import type { EngineModule } from './engine.js';
import type { SkippedFile } from './types.js';
import type { ViewImpl } from './view.js';

/** Largest file a page gets from an upload, drop or paste. */
export const MAX_UPLOAD = 512 * 1024 * 1024;

/** Upload directory of a view in the engine (under /data/tmp, emptied at engine start). */
export const uploadDirectory = (view: number) => `/data/tmp/uploads/${view}`;

interface UploadHost {
  readonly module: EngineModule;
  readonly ready: boolean;
  text(value: string): number;
}

/**
 * Files (upload, drop, paste) into the engine file system under /data/tmp (OPFS, not WASM
 * memory). The page reads them as long as it has its File objects (also after navigating), so
 * they are deleted only when the view closes. The engine thread reads the files itself.
 */
export class Uploads {
  private counter = 0;

  constructor(private readonly host: UploadHost) {}

  /** Engine paths of the files that were written; the others go out as `files-skipped`. */
  async write(view: ViewImpl, files: File[]): Promise<string[]> {
    const { host } = this;
    const uploads: { name: string; file: File; path: string }[] = [];
    const skipped: SkippedFile[] = [];
    for (const file of files) {
      // A pasted image is called "image.png" in Chrome
      const name = (file.name || 'image.png').replace(/[/\n]/g, '_');
      if (file.size > MAX_UPLOAD) skipped.push({ name, reason: 'too-large' });
      else
        uploads.push({ name, file, path: `${uploadDirectory(view.id)}/${++this.counter}/${name}` });
    }
    const write = host.module.blWriteFiles;
    const written =
      uploads.length && write && host.ready
        ? await write(uploads.map(({ file, path }) => ({ file, path })))
        : [];
    if (!view.alive) {
      // Closed meanwhile: its directory is gone, remove what came after
      if (host.ready) host.module._bl_remove_path(host.text(uploadDirectory(view.id)));
      return [];
    }
    const paths: string[] = [];
    uploads.forEach((upload, i) => {
      if (written[i]) paths.push(upload.path);
      else skipped.push({ name: upload.name, reason: 'unreadable' });
    });
    if (skipped.length) view.emit('files-skipped', { files: skipped });
    return paths;
  }
}
