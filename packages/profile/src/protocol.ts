/** Head of the answer to POST open. */
export interface OpenHead {
  id: string;
  session: string;
  created?: number;
  prefs: Record<string, unknown>;
  files: { path: string; size: number }[];
}

/** A file of the profile as the server sent it. */
export interface ProfileFile {
  path: string;
  data: Uint8Array;
}

/** Error of a writing request. `reason` when another device took over or reset the profile. */
export class ProfileError extends Error {
  readonly status?: number;
  readonly reason?: 'taken' | 'reset';
  constructor(message: string, o: { status?: number; reason?: 'taken' | 'reset' } = {}) {
    super(message);
    this.name = 'ProfileError';
    this.status = o.status;
    this.reason = o.reason;
  }
}

/** Joins chunks into one array. */
export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Request path of a profile file. */
export function filePath(path: string): string {
  return `files/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Incremental reader of the open answer: u32 LE length of the head, the head (JSON), then the
 * contents of all files of the head one after the other.
 */
export class OpenReader {
  #chunks: Uint8Array[] = [];
  #received = 0;
  #head: OpenHead | null = null;

  /** Adds bytes; returns the head once when it became complete with this chunk. */
  push(chunk: Uint8Array): OpenHead | null {
    this.#chunks.push(chunk);
    this.#received += chunk.length;
    if (this.#head || this.#received < 4) return null;
    const start = concat(this.#chunks);
    this.#chunks = [start];
    const headEnd = 4 + new DataView(start.buffer, start.byteOffset).getUint32(0, true);
    if (this.#received < headEnd) return null;
    this.#head = JSON.parse(new TextDecoder().decode(start.subarray(4, headEnd))) as OpenHead;
    return this.#head;
  }

  /** The files after the last chunk; throws when the answer is incomplete or too long. */
  finish(): { head: OpenHead; files: ProfileFile[] } {
    const head = this.#head;
    if (!head) throw new Error('Profile incomplete');
    const bytes = concat(this.#chunks);
    let offset = 4 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    const files = head.files.map(({ path, size }) => {
      offset += size;
      return { path, data: bytes.subarray(offset - size, offset) };
    });
    if (offset !== bytes.length) throw new Error('Profile incomplete');
    return { head, files };
  }
}

/** Browser and system of the host, shown where the profile is open ("Chrome on Linux"). */
export function hostDevice(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const system = /CrOS/.test(ua)
    ? 'ChromeOS'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'unknown system';
  return `${browser} on ${system}`;
}
