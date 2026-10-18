// Network sockets of the engine without a detour through the main thread.
//
// socket/connect/send/recv/poll are intercepted at link time
// (-Wl,--wrap=..., see engine.cmake) instead of using Emscripten's SOCKFS: that
// lives in the JavaScript of the main thread, every call from curl (its own
// thread) would be a synchronous detour there (about 0.5 s of waiting on CNN).
//
// TCP sockets and pipes (curl's wake-up pipe) live here in WASM memory, poll
// waits on a condition variable. Only opening connections, sending data and
// closing go asynchronously to the main thread (engine/js/sockets.js), which
// sends them through the host's transport (Module.blTransport). The main
// thread writes incoming data directly in here (bl__socket_data). Only what
// the transport really sent counts as sent (bl__socket_sent): while more than
// maxQueuedSend is on its way, send() waits or poll reports no POLLOUT.
//
// Name resolution is here too: getaddrinfo returns a placeholder address
// (172.29.x.y) for host names, connect turns it back into the name. The
// transport resolves it.
//
// Other file descriptors (files, UDP, ...) go unchanged to the originals. Our
// descriptors are real, reserved numbers in the file system (/dev/null), so
// they overlap with nothing.
//
// Rules for the lock:
// - no call that could wait for the main thread (it takes the lock too),
// - nothing on the main thread that can wait (not even malloc/free): while it
//   waits, Emscripten processes the queue, and pumpOnMainThread takes the
//   same lock.

#include "config.h"

#include <algorithm>
#include <arpa/inet.h>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdarg>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <fcntl.h>
#include <memory>
#include <mutex>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <string>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#include <unordered_map>
#include <vector>

extern "C" {
int __real_socket(int, int, int);
int __real_connect(int, const struct sockaddr*, socklen_t);
int __real_bind(int, const struct sockaddr*, socklen_t);
ssize_t __real_send(int, const void*, size_t, int);
ssize_t __real_recv(int, void*, size_t, int);
ssize_t __real_read(int, void*, size_t);
ssize_t __real_write(int, const void*, size_t);
int __real_close(int);
int __real_poll(struct pollfd*, nfds_t, int);
int __real_select(int, fd_set*, fd_set*, fd_set*, struct timeval*);
int __real_fcntl(int, int, ...);
int __real_getsockopt(int, int, int, void*, socklen_t*);
int __real_setsockopt(int, int, int, const void*, socklen_t);
int __real_getsockname(int, struct sockaddr*, socklen_t*);
int __real_getpeername(int, struct sockaddr*, socklen_t*);
int __real_pipe2(int[2], int);
}

// Run on the main thread (engine/js/sockets.js)
EM_JS(void, blJsSocketOpen, (int id, const char* host, int port), {
    blSockets.open(id, UTF8ToString(host), port);
});
EM_JS(void, blJsSocketSend, (int id, const uint8_t* data, int length), {
    blSockets.send(id, HEAPU8.slice(data, data + length));
});
EM_JS(void, blJsSocketClose, (int id), {
    blSockets.close(id);
});

namespace {

constexpr int maxDescriptors = 4096; // FS.MAX_OPEN_FDS of Emscripten
constexpr size_t maxQueuedSend = 8 << 20;

// Why a transport stream ended: the transport's CloseReason strings in this
// order, mapped by engine/js/sockets.js
enum class CloseReason : int { Closed, Reset, Refused, Unreachable, NameNotResolved, Timeout, Blocked, Throttled, Invalid, TransportDown };

// Received data as a chain of pieces. The pieces are created outside of the
// lock: on the main thread Emscripten processes the queue during every wait
// (also for the malloc lock), including pumpOnMainThread, which takes this
// lock too. If the main thread already holds the lock then, it waits for
// itself.
struct Chunk {
    Chunk* next;
    size_t length;
    uint8_t data[];

