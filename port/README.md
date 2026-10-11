# port/

Phase 3: unser WebKit-Port `PORT=Wasm`.

- `cmake/OptionsWasm.cmake`: welche Features an/aus sind
- `Platform*.cmake` fuer WTF, JavaScriptCore, PAL, WebCore
- Plattform-Code (RunLoop-Anbindung, Screen, Cursor, Clipboard, Fonts, ...)

Was zwingend in den WebKit-Baum muss, kommt als Patch nach `patches/webkit/`.
