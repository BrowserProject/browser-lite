// DOM tests of @browser-lite/ui in the browser of tests/lib (BL_BROWSER):
//   npx tsc -b && node packages/ui/test/browser.mjs
// Not part of `npm test`, which runs without a browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch } from '../../../tests/lib/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server;
let browser;
let page;
let origin;

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><meta charset="utf-8"><body style="margin:0"></body>');
      return;
    }
    try {
      const file = path.join(root, path.normalize(url.pathname));
      if (!file.startsWith(root)) throw new Error('outside');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  await context.grantPermissions(['notifications'], { origin });
  page = await context.newPage();
  page.on('pageerror', (error) => console.log('page error:', error.message));
  await page.goto(`${origin}/`);
  await page.evaluate(async () => {
    window.ui = { ...(await import('/dist/index.js')), ...(await import('/dist/datetime.js')) };
    // A view whose canvas sits at (50, 60) with 400x300 CSS px
    window.makeView = (id = 1, url = 'https://example.com/') => {
      const canvas = document.createElement('canvas');
      Object.assign(canvas.style, {
        position: 'fixed',
        left: '50px',
        top: '60px',
        width: '400px',
        height: '300px',
      });
      document.body.append(canvas);
      const listeners = new Map();
      const calls = [];
      const record =
        (name) =>
        (...args) =>
          calls.push([name, ...args]);
      return {
        id,
        url,
        canvas,
        calls,
        on(type, listener) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(listener);
          return () => listeners.get(type).delete(listener);
        },
        emit(type, event = {}) {
          for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
        },
        focus: record('focus'),
        command: record('command'),
        paste: record('paste'),
        back: record('back'),
        forward: record('forward'),
        reload: record('reload'),
        print: record('print'),
        viewSource: record('viewSource'),
      };
    };
    window.key = (key, options = {}) =>
      document.activeElement.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }),
      );
    window.pointerdown = (target) =>
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    window.items = [
      {
        text: 'Fruits',
        tooltip: '',
        enabled: true,
        label: true,
        selected: false,
        separator: false,
      },
      {
        text: 'Apple',
        tooltip: 'red',
        enabled: true,
        label: false,
        selected: false,
        separator: false,
      },
      {
        text: 'Banana',
        tooltip: '',
        enabled: true,
        label: false,
        selected: true,
        separator: false,
      },
      {
        text: 'Cherry',
        tooltip: '',
        enabled: false,
        label: false,
        selected: false,
        separator: false,
      },
      { text: '', tooltip: '', enabled: true, label: false, selected: false, separator: true },
      { text: 'Date', tooltip: '', enabled: true, label: false, selected: false, separator: false },
    ];
  });
});

after(async () => {
  await browser?.close();
  server?.close();
});

