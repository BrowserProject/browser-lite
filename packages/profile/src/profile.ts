import type { Browser } from '@browser-lite/core';
import {
  clearDirectory,
  folder,
  folderSize,
  isTransient,
  readText,
  removePath,
  writeFile,
} from './opfs.js';
import {
  filePath,
  hostDevice,
  type OpenHead,
  OpenReader,
  ProfileError,
  type ProfileFile,
} from './protocol.js';
import { type FileEntry, scan, siteOfPath, type Unit, unitOf } from './scan.js';
import { createStore, type KeyValueStore } from './store.js';

/**
 * off: no profile (not started, memory only or the browser is open in another tab), local:
 * server not reachable, connected, taken / reset: another device took over or reset the profile.
 */
export type ProfileStatus = 'off' | 'local' | 'connected' | 'taken' | 'reset';

/** English descriptions of the states. */
export const statusTexts: Readonly<Record<ProfileStatus, string>> = Object.freeze({
  off: 'No profile in this tab: the browser is not running here or already open in another tab',
  local: 'Profile server not reachable, changes stay on this device',
  connected: 'Connected to the profile server',
  taken: 'The profile was opened on another device, nothing is saved here any more',
  reset: 'The profile was reset on another device',
});

/** Default size limit per database in KB; larger databases stay on the device. */
export const DEFAULT_DB_LIMIT_KB = 256;

/** Answer of the server about the stored profile. */
export interface ProfileInfo {
  id: string;
  created: number;
  updated: number;
  /** Device that opened the profile last ("Chrome on Linux"). */
  device: string | null;
  opened: number | null;
  maxBytes: number;
  bytes: number;
  files: { path: string; size: number; modified: number }[];
  /** Cookies per domain, null when the server cannot read cookies.db. */
  cookies: { domain: string; count: number }[] | null;
}

/** A database that stays on this device because it is larger than the limit. */
export interface LocalDatabase {
  path: string;
  site: string;
  size: number;
  kind: 'IndexedDB' | 'localStorage';
}

/** What is stored only on this device (bytes). */
export interface LocalStats {
  databases: LocalDatabase[];
  cacheStorage: number;
  serviceWorkers: number;
  pageFiles: number;
  /** HTTP cache of the engine (Cache API of the whole origin), null when unknown. */
  httpCache: number | null;
}

/** Options of {@link createProfile}. */
export interface ProfileOptions {
  /** Base URL of the profile endpoint of the server, for example '/profile/'. */
  url: string | URL;
  /**
   * Size limit per database in KB (cookies.db has none); a function is read at every sync, so a
   * setting can change it. Default {@link DEFAULT_DB_LIMIT_KB}.
   */
  dbLimitKB?: number | (() => number);
  /** Fetch for all requests, for example to add an Authorization header. */
  fetch?: typeof fetch;
  /** Prefs that hold site data: reset(false) clears them too. Default `['permissions']`. */
  sitePrefs?: string[];
}

/** Browser client of the profile on the server. */
export interface Profile {
  readonly status: ProfileStatus;
  readonly statusText: string;
  /** Problem of the last sync while connected ('' when none). */
  readonly problem: string;
  /** Pass as BrowserOptions.storage.beforeStart. */
  beforeStart(dir: FileSystemDirectoryHandle): Promise<void>;
  /** Starts the periodic sync (visible 2 s, hidden 30 s) using browser.storage. */
  attach(browser: Browser): void;
  /**
   * Value of a pref, undefined when not set. Names match `^[a-z][a-z0-9-]{0,31}$` (the server
   * keeps at most 32 prefs of 4 MB together).
   */
  prefs<T = unknown>(name: string): T | undefined;
  /**
   * Saves locally at once and on the server when connected (else at the next start). A pref the
   * server refuses (name, size, limits) stays local and sets `problem`.
   */
  savePrefs(name: string, value: unknown): void;
  /** Resolves when the prefs are on the server, at most after timeoutMs (default 5000). */
  prefsSaved(timeoutMs?: number): Promise<void>;
  /** Information of the server, null without connection. */
  info(): Promise<ProfileInfo | null>;
  localStats(): Promise<LocalStats>;
  /**
   * Deletes site data (all = false: cookies, site storage, the `sitePrefs`) or the whole profile
   * (also all other prefs) on the server and here. The storage directory is cleared at the next
   * start, so destroy the browser or reload the page afterwards. Only while connected or local.
   */
  reset(all: boolean): Promise<void>;
  /** `status` fires when status, statusText or problem change. */
  on(type: 'status', listener: () => void): () => void;
}

