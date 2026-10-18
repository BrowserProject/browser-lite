#include "config.h"
#include "FileSystemStorageWasm.h"

#include "Storage.h"

#include <WebCore/ClientOrigin.h>
#include <WebCore/Exception.h>
#include <WebCore/ExceptionOr.h>
#include <WebCore/FileSystemHandleCloseScope.h>
#include <WebCore/FileSystemStorageConnection.h>
#include <WebCore/ScriptExecutionContext.h>
#include <WebCore/WorkerFileSystemStorageConnection.h>
#include <WebCore/WorkerGlobalScope.h>
#include <cerrno>
#include <cstdio>
#include <wtf/Expected.h>
#include <wtf/FileSystem.h>
#include <wtf/HashMap.h>
#include <wtf/MainThread.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/UUID.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

// One folder per top origin and origin (like the partitioning of WebKit2)
String rootPath(const ClientOrigin& origin)
{
    return FileSystem::pathByAppendingComponent(FileSystem::pathByAppendingComponent("/data/opfs"_s, FileSystem::encodeForFileName(origin.topOrigin.toString())), FileSystem::encodeForFileName(origin.clientOrigin.toString()));
}

// Like FileSystemStorageError in WebKit2
enum class Error : uint8_t {
    FileNotFound,
    InvalidDataType,
    InvalidModification,
    InvalidName,
    InvalidState,
    MissingArgument,
    NoModificationAllowed,
    TypeMismatch,
    QuotaError,
    Unknown,
};

Exception toException(Error error)
{
    switch (error) {
    case Error::FileNotFound:
        return Exception { ExceptionCode::NotFoundError };
    case Error::InvalidDataType:
        return Exception { ExceptionCode::TypeError, "Data type is invalid"_s };
    case Error::InvalidModification:
        return Exception { ExceptionCode::InvalidModificationError };
    case Error::InvalidName:
        return Exception { ExceptionCode::TypeError, "Name is invalid"_s };
    case Error::InvalidState:
        return Exception { ExceptionCode::InvalidStateError };
    case Error::MissingArgument:
        return Exception { ExceptionCode::TypeError, "Required argument is missing"_s };
    case Error::NoModificationAllowed:
        return Exception { ExceptionCode::NoModificationAllowedError };
    case Error::TypeMismatch:
        return Exception { ExceptionCode::TypeMismatchError, "File type is incompatible with handle type"_s };
    case Error::QuotaError:
        return Exception { ExceptionCode::QuotaExceededError, "Requested space above quota"_s };
    case Error::Unknown:
        break;
    }
    return Exception { ExceptionCode::UnknownError };
}

// Writing failed: with ENOSPC the host's OPFS has no space left
Error writeError()
{
    return errno == ENOSPC ? Error::QuotaError : Error::Unknown;
}

// Rename only: FileSystem::moveFile copies if that does not work. The copy is
// not atomic (without space the target stays half written) and reports success
// even if the source was not deleted
bool renameFile(const String& from, const String& to)
{
    return !rename(FileSystem::fileSystemRepresentation(from).data(), FileSystem::fileSystemRepresentation(to).data());
}

// WasmFS cannot rename folders in the host's OPFS (EBUSY), they only move as a
// copy through moveFile
bool moveDirectory(const String& from, const String& to)
{
    return FileSystem::moveFile(from, to) && (from == to || !FileSystem::fileExists(from));
}

ExceptionOr<void> toExceptionOr(std::optional<Error> error)
{
    if (!error)
        return { };
    return toException(*error);
}

struct Writable {
    FileSystem::FileHandle file;
    String path;
};

struct Handle {
    FileSystemHandleKind kind;
    String path;
    String name;
    FileSystemHandleGlobalIdentifier globalIdentifier;
    std::optional<FileSystemSyncAccessHandleIdentifier> syncAccessHandle;
    uint64_t syncAccessCapacity { 0 };
    HashMap<FileSystemWritableFileStreamIdentifier, Writable> writables;
};

struct GlobalEntry {
    FileSystemHandleKind kind;
    String path;
    String name;
    unsigned references { 1 };
};

// https://fs.spec.whatwg.org/#file-entry-lock
struct FileLock {
    bool exclusive { false };
    unsigned sharedCount { 0 };
};

