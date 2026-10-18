// Minimal View for the tests: records calls and lets the test emit events.

export function fakeView({
  id = 1,
  url = 'https://example.com/',
  rect = { left: 0, top: 0 },
} = {}) {
  const listeners = new Map();
  const calls = [];
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  return {
    id,
    url,
    calls,
    canvas: {
      getBoundingClientRect: () => ({ left: rect.left, top: rect.top, width: 800, height: 600 }),
    },
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type).delete(listener);
    },
    emit(type, event = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    command: record('command'),
    paste: record('paste'),
    back: record('back'),
    forward: record('forward'),
    reload: record('reload'),
    print: record('print'),
    viewSource: record('viewSource'),
    focus: record('focus'),
  };
}