test('select popup: rendering, position, keyboard and Enter', async () => {
  const result = await page.evaluate(async () => {
    const { selectPopup } = ui.selectPopup();
    const view = makeView();
    const pageKeys = [];
    const onPageKey = (e) => pageKeys.push(e.key);
    // Registered first and in the capture phase of the document, still after the popup
    document.addEventListener('keydown', onPageKey, true);
    const promise = selectPopup({
      view,
      rect: { x: 10, y: 20, width: 120, height: 24 },
      items,
      selectedIndex: 2,
      signal: new AbortController().signal,
    });
    const popup = document.querySelector('.bl-select-popup');
    const rows = [...popup.children].map((node) => `${node.className}:${node.textContent}`);
    const highlighted = () => popup.querySelector('[data-bl-highlighted]')?.textContent;
    const start = highlighted();
    const style = {
      top: popup.style.top,
      left: popup.style.left,
      minWidth: popup.style.minWidth,
      position: popup.style.position,
      overflowY: popup.style.overflowY,
    };
    const attrs = {
      role: popup.getAttribute('role'),
      ui: popup.dataset.blUi,
      selected: popup.querySelector('[aria-selected]')?.textContent,
      disabled: popup.querySelector('[aria-disabled]')?.textContent,
      tooltip: popup.querySelector('[title]')?.title,
    };
    key('ArrowDown');
    const afterDown = highlighted();
    key('ArrowDown');
    const atEnd = highlighted();
    key('Home');
    const home = highlighted();
    key('End');
    key('Enter');
    const index = await promise;
    document.removeEventListener('keydown', onPageKey, true);
    key('x');
    return {
      rows,
      start,
      style,
      attrs,
      afterDown,
      atEnd,
      home,
      index,
      open: !!document.querySelector('.bl-select-popup'),
      calls: view.calls,
      pageKeys,
    };
  });
  assert.deepEqual(result.rows, [
    'bl-group:Fruits',
    'bl-option:Apple',
    'bl-option bl-highlighted:Banana',
    'bl-option:Cherry',
    'bl-separator:',
    'bl-option:Date',
  ]);
  assert.equal(result.start, 'Banana');
  assert.deepEqual(result.style, {
    top: '104px',
    left: '60px',
    minWidth: '120px',
    position: 'fixed',
    overflowY: 'auto',
  });
  assert.deepEqual(result.attrs, {
    role: 'listbox',
    ui: 'select-popup',
    selected: 'Banana',
    disabled: 'Cherry',
    tooltip: 'red',
  });
  assert.equal(result.afterDown, 'Date', 'disabled entries are skipped');
  assert.equal(result.atEnd, 'Date');
  assert.equal(result.home, 'Apple');
  assert.equal(result.index, 5);
  assert.equal(result.open, false);
  assert.deepEqual(result.calls, [['focus']]);
  assert.deepEqual(result.pageKeys, [], 'keys do not reach the page while the popup is open');
});

test('select popup: typing, Escape, Space, Tab and page keys', async () => {
  const result = await page.evaluate(async () => {
    const { selectPopup } = ui.selectPopup();
    const view = makeView();
    const open = (selectedIndex = 1) =>
      selectPopup({
        view,
        rect: { x: 0, y: 0, width: 50, height: 20 },
        items,
        selectedIndex,
        signal: new AbortController().signal,
      });
    const highlighted = () =>
      document.querySelector('.bl-select-popup [data-bl-highlighted]')?.textContent;
    const out = {};
    let promise = open();
    key('d');
    out.typed = highlighted();
    key('Escape');
    out.escape = await promise;
    promise = open();
    key('b');
    key(' ');
    out.space = await promise;
    promise = open();
    key('Tab');
    out.tab = await promise;
    promise = open(1);
    key('PageDown');
    out.pageDown = highlighted();
    key('PageUp');
    out.pageUp = highlighted();
    key('Escape');
    await promise;
    promise = open(3);
    out.disabledSelected = highlighted();
    key('Escape');
    await promise;
    return out;
  });
  assert.deepEqual(result, {
    typed: 'Date',
    escape: -1,
    space: 2,
    tab: -1,
    pageDown: 'Date',
    pageUp: 'Apple',
    disabledSelected: 'Apple',
  });
});