constexpr uint64_t initialCapacity = 1024 * 1024;
// Copies for createWritable(): next to the folders of the origins, so in the
// same file system as the files (close() only renames)
constexpr auto swapDirectory = "/data/opfs-swap"_s;

class FileSystemStorageConnectionWasm final : public FileSystemStorageConnection {
public:
    static FileSystemStorageConnectionWasm& singleton()
    {
        static NeverDestroyed<Ref<FileSystemStorageConnectionWasm>> connection = adoptRef(*new FileSystemStorageConnectionWasm);
        return connection.get();
    }

    FileSystemStorageConnectionWasm()
    {
        // Leftovers of writes that did not finish (view closed)
        FileSystem::deleteNonEmptyDirectory(swapDirectory);
    }

    ExceptionOr<StorageConnection::DirectoryInfo> rootDirectory(const ClientOrigin& origin)
    {
        auto result = createHandle(FileSystemHandleKind::Directory, rootPath(origin), { }, true);
        if (!result)
            return toException(result.error());
        auto [globalIdentifier, identifier] = *result;
        return StorageConnection::DirectoryInfo { globalIdentifier, identifier, this };
    }

private:
    using HandleResult = Expected<std::pair<FileSystemHandleGlobalIdentifier, FileSystemHandleIdentifier>, Error>;

    HandleResult createHandle(std::optional<FileSystemHandleKind> kind, String&& path, String&& name, bool createIfNecessary)
    {
        if (path.isEmpty())
            return makeUnexpected(Error::Unknown);
        bool exists = FileSystem::fileExists(path);
        if (!createIfNecessary && !exists)
            return makeUnexpected(Error::FileNotFound);
        if (exists) {
            auto type = FileSystem::fileType(path);
            if (!type)
                return makeUnexpected(Error::Unknown);
            auto existingKind = *type == FileSystem::FileType::Directory ? FileSystemHandleKind::Directory : FileSystemHandleKind::File;
            if (kind && *kind != existingKind)
                return makeUnexpected(Error::TypeMismatch);
            kind = existingKind;
        }
        // Do not open an existing file: WasmFS keeps it locked in the host's
        // OPFS while open for writing as long as someone still reads it (move()
        // and the replacement on close() do not work there then)
        bool canAccess = true;
        if (*kind == FileSystemHandleKind::Directory)
            canAccess = FileSystem::makeAllDirectories(path);
        else if (!exists)
            canAccess = !!FileSystem::openFile(path, FileSystem::FileOpenMode::ReadWrite);
        if (!canAccess)
            return makeUnexpected(Error::Unknown);

        auto identifier = FileSystemHandleIdentifier::generate();
        auto globalIdentifier = FileSystemHandleGlobalIdentifier::generate();
        m_globalEntries.add(globalIdentifier, GlobalEntry { *kind, path, name });
        m_handles.add(identifier, std::make_unique<Handle>(Handle { *kind, WTF::move(path), WTF::move(name), globalIdentifier, std::nullopt, 0, { } }));
        return std::pair { globalIdentifier, identifier };
    }

    Ref<FileSystemHandleCloseScope> closeScope(FileSystemHandleGlobalIdentifier globalIdentifier, FileSystemHandleIdentifier identifier, FileSystemHandleKind kind)
    {
        return FileSystemHandleCloseScope::create(globalIdentifier, identifier, kind, *this);
    }

    Handle* find(FileSystemHandleIdentifier identifier)
    {
        auto it = m_handles.find(identifier);
        return it == m_handles.end() ? nullptr : it->value.get();
    }

    static bool isValidFileName(const String& directory, const String& name)
    {
        // https://fs.spec.whatwg.org/#valid-file-name
        if (name.isEmpty() || name == "."_s || name == ".."_s || name.contains('/'))
            return false;
        return FileSystem::pathFileName(FileSystem::pathByAppendingComponent(directory, name)) == name;
    }

    bool acquireLock(const String& path, bool exclusive)
    {
        auto& lock = m_locks.add(path, FileLock { }).iterator->value;
        if (exclusive) {
            if (lock.exclusive || lock.sharedCount)
                return false;
            lock.exclusive = true;
            return true;
        }
        if (lock.exclusive)
            return false;
        ++lock.sharedCount;
        return true;
    }

    void releaseLock(const String& path)
    {
        auto it = m_locks.find(path);
        if (it == m_locks.end())
            return;
        if (it->value.sharedCount && --it->value.sharedCount)
            return;
        m_locks.remove(it);
    }

