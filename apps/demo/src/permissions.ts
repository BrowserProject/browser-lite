import type { PermissionStore } from '@browser-lite/core';
import { profile } from './runtime.js';

type Decision = 'grant' | 'deny';

/** Decisions in the pref `permissions` of the profile: { "<kind> <origin>": decision }. */
const decisions = () => profile.prefs<Record<string, Decision>>('permissions') ?? {};

/** Permission decisions kept in the profile, so they follow to other devices. */
export const profilePermissions: PermissionStore = {
  set(origin, kind, value) {
    const next = { ...decisions() };
    if (value === null) delete next[`${kind} ${origin}`];
    else next[`${kind} ${origin}`] = value;
    profile.savePrefs('permissions', next);
  },
  *entries() {
    for (const [key, value] of Object.entries(decisions())) {
      const space = key.indexOf(' ');
      if (space > 0 && (value === 'grant' || value === 'deny'))
        yield [key.slice(space + 1), key.slice(0, space), value];
    }
  },
};
