// In-memory profile server speaking the HTTP protocol of the profile store, as a fetch function.

const PREFS = ['settings', 'bookmarks', 'permissions'];
const json = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });

export class FakeServer {
  constructor({ maxFileBytes = Infinity } = {}) {
    this.maxFileBytes = maxFileBytes;
    this.files = new Map();
    this.prefs = {};
    this.profile = {
      id: crypto.randomUUID(),
      session: null,
      resetBy: null,
      created: 1,
      updated: 1,
    };
    this.log = [];
    this.down = false;
    this.headers = [];
    this.fetch = this.fetch.bind(this);
  }

  checkSession(request) {
    const session = request.headers.get('x-profile-session');
    if (!session) return json(400);
    if (session !== this.profile.session) {
      const current = session.startsWith(`${this.profile.id}.`) || session === this.profile.resetBy;
      return json(409, { reason: current ? 'taken' : 'reset' });
    }
    return null;
  }

  /** Another device opens the profile: the session of the client is no longer valid. */
  takeOver() {
    this.profile.session = `${this.profile.id}.${crypto.randomUUID()}`;
  }

  async fetch(input, init) {
    const request = new Request(input, init);
    this.headers.push(Object.fromEntries(request.headers));
    if (this.down) throw new TypeError('fetch failed');
    const url = new URL(request.url);
    const route = url.pathname.split('/').slice(2).join('/');
    this.log.push(`${request.method} ${route}`);
    if (route === 'open' && request.method === 'POST') {
      const { device } = await request.json();
      this.device = device;
      this.profile.session = `${this.profile.id}.${crypto.randomUUID()}`;
      const files = [...this.files].map(([path, data]) => ({ path, size: data.length }));
      const prefs = Object.fromEntries(PREFS.map((name) => [name, this.prefs[name] ?? null]));
      const head = new TextEncoder().encode(
        JSON.stringify({
          id: this.profile.id,
          session: this.profile.session,
          created: 1,
          prefs,
          files,
        }),
      );
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, head.length, true);
      const parts = [length, head, ...this.files.values()];
      // Deliver in small chunks to exercise the incremental reader
      const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        all.set(part, offset);
        offset += part.length;
      }
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < all.length; i += 3) controller.enqueue(all.slice(i, i + 3));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    if (route === 'info' && request.method === 'GET') {
      const files = [...this.files].map(([path, data]) => ({
        path,
        size: data.length,
        modified: 1,
      }));
      return json(200, {
        id: this.profile.id,
        created: 1,
        updated: 2,
        device: this.device,
        opened: 3,
        maxBytes: 100,
        bytes: 0,
        files,
        cookies: [],
      });
    }
    if (route === 'reset' && request.method === 'POST') {
      const rejected = this.checkSession(request);
      if (rejected) return rejected;
      const { all } = await request.json();
      this.files.clear();
      for (const name of all ? PREFS : ['permissions']) delete this.prefs[name];
      Object.assign(this.profile, { id: crypto.randomUUID(), resetBy: this.profile.session });
      return json(204);
    }
    if (route.startsWith('files/')) {
      const rejected = this.checkSession(request);
      if (rejected) return rejected;
      const path = route.slice('files/'.length).split('/').map(decodeURIComponent).join('/');
      if (request.method === 'PUT') {
        const data = new Uint8Array(await request.arrayBuffer());
        if (data.length > this.maxFileBytes) return json(413);
        this.files.set(path, data);
        return json(204);
      }
      if (request.method === 'DELETE') {
        this.files.delete(path);
        return json(204);
      }
    }
    if (route.startsWith('prefs/') && request.method === 'PUT') {
      const rejected = this.checkSession(request);
      if (rejected) return rejected;
      const name = route.slice('prefs/'.length);
      if (!PREFS.includes(name)) return json(400);
      this.prefs[name] = await request.json();
      return json(204);
    }
    return json(404);
  }
}
