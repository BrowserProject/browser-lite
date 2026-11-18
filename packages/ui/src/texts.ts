import { displayHost } from './url-display.js';

/**
 * Texts the ui shows. Templates replace `{host}` with the host of the page, `{kind}` with the
 * permission kind, `{engine}` with the name of the search engine and `{text}` with the selected
 * text.
 */
export interface UiTexts {
  /** First line of alert, confirm and prompt. */
  dialogFrom: string;
  /** Host shown for pages without a host (for example about:blank). */
  thisPage: string;
  /** Asked once when a page shows dialogs in a fast loop. */
  manyDialogs: string;
  /** beforeunload when leaving the page. */
  leaveSite: string;
  /** beforeunload when reloading the page. */
  reloadSite: string;
  /** Second paragraph of the beforeunload question. */
  unsavedChanges: string;
  /** Before a reload or back/forward sends a form again. */
  resubmitForm: string;
  /** Second paragraph of the question before sending a form again. */
  resubmitWarning: string;
  /** Button that sends the form again. */
  resend: string;
  /** Button that accepts alert, confirm and prompt. */
  ok: string;
  /** Button that leaves the page on beforeunload (`reload` when reloading). */
  leave: string;
  /** Permission question per kind (geolocation, notifications, camera, microphone, ...). */
  permissions: Record<string, string>;
  /** Permission question for kinds without an entry in `permissions`. */
  permissionOther: string;
  allow: string;
  block: string;
  /** Title and button of the sign-in dialog (HTTP authentication). */
  signIn: string;
  /** Warning of the sign-in dialog for a server without https. */
  notPrivate: string;
  username: string;
  password: string;
  cancel: string;
  /** Next to the empty field of a date, time or color picker on iPhone and iPad. */
  tapToChoose: string;
  openLinkInNewTab: string;
  saveLinkAs: string;
  copyLinkAddress: string;
  openImageInNewTab: string;
  saveImageAs: string;
  copyImage: string;
  copyImageAddress: string;
  /** Checkable items of a video or audio. */
  loop: string;
  showControls: string;
  pictureInPicture: string;
  openVideoInNewTab: string;
  saveVideoAs: string;
  copyVideoAddress: string;
  openAudioInNewTab: string;
  saveAudioAs: string;
  copyAudioAddress: string;
  copy: string;
  cut: string;
  paste: string;
  pasteAsPlainText: string;
  /** Context menu of a misspelled word, after its corrections. */
  addToDictionary: string;
  undo: string;
  redo: string;
  selectAll: string;
  /** Searches the web for the selected text (shortened to 50 characters here). */
  searchFor: string;
  back: string;
  forward: string;
  reload: string;
  print: string;
  viewSource: string;
}

/** English default texts. */
export const defaultTexts: Readonly<UiTexts> = Object.freeze({
  dialogFrom: '{host} says:',
  thisPage: 'This page',
  manyDialogs: '{host} is showing many dialogs. Allow more dialogs from this site?',
  leaveSite: 'Leave site?',
  reloadSite: 'Reload site?',
  unsavedChanges: 'Changes that you made may not be saved.',
  resubmitForm: 'Confirm form resubmission',
  resubmitWarning:
    'This page uses information that you entered. Sending it again may repeat an action, such as an order or a payment.',
  resend: 'Continue',
  ok: 'OK',
  leave: 'Leave',
  permissions: Object.freeze({
    geolocation: '{host} wants to know your location',
    notifications: '{host} wants to show notifications',
    microphone: '{host} wants to use your microphone',
    camera: '{host} wants to use your camera',
    'camera-microphone': '{host} wants to use your camera and microphone',
    'clipboard-read': '{host} wants to see text and images copied to the clipboard',
  }) as Record<string, string>,
  permissionOther: '{host} wants to use {kind}',
  allow: 'Allow',
  block: 'Block',
  signIn: 'Sign in',
  notPrivate: 'Your connection to this site is not private',
  username: 'Username',
  password: 'Password',
  cancel: 'Cancel',
  tapToChoose: 'Tap the field to choose',
  openLinkInNewTab: 'Open link in new tab',
  saveLinkAs: 'Save link as…',
  copyLinkAddress: 'Copy link address',
  openImageInNewTab: 'Open image in new tab',
  saveImageAs: 'Save image as…',
  copyImage: 'Copy image',
  copyImageAddress: 'Copy image address',
  loop: 'Loop',
  showControls: 'Show controls',
  pictureInPicture: 'Picture in picture',
  openVideoInNewTab: 'Open video in new tab',
  saveVideoAs: 'Save video as…',
  copyVideoAddress: 'Copy video address',
  openAudioInNewTab: 'Open audio in new tab',
  saveAudioAs: 'Save audio as…',
  copyAudioAddress: 'Copy audio address',
  copy: 'Copy',
  cut: 'Cut',
  paste: 'Paste',
  pasteAsPlainText: 'Paste as plain text',
  addToDictionary: 'Add to dictionary',
  undo: 'Undo',
  redo: 'Redo',
  selectAll: 'Select all',
  searchFor: 'Search {engine} for “{text}”',
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  print: 'Print…',
  viewSource: 'View page source',
});

/** Default texts with the overrides applied; `permissions` entries merge one by one. */
export function resolveTexts(overrides?: Partial<UiTexts>): UiTexts {
  return {
    ...defaultTexts,
    ...overrides,
    permissions: { ...defaultTexts.permissions, ...overrides?.permissions },
  };
}

/** Replaces `{name}` placeholders of a template. Unknown names stay as they are. */
export function format(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/**
 * Host of an origin for questions and dialog titles, internationalized hosts shown like
 * `displayHost`; '' for opaque origins.
 */
export function hostOf(origin: string): string {
  try {
    const host = new URL(origin).host;
    if (host) return displayHost(host);
  } catch {}
  return origin && origin !== 'null' ? origin : '';
}