const VISIBLE_INTERVAL = 2000;
const HIDDEN_INTERVAL = 30000;
const AFTER_HIDE = 2500;
/** open: until the head of the answer arrived, then for all files. */
const OPEN_TIMEOUT = 10000;
const DOWNLOAD_TIMEOUT = 120000;
/** File in the storage directory with the id of the profile inside. */
const MARKER = 'profile-id';

/** What is uploaded: files with [size, lastModified]; prefs not yet on the server. */
interface SyncRecord {
  id?: string;
  session?: string;
  files: Record<string, [number, number]>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isHidden = () => typeof document !== 'undefined' && document.hidden;

/** Creates the client; nothing happens before beforeStart. */
export function createProfile(options: ProfileOptions): Profile {
  return new ProfileClient(options);
}

class ProfileClient implements Profile {
  #base: URL;
  #fetch: typeof fetch;
  #dbLimitKB: number | (() => number);
  #sitePrefs: string[];
  #store: KeyValueStore;
  #status: ProfileStatus = 'off';
  #problem = '';
  #listeners = new Set<() => void>();
  #top: FileSystemDirectoryHandle | null = null;
  #browser: Browser | null = null;
  #record: SyncRecord = { files: {} };
  #prefs: Record<string, unknown>;
  #unsentPrefs = new Set<string>();
  #prefsQueue: Promise<void> = Promise.resolve();
  #syncing: Promise<SyncResult | null> | null = null;
  #syncTimer: ReturnType<typeof setTimeout> | undefined;
  /** A missing file may be replaced by the engine right now: delete it only the second time. */
  #missing = new Set<string>();
  /** Rejected by the server (path, too large, profile full) until the file changes. */
  #rejected = new Map<string, string>();

  constructor(options: ProfileOptions) {
    const href = String(options.url);
    const base = new URL(href, globalThis.location?.href);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    this.#base = base;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#dbLimitKB = options.dbLimitKB ?? DEFAULT_DB_LIMIT_KB;
    this.#sitePrefs = [...(options.sitePrefs ?? ['permissions'])];
    this.#store = createStore(`bl-profile ${base.href}`);
    this.#prefs = this.#store.readJSON<Record<string, unknown>>('prefs') ?? {};
    // Methods work unbound, for example `storage: { beforeStart: profile.beforeStart }`
    for (const name of [
      'beforeStart',
      'attach',
      'prefs',
      'savePrefs',
      'prefsSaved',
      'info',
      'localStats',
      'reset',
      'on',
    ] as const)
      Object.defineProperty(this, name, { value: this[name].bind(this) });
  }

  get status() {
    return this.#status;
  }

  get statusText() {
    return statusTexts[this.#status];
  }

  get problem() {
    return this.#problem;
  }

  on(type: 'status', listener: () => void): () => void {
    if (type !== 'status') return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('profile: status listener failed', error);
      }
    }
  }

