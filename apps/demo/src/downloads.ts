import type { Download } from '@browser-lite/core';
import { setStatus } from './toolbar.js';
import { formatSize, readJSON } from './util.js';

/**
 * A download for the downloads panel (Ctrl+J). Like Chrome the list outlives a restart: it is
 * kept in localStorage of this device (like the history), the files only in memory.
 */
export interface DownloadEntry {
  readonly id: string;
  readonly filename: string;
  /** Address the file came from; empty when it cannot be loaded again (data:, blob:). */
  readonly url: string;
  /** Start in ms since the epoch. */
  readonly time: number;
  /** Like `Download.state`; a download the demo ended during (a reload) is an 'error' 'Aborted'. */
  state: Download['state'];
  /** Why it failed, the core's text ('Cancelled', 'Aborted', 'HTTP 404', ...). */
  error?: string;
  /** Size of the finished file. */
  size?: number;
  /** The core's download while its file is in memory; null after a restart or once dropped. */
  download: Download | null;
}

/** What localStorage keeps of an entry. */
type Saved = Omit<DownloadEntry, 'download'>;

const KEY = 'bl-downloads';
const MAX_ENTRIES = 100;
const KEEP_FILES = 10;
const entries: DownloadEntry[] = readJSON<Saved[]>(KEY, []).map(restore);
const listeners = new Set<() => void>();

/** A saved entry as it is after a restart: no file, a running one was aborted. */
function restore(saved: Saved): DownloadEntry {
  const entry: DownloadEntry = { ...saved, download: null };
  if (entry.state === 'progress') {
    entry.state = 'error';
    entry.error = 'Aborted';
  }
  return entry;
}

export const downloads = (): readonly DownloadEntry[] => entries;

/**
 * Calls listener when a download starts, ends or the list was cleared; its progress comes as the
 * `progress` event of the core's Download.
 */
export function onDownloadsChange(listener: () => void): void {
  listeners.add(listener);
}

const changed = () => {
  for (const listener of listeners) listener();
};

const saved = ({ download: _, ...rest }: DownloadEntry): Saved => rest;

/** Writes entry into the stored list; other demo tabs of this device write theirs too. */
function persist(entry: DownloadEntry): void {
  const list = readJSON<Saved[]>(KEY, []).filter((other) => other.id !== entry.id);
  list.push(saved(entry));
  write(list.slice(-MAX_ENTRIES));
}

function write(list: Saved[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Full: the list stays in this session
  }
}

/** Only web addresses can be requested again (data: comes without its data, blob: dies). */
const reloadable = (url: string) => (/^https?:/i.test(url) ? url : '');

/** A download of the pages ('download' event): progress in the status line, saved when done. */
export function addDownload(download: Download): void {
  const entry: DownloadEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    filename: download.filename,
    url: reloadable(download.url),
    time: Date.now(),
    state: 'progress',
    download,
  };
  entries.push(entry);
  // Ended entries beyond the limit leave the list, the oldest first
  while (entries.length > MAX_ENTRIES) {
    const index = entries.findIndex((e) => e.state !== 'progress');
    if (index < 0) break;
    entries.splice(index, 1);
  }
  persist(entry);
  setStatus(`Download: ${download.filename}`);
  changed();
  download.on('progress', () => {
    const total = download.size > 0 ? ` of ${formatSize(download.size)}` : '';
    setStatus(`Download: ${download.filename} ${formatSize(download.received)}${total}`);
  });
  download.on('error', () => {
    entry.state = 'error';
    entry.error = download.error;
    persist(entry);
    setStatus(
      cancelled(entry)
        ? `Download cancelled: ${download.filename}`
        : `Download failed: ${download.filename} (${download.error ?? ''})`,
    );
    changed();
  });
  download.on('done', () => {
    download.save();
    entry.state = 'done';
    entry.size = download.blob?.size ?? download.size;
    persist(entry);
    setStatus(`Download finished: ${download.filename} (${formatSize(download.blob?.size)})`);
    // Old files leave memory (the list keeps the name)
    const kept = entries.filter((e) => e.download?.state === 'done');
    const oldest = kept[0];
    if (kept.length > KEEP_FILES && oldest) oldest.download = null;
    changed();
  });
}

/** Removes the ended downloads from the list (Chrome's "Clear all"); running ones stay. */
export function clearDownloads(): void {
  const running = entries.filter((e) => e.state === 'progress');
  entries.splice(0, entries.length, ...running);
  write(readJSON<Saved[]>(KEY, []).filter((other) => running.some((e) => e.id === other.id)));
  changed();
}

/** Stopped with `Download.cancel()` (the core's error text for it). */
const cancelled = (entry: DownloadEntry) => entry.error === 'Cancelled';

/** State text of a download for the panel. */
export function downloadState(entry: DownloadEntry): string {
  if (entry.state === 'error')
    return cancelled(entry) ? 'Cancelled' : `Error: ${entry.error ?? ''}`;
  if (entry.state === 'done') return formatSize(entry.size);
  const download = entry.download;
  return `${formatSize(download?.received)} of ${download?.size ? formatSize(download.size) : '?'}`;
}
