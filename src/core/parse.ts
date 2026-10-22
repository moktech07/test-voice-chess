/**
 * Speech parsing for the voice-chess PWA.
 *
 * Turns a messy, spoken utterance into a (deliberately loose) `Intent`.
 * The resolver downstream is responsible for filling in `from` / `piece`
 * when the player did not say them.
 *
 * Everything in here is defensive: the parser never throws and returns
 * `null` for anything it cannot make sense of.
 */

import type {
  CommandIntent,
  CommandKind,
  Intent,
  MoveIntent,
  PieceType,
} from './types.ts';

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * Words that name a piece -> piece type.
 *
 * "eight" is here because "promote to eight" is the classic spoken pun for
 * promoting to a rook. It only ever reaches the promotion slot, because
 * `normalizeSpeech` turns it into the digit 8 whenever it sits next to a
 * file letter (i.e. when it means rank 8).
 */
const PIECE_WORDS: Record<string, PieceType> = {
  pawn: 'p',
  knight: 'n',
  night: 'n',
  nite: 'n',
  bishop: 'b',
  bishup: 'b',
  rook: 'r',
  rock: 'r',
  queen: 'q',
  quean: 'q',
  king: 'k',
  eight: 'r',
};

/** Single letters that name a piece on their own ("n", "q", ...). */
const PIECE_LETTERS = new Set<string>(['p', 'n', 'b', 'r', 'q', 'k']);

/**
 * File letters that speech engines like to spell out.
 * Only expanded when they sit next to a rank (see `normalizeSpeech`).
 */
const FILE_WORDS: Record<string, string> = {
  ay: 'a',
  eh: 'a',
  be: 'b',
  bee: 'b',
  see: 'c',
  sea: 'c',
  cee: 'c',
  dee: 'd',
  ef: 'f',
  eff: 'f',
  gee: 'g',
  jee: 'g',
  aitch: 'h',
  hatch: 'h',
  age: 'h',
};

/** Rank words that are always safe to turn into digits. */
const RANK_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  won: '1',
  wont: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
};

/**
 * Rank words that are only a rank when a file letter sits next to them.
 * "to" is the preposition far more often than it is the number two.
 */
const CONTEXT_RANK_WORDS: Record<string, string> = {
  ate: '8',
  for: '4',
  fore: '4',
  to: '2',
  too: '2',
};

/** Irregular inflections collapsed onto a canonical token. */
const WORD_FIXUPS: Record<string, string> = {
  whats: 'what',
  hows: 'how',
  wheres: 'where',
  lets: 'let',
  too: 'to',
  commands: 'command',
  boards: 'board',
  scores: 'score',
  levels: 'level',
  kings: 'king',
  queens: 'queen',
  knights: 'knight',
  bishops: 'bishop',
  rooks: 'rook',
  pawns: 'pawn',
  takes: 'take',
  taking: 'take',
  captured: 'capture',
  captures: 'capture',
  capturing: 'capture',
  moves: 'move',
  moving: 'move',
  went: 'go',
  goes: 'go',
  going: 'go',
  promoting: 'promote',
  promotions: 'promote',
  promotes: 'promote',
  castles: 'castle',
  castled: 'castle',
  castling: 'castle',
};

/** Words that are pure noise and can be dropped. */
const FILLER_WORDS = new Set<string>([
  'please',
  'okay',
  'ok',
  'um',
  'uh',
  'so',
  'now',
  'i',
  'want',
  'play',
  'the',
  'a',
  'an',
  'my',
  'just',
  'really',
  'maybe',
  'actually',
  'er',
  'hmm',
  'let',
  'me',
  'us',
  'well',
  'yeah',
  'hey',
  'and',
  'then',
  'x',
]);

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isFileLetter(word: string | undefined): boolean {
  return !!word && /^[a-h]$/.test(word);
}

/** A token that could stand in for a file letter ("e", "bee", "ef", ...). */
function isFileish(word: string | undefined): boolean {
  if (!word) return false;
  return isFileLetter(word) || Object.prototype.hasOwnProperty.call(FILE_WORDS, word);
}

/** A token that could stand in for a rank ("4", "four", "ate", ...). */
function isRankish(word: string | undefined): boolean {
  if (!word) return false;
  if (/^[0-9]$/.test(word)) return true;
  return (
    Object.prototype.hasOwnProperty.call(RANK_WORDS, word) ||
    Object.prototype.hasOwnProperty.call(CONTEXT_RANK_WORDS, word)
  );
}