    static Chunk* create(const void* data, size_t length)
    {
        auto* chunk = static_cast<Chunk*>(malloc(sizeof(Chunk) + length));
        if (!chunk)
            return nullptr;
        chunk->next = nullptr;
        chunk->length = length;
        memcpy(chunk->data, data, length);
        return chunk;
    }
};

struct Buffer {
    Chunk* head { nullptr };
    Chunk* tail { nullptr };
    size_t offset { 0 }; // in the first piece
    size_t size { 0 };

    Buffer() = default;
    Buffer(const Buffer&) = delete;
    Buffer& operator=(const Buffer&) = delete;
    ~Buffer()
    {
        while (head) {
            auto* next = head->next;
            free(head);
            head = next;
        }
    }

    // Under the lock, allocates nothing
    void append(Chunk* chunk)
    {
        if (tail)
            tail->next = chunk;
        else
            head = chunk;
        tail = chunk;
        size += chunk->length;
    }

    // Frees consumed pieces: only call in worker threads
    size_t read(uint8_t* out, size_t length, bool peek)
    {
        size_t copied = 0;
        size_t chunkOffset = offset;
        for (auto* chunk = head; chunk && copied < length; chunk = chunk->next) {
            size_t count = std::min(length - copied, chunk->length - chunkOffset);
            memcpy(out + copied, chunk->data + chunkOffset, count);
            copied += count;
            chunkOffset = 0;
        }
        if (peek)
            return copied;
        size -= copied;
        size_t remaining = copied;
        while (remaining) {
            size_t available = head->length - offset;
            if (remaining < available) {
                offset += remaining;
                break;
            }
            remaining -= available;
            offset = 0;
            auto* next = head->next;
            free(head);
            head = next;
            if (!head)
                tail = nullptr;
        }
        return copied;
    }
};

struct Socket {
    enum class State { Created, Connecting, Connected, Closed };
    int id { 0 };
    State state { State::Created };
    int pendingError { 0 }; // for SO_ERROR
    bool remoteClosed { false };
    Buffer received;
    size_t queuedSend { 0 };
    sockaddr_storage peer { };
    socklen_t peerLength { 0 };
};

struct Pipe {
    Buffer data;
    bool readerOpen { true };
    bool writerOpen { true };
};

// Whoever uses a descriptor holds a reference: close() on another thread only
// removes it from the table
struct Descriptor {
    enum class Kind { Socket, PipeRead, PipeWrite };
    Kind kind;
    std::atomic<bool> nonBlocking { false };
    std::shared_ptr<Socket> socket;
    std::shared_ptr<Pipe> pipe;
};

struct Operation {
    enum class Type { Open, Send, Close };
    Type type;
    int id;
    std::string host;
    int port { 0 };
    std::vector<uint8_t> data;
};

std::mutex mutex;
std::condition_variable changed;
std::shared_ptr<Descriptor> descriptors[maxDescriptors];
// Readable without the lock: is the number ours? read/write/close of all other files pass here too
std::atomic<bool> ours[maxDescriptors];
std::unordered_map<int, std::shared_ptr<Socket>> socketsById;
int nextSocketId = 1;
std::vector<Operation> outbox;
std::atomic<bool> pumpScheduled { false };
// Placeholder addresses for host names (172.29.0.0/16)
std::unordered_map<std::string, uint32_t> addressForHost;
std::unordered_map<uint32_t, std::string> hostForAddress;
uint32_t nextPlaceholder = 1;

bool isOurs(int fd)
{
    return fd >= 0 && fd < maxDescriptors && ours[fd].load(std::memory_order_acquire);
}

std::shared_ptr<Descriptor> descriptorFor(int fd)
{
    if (!isOurs(fd))
        return nullptr;
    std::lock_guard lock(mutex);
    return descriptors[fd];
}

// Under the lock
Descriptor* descriptorLocked(int fd)
{
    return isOurs(fd) ? descriptors[fd].get() : nullptr;
}

// Under the lock
void storeDescriptor(int fd, std::shared_ptr<Descriptor>&& descriptor)
{
    descriptors[fd] = std::move(descriptor);
    ours[fd].store(true, std::memory_order_release);
}

std::shared_ptr<Descriptor> createDescriptor(Descriptor::Kind kind, bool nonBlocking)
{
    auto descriptor = std::make_shared<Descriptor>();
    descriptor->kind = kind;
    descriptor->nonBlocking = nonBlocking;
    return descriptor;
}

// Reserve a real number in the file system (rare, may wait)
int reserveDescriptor()
{
    int fd = open("/dev/null", O_RDWR);
    if (fd >= maxDescriptors) {
        __real_close(fd);
        errno = EMFILE;
        return -1;
    }
    return fd;
}

void pumpOnMainThread(void*)
{
    pumpScheduled.store(false);
    std::vector<Operation> operations;
    {
        std::lock_guard lock(mutex);
        operations.swap(outbox);
    }
    for (auto& operation : operations) {
        switch (operation.type) {
        case Operation::Type::Open:
            blJsSocketOpen(operation.id, operation.host.c_str(), operation.port);
            break;
        case Operation::Type::Send:
            blJsSocketSend(operation.id, operation.data.data(), operation.data.size());
            break;
        case Operation::Type::Close:
            blJsSocketClose(operation.id);
            break;
        }
    }
}

// Error for the reason a stream ended. The transport may not confirm the
// connection (Wisp does not), the stream then counts as open right away: a
// connection that fails at the relay only ends afterwards. CurlRequest turns
// these errors back into curl's codes (patch 0039), which pick the error page.
int errorForCloseReason(CloseReason reason, bool opened)
{
    switch (reason) {
    case CloseReason::NameNotResolved:
        return EADDRNOTAVAIL;
    case CloseReason::Unreachable:
        return EHOSTUNREACH;
    case CloseReason::Timeout:
        return ETIMEDOUT;
    case CloseReason::Refused:
        return ECONNREFUSED;
    case CloseReason::Invalid:
    case CloseReason::Blocked:
        return EACCES;
    default:
        // Before opening only the transport itself closes: it cannot reach its network
        return opened ? ECONNRESET : ENETUNREACH;
    }
}

// Call under the lock
void queueOperation(Operation&& operation)
{
    outbox.push_back(std::move(operation));
    if (!pumpScheduled.exchange(true))
        emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), pumpOnMainThread, nullptr);
}

