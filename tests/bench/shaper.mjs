// A slow access link in front of a local TCP port, for benchmarks by hand: per direction a
// bottleneck of `kbit` that serves the connections round robin, then a one-way delay of rtt/2.
// A connection queues at most 64 KB at the bottleneck (its reader pauses), so connections share
// the link roughly like TCP flows do and a large download does not starve a small request.
import net from 'node:net';

const QUEUE_BYTES = 64 * 1024;
const CHUNK_BYTES = 4096;

function bottleneck(kbit) {
  const bytesPerMs = kbit / 8;
  const flows = new Set();
  let busy = false;
  const next = () => {
    busy = false;
    for (const flow of flows) {
      if (!flow.queue.length) continue;
      // Round robin: the flow goes to the end
      flows.delete(flow);
      flows.add(flow);
      const chunk = flow.queue.shift();
      flow.queued -= chunk ? chunk.length : 0;
      if (flow.queued < QUEUE_BYTES / 2) flow.resume();
      busy = true;
      setTimeout(
        () => {
          flow.deliver(chunk);
          next();
        },
        chunk ? chunk.length / bytesPerMs : 0,
      );
      return;
    }
  };
  return {
    add: (flow) => flows.add(flow),
    remove: (flow) => flows.delete(flow),
    kick: () => busy || next(),
  };
}

// from -> bottleneck -> delay line -> to; null in the queue stands for the end
function pipe(from, to, link, delay) {
  const line = [];
  let timer = null;
  const drain = () => {
    timer = null;
    while (line.length && line[0][0] <= Date.now()) {
      const [, chunk] = line.shift();
      if (to.destroyed) return;
      if (chunk === null) to.end();
      else to.write(chunk);
    }
    if (line.length) timer = setTimeout(drain, line[0][0] - Date.now());
  };
  const flow = {
    queue: [],
    queued: 0,
    resume: () => from.resume(),
    deliver(chunk) {
      line.push([Date.now() + delay, chunk]);
      if (chunk === null) link.remove(flow);
      timer ??= setTimeout(drain, delay);
    },
  };
  link.add(flow);
  from.on('data', (data) => {
    for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
      const chunk = data.subarray(offset, offset + CHUNK_BYTES);
      flow.queue.push(chunk);
      flow.queued += chunk.length;
    }
    if (flow.queued > QUEUE_BYTES) from.pause();
    link.kick();
  });
  const end = () => {
    flow.queue.push(null);
    link.kick();
  };
  from.on('end', end);
  from.on('error', end);
}

/**
 * Starts the link on a free port of 127.0.0.1 in front of `target` (a port of 127.0.0.1).
 * Returns `{ port, close() }`.
 */
export async function startShaper({ target, rttMs, downKbit, upKbit }) {
  const down = bottleneck(downKbit);
  const up = bottleneck(upKbit);
  const server = net.createServer((client) => {
    const upstream = net.connect(target, '127.0.0.1');
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    pipe(client, upstream, up, rttMs / 2);
    pipe(upstream, client, down, rttMs / 2);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => server.close() };
}
