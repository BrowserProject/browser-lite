import type { RequestHandlers } from '@browser-lite/core';
import { type NativeDialogOptions, nativeDialogs } from './dialogs.js';
import { hostPickers } from './host-picker.js';
import { context } from './options.js';
import { permissionPrompt } from './permission-prompt.js';
import { selectPopup } from './select-popup.js';

/**
 * All request handlers of this package: select popup, color and date/time picker, permission
 * prompt and native dialogs. File choosers stay with the default of the core.
 */
export function defaultHandlers(options?: NativeDialogOptions): Partial<RequestHandlers> {
  return {
    ...selectPopup(options),
    ...hostPickers(context(options)),
    ...permissionPrompt(options),
    ...nativeDialogs(options),
  };
}
