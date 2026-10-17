// Geraete und Dienste des Host-Browsers fuer die Seiten in der Engine:
// Berechtigungs-Abfragen (wie Chrome), Standort, Benachrichtigungen, Gamepads,
// Sprachausgabe und Touch. Gegenstueck: engine/src/DeviceClients.cpp,
// Gamepad.cpp, Speech.cpp und WebView::touchEvent.

import { rtcHostCalls } from './webrtc.js';
import { pipHostCalls } from './media.js';
import { bytesToBase64, base64ToBytes, domError } from './util.js';

let api; // { engine(), toUTF8(text), tabs(), activeTab(), activateTab(tab), focusPage() }

const PERMISSIONS_KEY = 'bl-permissions';
const KIND_TEXT = {
  geolocation: 'möchte deinen Standort verwenden',
  notifications: 'möchte Benachrichtigungen anzeigen',
  microphone: 'möchte dein Mikrofon verwenden',
  camera: 'möchte deine Kamera verwenden',
  'camera-microphone': 'möchte deine Kamera und dein Mikrofon verwenden',
};

function loadDecisions() {
  try {
    return JSON.parse(localStorage.getItem(PERMISSIONS_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

function saveDecision(kind, origin, granted) {
  const decisions = loadDecisions();
  decisions[kind + ' ' + origin] = granted ? 1 : 2;
  try {
    localStorage.setItem(PERMISSIONS_KEY, JSON.stringify(decisions));
  } catch (e) {}
}

export function clearPermissions() {
  try {
    localStorage.removeItem(PERMISSIONS_KEY);
  } catch (e) {}
}

export function initDevices(options) {
  api = options;
  // Gespeicherte Entscheidungen an die Engine (gilt fuer Notification.permission usw.)
  const engine = api.engine();
  for (const [key, decision] of Object.entries(loadDecisions())) {
    const space = key.indexOf(' ');
    engine._bl_set_permission(api.toUTF8(key.slice(0, space)), api.toUTF8(key.slice(space + 1)), decision);
  }
  initSpeech();
  window.addEventListener('gamepadconnected', () => pollGamepads());
}

// ------------------------------------------------------- Berechtigungen

const prompt = document.createElement('div');
prompt.id = 'permission-prompt';
prompt.hidden = true;
document.body.appendChild(prompt);
const queue = [];

function showNextPrompt() {
  if (!prompt.hidden || !queue.length)
    return;
  const request = queue[0];
  prompt.textContent = '';
  const text = document.createElement('p');
  let host = request.origin;
  try {
    host = new URL(request.origin).host || request.origin;
  } catch (e) {}
  text.textContent = `${host} ${KIND_TEXT[request.kind] || 'möchte eine Berechtigung'}`;
  const allow = document.createElement('button');
  allow.textContent = 'Zulassen';
  allow.className = 'primary';
  const block = document.createElement('button');
  block.textContent = 'Blockieren';
  prompt.append(text, block, allow);
  const answer = async (granted) => {
    queue.shift();
    prompt.hidden = true;
    // Der Host-Browser fragt fuer browser-lite selber noch einmal (einmalig)
    if (granted && request.kind === 'notifications' && typeof Notification !== 'undefined' && Notification.permission !== 'granted')
      granted = (await Notification.requestPermission().catch(() => 'denied')) === 'granted';
    saveDecision(request.kind, request.origin, granted);
    api.engine()._bl_permission_answer(request.id, granted ? 1 : 2);
    showNextPrompt();
  };
  allow.addEventListener('click', () => answer(true));
  block.addEventListener('click', () => answer(false));
  prompt.hidden = false;
}

export function onPermissionRequest(tab, data) {
  queue.push({ ...data, view: tab.id });
  showNextPrompt();
}

// Tab geschlossen: offene Fragen ablehnen (ohne sie zu merken), Standort,
// Sensoren und Objekte der Host-Bruecke freigeben
export function forgetTab(tab) {
  const shown = prompt.hidden ? null : queue[0];
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].view === tab.id) {
      api.engine()._bl_permission_answer(queue[i].id, 0);
      queue.splice(i, 1);
    }
  }
  if (shown?.view === tab.id) {
    prompt.hidden = true;
    showNextPrompt();
  }
  onGeolocationStop(tab);
  onSensorStop(tab, { kind: 'orientation' });
  onSensorStop(tab, { kind: 'motion' });
  releaseHostObjects(tab.id);
}

// ------------------------------------------------------- Standort

const watches = new Map(); // viewId -> watchId

export function onGeolocationStart(tab, data) {
  onGeolocationStop(tab);
  if (!navigator.geolocation) {
    api.engine()._bl_geolocation_error(tab.id, 2, api.toUTF8('Kein Standort verfügbar'));
    return;
  }
  const nan = (value) => (value == null ? NaN : value);
  const id = navigator.geolocation.watchPosition((position) => {
    const c = position.coords;
    api.engine()._bl_geolocation_position(tab.id, c.latitude, c.longitude, c.accuracy, nan(c.altitude), nan(c.altitudeAccuracy), nan(c.heading), nan(c.speed), position.timestamp);
  }, (error) => {
    api.engine()._bl_geolocation_error(tab.id, error.code, api.toUTF8(error.message || ''));
  }, { enableHighAccuracy: !!data.highAccuracy });
  watches.set(tab.id, id);
}

export function onGeolocationStop(tab) {
  const id = watches.get(tab.id);
  if (id !== undefined) {
    navigator.geolocation?.clearWatch(id);
    watches.delete(tab.id);
  }
}

// ------------------------------------------------------- Lage und Bewegung

// Pro Tab und Art (orientation/motion) ein Zuhoerer auf das Event des Hosts,
// solange die Seite selber zuhoert. Nur der sichtbare Tab bekommt Werte.
const sensors = new Map(); // `${viewId}:${kind}` -> Funktion

export function onSensorStart(tab, data) {
  onSensorStop(tab, data);
  const nan = (value) => (value == null ? NaN : value);
  let listener;
  if (data.kind === 'orientation') {
    listener = (event) => {
      if (api.activeTab() === tab)
        api.engine()._bl_device_orientation(tab.id, nan(event.alpha), nan(event.beta), nan(event.gamma), event.absolute ? 1 : 0);
    };
    window.addEventListener('deviceorientation', listener);
  } else if (data.kind === 'motion') {
    listener = (event) => {
      if (api.activeTab() !== tab)
        return;
      const a = event.acceleration || {}, g = event.accelerationIncludingGravity || {}, r = event.rotationRate || {};
      api.engine()._bl_device_motion(tab.id, nan(a.x), nan(a.y), nan(a.z), nan(g.x), nan(g.y), nan(g.z),
        nan(r.alpha), nan(r.beta), nan(r.gamma), nan(event.interval));
    };
    window.addEventListener('devicemotion', listener);
  } else
    return;
  sensors.set(`${tab.id}:${data.kind}`, listener);
}

export function onSensorStop(tab, data) {
  const key = `${tab.id}:${data.kind}`;
  const listener = sensors.get(key);
  if (!listener)
    return;
  window.removeEventListener(data.kind === 'orientation' ? 'deviceorientation' : 'devicemotion', listener);
  sensors.delete(key);
}

// ------------------------------------------------------- Host-Bruecke

// Polyfills der Seite (engine/src/WebPlatformExtras.cpp) fragen APIs des
// Host-Browsers. Die Engine laesst nur diese Namen durch.
// File System Access: die Handles des Host bleiben hier, die Seite bekommt nur
// eine zufaellige id. Jede id gilt nur fuer den Ursprung, der sie bekommen hat.
const fsHandles = new Map(); // id -> { handle, origin, view }
const fsWritables = new Map(); // id -> { writable, origin, view }
const FS_MAX_FILE = 256 * 1024 * 1024;

function fsInfo(handle, origin, view) {
  const id = crypto.randomUUID();
  fsHandles.set(id, { handle, origin, view });
  return { id, name: handle.name, kind: handle.kind };
}

function fsHandle(id, origin, kind) {
  const entry = fsHandles.get(id);
  if (!entry || entry.origin !== origin || (kind && entry.handle.kind !== kind))
    throw domError('NotFoundError', 'Handle not found');
  return entry.handle;
}

function fsPickerOptions(payload) {
  const options = {};
  for (const key of ['types', 'excludeAcceptAllOption', 'multiple', 'suggestedName', 'id', 'startIn', 'mode']) {
    if (payload?.[key] !== undefined && payload[key] !== null)
      options[key] = payload[key];
  }
  return options;
}

function fsNeed(name) {
  if (typeof window[name] !== 'function')
    throw domError('NotSupportedError', name + ' not supported');
}

const hostCalls = {
  async 'fs-open'(payload, origin, view) {
    fsNeed('showOpenFilePicker');
    return (await window.showOpenFilePicker(fsPickerOptions(payload))).map((handle) => fsInfo(handle, origin, view));
  },
  async 'fs-save'(payload, origin, view) {
    fsNeed('showSaveFilePicker');
    return fsInfo(await window.showSaveFilePicker(fsPickerOptions(payload)), origin, view);
  },
  async 'fs-directory'(payload, origin, view) {
    fsNeed('showDirectoryPicker');
    return fsInfo(await window.showDirectoryPicker(fsPickerOptions(payload)), origin, view);
  },
  async 'fs-file'(payload, origin) {
    const file = await fsHandle(payload?.id, origin, 'file').getFile();
    if (file.size > FS_MAX_FILE)
      throw domError('NotReadableError', 'File too large');
    return { name: file.name, type: file.type, lastModified: file.lastModified, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) };
  },
  async 'fs-writable'(payload, origin, view) {
    const writable = await fsHandle(payload?.id, origin, 'file').createWritable({ keepExistingData: !!payload?.keepExistingData });
    const id = crypto.randomUUID();
    fsWritables.set(id, { writable, origin, view });
    return { id };
  },
  async 'fs-write'(payload, origin) {
    const entry = fsWritables.get(payload?.id);
    if (!entry || entry.origin !== origin)
      throw domError('InvalidStateError', 'Stream is closed');
    const { writable } = entry;
    switch (payload.op) {
    case 'write': {
      const data = base64ToBytes(payload.data || '');
      await writable.write(payload.position == null ? data : { type: 'write', position: payload.position, data });
      return null;
    }
    case 'seek':
      await writable.seek(payload.position);
      return null;
    case 'truncate':
      await writable.truncate(payload.size);
      return null;
    case 'close':
      fsWritables.delete(payload.id);
      await writable.close();
      return null;
    default:
      fsWritables.delete(payload.id);
      await writable.abort();
      return null;
    }
  },
  async 'fs-child'(payload, origin, view) {
    const directory = fsHandle(payload?.id, origin, 'directory');
    const options = { create: !!payload.create };
    const handle = payload.kind === 'directory' ? await directory.getDirectoryHandle(payload.name, options) : await directory.getFileHandle(payload.name, options);
    return fsInfo(handle, origin, view);
  },
  async 'fs-list'(payload, origin, view) {
    const list = [];
    for await (const handle of fsHandle(payload?.id, origin, 'directory').values())
      list.push(fsInfo(handle, origin, view));
    return list;
  },
  async 'fs-remove'(payload, origin) {
    await fsHandle(payload?.id, origin, 'directory').removeEntry(payload.name, { recursive: !!payload.recursive });
    return null;
  },
  async 'fs-resolve'(payload, origin) {
    const other = payload?.other ? fsHandle(payload.other, origin) : null;
    return other ? fsHandle(payload.id, origin, 'directory').resolve(other) : null;
  },
  async 'fs-same'(payload, origin) {
    const other = payload?.other ? fsHandle(payload.other, origin) : null;
    return other ? fsHandle(payload.id, origin).isSameEntry(other) : false;
  },
  async 'fs-permission'(payload, origin) {
    const handle = fsHandle(payload?.id, origin);
    const descriptor = { mode: payload.mode === 'readwrite' ? 'readwrite' : 'read' };
    const method = payload.request ? handle.requestPermission : handle.queryPermission;
    return typeof method === 'function' ? method.call(handle, descriptor) : 'granted';
  },
  async eyedropper() {
    if (typeof EyeDropper !== 'function')
      throw domError('NotSupportedError', 'EyeDropper not supported');
    const result = await new EyeDropper().open();
    return { sRGBHex: result.sRGBHex };
  },
  async battery() {
    if (typeof navigator.getBattery !== 'function')
      return { charging: true, chargingTime: 0, dischargingTime: null, level: 1 };
    const battery = await navigator.getBattery();
    const finite = (value) => (Number.isFinite(value) ? value : null);
    return { charging: battery.charging, chargingTime: finite(battery.chargingTime), dischargingTime: finite(battery.dischargingTime), level: battery.level };
  },
  async 'keyboard-lock'(payload) {
    if (!navigator.keyboard?.lock)
      throw domError('NotSupportedError', 'Keyboard lock not supported');
    await navigator.keyboard.lock(payload?.keyCodes || undefined);
    return null;
  },
  async 'keyboard-unlock'() {
    navigator.keyboard?.unlock?.();
    return null;
  },
  async 'keyboard-layout'() {
    if (!navigator.keyboard?.getLayoutMap)
      return [];
    return [...(await navigator.keyboard.getLayoutMap()).entries()];
  },
};

