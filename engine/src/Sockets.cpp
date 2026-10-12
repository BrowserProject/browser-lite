// Netzwerk-Sockets der Engine ohne Umweg ueber den Haupt-Thread.
//
// Vorher liefen socket/connect/send/recv/poll ueber Emscriptens SOCKFS. Das
// lebt im JavaScript des Haupt-Threads: jeder Aufruf von curl (eigener
// Thread) war ein synchroner Umweg dorthin, auf CNN ca. 0.5 s Wartezeit.
//
// Jetzt fangen wir die Funktionen beim Linken ab (-Wl,--wrap=..., siehe
// engine.cmake). TCP-Sockets und Pipes (die Weck-Pipe von curl) leben hier im
// WASM-Speicher, poll wartet auf eine Condition-Variable. Nur Verbindungen
// oeffnen, Daten senden und schliessen gehen asynchron an den Haupt-Thread
// (engine/js/sockets.js), der sie ueber den Transport der Oberflaeche (Wisp)
// schickt. Ankommende Daten schreibt der Haupt-Thread direkt hier hinein
// (bl_socket_data).
//
// Auch die Namensaufloesung ist hier: getaddrinfo gibt fuer Hostnamen eine
// Platzhalter-Adresse (172.29.x.y) zurueck, connect macht daraus wieder den
// Namen. Aufloesen tut das Relay.
//
// Andere Dateideskriptoren (Dateien, UDP, ...) gehen unveraendert an die
// Originale. Unsere Deskriptoren sind echte, reservierte Nummern im
// Dateisystem (/dev/null), damit sie sich mit nichts ueberschneiden.
//
// Regeln fuer das Lock:
// - kein Aufruf, der auf den Haupt-Thread warten koennte (der nimmt es auch),
// - auf dem Haupt-Thread nichts, was warten kann (auch nicht malloc/free):
//   waehrend er wartet, arbeitet Emscripten die Warteschlange ab, und
//   pumpOnMainThread nimmt dasselbe Lock.

#include "config.h"

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

// Laufen auf dem Haupt-Thread (engine/js/sockets.js)
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

constexpr int maxDescriptors = 4096; // FS.MAX_OPEN_FDS von Emscripten
constexpr size_t maxQueuedSend = 8 << 20;
constexpr uint8_t wispCloseVoluntary = 0x02;

// Empfangene Daten als Kette von Stuecken. Die Stuecke werden ausserhalb des
// Locks angelegt: auf dem Haupt-Thread bearbeitet Emscripten waehrend jedem
// Warten (auch auf das Lock von malloc) die Warteschlange, darunter
// pumpOnMainThread, das dieses Lock auch nimmt. Haelt der Haupt-Thread das
// Lock dabei schon, wartet er auf sich selber.
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
    size_t offset { 0 }; // im ersten Stueck
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

    // Unter dem Lock, legt nichts an
    void append(Chunk* chunk)
    {
        if (tail)
            tail->next = chunk;
        else
            head = chunk;
        tail = chunk;
        size += chunk->length;
    }

    // Gibt verbrauchte Stuecke frei: nur in Worker-Threads aufrufen
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
    int pendingError { 0 }; // fuer SO_ERROR
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

