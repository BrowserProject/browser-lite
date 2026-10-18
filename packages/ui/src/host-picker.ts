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
}

type OpenPicker = (
  request: PickerRequest,
  type: string,
  value: string,
  setup?: (input: HTMLInputElement) => void,
) => Promise<string | null>;

/**
 * Shows the native picker of the host browser: a hidden input at the place of the field of the
 * page, opened with showPicker(). Resolves its value on change or when the user clicks
 * elsewhere, null when aborted. A new picker finishes the open one.
 */
function createHostPicker(ui: UiContext): OpenPicker {
  let current: (() => void) | null = null;

  return (request, type, value, setup) => {
    current?.();
    return new Promise((resolve) => {
      if (request.signal.aborted) {
        resolve(null);
        return;
      }
      const root = ui.root();
      const doc = root.ownerDocument;
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
        if (current !== done) return;
        current = null;
        stopListening();
        request.signal.removeEventListener('abort', onAbort);
        input.remove();
        resolve(result);
      };
      const done = () => finish(input.value || null);
      const onAbort = () => finish(null);
      current = done;
      const stopListening = listen([
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
  };
}

/** Color and date/time picker sharing one hidden input: opening one finishes the other. */
export function hostPickers(
  ui: UiContext,
): Pick<RequestHandlers, 'colorPicker' | 'dateTimePicker'> {
  const open = createHostPicker(ui);
  return {
    colorPicker: (request: ColorRequest) => open(request, 'color', request.value || '#000000'),
    dateTimePicker(request: DateTimeRequest) {
      const type = dateTimeType(request.type);
      return open(request, type, request.value || '', (input) => {
        if (request.min) input.min = valueFromNumber(type, request.min);
        if (request.max) input.max = valueFromNumber(type, request.max);
        const step = stepAttribute(type, request.step);
        if (step) input.step = step;
      });
    },
  };
}

/**
 * `<input type=color>` with the color picker of the host browser. Element: hidden
 * `input.bl-host-picker`.
 */
export function colorPicker(options?: UiOptions): Pick<RequestHandlers, 'colorPicker'> {
  return { colorPicker: hostPickers(context(options)).colorPicker };
}

/**
 * Date and time inputs (date, time, datetime-local, month, week) with the picker of the host
 * browser, limited by min, max and step of the field. Element: hidden `input.bl-host-picker`.
 */
export function dateTimePicker(options?: UiOptions): Pick<RequestHandlers, 'dateTimePicker'> {
  return { dateTimePicker: hostPickers(context(options)).dateTimePicker };
}