// WebCodecs ImageDecoder der Seiten (Polyfill in engine/src/WebPlatformExtras.cpp)
const imageDecoders = new Map(); // id -> { decoder, origin, view }
let nextImageDecoder = 1;

function imageDecoderFor(payload, origin) {
  const entry = imageDecoders.get(payload?.id);
  if (!entry || entry.origin !== origin)
    throw domError('InvalidStateError', 'The decoder has been closed.');
  return entry.decoder;
}

Object.assign(hostCalls, {
  async 'network-info'() {
    const connection = navigator.connection;
    return {
      deviceMemory: navigator.deviceMemory,
      connection: connection ? { effectiveType: connection.effectiveType, downlink: connection.downlink, rtt: connection.rtt, saveData: connection.saveData, type: connection.type } : null,
    };
  },
  async 'image-supported'(payload) {
    return typeof ImageDecoder === 'function' && await ImageDecoder.isTypeSupported(String(payload?.type));
  },
  async 'image-open'(payload, origin, view) {
    if (typeof ImageDecoder !== 'function')
      throw domError('NotSupportedError', 'ImageDecoder is not available');
    const init = { data: base64ToBytes(payload?.data || ''), type: String(payload?.type) };
    if (typeof payload?.preferAnimation === 'boolean')
      init.preferAnimation = payload.preferAnimation;
    const decoder = new ImageDecoder(init);
    await decoder.tracks.ready;
    await decoder.completed;
    const id = nextImageDecoder++;
    imageDecoders.set(id, { decoder, origin, view });
    const tracks = [];
    for (let i = 0; i < decoder.tracks.length; i++) {
      const track = decoder.tracks[i];
      tracks.push({ animated: track.animated, frameCount: track.frameCount, repetitionCount: track.repetitionCount, selected: track.selected });
    }
    return { id, tracks };
  },
  async 'image-decode'(payload, origin) {
    const decoder = imageDecoderFor(payload, origin);
    const { image } = await decoder.decode({ frameIndex: Number(payload.frameIndex) || 0 });
    try {
      const width = image.displayWidth, height = image.displayHeight;
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, width, height);
      const pixels = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
      return { width, height, timestamp: image.timestamp, duration: image.duration, data: bytesToBase64(pixels) };
    } finally {
      image.close();
    }
  },
  async 'image-close'(payload, origin) {
    imageDecoderFor(payload, origin).close();
    imageDecoders.delete(payload.id);
    return {};
  },
});