    bool hasActiveLock(const String& path) const
    {
        auto prefix = makeString(path, '/');
        for (auto& lockedPath : m_locks.keys()) {
            if (lockedPath == path || lockedPath.startsWith(prefix))
                return true;
        }
        return false;
    }

    void removeGlobalReference(FileSystemHandleGlobalIdentifier globalIdentifier)
    {
        auto it = m_globalEntries.find(globalIdentifier);
        if (it == m_globalEntries.end())
            return;
        if (!--it->value.references)
            m_globalEntries.remove(it);
    }

    std::optional<Error> closeWritableInternal(Handle& handle, FileSystemWritableFileStreamIdentifier streamIdentifier, FileSystemWriteCloseReason reason)
    {
        auto it = handle.writables.find(streamIdentifier);
        if (it == handle.writables.end())
            return Error::InvalidState;
        auto writable = handle.writables.take(it);
        releaseLock(handle.path);
        writable.file = { };
        if (reason == FileSystemWriteCloseReason::Aborted) {
            FileSystem::deleteFile(writable.path);
            return std::nullopt;
        }
        if (renameFile(writable.path, handle.path))
            return std::nullopt;
        FileSystem::deleteFile(writable.path);
        return Error::Unknown;
    }

    // ---------------------------------------------------- FileSystemStorageConnection

    void closeHandle(FileSystemHandleIdentifier identifier) final
    {
        auto* handle = find(identifier);
        if (!handle)
            return;
        if (handle->syncAccessHandle)
            releaseLock(handle->path);
        for (auto streamIdentifier : copyToVector(handle->writables.keys()))
            closeWritableInternal(*handle, streamIdentifier, FileSystemWriteCloseReason::Aborted);
        removeGlobalReference(handle->globalIdentifier);
        m_handles.remove(identifier);
    }

    void isSameEntry(FileSystemHandleIdentifier identifier, FileSystemHandleIdentifier otherIdentifier, SameEntryCallback&& completionHandler) final
    {
        auto* handle = find(identifier);
        auto* other = find(otherIdentifier);
        completionHandler(handle && other && handle->path == other->path);
    }

    void move(FileSystemHandleIdentifier identifier, FileSystemHandleIdentifier destinationIdentifier, const String& newName, VoidCallback&& completionHandler) final
    {
        auto* handle = find(identifier);
        auto* destination = find(destinationIdentifier);
        if (!handle || !destination)
            return completionHandler(toException(Error::Unknown));
        if (hasActiveLock(handle->path))
            return completionHandler(toException(Error::NoModificationAllowed));
        if (destination->kind != FileSystemHandleKind::Directory)
            return completionHandler(toException(Error::TypeMismatch));
        if (!isValidFileName(destination->path, newName))
            return completionHandler(toException(Error::InvalidName));
        auto destinationPath = FileSystem::pathByAppendingComponent(destination->path, newName);
        if (destinationPath != handle->path && hasActiveLock(destinationPath))
            return completionHandler(toException(Error::NoModificationAllowed));
        bool moved = handle->kind == FileSystemHandleKind::Directory ? moveDirectory(handle->path, destinationPath) : renameFile(handle->path, destinationPath);
        if (!moved)
            return completionHandler(toException(Error::Unknown));
        handle->path = destinationPath;
        handle->name = newName;
        completionHandler({ });
    }

    void requestHandle(FileSystemHandleIdentifier identifier, std::optional<FileSystemHandleKind> kind, const String& name, bool createIfNecessary, GetHandleCallback&& completionHandler)
    {
        auto* directory = find(identifier);
        if (!directory)
            return completionHandler(toException(Error::Unknown));
        if (directory->kind != FileSystemHandleKind::Directory)
            return completionHandler(toException(Error::TypeMismatch));
        if (!isValidFileName(directory->path, name))
            return completionHandler(toException(Error::InvalidName));
        auto result = createHandle(kind, FileSystem::pathByAppendingComponent(directory->path, name), String { name }, createIfNecessary);
        if (!result)
            return completionHandler(toException(result.error()));
        auto [globalIdentifier, newIdentifier] = *result;
        completionHandler(closeScope(globalIdentifier, newIdentifier, find(newIdentifier)->kind));
    }

