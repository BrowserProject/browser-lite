// Wird vor den generierten Emscripten-Code gesetzt (--pre-js).
// Laeuft im Haupt-Thread UND in jedem Worker. Die eigentliche Browser-UI liegt
// in web/ und setzt Module.onEngineReady, onEngineEvent, onEngineFrame,
// onEngineNeedsFrame und engineDialog.
if (typeof Module === 'undefined')
  var Module = {};