struct Descriptor {
    enum class Kind { Socket, PipeRead, PipeWrite };
    Kind kind;
    bool nonBlocking { false };
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
std::atomic<Descriptor*> descriptors[maxDescriptors];
std::unordered_map<int, std::shared_ptr<Socket>> socketsById;
int nextSocketId = 1;
std::vector<Operation> outbox;
std::atomic<bool> pumpScheduled { false };
// Platzhalter-Adressen fuer Hostnamen (172.29.0.0/16)
std::unordered_map<std::string, uint32_t> addressForHost;
std::unordered_map<uint32_t, std::string> hostForAddress;
uint32_t nextPlaceholder = 1;

Descriptor* descriptorFor(int fd)
{
    if (fd < 0 || fd >= maxDescriptors)
        return nullptr;
    return descriptors[fd].load(std::memory_order_acquire);
}

// Eine echte Nummer im Dateisystem reservieren (selten, darf warten)
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
    size_t sent = 0;
    for (auto& operation : operations) {
        switch (operation.type) {
        case Operation::Type::Open:
            blJsSocketOpen(operation.id, operation.host.c_str(), operation.port);
            break;
        case Operation::Type::Send:
            blJsSocketSend(operation.id, operation.data.data(), operation.data.size());
            sent += operation.data.size();
            break;
        case Operation::Type::Close:
            blJsSocketClose(operation.id);
            break;
        }
    }
    if (!sent)
        return;
    std::lock_guard lock(mutex);
    for (auto& operation : operations) {
        if (operation.type != Operation::Type::Send)
            continue;
        if (auto it = socketsById.find(operation.id); it != socketsById.end())
            it->second->queuedSend -= std::min(it->second->queuedSend, operation.data.size());
    }
    changed.notify_all();
}

// Unter dem Lock aufrufen
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