test('select popup: click, click outside, abort, a new request and a width change', async () => {
  const result = await page.evaluate(async () => {
    const { selectPopup } = ui.selectPopup();
    const view = makeView();
    const open = (signal = new AbortController().signal) =>
      selectPopup({
        view,
        rect: { x: 0, y: 0, width: 50, height: 20 },
        items,
        selectedIndex: 1,
        signal,
      });
    const out = {};
    let promise = open();
    const date = [...document.querySelectorAll('.bl-select-popup .bl-option')].find(
      (row) => row.textContent === 'Date',
    );
    date.dispatchEvent(new PointerEvent('pointerenter'));
    out.hover = document.querySelector('[data-bl-highlighted]').textContent;
    date.click();
    out.click = await promise;
    promise = open();
    document.querySelector('.bl-select-popup [aria-disabled]').click();
    out.stillOpen = !!document.querySelector('.bl-select-popup');
    pointerdown(document.body);
    out.outside = await promise;
    const controller = new AbortController();
    view.calls.length = 0;
    promise = open(controller.signal);
    controller.abort();
    out.aborted = await promise;
    out.abortFocus = view.calls.length;
    out.removed = !document.querySelector('.bl-select-popup');
    const first = open();
    const second = open();
    out.replaced = await first;
    out.count = document.querySelectorAll('.bl-select-popup').length;
    // Only a change of the width closes it (not an on-screen keyboard that goes away)
    window.dispatchEvent(new Event('resize'));
    out.heightOnly = document.querySelectorAll('.bl-select-popup').length;
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', {
      value: window.innerWidth + 100,
      configurable: true,
    });
    window.dispatchEvent(new Event('resize'));
    if (innerWidth) Object.defineProperty(window, 'innerWidth', innerWidth);
    else delete window.innerWidth;
    out.resize = await second;
    const pre = new AbortController();
    pre.abort();
    out.preAborted = await open(pre.signal);
    out.left = document.querySelectorAll('.bl-select-popup').length;
    return out;
  });
  assert.deepEqual(result, {
    hover: 'Date',
    click: 5,
    stillOpen: true,
    outside: -1,
    aborted: -1,
    abortFocus: 0,
    removed: true,
    replaced: -1,
    count: 1,
    heightOnly: 1,
    resize: -1,
    preAborted: -1,
    left: 0,
  });
});

test('select popup opens above the field when there is no room below', async () => {
  const result = await page.evaluate(async () => {
    const { selectPopup } = ui.selectPopup();
    const view = makeView();
    const many = Array.from({ length: 40 }, (_, i) => ({
      text: `Item ${i}`,
      tooltip: '',
      enabled: true,
      label: false,
      selected: false,
      separator: false,
    }));
    const promise = selectPopup({
      view,
      rect: { x: 300, y: 500, width: 80, height: 20 },
      items: many,
      selectedIndex: 39,
      signal: new AbortController().signal,
    });
    const popup = document.querySelector('.bl-select-popup');
    const box = popup.getBoundingClientRect();
    const out = {
      bottom: Math.round(box.bottom),
      top: Math.round(box.top),
      maxHeight: popup.style.maxHeight,
    };
    key('Escape');
    await promise;
    return out;
  });
  assert.equal(result.bottom, 560, 'ends at the top of the field');
  assert.ok(result.top >= 0);
  assert.equal(result.maxHeight, '552px');
});

test('select popup with real keyboard and mouse input', async () => {
  await page.evaluate(() => {
    const { selectPopup } = ui.selectPopup();
    window.view = makeView();
    window.pending = selectPopup({
      view,
      rect: { x: 10, y: 10, width: 100, height: 20 },
      items,
      selectedIndex: 1,
      signal: new AbortController().signal,
    });
  });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => pending), 2);
  await page.evaluate(() => {
    window.pending = ui.selectPopup().selectPopup({
      view,
      rect: { x: 10, y: 10, width: 100, height: 20 },
      items,
      selectedIndex: 1,
      signal: new AbortController().signal,
    });
  });
  await page.locator('.bl-select-popup .bl-option', { hasText: 'Date' }).click();
  assert.equal(await page.evaluate(() => pending), 5);
  await page.evaluate(() => {
    window.pending = ui.selectPopup().selectPopup({
      view,
      rect: { x: 10, y: 10, width: 100, height: 20 },
      items,
      selectedIndex: 1,
      signal: new AbortController().signal,
    });
  });
  await page.mouse.click(700, 500);
  assert.equal(await page.evaluate(() => pending), -1);
});

