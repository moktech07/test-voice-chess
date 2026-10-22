import './style.css';
import { VoiceChessController } from './core/controller.ts';
import { createEngine } from './core/engine.ts';
import { createSpeechInput, createSpeechOutput, speechSupportReport } from './core/speech.ts';
import type { GameViewState } from './core/types.ts';
import { renderBoard } from './ui/board.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const els = {
  micDot: $('mic-dot'),
  statusText: $('status-text'),
  turn: $('turn'),
  board: $('board'),
  heard: $('heard-text'),
  said: $('said-text'),
  hint: $('hint'),
  start: $<HTMLButtonElement>('btn-start'),
  undo: $<HTMLButtonElement>('btn-undo'),
  newGame: $<HTMLButtonElement>('btn-new'),
  read: $<HTMLButtonElement>('btn-read'),
  help: $<HTMLButtonElement>('btn-help'),
  level: $<HTMLInputElement>('level'),
  levelLabel: $('level-label'),
};

const engine = createEngine();
const speechOut = createSpeechOutput();
const speechIn = createSpeechInput();

const controller = new VoiceChessController({
  engine,
  speechOut,
  speechIn,
  playerColor: 'w',
  difficulty: Number(els.level.value),
});

const support = speechSupportReport();
if (!support.input) {
  els.hint.textContent =
    'Voice input is not available in this browser. On Chrome for Android or iOS Safari it works.';
}

let lastFen = '';

controller.subscribe((state: GameViewState) => {
  // Board
  if (state.fen !== lastFen) {
    lastFen = state.fen;
    renderBoard(els.board, state.fen, state.history);
  }

  // Turn + status
  if (state.over) {
    els.turn.textContent = state.result ?? 'Game over';
  } else if (state.thinking) {
    els.turn.textContent = 'Engine thinking…';
  } else {
    els.turn.textContent = state.turn === state.playerColor ? 'Your move' : 'Engine move';
  }

  els.micDot.className = `dot${state.thinking ? ' dot--busy' : ' dot--live'}`;

  // Transcript
  if (state.lastHeard && els.heard.textContent !== state.lastHeard) {
    els.heard.textContent = state.lastHeard;
  }
  if (state.lastSpoken && els.said.textContent !== state.lastSpoken) {
    els.said.textContent = state.lastSpoken;
  }

  // Hints
  if (state.pendingQuestion) {
    els.hint.textContent = state.pendingQuestion.text;
  } else if (state.over) {
    els.hint.textContent = 'Game over. Say “new game” to play again.';
  } else if (!state.thinking && state.turn === state.playerColor) {
    els.hint.textContent = 'Say a move like “knight takes f three”. Say “help” for commands.';
  } else {
    els.hint.textContent = 'Engine thinking…';
  }

  els.undo.disabled = state.history.length === 0;
});

/* ------------------------------------------------------------------ */
/* Buttons — these are conveniences. The game is fully voice-driven.  */
/* ------------------------------------------------------------------ */

els.start.addEventListener('click', () => {
  els.start.disabled = true;
  els.statusText.textContent = 'Loading engine…';
  void controller.start().then(
    () => {
      els.statusText.textContent = 'Listening';
      els.start.hidden = true;
    },
    (err) => {
      els.statusText.textContent = 'Engine failed to start';
      els.hint.textContent = `Could not start the engine: ${err?.message ?? err}`;
      els.start.disabled = false;
    },
  );
});

els.undo.addEventListener('click', () => controller.undo());
els.newGame.addEventListener('click', () => controller.newGame());
els.read.addEventListener('click', () => controller.handleUtterance('read the board'));
els.help.addEventListener('click', () => controller.handleUtterance('help'));

els.level.addEventListener('input', () => {
  els.levelLabel.textContent = els.level.value;
});
els.level.addEventListener('change', () => {
  controller.handleUtterance(`difficulty ${els.level.value}`);
});

/* Keep the screen awake during a game — the user has their eyes closed. */
let wakeLock: WakeLockSentinel | null = null;
async function acquireWakeLock(): Promise<void> {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    /* wake lock is a nice-to-have */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && els.start.hidden) void acquireWakeLock();
});
