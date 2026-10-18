import type { PermissionStore } from '@browser-lite/core';
import { profile } from './runtime.js';

type Decision = 'grant' | 'deny';

/** Decisions in the pref `permissions` of the profile: { "<kind> <origin>": decision }. */
const decisions = () => profile.prefs<Record<string, Decision>>('permissions') ?? {};

/** Permission decisions kept in the profile, so they follow to other devices. */
export const profilePermissions: PermissionStore = {
  get(origin, kind) {
    return decisions()[`${kind} ${origin}`];
  },
  set(origin, kind, value) {
    profile.savePrefs('permissions', { ...decisions(), [`${kind} ${origin}`]: value });
  },
  *entries() {
    for (const [key, value] of Object.entries(decisions())) {
      const space = key.indexOf(' ');
      if (space > 0 && (value === 'grant' || value === 'deny'))
        yield [key.slice(space + 1), key.slice(0, space), value];
    }
  },
};
