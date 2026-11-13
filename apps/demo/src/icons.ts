/**
 * The icons of the demo: inline SVG on a 24 px grid with a 2 px stroke in `currentColor`, so
 * they follow the text color of light and dark mode. CSS sizes them through `.ui-icon`.
 */
const PATHS = {
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v5h-5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>',
  'star-filled':
    '<path fill="currentColor" d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>',
  menu: '<g fill="currentColor" stroke="none"><circle cx="12" cy="5.5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="18.5" r="1.7"/></g>',
  'chevron-up': '<path d="M6 15l6-6 6 6"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
  warning:
    '<path d="M10.3 4.3L2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0zM12 9.5v4M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5M3.5 4v4.5H8M12 7.5V12l3 2"/>',
  bookmarks: '<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  save: '<path d="M4.5 4.5h12l3 3v12h-15z"/><path d="M8 4.5v4.5h7V4.5M7.5 19.5v-6h9v6"/>',
  print:
    '<path d="M7 9V3.5h10V9M7 17.5H5a2 2 0 0 1-2-2v-4.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2h-2M7 14h10v6.5H7z"/>',
  settings:
    '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  'speaker-on':
    '<path d="M11 5L6.5 9H3.5v6h3l4.5 4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18.5 6a8.5 8.5 0 0 1 0 12"/>',
  'speaker-off': '<path d="M11 5L6.5 9H3.5v6h3l4.5 4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  blocked: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  'popup-blocked':
    '<rect x="3.5" y="5.5" width="13" height="11" rx="2"/><path d="M3.5 9h13"/><circle cx="17.5" cy="17.5" r="3.5"/><path d="M15 15l5 5"/>',
  globe:
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z"/>',
  extension: '<path d="M4.5 8.5h4a2.5 2.5 0 1 1 5 0h4v4a2.5 2.5 0 1 1 0 5v3h-13z"/>',
  tabs: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
  device: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
} as const;

/** Name of an icon of {@link icon}. */
export type IconName = keyof typeof PATHS;

const cache = new Map<IconName, SVGSVGElement>();

/** A new element of the icon `name` (decorative: `aria-hidden`, the button has the label). */
export function icon(name: IconName): SVGSVGElement {
  let template = cache.get(name);
  if (!template) {
    const holder = document.createElement('template');
    holder.innerHTML =
      `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
      `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
    template = holder.content.firstElementChild as SVGSVGElement;
    cache.set(name, template);
  }
  return template.cloneNode(true) as SVGSVGElement;
}

/** Replaces the icon of `target` (its first `.ui-icon`, or prepends one) with `name`. */
export function setIcon(target: Element, name: IconName): void {
  const fresh = icon(name);
  const old = target.querySelector(':scope > .ui-icon');
  if (old) old.replaceWith(fresh);
  else target.prepend(fresh);
}

/** Gives every element with `data-icon` below root its icon (the buttons of index.html). */
export function renderIcons(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-icon]'))
    setIcon(node, node.dataset.icon as IconName);
}
