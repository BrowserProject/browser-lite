/**
 * Texts the ui shows. Templates replace `{host}` with the host of the page and `{kind}` with
 * the permission kind.
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
  openLinkInNewTab: string;
  copyLinkAddress: string;
  openImageInNewTab: string;
  copyImageAddress: string;
  copy: string;
  cut: string;
  paste: string;
  selectAll: string;
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
  permissions: Object.freeze({
    geolocation: '{host} wants to know your location',
    notifications: '{host} wants to show notifications',
    microphone: '{host} wants to use your microphone',
    camera: '{host} wants to use your camera',
    'camera-microphone': '{host} wants to use your camera and microphone',
  }) as Record<string, string>,
  permissionOther: '{host} wants to use {kind}',
  allow: 'Allow',
  block: 'Block',
  signIn: 'Sign in',
  notPrivate: 'Your connection to this site is not private',
  username: 'Username',
  password: 'Password',
  cancel: 'Cancel',
  openLinkInNewTab: 'Open link in new tab',
  copyLinkAddress: 'Copy link address',
  openImageInNewTab: 'Open image in new tab',
  copyImageAddress: 'Copy image address',
  copy: 'Copy',
  cut: 'Cut',
  paste: 'Paste',
  selectAll: 'Select all',
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

/** Host of an origin for questions and dialog titles; '' for opaque origins. */
export function hostOf(origin: string): string {
  try {
    const host = new URL(origin).host;
    if (host) return host;
  } catch {}
  return origin && origin !== 'null' ? origin : '';
}