Object.assign(hostCalls, rtcHostCalls, pipHostCalls);

// Decoder, Writables und Handles eines geschlossenen Tabs. Beim Navigieren
// bleiben sie: das Dokument kann im Back/Forward-Cache weiterleben.
function releaseHostObjects(view) {
  for (const [id, entry] of imageDecoders) {
    if (entry.view === view) {
      imageDecoders.delete(id);
      entry.decoder.close();
    }
  }
  for (const [id, entry] of fsWritables) {
    if (entry.view === view) {
      fsWritables.delete(id);
      entry.writable.abort().catch(() => {});
    }
  }
  for (const [id, entry] of fsHandles) {
    if (entry.view === view)
      fsHandles.delete(id);
  }
}

export async function onHostCall(tab, data) {
  const send = (ok, value) => api.engine()._bl_host_call_result(data.id, ok ? 1 : 0, api.toUTF8(JSON.stringify(value ?? null)));
  const handler = hostCalls[data.name];
  if (!handler)
    return send(false, { name: 'NotSupportedError', message: 'Not supported' });
  try {
    send(true, await handler(JSON.parse(data.payload || 'null'), data.origin || '', tab.id));
  } catch (error) {
    send(false, { name: error?.name || 'NotSupportedError', message: error?.message || String(error) });
  }
}

