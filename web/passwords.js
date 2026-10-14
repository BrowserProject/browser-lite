// Passwort-Speicher wie in Chrome: nach dem Abschicken eines Anmeldeformulars
// fragt die Oberflaeche "Passwort speichern?", beim naechsten Besuch fuellt die
// Engine Benutzername und Passwort beim Fokus auf das Formular aus
// (engine/src/Passwords.cpp). Gespeichert wird im IndexedDB des Host-Browsers,
// die Passwoerter mit AES-GCM verschluesselt. Der Schluessel ist nicht
// exportierbar: auch Code der Oberflaeche kommt nicht an die Schluessel-Bytes.

const DB_NAME = 'bl-passwords';
let api = null;
let dbPromise = null;

export function initPasswords(options) {
  api = options;
}

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('logins', { keyPath: 'id' }).createIndex('origin', 'origin');
        db.createObjectStore('meta');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

async function run(store, mode, action) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

let keyPromise = null;
function key() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const existing = await run('meta', 'readonly', (s) => s.get('key'));
      if (existing)
        return existing;
      const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await run('meta', 'readwrite', (s) => s.put(created, 'key'));
      return created;
    })().catch((error) => {
      keyPromise = null;
      throw error;
    });
  }
  return keyPromise;
}

async function encrypt(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(text));
  return { iv, data };
}

async function decrypt(login) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: login.iv }, await key(), login.data);
  return new TextDecoder().decode(plain);
}

const loginsFor = (origin) => run('logins', 'readonly', (s) => s.index('origin').getAll(origin));

async function neverList() {
  return (await run('meta', 'readonly', (s) => s.get('never'))) || [];
}

// Alle gespeicherten Anmeldungen (ohne Passwort) fuer die Liste im Menue
export async function listLogins() {
  const logins = await run('logins', 'readonly', (s) => s.getAll()).catch(() => []);
  return logins.map(({ id, origin, username, used }) => ({ id, origin, username, used })).sort((a, b) => a.origin.localeCompare(b.origin));
}

export async function revealPassword(id) {
  const login = await run('logins', 'readonly', (s) => s.get(id));
  return login ? decrypt(login) : '';
}

export async function removeLogin(id) {
  await run('logins', 'readwrite', (s) => s.delete(id));
}

export async function clearPasswords() {
  keyPromise = null;
  if (dbPromise) {
    (await dbPromise.catch(() => null))?.close();
    dbPromise = null;
  }
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = request.onerror = request.onblocked = resolve;
  });
}

async function saveLogin(origin, username, password) {
  const id = origin + '\n' + username;
  const { iv, data } = await encrypt(password);
  await run('logins', 'readwrite', (s) => s.put({ id, origin, username, iv, data, used: Date.now() }));
}

// ------------------------------------------------------- Abfrage "Speichern?"

const prompt = document.createElement('div');
prompt.id = 'password-prompt';
prompt.hidden = true;
document.body.appendChild(prompt);

function hostOf(origin) {
  try {
    return new URL(origin).host || origin;
  } catch (e) {
    return origin;
  }
}

function showPrompt(data, update) {
  prompt.textContent = '';
  const text = document.createElement('p');
  text.textContent = update ? `Passwort für ${hostOf(data.origin)} aktualisieren?` : `Passwort für ${hostOf(data.origin)} speichern?`;
  const user = document.createElement('p');
  user.className = 'password-user';
  user.textContent = data.username || '(ohne Benutzername)';
  const save = document.createElement('button');
  save.textContent = update ? 'Aktualisieren' : 'Speichern';
  save.className = 'primary';
  const never = document.createElement('button');
  never.textContent = update ? 'Nein' : 'Nie';
  prompt.append(text, user, save, never);
  save.addEventListener('click', async () => {
    prompt.hidden = true;
    await saveLogin(data.origin, data.username, data.password).catch((error) => console.warn('Passwort speichern:', error));
  });
  never.addEventListener('click', async () => {
    prompt.hidden = true;
    if (update)
      return;
    const list = await neverList();
    if (!list.includes(data.origin))
      await run('meta', 'readwrite', (s) => s.put([...list, data.origin], 'never')).catch(() => {});
  });
  prompt.hidden = false;
}

export function hidePasswordPrompt() {
  prompt.hidden = true;
}

// Die Seite schickt ein Formular mit Passwort ab (engine: "password-submit")
export async function onPasswordSubmit(tab, data) {
  if (!data.origin || !data.password || !/^https?:/.test(data.origin))
    return;
  try {
    if ((await neverList()).includes(data.origin))
      return;
    const saved = (await loginsFor(data.origin)).find((login) => login.username === data.username);
    if (saved) {
      if (await decrypt(saved) === data.password) {
        await run('logins', 'readwrite', (s) => s.put({ ...saved, used: Date.now() }));
        return;
      }
      showPrompt(data, true);
      return;
    }
    showPrompt(data, false);
  } catch (error) {
    console.warn('Passwort-Speicher:', error);
  }
}

// Fokus auf einem leeren Anmeldeformular (engine: "login-field"): die zuletzt
// benutzte Anmeldung fuer diesen Ursprung einfuellen
export async function onLoginField(tab, data) {
  try {
    const logins = await loginsFor(data.origin);
    if (!logins.length)
      return;
    logins.sort((a, b) => b.used - a.used);
    const password = await decrypt(logins[0]);
    const engine = api.engine();
    engine._bl_fill_login(tab.id, api.toUTF8(data.origin), api.toUTF8(logins[0].username), api.toUTF8(password));
  } catch (error) {
    console.warn('Passwort-Speicher:', error);
  }
}