  #setStatus(status: ProfileStatus) {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit();
  }

  #setProblem(problem: string) {
    if (this.#problem === problem) return;
    this.#problem = problem;
    this.#emit();
  }

  #dbLimit(): number {
    const kb = typeof this.#dbLimitKB === 'function' ? this.#dbLimitKB() : this.#dbLimitKB;
    return (Number.isFinite(kb) && kb > 0 ? kb : DEFAULT_DB_LIMIT_KB) * 1024;
  }

  #directory(): FileSystemDirectoryHandle | null {
    return this.#browser?.storage.directory ?? this.#top;
  }

  #saveRecord() {
    this.#store.writeJSON('sync', { ...this.#record, prefs: [...this.#unsentPrefs] });
  }

  #savePrefsCache() {
    this.#store.writeJSON('prefs', this.#prefs);
  }

  // ------------------------------------------------------------ server

  #request(
    path: string,
    o: {
      method?: string;
      body?: BodyInit;
      json?: unknown;
      timeout?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    let body = o.body;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers['Content-Type'] = 'application/json';
    }
    if (this.#record.session) headers['X-Profile-Session'] = this.#record.session;
    return this.#fetch(new URL(path, this.#base), {
      method: o.method ?? 'GET',
      body,
      headers,
      cache: 'no-store',
      signal: o.signal ?? AbortSignal.timeout(o.timeout ?? 60000),
    });
  }

  /** Writing request; 409 means another device took over (error.reason). */
  async #write(
    path: string,
    method: string,
    o: { body?: BodyInit; json?: unknown; timeout?: number } = {},
  ) {
    const response = await this.#request(path, { method, ...o });
    if (response.status === 409) {
      const answer = (await response.json().catch(() => null)) as { reason?: string } | null;
      const reason = answer?.reason === 'reset' ? 'reset' : 'taken';
      throw new ProfileError(statusTexts[reason], { status: 409, reason });
    }
    if (!response.ok)
      throw new ProfileError(`Profile server: HTTP ${response.status}`, {
        status: response.status,
      });
  }

  /**
   * POST open. The new session counts on the server as soon as it answers: onHead runs before
   * the files arrived.
   */
  async #fetchProfile(onHead: (head: OpenHead) => void) {
    const controller = new AbortController();
    const abortAfter = (ms: number) =>
      setTimeout(
        () => controller.abort(new DOMException('Profile server does not answer', 'TimeoutError')),
        ms,
      );
    let timer = abortAfter(OPEN_TIMEOUT);
    try {
      const device = hostDevice(globalThis.navigator?.userAgent ?? '');
      const response = await this.#request('open', {
        method: 'POST',
        json: { device },
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw new ProfileError(`Profile server: HTTP ${response.status}`, {
          status: response.status,
        });
      clearTimeout(timer);
      timer = abortAfter(DOWNLOAD_TIMEOUT);
      const reader = response.body.getReader();
      const open = new OpenReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        const head = open.push(chunk.value);
        if (head) onHead(head);
      }
      return open.finish();
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------ start

  async beforeStart(dir: FileSystemDirectoryHandle): Promise<void> {
    if (this.#browser && this.#browser.state !== 'ready') this.#detach();
    // A sync of the previous browser must finish before the record is read and the seed runs
    await this.#syncing;
    this.#top = dir;
    try {
      if (this.#store.read('clear')) {
        await clearDirectory(dir);
        this.#store.write('clear', null);
      }
      const saved = this.#store.readJSON<SyncRecord & { prefs?: string[] }>('sync');
      this.#unsentPrefs = new Set(saved?.prefs ?? []);
      this.#record = { files: saved?.files ?? {}, id: saved?.id, session: saved?.session };
      let catchUp: SyncResult = { taken: false, pending: new Set() };
      // Upload what did not get out last time, while this device still has the profile
      if (this.#record.session && this.#record.id === (await readText(dir, MARKER)))
        catchUp = (await this.#sync(true)) ?? catchUp;
      // Another device took over meanwhile: then the server counts
      if (catchUp.taken) this.#unsentPrefs.clear();
      const opened = await this.#fetchProfile((head) => {
        this.#record = {
          id: head.id,
          session: head.session,
          files: head.id === this.#record.id ? this.#record.files : {},
        };
        this.#saveRecord();
      });
      await this.#seed(dir, opened, catchUp.pending);
    } catch (error) {
      console.warn('profile:', error);
      this.#setStatus('local');
      return;
    }
    this.#setStatus('connected');
    void this.#flushPrefs();
    if (this.#browser) this.#scheduleSync(VISIBLE_INTERVAL);
  }

  /**
   * The profile of the server into the directory. Another profile (new device, reset): clear
   * everything first. Else the server counts, except for pending databases (not uploaded while
   * catching up), which stay. A database that was in the profile and is no longer on the server
   * was deleted elsewhere. Databases that never were in the profile stay.
   */
  async #seed(
    top: FileSystemDirectoryHandle,
    { head, files }: { head: OpenHead; files: ProfileFile[] },
    pending: Set<string>,
  ) {
    const local = this.#prefs;
    this.#prefs = { ...head.prefs };
    for (const name of this.#unsentPrefs) this.#prefs[name] = local[name] ?? null;
    this.#savePrefsCache();
    let keep = pending;
    if ((await readText(top, MARKER)) !== head.id) {
      await clearDirectory(top);
      keep = new Set();
    } else {
      const remote = new Set(files.map((file) => unitOf(file.path)));
      const known = new Set(Object.keys(this.#record.files).map(unitOf));
      for (const unit of await scan(top, this.#dbLimit())) {
        if (!keep.has(unit.key) && (remote.has(unit.key) || known.has(unit.key)))
          await removePath(top, unit.key);
      }
    }
    // WebKit rebuilds it from the .localstorage files at start
    await removePath(top, 'localstorage/LegacyStorageTracker.db');
    // Pending databases keep their old stamps, the sync uploads them
    const stamps = Object.fromEntries(
      Object.entries(this.#record.files).filter(([path]) => keep.has(unitOf(path))),
    );
    for (const file of files) {
      if (keep.has(unitOf(file.path))) continue;
      const written = await writeFile(top, file.path, file.data as Uint8Array<ArrayBuffer>);
      stamps[file.path] = [written.size, written.lastModified];
    }
    await writeFile(top, MARKER, head.id);
    this.#record.files = stamps;
    this.#saveRecord();
  }

  attach(browser: Browser): void {
    if (this.#browser === browser) return;
    this.#browser = browser;
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', this.#onVisibility);
    this.#scheduleSync(VISIBLE_INTERVAL);
  }

  #detach() {
    clearTimeout(this.#syncTimer);
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.#onVisibility);
    this.#browser = null;
  }

  #onVisibility = () => {
    // The core flushes the storage itself when the page is hidden
    this.#scheduleSync(isHidden() ? AFTER_HIDE : VISIBLE_INTERVAL);
  };

  // ------------------------------------------------------------ sync

  #scheduleSync(ms: number) {
    clearTimeout(this.#syncTimer);
    if (this.#status !== 'connected' || !this.#browser) return;
    this.#syncTimer = setTimeout(async () => {
      if (this.#browser?.state === 'destroyed') {
        this.#detach();
        return;
      }
      await this.#sync();
      this.#scheduleSync(isHidden() ? HIDDEN_INTERVAL : VISIBLE_INTERVAL);
    }, ms);
  }

  #stop(reason: 'taken' | 'reset') {
    clearTimeout(this.#syncTimer);
    this.#setStatus(reason);
  }

  /**
   * Uploads changes and deletes on the server what is gone locally or became too large.
   * beforeStart: the engine does not run yet, nothing is being replaced; returns then whether
   * another device took over and the databases that did not get to the server.
   */
  #sync(beforeStart = false): Promise<SyncResult | null> {
    if (this.#syncing || !this.#record.session || (!beforeStart && this.#status !== 'connected'))
      return this.#syncing ?? Promise.resolve(null);
    const syncing = this.#runSync(beforeStart).finally(() => {
      this.#syncing = null;
    });
    this.#syncing = syncing;
    return syncing;
  }

  #changed(file: FileEntry): boolean {
    const known = this.#record.files[file.path];
    return !known || known[0] !== file.size || known[1] !== file.modified;
  }

  async #runSync(beforeStart: boolean): Promise<SyncResult | null> {
    const timeout = beforeStart ? 10000 : 60000;
    // Nothing more is written after reset()
    const active = () => beforeStart || this.#status === 'connected';
    let units: Unit[] | null = null;
    let taken = false;
    try {
      const top = this.#directory();
      if (!top) throw new Error('No storage directory');
      units = await scan(top, this.#dbLimit());
      const byKey = new Map(units.map((unit) => [unit.key, unit]));
      const present = new Set<string>();
      for (const unit of units) {
        if (unit.unstable || unit.big) continue;
        for (const file of unit.files) {
          present.add(file.path);
          if (this.#changed(file) && active()) await this.#upload(file, timeout);
        }
      }
      const stillMissing = new Set<string>();
      for (const path of Object.keys(this.#record.files)) {
        const unit = byKey.get(unitOf(path));
        if (present.has(path) || unit?.unstable || !active()) continue;
        if (unit?.big || beforeStart || this.#missing.has(path)) {
          // 400: no path of the profile, so the server does not have it either
          await this.#write(filePath(path), 'DELETE', { timeout }).catch((error: unknown) => {
            if ((error as ProfileError).status !== 400) throw error;
          });
          delete this.#record.files[path];
        } else {
          stillMissing.add(path);
        }
      }
      this.#missing = stillMissing;
      this.#setProblem(
        this.#rejected.size ? 'Not everything fits into the profile (server limit)' : '',
      );
      if (this.#unsentPrefs.size && !beforeStart) void this.#flushPrefs();
    } catch (error) {
      const reason = (error as ProfileError).reason;
      if (reason) {
        taken = true;
        if (!beforeStart) this.#stop(reason);
      } else {
        this.#setProblem('Connection to the profile server interrupted, retrying');
        console.warn('profile:', error);
      }
    } finally {
      this.#saveRecord();
    }
    if (!beforeStart) return null;
    if (!units) throw new Error('Profile in the storage directory not readable');
    return { taken, pending: taken ? new Set() : this.#unsynced(units) };
  }

  /**
   * Databases whose state is not on the server: changed or new (also rejected), deleted
   * locally or became too large while the server still has them.
   */
  #unsynced(units: Unit[]): Set<string> {
    const pending = new Set<string>();
    const present = new Set<string>();
    for (const unit of units) {
      if (unit.big) continue;
      if (unit.unstable || unit.files.some((file) => this.#changed(file))) pending.add(unit.key);
      for (const file of unit.files) present.add(file.path);
    }
    for (const path of Object.keys(this.#record.files))
      if (!present.has(path)) pending.add(unitOf(path));
    return pending;
  }

  async #upload(file: FileEntry, timeout: number) {
    const stamp = `${file.size}:${file.modified}`;
    if (this.#rejected.get(file.path) === stamp) return;
    this.#rejected.delete(file.path);
    for (let attempt = 1; ; attempt++) {
      try {
        const snapshot = await file.handle.getFile();
        await this.#write(filePath(file.path), 'PUT', {
          body: await snapshot.arrayBuffer(),
          timeout,
        });
        this.#record.files[file.path] = [snapshot.size, snapshot.lastModified];
        return;
      } catch (error) {
        if (isTransient(error)) {
          if (attempt === 3) return;
          await sleep(250);
          continue;
        }
        const status = (error as { status?: number }).status;
        if (status === 400 || status === 413 || status === 507) {
          this.#rejected.set(file.path, stamp);
          return;
        }
        throw error;
      }
    }
  }

  // ------------------------------------------------------------ prefs

  prefs<T = unknown>(name: string): T | undefined {
    return (this.#prefs[name] ?? undefined) as T | undefined;
  }

  savePrefs(name: string, value: unknown): void {
    this.#prefs[name] = value;
    this.#savePrefsCache();
    if (this.#status === 'off') return;
    this.#unsentPrefs.add(name);
    this.#saveRecord();
    if (this.#status === 'connected') void this.#flushPrefs();
  }

  #flushPrefs(): Promise<void> {
    this.#prefsQueue = this.#prefsQueue.then(async () => {
      for (const name of [...this.#unsentPrefs]) {
        if (this.#status !== 'connected') return;
        const value = this.#prefs[name] ?? null;
        const sent = JSON.stringify(value);
        try {
          await this.#write(`prefs/${encodeURIComponent(name)}`, 'PUT', { json: value });
        } catch (error) {
          const { reason, status } = error as ProfileError;
          if (reason) this.#stop(reason);
          // Else again at the next sync, unless refused for good: then it stays local
          if (reason || !(status === 400 || status === 413 || status === 507)) return;
          this.#unsentPrefs.delete(name);
          this.#saveRecord();
          this.#setProblem(`The server refused the pref ${name} (HTTP ${status})`);
          continue;
        }
        // Changed again during the request: send again
        if (JSON.stringify(this.#prefs[name] ?? null) === sent) {
          this.#unsentPrefs.delete(name);
          this.#saveRecord();
        }
      }
    });
    return this.#prefsQueue;
  }

  prefsSaved(timeoutMs = 5000): Promise<void> {
    return Promise.race([this.#prefsQueue, sleep(timeoutMs)]);
  }

  // ------------------------------------------------------------ info and maintenance

  async info(): Promise<ProfileInfo | null> {
    if (this.#status === 'off') return null;
    try {
      const response = await this.#request('info', { timeout: 10000 });
      return response.ok ? ((await response.json()) as ProfileInfo) : null;
    } catch {
      return null;
    }
  }

  async localStats(): Promise<LocalStats> {
    const top = this.#directory();
    const limit = this.#dbLimit();
    const databases = (top ? await scan(top, Number.POSITIVE_INFINITY) : [])
      .filter((unit) => unit.key !== 'cookies.db' && unit.size > limit)
      .map(
        (unit): LocalDatabase => ({
          path: unit.key,
          site: siteOfPath(unit.key),
          size: unit.size,
          kind: unit.key.startsWith('indexeddb/') ? 'IndexedDB' : 'localStorage',
        }),
      );
    const size = async (name: string) => folderSize(await folder(top, [name]));
    const estimate = (await globalThis.navigator?.storage?.estimate?.().catch(() => null)) as
      | (StorageEstimate & { usageDetails?: { caches?: number } })
      | null;
    return {
      databases,
      cacheStorage: await size('cachestorage'),
      serviceWorkers: await size('serviceworkers'),
      pageFiles: await size('opfs'),
      httpCache: estimate?.usageDetails?.caches ?? null,
    };
  }

  async reset(all: boolean): Promise<void> {
    if (this.#status !== 'connected' && this.#status !== 'local') throw new Error(this.statusText);
    const connected = this.#status === 'connected';
    this.#status = 'off';
    clearTimeout(this.#syncTimer);
    // A running sync must not upload anything after the reset
    await this.#syncing;
    await this.#prefsQueue;
    if (connected) {
      try {
        await this.#write('reset', 'POST', {
          json: { all, prefs: this.#sitePrefs },
          timeout: 10000,
        });
      } catch (error) {
        const reason = (error as ProfileError).reason;
        if (reason) this.#status = reason;
        else this.#status = 'connected';
        this.#emit();
        this.#scheduleSync(VISIBLE_INTERVAL);
        throw error;
      }
    }
    const cleared = all ? Object.keys(this.#prefs) : this.#sitePrefs;
    for (const name of cleared) delete this.#prefs[name];
    for (const name of all ? [...this.#unsentPrefs] : cleared) this.#unsentPrefs.delete(name);
    this.#savePrefsCache();
    this.#record = { files: {} };
    this.#saveRecord();
    this.#store.write('clear', '1');
    this.#emit();
  }
}

interface SyncResult {
  taken: boolean;
  pending: Set<string>;
}
