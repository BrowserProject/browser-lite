// Auswahlen der Seite, die der Browser selber zeigt (engine/src/Choosers.cpp):
// Liste von <select>, Farbe (<input type=color>) und Datum/Zeit. Dazu die
// Link-Adresse unten links und Tooltips (title-Attribut) wie in Chrome.

let api; // { engine(), toUTF8(text), focusPage() }

export function initPickers(options) {
  api = options;
}

function anchorRect(tab, data) {
  const rect = tab.canvas.getBoundingClientRect();
  return { left: rect.left + data.x, top: rect.top + data.y, width: data.width, height: data.height };
}

// ------------------------------------------------------------- Liste (<select>)

const popup = document.createElement('div');
popup.id = 'select-popup';
popup.setAttribute('role', 'listbox');
popup.hidden = true;
document.body.appendChild(popup);

let popupTab = null;
let entries = []; // { index, row } der waehlbaren Eintraege
let highlighted = -1;
let typed = '';
let typedTimer = 0;

function highlight(position) {
  if (highlighted >= 0)
    entries[highlighted]?.row.classList.remove('highlighted');
  highlighted = position;
  const entry = entries[position];
  if (!entry)
    return;
  entry.row.classList.add('highlighted');
  entry.row.scrollIntoView({ block: 'nearest' });
}

function choose(index) {
  const tab = popupTab;
  closeSelectPopup();
  if (tab)
    api.engine()._bl_popup_choose(tab.id, index);
  api.focusPage();
}

function closeSelectPopup() {
  popup.hidden = true;
  popup.textContent = '';
  popupTab = null;
  entries = [];
  highlighted = -1;
}

export function showSelectPopup(tab, data) {
  // Die Engine schickt die Liste neu (z.B. geaenderte Optionen): nur neu zeichnen
  if (popupTab && popupTab !== tab)
    cancelSelectPopup();
  closeSelectPopup();
  popupTab = tab;
  data.items.forEach((item, index) => {
    if (item.separator) {
      popup.appendChild(document.createElement('hr'));
      return;
    }
    const row = document.createElement('div');
    row.textContent = item.text || ' ';
    if (item.tooltip)
      row.title = item.tooltip;
    if (item.label) {
      row.className = 'group';
    } else {
      row.className = 'option';
      row.setAttribute('role', 'option');
      if (item.selected)
        row.setAttribute('aria-selected', 'true');
      if (!item.enabled) {
        row.setAttribute('aria-disabled', 'true');
      } else {
        const position = entries.length;
        entries.push({ index, row, text: (item.text || '').trim().toLowerCase() });
        row.addEventListener('pointerenter', () => highlight(position));
        row.addEventListener('click', () => choose(index));
      }
    }
    popup.appendChild(row);
  });

  // Unter das Feld, sonst darueber; nie ueber den Fensterrand hinaus
  popup.hidden = false;
  const anchor = anchorRect(tab, data);
  popup.style.minWidth = anchor.width + 'px';
  popup.style.maxHeight = '';
  const below = window.innerHeight - (anchor.top + anchor.height) - 8;
  const above = anchor.top - 8;
  const height = popup.offsetHeight;
  if (height <= below || below >= above) {
    popup.style.top = (anchor.top + anchor.height) + 'px';
    popup.style.maxHeight = Math.max(below, 80) + 'px';
  } else {
    popup.style.maxHeight = above + 'px';
    popup.style.top = (anchor.top - Math.min(height, above)) + 'px';
  }
  popup.style.left = Math.max(4, Math.min(anchor.left, window.innerWidth - popup.offsetWidth - 4)) + 'px';
  highlight(Math.max(0, entries.findIndex((entry) => entry.index === data.selectedIndex)));
}

// Die Engine hat die Liste selber geschlossen
export function hideSelectPopup() {
  closeSelectPopup();
}

function cancelSelectPopup() {
  choose(-1);
}

function onPopupKey(e) {
  if (popup.hidden)
    return;
  let handled = true;
  switch (e.key) {
  case 'ArrowDown':
    highlight(Math.min(highlighted + 1, entries.length - 1));
    break;
  case 'ArrowUp':
    highlight(Math.max(highlighted - 1, 0));
    break;
  case 'PageDown':
    highlight(Math.min(highlighted + 10, entries.length - 1));
    break;
  case 'PageUp':
    highlight(Math.max(highlighted - 10, 0));
    break;
  case 'Home':
    highlight(0);
    break;
  case 'End':
    highlight(entries.length - 1);
    break;
  case 'Enter':
  case ' ':
    if (entries[highlighted])
      choose(entries[highlighted].index);
    else
      cancelSelectPopup();
    break;
  case 'Escape':
  case 'Tab':
    cancelSelectPopup();
    break;
  default:
    // Tippen springt zum ersten passenden Eintrag
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      clearTimeout(typedTimer);
      typed += e.key.toLowerCase();
      typedTimer = setTimeout(() => { typed = ''; }, 800);
      const match = entries.findIndex((entry) => entry.text.startsWith(typed));
      if (match >= 0)
        highlight(match);
    } else {
      handled = false;
    }
  }
  if (handled) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