// ------------------------------------------------------- Benachrichtigungen

const notifications = new Map(); // id -> Notification des Hosts

export function onNotification(tab, data) {
  const send = (type) => api.engine()._bl_notification_event(api.toUTF8(data.id), type);
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    send(3);
    return;
  }
  const notification = new Notification(data.title, { body: data.body, icon: data.icon || undefined, tag: data.tag || undefined, lang: data.lang || undefined, silent: data.silent });
  notifications.set(data.id, notification);
  notification.addEventListener('show', () => send(0));
  // Aus showNotification() (persistent): den Klick behandelt der Service Worker
  notification.addEventListener('click', () => {
    window.focus();
    const target = !data.persistent && tab && api.tabs().get(tab.id);
    if (target)
      api.activateTab(target);
    send(1);
  });
  notification.addEventListener('close', () => {
    notifications.delete(data.id);
    send(2);
  });
  notification.addEventListener('error', () => send(3));
}

export function onNotificationClose(data) {
  notifications.get(data.id)?.close();
}

// ------------------------------------------------------- Gamepads

let gamepadMonitoring = false;
let gamepadFrame = 0;
const lastGamepadState = [];

export function onGamepadMonitor(data) {
  gamepadMonitoring = !!data.on;
  if (gamepadMonitoring)
    pollGamepads();
}

