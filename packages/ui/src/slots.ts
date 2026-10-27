import type { ContextMenuInfo, View } from '@browser-lite/core';
import type { MenuItem } from './context-menu.js';
import { element } from './options.js';

/** A button in the toolbar of the app. */
export interface ToolbarButton {
  /** Unique in the slot, best prefixed with the extension id (`data-bl-item`). */
  id: string;
  /** Tooltip and accessible name. */
  label: string;
  /** Short text or emoji on the button; default the label. */
  icon?: string;
  /** Runs on a click with the view the app shows (null without one). */
  action(view: View | null): void | Promise<void>;
}

/** A panel the app shows in its side panel (opened with {@link UiSlots.openPanel}). */
export interface SidePanel {
  id: string;
  title: string;
  /** Fills the empty container; the returned function runs when the panel closes. */
  render(container: HTMLElement): (() => void) | undefined;
}

/** An entry of the context menu of the pages. */
export interface ContextMenuEntry {
  id: string;
  label: string;
  /** Shown only when this returns true (default always). */
  when?(info: ContextMenuInfo): boolean;
  action(view: View, info: ContextMenuInfo): void | Promise<void>;
}

/** A section of the settings page of the app. */
export interface SettingsSection {
  id: string;
  title: string;
  /** Fills the empty container; the returned function runs when the section goes away. */
  render(container: HTMLElement): (() => void) | undefined;
}

/** The slots and what goes into each. */
export interface UiSlotItems {
  toolbar: ToolbarButton;
  panel: SidePanel;
  'context-menu': ContextMenuEntry;
  settings: SettingsSection;
}

/** Name of a slot. */
export type UiSlot = keyof UiSlotItems;

/**
 * Places in the UI of an app that extensions fill (toolbar buttons, side panels, context menu
 * entries, settings sections). The app renders them; offer it to the extensions as part of their
 * `app` (`createExtensionHost({ app: { ui } })`).
 */
export interface UiSlots {
  /**
   * Adds an item; returns the function that removes it (return it from the extension's setup).
   * @throws Error when the slot holds an item with the same id.
   */
  add<K extends UiSlot>(slot: K, item: UiSlotItems[K]): () => void;
  /** Items of a slot in the order they were added. */
  items<K extends UiSlot>(slot: K): readonly UiSlotItems[K][];
  /** Asks the app to show a side panel (event `open-panel`). */
  openPanel(id: string): void;
  /** The items of a slot changed. */
  on(type: 'change', listener: (event: { slot: UiSlot }) => void): () => void;
  /** {@link UiSlots.openPanel} was called. */
  on(type: 'open-panel', listener: (event: { id: string }) => void): () => void;
}

type Listener = (event: never) => void;

class UiSlotsImpl implements UiSlots {
  private readonly slots = new Map<UiSlot, { id: string }[]>();
  private readonly listeners = new Map<string, Set<Listener>>();

  add<K extends UiSlot>(slot: K, item: UiSlotItems[K]): () => void {
    const list = this.slots.get(slot) ?? [];
    if (list.some((entry) => entry.id === item.id))
      throw new Error(`The ${slot} slot holds ${item.id} already`);
    this.slots.set(slot, [...list, item]);
    this.emit('change', { slot });
    return () => {
      const current = this.slots.get(slot) ?? [];
      if (!current.includes(item)) return;
      this.slots.set(
        slot,
        current.filter((entry) => entry !== item),
      );
      this.emit('change', { slot });
    };
  }

  items<K extends UiSlot>(slot: K): readonly UiSlotItems[K][] {
    return (this.slots.get(slot) ?? []) as UiSlotItems[K][];
  }

  openPanel(id: string): void {
    this.emit('open-panel', { id });
  }

  on(type: 'change' | 'open-panel', listener: (event: never) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      try {
        (listener as (event: unknown) => void)(event);
      } catch (error) {
        console.warn('ui slots:', error);
      }
    }
  }
}

/** Creates empty {@link UiSlots}. */
export function createUiSlots(): UiSlots {
  return new UiSlotsImpl();
}

/**
 * Renders the toolbar slot into `container` and keeps it current; `view` returns the view the
 * app shows. Returns the function that stops and removes the buttons.
 * Elements: `button.bl-toolbar-button` with `data-bl-item`, `title` and `aria-label`.
 */
export function renderToolbar(
  slots: UiSlots,
  container: HTMLElement,
  view: () => View | null,
): () => void {
  const buttons: HTMLElement[] = [];
  const render = () => {
    for (const button of buttons.splice(0)) button.remove();
    for (const item of slots.items('toolbar')) {
      const button = element(container, 'button', 'toolbar-button');
      button.type = 'button';
      button.dataset.blItem = item.id;
      button.title = item.label;
      button.setAttribute('aria-label', item.label);
      button.textContent = item.icon ?? item.label;
      button.addEventListener('click', () => {
        void Promise.resolve()
          .then(() => item.action(view()))
          .catch((error: unknown) => console.warn('toolbar button:', error));
      });
      buttons.push(button);
    }
    container.append(...buttons);
  };
  render();
  const stop = slots.on('change', ({ slot }) => {
    if (slot === 'toolbar') render();
  });
  return () => {
    stop();
    for (const button of buttons.splice(0)) button.remove();
  };
}

/**
 * The context menu entries of the slot for a `context-menu` event, as items for
 * {@link showContextMenu} (after {@link defaultMenuItems}, with a separator before them).
 */
export function slotMenuItems(slots: UiSlots, view: View, info: ContextMenuInfo): MenuItem[] {
  const entries = slots.items('context-menu').filter((entry) => {
    try {
      return entry.when?.(info) ?? true;
    } catch {
      return false;
    }
  });
  if (!entries.length) return [];
  return [
    { separator: true },
    ...entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      action: () => entry.action(view, info),
    })),
  ];
}
