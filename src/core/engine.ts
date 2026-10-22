/**
 * Stockfish engine wrapper.
 *
 * The engine is the `stockfish-19-lite-single` build: single-threaded, so it
 * needs neither SharedArrayBuffer nor cross-origin isolation (COOP/COEP).
 * That is essential because GitHub Pages cannot send those headers, and this
 * app has to work when served from a project subdirectory.
 *
 * The engine runs inside a Web Worker so a long search never blocks the UI
 * (and therefore never stutters speech synthesis or the microphone).
 *
 * BOOTSTRAP CONTRACT (discovered by reading the engine bundle)
 * -------------------------------------------------------------
 * `public/engine/stockfish-19-lite-single.js` is an Emscripten UMD bundle that
 * runs on load and picks a bootstrap branch from the global scope:
 *
 *   "undefined" != typeof onmessage && ("undefined" == typeof window || void 0 === window.document)
 *     || "undefined" != typeof global && "[object process]" === Object.prototype.toString.call(global.process)
 *     ? (function () { /* worker / node bootstrap *\/ })()
 *     : "object" == typeof document && document.currentScript
 *       ? document.currentScript._exports = e()
 *       : e();
 *
 * The worker branch is the one that speaks UCI over `postMessage`:
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
 * message out. The `location.hash` of the worker URL is how the bundle finds
 * its .wasm file:
 *
 *   a = self.location.hash.substr(1).split(","),
 *   t = decodeURIComponent(a[0] || location.origin + location.pathname.replace(/\.js$/i, ".wasm")),
 *   i = { locateFile: function (e) {
 *         return e.indexOf(".wasm") > -1 ? e.indexOf(".wasm.map") > -1 ? t + ".map" : r || t
 *                                        : self.location.href
 *       }, ... }
 *
 * `public/engine/stockfish-worker.js` is a thin shim that loads the bundle
 * inside a Worker scope and makes sure the .wasm is fetched from the right
 * place. See that file for the full reasoning.
 */

import {
  ENGINE_RELATIVE_PATHS,
  UCI,
  clampDifficulty,
  depthForDifficulty,
  goDepthCommand,
  goMovetimeCommand,
  isBestMoveLine,
  isInfoLine,
  parseBestMove,
  parseInfo,
  positionFenCommand,
} from './engine-protocol.ts';
import type { ParsedInfo } from './engine-protocol.ts';
import type { Engine, EngineMove } from './types.ts';

/**
 * The files this app ships. All paths are RELATIVE so the app works when it
 * is served from a subdirectory (e.g. https://user.github.io/voice-chess/).
 */
export const ENGINE_FILES = {
  /** The Emscripten UMD bundle, copied from node_modules/stockfish/bin. */
  js: ENGINE_RELATIVE_PATHS.js,
  /** The single-threaded "lite" wasm binary (≈1.8 MB). */
  wasm: ENGINE_RELATIVE_PATHS.wasm,
  /** The thin worker shim that loads the bundle inside a Worker scope. */
  worker: './engine/stockfish-worker.js',
} as const;

/** Where the worker shim lives, relative to the app root. */
const WORKER_RELATIVE_PATH = './engine/stockfish-worker.js';

export interface EngineOptions {
  /** URL of the Emscripten bundle. Defaults to `./engine/stockfish-19-lite-single.js`. */
  engineUrl?: string;
  /** URL of the wasm binary. Defaults to `./engine/stockfish-19-lite-single.wasm`. */
  wasmUrl?: string;
  /** URL of the worker shim. Defaults to `./engine/stockfish-worker.js`. */
  workerUrl?: string;
  /** Milliseconds to wait for `uciok` / `readyok` during init. Default 30 s. */
  initTimeoutMs?: number;
  /** Milliseconds after which a running search is stopped. Default 60 s. */
  searchTimeoutMs?: number;
}

/** Resolve a relative path against the document base (subdirectory-safe). */
function resolveAgainstDocument(rel: string): string {
  const base =
    typeof document !== 'undefined' && document.baseURI
      ? document.baseURI
      : typeof location !== 'undefined'
        ? location.href
        : undefined;
  if (!base) return rel;
  try {
    return new URL(rel, base).toString();
  } catch {
    return rel;
  }
}