function pollGamepads() {
  if (!gamepadMonitoring || gamepadFrame)
    return;
  gamepadFrame = requestAnimationFrame(() => {
    gamepadFrame = 0;
    const engine = api.engine();
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let index = 0; index < Math.max(pads.length, lastGamepadState.length); index++) {
      const pad = pads[index];
      const state = pad && pad.connected
        ? JSON.stringify({ connected: true, id: pad.id, mapping: pad.mapping, axes: [...pad.axes], buttons: pad.buttons.map((b) => b.value), haptics: !!pad.vibrationActuator })
        : JSON.stringify({ connected: false });
      if (state !== lastGamepadState[index]) {
        lastGamepadState[index] = state;
        engine._bl_gamepad(index, api.toUTF8(state));
      }
    }
    pollGamepads();
  });
}

export function onGamepadEffect(data) {
  const pad = navigator.getGamepads?.()[data.index];
  const actuator = pad?.vibrationActuator;
  if (!actuator)
    return;
  if (data.type === 'stop')
    actuator.reset?.();
  else
    actuator.playEffect(data.type, { duration: data.duration, startDelay: data.startDelay, strongMagnitude: data.strongMagnitude, weakMagnitude: data.weakMagnitude }).catch(() => {});
}

// ------------------------------------------------------- Sprachausgabe

function initSpeech() {
  if (typeof speechSynthesis === 'undefined')
    return;
  const sendVoices = () => {
    const voices = speechSynthesis.getVoices().map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang, local: v.localService, default: v.default }));
    api.engine()._bl_speech_voices(api.toUTF8(JSON.stringify(voices)));
  };
  speechSynthesis.addEventListener('voiceschanged', sendVoices);
  sendVoices();
}

export function onSpeak(data) {
  const send = (type, charIndex = 0, charLength = 0) => api.engine()._bl_speech_event(data.id, type, charIndex, charLength);
  if (typeof speechSynthesis === 'undefined') {
    send(4);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(data.text);
  if (data.lang)
    utterance.lang = data.lang;
  const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === data.voice);
  if (voice)
    utterance.voice = voice;
  utterance.volume = data.volume;
  utterance.rate = data.rate;
  utterance.pitch = data.pitch;
  utterance.onstart = () => send(0);
  utterance.onend = () => send(1);
  utterance.onpause = () => send(2);
  utterance.onresume = () => send(3);
  utterance.onerror = (e) => (e.error === 'canceled' || e.error === 'interrupted' ? send(1) : send(4));
  utterance.onboundary = (e) => send(e.name === 'sentence' ? 6 : 5, e.charIndex, e.charLength || 0);
  speechSynthesis.speak(utterance);
}

export function onSpeechCommand(data) {
  if (typeof speechSynthesis === 'undefined')
    return;
  if (data.command === 'pause')
    speechSynthesis.pause();
  else if (data.command === 'resume')
    speechSynthesis.resume();
  else
    speechSynthesis.cancel();
}

// ------------------------------------------------------- Spracherkennung
// Die Engine (DeviceClients.cpp) hat schon nach dem Mikrofon gefragt. Wir
// erkennen mit SpeechRecognition des Host und melden alles zurueck.

const RECOGNITION_ERRORS = ['no-speech', 'aborted', 'audio-capture', 'network', 'not-allowed', 'service-not-allowed', 'bad-grammar', 'language-not-supported'];
const recognitions = new Map(); // id -> SpeechRecognition des Host

