// Small in-memory FileSystemDirectoryHandle for the tests (the parts the profile uses).

const notFound = (name) => new DOMException(`${name} not found`, 'NotFoundError');
const mismatch = (name) => new DOMException(`${name} has the other kind`, 'TypeMismatchError');

let clock = 1_700_000_000_000;

export class FakeFile {
  kind = 'file';
  constructor(name, data = new Uint8Array(), parent = null) {
    this.name = name;
    this.data = data;
    this.modified = ++clock;
    this.parent = parent;
    /** Set to an error name to make the next getFile() fail once. */
    this.failNext = null;
  }
  async getFile() {
    if (this.failNext) {
      const name = this.failNext;
      this.failNext = null;
      throw new DOMException('failing', name);
    }
    if (this.parent && this.parent.entries.get(this.name) !== this) throw notFound(this.name);
    return new File([this.data], this.name, { lastModified: this.modified });
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (data) => {
        chunks.push(
          typeof data === 'string'
            ? new TextEncoder().encode(data)
            : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength),
        );
      },
      close: async () => {
        const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        this.data = bytes;
        this.modified = ++clock;
      },
    };
  }
  /** Changes the content like the engine does. */
  set(data) {
    this.data = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.modified = ++clock;
  }
}

export class FakeDir {
  kind = 'directory';
  constructor(name = '') {
    this.name = name;
    this.entries = new Map();
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    const entry = this.entries.get(name);
    if (entry) {
      if (entry.kind !== 'directory') throw mismatch(name);
      return entry;
    }
    if (!create) throw notFound(name);
    const dir = new FakeDir(name);
    this.entries.set(name, dir);
    return dir;
  }
  async getFileHandle(name, { create = false } = {}) {
    const entry = this.entries.get(name);
    if (entry) {
      if (entry.kind !== 'file') throw mismatch(name);
      return entry;
    }
    if (!create) throw notFound(name);
    const file = new FakeFile(name, new Uint8Array(), this);
    this.entries.set(name, file);
    return file;
  }
  async removeEntry(name, { recursive = false } = {}) {
    const entry = this.entries.get(name);
    if (!entry) throw notFound(name);
    if (entry.kind === 'directory' && entry.entries.size && !recursive)
      throw new DOMException('not empty', 'InvalidModificationError');
    this.entries.delete(name);
  }
  async *values() {
    for (const entry of [...this.entries.values()]) yield entry;
  }
  async *keys() {
    for (const name of [...this.entries.keys()]) yield name;
  }

  /** Creates a file (and its directories) synchronously for test setup. */
  put(path, data = '') {
    const parts = path.split('/');
    let dir = this;
    for (const part of parts.slice(0, -1)) {
      let next = dir.entries.get(part);
      if (!next) {
        next = new FakeDir(part);
        dir.entries.set(part, next);
      }
      dir = next;
    }
    const name = parts.at(-1);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const existing = dir.entries.get(name);
    if (existing?.kind === 'file') {
      existing.set(bytes);
      return existing;
    }
    const file = new FakeFile(name, bytes, dir);
    dir.entries.set(name, file);
    return file;
  }

  /** Looks up an entry by path, undefined when missing. */
  at(path) {
    let entry = this;
    for (const part of path.split('/')) {
      entry = entry?.kind === 'directory' ? entry.entries.get(part) : undefined;
    }
    return entry;
  }

  /** Text of a file by path, undefined when missing. */
  text(path) {
    const entry = this.at(path);
    return entry?.kind === 'file' ? new TextDecoder().decode(entry.data) : undefined;
  }

  /** All file paths below this directory, sorted. */
  paths(prefix = '') {
    const all = [];
    for (const [name, entry] of this.entries) {
      const path = prefix + name;
      if (entry.kind === 'file') all.push(path);
      else all.push(...entry.paths(`${path}/`));
    }
    return all.sort();
  }
}