short readyEvents(const Descriptor& descriptor)
{
    switch (descriptor.kind) {
    case Descriptor::Kind::Socket: {
        auto& socket = *descriptor.socket;
        short events = 0;
        if (socket.received.size || socket.remoteClosed)
            events |= POLLIN;
        if (socket.state == Socket::State::Connected && !socket.remoteClosed && socket.queuedSend < maxQueuedSend)
            events |= POLLOUT;
        if (socket.remoteClosed)
            events |= POLLHUP;
        if (socket.pendingError)
            events |= POLLERR | POLLOUT;
        return events;
    }
    case Descriptor::Kind::PipeRead:
        return (descriptor.pipe->data.size ? POLLIN : 0) | (descriptor.pipe->writerOpen ? 0 : POLLHUP);
    case Descriptor::Kind::PipeWrite:
        return descriptor.pipe->readerOpen ? POLLOUT : POLLERR;
    }
    return 0;
}

ssize_t receive(Descriptor& descriptor, void* buffer, size_t length, bool peek, bool nonBlocking)
{
    std::unique_lock lock(mutex);
    for (;;) {
        if (descriptor.kind == Descriptor::Kind::PipeRead) {
            auto& pipe = *descriptor.pipe;
            if (pipe.data.size)
                return pipe.data.read(static_cast<uint8_t*>(buffer), length, peek);
            if (!pipe.writerOpen)
                return 0;
        } else if (descriptor.kind == Descriptor::Kind::Socket) {
            auto& socket = *descriptor.socket;
            if (socket.received.size)
                return socket.received.read(static_cast<uint8_t*>(buffer), length, peek);
            // An abort by the transport is an error, not a normal end
            if (socket.remoteClosed && socket.pendingError) {
                errno = std::exchange(socket.pendingError, 0);
                return -1;
            }
            if (socket.remoteClosed)
                return 0;
            if (socket.state == Socket::State::Created || socket.state == Socket::State::Closed) {
                errno = ENOTCONN;
                return -1;
            }
        } else {
            errno = EBADF;
            return -1;
        }
        if (nonBlocking) {
            errno = EAGAIN;
            return -1;
        }
        changed.wait(lock);
    }
}

