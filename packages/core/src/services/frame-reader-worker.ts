/**
 * Module worker of {@link FrameReader} (frame-reader.ts): draws a `VideoFrame` of a host `<video>`
 * at the requested size and reads its pixels (RGBA, not premultiplied), so the GPU readback blocks
 * this thread instead of the host's main thread. One canvas per player, released with `release`.
 */

/** A frame to read, or the end of a player's canvas. */
export type FrameRequest =
  | { type: 'read'; id: number; player: number; frame: VideoFrame; width: number; height: number }
  | { type: 'release'; player: number };

/** The pixels of a read (`width * height * 4` bytes), or why it failed. */
export interface FrameAnswer {
  id: number;
  pixels?: ArrayBuffer;
  error?: string;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FrameRequest>) => void) | null;
  postMessage(message: FrameAnswer, transfer: Transferable[]): void;
};

const contexts = new Map<number, OffscreenCanvasRenderingContext2D>();

function read(player: number, frame: VideoFrame, width: number, height: number): ArrayBuffer {
  let context = contexts.get(player);
  if (!context || context.canvas.width !== width || context.canvas.height !== height) {
    // With alpha: VP9 and HEVC videos can be transparent. Each frame replaces the last one.
    const created = new OffscreenCanvas(width, height).getContext('2d', {
      willReadFrequently: true,
    });
    if (!created) throw new Error('No 2D context');
    created.globalCompositeOperation = 'copy';
    contexts.set(player, created);
    context = created;
  }
  context.drawImage(frame, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data.buffer as ArrayBuffer;
}

scope.onmessage = ({ data }) => {
  if (data.type === 'release') {
    contexts.delete(data.player);
    return;
  }
  const { id, player, frame, width, height } = data;
  try {
    const pixels = read(player, frame, width, height);
    scope.postMessage({ id, pixels }, [pixels]);
  } catch (error) {
    scope.postMessage({ id, error: `${(error as Error)?.message ?? error}` }, []);
  } finally {
    frame.close();
  }
};