test('permission prompt: queue, answers, abort, texts and notifications', async () => {
  const result = await page.evaluate(async () => {
    const { permission } = ui.permissionPrompt({ texts: { allow: 'Yes' } });
    const view = makeView(3);
    const prompt = () => document.querySelector('.bl-permission-prompt');
    const req = (kind, signal = new AbortController().signal, origin = 'https://maps.example') =>
      permission({ view, kind, origin, signal });
    const out = {};
    const first = req('geolocation');
    const second = req('camera');
    const thirdController = new AbortController();
    const third = req('microphone', thirdController.signal);
    const fourth = req('midi', undefined, 'null');
    out.count = document.querySelectorAll('.bl-permission-prompt').length;
    out.text1 = prompt().querySelector('p').textContent;
    out.buttons = [...prompt().querySelectorAll('button')].map(
      (b) => `${b.dataset.blAnswer}:${b.textContent}:${b.className}`,
    );
    out.attrs = [prompt().dataset.blView, prompt().dataset.blKind, prompt().getAttribute('role')];
    prompt().querySelector('[data-bl-answer=allow]').click();
    out.answer1 = await first;
    out.text2 = prompt().querySelector('p').textContent;
    thirdController.abort();
    out.answer3 = await third;
    prompt().querySelector('[data-bl-answer=block]').click();
    out.answer2 = await second;
    out.text4 = prompt().querySelector('p').textContent;
    let hostAnswer = 'granted';
    const asked = [];
    Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
    Notification.requestPermission = async () => {
      asked.push(1);
      return hostAnswer;
    };
    const fifth = req('notifications');
    prompt().querySelector('[data-bl-answer=block]').click();
    out.answer4 = await fourth;
    out.text5 = prompt().querySelector('p').textContent;
    prompt().querySelector('[data-bl-answer=allow]').click();
    out.answer5 = await fifth;
    hostAnswer = 'denied';
    const refused = req('notifications');
    prompt().querySelector('[data-bl-answer=allow]').click();
    out.refused = await refused;
    out.asked = asked.length;
    const sixthController = new AbortController();
    const sixth = req('geolocation', sixthController.signal);
    const seventh = req('camera');
    sixthController.abort();
    out.answer6 = await sixth;
    out.text7 = prompt().querySelector('p').textContent;
    prompt().querySelector('[data-bl-answer=allow]').click();
    out.answer7 = await seventh;
    out.left = document.querySelectorAll('.bl-permission-prompt').length;
    return out;
  });
  assert.deepEqual(result, {
    count: 1,
    text1: 'maps.example wants to know your location',
    buttons: ['block:Block:bl-block', 'allow:Yes:bl-allow'],
    attrs: ['3', 'geolocation', 'dialog'],
    answer1: 'grant',
    text2: 'maps.example wants to use your camera',
    answer3: 'dismiss',
    answer2: 'deny',
    text4: 'This page wants to use midi',
    answer4: 'deny',
    text5: 'maps.example wants to show notifications',
    answer5: 'grant',
    refused: 'dismiss',
    asked: 2,
    answer6: 'dismiss',
    text7: 'maps.example wants to use your camera',
    answer7: 'grant',
    left: 0,
  });
});

