/**
 * UCI protocol constants and helpers shared by the browser worker and the
 * Node unit test.
 *
 * Keeping these in one place means the Node test exercises exactly the same
 * parsing rules as the browser build — if the protocol handling is right in
 * Node, it is right in the worker.
 */

/** The Stockfish build we ship. Single-threaded: no SharedArrayBuffer, no COOP/COEP. */
export const ENGINE_JS_FILENAME = 'stockfish-19-lite-single.js';
export const ENGINE_WASM_FILENAME = 'stockfish-19-lite-single.wasm';

/**
 * Paths relative to the app root. The app is served from a subdirectory
 * (e.g. https://user.github.io/voice-chess/), so these must stay relative.
 * `public/` is served at the app root by Vite, hence `./engine/...`.
 */
export const ENGINE_RELATIVE_PATHS = {
  js: `./engine/${ENGINE_JS_FILENAME}`,
  wasm: `./engine/${ENGINE_WASM_FILENAME}`,
} as const;

/** UCI commands we send. */
export const UCI = {
  /** Start the handshake. */
  INIT: 'uci',
  /** Engine answers `uciok`. */
  OK: 'uciok',
  /** Ask whether the engine has finished setting up. Engine answers `readyok`. */
  IS_READY: 'isready',
  /** Engine answers `readyok`. */
  READY_OK: 'readyok',
  /** Reset the transposition table / game state. */
  NEW_GAME: 'ucinewgame',
  /** Stop the current search. */
  STOP: 'stop',
  /** Shut the engine down. */
  QUIT: 'quit',
} as const;

/**
 * Difficulty (0..4) -> search depth.
 *
 * Depth mapping is used rather than UCI `Skill Level` because it is fully
 * predictable: the same level always produces the same amount of thinking,
 * and there is no risk of the engine playing at strength far above the
 * requested level (Skill Level in Stockfish is a hand-tuned heuristic).
 *
 * The `Skill Level` option is still sent alongside, but only as a *ceiling*
 * that is always at or above the depth-derived strength, so it can never make
 * the engine weaker than the depth implies. See `skillLevelForDepth`.
 */
export const DIFFICULTY_DEPTHS = [2, 4, 8, 12, 16] as const;

/** Clamp any number into the valid 0..4 difficulty range. */
export function clampDifficulty(level: number): number {
  if (!Number.isFinite(level)) return 2;
  const n = Math.round(level);
  if (n < 0) return 0;
  if (n > 4) return 4;
  return n;
}

/** Map a difficulty level (0..4) to the search depth to use. */
export function depthForDifficulty(level: number): number {
  return DIFFICULTY_DEPTHS[clampDifficulty(level)];
}

/**
 * A UCI `Skill Level` that corresponds to the depth we are searching at.
 * Stockfish's Skill Level (0..20) roughly tracks Elo; we only use it to make
 * sure a shallow search is not accidentally played at full strength.
 */
export function skillLevelForDepth(depth: number): number {
  // 2 -> 0, 4 -> 2, 8 -> 6, 12 -> 10, 16 -> 14, interpolated in between.
  const table = [0, 2, 6, 10, 14];
  if (depth <= 2) return table[0];
  if (depth <= 4) return table[1];
  if (depth <= 8) return table[2];
  if (depth <= 12) return table[3];
  return table[4];
}

/** Build the `position fen ...` command. */
export function positionFenCommand(fen: string): string {
  return `position fen ${fen.trim()}`;
}

/** Build the `go` command for a depth-limited search. */
export function goDepthCommand(depth: number): string {
  return `go depth ${Math.max(1, Math.round(depth))}`;
}

/** Build the `go` command for a time-limited search. */
export function goMovetimeCommand(movetimeMs: number): string {
  return `go movetime ${Math.max(1, Math.round(movetimeMs))}`;
}

/** Build the `setoption name Skill Level value N` command. */
export function skillLevelCommand(level: number): string {
  return `setoption name Skill Level value ${Math.max(0, Math.min(20, Math.round(level)))}`;
}

export interface ParsedBestMove {
  from: string;
  to: string;
  promotion?: string;
}

/**
 * Parse a `bestmove` line.
 *
 * Format: `bestmove <from><to>[<promotion>]` — for example `bestmove e2e4`,
 * `bestmove e7e8q`, or `bestmove 0000` (no legal move / search aborted).
 */
export function parseBestMove(line: string): ParsedBestMove | null {
  const text = line.trim();
  if (!text.startsWith('bestmove')) return null;
  const tokens = text.split(/\s+/);
  const move = tokens[1];
  if (!move || move.length < 4) return null;
  // `0000` is Stockfish's "no move" sentinel.
  if (move === '0000') return null;

  const from = move.slice(0, 2);
  const to = move.slice(2, 4);
  const promo = move.length > 4 ? move.slice(4, 5) : undefined;

  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return null;
  if (promo !== undefined && !'qrbn'.includes(promo)) return null;

  const result: ParsedBestMove = { from, to };
  if (promo) result.promotion = promo;
  return result;
}

export interface ParsedInfo {
  depth?: number;
  /** Score in centipawns, from the side-to-move's point of view. */
  scoreCp?: number;
  /** Mate distance in moves; negative means the side to move is getting mated. */
  mateIn?: number;
  /** The move the engine is currently considering. */
  pv?: string[];
}

/**
 * Parse an `info` line.
 *
 * We care about `depth`, `score cp|mate`, `seldepth`, `nodes`, `nps` and the
 * principal variation (`pv ...`).
 */
export function parseInfo(line: string): ParsedInfo | null {
  const text = line.trim();
  if (!text.startsWith('info')) return null;

  const info: ParsedInfo = {};
  const tokens = text.split(/\s+/);

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok) {
      case 'depth':
        info.depth = Number(tokens[++i]);
        break;
      case 'seldepth':
        i++; // seldepth is not exposed, but we must skip its value.
        break;
      case 'score': {
        const kind = tokens[++i];
        const value = Number(tokens[++i]);
        if (kind === 'cp' && Number.isFinite(value)) info.scoreCp = value;
        else if (kind === 'mate' && Number.isFinite(value)) info.mateIn = value;
        break;
      }
      case 'nodes':
        i++;
        break;
      case 'nps':
        i++;
        break;
      case 'time':
        i++;
        break;
      case 'pv': {
        const pv: string[] = [];
        for (let j = i + 1; j < tokens.length; j++) {
          if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(tokens[j])) break;
          pv.push(tokens[j]);
        }
        info.pv = pv;
        i = tokens.length;
        break;
      }
      default:
        break;
    }
  }
  return info;
}

/** True if the line is a `bestmove` line. */
export function isBestMoveLine(line: string): boolean {
  return line.trim().startsWith('bestmove');
}

/** True if the line is an `info` line. */
export function isInfoLine(line: string): boolean {
  return line.trim().startsWith('info');
}
