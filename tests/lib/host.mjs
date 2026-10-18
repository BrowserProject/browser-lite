// Helpers for the core test host page (tests/core/host): window.blTest and window.blHost.

/** Opens the host page and waits for the first browser; false when createBrowser failed. */
export async function openHost(page, url) {
  await page.goto(url);
  return page.evaluate(() => window.blHost.ready);
}

/** Loads url in the active view (like typing it into an address bar). */
export const load = (page, url) => page.evaluate((url) => window.blTest.load(url), url);

/** Opens url in a new active view; the previous view is hidden. Resolves the view id. */
export const openView = (page, url) => page.evaluate((url) => window.blTest.open(url).id, url);

/** Makes the view at index (in opening order) the active one. */
export const selectView = (page, index) =>
  page.evaluate((index) => window.blHost.select(index), index);

/** Recorded host events ('title:...', 'popup-load', ...). */
export const hostEvents = (page) => page.evaluate(() => window.blHost.events);

/** Until a recorded host event matches (string: exact, RegExp: test), at most ms. */
export async function waitEvent(page, match, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const events = await hostEvents(page);
    const found = events.find((event) =>
      typeof match === 'string' ? event === match : match.test(event),
    );
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** Runs source in the page of the active view (debug eval). */
export const evalPage = (page, source) =>
  page.evaluate((source) => window.blTest.eval(source), source);