    void getFileHandle(FileSystemHandleIdentifier identifier, const String& name, bool createIfNecessary, GetHandleCallback&& completionHandler) final
    {
        requestHandle(identifier, FileSystemHandleKind::File, name, createIfNecessary, WTF::move(completionHandler));
    }

    void getDirectoryHandle(FileSystemHandleIdentifier identifier, const String& name, bool createIfNecessary, GetHandleCallback&& completionHandler) final
    {
        requestHandle(identifier, FileSystemHandleKind::Directory, name, createIfNecessary, WTF::move(completionHandler));
    }

    void getHandle(FileSystemHandleIdentifier identifier, const String& name, GetHandleCallback&& completionHandler) final
    {
        requestHandle(identifier, std::nullopt, name, false, WTF::move(completionHandler));
    }

    void removeEntry(FileSystemHandleIdentifier identifier, const String& name, bool deleteRecursively, VoidCallback&& completionHandler) final
    {
        auto* directory = find(identifier);
        if (!directory)
            return completionHandler(toException(Error::Unknown));
        if (directory->kind != FileSystemHandleKind::Directory)
            return completionHandler(toException(Error::TypeMismatch));
        if (!isValidFileName(directory->path, name))
            return completionHandler(toException(Error::InvalidName));
        auto path = FileSystem::pathByAppendingComponent(directory->path, name);
        if (!FileSystem::fileExists(path))
            return completionHandler(toException(Error::FileNotFound));
        if (hasActiveLock(path))
            return completionHandler(toException(Error::NoModificationAllowed));
        auto type = FileSystem::fileType(path);
        if (!type)
            return completionHandler(toException(Error::TypeMismatch));
        std::optional<Error> error;
        if (*type == FileSystem::FileType::Directory) {
            if (!deleteRecursively) {
                if (!FileSystem::deleteEmptyDirectory(path))
                    error = FileSystem::listDirectory(path).isEmpty() ? Error::Unknown : Error::InvalidModification;
            } else if (!FileSystem::deleteNonEmptyDirectory(path))
                error = Error::Unknown;
        } else if (!FileSystem::deleteFile(path))
            error = Error::Unknown;
        completionHandler(toExceptionOr(error));
    }

    void resolve(FileSystemHandleIdentifier identifier, FileSystemHandleIdentifier otherIdentifier, ResolveCallback&& completionHandler) final
    {
        auto* handle = find(identifier);
        auto* other = find(otherIdentifier);
        if (!handle || !other)
            return completionHandler(toException(Error::Unknown));
        if (!other->path.startsWith(handle->path))
            return completionHandler(std::optional<Vector<String>> { });
        auto rest = other->path.substring(handle->path.length());
        if (!rest.isEmpty() && !rest.startsWith('/'))
            return completionHandler(std::optional<Vector<String>> { });
        completionHandler(std::optional<Vector<String>> { rest.split('/') });
    }

    void getFile(FileSystemHandleIdentifier identifier, StringCallback&& completionHandler) final
    {
        auto* handle = find(identifier);
        if (!handle)
            return completionHandler(toException(Error::Unknown));
        if (handle->kind != FileSystemHandleKind::File)
            return completionHandler(toException(Error::TypeMismatch));
        completionHandler(String { handle->path });
    }

    void getHandleNames(FileSystemHandleIdentifier identifier, GetHandleNamesCallback&& completionHandler) final
    {
        auto* handle = find(identifier);
        if (!handle)
            return completionHandler(toException(Error::Unknown));
        if (handle->kind != FileSystemHandleKind::Directory)
            return completionHandler(toException(Error::TypeMismatch));
        completionHandler(FileSystem::listDirectory(handle->path));
    }

    // Only in workers: synchronous access through an open file
    void createSyncAccessHandle(FileSystemHandleIdentifier identifier, GetAccessHandleCallback&& completionHandler) final
    {
        auto* handle = find(identifier);
        if (!handle)
            return completionHandler(toException(Error::Unknown));
        if (!acquireLock(handle->path, true))
            return completionHandler(toException(Error::InvalidState));
        auto file = FileSystem::openFile(handle->path, FileSystem::FileOpenMode::ReadWrite);
        if (!file) {
            releaseLock(handle->path);
            return completionHandler(toException(Error::Unknown));
        }
        handle->syncAccessHandle = FileSystemSyncAccessHandleIdentifier::generate();
        handle->syncAccessCapacity = FileSystem::fileSize(handle->path).value_or(0);
        completionHandler(SyncAccessHandleInfo { *handle->syncAccessHandle, WTF::move(file), handle->syncAccessCapacity });
    }

