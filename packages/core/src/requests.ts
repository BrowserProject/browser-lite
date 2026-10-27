import type { Config } from './config.js';
import type { EngineModule } from './engine.js';
import { storePermission } from './permissions.js';
import type {
  AuthCredentials,
  AuthRequest,
  DialogAnswer,
  DialogRequest,
  FileChooserRequest,
  PermissionAnswer,
  PermissionKind,
  Rect,
  RequestHandlers,
  SelectItem,
} from './types.js';
import type { ViewImpl } from './view.js';
import type { Watchdog } from './watchdog.js';

const DIALOG_TYPES = ['alert', 'confirm', 'prompt', 'beforeunload', 'beforeunload'] as const;

/** Default file chooser: the native file dialog of the host browser. */
export function nativeFileChooser(request: FileChooserRequest): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = request.multiple;
    if (request.accept) input.accept = request.accept;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    request.signal.addEventListener('abort', () => resolve(null), { once: true });
    input.click();
  });
}

interface RequestsHost {
  readonly module: EngineModule;
  readonly config: Config;
  readonly watchdog: Watchdog;
  readonly ready: boolean;
  text(value: string | null | undefined): number;
  readonly uploads: { write(view: ViewImpl, files: File[]): Promise<string[]> };
}

interface OpenDialog {
  view: ViewImpl;
  type: DialogRequest['type'];
  controller: AbortController;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as PromiseLike<unknown> | null)?.then === 'function';

const report = (error: unknown) =>
  queueMicrotask(() => {
    throw error;
  });

type Picker = 'select' | 'color' | 'datetime';

const rectOf = (data: Record<string, unknown>): Rect => ({
  x: Number(data.x) || 0,
  y: Number(data.y) || 0,
  width: Number(data.width) || 0,
  height: Number(data.height) || 0,
});

/**
 * Requests the engine waits for (dialogs, permissions, HTTP authentication, file chooser, popups and pickers),
 * answered by the request handlers of the options or safe defaults. Every request has an
 * AbortSignal: aborted when the page hides the popup, the view closes or the engine ends.
 */
export class Requests {
  private readonly pending = new Map<number, Set<AbortController>>();
  private readonly pickers = new Map<string, AbortController>();
  private readonly permissions = new Map<number, { view: number; controller: AbortController }>();
  private readonly dialogs = new Map<number, OpenDialog>();
  private readonly auths = new Map<number, { view: number; controller: AbortController }>();

  constructor(private readonly host: RequestsHost) {}

  private get handlers(): Partial<RequestHandlers> {
    return this.host.config.handlers;
  }

  private track(view: ViewImpl): AbortController {
    const controller = new AbortController();
    let set = this.pending.get(view.id);
    if (!set) {
      set = new Set();
      this.pending.set(view.id, set);
    }
    set.add(controller);
    controller.signal.addEventListener('abort', () => set.delete(controller), { once: true });
    return controller;
  }

  private done(view: ViewImpl, controller: AbortController): void {
    this.pending.get(view.id)?.delete(controller);
  }

  /**
   * alert/confirm/prompt/beforeunload (Module.engineDialog). The engine thread waits until
   * bl_dialog_answer; the handler may answer later (a promise). Meanwhile the watchdog pauses.
   */
  dialog(
    id: number,
    view: ViewImpl | undefined,
    type: number,
    origin: string,
    message: string,
    defaultValue: string,
  ): void {
    const kind = DIALOG_TYPES[type] ?? 'alert';
    const handler = this.handlers.dialog;
    if (!view?.alive || !handler) {
      this.answerDialog(id, kind, undefined);
      return;
    }
    const controller = this.track(view);
    this.dialogs.set(id, { view, type: kind, controller });
    this.host.watchdog.pause();
    let result: DialogAnswer | Promise<DialogAnswer>;
    try {
      result = handler({
        view,
        type: kind,
        origin,
        message,
        defaultValue,
        reload: type === 4,
        signal: controller.signal,
      });
    } catch (error) {
      report(error);
      result = undefined;
    }
    if (isThenable(result))
      result.then(
        (answer) => this.finishDialog(id, answer as DialogAnswer),
        (error: unknown) => {
          report(error);
          this.finishDialog(id, undefined);
        },
      );
    else this.finishDialog(id, result);
  }

  private finishDialog(id: number, answer: DialogAnswer): void {
    const dialog = this.dialogs.get(id);
    if (!dialog) return;
    this.dialogs.delete(id);
    this.done(dialog.view, dialog.controller);
    this.host.watchdog.resume();
    this.answerDialog(id, dialog.type, answer);
  }