/** True when the token could be the start of a square ("e", "e4", "4", "bee"). */
function startsSquare(token: string | undefined): boolean {
  if (!token) return false;
  if (/^[a-h][1-8]$/.test(token)) return true;
  if (/^[a-h]$/.test(token)) return true;
  if (/^[1-8]$/.test(token)) return true;
  return isFileish(token);
}

function includesToken(tokens: string[], word: string): boolean {
  return tokens.indexOf(word) >= 0;
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Lower-cases, strips punctuation and expands the homophones that speech
 * engines like to produce.
 *
 *   "E-4"             -> "e 4"
 *   "e four"          -> "e 4"
 *   "knight ef three" -> "knight f 3"
 *   "e for"           -> "e 4"     (only with a file letter nearby)
 *   "e to"            -> "e 2"     (only with a file letter nearby)
 *   "e ate"           -> "e 8"     (only with a file letter nearby)
 *   "rank four"       -> "4"
 *   "e4 x f5"         -> "e 4 x f 5"
 */
export function normalizeSpeech(text: string): string {
  if (typeof text !== 'string') return '';

  let flat = text.toLowerCase().replace(/['‘’`]/g, '');
  flat = flat.replace(/[^a-z0-9]+/g, ' ').trim();
  if (!flat) return '';

  // Multi-word filler phrases that survive tokenisation.
  flat = flat.replace(/\b(let|lets)\s+go\b/g, ' ').trim();
  if (!flat) return '';

  let tokens = flat.split(/\s+/).filter(Boolean);
  tokens = tokens.map((w) => WORD_FIXUPS[w] ?? w);

  // Split a glued file letter + rank word ("efour" -> "e four") and a
  // glued square ("f3" -> "f 3") so the rest of the pipeline sees the
  // file and the rank as separate tokens.
  const split: string[] = [];
  for (const token of tokens) {
    const wordSplit = /^([a-h])(one|two|three|four|five|six|seven|eight|won|wont|ate|for)$/.exec(
      token,
    );
    if (wordSplit) {
      split.push(wordSplit[1], wordSplit[2]);
      continue;
    }
    const squareSplit = /^([a-h])([1-8])$/.exec(token);
    if (squareSplit) {
      split.push(squareSplit[1], squareSplit[2]);
      continue;
    }
    split.push(token);
  }
  tokens = split;

  // "rank four" -> "4": the word "rank" is only a label.
  const withoutRank: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'rank') {
      const next = tokens[i + 1];
      if (next !== undefined) {
        if (/^[1-8]$/.test(next)) continue; // drop "rank"
        if (RANK_WORDS[next]) {
          withoutRank.push(RANK_WORDS[next]);
          i += 1;
          continue;
        }
        if (CONTEXT_RANK_WORDS[next]) {
          withoutRank.push(CONTEXT_RANK_WORDS[next]);
          i += 1;
          continue;
        }
        if (next === 'eight') {
          withoutRank.push('8');
          i += 1;
          continue;
        }
      }
    }
    withoutRank.push(tokens[i]);
  }
  tokens = withoutRank;

  // Pass 1 — rank words that are always ranks.
  tokens = tokens.map((w) => RANK_WORDS[w] ?? w);

  // Pass 2 — rank words that need a file letter for context.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const prevIsFile = isFileish(prev);
    const nextIsFile = isFileish(next);
    const nearRankWord = prev === 'rank' || next === 'rank';

    if (token === 'to' || token === 'too') {
      // "e to" is e2; "to e4" is a preposition.
      if (prevIsFile && !nextIsFile) tokens[i] = '2';
      continue;
    }
    if (token === 'eight') {
      // "e eight" is rank 8; a trailing "eight" means "promote to rook".
      if (prevIsFile || nextIsFile || nearRankWord) tokens[i] = '8';
      continue;
    }
    const digit = CONTEXT_RANK_WORDS[token];
    if (!digit) continue;
    if (prevIsFile || nextIsFile || nearRankWord) tokens[i] = digit;
  }

  // Pass 3 — spelled-out file letters, but only next to a rank.
  for (let i = 0; i < tokens.length; i++) {
    const file = FILE_WORDS[tokens[i]];
    if (!file) continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const prevIsRank = !!prev && /^[1-8]$/.test(prev);
    const nextIsRank = !!next && /^[1-8]$/.test(next);
    if (prevIsRank || nextIsRank) tokens[i] = file;
  }

  return tokens.join(' ');
}

