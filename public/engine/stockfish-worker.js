/*
 * Web Worker shim for the Stockfish 19 "lite-single" build.
 *
 * This file is served verbatim from public/engine/ (Vite copies public/ to the
 * app root), so it always sits in the same directory as the engine bundle and
 * the wasm binary. Everything it loads is resolved RELATIVE to its own URL,
 * which is what makes a subdirectory deploy (https://user.github.io/voice-chess/)
 * work without any absolute paths.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BOOTSTRAP NEEDS A SHIM AT ALL
 * ---------------------------------------------------------------------------
 * public/engine/stockfish-19-lite-single.js is an Emscripten UMD bundle that
 * runs on load and picks a bootstrap branch from the global scope
 * (beautified from the bundle):
 *
 *   "undefined" != typeof onmessage && ("undefined" == typeof window || void 0 === window.document)
 *     || "undefined" != typeof global && "[object process]" === Object.prototype.toString.call(global.process)
 *     ? (function () { /* WORKER / NODE BOOTSTRAP *\/ })()
 *     : "object" == typeof document && document.currentScript
 *       ? document.currentScript._exports = e()
 *       : e();
 *
 * The worker branch is the one that speaks UCI over postMessage:
 *
 *   i = { locateFile: ..., listener: function (e) { postMessage(e) } }
 *
 *   onmessage || (onmessage = function (e) {
 *     if ("setoption name CanOutputEngineDownloadProgress" === e.data) postMessage("info WillOutputEngineDownloadProgress");
 *     else if (e.data.progressPort) n = e.data.progressPort;
 *     else if (i.processCommand ? i.processCommand(e.data) : s.push(e.data),
 *              "quit" === e.data) try { self.close() } catch (e) {}
 *   })
 *
 * So: exactly one UCI command per message in, one UCI output line per
 * message out. The shim's only job is to get the bundle to take that branch
 * and to point it at the right .wasm file.
 *
 * ---------------------------------------------------------------------------
 * FORCING THE WORKER BRANCH
 * ---------------------------------------------------------------------------
 * The branch test is `"undefined" != typeof onmessage`. In a browser Worker
 * `onmessage` is an IDL attribute of WorkerGlobalScope, so it already reads as
 * "object" (null) — but we set it explicitly to null first anyway so the
 * branch is taken on every engine. Because `null` is falsy, the bundle's own
 * `onmessage || (onmessage = function (e) {...})` fallback still installs the
 * real UCI handler.
 *
 * ---------------------------------------------------------------------------
 * FINDING THE .wasm FILE
 * ---------------------------------------------------------------------------
 * The bundle resolves its wasm from the worker URL's hash:
 *
 *   a = self.location.hash.substr(1).split(","),
 *   t = decodeURIComponent(a[0] || location.origin + location.pathname.replace(/\.js$/i, ".wasm")),
 *
 *   i = { locateFile: function (e) {
 *         return e.indexOf(".wasm") > -1 ? e.indexOf(".wasm.map") > -1 ? t + ".map" : r || t
 *                                        : self.location.href
 *       }, ... }
 *
 * The `r ||` fallback is the (unset) argument of that IIFE, so `t` is always
 * the wasm URL. `t` is then handed straight to `fetch()` by the bundle's own
 * `instantiateWasm` override, so `locateFile` is never consulted for the
 * binary.
 *
 * We therefore pass the wasm URL in BOTH the worker's query string and the
 * worker's hash:
 *
 *   - the hash is the bundle's own documented mechanism, so on a browser that
 *     preserves the fragment of a worker URL it just works;
 *   - the query string is always preserved, and the fetch shim below uses it
 *     to rewrite any `.wasm` request, so it works even when the fragment is
 *     dropped.
 *
 * The fetch shim also forces the `application/wasm` content type, because
 * `WebAssembly.instantiateStreaming()` refuses anything else and the
 * engine's loader does not fall back to ArrayBuffer instantiation.
 */

/* eslint-disable no-var */
(function () {
  'use strict';

  var here = self.location.href;

  /* ---------------------------------------------------------------- */
  /* Where are the engine files?                                       */
  /* ---------------------------------------------------------------- */

  var params = new URLSearchParams(self.location.search);

  /* The bundle parses the hash itself as `hash[0] = wasm`, `hash[1] = engine`. */
  var hashParts = self.location.hash.replace(/^#/, '').split(',');
  var hashWasm = hashParts.length > 0 ? decodeURIComponent(hashParts[0] || '') : '';
  var hashEngine = hashParts.length > 1 ? decodeURIComponent(hashParts[1] || '') : '';

  var engineUrl =
    params.get('engine') ||
    hashEngine ||
    new URL('./stockfish-19-lite-single.js', here).toString();

  var wasmUrl =
    params.get('wasm') ||
    hashWasm ||
    new URL('./stockfish-19-lite-single.wasm', here).toString();

  /* ---------------------------------------------------------------- */
  /* Make sure the engine fetches the right .wasm                       */
  /* ---------------------------------------------------------------- */

  var originalFetch = self.fetch ? self.fetch.bind(self) : null;

  if (originalFetch) {
    self.fetch = function (input, init) {
      var raw;
      try {
        raw = typeof input === 'string' ? input : (input && input.url) || String(input);
      } catch (e) {
        return originalFetch(input, init);
      }

      var url;
      try {
        url = new URL(raw, here);
      } catch (e) {
        return originalFetch(input, init);
      }

      var isWasm = /\.wasm$/i.test(url.pathname);
      var isWasmMap = /\.wasm\.map$/i.test(url.pathname);

      if (isWasm && url.toString() !== wasmUrl) {
        url = new URL(wasmUrl, here);
      }

      return originalFetch(url.toString(), init).then(function (res) {
        if (!isWasm && !isWasmMap) return res;
        /* WebAssembly.instantiateStreaming() insists on the right MIME type,
           and the engine's own loader does not fall back to ArrayBuffer. */
        var headers = new Headers(res.headers);
        if (!/application\/wasm/i.test(headers.get('content-type') || '')) {
          headers.set('content-type', 'application/wasm');
        }
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: headers,
        });
      });
    };
  }

  /* ---------------------------------------------------------------- */
  /* Load the engine                                                   */
  /* ---------------------------------------------------------------- */

  /* Force the worker bootstrap branch of the bundle (see the note above). */
  try {
    self.onmessage = null;
  } catch (e) {
    /* ignore */
  }

  try {
    importScripts(engineUrl);
  } catch (err) {
    self.postMessage({
      __vcWorkerError: true,
      message:
        'Failed to load the chess engine script "' +
        engineUrl +
        '": ' +
        (err && err.message ? err.message : String(err)),
    });
    throw err;
  }

  /* If the bundle did not install its UCI handler we would never hear from
     the engine, so fail loudly instead of hanging forever. */
  if (typeof self.onmessage !== 'function') {
    self.postMessage({
      __vcWorkerError: true,
      message:
        'The chess engine script loaded but did not install its UCI handler. ' +
        'It has to be loaded inside a Web Worker.',
    });
  }
})();
