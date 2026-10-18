/** Burst protection state of one view; reset with every new document. */
export interface DialogState {
  /** Number of the current dialog in a row of dialogs less than 1 s apart. */
  burst: number;
  /** Time the last dialog closed. */
  last: number;
  /** The user was asked whether the page may show more dialogs. */
  asked: boolean;
  /** The user blocked further dialogs of this document. */
  blocked: boolean;
}

/** Gap in ms below which dialogs count as one burst. */
export const BURST_GAP_MS = 1000;
/** From this burst count on, the user is asked once whether more dialogs may come. */
export const ASK_AFTER = 4;
/** From this burst count on, beforeunload leaves without asking (a page navigating in a loop). */
export const BEFOREUNLOAD_LIMIT = 3;

/** State of a view without dialogs so far. */
export function newDialogState(): DialogState {
  return { burst: 0, last: 0, asked: false, blocked: false };
}

/** Counts a new dialog and returns its number in the current burst. */
export function countDialog(state: DialogState, now: number): number {
  state.burst = now - state.last < BURST_GAP_MS ? state.burst + 1 : 1;
  return state.burst;
}

/** What to do with a dialog of the page before it is shown. */
export type DialogDecision = 'show' | 'ask' | 'skip';

/**
 * Decision for alert, confirm and prompt: 'skip' when blocked, 'ask' once when the page shows
 * dialogs in a fast loop (the caller asks and calls {@link answerAsk}), else 'show'.
 */
export function decideDialog(state: DialogState, now: number): DialogDecision {
  if (state.blocked) return 'skip';
  if (countDialog(state, now) >= ASK_AFTER && !state.asked) return 'ask';
  return 'show';
}

/** Records the answer to the question whether more dialogs may come. */
export function answerAsk(state: DialogState, allow: boolean): void {
  state.asked = true;
  if (!allow) state.blocked = true;
}

/** True when beforeunload should leave without asking (blocked or in a loop). */
export function skipBeforeUnload(state: DialogState, now: number): boolean {
  return state.blocked || countDialog(state, now) >= BEFOREUNLOAD_LIMIT;
}
