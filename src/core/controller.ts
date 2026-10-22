import { Chess } from 'chess.js';
import type {
  CandidateMove,
  Color,
  CommandIntent,
  Engine,
  GameController,
  GameViewState,
  MoveIntent,
  PieceType,
  ResolveResult,
  SpeechInput,
  SpeechOutput,
} from './types.ts';
import { parseUtterance } from './parse.ts';
import { resolveDisambiguation, resolveMove } from './resolve.ts';
import { createEchoGuard, type EchoGuard } from './speech.ts';

export interface ControllerDeps {
  engine: Engine;
  speechOut: SpeechOutput;
  speechIn: SpeechInput;
  playerColor?: Color;
  difficulty?: number;
}

/**
 * The playable core. Everything here is transport-agnostic: it takes text in
 * and produces text out. The UI layer wires it to the DOM.
 */
export class VoiceChessController implements GameController {
  private chess: Chess;
  private engine: Engine;
  private speechOut: SpeechOutput;
  private speechIn: SpeechInput;
  private echoGuard: EchoGuard;

  private playerColor: Color;
  private difficulty: number;

  private listeners = new Set<(s: GameViewState) => void>();
  private state: GameViewState;

  /** Pending ambiguity awaiting the player's answer. */
  private pending: { reason: 'piece' | 'square'; candidates: CandidateMove[] } | null = null;
  /** The intent that produced the pending ambiguity, so we can retry it. */
  private pendingIntent: MoveIntent | null = null;

  /** True while the engine is searching. */
  private thinking = false;
  /** Guards against applying a move while the engine is thinking. */
  private busy = false;

  /** True when the mic is intentionally off (sleep mode). */
  private asleep = false;

  /** Serialises speech so TTS and the game loop don't interleave. */
  private speechChain: Promise<void> = Promise.resolve();

  /** The last thing we spoke, for the "repeat" command. */
  private lastSpoken = '';
  /** The last thing we heard, for the transcript display. */
  private lastHeard = '';

