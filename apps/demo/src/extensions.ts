import { createExtensionHost, type Extension, type ExtensionStore } from '@browser-lite/core';
import { createUiSlots, type UiSlots } from '@browser-lite/ui';
import { profile } from './runtime.js';
import { element } from './util.js';

/** What the demo offers its extensions: the slots of its UI. */
export interface DemoApp {
  ui: UiSlots;
}

/** An extension of the demo. */
export type DemoExtension = Extension<DemoApp>;

/** Extensions that come with the demo, installed before the first browser starts. */
const BUILT_IN: DemoExtension[] = [];

/** The pref `extensions`: data of each extension and the ones the user turned off. */
interface ExtensionPrefs {
  data?: Record<string, Record<string, unknown>>;
  disabled?: string[];
}

const prefs = (): ExtensionPrefs => profile.prefs<ExtensionPrefs>('extensions') ?? {};
const savePrefs = (changes: ExtensionPrefs) =>
  profile.savePrefs('extensions', { ...prefs(), ...changes });

/** Data of the extensions in the profile, so it follows to other devices. */
const store: ExtensionStore = {
  load: (id) => prefs().data?.[id] ?? null,
  save: (id, data) => savePrefs({ data: { ...prefs().data, [id]: data } }),
};

/** Toolbar buttons, side panels, context menu entries and settings of the extensions. */
export const ui = createUiSlots();

/** Serves every browser the demo starts (also after a restart). */
export const extensions = createExtensionHost<DemoApp>({ app: { ui }, store });

/** Installs an extension, turned off when the user turned it off before. */
export function installExtension(extension: DemoExtension): Promise<void> {
  return extensions.install(extension, { enabled: !prefs().disabled?.includes(extension.id) });
}

/** Resolves once the built-in extensions are installed. */
export const builtInExtensions = Promise.all(BUILT_IN.map(installExtension)).then(() => {});

async function setEnabled(id: string, enabled: boolean): Promise<void> {
  const disabled = new Set(prefs().disabled);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  savePrefs({ disabled: [...disabled] });
  await (enabled ? extensions.enable(id) : extensions.disable(id));
}

/**
 * The settings section of the extensions: a switch per installed extension, then the sections
 * the extensions add. Returns the function that runs when the section goes away.
 */
export function renderExtensionSettings(section: HTMLElement): () => void {
  const list = element('div', { className: 'extension-list' });
  const own = element('div');
  const cleanups: (() => void)[] = [];
  const renderList = () => {
    list.textContent = '';
    if (!extensions.extensions.length)
      list.append(
        element('p', { className: 'panel-empty', textContent: 'No extensions installed.' }),
      );
    for (const info of extensions.extensions) {
      const input = element('input', { type: 'checkbox', checked: info.enabled });
      input.dataset.extension = info.id;
      input.addEventListener('change', () => void setEnabled(info.id, input.checked));
      const failed = info.error ? ` (failed: ${String(info.error)})` : '';
      list.append(
        element(
          'label',
          { className: 'settings-row' },
          element(
            'span',
            {},
            info.id,
            element('small', { textContent: `${info.version}${failed}` }),
          ),
          input,
        ),
      );
    }
  };
  const renderOwn = () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    own.textContent = '';
    for (const item of ui.items('settings')) {
      const container = element('div', { className: 'extension-settings' });
      container.dataset.blItem = item.id;
      own.append(element('h3', { textContent: item.title }), container);
      try {
        const cleanup = item.render(container);
        if (cleanup) cleanups.push(cleanup);
      } catch (error) {
        console.warn('extension settings:', error);
      }
    }
  };
  section.append(list, own);
  renderList();
  renderOwn();
  const stops = [
    extensions.on('change', renderList),
    ui.on('change', ({ slot }) => {
      if (slot === 'settings') renderOwn();
    }),
  ];
  return () => {
    for (const stop of stops) stop();
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