ssize_t transmit(Descriptor& descriptor, const void* buffer, size_t length)
{
    if (descriptor.kind == Descriptor::Kind::PipeWrite) {
        auto* chunk = Chunk::create(buffer, length);
        if (!chunk) {
            errno = ENOMEM;
            return -1;
        }
        std::lock_guard lock(mutex);
        if (!descriptor.pipe->readerOpen) {
            free(chunk);
            errno = EPIPE;
            return -1;
        }
        descriptor.pipe->data.append(chunk);
        changed.notify_all();
        return length;
    }
    std::unique_lock lock(mutex);
    if (descriptor.kind != Descriptor::Kind::Socket) {
        errno = EBADF;
        return -1;
    }
    auto& socket = *descriptor.socket;
    for (;;) {
        if (socket.pendingError || socket.remoteClosed || socket.state == Socket::State::Closed) {
            errno = socket.pendingError ? socket.pendingError : EPIPE;
            return -1;
        }
        if (socket.state == Socket::State::Connected && socket.queuedSend < maxQueuedSend)
            break;
        if (socket.state == Socket::State::Created) {
            errno = ENOTCONN;
            return -1;
        }
        if (descriptor.nonBlocking) {
            errno = EAGAIN;
            return -1;
        }
        changed.wait(lock);
    }
    Operation operation { Operation::Type::Send, socket.id };
    operation.data.assign(static_cast<const uint8_t*>(buffer), static_cast<const uint8_t*>(buffer) + length);
    socket.queuedSend += length;
    queueOperation(std::move(operation));
    return length;
}

std::string hostForPeer(const sockaddr* address, int& port)
{
    char text[INET6_ADDRSTRLEN] = { };
    if (address->sa_family == AF_INET) {
        auto* ipv4 = reinterpret_cast<const sockaddr_in*>(address);
        port = ntohs(ipv4->sin_port);
        uint32_t value = ntohl(ipv4->sin_addr.s_addr);
        if ((value >> 16) == ((172u << 8) | 29u)) {
            if (auto it = hostForAddress.find(value & 0xffff); it != hostForAddress.end())
                return it->second;
        }
        inet_ntop(AF_INET, &ipv4->sin_addr, text, sizeof(text));
        return text;
    }
    auto* ipv6 = reinterpret_cast<const sockaddr_in6*>(address);
    port = ntohs(ipv6->sin6_port);
    inet_ntop(AF_INET6, &ipv6->sin6_addr, text, sizeof(text));
    return text;
}

} // namespace

