import type { RequestHandlers } from '@browser-lite/core';
import { pageDialogs } from '@browser-lite/ui';
import { activate, activeTab, tabOf } from './tabs.js';
import { byId } from './util.js';

/**
 * alert, confirm, prompt and beforeunload as in-page dialogs of the ui package over the page
 * area (only the asking tab waits). Only the tab in front asks (#149): background tabs get the
 * default answer at once and a marker; a beforeunload of a background tab leaves without
 * asking, unless the tab is being closed (then it comes to the front first).
 */
export function dialogHandler(): Pick<RequestHandlers, 'dialog'> {
  const inPage = pageDialogs({
    root: byId('pages'),
    onBlocked(view) {
      const tab = tabOf(view);
      if (!tab) return;
      tab.dialogsBlocked = true;
      tab.updateDialogMarker();
    },
  });
  return {
    dialog(request) {
      const tab = tabOf(request.view);
      if (request.type === 'beforeunload') {
        if (!tab || (tab !== activeTab() && !tab.closing)) return true;
        if (tab !== activeTab()) activate(tab);
        return inPage.dialog(request);
      }
      if (!tab || tab !== activeTab()) {
        if (tab) {
          tab.dialogSuppressed = true;
          tab.updateDialogMarker();
        }
        return request.type === 'confirm' ? false : null;
      }
      return inPage.dialog(request);
    },
  };
}
