// CSS px sideways before a press becomes a swipe, and before a vertical move leaves it to scrolling
const THRESHOLD = 10;
// Share of the width past which a release removes, the speed in px/ms of a fling that does too
const DISTANCE = 0.35;
const FLING = 0.5;
// ms of moves before the release that its speed is measured over
const SPEED_WINDOW = 100;
// Like --medium of style.css
const DURATION = 200;

/**
 * Swiping node sideways to remove it, like the tab cards of mobile Chrome and Safari: the node
 * follows the finger (or mouse) and fades out; released past a good third of its width or flung
 * that way it slides out of the window and remove() decides, else it slides back. When remove()
 * resolves false (the page asked to stay) it comes back. A swipe opens nothing: the click of its
 * release goes nowhere. Vertical moves stay scrolling (the node needs touch-action: pan-y).
 */
export function swipeAway(node: HTMLElement, remove: () => Promise<boolean>): void {
  let busy = false;
  node.addEventListener('pointerdown', (down) => {
    if (busy || !down.isPrimary || down.button !== 0) return;
    track(node, down, async (direction) => {
      busy = true;
      await slide(node, `${direction * innerWidth}px 0`, '0');
      if (await remove()) return;
      busy = false;
      if (node.isConnected) await slide(node, '', '');
    });
  });
}

function track(node: HTMLElement, down: PointerEvent, away: (direction: number) => void): void {
  const listening = new AbortController();
  let swiping = false;
  let shift = 0;
  const moves: { x: number; time: number }[] = [];
  const move = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    // Released where this page got no pointerup (outside the window)
    if (!(e.buttons & 1)) return end(e);
    const dx = e.clientX - down.clientX;
    if (!swiping) {
      const dy = Math.abs(e.clientY - down.clientY);
      if (dy >= THRESHOLD && dy > Math.abs(dx)) return listening.abort();
      if (Math.abs(dx) < THRESHOLD) return;
      swiping = true;
      node.setPointerCapture(e.pointerId);
      for (const animation of node.getAnimations()) animation.cancel();
    }
    node.classList.add('swiping');
    moves.push({ x: e.clientX, time: e.timeStamp });
    while (moves.length > 2 && e.timeStamp - (moves[1]?.time ?? 0) > SPEED_WINDOW) moves.shift();
    shift = dx;
    node.style.translate = `${shift}px 0`;
    node.style.opacity = String(Math.max(0, 1 - Math.abs(shift) / node.offsetWidth));
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    listening.abort();
    if (!swiping) return;
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
    swallowClick(node);
    // Of the last moves, when the release came right after them
    const first = moves[0];
    const last = moves.at(-1);
    const speed =
      first && last && last !== first && e.timeStamp - last.time <= SPEED_WINDOW
        ? (last.x - first.x) / Math.max(1, last.time - first.time)
        : 0;
    const flung = Math.abs(speed) >= FLING && Math.sign(speed) === Math.sign(shift);
    if (e.type === 'pointerup' && (Math.abs(shift) >= node.offsetWidth * DISTANCE || flung)) {
      away(Math.sign(shift));
    } else {
      void slide(node, '', '');
    }
  };
  const options = { capture: true, signal: listening.signal };
  window.addEventListener('pointermove', move, options);
  window.addEventListener('pointerup', end, options);
  window.addEventListener('pointercancel', end, options);
}

// Animates node from where it is to translate and opacity ('' for its place)
async function slide(node: HTMLElement, translate: string, opacity: string): Promise<void> {
  const from = { translate: node.style.translate || '0px 0', opacity: node.style.opacity || '1' };
  node.style.translate = translate;
  node.style.opacity = opacity;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const to = { translate: translate || '0px 0', opacity: opacity || '1' };
  const animation = node.animate([from, to], {
    duration: reduce ? 0 : DURATION,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
  });
  await animation.finished.catch(() => {});
  if (!translate) node.classList.remove('swiping');
}

// The click that may follow the release of a swipe, until the next press or key
function swallowClick(node: HTMLElement): void {
  const swallowing = new AbortController();
  const options = { capture: true, signal: swallowing.signal };
  node.addEventListener(
    'click',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      swallowing.abort();
    },
    options,
  );
  const stop = () => swallowing.abort();
  window.addEventListener('pointerdown', stop, options);
  window.addEventListener('keydown', stop, options);
}
