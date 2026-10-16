# Profil auf dem Server (Plan)

Noch nicht umgesetzt. Das ist die bevorzugte Loesung, falls browser-lite ein Login bekommt:
ein kleines Profil, das einem auf jedes Geraet folgt, damit man auf Webseiten angemeldet bleibt.

## Was ins Profil kommt

Alles liegt schon unter `/data` (siehe [architektur.md](architektur.md), Speicher). Synchronisiert
wird nur, was Anmeldungen haelt, nicht was sich neu laden laesst:

| Daten | Pfad | Im Profil |
|---|---|---|
| Cookies | `/data/cookies.db` | ja |
| localStorage | `/data/localstorage/` (eine Datei pro Ursprung und `StorageTracker.db`) | ja |
| IndexedDB | `/data/indexeddb/v1/<Ursprung>/<Ursprung>/<Name>/`, ein Ordner pro Datenbank | nur Datenbanken bis 256 KB |
| OPFS der Seiten, Cache API, Service Worker | `/data/opfs`, `/data/cachestorage`, `/data/serviceworkers` | nein |
| HTTP- und Bytecode-Cache | Cache API des Host | nein |

Die Grenze bei IndexedDB ist der Mittelweg: Auth-Datenbanken sind winzig (z.B.
`firebaseLocalStorageDb` von Firebase Auth), die grossen sind fast immer Caches (YouTube,
Mail offline, Editoren). So bleibt ein Profil bei einigen KB bis wenigen MB. Waechst eine
Datenbank ueber die Grenze, faellt sie heraus, schlimmstenfalls meldet man sich dort neu an.

Offen: ob auch die Daten der Oberflaeche (Sitzung, Verlauf, Lesezeichen, Einstellungen in
`web/library.js`, `bl-permissions`) mitkommen, oder ob das der Host-Browser macht (#130).

## Ablauf

1. **Login** am Server mit Passkey. Die Sitzung ersetzt auch den `RELAY_TOKEN`: das Relay
   bekommt nur, wer angemeldet ist.
2. **Start:** Die Oberflaeche laedt das Profil, entschluesselt es und gibt die Dateien vor dem
   Start der Engine nach `/data`, auf dem gleichen Weg wie die Uebernahme aus dem alten IDBFS
   (`migrateLegacyStorage` in `engine/src/Storage.cpp`, daraus wird ein allgemeiner Import).
3. **Laufzeit:** Nach jedem Flush (`bl_storage_flush`, alle 5 s und beim Verlassen) meldet die
   Engine, welche Dateien des Profils sich geaendert haben. Die Oberflaeche verschluesselt und
   laedt nur diese hoch. Die Dateien sind dann immer ganz: das MemoryVFS schreibt SQLite nur
   ausserhalb einer Schreib-Transaktion.
4. **Abmelden:** wie "Gespeicherte Daten loeschen", `/data` wird geleert. Auf fremden Geraeten
   ohne OPFS (`BL_OPFS=0`): das Profil liegt nur im Speicher, lokal bleibt nichts.
5. **Server:** pro Nutzer verschluesselte Dateien, nach Inhalt adressiert, einige Versionen
   zum Zuruecksetzen. Der Container braucht dafuer ein Volume und Backups.

## Pflicht

- **Ende-zu-Ende verschluesselt.** Wer die Cookies hat, ist ueberall angemeldet. Schluessel aus
  der PRF-Erweiterung des Passkeys (sonst aus einem eigenen Passwort), verschluesselt wird im
  Host (WebCrypto, AES-GCM). Schuetzt gegen Lecks auf dem Server und in Backups, nicht gegen
  einen boeswilligen Server: der liefert auch die Engine aus.
- **Nur ein Geraet gleichzeitig.** Viele Seiten tauschen Refresh-Tokens bei jeder Nutzung aus
  (Google, Microsoft, OAuth). Legt ein zweites Geraet ein schon verbrauchtes Token vor, gilt das
  als Diebstahl und alle Sitzungen werden abgemeldet. Darum eine Sperre pro Profil auf dem
  Server mit Uebernahme (altes Geraet flusht und schliesst zuerst), dazu eine Sperre ueber Web
  Locks fuer mehrere Tabs im selben Host-Browser.

## Was nach einem Geraetewechsel fehlt

- Anmeldungen in grossen IndexedDB-Datenbanken, z.B. WhatsApp Web und Telegram Web: neu koppeln.
- Offline-Daten und PWAs starten leer und laden neu.

Weil der ganze Verkehr ueber das Relay geht (gleiche IP, gleicher User-Agent), sieht ein
mitgenommenes Profil fuer die Seiten wie dasselbe Geraet aus.

## Schritte

1. Konto und Login am Server, Sitzung statt `RELAY_TOKEN`.
2. Profil wie oben: Cookies, localStorage, kleine IndexedDB, verschluesselt, mit Sperre.
3. Spaeter: Kontingent pro Nutzer, Versionen zuruecksetzen, mehrere Profile pro Host
   (`/data/<Profil>` statt `/data`).
