/**
 * iOS Safari lays its on-screen keyboard over the page and pans the visual viewport instead of
 * making the page smaller (Chromium does that with `interactive-widget=resizes-content` in the
 * viewport meta tag). The page follows the visible part, so the view gets shorter and the engine
 * keeps the field being typed in visible. Fixed elements (sheets, prompts) use the CSS variables
 * `--visible-height` and `--keyboard-height`, set only while the keyboard covers the page.
 */
export function fitVisualViewport(): void {
  const visual = window.visualViewport;
  if (!visual) return;
  const root = document.documentElement;
  const fit = () => {
    // Pinch zoom of the page itself also makes the visual viewport smaller: leave it
    const covered = Math.abs(visual.scale - 1) < 0.01 && visual.height < window.innerHeight - 1;
    root.style.height = covered ? `${visual.height}px` : '';
    if (covered) {
      root.style.setProperty('--visible-height', `${visual.height}px`);
      root.style.setProperty('--keyboard-height', `${window.innerHeight - visual.height}px`);
    } else {
      root.style.removeProperty('--visible-height');
      root.style.removeProperty('--keyboard-height');
    }
    if (covered && (window.scrollY || visual.offsetTop)) window.scrollTo(0, 0);
  };
  visual.addEventListener('resize', fit);
  visual.addEventListener('scroll', fit);
}
