/**
 * Move resolution: turn a (deliberately loose) spoken MoveIntent into a single
 * legal chess move, or explain why we cannot.
 *
 * The heart of this module is `resolveMove`, which implements the spoken-chess
 * disambiguation rules:
 *   - a spoken move usually omits the origin square,
 *   - when several legal moves fit, we ask the player which piece / which square.
 */

import type { Chess, Move } from 'chess.js';

import type {
  CandidateMove,
  Color,
  MoveIntent,
  PieceType,
  ResolveResult,
} from './types';

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

const PIECE_NAMES: Record<PieceType, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

const COLOR_NAMES: Record<Color, string> = {
  w: 'white',
  b: 'black',
};

/** Human-friendly name for a piece, e.g. 'white knight'. */
export function describePiece(piece: PieceType, color?: Color): string {
  const name = PIECE_NAMES[piece] ?? piece;
  return color ? `${COLOR_NAMES[color] ?? color} ${name}` : name;
}

/** Speakable description of a square, e.g. 'e4'. */
export function squareName(square: string): string {
  return (square ?? '').trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Candidates                                                          */
/* ------------------------------------------------------------------ */

/**
 * chess.js v1 flag letters:
 *   'n' normal, 'b' big pawn (double step), 'c' capture, 'e' en-passant capture,
 *   'p' promotion, 'k' king-side castle, 'q' queen-side castle.
 * Note 'b' is the double pawn push, NOT a capture — so we key on 'c'/'e'.
 * We also accept the older v0 spellings ('b' for capture) so the module keeps
 * working against either build.
 */
function isCapture(flags: string): boolean {
  return flags.includes('c') || flags.includes('e');
}

function isPromotion(flags: string, san: string): boolean {
  return flags.includes('p') || san.includes('=');
}

function isCastle(san: string): boolean {
  return san === 'O-O' || san === 'O-O-O';
}

function toCandidate(move: Move): CandidateMove {
  return {
    from: move.from,
    to: move.to,
    piece: move.piece as PieceType,
    san: move.san,
    capture: isCapture(move.flags),
    castle: isCastle(move.san),
    promotion: isPromotion(move.flags, move.san),
  };
}

/** Internal candidate: keeps the promotion piece so we can match "promote to queen". */
interface RichCandidate {
  move: CandidateMove;
  promotionPiece?: PieceType;
}

function richCandidates(chess: Chess): RichCandidate[] {
  const moves = chess.moves({ verbose: true }) as Move[];
  return moves.map((m) => ({
    move: toCandidate(m),
    promotionPiece: m.promotion as PieceType | undefined,
  }));
}

/** All legal moves in the current position, as CandidateMove[] (contract type). */
export function legalCandidates(chess: Chess): CandidateMove[] {
  return richCandidates(chess).map((c) => c.move);
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

function ambiguousReason(candidates: CandidateMove[]): 'piece' | 'square' {
  const types = new Set(candidates.map((c) => c.piece));
  // More than one piece type can make the move -> ask which piece.
  // Otherwise it is the same piece from several squares -> ask which square.
  return types.size > 1 ? 'piece' : 'square';
}

/**
 * A short, speakable explanation of why the intent could not be matched.
 */
function illegalReason(chess: Chess, intent: MoveIntent): string {
  if (chess.isGameOver()) {
    if (chess.isCheckmate()) return 'the game is over, checkmate';
    if (chess.isStalemate()) return 'the game is over, stalemate';
    if (chess.isDraw()) return 'the game is over, it is a draw';
    return 'the game is over';
  }

  // If the origin square holds an enemy piece, the player is speaking for the
  // wrong side.
  if (intent.from) {
    const occupant = chess.get(intent.from);
    if (occupant && occupant.color !== chess.turn()) {
      return 'it is not your turn';
    }
  }

  if (intent.castling) {
    return intent.castling === 'k'
      ? 'you cannot castle kingside'
      : 'you cannot castle queenside';
  }

  const to = squareName(intent.to);

  if (intent.piece && intent.from) {
    return `the ${describePiece(intent.piece)} on ${squareName(intent.from)} cannot go to ${to}`;
  }
  if (intent.piece) {
    return `no ${describePiece(intent.piece)} can go to ${to}`;
  }
  if (intent.from) {
    return `no piece on ${squareName(intent.from)} can go to ${to}`;
  }
  if (!to) {
    return 'that is not a legal move';
  }
  return `${to} is not a legal move`;
}

/**
 * Resolve a spoken MoveIntent against the position.
 * Implements the disambiguation rules below.
 */
export function resolveMove(chess: Chess, intent: MoveIntent): ResolveResult {
  let pool = richCandidates(chess);

  // 1. Castling intents ignore the destination square entirely (the
  //    destination of a castle move is the rook's square, g1/c1).
  if (intent.castling) {
    const wantSan = intent.castling === 'k' ? 'O-O' : 'O-O-O';
    pool = pool.filter((c) => c.move.san === wantSan);
  } else {
    // 2. Target square.
    pool = pool.filter((c) => c.move.to === squareName(intent.to));
  }

  // 3. Named piece type.
  if (intent.piece) {
    pool = pool.filter((c) => c.move.piece === intent.piece);
  }

  // 4. Named origin square.
  if (intent.from) {
    pool = pool.filter((c) => c.move.from === squareName(intent.from));
  }

  // 5. Promotion. Prefer the exact promotion piece when it is available
  //    ("promote to queen" -> a8=Q), otherwise accept any promotion.
  if (intent.promotion) {
    const promoPool = pool.filter((c) => c.move.promotion);
    const exact = promoPool.filter((c) => c.promotionPiece === intent.promotion);
    pool = exact.length > 0 ? exact : promoPool;
  }

  if (pool.length === 0) {
    return { status: 'illegal', reason: illegalReason(chess, intent), intent };
  }

  if (pool.length === 1) {
    return { status: 'ok', move: pool[0].move };
  }

  // Several matches. We never auto-pick (not even when only one of them is a
  // capture) — the player hears the question and answers.
  const candidates = pool.map((c) => c.move);
  return { status: 'ambiguous', reason: ambiguousReason(candidates), candidates };
}

/**
 * Given a pending ambiguity (from a previous ResolveResult with status 'ambiguous'),
 * apply the player's answer (a piece type or an origin square) and pick the final move.
 * Returns a ResolveResult; status 'ambiguous' again if the answer still matches several.
 */
export function resolveDisambiguation(
  chess: Chess,
  pending: { reason: 'piece' | 'square'; candidates: CandidateMove[] },
  answer: { piece?: PieceType; square?: string }
): ResolveResult {
  const all = pending.candidates ?? [];
  let pool = all;

  if (answer.piece) {
    pool = pool.filter((c) => c.piece === answer.piece);
  }
  if (answer.square) {
    pool = pool.filter((c) => c.from === squareName(answer.square));
  }

  const rawText = answer.piece
    ? describePiece(answer.piece)
    : answer.square
      ? squareName(answer.square)
      : '';

  const bestEffortIntent: MoveIntent = {
    kind: 'move',
    to: all.length > 0 ? all[0].to : '',
    raw: rawText,
  };

  if (pool.length === 0) {
    let reason: string;
    if (answer.piece && answer.square) {
      reason = `there is no ${describePiece(answer.piece)} on ${squareName(answer.square)} that can do that`;
    } else if (answer.piece) {
      reason = `there is no ${describePiece(answer.piece)} that can do that`;
    } else if (answer.square) {
      reason = `${squareName(answer.square)} is not one of the options`;
    } else {
      reason = 'that is not one of the options';
    }
    return { status: 'illegal', reason, intent: bestEffortIntent };
  }

  if (pool.length === 1) {
    return { status: 'ok', move: pool[0] };
  }

  // Still ambiguous.
  //  - The player named a piece -> the only open question is which square.
  //  - The player named a square -> also keep asking about the square.
  //  - No answer at all -> fall back to comparing the piece types.
  const reason: 'piece' | 'square' =
    answer.piece || answer.square ? 'square' : ambiguousReason(pool);

  return { status: 'ambiguous', reason, candidates: pool };
}