export function onSpeechRecognition(tab, data) {
  const send = (type, payload = '') => api.engine()._bl_speech_recognition_event(data.id, type, api.toUTF8(payload));
  const running = recognitions.get(data.id);
  if (data.action !== 'start') {
    if (running) {
      if (data.action === 'stop')
        running.stop();
      else
        running.abort();
    }
    return;
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    send(9, JSON.stringify({ error: RECOGNITION_ERRORS.indexOf('service-not-allowed'), message: 'Spracherkennung gibt es hier nicht' }));
    send(10);
    return;
  }
  running?.abort();
  const recognition = new Recognition();
  if (data.lang)
    recognition.lang = data.lang;
  recognition.continuous = !!data.continuous;
  recognition.interimResults = !!data.interimResults;
  recognition.maxAlternatives = Math.max(1, data.maxAlternatives || 1);
  const events = ['start', 'audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend'];
  events.forEach((name, type) => recognition.addEventListener(name, () => send(type)));
  recognition.addEventListener('result', (e) => {
    // Nur die geaenderten Ergebnisse, WebCore haengt sie an die fertigen an
    const results = [];
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const alternatives = [];
      for (let j = 0; j < result.length; j++)
        alternatives.push([result[j].transcript, result[j].confidence]);
      results.push({ final: result.isFinal, alternatives });
    }
    send(7, JSON.stringify(results));
  });
  recognition.addEventListener('nomatch', () => send(8));
  recognition.addEventListener('error', (e) => {
    const index = RECOGNITION_ERRORS.indexOf(e.error);
    send(9, JSON.stringify({ error: index < 0 ? 3 : index, message: e.message || '' }));
  });
  recognition.addEventListener('end', () => {
    if (recognitions.get(data.id) === recognition)
      recognitions.delete(data.id);
    send(10);
  });
  recognitions.set(data.id, recognition);
  try {
    recognition.start();
  } catch (e) {
    recognitions.delete(data.id);
    send(9, JSON.stringify({ error: 2, message: String(e.message || e) }));
    send(10);
  }
}

// ------------------------------------------------------- Touch
// Finger gehen als Touch-Events an die Seite. Faengt die Seite sie nicht ab
// (preventDefault), scrollt ein Wischen die Seite (mit Schwung), ein kurzes
// Antippen wird ein Klick, langes Druecken das Kontextmenue und zwei Finger
// zoomen die Ansicht, wie in Chrome.

const TAP_DISTANCE = 10;
const LONG_PRESS = 550;