test('login prompt: texts, keyboard, queue, cancel and abort', async () => {
  await page.evaluate(() => {
    const { authenticate } = ui.loginPrompt({ texts: { signIn: 'Anmelden' } });
    window.login = { authenticate, answers: [] };
  });
  await page.evaluate(
    ([first, second, third]) => {
      const view = makeView(5);
      const controller = new AbortController();
      window.login.abort = () => controller.abort();
      for (const [index, origin] of [first, second, third].entries())
        window.login
          .authenticate({
            view,
            url: `${origin}/private/`,
            origin,
            realm: 'Members',
            scheme: 'basic',
            retry: false,
            signal: index === 1 ? controller.signal : new AbortController().signal,
          })
          .then((answer) => window.login.answers.push([index, answer]));
    },
    ['http://plain.example', 'https://aborted.example', 'https://secure.example'],
  );
  const shown = () =>
    page.evaluate(() => {
      const forms = document.querySelectorAll('.bl-login-prompt');
      const form = forms[0];
      return {
        count: forms.length,
        title: form?.querySelector('h2').textContent,
        origin: form?.querySelector('.bl-origin').textContent,
        warning: form?.querySelector('.bl-not-private')?.textContent ?? null,
        labels: form ? [...form.querySelectorAll('label')].map((l) => l.textContent) : [],
        buttons: form
          ? [...form.querySelectorAll('button')].map(
              (b) => `${b.dataset.blAnswer}:${b.textContent}`,
            )
          : [],
        focused: document.activeElement?.name ?? null,
        attrs: form ? [form.dataset.blView, form.getAttribute('role')] : [],
      };
    });
  assert.deepEqual(await shown(), {
    count: 1,
    title: 'Anmelden',
    origin: 'http://plain.example',
    warning: 'Your connection to this site is not private',
    labels: ['Username', 'Password'],
    buttons: ['cancel:Cancel', 'sign-in:Anmelden'],
    focused: 'username',
    attrs: ['5', 'dialog'],
  });
  // Real typing, Tab and Enter sign in
  await page.keyboard.type('ann');
  await page.keyboard.press('Tab');
  await page.keyboard.type('sécret');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.login.answers.length === 1);
  // The aborted one leaves the queue, the next shows without the warning
  await page.evaluate(() => window.login.abort());
  await page.waitForFunction(() => window.login.answers.length === 2);
  const third = await shown();
  assert.equal(third.origin, 'https://secure.example');
  assert.equal(third.warning, null);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.login.answers.length === 3);
  // Cancel button of another request
  const last = page.evaluate(() =>
    window.login.authenticate({
      view: makeView(6),
      url: 'https://x.example/',
      origin: 'https://x.example',
      realm: '',
      scheme: 'digest',
      retry: true,
      signal: new AbortController().signal,
    }),
  );
  await page.click('.bl-login-prompt [data-bl-answer=cancel]');
  assert.equal(await last, null);
  assert.deepEqual(await page.evaluate(() => window.login.answers), [
    [0, { username: 'ann', password: 'sécret' }],
    [1, null],
    [2, null],
  ]);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.bl-login-prompt').length), 0);
});