/* ------------------------------------------------------------------ */
/* Square / rank helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Parse a spoken square into algebraic notation.
 * Accepts "e4", "E4", "e 4", "e-4", "e four", "e for", "ef three".
 * Returns `null` when the input is not a valid square.
 */
export function parseSquare(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const squeezed = raw.toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
  if (!squeezed) return null;

  let work = squeezed.replace(
    /^([a-h])(one|two|three|four|five|six|seven|eight|won|wont)$/,
    (_m, file: string, rank: string) => file + (RANK_WORDS[rank] ?? rank),
  );
  work = work.replace(
    /^(be|bee|see|sea|cee|dee|ef|eff|gee|jee|aitch|hatch|ay|eh|age)(one|two|three|four|five|six|seven|eight)$/,
    (_m, fileWord: string, rank: string) =>
      (FILE_WORDS[fileWord] ?? fileWord) + (RANK_WORDS[rank] ?? rank),
  );

  const m = /^([a-h])([1-8])$/.exec(work);
  if (!m) return null;
  return m[1] + m[2];
}

/**
 * Parse a spoken rank into a digit string "1".."8".
 * Accepts "4", "four", "rank four", "ate".
 */
export function parseRank(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const norm = normalizeSpeech(raw);
  if (!norm) return null;
  for (const token of norm.split(' ')) {
    if (/^[1-8]$/.test(token)) return token;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Internal scanning                                                   */
/* ------------------------------------------------------------------ */

interface SquareSpan {
  file: string;
  rank: string;
  start: number;
  end: number;
  square: string;
}

/** Find every square mentioned in the token stream (file+rank pairs). */
function findSquares(tokens: string[]): SquareSpan[] {
  const spans: SquareSpan[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const single = /^([a-h])([1-8])$/.exec(token);
    if (single) {
      spans.push({
        file: single[1],
        rank: single[2],
        start: i,
        end: i,
        square: single[1] + single[2],
      });
      continue;
    }
    const next = tokens[i + 1];
    if (/^[a-h]$/.test(token) && !!next && /^[1-8]$/.test(next)) {
      spans.push({
        file: token,
        rank: next,
        start: i,
        end: i + 1,
        square: token + next,
      });
      i += 1;
    }
  }
  return spans;
}

interface PieceHit {
  index: number;
  piece: PieceType;
}

/** Find piece names, ignoring tokens that are part of a square. */
function findPieces(tokens: string[], spans: SquareSpan[]): PieceHit[] {
  const consumed = new Set<number>();
  for (const span of spans) {
    for (let i = span.start; i <= span.end; i++) consumed.add(i);
  }
  const hits: PieceHit[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const token = tokens[i];
    const word = PIECE_WORDS[token];
    if (word) {
      hits.push({ index: i, piece: word });
      continue;
    }
    if (token.length === 1 && PIECE_LETTERS.has(token)) {
      hits.push({ index: i, piece: token as PieceType });
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* Command detection                                                   */
/* ------------------------------------------------------------------ */

interface CommandRule {
  kind: CommandKind;
  test: (tokens: string[]) => boolean;
}

const COMMAND_RULES: CommandRule[] = [
  {
    kind: 'undo',
    test: (t) =>
      includesToken(t, 'undo') ||
      includesToken(t, 'takeback') ||
      (includesToken(t, 'take') && includesToken(t, 'back')) ||
      (includesToken(t, 'go') && includesToken(t, 'back')) ||
      includesToken(t, 'unmove'),
  },
  {
    kind: 'new',
    test: (t) =>
      includesToken(t, 'new') ||
      includesToken(t, 'restart') ||
      includesToken(t, 'reset') ||
      includesToken(t, 'fresh') ||
      (includesToken(t, 'start') && (includesToken(t, 'over') || includesToken(t, 'game'))),
  },
  {
    kind: 'help',
    test: (t) =>
      includesToken(t, 'help') ||
      includesToken(t, 'command') ||
      (includesToken(t, 'what') && includesToken(t, 'can') && includesToken(t, 'say')),
  },
  {
    kind: 'read_board',
    test: (t) =>
      includesToken(t, 'board') ||
      includesToken(t, 'describe') ||
      includesToken(t, 'pieces'),
  },
  {
    kind: 'where',
    test: (t) =>
      (includesToken(t, 'where') || includesToken(t, 'locate') || includesToken(t, 'find')) &&
      findPieces(t, []).length > 0,
  },
  {
    kind: 'status',
    test: (t) =>
      includesToken(t, 'status') ||
      includesToken(t, 'score') ||
      includesToken(t, 'whose') ||
      includesToken(t, 'turn'),
  },
  {
    kind: 'resign',
    test: (t) =>
      includesToken(t, 'resign') ||
      includesToken(t, 'forfeit') ||
      (includesToken(t, 'give') && includesToken(t, 'up')),
  },
  {
    kind: 'difficulty',
    test: (t) =>
      includesToken(t, 'difficulty') ||
      includesToken(t, 'level') ||
      includesToken(t, 'harder') ||
      includesToken(t, 'easier') ||
      includesToken(t, 'beginner') ||
      (t.length === 1 && ['easy', 'medium', 'hard', 'expert'].indexOf(t[0]) >= 0),
  },
  {
    kind: 'repeat',
    test: (t) =>
      includesToken(t, 'repeat') ||
      includesToken(t, 'again') ||
      (includesToken(t, 'what') &&
        (includesToken(t, 'say') || includesToken(t, 'said')) &&
        !includesToken(t, 'can')),
  },
  {
    kind: 'cancel',
    test: (t) =>
      includesToken(t, 'cancel') ||
      includesToken(t, 'nevermind') ||
      (includesToken(t, 'never') && includesToken(t, 'mind')) ||
      (includesToken(t, 'scratch') && includesToken(t, 'that')),
  },
  {
    kind: 'sleep',
    test: (t) => includesToken(t, 'sleep') || includesToken(t, 'pause'),
  },
  {
    kind: 'wake',
    test: (t) => includesToken(t, 'wake') || includesToken(t, 'resume'),
  },
];

/** Word -> difficulty level (0..4). */
const LEVEL_WORDS: Record<string, number> = {
  beginner: 0,
  easy: 1,
  easier: 1,
  medium: 2,
  hard: 3,
  harder: 3,
  expert: 4,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
};

function extractLevel(tokens: string[]): number | undefined {
  for (const token of tokens) {
    if (/^[0-4]$/.test(token)) return Number(token);
  }
  for (const token of tokens) {
    const level = LEVEL_WORDS[token];
    if (level !== undefined) return level;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Castling                                                            */
/* ------------------------------------------------------------------ */

function detectCastling(tokens: string[]): 'k' | 'q' | null {
  const oCount = tokens.filter((t) => t === 'o').length;
  const hasCastle =
    includesToken(tokens, 'castle') || includesToken(tokens, 'oo') || oCount >= 2;
  if (!hasCastle) return null;

  if (includesToken(tokens, 'long') || includesToken(tokens, 'queenside')) return 'q';
  if (includesToken(tokens, 'queen')) return 'q';
  if (includesToken(tokens, 'short') || includesToken(tokens, 'kingside')) return 'k';
  if (includesToken(tokens, 'king')) return 'k';
  if (oCount >= 3) return 'q';
  // "castle" on its own: assume the short side.
  return 'k';
}

/* ------------------------------------------------------------------ */
/* Token cleanup                                                       */
/* ------------------------------------------------------------------ */

/**
 * Drop filler words. "to" is only kept when it introduces a square,
 * because it is otherwise just noise ("move to e4" keeps it, "knight to f3"
 * loses it — both end up pointing at the same square).
 */
function stripFillers(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'to') {
      if (startsSquare(tokens[i + 1])) out.push(token);
      continue;
    }
    if (token === 'a') {
      // "a" is filler, but it is also the a-file: "a 1" is a square.
      if (/^[1-8]$/.test(tokens[i + 1] ?? '')) out.push(token);
      continue;
    }
    if (FILLER_WORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Extra context the caller can pass in. `pendingDisambiguation` tells the
 * parser that the app is currently waiting for the answer to a
 * "which knight?" question, so a bare square means "this one" rather than
 * "move here".
 */
export interface ParseContext {
  pendingDisambiguation?: boolean;
}

/**
 * Turn a spoken utterance into an `Intent`.
 * Returns `null` when nothing sensible can be made of the input.
 */
export function parseUtterance(
  text: string,
  context: ParseContext = {},
): Intent | null {
  try {
    if (typeof text !== 'string') return null;
    const raw = text.trim();
    if (!raw) return null;

    const normalized = normalizeSpeech(raw);
    if (!normalized) return null;

    let tokens = normalized.split(' ').filter(Boolean);
    tokens = stripFillers(tokens);
    if (!tokens.length) return null;

    /* ---- castling ------------------------------------------------ */
    const castling = detectCastling(tokens);
    if (castling) {
      const intent: MoveIntent = { kind: 'move', to: '', castling, raw };
      return intent;
    }

    /* ---- commands ------------------------------------------------ */
    for (const rule of COMMAND_RULES) {
      if (!rule.test(tokens)) continue;
      const intent: CommandIntent = { kind: rule.kind, raw };
      if (rule.kind === 'where') {
        const hits = findPieces(tokens, []);
        if (hits.length) intent.piece = hits[0].piece;
      } else if (rule.kind === 'difficulty') {
        const level = extractLevel(tokens);
        if (level !== undefined) intent.level = level;
      }
      return intent;
    }

    /* ---- move ---------------------------------------------------- */
    const spans = findSquares(tokens);
    const pieces = findPieces(tokens, spans);

    if (!spans.length) {
      // No square at all. A lone piece name answers a disambiguation question.
      if (pieces.length === 1) {
        const onlyPieceTokens = tokens.every(
          (t) => PIECE_WORDS[t] !== undefined || PIECE_LETTERS.has(t),
        );
        if (onlyPieceTokens) {
          const intent: CommandIntent = {
            kind: 'disambiguate',
            piece: pieces[0].piece,
            raw,
          };
          return intent;
        }
      }
      return null;
    }

    const first = spans[0];
    const last = spans[spans.length - 1];

    let from: string | undefined;
    let to: string;
    if (spans.length === 1) {
      to = first.square;
    } else {
      from = first.square;
      to = last.square;
    }

    // A bare square answering a disambiguation question.
    if (!from && pieces.length === 0 && context.pendingDisambiguation) {
      const intent: CommandIntent = { kind: 'disambiguate', square: to, raw };
      return intent;
    }

    /* ---- piece / promotion -------------------------------------- */
    let piece: PieceType | undefined;
    let promotion: PieceType | undefined;

    const promoteIndex = tokens.indexOf('promote');
    // Pieces said before the square, and pieces said after it.
    const before = pieces.filter((p) => p.index < first.start);
    const after = pieces.filter((p) => p.index > last.end);

    if (promoteIndex >= 0) {
      // "pawn promote to queen on e8" / "promote to queen e8"
      const beforePromote = pieces.filter((p) => p.index < promoteIndex);
      const afterPromote = pieces.filter((p) => p.index > promoteIndex);
      if (afterPromote.length) {
        promotion = afterPromote[afterPromote.length - 1].piece;
        if (beforePromote.length) {
          piece = beforePromote[beforePromote.length - 1].piece;
        }
      } else if (beforePromote.length) {
        piece = beforePromote[beforePromote.length - 1].piece;
        promotion = beforePromote[beforePromote.length - 1].piece;
      }
    } else if (before.length) {
      // A piece named before the square is the moving piece.
      piece = before[before.length - 1].piece;
      // A piece named after it is the promotion piece ("pawn e8 queen").
      if (after.length) promotion = after[after.length - 1].piece;
    } else if (after.length) {
      // Only a trailing piece word. On rank 8 it reads as a promotion
      // ("e8 queen"), elsewhere as the moving piece ("the h two knight").
      if (after.length >= 2) {
        piece = after[0].piece;
        promotion = after[after.length - 1].piece;
      } else if (last.rank === '8') {
        promotion = after[0].piece;
      } else {
        piece = after[0].piece;
      }
    }

    const intent: MoveIntent = { kind: 'move', to, raw };
    if (from) intent.from = from;
    if (piece) intent.piece = piece;
    if (promotion) intent.promotion = promotion;
    return intent;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Command catalogue                                                   */
/* ------------------------------------------------------------------ */

/**
 * Every command phrase the app understands. Used to build the spoken help
 * text and the on-screen help list.
 */
export const SPEECH_COMMANDS: {
  phrase: string;
  kind: CommandKind;
  description: string;
}[] = [
  { phrase: 'undo', kind: 'undo', description: 'Take back the last move' },
  { phrase: 'take back', kind: 'undo', description: 'Take back the last move' },
  { phrase: 'undo move', kind: 'undo', description: 'Take back the last move' },
  { phrase: 'go back', kind: 'undo', description: 'Take back the last move' },
  { phrase: 'new game', kind: 'new', description: 'Start a fresh game' },
  { phrase: 'new', kind: 'new', description: 'Start a fresh game' },
  { phrase: 'restart', kind: 'new', description: 'Start a fresh game' },
  { phrase: 'start over', kind: 'new', description: 'Start a fresh game' },
  { phrase: 'reset', kind: 'new', description: 'Start a fresh game' },
  { phrase: 'help', kind: 'help', description: 'List everything you can say' },
  { phrase: 'what can I say', kind: 'help', description: 'List everything you can say' },
  { phrase: 'commands', kind: 'help', description: 'List everything you can say' },
  { phrase: 'read the board', kind: 'read_board', description: 'Have the board read aloud' },
  { phrase: 'board', kind: 'read_board', description: 'Have the board read aloud' },
  { phrase: 'read board', kind: 'read_board', description: 'Have the board read aloud' },
  {
    phrase: 'describe the board',
    kind: 'read_board',
    description: 'Have the board read aloud',
  },
  {
    phrase: 'where are the pieces',
    kind: 'read_board',
    description: 'Have the board read aloud',
  },
  { phrase: 'where is the knight', kind: 'where', description: 'Find a piece on the board' },
  { phrase: 'where is the bishop', kind: 'where', description: 'Find a piece on the board' },
  { phrase: 'where are the rooks', kind: 'where', description: 'Find a piece on the board' },
  { phrase: 'status', kind: 'status', description: 'Whose turn it is, and the score' },
  { phrase: 'whose turn', kind: 'status', description: 'Whose turn it is, and the score' },
  { phrase: "what's the score", kind: 'status', description: 'Whose turn it is, and the score' },
  { phrase: 'resign', kind: 'resign', description: 'Resign the current game' },
  { phrase: 'i resign', kind: 'resign', description: 'Resign the current game' },
  { phrase: 'give up', kind: 'resign', description: 'Resign the current game' },
  { phrase: 'difficulty three', kind: 'difficulty', description: 'Set the engine difficulty' },
  { phrase: 'difficulty 3', kind: 'difficulty', description: 'Set the engine difficulty' },
  { phrase: 'level 3', kind: 'difficulty', description: 'Set the engine difficulty' },
  { phrase: 'make it harder', kind: 'difficulty', description: 'Set the engine difficulty' },
  { phrase: 'make it easier', kind: 'difficulty', description: 'Set the engine difficulty' },
  { phrase: 'repeat', kind: 'repeat', description: 'Say the last message again' },
  { phrase: 'say again', kind: 'repeat', description: 'Say the last message again' },
  { phrase: 'again', kind: 'repeat', description: 'Say the last message again' },
  { phrase: 'what did you say', kind: 'repeat', description: 'Say the last message again' },
  { phrase: 'cancel', kind: 'cancel', description: 'Cancel the current action' },
  { phrase: 'never mind', kind: 'cancel', description: 'Cancel the current action' },
  { phrase: 'scratch that', kind: 'cancel', description: 'Cancel the current action' },
  { phrase: 'sleep', kind: 'sleep', description: 'Pause voice recognition' },
  { phrase: 'pause', kind: 'sleep', description: 'Pause voice recognition' },
  { phrase: 'wake up', kind: 'wake', description: 'Resume voice recognition' },
  { phrase: 'resume', kind: 'wake', description: 'Resume voice recognition' },
  { phrase: 'the knight', kind: 'disambiguate', description: 'Answer a "which piece?" question' },
  { phrase: 'the queen', kind: 'disambiguate', description: 'Answer a "which piece?" question' },
  { phrase: 'e4', kind: 'disambiguate', description: 'Answer a "which square?" question' },
];
