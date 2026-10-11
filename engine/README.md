# engine/

Phase 4+: unser Embedding von WebCore ("WasmWebView").

- Page/Frame aufsetzen, eigene WebCore-Clients (ChromeClient, FrameLoaderClient, ...)
- Rendering mit Skia auf das Canvas
- `net/`: Socket-Schicht und Transport-Interface (Wisp jetzt, WireGuard spaeter)
- `storage/`: WasmFS + OPFS