    void closeSyncAccessHandle(FileSystemHandleIdentifier identifier, FileSystemSyncAccessHandleIdentifier accessHandleIdentifier, EmptyCallback&& completionHandler) final
    {
        auto* handle = find(identifier);
        if (handle && handle->syncAccessHandle == accessHandleIdentifier) {
            releaseLock(handle->path);
            handle->syncAccessHandle = std::nullopt;
        }
        completionHandler();
    }

    void requestNewCapacityForSyncAccessHandle(FileSystemHandleIdentifier identifier, FileSystemSyncAccessHandleIdentifier accessHandleIdentifier, uint64_t newCapacity, RequestCapacityCallback&& completionHandler) final
    {
        auto* handle = find(identifier);
        if (!handle || handle->syncAccessHandle != accessHandleIdentifier)
            return completionHandler(std::nullopt);
        // Like WebKit2: grow in big steps, estimate() checks the quota
        if (newCapacity > handle->syncAccessCapacity)
            handle->syncAccessCapacity = std::max<uint64_t>(newCapacity, std::max<uint64_t>(initialCapacity, handle->syncAccessCapacity * 2));
        completionHandler(handle->syncAccessCapacity);
    }

    void registerSyncAccessHandle(FileSystemSyncAccessHandleIdentifier identifier, ScriptExecutionContextIdentifier contextIdentifier) final { m_syncAccessHandles.add(identifier, contextIdentifier); }
    void unregisterSyncAccessHandle(FileSystemSyncAccessHandleIdentifier identifier) final { m_syncAccessHandles.remove(identifier); }

    void invalidateAccessHandle(FileSystemSyncAccessHandleIdentifier identifier) final
    {
        auto contextIdentifier = m_syncAccessHandles.get(identifier);
        if (!contextIdentifier)
            return;
        ScriptExecutionContext::postTaskTo(contextIdentifier, [identifier](auto& context) {
            if (RefPtr scope = dynamicDowncast<WorkerGlobalScope>(context)) {
                // Through the base class: the method is public there
                if (RefPtr<FileSystemStorageConnection> connection = scope->fileSystemStorageConnection())
                    connection->invalidateAccessHandle(identifier);
            }
        });
    }

    // createWritable(): write into a copy, close() replaces the file with it
    void createWritable(ScriptExecutionContextIdentifier, FileSystemHandleIdentifier identifier, bool keepExistingData, StreamCallback&& completionHandler) final
    {
        auto* handle = find(identifier);
        if (!handle)
            return completionHandler(toException(Error::Unknown));
        if (!FileSystem::fileExists(handle->path))
            return completionHandler(toException(Error::FileNotFound));
        if (!acquireLock(handle->path, false))
            return completionHandler(toException(Error::InvalidState));
        FileSystem::makeAllDirectories(swapDirectory);
        auto path = FileSystem::pathByAppendingComponent(swapDirectory, createVersion4UUIDString());
        FileSystem::FileHandle file;
        if (!keepExistingData || FileSystem::copyFile(path, handle->path))
            file = FileSystem::openFile(path, FileSystem::FileOpenMode::ReadWrite);
        if (!file) {
            FileSystem::deleteFile(path);
            releaseLock(handle->path);
            return completionHandler(toException(Error::Unknown));
        }
        auto streamIdentifier = FileSystemWritableFileStreamIdentifier::generate();
        handle->writables.add(streamIdentifier, Writable { WTF::move(file), WTF::move(path) });
        completionHandler(ExceptionOr<FileSystemWritableFileStreamIdentifier> { WTF::move(streamIdentifier) });
    }

    void closeWritable(FileSystemHandleIdentifier identifier, FileSystemWritableFileStreamIdentifier streamIdentifier, FileSystemWriteCloseReason reason, VoidCallback&& completionHandler) final
    {
        auto* handle = find(identifier);
        if (!handle)
            return completionHandler(toException(Error::Unknown));
        completionHandler(toExceptionOr(closeWritableInternal(*handle, streamIdentifier, reason)));
    }