extern "C" {

// ---------------------------------------------------------------- Main thread

EMSCRIPTEN_KEEPALIVE void bl__socket_opened(int id)
{
    std::lock_guard lock(mutex);
    if (auto it = socketsById.find(id); it != socketsById.end()) {
        if (it->second->state == Socket::State::Connecting)
            it->second->state = Socket::State::Connected;
        changed.notify_all();
    }
}

// Takes over data (allocated with malloc). Main thread: allocate or free
// nothing under the lock (see Chunk)
EMSCRIPTEN_KEEPALIVE void bl__socket_data(int id, uint8_t* data, int length)
{
    auto* chunk = Chunk::create(data, length);
    free(data);
    if (!chunk)
        return;
    {
        std::lock_guard lock(mutex);
        if (auto it = socketsById.find(id); it != socketsById.end()) {
            it->second->received.append(chunk);
            chunk = nullptr;
            changed.notify_all();
        }
    }
    free(chunk);
}

// The transport really sent length bytes
EMSCRIPTEN_KEEPALIVE void bl__socket_sent(int id, int length)
{
    std::lock_guard lock(mutex);
    if (auto it = socketsById.find(id); it != socketsById.end()) {
        auto& socket = *it->second;
        socket.queuedSend -= std::min<size_t>(socket.queuedSend, length);
        changed.notify_all();
    }
}

// reason: CloseReason (engine/js/sockets.js)
EMSCRIPTEN_KEEPALIVE void bl__socket_closed(int id, int reason)
{
    std::lock_guard lock(mutex);
    auto it = socketsById.find(id);
    if (it == socketsById.end())
        return;
    auto& socket = *it->second;
    bool connecting = socket.state == Socket::State::Connecting;
    auto closeReason = static_cast<CloseReason>(std::clamp(reason, 0, static_cast<int>(CloseReason::TransportDown)));
    if (closeReason != CloseReason::Closed)
        socket.pendingError = errorForCloseReason(closeReason, !connecting);
    else if (connecting)
        socket.pendingError = ECONNRESET;
    socket.remoteClosed = true;
    socket.state = Socket::State::Closed;
    changed.notify_all();
}

// ---------------------------------------------------------------- Names

int __wrap_getaddrinfo(const char* node, const char* service, const struct addrinfo* hints, struct addrinfo** result)
{
    if (!node)
        return EAI_NONAME;
    int family = hints ? hints->ai_family : AF_UNSPEC;
    sockaddr_storage address { };
    socklen_t length;
    in_addr ipv4;
    in6_addr ipv6;
    uint16_t port = htons(service ? atoi(service) : 0);
    if (inet_pton(AF_INET, node, &ipv4) == 1 && family != AF_INET6) {
        auto* out = reinterpret_cast<sockaddr_in*>(&address);
        out->sin_family = AF_INET;
        out->sin_addr = ipv4;
        out->sin_port = port;
        length = sizeof(sockaddr_in);
    } else if (inet_pton(AF_INET6, node, &ipv6) == 1 && family != AF_INET) {
        auto* out = reinterpret_cast<sockaddr_in6*>(&address);
        out->sin6_family = AF_INET6;
        out->sin6_addr = ipv6;
        out->sin6_port = port;
        length = sizeof(sockaddr_in6);
    } else {
        if ((hints && (hints->ai_flags & AI_NUMERICHOST)) || family == AF_INET6)
            return EAI_NONAME;
        // Placeholder, the transport resolves the name
        uint32_t placeholder;
        {
            std::lock_guard lock(mutex);
            auto [it, added] = addressForHost.try_emplace(node, 0);
            if (added) {
                if (nextPlaceholder > 0xfffe)
                    nextPlaceholder = 1;
                // The slot becomes free again: the old name gets a new one next time
                if (auto old = hostForAddress.find(nextPlaceholder); old != hostForAddress.end()) {
                    addressForHost.erase(old->second);
                    hostForAddress.erase(old);
                }
                it->second = nextPlaceholder++;
                hostForAddress[it->second] = node;
            }
            placeholder = it->second;
        }
        auto* out = reinterpret_cast<sockaddr_in*>(&address);
        out->sin_family = AF_INET;
        out->sin_addr.s_addr = htonl((172u << 24) | (29u << 16) | placeholder);
        out->sin_port = port;
        length = sizeof(sockaddr_in);
    }

    // Everything in one block, freeaddrinfo frees it
    size_t nameLength = (hints && (hints->ai_flags & AI_CANONNAME)) ? strlen(node) + 1 : 0;
    auto* block = static_cast<uint8_t*>(calloc(1, sizeof(addrinfo) + sizeof(sockaddr_storage) + nameLength));
    if (!block)
        return EAI_MEMORY;
    auto* info = reinterpret_cast<addrinfo*>(block);
    auto* storedAddress = reinterpret_cast<sockaddr*>(block + sizeof(addrinfo));
    memcpy(storedAddress, &address, length);
    info->ai_family = address.ss_family;
    info->ai_socktype = hints && hints->ai_socktype ? hints->ai_socktype : SOCK_STREAM;
    info->ai_protocol = hints && hints->ai_protocol ? hints->ai_protocol : IPPROTO_TCP;
    info->ai_addrlen = length;
    info->ai_addr = storedAddress;
    if (nameLength) {
        info->ai_canonname = reinterpret_cast<char*>(block + sizeof(addrinfo) + sizeof(sockaddr_storage));
        memcpy(info->ai_canonname, node, nameLength);
    }
    *result = info;
    return 0;
}

void __wrap_freeaddrinfo(struct addrinfo* info)
{
    while (info) {
        auto* next = info->ai_next;
        free(info);
        info = next;
    }
}

// ---------------------------------------------------------------- Sockets

int __wrap_socket(int domain, int type, int protocol)
{
    if ((domain != AF_INET && domain != AF_INET6) || (type & 0xf) != SOCK_STREAM)
        return __real_socket(domain, type, protocol);
    int fd = reserveDescriptor();
    if (fd < 0)
        return -1;
    auto descriptor = createDescriptor(Descriptor::Kind::Socket, type & SOCK_NONBLOCK);
    descriptor->socket = std::make_shared<Socket>();
    std::lock_guard lock(mutex);
    descriptor->socket->id = nextSocketId++;
    socketsById[descriptor->socket->id] = descriptor->socket;
    storeDescriptor(fd, std::move(descriptor));
    return fd;
}

int __wrap_connect(int fd, const struct sockaddr* address, socklen_t length)
{
    auto descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_connect(fd, address, length);
    if (descriptor->kind != Descriptor::Kind::Socket || !address || (address->sa_family != AF_INET && address->sa_family != AF_INET6)) {
        errno = EAFNOSUPPORT;
        return -1;
    }
    std::unique_lock lock(mutex);
    auto& socket = *descriptor->socket;
    if (socket.state != Socket::State::Created) {
        errno = socket.state == Socket::State::Connecting ? EALREADY : EISCONN;
        return -1;
    }
    int port = 0;
    std::string host = hostForPeer(address, port);
    memcpy(&socket.peer, address, std::min<size_t>(length, sizeof(socket.peer)));
    socket.peerLength = length;
    socket.state = Socket::State::Connecting;
    queueOperation({ Operation::Type::Open, socket.id, host, port });
    if (descriptor->nonBlocking) {
        errno = EINPROGRESS;
        return -1;
    }
    changed.wait(lock, [&] { return socket.state != Socket::State::Connecting; });
    if (socket.pendingError) {
        errno = std::exchange(socket.pendingError, 0);
        return -1;
    }
    return 0;
}

int __wrap_bind(int fd, const struct sockaddr* address, socklen_t length)
{
    if (!isOurs(fd))
        return __real_bind(fd, address, length);
    return 0;
}

ssize_t __wrap_send(int fd, const void* buffer, size_t length, int flags)
{
    auto descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_send(fd, buffer, length, flags);
    return transmit(*descriptor, buffer, length);
}

ssize_t __wrap_recv(int fd, void* buffer, size_t length, int flags)
{
    auto descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_recv(fd, buffer, length, flags);
    return receive(*descriptor, buffer, length, flags & MSG_PEEK, descriptor->nonBlocking || (flags & MSG_DONTWAIT));
}

ssize_t __wrap_read(int fd, void* buffer, size_t length)
{
    auto descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_read(fd, buffer, length);
    return receive(*descriptor, buffer, length, false, descriptor->nonBlocking);
}

ssize_t __wrap_write(int fd, const void* buffer, size_t length)
{
    auto descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_write(fd, buffer, length);
    return transmit(*descriptor, buffer, length);
}

int __wrap_close(int fd)
{
    auto descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_close(fd);
    {
        std::lock_guard lock(mutex);
        ours[fd].store(false, std::memory_order_release);
        descriptors[fd] = nullptr;
        switch (descriptor->kind) {
        case Descriptor::Kind::Socket: {
            auto& socket = *descriptor->socket;
            if (socket.state != Socket::State::Created)
                queueOperation({ Operation::Type::Close, socket.id });
            socketsById.erase(socket.id);
            break;
        }
        case Descriptor::Kind::PipeRead:
            descriptor->pipe->readerOpen = false;
            break;
        case Descriptor::Kind::PipeWrite:
            descriptor->pipe->writerOpen = false;
            break;
        }
        changed.notify_all();
    }
    return __real_close(fd);
}

int __wrap_pipe2(int fds[2], int flags)
{
    int readFd = reserveDescriptor();
    if (readFd < 0)
        return -1;
    int writeFd = reserveDescriptor();
    if (writeFd < 0) {
        __real_close(readFd);
        return -1;
    }
    auto pipe = std::make_shared<Pipe>();
    auto reader = createDescriptor(Descriptor::Kind::PipeRead, flags & O_NONBLOCK);
    auto writer = createDescriptor(Descriptor::Kind::PipeWrite, flags & O_NONBLOCK);
    reader->pipe = writer->pipe = pipe;
    std::lock_guard lock(mutex);
    storeDescriptor(readFd, std::move(reader));
    storeDescriptor(writeFd, std::move(writer));
    fds[0] = readFd;
    fds[1] = writeFd;
    return 0;
}

int __wrap_fcntl(int fd, int command, ...)
{
    va_list arguments;
    va_start(arguments, command);
    long argument = va_arg(arguments, long);
    va_end(arguments);
    auto descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_fcntl(fd, command, argument);
    switch (command) {
    case F_GETFL:
        return O_RDWR | (descriptor->nonBlocking ? O_NONBLOCK : 0);
    case F_SETFL:
        descriptor->nonBlocking = argument & O_NONBLOCK;
        return 0;
    default:
        return 0;
    }
}

int __wrap_getsockopt(int fd, int level, int name, void* value, socklen_t* length)
{
    auto descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_getsockopt(fd, level, name, value, length);
    int result = 0;
    if (level == SOL_SOCKET && name == SO_ERROR && descriptor->kind == Descriptor::Kind::Socket) {
        std::lock_guard lock(mutex);
        result = std::exchange(descriptor->socket->pendingError, 0);
    }
    if (value && length && *length >= sizeof(int)) {
        memcpy(value, &result, sizeof(int));
        *length = sizeof(int);
    }
    return 0;
}

int __wrap_setsockopt(int fd, int level, int name, const void* value, socklen_t length)
{
    if (!isOurs(fd))
        return __real_setsockopt(fd, level, name, value, length);
    return 0;
}

int __wrap_getpeername(int fd, struct sockaddr* address, socklen_t* length)
{
    auto descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_getpeername(fd, address, length);
    if (descriptor->kind != Descriptor::Kind::Socket) {
        errno = ENOTSOCK;
        return -1;
    }
    std::lock_guard lock(mutex);
    auto& socket = *descriptor->socket;
    if (!socket.peerLength) {
        errno = ENOTCONN;
        return -1;
    }
    memcpy(address, &socket.peer, std::min(*length, socket.peerLength));
    *length = socket.peerLength;
    return 0;
}

int __wrap_getsockname(int fd, struct sockaddr* address, socklen_t* length)
{
    auto descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_getsockname(fd, address, length);
    sockaddr_in local { };
    local.sin_family = AF_INET;
    memcpy(address, &local, std::min<socklen_t>(*length, sizeof(local)));
    *length = sizeof(local);
    return 0;
}

// ---------------------------------------------------------------- Waiting

int __wrap_poll(struct pollfd* fds, nfds_t count, int timeout)
{
    bool ownFound = false;
    std::vector<pollfd> foreign;
    std::vector<nfds_t> foreignIndex;
    for (nfds_t i = 0; i < count; ++i) {
        fds[i].revents = 0;
        if (isOurs(fds[i].fd))
            ownFound = true;
        else if (fds[i].fd >= 0) {
            foreign.push_back(fds[i]);
            foreignIndex.push_back(i);
        }
    }
    if (!ownFound)
        return __real_poll(fds, count, timeout);

    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout < 0 ? 0 : timeout);
    std::unique_lock lock(mutex);
    for (;;) {
        int ready = 0;
        for (nfds_t i = 0; i < count; ++i) {
            if (auto* descriptor = descriptorLocked(fds[i].fd)) {
                short events = readyEvents(*descriptor);
                fds[i].revents = events & (fds[i].events | POLLERR | POLLHUP);
                if (fds[i].revents)
                    ready++;
            }
        }
        if (!foreign.empty()) {
            // Only peek at other descriptors (without the lock, that goes to the main thread)
            lock.unlock();
            for (auto& entry : foreign)
                entry.revents = 0;
            if (__real_poll(foreign.data(), foreign.size(), 0) > 0) {
                for (size_t i = 0; i < foreign.size(); ++i) {
                    fds[foreignIndex[i]].revents = foreign[i].revents;
                    if (foreign[i].revents)
                        ready++;
                }
            }
            lock.lock();
        }
        if (ready || !timeout)
            return ready;
        auto now = std::chrono::steady_clock::now();
        if (timeout > 0 && now >= deadline)
            return 0;
        auto until = timeout < 0 ? now + std::chrono::hours(1) : deadline;
        if (!foreign.empty())
            until = std::min(until, now + std::chrono::milliseconds(20));
        changed.wait_until(lock, until);
    }
}