window.addEventListener('keydown', onPopupKey, true);
window.addEventListener('pointerdown', (e) => {
  if (!popup.hidden && !popup.contains(e.target))
    cancelSelectPopup();
}, true);
window.addEventListener('blur', () => {
  if (!popup.hidden)
    cancelSelectPopup();
});
window.addEventListener('resize', () => {
  if (!popup.hidden)
    cancelSelectPopup();
});

// ------------------------------------------------- Farbe und Datum/Zeit
// Ein verstecktes Eingabefeld des Host-Browsers an der Stelle des Felds der
// Seite zeigt den echten Auswahldialog (showPicker).

let picker = null; // { tab, input, kind }

function finishPicker(sendDone) {
  if (!picker)
    return;
  const { tab, input, kind } = picker;
  picker = null;
  input.remove();
  if (sendDone)
    send(tab, kind, input.value, true);
}

function send(tab, kind, value, done) {
  const engine = api.engine();
  const text = value ? api.toUTF8(value) : 0;
  if (kind === 'color')
    engine._bl_color_chosen(tab.id, text, done ? 1 : 0);
  else
    engine._bl_datetime_chosen(tab.id, text, done ? 1 : 0);
}

// Zahl im Format von valueAsNumber in den Text fuer min/max umrechnen
function valueForNumber(type, number) {
  const input = document.createElement('input');
  input.type = type;
  try {
    input.valueAsNumber = number;
  } catch (e) {
    return '';
  }
  return input.value;
}

function openPicker(tab, data, kind, type, value) {
  finishPicker(true);
  const input = document.createElement('input');
  input.type = type;
  input.className = 'host-picker';
  input.tabIndex = -1;
  const anchor = anchorRect(tab, data);
  Object.assign(input.style, { left: anchor.left + 'px', top: anchor.top + 'px', width: Math.max(anchor.width, 1) + 'px', height: Math.max(anchor.height, 1) + 'px' });
  if (kind === 'datetime') {
    if (data.min)
      input.min = valueForNumber(type, data.min);
    if (data.max)
      input.max = valueForNumber(type, data.max);
  }
  input.value = value;
  document.body.appendChild(input);
  picker = { tab, input, kind };
  input.addEventListener('input', () => send(tab, kind, input.value, false));
  input.addEventListener('change', () => {
    if (picker?.input === input)
      finishPicker(true);
  });
  try {
    input.showPicker();
  } catch (e) {
    // Ohne Benutzeraktion (zu spaet) geht showPicker nicht: Feld fokussieren
    input.focus();
  }
}

export function showColorPicker(tab, data) {
  openPicker(tab, data, 'color', 'color', data.value || '#000000');
}

export function showDateTimePicker(tab, data) {
  const types = ['date', 'time', 'datetime-local', 'month', 'week'];
  openPicker(tab, data, 'datetime', types.includes(data.type) ? data.type : 'date', data.value || '');
}

// Die Engine hat die Auswahl selber beendet
export function hidePicker() {
  finishPicker(false);
}

window.addEventListener('pointerdown', (e) => {
  if (picker && e.target !== picker.input)
    finishPicker(true);
}, true);

// Tab geschlossen: seine Liste oder Auswahl nicht ueber dem naechsten Tab
// stehen lassen. Die Engine schliesst ihre Seite selber (Choosers.cpp).
export function closePickers(tab) {
  if (popupTab === tab)
    closeSelectPopup();
  if (picker?.tab === tab)
    finishPicker(false);
}

// ------------------------------------------------------- Link und Tooltip

const linkStatus = document.createElement('div');
linkStatus.id = 'link-status';
linkStatus.hidden = true;
document.body.appendChild(linkStatus);

export function showHover(tab, data, active) {
  if (active) {
    linkStatus.textContent = data.link || '';
    linkStatus.hidden = !data.link;
  }
  tab.canvas.title = data.tooltip || '';
}

export function clearHover() {
  linkStatus.hidden = true;
}
