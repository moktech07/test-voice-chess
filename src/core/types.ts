/**
 * SHARED CONTRACT — every module talks through these types.
 * Do not change a shape here without updating the other modules.
 */

export type Color = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
export const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;

/* ------------------------------------------------------------------ */
/* Moves                                                              */
/* ------------------------------------------------------------------ */

/** What the player *said*. Deliberately loose — it may be under-specified. */
export interface MoveIntent {
  kind: 'move';
  /** Target square, e.g. 'e4'. Always present for a move intent. */
  to: string;
  /** Origin square, e.g. 'e2'. Optional — often omitted in speech. */
  from?: string;
  /** Piece type, e.g. 'n'. Optional — inferred when unambiguous. */
  piece?: PieceType;
  /** Promotion piece, e.g. 'q'. Optional. */
  promotion?: PieceType;
  /** Castling: 'k' = king side, 'q' = queen side. */
  castling?: 'k' | 'q';
  /** Raw token(s) the intent was parsed from, for echo in transcripts. */
  raw?: string;
}

export type CommandKind =
  | 'undo'
  | 'new'
  | 'help'
  | 'read_board'
  | 'where'
  | 'status'
  | 'resign'
  | 'difficulty'
  | 'repeat'
  | 'cancel'
  | 'disambiguate'
  | 'sleep'
  | 'wake';

export interface CommandIntent {
  kind: CommandKind;
  /** For 'where': which piece. */
  piece?: PieceType;
  /** For 'difficulty': 0..4 */
  level?: number;
  /** For 'disambiguate': the chosen origin square, e.g. 'g1'. */
  square?: string;
  raw?: string;
}

export type Intent = MoveIntent | CommandIntent;

/* ------------------------------------------------------------------ */
/* Move resolution                                                     */
/* ------------------------------------------------------------------ */

export interface CandidateMove {
  /** Origin square, e.g. 'b1'. */
  from: string;
  /** Destination square, e.g. 'f3'. */
  to: string;
  /** Piece that moves. */
  piece: PieceType;
  /** SAN, e.g. 'Ngf3'. */
  san: string;
  /** True when the move is a capture. */
  capture: boolean;
  /** True when the move is castling. */
  castle: boolean;
  /** True when the move promotes. */
  promotion: boolean;
}

export type ResolveResult =
  | { status: 'ok'; move: CandidateMove }
  /**
   * The player must disambiguate. `reason` says which question to ask.
   *  - 'piece': several different pieces can make the move -> ask which piece
   *  - 'square': several pieces of the same type can make it -> ask which square
   */
  | { status: 'ambiguous'; reason: 'piece' | 'square'; candidates: CandidateMove[] }
  | { status: 'illegal'; reason: string; intent: MoveIntent };

/* ------------------------------------------------------------------ */
/* Engine                                                             */
/* ------------------------------------------------------------------ */

export interface EngineMove {
  from: string;
  to: string;
  promotion?: string;
}

export interface Engine {
  /** Load the wasm engine. Resolves when the engine is ready to accept UCI. */
  init(): Promise<void>;
  /** Set search depth / skill level, 0..4 (engine maps this to depth). */
  setDifficulty(level: number): void;
  /** Search for the best move for the given FEN. */
  search(fen: string, opts?: { depth?: number; movetimeMs?: number }): Promise<EngineMove>;
  /** Stop any running search. */
  stop(): void;
  /** Release the worker. */
  dispose(): void;
  /** True once init() has resolved. */
  readonly ready: boolean;
}

/* ------------------------------------------------------------------ */
/* Audio                                                              */
/* ------------------------------------------------------------------ */

export interface SpeechOutput {
  /** Speak text aloud. Resolves when the utterance finishes. */
  speak(text: string, opts?: { interrupt?: boolean }): Promise<void>;
  /** Stop speaking immediately. */
  cancel(): void;
  /** True while an utterance is in progress. */
  readonly speaking: boolean;
}

export interface SpeechInput {
  /** Start continuous recognition. `onHeard` fires for final results. */
  start(onHeard: (text: string, isFinal: boolean) => void): void;
  /** Pause recognition (used while TTS is speaking, to avoid self-hearing). */
  pause(): void;
  /** Resume recognition. */
  resume(): void;
  /** Stop recognition permanently. */
  stop(): void;
  /** True when the mic is actively listening. */
  readonly listening: boolean;
}

/* ------------------------------------------------------------------ */
/* Game state                                                          */
/* ------------------------------------------------------------------ */

export interface GameViewState {
  /** Whose turn it is. */
  turn: Color;
  /** The colour the human plays. */
  playerColor: Color;
  /** Current position FEN. */
  fen: string;
  /** SAN history of the game. */
  history: string[];
  /** Difficulty 0..4. */
  difficulty: number;
  /** Game over? */
  over: boolean;
  /** Result text, e.g. 'Checkmate — you win'. */
  result?: string;
  /** True while the engine is thinking. */
  thinking: boolean;
  /** Pending disambiguation question, if any. */
  pendingQuestion?: {
    reason: 'piece' | 'square';
    candidates: CandidateMove[];
    /** The spoken question text. */
    text: string;
  };
  /** Last thing the app said (for the on-screen transcript). */
  lastSpoken?: string;
  /** Last thing the player said. */
  lastHeard?: string;
}

/* ------------------------------------------------------------------ */
/* Controller                                                         */
/* ------------------------------------------------------------------ */

export interface ControllerOptions {
  engine: Engine;
  speechOut: SpeechOutput;
  speechIn: SpeechInput;
  playerColor?: Color;
  difficulty?: number;
}

export interface GameController {
  /** Feed a recognised utterance in. */
  handleUtterance(text: string): void;
  /** Current view state. */
  getState(): GameViewState;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(fn: (state: GameViewState) => void): () => void;
  /** Start a fresh game. */
  newGame(): void;
  /** Take back one ply (and the engine's reply if it already moved). */
  undo(): void;
}