ssize_t receive(Descriptor& descriptor, void* buffer, size_t length, bool peek)
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
        if (descriptor.nonBlocking) {
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

// ---------------------------------------------------------------- Haupt-Thread

EMSCRIPTEN_KEEPALIVE void bl_socket_opened(int id)
{
    std::lock_guard lock(mutex);
    if (auto it = socketsById.find(id); it != socketsById.end()) {
        if (it->second->state == Socket::State::Connecting)
            it->second->state = Socket::State::Connected;
        changed.notify_all();
    }
}

// Uebernimmt data (mit malloc angelegt). Haupt-Thread: unter dem Lock nichts
// anlegen oder freigeben (siehe Chunk)
EMSCRIPTEN_KEEPALIVE void bl_socket_data(int id, uint8_t* data, int length)
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

EMSCRIPTEN_KEEPALIVE void bl_socket_closed(int id, int reason)
{
    std::lock_guard lock(mutex);
    auto it = socketsById.find(id);
    if (it == socketsById.end())
        return;
    auto& socket = *it->second;
    if (socket.state == Socket::State::Connecting)
        socket.pendingError = reason == wispCloseVoluntary ? ECONNRESET : ECONNREFUSED;
    socket.remoteClosed = true;
    socket.state = Socket::State::Closed;
    changed.notify_all();
}

// ---------------------------------------------------------------- Namen

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
        // Platzhalter, das Relay loest den Namen auf
        uint32_t placeholder;
        {
            std::lock_guard lock(mutex);
            auto [it, added] = addressForHost.try_emplace(node, 0);
            if (added) {
                if (nextPlaceholder > 0xfffe)
                    nextPlaceholder = 1;
                hostForAddress.erase(nextPlaceholder);
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

    // Alles in einem Block, freeaddrinfo gibt ihn frei
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
    auto* descriptor = new Descriptor { Descriptor::Kind::Socket };
    descriptor->nonBlocking = type & SOCK_NONBLOCK;
    descriptor->socket = std::make_shared<Socket>();
    std::lock_guard lock(mutex);
    descriptor->socket->id = nextSocketId++;
    socketsById[descriptor->socket->id] = descriptor->socket;
    descriptors[fd].store(descriptor, std::memory_order_release);
    return fd;
}

int __wrap_connect(int fd, const struct sockaddr* address, socklen_t length)
{
    auto* descriptor = descriptorFor(fd);
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
    if (!descriptorFor(fd))
        return __real_bind(fd, address, length);
    return 0;
}

ssize_t __wrap_send(int fd, const void* buffer, size_t length, int flags)
{
    auto* descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_send(fd, buffer, length, flags);
    return transmit(*descriptor, buffer, length);
}

ssize_t __wrap_recv(int fd, void* buffer, size_t length, int flags)
{
    auto* descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_recv(fd, buffer, length, flags);
    if (flags & MSG_DONTWAIT) {
        Descriptor copy = *descriptor;
        copy.nonBlocking = true;
        return receive(copy, buffer, length, flags & MSG_PEEK);
    }
    return receive(*descriptor, buffer, length, flags & MSG_PEEK);
}

ssize_t __wrap_read(int fd, void* buffer, size_t length)
{
    auto* descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_read(fd, buffer, length);
    return receive(*descriptor, buffer, length, false);
}

ssize_t __wrap_write(int fd, const void* buffer, size_t length)
{
    auto* descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_write(fd, buffer, length);
    return transmit(*descriptor, buffer, length);
}

int __wrap_close(int fd)
{
    auto* descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_close(fd);
    {
        std::lock_guard lock(mutex);
        descriptors[fd].store(nullptr, std::memory_order_release);
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
    // Ein anderer Thread koennte den Zeiger gerade noch lesen (z.B. poll ohne
    // Lock): erst spaeter freigeben waere sauberer, Deskriptoren sind aber nur
    // in einem Thread gleichzeitig in Gebrauch (curl).
    delete descriptor;
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
    auto* reader = new Descriptor { Descriptor::Kind::PipeRead, bool(flags & O_NONBLOCK), nullptr, pipe };
    auto* writer = new Descriptor { Descriptor::Kind::PipeWrite, bool(flags & O_NONBLOCK), nullptr, pipe };
    std::lock_guard lock(mutex);
    descriptors[readFd].store(reader, std::memory_order_release);
    descriptors[writeFd].store(writer, std::memory_order_release);
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
    auto* descriptor = descriptorFor(fd);
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
    auto* descriptor = descriptorFor(fd);
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
    if (!descriptorFor(fd))
        return __real_setsockopt(fd, level, name, value, length);
    return 0;
}

int __wrap_getpeername(int fd, struct sockaddr* address, socklen_t* length)
{
    auto* descriptor = descriptorFor(fd);
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
    auto* descriptor = descriptorFor(fd);
    if (!descriptor)
        return __real_getsockname(fd, address, length);
    sockaddr_in local { };
    local.sin_family = AF_INET;
    memcpy(address, &local, std::min<socklen_t>(*length, sizeof(local)));
    *length = sizeof(local);
    return 0;
}

// ---------------------------------------------------------------- Warten

int __wrap_poll(struct pollfd* fds, nfds_t count, int timeout)
{
    bool ours = false;
    std::vector<pollfd> foreign;
    std::vector<nfds_t> foreignIndex;
    for (nfds_t i = 0; i < count; ++i) {
        fds[i].revents = 0;
        if (descriptorFor(fds[i].fd))
            ours = true;
        else if (fds[i].fd >= 0) {
            foreign.push_back(fds[i]);
            foreignIndex.push_back(i);
        }
    }
    if (!ours)
        return __real_poll(fds, count, timeout);

    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout < 0 ? 0 : timeout);
    std::unique_lock lock(mutex);
    for (;;) {
        int ready = 0;
        for (nfds_t i = 0; i < count; ++i) {
            if (auto* descriptor = descriptorFor(fds[i].fd)) {
                short events = readyEvents(*descriptor);
                fds[i].revents = events & (fds[i].events | POLLERR | POLLHUP);
                if (fds[i].revents)
                    ready++;
            }
        }
        if (!foreign.empty()) {
            // Andere Deskriptoren nur kurz nachsehen (ohne Lock, das geht an den Haupt-Thread)
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
    bool ours = false;
    for (int fd = 0; fd < count && !ours; ++fd) {
        if (((readSet && FD_ISSET(fd, readSet)) || (writeSet && FD_ISSET(fd, writeSet)) || (errorSet && FD_ISSET(fd, errorSet))) && descriptorFor(fd))
            ours = true;
    }
    if (!ours)
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