  // Missing or unexpected answers count like the defaults: confirm false, prompt null, leave
  private answerDialog(id: number, type: DialogRequest['type'], answer: DialogAnswer): void {
    const { module, ready } = this.host;
    if (!ready) return;
    if (type === 'prompt' && typeof answer === 'string')
      module._bl_dialog_answer(id, 1, this.host.text(answer));
    else
      module._bl_dialog_answer(
        id,
        (type === 'confirm' && answer === true) || (type === 'beforeunload' && answer !== false)
          ? 1
          : 0,
        0,
      );
  }

  /** Answers every open dialog with the default (the engine must run, for example to stop). */
  closeDialogs(): void {
    for (const [id, dialog] of [...this.dialogs]) {
      this.dialogs.delete(id);
      dialog.controller.abort();
      this.host.watchdog.resume();
      this.answerDialog(id, dialog.type, undefined);
    }
  }

  async permission(
    view: ViewImpl,
    data: { id: number; kind: PermissionKind; origin: string },
  ): Promise<void> {
    const { module, config } = this.host;
    const handler = this.handlers.permission;
    // Without a handler: no for now, nothing remembered
    if (!handler) {
      module._bl_permission_answer(data.id, 0);
      return;
    }
    const controller = this.track(view);
    this.permissions.set(data.id, { view: view.id, controller });
    let answer: PermissionAnswer = 'dismiss';
    try {
      const result = await handler({
        view,
        kind: data.kind,
        origin: data.origin,
        signal: controller.signal,
      });
      if (result === 'grant' || result === 'deny') answer = result;
    } catch {}
    if (controller.signal.aborted || !this.permissions.has(data.id)) return;
    this.permissions.delete(data.id);
    this.done(view, controller);
    if (!this.host.ready) return;
    if (answer !== 'dismiss') storePermission(config.permissions, data.origin, data.kind, answer);
    module._bl_permission_answer(data.id, answer === 'grant' ? 1 : answer === 'deny' ? 2 : 0);
  }

  /** A 401 the engine asks the user about ('auth'); answered with bl_auth_answer. */
  async authenticate(
    view: ViewImpl,
    data: {
      id: number;
      url?: string;
      origin?: string;
      realm?: string;
      scheme?: string;
      retry?: boolean;
    },
  ): Promise<void> {
    const { module } = this.host;
    const handler = this.handlers.authenticate;
    if (!handler) {
      module._bl_auth_answer(data.id, 0, 0);
      return;
    }
    const controller = this.track(view);
    this.auths.set(data.id, { view: view.id, controller });
    let answer: AuthCredentials | null = null;
    try {
      const request: AuthRequest = {
        view,
        url: String(data.url ?? ''),
        origin: String(data.origin ?? ''),
        realm: String(data.realm ?? ''),
        scheme: data.scheme === 'digest' ? 'digest' : 'basic',
        retry: !!data.retry,
        signal: controller.signal,
      };
      const result = await handler(request);
      if (result && typeof result.username === 'string' && typeof result.password === 'string')
        answer = { username: result.username, password: result.password };
    } catch {}
    if (controller.signal.aborted || !this.auths.has(data.id)) return;
    this.auths.delete(data.id);
    this.done(view, controller);
    if (!this.host.ready) return;
    if (answer)
      module._bl_auth_answer(
        data.id,
        this.host.text(answer.username),
        this.host.text(answer.password),
      );
    else module._bl_auth_answer(data.id, 0, 0);
  }

  /** No load waits for the answer any more ('auth-cancel'). */
  cancelAuth(id: number): void {
    const entry = this.auths.get(id);
    if (!entry) return;
    this.auths.delete(id);
    entry.controller.abort();
  }

  async fileChooser(view: ViewImpl, data: { multiple?: boolean; accept?: string }): Promise<void> {
    const controller = this.track(view);
    const handler = this.handlers.fileChooser ?? nativeFileChooser;
    let files: File[] | null = null;
    try {
      files = await handler({
        view,
        multiple: !!data.multiple,
        accept: data.accept ?? '',
        signal: controller.signal,
      });
    } catch {}
    if (controller.signal.aborted) return;
    const paths = files?.length ? await this.host.uploads.write(view, files) : [];
    this.done(view, controller);
    if (view.alive) this.host.module._bl_choose_files(view.id, this.host.text(paths.join('\n')));
  }

  private openPicker(view: ViewImpl, picker: Picker): AbortController {
    const key = `${view.id}:${picker}`;
    // The engine sends the list again (changed options): the old request is superseded
    this.pickers.get(key)?.abort();
    const controller = this.track(view);
    this.pickers.set(key, controller);
    return controller;
  }

