import type { ColorRequest, DateTimeRequest, RequestHandlers, View } from '@browser-lite/core';
import { dateTimeType, stepAttribute, valueFromNumber } from './datetime.js';
import {
  context,
  element,
  listen,
  type UiContext,
  type UiOptions,
  viewportRect,
} from './options.js';

interface PickerRequest {
  view: View;
  rect: ColorRequest['rect'];
  signal: AbortSignal;
  preview?(value: string): void;
}

/** Finishes the open picker of a document; the host browser shows one picker at a time. */
const openPickers = new WeakMap<Document, () => void>();

/**
 * Shows the native picker of the host browser: a hidden input at the place of the field of the
 * page, opened with showPicker(). Every input event previews the value in the page. Resolves
 * its value on change or when the user clicks elsewhere, null when aborted. A new picker in the
 * same document finishes the open one.
 */
function openHostPicker(
  ui: UiContext,
  request: PickerRequest,
  type: string,
  value: string,
  setup?: (input: HTMLInputElement) => void,
): Promise<string | null> {
  const root = ui.root();
  const doc = root.ownerDocument;
  openPickers.get(doc)?.();
  return new Promise((resolve) => {
    if (request.signal.aborted) {
      resolve(null);
      return;
    }
    const input = element(root, 'input', 'host-picker');
    input.type = type;
    input.tabIndex = -1;
    const anchor = viewportRect(request.view, request.rect);
    Object.assign(input.style, {
      position: 'fixed',
      left: `${anchor.x}px`,
      top: `${anchor.y}px`,
      width: `${Math.max(anchor.width, 1)}px`,
      height: `${Math.max(anchor.height, 1)}px`,
      opacity: '0',
      pointerEvents: 'none',
    });
    setup?.(input);
    input.value = value;

    const finish = (result: string | null) => {
      if (openPickers.get(doc) !== done) return;
      openPickers.delete(doc);
      stopListening();
      request.signal.removeEventListener('abort', onAbort);
      input.remove();
      resolve(result);
    };
    const done = () => finish(input.value || null);
    const onAbort = () => finish(null);
    openPickers.set(doc, done);
    const stopListening = listen([
      [input, 'input', () => request.preview?.(input.value)],
      [input, 'change', done],
      [
        doc,
        'pointerdown',
        (event) => {
          if (event.target !== input) done();
        },
        true,
      ],
    ]);
    request.signal.addEventListener('abort', onAbort);
    root.append(input);
    try {
      input.showPicker();
    } catch {
      // showPicker needs a user activation; the focused field still opens with a key
      input.focus();
    }
  });
}

/**
 * `<input type=color>` with the color picker of the host browser. Element: hidden
 * `input.bl-host-picker`.
 */
export function colorPicker(options?: UiOptions): Pick<RequestHandlers, 'colorPicker'> {
  const ui = context(options);
  return {
    colorPicker: (request: ColorRequest) =>
      openHostPicker(ui, request, 'color', request.value || '#000000'),
  };
}

/**
 * Date and time inputs (date, time, datetime-local, month, week) with the picker of the host
 * browser, limited by min, max and step of the field. Element: hidden `input.bl-host-picker`.
 */
export function dateTimePicker(options?: UiOptions): Pick<RequestHandlers, 'dateTimePicker'> {
  const ui = context(options);
  return {
    dateTimePicker(request: DateTimeRequest) {
      const type = dateTimeType(request.type);
      return openHostPicker(ui, request, type, request.value || '', (input) => {
        const doc = input.ownerDocument;
        if (request.min) input.min = valueFromNumber(doc, type, request.min);
        if (request.max) input.max = valueFromNumber(doc, type, request.max);
        const step = stepAttribute(type, request.step);
        if (step) input.step = step;
      });
    },
  };
}