test('context menu with the default items', async () => {
  const result = await page.evaluate(async () => {
    const view = makeView(4);
    const opened = [];
    const info = {
      x: 30,
      y: 40,
      link: 'https://l.test/',
      image: '',
      selection: '',
      editable: false,
      canGoBack: false,
      canGoForward: true,
    };
    const items = ui.defaultMenuItems(view, info, { openTab: (url) => opened.push(url) });
    const close = ui.showContextMenu(view, info, items);
    const menu = document.querySelector('.bl-context-menu');
    const out = {
      rows: [...menu.children].map((node) =>
        node.tagName === 'HR' ? '-' : `${node.textContent}${node.disabled ? ' (off)' : ''}`,
      ),
      position: [menu.style.left, menu.style.top, menu.style.position],
      role: menu.getAttribute('role'),
      item: menu.querySelector('button').dataset.blItem,
    };
    menu.querySelector('[data-bl-item=open-link]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    out.opened = opened;
    out.closedByClick = !document.querySelector('.bl-context-menu');
    out.calls = view.calls.map((call) => call[0]);
    close();
    ui.showContextMenu(view, info, items);
    key('Escape');
    out.escape = !document.querySelector('.bl-context-menu');
    ui.showContextMenu(view, info, items);
    pointerdown(document.body);
    out.outside = !document.querySelector('.bl-context-menu');
    ui.showContextMenu(view, info, items);
    ui.showContextMenu(view, info, items);
    out.single = document.querySelectorAll('.bl-context-menu').length;
    view.emit('close');
    out.viewClosed = !document.querySelector('.bl-context-menu');
    ui.showContextMenu(view, info, items);
    window.dispatchEvent(new Event('blur'));
    out.blur = !document.querySelector('.bl-context-menu');
    const edge = ui.showContextMenu(view, { ...info, x: 740, y: 530 }, items);
    const box = document.querySelector('.bl-context-menu').getBoundingClientRect();
    out.inside = box.right <= 800 && box.bottom <= 600;
    edge();
    ui.showContextMenu(view, info, [
      { label: 'Broken', action: () => Promise.reject(new Error('no')) },
      { separator: true },
    ]);
    out.custom = [...document.querySelector('.bl-context-menu').children].map(
      (node) => node.tagName,
    );
    document.querySelector('.bl-context-menu button').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    out.afterError = !document.querySelector('.bl-context-menu');
    return out;
  });
  assert.deepEqual(result, {
    rows: [
      'Open link in new tab',
      'Copy link address',
      '-',
      'Select all',
      '-',
      'Back (off)',
      'Forward',
      'Reload',
      'Print…',
      'View page source',
    ],
    position: ['80px', '100px', 'fixed'],
    role: 'menu',
    item: 'open-link',
    opened: ['https://l.test/'],
    closedByClick: true,
    calls: ['focus'],
    escape: true,
    outside: true,
    single: 1,
    viewClosed: true,
    blur: true,
    inside: true,
    custom: ['BUTTON'],
    afterError: true,
  });
});

test('link status bubble follows hover events', async () => {
  const result = await page.evaluate(() => {
    const view = makeView(5);
    const dispose = ui.linkStatus(view);
    const bubble = () => document.querySelector('.bl-link-status');
    const out = { initial: bubble().hidden };
    view.emit('hover', { url: 'https://a.test/x' });
    out.shown = [bubble().hidden, bubble().textContent];
    view.emit('hover', { url: null });
    out.cleared = bubble().hidden;
    view.emit('hover', { url: 'https://b.test/' });
    view.emit('commit', { errorPage: null });
    out.commit = bubble().hidden;
    dispose();
    out.removed = !bubble();
    view.emit('hover', { url: 'https://c.test/' });
    out.still = !bubble();
    const other = makeView(6);
    ui.linkStatus(other);
    other.emit('close');
    out.closed = !bubble();
    return out;
  });
  assert.deepEqual(result, {
    initial: true,
    shown: [false, 'https://a.test/x'],
    cleared: true,
    commit: true,
    removed: true,
    still: true,
    closed: true,
  });
});

test('color and date/time pickers', async () => {
  const result = await page.evaluate(async () => {
    const { colorPicker, dateTimePicker } = ui.defaultHandlers();
    const view = makeView(7);
    const input = () => document.querySelector('input.bl-host-picker');
    const rect = { x: 5, y: 6, width: 70, height: 22 };
    const out = {};
    const previews = [];
    let promise = colorPicker({
      view,
      rect,
      value: '#ff0000',
      signal: new AbortController().signal,
      preview: (value) => previews.push(value),
    });
    out.color = [
      input().type,
      input().value,
      input().style.left,
      input().style.top,
      input().style.width,
      input().style.opacity,
    ];
    input().value = '#0000ff';
    input().dispatchEvent(new Event('input'));
    input().value = '#00ff00';
    input().dispatchEvent(new Event('input'));
    input().dispatchEvent(new Event('change'));
    out.chosen = await promise;
    out.previews = [...previews];
    out.removed = !input();
    const controller = new AbortController();
    promise = colorPicker({ view, rect, value: '', signal: controller.signal });
    out.defaultColor = input().value;
    controller.abort();
    out.aborted = await promise;
    const day = Date.UTC(2024, 0, 1);
    promise = dateTimePicker({
      view,
      rect,
      type: 'date',
      value: '2024-03-05',
      min: day,
      max: day + 365 * 86400000,
      step: 7 * 86400000,
      signal: new AbortController().signal,
    });
    out.date = [input().type, input().value, input().min, input().max, input().step];
    pointerdown(document.body);
    out.outside = await promise;
    promise = dateTimePicker({
      view,
      rect,
      type: 'time',
      value: '',
      min: 8 * 3600000,
      max: 0,
      step: 900000,
      signal: new AbortController().signal,
    });
    out.time = [input().type, input().min, input().max, input().step];
    const next = colorPicker({
      view,
      rect,
      value: '#123456',
      signal: new AbortController().signal,
    });
    out.replaced = await promise;
    out.single = document.querySelectorAll('input.bl-host-picker').length;
    input().dispatchEvent(new Event('change'));
    out.next = await next;
    promise = dateTimePicker({
      view,
      rect,
      type: 'week',
      value: '',
      min: 0,
      max: 0,
      step: 604800000,
      signal: new AbortController().signal,
    });
    out.week = [input().type, input().min, input().step];
    // Firefox and Safari have no week input: their date picker stands in
    out.hostWeek = input().type === 'week';
    input().value = out.hostWeek ? '2024-W10' : '2024-03-05';
    input().dispatchEvent(new Event('change'));
    out.weekValue = await promise;
    promise = dateTimePicker({
      view,
      rect,
      type: 'month',
      value: '2024-03',
      min: (2024 - 1970) * 12,
      max: (2024 - 1970) * 12 + 5,
      step: 0,
      signal: new AbortController().signal,
      preview: (value) => previews.push(value),
    });
    out.month = [input().type, input().value, input().min, input().max];
    input().value = out.hostWeek ? '2024-04' : '2024-04-17';
    input().dispatchEvent(new Event('input'));
    out.monthPreview = previews.at(-1);
    input().dispatchEvent(new Event('change'));
    out.monthValue = await promise;
    promise = dateTimePicker({
      view,
      rect,
      type: 'bogus',
      value: '',
      min: 0,
      max: 0,
      step: 0,
      signal: new AbortController().signal,
    });
    out.fallback = [input().type, input().step];
    pointerdown(input());
    out.ownClick = !!input();
    input().dispatchEvent(new Event('change'));
    out.empty = await promise;
    // Composed on their own, both pickers still share the one picker of the document
    const separate = { ...ui.colorPicker(), ...ui.dateTimePicker() };
    promise = separate.dateTimePicker({
      view,
      rect,
      type: 'date',
      value: '2024-05-06',
      min: 0,
      max: 0,
      step: 0,
      signal: new AbortController().signal,
      preview: (value) => previews.push(value),
    });
    input().value = '2024-05-07';
    input().dispatchEvent(new Event('input'));
    const color = separate.colorPicker({
      view,
      rect,
      value: '#abcdef',
      signal: new AbortController().signal,
    });
    out.separate = [await promise, document.querySelectorAll('input.bl-host-picker').length];
    out.datePreview = previews.at(-1);
    pointerdown(document.body);
    out.separateColor = await color;
    return out;
  });
  const { hostWeek } = result;
  assert.deepEqual(result, {
    color: ['color', '#ff0000', '55px', '66px', '70px', '0'],
    chosen: '#00ff00',
    previews: ['#0000ff', '#00ff00'],
    removed: true,
    defaultColor: '#000000',
    aborted: null,
    date: ['date', '2024-03-05', '2024-01-01', '2024-12-31', '7'],
    outside: '2024-03-05',
    time: ['time', '08:00', '', '900'],
    replaced: null,
    single: 1,
    next: '#123456',
    week: hostWeek ? ['week', '', '1'] : ['date', '', ''],
    hostWeek,
    weekValue: '2024-W10',
    month: hostWeek
      ? ['month', '2024-03', '2024-01', '2024-06']
      : ['date', '2024-03-01', '2024-01-01', '2024-06-30'],
    monthPreview: '2024-04',
    monthValue: '2024-04',
    fallback: ['date', ''],
    ownClick: true,
    empty: null,
    separate: ['2024-05-07', 1],
    datePreview: '2024-05-07',
    separateColor: '#abcdef',
  });
});

test('pickers on an iPhone: a sheet with the input, opened by the tap on it', async () => {
  const result = await page.evaluate(async () => {
    const restore = [
      ['userAgent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)'],
      ['maxTouchPoints', 5],
    ].map(([name, value]) => {
      Object.defineProperty(navigator, name, { configurable: true, get: () => value });
      return () => delete navigator[name];
    });
    try {
      const { dateTimePicker } = ui.defaultHandlers();
      const view = makeView(8);
      const rect = { x: 5, y: 6, width: 70, height: 22 };
      const request = () =>
        dateTimePicker({
          view,
          rect,
          type: 'date',
          value: '2024-03-05',
          min: 0,
          max: 0,
          step: 0,
          signal: new AbortController().signal,
        });
      const out = {};
      let promise = request();
      const sheet = document.querySelector('form.bl-picker-sheet');
      const input = sheet?.querySelector('input.bl-host-picker');
      out.sheet = [!!sheet, input?.type, input?.value, input?.style.opacity, sheet?.style.top];
      sheet.querySelector('button[data-bl-answer=cancel]').click();
      out.cancelled = await promise;
      out.removed = !document.querySelector('form.bl-picker-sheet');
      promise = request();
      const next = document.querySelector('form.bl-picker-sheet input');
      pointerdown(next);
      out.stillOpen = !!document.querySelector('form.bl-picker-sheet');
      next.value = '2024-04-01';
      next.dispatchEvent(new Event('change'));
      out.chosen = await promise;
      return out;
    } finally {
      for (const undo of restore) undo();
    }
  });
  assert.deepEqual(result, {
    sheet: [true, 'date', '2024-03-05', '', '92px'],
    cancelled: null,
    removed: true,
    stillOpen: true,
    chosen: '2024-04-01',
  });
});

test('native dialogs show Chrome-like texts and protect against loops', async () => {
  const shown = [];
  const answers = [];
  const onDialog = async (dialog) => {
    shown.push([dialog.type(), dialog.message(), dialog.defaultValue()]);
    const answer = answers.shift() ?? true;
    if (answer === false) await dialog.dismiss();
    else await dialog.accept(typeof answer === 'string' ? answer : undefined);
  };
  page.on('dialog', onDialog);
  // alert, prompt, beforeunload, confirm, then a loop of alerts: the fourth asks, blocked
  answers.push(true, 'typed', true, false, true, true, true, false);
  const result = await page.evaluate(() => {
    let now = 1e6;
    const blocked = [];
    const { dialog } = ui.nativeDialogs({
      now: () => now,
      onBlocked: (view) => blocked.push(view.id),
    });
    const view = makeView(8);
    const req = (type, extra = {}) => ({
      view,
      type,
      origin: 'https://example.com',
      message: 'Hi',
      defaultValue: 'd',
      reload: false,
      ...extra,
    });
    const out = [];
    out.push(dialog(req('alert')));
    now += 5000;
    out.push(dialog(req('prompt')));
    now += 5000;
    out.push(dialog(req('beforeunload', { reload: true })));
    now += 5000;
    out.push(dialog(req('confirm')));
    now += 5000;
    for (let i = 0; i < 6; i++) {
      out.push(dialog(req('alert')));
      now += 100;
    }
    return { out, blocked };
  });
  page.off('dialog', onDialog);
  assert.deepEqual(result.out, [
    undefined,
    'typed',
    true,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  assert.deepEqual(result.blocked, [8]);
  assert.deepEqual(shown, [
    ['alert', 'example.com says:\n\nHi', ''],
    ['prompt', 'example.com says:\n\nHi', 'd'],
    ['confirm', 'Reload site?\n\nChanges that you made may not be saved.', ''],
    ['confirm', 'example.com says:\n\nHi', ''],
    ['alert', 'example.com says:\n\nHi', ''],
    ['alert', 'example.com says:\n\nHi', ''],
    ['alert', 'example.com says:\n\nHi', ''],
    ['confirm', 'example.com is showing many dialogs. Allow more dialogs from this site?', ''],
  ]);
});

test('valueFromNumber converts through the host browser', async () => {
  const values = await page.evaluate(() => {
    const day = Date.UTC(2024, 1, 29);
    return [
      ['date', day],
      ['datetime-local', day + 13 * 3_600_000 + 5 * 60_000],
      ['time', 9 * 3_600_000 + 30 * 60_000],
      ['month', (2024 - 1970) * 12 + 11],
      ['week', Date.UTC(2020, 11, 28)],
      ['bogus', day],
      ['date', Number.NaN],
      ['date', 1e20],
    ].map(([type, number]) => ui.valueFromNumber(document, type, number));
  });
  assert.deepEqual(values, [
    '2024-02-29',
    '2024-02-29T13:05',
    '09:30',
    '2024-12',
    '2020-W53',
    '2024-02-29',
    '',
    '',
  ]);
});
