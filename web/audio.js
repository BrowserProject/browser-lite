// Ton der Engine ueber das Web Audio des Host-Browsers abspielen.
//
// Die Engine meldet sich mit Module.onEngineAudio(typ, id, ptr, ...):
//   start: ein AudioContext der Seite laeuft, Ringpuffer bei ptr
//   stop:  AudioContext pausiert/geschlossen
//   close: Ringpuffer wird nicht mehr gebraucht, wir geben ihn frei
// Chrome laesst Ton erst nach einer Benutzer-Aktion zu. Bis dahin rendert die
// Engine weiter (die Zeit laeuft), nur hoert man noch nichts.

const workletURL = new URL('audio-worklet.js' + new URL(import.meta.url).search, import.meta.url);

let context = null;
let workletReady = null;
const outputs = new Map(); // id -> { node, stopped }
let lastPeak = 0;

function audioContext(sampleRate) {
  if (!context) {
    context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    workletReady = context.audioWorklet.addModule(workletURL);
    // Nach jedem Klick/Tastendruck nochmal versuchen, falls noch gesperrt
    const resume = () => {
      if (context.state === 'suspended' && outputs.size)
        context.resume().catch(() => {});
    };
    for (const type of ['pointerdown', 'keydown', 'touchend'])
      window.addEventListener(type, resume, true);
  }
  return context;
}

function stopOutput(id) {
  const output = outputs.get(id);
  if (!output)
    return;
  output.stopped = true;
  if (output.node) {
    output.node.port.postMessage('stop');
    output.node.disconnect();
  }
  outputs.delete(id);
}

async function startOutput(engine, id, ptr, capacity, channels, sampleRate) {
  stopOutput(id);
  const output = { node: null, stopped: false };
  outputs.set(id, output);
  try {
    const ctx = audioContext(sampleRate);
    await workletReady;
    if (output.stopped)
      return;
    output.node = new AudioWorkletNode(ctx, 'engine-audio-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { buffer: engine.HEAPU8.buffer, ptr, capacity, channels },
    });
    output.node.port.onmessage = (event) => {
      lastPeak = event.data.peak;
    };
    output.node.connect(ctx.destination);
    if (ctx.state === 'suspended')
      ctx.resume().catch(() => {});
  } catch (error) {
    console.warn('Ton nicht verfuegbar:', error);
  }
}

export function onEngineAudio(engine, type, id, ptr, capacity, channels, sampleRate) {
  if (type === 'start')
    startOutput(engine, id, ptr, capacity, channels, sampleRate);
  else if (type === 'stop')
    stopOutput(id);
  else if (type === 'close') {
    stopOutput(id);
    // Das Worklet liest vielleicht gerade noch, darum kurz warten
    setTimeout(() => engine._free(ptr), 500);
  }
}

// Fuer Tests: Zustand des Host-AudioContext
export function audioState() {
  return { state: context?.state ?? 'none', outputs: outputs.size, peak: lastPeak };
}
