import type { Browser } from '@browser-lite/core';
import { createProfile, DEFAULT_DB_LIMIT_KB, type Profile } from '@browser-lite/profile';
import { tokenFor } from './params.js';

/** State shared by the modules: the running browser (replaced by a restart) and the profile. */
export const runtime: {
  browser: Browser | null;
  /** True after a crash and while restarting: the session is not saved any more. */
  stopped: boolean;
} = { browser: null, stopped: false };

/**
 * Browser profile on the own server (`profile/`): cookies, site storage and the prefs settings,
 * bookmarks and permissions. Authorized with the token of this host.
 */
export const profile: Profile = createProfile({
  url: new URL('profile/', location.href),
  fetch: (input, init) => {
    const token = tokenFor(location.host);
    if (!token) return fetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  },
  dbLimitKB: () => {
    const settings = profile.prefs<{ dbLimit?: number }>('settings');
    return settings?.dbLimit ?? DEFAULT_DB_LIMIT_KB;
  },
});
