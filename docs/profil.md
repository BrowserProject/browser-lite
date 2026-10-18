# Profil im Container

Der Container hostet genau ein Browser-Profil: Cookies, localStorage und kleine IndexedDBs der
Seiten, dazu Einstellungen, Lesezeichen und Berechtigungen der Oberflaeche. So bleibt man auf
Websites angemeldet, auch nach dem Wechsel auf ein anderes Geraet. Server: `createProfileStore`
(API in [packages/server/README.md](../packages/server/README.md)), Oberflaeche: `web/profile.js` und
`web/settings.js` ([web/README.md](../web/README.md)).

## Was im Profil ist

Nur was Anmeldungen haelt, nicht was sich neu laden laesst. Die Pfade sind die von `/data` der
Engine, also des OPFS im Host (siehe [architektur.md](architektur.md), Speicher).

| Daten | Pfad | Im Profil |
|---|---|---|
| Cookies | `cookies.db` | immer (24-60 KB) |
| localStorage | `localstorage/<Ursprung>.localstorage` | bis zur Grenze |
| IndexedDB | `indexeddb/v1/<oben>/[<Frame>/]<SHA-256 des Namens>/`, `IndexedDB.sqlite3` und Blobs | ganzer Ordner bis zur Grenze |
| `localstorage/LegacyStorageTracker.db` | | nein, WebKit baut sie beim Start aus den Dateien neu auf |
| Cache API, Service Worker, OPFS der Seiten, HTTP- und Bytecode-Cache | | nein, Cache des Geraets |
| Einstellungen, Lesezeichen, Berechtigungen | `prefs/<name>.json` auf dem Server | ja |
| Verlauf, offene Tabs, Downloads | localStorage des Host | nein |

Auf dem Server liegt das Profil unter `PROFILE_DIR` (Container: `/data`, Volume `profile`),
jede Datei atomar geschrieben. Grenzen dort: 32 MB pro Datei, `PROFILE_MAX_MB` (64) fuer alles.

## Grenze pro Datenbank

Eine Datenbank ist `cookies.db`, eine `.localstorage`-Datei oder ein IndexedDB-Ordner (alle
Dateien zusammen). Ausser `cookies.db` kommt sie nur ins Profil, wenn sie hoechstens `DB_LIMIT`
gross ist: Standard 256 KB, in den Einstellungen 128 KB bis 4 MB. Gemessen (abgemeldet):

- Eine leere IndexedDB von WebKit hat immer 77824 Bytes (19 Seiten). Von 18 Datenbanken echter
  Seiten lagen 16 zwischen 64 und 128 KB, eine bei 176 KB, die von Telegram (ein Cache) bei 268 KB.
- localStorage kann selber ein grosser Cache sein: Notion 2.6 MB, Wikipedia 1.9 MB, alle anderen
  hoechstens 40 KB.

Darum eine Grenze fuer beide Arten. Waechst eine Datenbank darueber, faellt sie aus dem Profil
und bleibt als Cache auf dem Geraet, schlimmstenfalls meldet man sich dort neu an.

## Ablauf

1. **Start** (`mountStorage` in `web/app.js`, mit der Sperre `bl-data`, bevor die Engine
   laeuft): Was beim letzten Mal nicht mehr hochging, laedt `profile.js` zuerst nach
   (`localStorage['bl-profile-sync']`: Session, Stand jeder Datei, nicht gesendete prefs).
   Dann `POST /profile/open`: der Server schickt alle Dateien und prefs in einer Antwort und
   gibt eine neue Session, die sofort mit dem Kopf der Antwort gespeichert wird (10 s bis zum
   Kopf, 120 s fuer die Dateien). Die Datei `profile-id` im OPFS sagt, welches Profil dort
   liegt. Ein anderes (neues Geraet, zurueckgesetzt) leert erst das ganze OPFS. Sonst gilt der
   Server: seine Datenbanken ersetzen die lokalen, eine lokale, die im Profil war und die er
   nicht mehr hat, wurde anderswo geloescht. Datenbanken, die nie im Profil waren (zu gross),
   bleiben als Cache. Was beim Nachholen nicht hochging (Netz, Server lehnt ab), bleibt wie es
   ist und geht danach hoch, ausser ein anderes Geraet hat das Profil inzwischen geoeffnet.
2. **Laufzeit:** Die Engine schreibt jede SQLite-Datei ganz per `rename`, ca. 1 s nach einer
   Aenderung (Entscheid 180). `syncProfile` liest das OPFS alle 2 s (versteckt alle 30 s, 2.5 s
   nach dem Verstecken), vergleicht Groesse und Zeit mit dem zuletzt Hochgeladenen, laedt
   Geaendertes hoch und loescht auf dem Server, was lokal fehlt (erst beim zweiten Mal, die
   Engine kann die Datei gerade ersetzen) oder zu gross geworden ist. prefs gehen sofort hoch.
3. **Uebernahme:** Jedes `open` macht eine neue Session, nur die letzte darf schreiben. Das
   vorige Geraet bekommt 409, der Abgleich stoppt mit dem Hinweis "Das Profil wurde auf einem
   anderen Geraet geoeffnet" und "Neu laden" (holt es zurueck). Viele Seiten tauschen
   Refresh-Tokens bei jeder Nutzung aus, zwei Geraete gleichzeitig wuerden sich gegenseitig
   abmelden. Die Session steht in `profile.json` und ueberlebt einen Deploy.
4. **Zuruecksetzen** (Einstellungen, Profil, nur im Tab mit dem Profil): "Websitedaten
   loeschen" loescht Dateien und Berechtigungen, "Profil zuruecksetzen" auch Einstellungen und
   Lesezeichen. Das Profil bekommt
   eine neue id, das OPFS wird beim naechsten Start geleert, die anderen Geraete bekommen 409
   und leeren ihr OPFS beim naechsten Start.
5. **Ohne Server** (404, 503, Netz, Zeit um): alles laeuft lokal weiter, prefs aus der Kopie in
   `localStorage['bl-profile-prefs']`, Hinweis am Tab. Was so geaendert wurde, auch prefs,
   geht beim naechsten Start mit Server hoch und gilt dort, ausser ein anderes Geraet hat das
   Profil inzwischen geoeffnet. Ein zweiter Tab der Oberflaeche (ohne `bl-data`) hat kein
   Profil.

Sitzungs-Cookies loescht WebKit beim Oeffnen von `cookies.db`. Mit "Tabs beim Start
wiederherstellen" (Standard) bleiben sie wie in Chrome: die Oberflaeche setzt
`BL_KEEP_SESSION_COOKIES=1` (Patch 0044). Sonst waere man nach jedem Neustart dort abgemeldet,
wo die Seite nur ein Sitzungs-Cookie setzt. "Jetzt neu starten" (und der Neustart nach einem
Absturz) behaelt Sitzung und Sitzungs-Cookies immer.

## Nicht gemacht

- Keine Ende-zu-Ende-Verschluesselung und kein Login: die Dateien liegen unverschluesselt auf
  dem Server, wer ihn erreicht, hat das Profil (also die Anmeldungen). Darum nur intern, sonst
  mit `RELAY_TOKEN` ([deploy/README.md](../deploy/README.md)).
- Ein Profil pro Container. Spaeter: Login (Passkey), mehrere Profile, verschluesselt im Host
  (WebCrypto), Versionen zum Zuruecksetzen.
- Anmeldungen in grossen IndexedDBs (WhatsApp Web, Telegram Web) folgen nicht auf ein anderes
  Geraet, Offline-Daten und PWAs laden dort neu.
