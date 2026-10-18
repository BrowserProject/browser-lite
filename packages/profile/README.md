# @browser-lite/profile

Browser client of the server-side profile: cookies, localStorage and small IndexedDBs of the
pages, plus prefs of the app (settings, bookmarks, permissions), so users stay signed in to
websites, also on another device. The server side is `createProfileStore` of
`@browser-lite/server`.

Not on npm yet: install the tarballs of a GitHub release together with `@browser-lite/core`
([README, Install](../../README.md#install)).

## Example

```js
import { createBrowser } from '@browser-lite/core';
import { createProfile } from '@browser-lite/profile';

const profile = createProfile({
  url: '/profile/',
  // Optional: authorization for the profile endpoint
  fetch: (input, init) =>
    fetch(input, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } }),
});
const browser = await createBrowser({
  engineUrl,
  transport,
  storage: { beforeStart: profile.beforeStart },
});
profile.attach(browser);
profile.on('status', () => console.log(profile.status, profile.statusText));
```

## How it works

`beforeStart(dir)` runs before the engine starts with the storage namespace directory of the
core. It uploads what did not reach the server last time (while this device still holds the
profile), then downloads the profile (`POST open`) into the directory. Afterwards only the
engine writes there. `attach(browser)` starts the sync: every 2 s while the page is visible,
every 30 s while hidden and 2.5 s after hiding (the core flushes the storage on hide). The sync scans
the directory, uploads changed files and deletes on the server what is gone locally.

A database of the profile is `cookies.db`, one `.localstorage` file or the directory of one
IndexedDB. Except `cookies.db`, it goes into the profile only up to `dbLimitKB` (default 256);
larger ones stay on the device. When another device opens the profile, the status becomes
`taken` (or `reset` after a reset there) and nothing more is written; reload to take it back.

## API

| Member | Purpose |
| --- | --- |
| `createProfile({ url, dbLimitKB?, fetch? })` | `url`: base URL of the profile endpoint. `dbLimitKB`: number or function read at every sync. |
| `status`, `statusText`, `problem` | `off` (not started, memory only, other tab), `local` (server not reachable), `connected`, `taken`, `reset`; English text; problem of the last sync. |
| `on('status', listener)` | Status, text or problem changed. Returns an unsubscribe function. |
| `beforeStart(dir)` | Pass as `BrowserOptions.storage.beforeStart`. Never throws; failures give `local`. |
| `attach(browser)` | Starts the periodic sync; stops when the browser is destroyed. |
| `prefs(name)`, `savePrefs(name, value)` | Prefs `settings`, `bookmarks`, `permissions` (the names the server accepts). Saved locally at once, on the server when connected, otherwise at the next start (then the local value wins). |
| `prefsSaved(timeoutMs = 5000)` | Resolves when the prefs reached the server or after the timeout. |
| `info()` | Server information (size, files, cookies per domain), null without connection. |
| `localStats()` | What only this device holds: databases above the limit, cache storage, service workers, page files, HTTP cache. |
| `reset(all)` | Deletes site data (`all = false`: cookies, site storage, permissions) or the whole profile on the server and here. The directory is cleared at the next start: destroy the browser and start again, or reload. |
| `siteOfPath(path)` | Site (`https://example.com`) of a profile file path. |

Local state (prefs cache, upload record, pending clear) lives in `localStorage` under keys
starting with `bl-profile <url>`.

## Tests

`npm test` runs the unit tests in Node against `dist/` with an in-memory file system and server.
`node test/browser.mjs` runs the client with the real origin private file system in headless
Chromium; CI runs it with `node tests/run.mjs packages`.
