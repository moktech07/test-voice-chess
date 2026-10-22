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
} from './types';

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** Words that name a piece -> piece type. */
const PIECE_WORDS: Record<string, PieceType> = {
  pawn: 'p',
  pawns: 'p',
  knight: 'n',
  knights: 'n',
  night: 'n',
  nights: 'n',
  nite: 'n',
  bishop: 'b',
  bishops: 'b',
  bishup: 'b',
  rook: 'r',
  rooks: 'r',
  rock: 'r',
  queen: 'q',
  queens: 'q',
  quean: 'q',
  king: 'k',
  kings: 'k',
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
  one: '1',
  won: '1',
  wont: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
};

/**
 * Rank words that are only a rank when a file letter is nearby.
 * "to" is the preposition far more often than it is the number two.
 */
const CONTEXT_RANK_WORDS: Record<string, string> = {
  ate: '8',
  for: '4',
  fore: '4',
  to: '2',
  too: '2',
};

/** Irregular inflections / possessives collapsed onto a canonical token. */
const WORD_FIXUPS: Record<string, string> = {
  whats: 'what',
  lets: 'let',
  kings: 'king',
  queens: 'queen',
  knights: 'knight',
  bishops: 'bishop',
  rooks: 'rook',
  pawns: 'pawn',
  pieces: 'piece',
  ranks: 'rank',
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
  'lets',
  'well',
  'yeah',
  'hey',
  'and',
  'then',
]);

/** Tokens that make an utterance "move-like" rather than "bare". */
const VERB_TOKENS = new Set<string>([
  'move',
  'go',
  'take',
  'capture',
  'promote',
  'castle',
  'play',
  'put',
  'push',
  'slide',
  'jump',
  'to',
  'into',
  'attack',
]);

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isFileLetter(word: string | undefined): boolean {
  return !!word && /^[a-h]$/.test(word);
}

function isFileish(word: string | undefined): boolean {
  if (!word) return false;
  return isFileLetter(word) || Object.prototype.hasOwnProperty.call(FILE_WORDS, word);
}

function isRankish(word: string | undefined): boolean {
  if (!word) return false;
  if (/^[1-8]$/.test(word)) return true;
  return (
    Object.prototype.hasOwnProperty.call(RANK_WORDS, word) ||
    Object.prototype.hasOwnProperty.call(CONTEXT_RANK_WORDS, word)
  );
}

/** True when `words` appear in `tokens` in order (not necessarily adjacent). */
function hasSeq(tokens: string[], words: string[]): boolean {
  let cursor = 0;
  for (const word of words) {
    const found = tokens.indexOf(word, cursor);
    if (found < 0) return false;
    cursor = found + 1;
  }
  return true;
}

function contains(tokens: string[], word: string): boolean {
  return tokens.indexOf(word) >= 0;
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Lower-cases, strips punctuation and expands the homophones that speech
 * engines like to produce.
 *
 * - "E-4"        -> "e 4"
 * - "e four"     -> "e 4"
 * - "knight ef three" -> "knight f 3"
 * - "for"        -> "4" only when a file letter is nearby ("e for")
 * - "to"         -> "2" only when a file letter is nearby ("e to")
 * - "rank four"  -> "4"
 */
export function normalizeSpeech(text: string): string {
  if (typeof text !== 'string') return '';

  let flat = text.toLowerCase().replace(/['‘’`]/g, '');
  flat = flat.replace(/[^a-z0-9]+/g, ' ').trim();
  if (!flat) return '';

  let tokens = flat.split(/\s+/);
  tokens = tokens.map((w) => WORD_FIXUPS[w] ?? w);

  // Pass 1 — rank words that are always ranks.
  tokens = tokens.map((w) => RANK_WORDS[w] ?? w);

  // Pass 2 — rank words that need a file letter for context.
  for (let i = 0; i < tokens.length; i++) {
    const digit = CONTEXT_RANK_WORDS[tokens[i]];
    if (!digit) continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (isFileish(prev) || isFileish(next) || prev === 'rank' || next === 'rank') {
      tokens[i] = digit;
    }
  }

  // Pass 3 — spelled-out