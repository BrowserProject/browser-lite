# deploy/

Ein Container (`Dockerfile` im Hauptordner): `relay/server.mjs` mit der fertigen Seite.
Port 8080, ohne HTTPS. Browser geben SharedArrayBuffer nur in einem sicheren Kontext, darum
gehoert ein HTTPS-Proxy davor (hier `tailscale serve`, sonst z.B. Caddy).

## Ablauf bei jedem Push auf main

1. *CI* baut und testet die Engine.
2. *Deploy* (`.github/workflows/deploy.yml`, nur nach gruener CI):
   - Seite packen (`tools/package-site.sh`), Image bauen und testen (Header, Brotli, Token)
   - nach `ghcr.io/browserproject/browser-lite` pushen (Tags `<commit>` und `main`)
   - auf dem Server (Self-hosted Runner, Label `browser-lite-deploy`) mit `compose.yml`
     per Digest neu starten und `/healthz` pruefen

Ist die CI rot, bleibt der letzte gruene Stand online. Von Hand: *Actions -> Deploy -> Run
workflow* (ohne ID = letzter gruener CI-Lauf auf main).

## Server einrichten (Proxmox)

```bash
CT_IP=<ip>/<netz> CT_GW=<gateway> CT_STORAGE=<storage> deploy/setup-proxmox.sh root@<proxmox-host>
```

Legt einen unprivilegierten LXC mit Docker an, erzeugt `RELAY_TOKEN` in
`/opt/browser-lite/.env`, registriert den Runner und macht die Seite ueber `tailscale serve`
des Hosts per HTTPS im Tailnet erreichbar. Wiederholbar, bestehendes bleibt.

Danach einmal `https://<host>/?token=<RELAY_TOKEN>` oeffnen, der Token bleibt im Browser.
Token anzeigen: `pct exec <ct> -- cat /opt/browser-lite/.env` auf dem Proxmox-Host.

## Sicherheit

Das Repo ist oeffentlich und der Runner laeuft im LAN. Darum:
- Workflows aus Forks laufen erst nach Freigabe (Repo-Einstellung: alle externen Mitwirkenden).
- Nur der Job `deploy` nutzt das Label `browser-lite-deploy`, und nur nach einem Push auf
  `main` in diesem Repo. Nie einen anderen Job oder `pull_request` darauf laufen lassen.
- Der Container laeuft read-only, ohne Capabilities, als Benutzer `node`.
