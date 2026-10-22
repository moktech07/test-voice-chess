/**
 * Node-side proof that the UCI protocol handling is correct.
 *
 * The browser build talks to Stockfish inside a Web Worker; Node talks to the
 * very same engine through the `stockfish` npm package. Both sides share the
 * protocol helpers in `src/core/engine-protocol.ts`, so if the handshake,
 * the `position`/`go` commands and the `bestmove` parsing all work here,
 * they work in the worker too.
 *
 * Run with: npx vitest run tests/unit/engine.node.test.ts
 */

import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
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
} from '../../src/core/engine-protocol.ts';

const require = createRequire(import.meta.url);

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/* ------------------------------------------------------------------ */
/* A tiny UCI client that speaks to the real engine in Node.            */
/* ------------------------------------------------------------------ */

interface EngineHandle {
  processCommand: (cmd: string) => void;
  _command?: unknown;
  [key: string]: unknown;
}

type LineListener = (line: string) => void;

class NodeUciEngine {
  private handle: EngineHandle | null = null;
  private lines: string[] = [];
  private listeners: LineListener[] = [];

  async start(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initEngine = require('stockfish');
    this.handle = initEngine('lite-single', (line: string) => this.handleLine(line)) as EngineHandle;

    // The package sets `_command` once the wasm module is up.
    await this.waitFor(
      () => typeof this.handle?._command === 'function',
      30_000,
      'engine never became ready',
    );
  }

  private handleLine(line: string): void {
    this.lines.push(line);
    for (const l of this.listeners) l(line);
  }

  send(command: string): void {
    if (!this.handle) throw new Error('engine not started');
    this.handle.processCommand(command);
  }

