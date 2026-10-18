// Starts browser-lite-server of @browser-lite/server. Through the package instead of the bin link
// in node_modules/.bin, which npm only creates executable when the package was built before.
// Environment variables: README.md of @browser-lite/server.
await import(new URL('bin/browser-lite-server.js', import.meta.resolve('@browser-lite/server')));