  private current(view: ViewImpl, picker: Picker, controller: AbortController): boolean {
    const key = `${view.id}:${picker}`;
    if (controller.signal.aborted || this.pickers.get(key) !== controller || !view.alive)
      return false;
    return true;
  }

  private finishPicker(view: ViewImpl, picker: Picker, controller: AbortController): boolean {
    if (!this.current(view, picker, controller)) return false;
    this.pickers.delete(`${view.id}:${picker}`);
    this.done(view, controller);
    return true;
  }

  /** The page hid its popup or picker itself. */
  hidePicker(view: ViewImpl, picker: Picker): void {
    const key = `${view.id}:${picker}`;
    this.pickers.get(key)?.abort();
    this.pickers.delete(key);
  }

  async selectPopup(view: ViewImpl, data: Record<string, unknown>): Promise<void> {
    const controller = this.openPicker(view, 'select');
    const items = ((data.items as Partial<SelectItem>[] | undefined) ?? []).map((item) => ({
      text: item.text ?? '',
      tooltip: item.tooltip ?? '',
      enabled: item.enabled ?? false,
      label: item.label ?? false,
      selected: item.selected ?? false,
      separator: item.separator ?? false,
    }));
    let index = -1;
    const handler = this.handlers.selectPopup;
    if (handler) {
      try {
        const chosen = await handler({
          view,
          rect: rectOf(data),
          items,
          selectedIndex: Number(data.selectedIndex ?? -1),
          signal: controller.signal,
        });
        if (Number.isInteger(chosen) && chosen >= -1 && chosen < items.length) index = chosen;
      } catch {}
    }
    if (this.finishPicker(view, 'select', controller))
      this.host.module._bl_popup_choose(view.id, index);
  }

  async colorPicker(view: ViewImpl, data: Record<string, unknown>): Promise<void> {
    const controller = this.openPicker(view, 'color');
    const { module } = this.host;
    let value: string | null = null;
    const handler = this.handlers.colorPicker;
    if (handler) {
      try {
        value = await handler({
          view,
          rect: rectOf(data),
          value: String(data.value ?? '#000000'),
          signal: controller.signal,
          preview: (color) => {
            if (this.current(view, 'color', controller))
              module._bl_color_chosen(view.id, this.host.text(color), 0);
          },
        });
      } catch {}
    }
    if (this.finishPicker(view, 'color', controller))
      module._bl_color_chosen(view.id, typeof value === 'string' ? this.host.text(value) : 0, 1);
  }

  async dateTimePicker(view: ViewImpl, data: Record<string, unknown>): Promise<void> {
    const controller = this.openPicker(view, 'datetime');
    const { module } = this.host;
    let value: string | null = null;
    const handler = this.handlers.dateTimePicker;
    if (handler) {
      try {
        value = await handler({
          view,
          rect: rectOf(data),
          type: String(data.type ?? 'date'),
          value: String(data.value ?? ''),
          min: Number(data.min) || 0,
          max: Number(data.max) || 0,
          step: Number(data.step) || 0,
          signal: controller.signal,
          preview: (text) => {
            if (this.current(view, 'datetime', controller))
              module._bl_datetime_chosen(view.id, this.host.text(text), 0);
          },
        });
      } catch {}
    }
    if (this.finishPicker(view, 'datetime', controller))
      module._bl_datetime_chosen(view.id, typeof value === 'string' ? this.host.text(value) : 0, 1);
  }

  /** The view closes: abort its requests; open dialogs and permission questions count as dismissed. */
  closeView(view: ViewImpl): void {
    for (const [id, dialog] of [...this.dialogs]) {
      if (dialog.view !== view) continue;
      this.dialogs.delete(id);
      this.host.watchdog.resume();
      this.answerDialog(id, dialog.type, undefined);
    }
    for (const [id, entry] of this.permissions) {
      if (entry.view !== view.id) continue;
      this.permissions.delete(id);
      if (this.host.ready) this.host.module._bl_permission_answer(id, 0);
    }
    for (const [id, entry] of this.auths) {
      if (entry.view !== view.id) continue;
      this.auths.delete(id);
      if (this.host.ready) this.host.module._bl_auth_answer(id, 0, 0);
    }
    for (const controller of [...(this.pending.get(view.id) ?? [])]) controller.abort();
    this.pending.delete(view.id);
    for (const key of [...this.pickers.keys()])
      if (key.startsWith(`${view.id}:`)) this.pickers.delete(key);
  }

  /** The engine ended: abort everything without answers. */
  abortAll(): void {
    this.permissions.clear();
    this.auths.clear();
    this.dialogs.clear();
    for (const set of this.pending.values()) for (const controller of [...set]) controller.abort();
    this.pending.clear();
    this.pickers.clear();
  }
}
