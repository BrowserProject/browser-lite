# AGENTS.md

browser-lite: WebKit nach WebAssembly, ein ganzer Browser in einem Browser-Tab. Ueberblick in
[README.md](README.md), Hintergrund in [docs/](docs/), jeder Ordner hat eine kurze README.

## main und Deploy

Das Projekt ist ein Test und noch nicht produktiv. Gearbeitet wird direkt auf `main`: jederzeit
committen und pushen, ohne zu fragen, auch nur um etwas zu testen. Das ist der normale Weg und
soll so gemacht werden. Nie force-pushen.

Jeder Push auf `main` laeuft durch die CI und danach durch *Deploy*, der den Server auf genau
diesen Stand bringt ([deploy/README.md](deploy/README.md)). Nach einem Push beide Laeufe
abwarten (`gh run watch`), bei Rot reparieren und wieder pushen. Gruen heisst nur, dass es
baut und startet: aendert sich Verhalten, im echten Browser pruefen.

## Code und Doku

Einfacher, verstaendlicher, dauerhafter Code. Features sauber in die Architektur einbauen statt
anhaengen, auch wenn das mehr Arbeit ist. Was an mehreren Stellen gebraucht wird, gibt es einmal
als wiederverwendbares Modul (z.B. `relay/static.mjs` fuer beide Server).

Keine Rueckwaertskompatibilitaet ohne Not, lieber sauber umstellen. Bevor ein Feature entfernt
wird, das nicht klar verlangt wurde: fragen.

Doku kurz, nur was noetig ist, und aktuell halten (README des Ordners, passendes Kapitel in
`docs/`, `docs/stand.md`). Kommentare sparsam, nur fuer Nicht-Offensichtliches, nie fuer
Zwischenstaende oder Umstellungen. Deutsch, Umlaute als ae/oe/ue, kein Eszett, keine Gedankenstriche.

Versionen stehen nur in `versions.env`. Dockerfiles und Downloads sind gepinnt, Downloads mit
Checksumme. Shell-Skripte: `set -euo pipefail`, shellcheck-sauber. Aenderungen an WebKit nur
als Patch ([docs/build.md](docs/build.md)).

## Secrets und Sicherheit

Das Repo ist oeffentlich: keine Secrets, Tokens, Server-IPs oder Namen aus dem Heimnetz
committen. Nie Tokens loggen. Der Server laeuft intern ohne Relay-Token, nie oeffentlich machen
(z.B. Tailscale Funnel), ohne vorher `RELAY_TOKEN` zu setzen.

Der Self-hosted Runner (Label `browser-lite-deploy`) steht im LAN. Nur der Job `deploy` in
`deploy.yml` darf ihn nutzen, nie ein Job, der fuer Pull Requests oder Forks laeuft.

## Pruefen

Vor dem Push, je nach Aenderung:

```bash
git ls-files -z '*.sh' | xargs -0 shellcheck -x
node tests/relay/relay-test.mjs
node tests/wasm/rewrite-test.mjs && node tests/wasm/api-test.mjs
```

Engine, JSC und End-to-End-Tests brauchen den WebKit-Build und laufen in der CI
([docs/build.md](docs/build.md)).
