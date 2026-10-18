import type { Download } from '@browser-lite/core';
import { setStatus } from './toolbar.js';
import { formatSize } from './util.js';

/** A download of this session for the downloads panel (Ctrl+J). */
export interface DownloadEntry {
  readonly filename: string;
  /** Null once its file was dropped from memory (only the last ones are kept). */
  download: Download | null;
  /** Size of the finished file. */
  size?: number;
}

const KEEP_FILES = 10;
const entries: DownloadEntry[] = [];
const listeners = new Set<() => void>();

export const downloads = (): readonly DownloadEntry[] => entries;

/** Calls listener after every change of a download. */
export function onDownloadsChange(listener: () => void): void {
  listeners.add(listener);
}

const changed = () => {
  for (const listener of listeners) listener();
};

/** A download of the pages ('download' event): progress in the status line, saved when done. */
export function addDownload(download: Download): void {
  const entry: DownloadEntry = { filename: download.filename, download };
  entries.push(entry);
  setStatus(`Download: ${download.filename}`);
  changed();
  download.on('progress', () => {
    const total = download.size > 0 ? ` of ${formatSize(download.size)}` : '';
    setStatus(`Download: ${download.filename} ${formatSize(download.received)}${total}`);
  });
  download.on('error', () => {
    setStatus(`Download failed: ${download.filename} (${download.error ?? ''})`);
    changed();
  });
  download.on('done', () => {
    download.save();
    entry.size = download.blob?.size ?? download.size;
    setStatus(`Download finished: ${download.filename} (${formatSize(download.blob?.size)})`);
    // Old files leave memory (the list keeps the name)
    const kept = entries.filter((e) => e.download?.state === 'done');
    const oldest = kept[0];
    if (kept.length > KEEP_FILES && oldest) oldest.download = null;
    changed();
  });
}

/** State text of a download for the panel. */
export function downloadState(entry: DownloadEntry): string {
  const download = entry.download;
  if (!download) return formatSize(entry.size);
  if (download.state === 'failed') return `Error: ${download.error ?? ''}`;
  if (download.state === 'done') return formatSize(download.blob?.size ?? download.size);
  return `${formatSize(download.received)} of ${download.size ? formatSize(download.size) : '?'}`;
}