/** A promise with externally accessible settle functions. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ActiveSearch {
  deferred: Deferred<EngineMove>;
  timer: ReturnType<typeof setTimeout> | null;
}

export class StockfishEngine implements Engine {
  /**
   * Called for every `info` line the engine prints. Optional: the `Engine`
   * contract does not require it, but it is handy for difficulty feedback
   * (e.g. showing how bad the engine's score is).
   */
  onInfo?: (info: ParsedInfo) => void;

  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private isReady = false;
  private isDisposed = false;
  private difficulty = 2;

  private active: ActiveSearch | null = null;

  /** Pending handshake resolvers. */
  private waitForUciOk: (() => void) | null = null;
  private waitForReadyOk: (() => void) | null = null;

  private readonly engineUrl: string;
  private readonly wasmUrl: string;
  private readonly workerUrl: string;
  private readonly initTimeoutMs: number;
  private readonly searchTimeoutMs: number;

  constructor(opts: EngineOptions = {}) {
    this.engineUrl = resolveAgainstDocument(opts.engineUrl ?? ENGINE_FILES.js);
    this.wasmUrl = resolveAgainstDocument(opts.wasmUrl ?? ENGINE_FILES.wasm);
    this.workerUrl = resolveAgainstDocument(opts.workerUrl ?? WORKER_RELATIVE_PATH);
    this.initTimeoutMs = opts.initTimeoutMs ?? 30_000;
    this.searchTimeoutMs = opts.searchTimeoutMs ?? 60_000;
  }

  /** True once init() has resolved. */
  get ready(): boolean {
    return this.isReady;
  }

  /** The absolute URL of the Emscripten bundle that will be loaded. */
  get resolvedEngineUrl(): string {
    return this.engineUrl;
  }

  /** The absolute URL of the wasm binary that will be fetched. */
  get resolvedWasmUrl(): string {
    return this.wasmUrl;
  }

  /** The absolute URL of the worker script. */
  get resolvedWorkerUrl(): string {
    return this.workerUrl;
  }

  /** The current difficulty level (0..4). */
  get level(): number {
    return this.difficulty;
  }

  /**
   * Start the worker, load the engine and complete the UCI handshake.
   *
   * Resolves only after `uci` -> `uciok` and `isready` -> `readyok`.
   * Rejects if the worker or the wasm fails to load, or on timeout.
   */
  init(): Promise<void> {
    if (this.isDisposed) {
      return Promise.reject(new Error('Engine has been disposed.'));
    }
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.cleanupHandshake();
        try {
          this.worker?.terminate();
        } catch {
          /* ignore */
        }
        this.worker = null;
        this.initPromise = null;
        reject(new Error(message));
      };

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.cleanupHandshake();
        this.isReady = true;
        resolve();
      };

      timer = setTimeout(() => {
        fail(
          `Timed out after ${this.initTimeoutMs} ms waiting for the chess engine to start. ` +
            `Is ${this.engineUrl} reachable?`,
        );
      }, this.initTimeoutMs);

      let worker: Worker;
      try {
        worker = this.createWorker();
      } catch (err) {
        fail(`Could not start the chess engine worker: ${errText(err)}`);
        return;
      }
      this.worker = worker;

      worker.addEventListener('message', (event: MessageEvent) => {
        this.handleWorkerMessage(event.data);
      });
      worker.addEventListener('error', (event: ErrorEvent) => {
        fail(`The chess engine worker failed: ${event.message || 'unknown error'}`);
      });
      worker.addEventListener('messageerror', () => {
        fail('The chess engine worker sent a message that could not be deserialised.');
      });

      /* --- UCI handshake ------------------------------------------- */
      /* `uciok` -> ask whether the engine has finished setting up;
         `readyok` -> we are good to search. */
      this.waitForUciOk = () => {
        this.send(UCI.IS_READY);
        this.waitForReadyOk = succeed;
      };
      this.waitForReadyOk = succeed;

      this.send(UCI.INIT);
    });

    return this.initPromise;
  }

  /**
   * Set the difficulty (0..4).
   *
   * We map the level to a fixed search depth:
   *
   *   0 -> depth 2    1 -> depth 4    2 -> depth 8    3 -> depth 12    4 -> depth 16
   *
   * Depth mapping is used INSTEAD of UCI `setoption name Skill Level value N`
   * on purpose: depth is completely predictable (the same level always does
   * the same amount of thinking) whereas Skill Level is a hand-tuned
   * heuristic whose strength varies a lot with the position — a low Skill
   * Level can make Stockfish play randomly bad moves that do not even respect
   * the depth we asked for, and it can miss an obvious mate. We therefore do
   * not send Skill Level at all.
   */
  setDifficulty(level: number): void {
    this.difficulty = clampDifficulty(level);
  }

  /**
   * Search for the best move in the given position.
   *
   * Resolves with `{ from, to, promotion? }`. If a search is already running
   * it is stopped first and we wait for its `bestmove` before issuing the
   * new commands — sending `position` while the engine is searching would
   * corrupt the running search.
   */
  async search(fen: string, opts?: { depth?: number; movetimeMs?: number }): Promise<EngineMove> {
    if (this.isDisposed) throw new Error('Engine has been disposed.');
    if (!this.isReady) {
      throw new Error('Engine is not ready: await init() before searching.');
    }

    /* Stop a running search and wait for its bestmove, so the `position`
       command below cannot be applied to the wrong position. */
    if (this.active) {
      const previous = this.active;
      this.send(UCI.STOP);
      try {
        await previous.deferred.promise;
      } catch {
        /* the previous search failed; we are starting a fresh one anyway */
      }
      if (this.active === previous) this.active = null;
    }

    const depth = opts?.depth ?? depthForDifficulty(this.difficulty);
    const goCommand =
      opts?.movetimeMs !== undefined
        ? goMovetimeCommand(opts.movetimeMs)
        : goDepthCommand(depth);

    this.send(UCI.NEW_GAME);
    this.send(positionFenCommand(fen));

    const d = deferred<EngineMove>();
    const search: ActiveSearch = { deferred: d, timer: null };
    this.active = search;

    if (this.searchTimeoutMs > 0) {
      search.timer = setTimeout(() => {
        /* The engine is taking too long — ask it to stop; the bestmove it
           returns then resolves this search. */
        this.send(UCI.STOP);
      }, this.searchTimeoutMs);
    }

    this.send(goCommand);

    return d.promise;
  }

  /**
   * Stop the running search. The pending `search()` promise resolves with
   * the `bestmove` the engine emits in response.
   */
  stop(): void {
    if (!this.worker) return;
    this.send(UCI.STOP);
  }

  /** Shut the engine down and release the worker. */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.isReady = false;

    if (this.active) {
      const active = this.active;
      this.active = null;
      if (active.timer) clearTimeout(active.timer);
      active.deferred.reject(new Error('Engine disposed while searching.'));
    }

    if (this.worker) {
      try {
        this.send(UCI.QUIT);
      } catch {
        /* the worker may already be gone */
      }
      try {
        this.worker.terminate();
      } catch {
        /* ignore */
      }
      this.worker = null;
    }

    this.cleanupHandshake();
    this.initPromise = null;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  private createWorker(): Worker {
    /*
     * The engine bundle resolves its wasm from the worker's location hash
     * (`hash[0]` = wasm URL, `hash[1]` = engine bundle URL) — see the note
     * at the top of this file. We ALSO pass both URLs in the query string,
     * because the query string of a worker URL is always preserved while the
     * fragment is not guaranteed to be, and the worker shim prefers it.
     *
     * The comma between the two hash segments must stay a literal comma (the
     * bundle splits the raw hash on ","), so each URL is percent-encoded
     * individually.
     */
    const hash = `${encodeURIComponent(this.wasmUrl)},${encodeURIComponent(this.engineUrl)}`;
    const url = new URL(this.workerUrl);
    url.searchParams.set('engine', this.engineUrl);
    url.searchParams.set('wasm', this.wasmUrl);
    url.hash = hash;
    return new Worker(url.toString());
  }

  private send(command: string): void {
    if (!this.worker) return;
    this.worker.postMessage(command);
  }

  private cleanupHandshake(): void {
    this.waitForUciOk = null;
    this.waitForReadyOk = null;
  }

  private handleWorkerMessage(data: unknown): void {
    if (typeof data !== 'string') {
      /* Our worker shim reports structured failures. */
      if (data && typeof data === 'object') {
        const rec = data as { __vcWorkerError?: boolean; message?: string };
        if (rec.__vcWorkerError) {
          throw new Error(rec.message ?? 'The chess engine worker failed to start.');
        }
      }
      return;
    }

    const line = data.replace(/\r?\n/g, '').trim();
    if (!line) return;

    if (line === UCI.OK) {
      this.waitForUciOk?.();
      this.waitForUciOk = null;
      return;
    }
    if (line === UCI.READY_OK) {
      this.waitForReadyOk?.();
      this.waitForReadyOk = null;
      return;
    }

    if (isBestMoveLine(line)) {
      const move = parseBestMove(line);
      if (!move) return;
      const active = this.active;
      if (!active) return;
      this.active = null;
      if (active.timer) clearTimeout(active.timer);
      active.deferred.resolve(move);
      return;
    }

    if (isInfoLine(line)) {
      const info = parseInfo(line);
      if (info && this.onInfo) {
        try {
          this.onInfo(info);
        } catch {
          /* a broken listener must not break the engine */
        }
      }
    }
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Convenience factory. */
export function createEngine(opts?: EngineOptions): Engine {
  return new StockfishEngine(opts);
}

export type { ParsedInfo };
export default StockfishEngine;