int __wrap_select(int count, fd_set* readSet, fd_set* writeSet, fd_set* errorSet, struct timeval* timeout)
{
    bool ownFound = false;
    for (int fd = 0; fd < count && !ownFound; ++fd) {
        if (((readSet && FD_ISSET(fd, readSet)) || (writeSet && FD_ISSET(fd, writeSet)) || (errorSet && FD_ISSET(fd, errorSet))) && isOurs(fd))
            ownFound = true;
    }
    if (!ownFound)
        return __real_select(count, readSet, writeSet, errorSet, timeout);
    std::vector<pollfd> fds;
    for (int fd = 0; fd < count; ++fd) {
        short events = (readSet && FD_ISSET(fd, readSet) ? POLLIN : 0) | (writeSet && FD_ISSET(fd, writeSet) ? POLLOUT : 0);
        if (events || (errorSet && FD_ISSET(fd, errorSet)))
            fds.push_back({ fd, events, 0 });
    }
    int milliseconds = timeout ? timeout->tv_sec * 1000 + timeout->tv_usec / 1000 : -1;
    int result = __wrap_poll(fds.data(), fds.size(), milliseconds);
    if (result < 0)
        return result;
    if (readSet)
        FD_ZERO(readSet);
    if (writeSet)
        FD_ZERO(writeSet);
    if (errorSet)
        FD_ZERO(errorSet);
    int ready = 0;
    for (auto& entry : fds) {
        bool any = false;
        if (readSet && (entry.revents & (POLLIN | POLLHUP))) {
            FD_SET(entry.fd, readSet);
            any = true;
        }
        if (writeSet && (entry.revents & POLLOUT)) {
            FD_SET(entry.fd, writeSet);
            any = true;
        }
        if (errorSet && (entry.revents & POLLERR)) {
            FD_SET(entry.fd, errorSet);
            any = true;
        }
        ready += any;
    }
    return ready;
}

} // extern "C"
