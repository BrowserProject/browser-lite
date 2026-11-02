import type { RequestHandlers } from '@browser-lite/core';
import type { DialogOptions } from './dialogs.js';
import { fileChooser } from './file-chooser.js';
import { colorPicker, dateTimePicker } from './host-picker.js';
import { loginPrompt } from './login-prompt.js';
import { pageDialogs } from './page-dialogs.js';
import { permissionPrompt } from './permission-prompt.js';
import { selectPopup } from './select-popup.js';

/**
 * All request handlers of this package: select popup, color and date/time picker, permission
 * prompt, sign-in dialog and the dialogs of the pages in the page ({@link pageDialogs}). File choosers stay with the default of the core,
 * except on an iPhone or iPad ({@link fileChooser}).
 */
export function defaultHandlers(options?: DialogOptions): Partial<RequestHandlers> {
  return {
    ...fileChooser(options),
    ...selectPopup(options),
    ...colorPicker(options),
    ...dateTimePicker(options),
    ...permissionPrompt(options),
    ...loginPrompt(options),
    ...pageDialogs(options),
  };
}
