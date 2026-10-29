/* global process, URL, setTimeout, console */
// Mirrors how Vercel's Node runtime loads a function (@vercel/node dist/bundling-handler.js, compileUserCode):
// it patches http.Server.prototype.listen to capture the server WITHOUT ever calling the listen callback,
// waits for the module to finish evaluating, then uses the default-export (req, res) function if there is one,
// otherwise the captured server. Here the resulting handler is served on argv[2] so a test can call it.
import http from 'node:http';

const port = Number(process.argv[2]);
const entry = new URL('../../src/index.ts', import.meta.url).href;

let captured = null;
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function () {
  captured = this; // eslint-disable-line @typescript-eslint/no-this-alias -- same as Vercel's loader
  http.Server.prototype.listen = originalListen;
  return this;
};

const mod = await Promise.race([
  import(entry),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('module evaluation did not finish within 10s (blocked on listen()?)')), 10_000),
  ),
]).catch((err) => {
  console.error(String(err));
  process.exit(1);
});
http.Server.prototype.listen = originalListen;

let handler = mod.default?.default ?? mod.default;
if (typeof handler !== 'function') {
  if (!captured) {
    console.error('no default-export function and no server captured');
    process.exit(1);
  }
  captured.listen(port, '127.0.0.1');
} else {
  http.createServer(handler).listen(port, '127.0.0.1');
}