  /** Wait until a line matching `predicate` shows up. */
  waitForLine(predicate: (line: string) => boolean, timeoutMs = 30_000): Promise<string> {
    const existing = this.lines.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== listener);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for a matching line`));
      }, timeoutMs);

      const listener: LineListener = (line) => {
        if (!predicate(line)) return;
        clearTimeout(timer);
        this.listeners = this.listeners.filter((l) => l !== listener);
        resolve(line);
      };
      this.listeners.push(listener);
    });
  }

  waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (predicate()) {
          clearInterval(iv);
          resolve();
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(iv);
          reject(new Error(message));
        }
      }, 20);
    });
  }

  get allLines(): string[] {
    return this.lines;
  }

  dispose(): void {
    try {
      this.send(UCI.QUIT);
    } catch {
      /* ignore */
    }
    this.handle = null;
  }
}

/* ------------------------------------------------------------------ */
/* Pure protocol tests (no engine needed)                               */
/* ------------------------------------------------------------------ */

describe('UCI protocol helpers', () => {
  it('parses a normal bestmove', () => {
    expect(parseBestMove('bestmove e2e4')).toEqual({ from: 'e2', to: 'e4' });
  });

  it('parses a promotion', () => {
    expect(parseBestMove('bestmove e7e8q')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    expect(parseBestMove('bestmove a7a8n')).toEqual({ from: 'a7', to: 'a8', promotion: 'n' });
  });

  it('ignores the "no move" sentinel', () => {
    expect(parseBestMove('bestmove 0000')).toBeNull();
  });

  it('rejects nonsense', () => {
    expect(parseBestMove('bestmove')).toBeNull();
    expect(parseBestMove('bestmove xyz')).toBeNull();
    expect(parseBestMove('bestmove e9e4')).toBeNull();
    expect(parseBestMove('info depth 5')).toBeNull();
  });

  it('parses score, depth and pv from an info line', () => {
    const info = parseInfo(
      'info depth 12 seldepth 18 multipv 1 score cp 25 nodes 12345 nps 100000 time 123 pv e2e4 e7e5 g1f3',
    );
    expect(info?.depth).toBe(12);
    expect(info?.scoreCp).toBe(25);
    expect(info?.pv?.[0]).toBe('e2e4');
    expect(info?.pv?.[2]).toBe('g1f3');
  });

  it('parses mate scores', () => {
    const info = parseInfo('info depth 3 score mate 5');
    expect(info?.mateIn).toBe(5);
  });

  it('recognises line kinds', () => {
    expect(isBestMoveLine('bestmove e2e4')).toBe(true);
    expect(isBestMoveLine('  bestmove e2e4')).toBe(true);
    expect(isBestMoveLine('info depth 1')).toBe(false);
    expect(isInfoLine('info depth 1')).toBe(true);
    expect(isInfoLine('bestmove e2e4')).toBe(false);
  });

  it('builds commands', () => {
    expect(positionFenCommand(START_FEN)).toBe(`position fen ${START_FEN}`);
    expect(goDepthCommand(8)).toBe('go depth 8');
    expect(goMovetimeCommand(250)).toBe('go movetime 250');
  });

  it('maps difficulty to depth', () => {
    expect(depthForDifficulty(0)).toBe(2);
    expect(depthForDifficulty(1)).toBe(4);
    expect(depthForDifficulty(2)).toBe(8);
    expect(depthForDifficulty(3)).toBe(12);
    expect(depthForDifficulty(4)).toBe(16);
    /* Out-of-range values are clamped, not thrown. */
    expect(depthForDifficulty(-3)).toBe(2);
    expect(depthForDifficulty(99)).toBe(16);
    expect(clampDifficulty(2.4)).toBe(2);
    expect(clampDifficulty(NaN)).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Tests against the real engine in Node.                               */
/* ------------------------------------------------------------------ */

describe('UCI engine in Node', () => {
  let engine: NodeUciEngine;

  beforeAll(async () => {
    engine = new NodeUciEngine();
    await engine.start();
  }, 60_000);

  afterAll(() => {
    engine?.dispose();
  });

  it('completes the uci handshake', async () => {
    engine.send(UCI.INIT);
    const ok = await engine.waitForLine((l) => l.trim() === UCI.OK);
    expect(ok.trim()).toBe('uciok');

    engine.send(UCI.IS_READY);
    const ready = await engine.waitForLine((l) => l.trim() === UCI.READY_OK);
    expect(ready.trim()).toBe('readyok');
  }, 60_000);

  it('answers a position/go/bestmove sequence', async () => {
    engine.send(UCI.NEW_GAME);
    engine.send(positionFenCommand(START_FEN));
    engine.send(goDepthCommand(8));

    const line = await engine.waitForLine((l) => isBestMoveLine(l));
    const move = parseBestMove(line);
    expect(move).not.toBeNull();
    expect(move!.from).toMatch(/^[a-h][1-8]$/);
    expect(move!.to).toMatch(/^[a-h][1-8]$/);
  }, 60_000);

  it('emits info lines with a score while searching', async () => {
    engine.send(UCI.NEW_GAME);
    engine.send(positionFenCommand(START_FEN));
    engine.send(goDepthCommand(6));

    const infoLine = await engine.waitForLine((l) => isInfoLine(l) && parseInfo(l)?.depth !== undefined);
    const info = parseInfo(infoLine);
    expect(info?.depth).toBeGreaterThan(0);
  }, 60_000);

  it('produces a legal opening move from the start position', async () => {
    engine.send(UCI.NEW_GAME);
    engine.send(positionFenCommand(START_FEN));
    engine.send(goDepthCommand(10));

    const line = await engine.waitForLine((l) => isBestMoveLine(l));
    const move = parseBestMove(line);
    expect(move).not.toBeNull();

    /* Sanity-check with chess.js that the move is legal. */
    const { Chess } = require('chess.js');
    const chess = new Chess();
    const applied = chess.move({ from: move!.from, to: move!.to, promotion: move!.promotion });
    expect(applied).toBeTruthy();
    expect(applied.san).toBeTruthy();
  }, 60_000);

  it('responds to "stop" with a bestmove', async () => {
    engine.send(UCI.NEW_GAME);
    engine.send(positionFenCommand(START_FEN));
    /* A deep search so that "stop" actually interrupts something. */
    engine.send('go depth 60');

    /* Wait until the engine is really searching, then stop it. */
    await engine.waitFor(
      () => engine.allLines.some((l) => isInfoLine(l) && (parseInfo(l)?.depth ?? 0) >= 1),
      30_000,
      'engine never started searching',
    );
    engine.send(UCI.STOP);

    const line = await engine.waitForLine((l) => isBestMoveLine(l));
    const move = parseBestMove(line);
    expect(move).not.toBeNull();
  }, 60_000);

  it('answers "isready" again after a search', async () => {
    engine.send(UCI.IS_READY);
    const ready = await engine.waitForLine((l) => l.trim() === UCI.READY_OK);
    expect(ready.trim()).toBe('readyok');
  }, 60_000);
});
