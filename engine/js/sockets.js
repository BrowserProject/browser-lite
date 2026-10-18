// Sockets of the engine (engine/src/Sockets.cpp), the part on the main thread.
//
// The C++ side sends asynchronously: open a connection, send data, close. The
// connections go through the host's transport (Module.blTransport, the public
// Transport: openTCP(host, port) returns a stream with send, close, onopen,
// ondata, onsent, onclose). Incoming data is written directly into the engine
// memory (_bl__socket_data), what the transport really sent is reported back
// (_bl__socket_sent).

// CloseReason strings of the transport, the index is the enum of Sockets.cpp
var blCloseReasons = ['closed', 'reset', 'refused', 'unreachable', 'name-not-resolved', 'timeout', 'blocked', 'throttled', 'invalid', 'transport-down'];
var blCloseReset = 1;
var blCloseTransportDown = 9;

var blSockets = {
  streams: new Map(),

  open(id, host, port) {
    var transport = Module['blTransport'];
    if (!transport) {
      Module['_bl__socket_closed'](id, blCloseTransportDown);
      return;
    }
    var stream = transport.openTCP(host, port);
    blSockets.streams.set(id, stream);
    stream.onopen = function () {
      Module['_bl__socket_opened'](id);
    };
    stream.ondata = function (data) {
      var pointer = Module['_malloc'](data.length);
      // No memory left: dropping data would mean a broken stream, so end the
      // connection with an error
      if (!pointer) {
        blSockets.close(id);
        Module['_bl__socket_closed'](id, blCloseReset);
        return;
      }
      HEAPU8.set(data, pointer);
      Module['_bl__socket_data'](id, pointer, data.length);
    };
    stream.onsent = function (length) {
      Module['_bl__socket_sent'](id, length);
    };
    stream.onclose = function (reason) {
      blSockets.streams.delete(id);
      var code = blCloseReasons.indexOf(reason);
      Module['_bl__socket_closed'](id, code < 0 ? blCloseReset : code);
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
    stream.onopen = null;
    stream.onclose = null;
    stream.ondata = null;
    stream.onsent = null;
    stream.close();
  },

  closeAll() {
    for (var id of Array.from(blSockets.streams.keys()))
      blSockets.close(id);
  },
};
