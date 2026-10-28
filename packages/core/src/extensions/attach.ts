import type { EngineModule } from '../engine.js';
import type { Browser, View } from '../types.js';
import { ATTACH, type AttachableHost, type ExtensionLink } from './link.js';

/** What the browser side of the extensions needs from a running browser. */
interface BrowserSide {
  readonly module: EngineModule;
  readonly ready: boolean;
  readonly views: ReadonlyMap<number, View>;
  text(value: string | null | undefined): number;
}

/**
 * Attaches the extension host of the options to a browser that just became ready, before its
 * first view: page content and messages of the host go to the engine.
 */
export function attachExtensions(
  host: AttachableHost,
  browser: Browser & BrowserSide,
): ExtensionLink {
  const { module } = browser;
  return host[ATTACH]({
    browser,
    views: () => browser.views.values(),
    setContent: (json) => {
      if (browser.ready) module._bl_set_user_content(browser.text(json));
    },
    postMessage: (view, extension, json) => {
      if (browser.ready)
        module._bl_extension_message(view.id, browser.text(extension), browser.text(json));
    },
  });
}

/**
 * The engine event `extension-message` (extension.sendMessage of a script): the answer of the
 * extension or an error goes back to the page with bl_host_call_result.
 */
export async function answerScriptMessage(
  browser: BrowserSide,
  link: ExtensionLink | null,
  data: Record<string, unknown>,
  view: View | undefined,
): Promise<void> {
  const id = Number(data.id);
  let ok = false;
  let result: string;
  try {
    if (!link || !view || view.closed) throw new Error('The extension is not running');
    const answer = await link.message(
      {
        extension: String(data.extension ?? ''),
        url: String(data.url ?? ''),
        message: String(data.message ?? 'null'),
      },
      view,
    );
    result = JSON.stringify(answer ?? null);
    ok = true;
  } catch (error) {
    const e = error as { name?: unknown; message?: unknown } | null;
    result = JSON.stringify({
      name: typeof e?.name === 'string' ? e.name : 'Error',
      message: typeof e?.message === 'string' ? e.message : String(error),
    });
  }
  if (browser.ready) browser.module._bl_host_call_result(id, ok ? 1 : 0, browser.text(result));
}
