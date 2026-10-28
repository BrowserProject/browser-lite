/**
 * True while the phone layout of style.css applies. Its media query sets `--layout: compact`
 * on the root, so the breakpoint lives only in the style sheet.
 */
export function compactLayout(): boolean {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--layout').trim() === 'compact'
  );
}