export function attachTouch(tab, canvas, position, modifierBits) {
  const touches = new Map(); // pointerId -> { id, x, y, pinch }
  let gesture = null; // { startX, startY, lastX, lastY, lastTime, velocityX, velocityY, moved, consumed, timer }
  let fling = 0;
  // Zwei Finger: Pinch-Zoom der Ansicht wie Chrome (engine/src/PinchZoom.h),
  // wenn die Seite die Finger nicht selber will (preventDefault, touch-action)
  let pinch = null; // { x, y, distance } der ersten zwei Finger
  const startsWithoutResult = []; // pointerId je touchstart, Antworten kommen der Reihe nach

  const send = (type, changedId, state, e) => {
    const points = [...touches.entries()].map(([pointerId, t]) => ({
      id: t.id, x: t.x, y: t.y, state: pointerId === changedId ? state : 3 /* stationaer */,
      rx: (e.width || 1) / 2, ry: (e.height || 1) / 2, force: e.pressure || 0,
    }));
    api.engine()._bl_touch(tab.id, type, api.toUTF8(JSON.stringify(points)), modifierBits(e));
  };

  const fingers = () => {
    const [a, b] = touches.values();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const startPinch = () => {
    if (pinch || touches.size !== 2 || ![...touches.values()].every((t) => t.pinch))
      return;
    pinch = fingers();
    api.engine()._bl_pinch(tab.id, 0, 1, pinch.x, pinch.y);
  };
  // phase 2 Ende, 3 Abbruch (zurueck zum Anfang der Geste)
  const stopPinch = (phase) => {
    if (!pinch)
      return;
    api.engine()._bl_pinch(tab.id, phase, 1, pinch.x, pinch.y);
    pinch = null;
  };

  tab.onTouchResult = (data) => {
    if (data.type === 0) {
      const touch = touches.get(startsWithoutResult.shift());
      if (touch)
        touch.pinch = data.pinch && !data.consumed;
      startPinch();
    }
    if (data.consumed) {
      if (gesture)
        gesture.consumed = true;
      stopPinch(3);
    }
  };

  const stopFling = () => {
    cancelAnimationFrame(fling);
    fling = 0;
  };

  const scrollBy = (x, y, dx, dy) => api.engine()._bl_wheel(tab.id, x, y, dx, dy, 0);

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch')
      return;
    e.preventDefault();
    e.stopImmediatePropagation();
    api.focusPage();
    stopFling();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = position(e);
    touches.set(e.pointerId, { id: e.pointerId, x, y, pinch: false });
    startsWithoutResult.push(e.pointerId);
    send(0, e.pointerId, 1 /* gedrueckt */, e);
    if (touches.size === 1) {
      gesture = { startX: x, startY: y, lastX: x, lastY: y, lastTime: e.timeStamp, velocityX: 0, velocityY: 0, moved: false, consumed: false };
      gesture.timer = setTimeout(() => {
        if (gesture && !gesture.moved && !gesture.consumed) {
          gesture.longPress = true;
          api.engine()._bl_context_menu(tab.id, x, y);
        }
      }, LONG_PRESS);
    } else if (gesture) {
      // Zweiter Finger: kein Klick und kein Scrollen mehr fuer diese Geste
      gesture.consumed = true;
    }
  }, true);

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId))
      return;
    e.stopImmediatePropagation();
    const [x, y] = position(e);
    Object.assign(touches.get(e.pointerId), { x, y });
    send(1, e.pointerId, 2 /* bewegt */, e);
    if (pinch && touches.size >= 2) {
      const now = fingers();
      if (pinch.distance > 0 && now.distance > 0)
        api.engine()._bl_pinch(tab.id, 1, now.distance / pinch.distance, now.x, now.y);
      pinch = now;
    }
    if (!gesture || touches.size !== 1)
      return;
    if (!gesture.moved && Math.hypot(x - gesture.startX, y - gesture.startY) > TAP_DISTANCE) {
      gesture.moved = true;
      clearTimeout(gesture.timer);
    }
    if (gesture.moved && !gesture.consumed) {
      const dx = gesture.lastX - x;
      const dy = gesture.lastY - y;
      const dt = Math.max(1, e.timeStamp - gesture.lastTime);
      gesture.velocityX = 0.8 * (dx / dt) + 0.2 * gesture.velocityX;
      gesture.velocityY = 0.8 * (dy / dt) + 0.2 * gesture.velocityY;
      scrollBy(x, y, dx, dy);
    }
    gesture.lastX = x;
    gesture.lastY = y;
    gesture.lastTime = e.timeStamp;
  }, true);

  const end = (e, cancelled) => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId))
      return;
    e.stopImmediatePropagation();
    const [x, y] = position(e);
    Object.assign(touches.get(e.pointerId), { x, y });
    send(cancelled ? 3 : 2, e.pointerId, cancelled ? 4 /* abgebrochen */ : 0 /* losgelassen */, e);
    touches.delete(e.pointerId);
    if (touches.size < 2)
      stopPinch(cancelled ? 3 : 2);
    if (!gesture || touches.size)
      return;
    const g = gesture;
    gesture = null;
    clearTimeout(g.timer);
    if (cancelled || g.consumed || g.longPress)
      return;
    if (!g.moved) {
      // Antippen = Klick (Maus runter/hoch an derselben Stelle)
      const engine = api.engine();
      engine._bl_mouse(tab.id, 2, -1, x, y, 0, 0);
      engine._bl_mouse(tab.id, 0, 0, x, y, 1, 0);
      engine._bl_mouse(tab.id, 1, 0, x, y, 1, 0);
      return;
    }
    // Schwung: Geschwindigkeit langsam abklingen lassen
    let vx = g.velocityX * 16;
    let vy = g.velocityY * 16;
    const step = () => {
      vx *= 0.95;
      vy *= 0.95;
      if (Math.abs(vx) < 0.5 && Math.abs(vy) < 0.5) {
        fling = 0;
        return;
      }
      scrollBy(x, y, vx, vy);
      fling = requestAnimationFrame(step);
    };
    if (Math.hypot(vx, vy) > 2)
      fling = requestAnimationFrame(step);
  };
  canvas.addEventListener('pointerup', (e) => end(e, false), true);
  canvas.addEventListener('pointercancel', (e) => end(e, true), true);
}
