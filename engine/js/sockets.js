// Sockets der Engine (engine/src/Sockets.cpp), Teil im Haupt-Thread.
//
// Die C++-Seite schickt asynchron: Verbindung oeffnen, Daten senden,
// schliessen. Die Verbindungen gehen ueber den Transport der Oberflaeche
// (Module.blTransport, z.B. Wisp aus web/transport.js). Ankommende Daten
// schreiben wir direkt in den Speicher der Engine (_bl_socket_data), was der
// Transport wirklich verschickt hat, melden wir zurueck (_bl_socket_sent).
var blSockets = {
  streams: new Map(),

  open(id, host, port) {
    var transport = Module['blTransport'];
    if (!transport) {
      Module['_bl_socket_closed'](id, 0x03);
      return;
    }
    var stream = transport.openTCP(host, port);
    blSockets.streams.set(id, stream);
    stream.onopen = function () {
      Module['_bl_socket_opened'](id);
    };
    stream.ondata = function (data) {
      var pointer = Module['_malloc'](data.length);
      // Kein Speicher mehr: Daten verwerfen hiesse einen kaputten Datenstrom,
      // also die Verbindung mit Fehler beenden
      if (!pointer) {
        blSockets.close(id);
        Module['_bl_socket_closed'](id, 0x03);
        return;
      }
      HEAPU8.set(data, pointer);
      Module['_bl_socket_data'](id, pointer, data.length);
    };
    stream.onsent = function (length) {
      Module['_bl_socket_sent'](id, length);
    };
    stream.onclose = function (reason) {
      blSockets.streams.delete(id);
      Module['_bl_socket_closed'](id, reason);
    };
  },

  send(id, data) {
    var stream = blSockets.streams.get(id);
    if (stream)
      stream.send(data);
  },

  close(id) {
    var stream = blSockets.streams.get(id);
    if (!stream)
      return;
    blSockets.streams.delete(id);
    stream.onclose = null;
    stream.ondata = null;
    stream.onsent = null;
    stream.close();
  },
};