  constructor(deps: ControllerDeps) {
    this.engine = deps.engine;
    this.speechOut = deps.speechOut;
    this.speechIn = deps.speechIn;
    this.echoGuard = createEchoGuard(this.speechIn, this.speechOut);
    this.playerColor = deps.playerColor ?? 'w';
    this.difficulty = deps.difficulty ?? 2;

    this.chess = new Chess();
    this.state = {
      turn: 'w',
      playerColor: this.playerColor,
      fen: this.chess.fen(),
      history: [],
      difficulty: this.difficulty,
      over: false,
      thinking: false,
      lastSpoken: '',
      lastHeard: '',
    };
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  getState(): GameViewState {
    return { ...this.state };
  }

  subscribe(fn: (s: GameViewState) => void): () => void {
    this.listeners.add(fn);
    fn(this.getState());
    return () => this.listeners.delete(fn);
  }

  /** Start listening and greet the player. */
  async start(): Promise<void> {
    await this.engine.init();
    this.engine.setDifficulty(this.difficulty);
    this.speechIn.start((text, isFinal) => {
      if (isFinal) this.handleUtterance(text);
    });
    this.say(
      `Welcome to voice chess. You play ${this.playerColor === 'w' ? 'white' : 'black'}. ` +
        `Say help at any time to hear what you can say.`
    );
    this.emit();
  }

  handleUtterance(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.lastHeard = trimmed;
    this.state.lastHeard = trimmed;

    // While a disambiguation question is outstanding, a bare square is the
    // player's answer ("the h two knight") rather than a new destination.
    const intent = parseUtterance(trimmed, {
      pendingDisambiguation: this.pending !== null,
    });
    if (!intent) {
      this.say(`I did not understand "${trimmed}". Say help for commands.`);
      this.emit();
      return;
    }

    if (intent.kind === 'move') {
      this.handleMoveIntent(intent);
    } else if (intent.kind === 'disambiguate') {
      if (this.pending) {
        this.handleDisambiguationAnswer(intent);
      } else {
        this.say('I did not catch which piece you meant. Say the square again.');
      }
    } else {
      this.handleCommand(intent);
    }
    this.emit();
  }

  newGame(): void {
    this.chess = new Chess();
    this.pending = null;
    this.pendingIntent = null;
    this.thinking = false;
    this.busy = false;
    this.state.history = [];
    this.state.over = false;
    this.state.result = undefined;
    this.state.thinking = false;
    this.state.pendingQuestion = undefined;
    this.syncPosition();
    this.say('New game. You are white. Your move.');
    this.maybeEngineMove();
  }

  /**
   * Load a specific position. Used to set up a game (and by tests to reach
   * positions where a spoken move is ambiguous).
   */
  loadPosition(fen: string): void {
    try {
      this.chess = new Chess(fen);
    } catch {
      return;
    }
    this.pending = null;
    this.pendingIntent = null;
    this.thinking = false;
    this.busy = false;
    this.state.history = this.chess.history();
    this.state.over = this.chess.isGameOver();
    this.state.result = undefined;
    this.state.thinking = false;
    this.state.pendingQuestion = undefined;
    this.syncPosition();
  }

  undo(): void {
    if (this.state.history.length === 0) {
      this.say('There are no moves to take back.');
      return;
    }
    // If the engine has already replied, take back both plies so it is the
    // player's turn again and they can choose a different move.
    const engineAlreadyReplied =
      this.chess.turn() === this.playerColor && this.chess.history().length >= 2;
    if (engineAlreadyReplied) {
      this.chess.undo();
    }
    this.chess.undo();
    this.pending = null;
    this.pendingIntent = null;
    this.thinking = false;
    this.busy = false;
    this.state.history = this.chess.history();
    this.state.over = false;
    this.state.result = undefined;
    this.state.thinking = false;
    this.state.pendingQuestion = undefined;
    this.syncPosition();
    this.say(`Took back. The board is back to ${this.positionSummary()}.`);
    // If the engine still has the move, let it play again.
    this.maybeEngineMove();
  }

  /* ---------------------------------------------------------------- */
  /* Move handling                                                      */
  /* ---------------------------------------------------------------- */

  private handleMoveIntent(intent: MoveIntent): void {
    if (this.busy) {
      this.say('Wait for the engine to finish thinking.');
      return;
    }
    if (this.state.over) {
      this.say('The game is over. Say new game to play again.');
      return;
    }
    if (this.chess.turn() !== this.playerColor) {
      this.say('Not your turn yet. The engine is thinking.');
      return;
    }

    // If we are waiting for a disambiguation answer, treat this as the answer.
    if (this.pending) {
      if (this.tryAnswerPending(intent)) return;
      // Not an answer — treat as a fresh move intent, which cancels the question.
      this.say('Never mind that question.');
      this.pending = null;
      this.pendingIntent = null;
      this.state.pendingQuestion = undefined;
    }

    const result = resolveMove(this.chess, intent);
    this.applyResolution(result, intent);
  }

  /**
   * Try to read the current utterance as an answer to a pending
   * "which piece / which square" question.
   *
   * The player may answer with:
   *   - a piece name      ("knight")
   *   - an origin square  ("h two", "from h two")
   *   - a piece + square  ("the h two knight")
   *
   * Returns true when the utterance was consumed as an answer.
   */
  private tryAnswerPending(intent: MoveIntent): boolean {
    const pending = this.pending;
    if (!pending) return false;

    const answer: { piece?: PieceType; square?: string } = {};
    if (intent.piece) answer.piece = intent.piece;
    if (intent.from) answer.square = intent.from;

    // A bare square ("h two") means the ORIGIN square of the piece, but only
    // when it is actually one of the candidate origins. Otherwise the player
    // is naming a new destination and we should not hijack it.
    if (!answer.square && intent.to) {
      const isCandidateOrigin = pending.candidates.some((c) => c.from === intent.to);
      if (isCandidateOrigin) answer.square = intent.to;
    }

    if (!answer.piece && !answer.square) return false;

    const result = resolveDisambiguation(this.chess, pending, answer);
    this.applyResolution(result, {
      kind: 'move',
      to: pending.candidates[0]?.to ?? '',
      from: answer.square,
      piece: answer.piece,
      raw: intent.raw,
    });
    return true;
  }

  /**
   * The player answered a "which piece / which square" question.
   * `disambiguate` intents carry either a piece type or a square.
   */
  private handleDisambiguationAnswer(intent: CommandIntent): void {
    if (!this.pending) return;
    const answer: { piece?: PieceType; square?: string } = {};
    if (intent.piece) answer.piece = intent.piece;
    if (intent.square) answer.square = intent.square;

    if (!answer.piece && !answer.square) {
      this.say('I did not catch which piece you meant. Say the piece name or the square.');
      return;
    }

    const result = resolveDisambiguation(this.chess, this.pending, answer);
    this.applyResolution(result, {
      kind: 'move',
      to: this.pending.candidates[0]?.to ?? '',
      from: answer.square,
      piece: answer.piece,
      raw: intent.raw,
    });
  }

  private applyResolution(result: ResolveResult, intent: MoveIntent): void {
    if (result.status === 'illegal') {
      this.say(`${capitalize(result.reason)}. Try again.`);
      return;
    }
    if (result.status === 'ambiguous') {
      this.pending = { reason: result.reason, candidates: result.candidates };
      this.pendingIntent = intent;
      const text = this.ambiguityQuestion(result.reason, result.candidates);
      this.state.pendingQuestion = { reason: result.reason, candidates: result.candidates, text };
      this.say(text);
      return;
    }

    this.pending = null;
    this.pendingIntent = null;
    this.state.pendingQuestion = undefined;

    const move = result.move;
    let applied;
    try {
      applied = this.chess.move({
        from: move.from,
        to: move.to,
        // chess.js requires a promotion piece when the move promotes; the
        // player's spoken choice wins, defaulting to a queen.
        promotion: move.promotion ? (intent.promotion ?? 'q') : undefined,
      });
    } catch {
      this.say('That move is not legal here. Try again.');
      return;
    }
    if (!applied) {
      this.say('That move is not legal here. Try again.');
      return;
    }

    this.state.history = this.chess.history();
    this.syncPosition();
    this.say(`${capitalize(applied.san)}. ${this.positionSummary()}`);
    this.maybeEngineMove();
  }

  /** Build the spoken question when a move is ambiguous. */
  private ambiguityQuestion(reason: 'piece' | 'square', candidates: CandidateMove[]): string {
    if (reason === 'piece') {
      const pieces = [...new Set(candidates.map((c) => c.piece))];
      const names = pieces.map((p) => this.pieceWord(p));
      if (names.length === 2) {
        return `A ${names[0]} or a ${names[1]} can go there. Which one?`;
      }
      return `Several pieces can go there: ${names.join(', ')}. Which one?`;
    }
    // reason === 'square'
    const squares = [...new Set(candidates.map((c) => c.from))];
    const names = squares.map((s) => this.squareWord(s));
    if (names.length === 2) {
      return `Two ${this.pieceWord(candidates[0].piece)}s can go there, from ${names[0]} or ${names[1]}. Which one?`;
    }
    return `Which ${this.pieceWord(candidates[0].piece)}, from ${names.join(' or ')}?`;
  }

  private pieceWord(piece: PieceType): string {
    return piece === 'n' ? 'knight' : piece === 'b' ? 'bishop' : piece === 'r' ? 'rook' : piece === 'q' ? 'queen' : piece === 'k' ? 'king' : 'pawn';
  }

  /** Speak a square the way a person says it: "e four". */
  private squareWord(square: string): string {
    const file = square[0] ?? '';
    const rank = square[1] ?? '';
    const rankNames = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
    const r = Number(rank);
    return `${file} ${rankNames[r - 1] ?? rank}`;
  }

  /* ---------------------------------------------------------------- */
  /* Engine turn                                                       */
  /* ---------------------------------------------------------------- */

  private maybeEngineMove(): void {
    if (this.state.over) return;
    if (this.chess.turn() === this.playerColor) return;

    this.thinking = true;
    this.busy = true;
    this.state.thinking = true;
    this.emit();

    void this.runEngineMove();
  }

  private async runEngineMove(): Promise<void> {
    const fen = this.chess.fen();
    try {
      const result = await this.engine.search(fen);
      // Guard: the position may have changed while the engine was thinking
      // (e.g. the player said "undo").
      if (this.chess.fen() !== fen) return;

      let applied = null;
      try {
        applied = this.chess.move({
          from: result.from,
          to: result.to,
          promotion: result.promotion,
        });
      } catch {
        applied = null;
      }
      if (!applied) {
        this.say('The engine could not make a move. Say new game to restart.');
        this.thinking = false;
        this.busy = false;
        this.state.thinking = false;
        this.emit();
        return;
      }
      this.state.history = this.chess.history();
      this.syncPosition();
      this.say(`Engine plays ${capitalize(applied.san)}. ${this.positionSummary()}`);
      this.afterMove();
    } catch (err) {
      this.say('The engine had a problem. Say new game to restart.');
      console.error('engine error', err);
    } finally {
      this.thinking = false;
      this.busy = false;
      this.state.thinking = false;
      this.emit();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Commands                                                          */
  /* ---------------------------------------------------------------- */

  private handleCommand(intent: CommandIntent): void {
    switch (intent.kind) {
      case 'undo':
        this.undo();
        return;
      case 'new':
        this.newGame();
        return;
      case 'help':
        this.say(this.helpText());
        return;
      case 'read_board':
        this.say(this.boardDescription());
        return;
      case 'where':
        this.say(this.whereDescription(intent.piece));
        return;
      case 'status':
        this.say(this.statusText());
        return;
      case 'resign':
        this.state.over = true;
        this.state.result = 'You resigned.';
        this.say('You resigned. The game is over. Say new game to play again.');
        return;
      case 'difficulty':
        if (typeof intent.level === 'number') {
          this.difficulty = Math.max(0, Math.min(4, intent.level));
          this.engine.setDifficulty(this.difficulty);
          this.state.difficulty = this.difficulty;
          this.say(`Difficulty set to ${this.difficulty}.`);
        } else {
          this.say(`Difficulty is ${this.difficulty}. Say difficulty zero to four to change it.`);
        }
        return;
      case 'repeat':
        this.say(this.lastSpoken || 'I have not said anything yet.');
        return;
      case 'cancel':
        this.pending = null;
        this.pendingIntent = null;
        this.state.pendingQuestion = undefined;
        this.say('Okay, cancelled.');
        return;
      case 'disambiguate':
        this.say('I did not catch which piece you meant. Say the square again.');
        return;
      case 'sleep':
        this.asleep = true;
        this.speechIn.pause();
        this.say('Going to sleep. Say wake up to continue.');
        return;
      case 'wake':
        this.asleep = false;
        this.speechIn.resume();
        this.say('Awake. Your move.');
        return;
    }
  }

  private helpText(): string {
    return (
      'You can say a move like "knight takes f three", "e four", or "castle kingside". ' +
      'You can say "read the board" to hear the position, "where is the queen", ' +
      '"status", "undo", "resign", or "new game". ' +
      'If I ask which piece, just say the piece name or the square.'
    );
  }

  /** Describe the position out loud, in reading order. */
  private boardDescription(): string {
    const board = this.chess.board();
    const parts: string[] = [];
    for (const row of board) {
      const rowParts: string[] = [];
      for (const sq of row) {
        if (!sq) {
          rowParts.push('empty');
          continue;
        }
        const color = sq.color === 'w' ? 'white' : 'black';
        rowParts.push(`${color} ${this.pieceWord(sq.type as PieceType)}`);
      }
      // Collapse runs of empties for brevity: "4 empties".
      const collapsed: string[] = [];
      let emptyRun = 0;
      for (const p of rowParts) {
        if (p === 'empty') {
          emptyRun++;
          continue;
        }
        if (emptyRun > 0) {
          collapsed.push(emptyRun === 1 ? 'empty' : `${emptyRun} empties`);
          emptyRun = 0;
        }
        collapsed.push(p);
      }
      if (emptyRun > 0) {
        collapsed.push(emptyRun === 1 ? 'empty' : `${emptyRun} empties`);
      }
      parts.push(collapsed.join(', '));
    }
    // Row 1 first for a player at the bottom (index 7 of the array).
    const ordered = parts.slice().reverse();
    return `Rank eight: ${ordered[0]}. Rank seven: ${ordered[1]}. Rank six: ${ordered[2]}. ` +
      `Rank five: ${ordered[3]}. Rank four: ${ordered[4]}. Rank three: ${ordered[5]}. ` +
      `Rank two: ${ordered[6]}. Rank one: ${ordered[7]}.`;
  }

  private whereDescription(piece?: PieceType): string {
    const board = this.chess.board();
    const found: string[] = [];
    for (const row of board) {
      for (const sq of row) {
        if (!sq) continue;
        if (piece && sq.type !== piece) continue;
        const color = sq.color === 'w' ? 'white' : 'black';
        found.push(`${color} ${this.pieceWord(sq.type as PieceType)} on ${this.squareWord(sq.square)}`);
      }
    }
    if (found.length === 0) return piece ? `There is no ${this.pieceWord(piece)} on the board.` : 'The board is empty.';
    return found.join('. ') + '.';
  }

  private statusText(): string {
    if (this.state.over) return this.state.result ?? 'The game is over.';
    const turn = this.chess.turn() === this.playerColor ? 'You are' : 'The engine is';
    const moveNo = this.chess.moveNumber();
    return `${turn} to move. Move number ${moveNo}. Difficulty ${this.difficulty}.`;
  }

  /** A one-line summary of the position for after each move. */
  private positionSummary(): string {
    if (this.chess.isCheckmate()) return 'Checkmate.';
    if (this.chess.isStalemate()) return 'Stalemate, it is a draw.';
    if (this.chess.isInsufficientMaterial()) return 'Draw by insufficient material.';
    if (this.chess.isThreefoldRepetition()) return 'Draw by repetition.';
    if (this.chess.isDrawByFiftyMoves()) return 'Draw by the fifty move rule.';
    if (this.chess.isCheck()) {
      return `You are ${this.chess.turn() === this.playerColor ? 'in check' : 'giving check'}.`;
    }
    return this.chess.turn() === this.playerColor ? 'Your move.' : 'Engine thinking.';
  }

  private afterMove(): void {
    if (this.chess.isCheckmate()) {
      this.state.over = true;
      const won = this.chess.turn() === this.playerColor;
      this.state.result = won ? 'Checkmate — you win.' : 'Checkmate — the engine wins.';
      this.say(this.state.result);
      return;
    }
    if (this.chess.isStalemate()) {
      this.state.over = true;
      this.state.result = 'Stalemate — draw.';
      this.say('Stalemate. The game is a draw.');
      return;
    }
    if (this.chess.isDraw()) {
      this.state.over = true;
      this.state.result = 'Draw.';
      this.say('The game is a draw.');
      return;
    }
    this.maybeEngineMove();
  }

  private syncPosition(): void {
    this.state.turn = this.chess.turn();
    this.state.fen = this.chess.fen();
    this.state.over = this.chess.isGameOver();
  }

  /* ---------------------------------------------------------------- */
  /* Speech                                                             */
  /* ---------------------------------------------------------------- */

  /** Speak text, serialised so utterances never overlap. */
  private say(text: string): void {
    this.lastSpoken = text;
    this.state.lastSpoken = text;
    this.speechChain = this.speechChain
      .then(async () => {
        // The echo guard mutes the mic for exactly as long as the app is
        // talking, so the app can never hear its own voice-over.
        if (this.asleep) {
          await this.speechOut.speak(text, { interrupt: true });
        } else {
          await this.echoGuard.speak(text, { interrupt: true });
        }
      })
      .catch(() => {
        /* a failed utterance must never break the game loop */
      });
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        /* a broken listener must not break the game */
      }
    }
  }
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