    void executeCommandForWritable(FileSystemHandleIdentifier identifier, FileSystemWritableFileStreamIdentifier streamIdentifier, FileSystemWriteCommandType type, std::optional<uint64_t> position, std::optional<uint64_t> size, std::span<const uint8_t> dataBytes, bool hasDataError, VoidCallback&& completionHandler) final
    {
        auto* handle = find(identifier);
        if (!handle)
            return completionHandler(toException(Error::Unknown));
        auto it = handle->writables.find(streamIdentifier);
        if (it == handle->writables.end())
            return completionHandler(toException(Error::InvalidState));
        auto& file = it->value.file;
        auto run = [&]() -> std::optional<Error> {
            if (hasDataError)
                return Error::InvalidDataType;
            switch (type) {
            case FileSystemWriteCommandType::Write:
                if (position && !file.seek(*position, FileSystem::FileSeekOrigin::Beginning))
                    return Error::Unknown;
                if (!file.write(dataBytes))
                    return writeError();
                return std::nullopt;
            case FileSystemWriteCommandType::Seek:
                if (!position)
                    return Error::MissingArgument;
                if (!file.seek(*position, FileSystem::FileSeekOrigin::Beginning))
                    return Error::Unknown;
                return std::nullopt;
            case FileSystemWriteCommandType::Truncate: {
                if (!size)
                    return Error::MissingArgument;
                if (!file.truncate(*size))
                    return Error::Unknown;
                auto offset = file.seek(0, FileSystem::FileSeekOrigin::Current);
                if (!offset || *offset > *size)
                    file.seek(*size, FileSystem::FileSeekOrigin::Beginning);
                return std::nullopt;
            }
            }
            return Error::Unknown;
        };
        auto error = run();
        if (error)
            closeWritableInternal(*handle, streamIdentifier, FileSystemWriteCloseReason::Aborted);
        completionHandler(toExceptionOr(error));
    }

    // For postMessage/IndexedDB: find handles again by their global identifier
    void addGlobalIdentifierReference(ClientOrigin&&, FileSystemHandleGlobalIdentifier globalIdentifier) final
    {
        auto it = m_globalEntries.find(globalIdentifier);
        if (it != m_globalEntries.end())
            ++it->value.references;
    }

    void removeGlobalIdentifierReferences(ClientOrigin&&, Vector<FileSystemHandleGlobalIdentifier>&& globalIdentifiers) final
    {
        for (auto globalIdentifier : globalIdentifiers)
            removeGlobalReference(globalIdentifier);
    }

    void resolveGlobalIdentifier(ClientOrigin&&, FileSystemHandleGlobalIdentifier globalIdentifier, ResolveGlobalIdentifierCallback&& completionHandler) final
    {
        auto it = m_globalEntries.find(globalIdentifier);
        if (it == m_globalEntries.end())
            return completionHandler(Exception { ExceptionCode::UnknownError, "Failed to resolve handle's global identifier"_s });
        auto entry = it->value;
        auto result = createHandle(entry.kind, WTF::move(entry.path), WTF::move(entry.name), false);
        if (!result)
            return completionHandler(toException(result.error()));
        // Replace the new identifier with the existing one
        auto [newGlobalIdentifier, identifier] = *result;
        m_globalEntries.remove(newGlobalIdentifier);
        if (auto existing = m_globalEntries.find(globalIdentifier); existing != m_globalEntries.end())
            ++existing->value.references;
        find(identifier)->globalIdentifier = globalIdentifier;
        completionHandler(ExceptionOr<FileSystemHandleIdentifier> { WTF::move(identifier) });
    }

    HashMap<FileSystemHandleIdentifier, std::unique_ptr<Handle>> m_handles;
    HashMap<FileSystemHandleGlobalIdentifier, GlobalEntry> m_globalEntries;
    HashMap<String, FileLock> m_locks;
    HashMap<FileSystemSyncAccessHandleIdentifier, ScriptExecutionContextIdentifier> m_syncAccessHandles;
};

} // namespace

void fileSystemGetDirectory(const ClientOrigin& origin, StorageConnection::GetDirectoryCallback&& completionHandler)
{
    ASSERT(isMainThread());
    completionHandler(FileSystemStorageConnectionWasm::singleton().rootDirectory(origin));
}

uint64_t fileSystemUsage(const ClientOrigin& origin)
{
    return directorySize(rootPath(origin));
}

} // namespace BrowserLite
