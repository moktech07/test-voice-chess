import { describe, expect, it, vi } from 'vitest';
import { VoiceChessController } from '../../src/core/controller.ts';
import type {
  Engine,
  EngineMove,
  GameViewState,
  SpeechInput,
  SpeechOutput,
} from '../../src/core/types.ts';

/* ------------------------------------------------------------------ */
/* Test doubles                                                        */
/* ------------------------------------------------------------------ */

class FakeEngine implements Engine {
  ready = false;
  difficulty = 2;
  /** Moves the engine will play, in order. */
  replies: EngineMove[] = [];
  /** Resolvers for in-flight searches, so tests can control timing. */
  pendingSearch: { resolve: (m: EngineMove) => void } | null = null;

  async init(): Promise<void> {
    this.ready = true;
  }
  setDifficulty(level: number): void {
    this.difficulty = level;
  }
  async search(fen: string): Promise<EngineMove> {
    const next = this.replies.shift();
    if (!next) return { from: 'e7', to: 'e5' };
    return next;
  }
  stop(): void {}
  dispose(): void {}
}

class FakeSpeechOutput implements SpeechOutput {
  spoken: string[] = [];
  speaking = false;
  async speak(text: string): Promise<void> {
    this.spoken.push(text);
    this.speaking = true;
    await Promise.resolve();
    this.speaking = false;
  }
  cancel(): void {}
}

class FakeSpeechInput implements SpeechInput {
  listening = false;
  paused = false;
  /** True when the mic was paused while the app was speaking. */
  selfHeard = false;
  onHeard: ((t: string, f: boolean) => void) | null = null;

  start(onHeard: (t: string, f: boolean) => void): void {
    this.listening = true;
    this.onHeard = onHeard;
  }
  pause(): void {
    this.paused = true;
    this.listening = false;
  }
  resume(): void {
    this.paused = false;
    this.listening = true;
  }
  stop(): void {
    this.listening = false;
  }
  /** Simulate the player speaking. */
  say(text: string): void {
    this.onHeard?.(text, true);
  }
}

/** Let the microtask queue drain so awaited promises settle. */
const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function makeController() {
  const engine = new FakeEngine();
  const out = new FakeSpeechOutput();
  const input = new FakeSpeechInput();
  const controller = new VoiceChessController({
    engine,
    speechOut: out,
    speechIn: input,
    playerColor: 'w',
    difficulty: 2,
  });
  return { controller, engine, out, input };
}

/**
 * The engine always replies, so a test that only cares about the player's
 * move must look at the history *before* the engine has answered. This
 * helper returns the player's own moves only.
 */
const playerMoves = (controller: VoiceChessController): string[] => {
  const history = controller.getState().history;
  // The engine plays the odd-indexed plies (white = player).
  return history.filter((_, i) => i % 2 === 0);
};

/** The last thing the app said. */
const lastSpoken = (out: FakeSpeechOutput): string => out.spoken[out.spoken.length - 1] ?? '';

/* ------------------------------------------------------------------ */

describe('VoiceChessController', () => {
  it('starts and greets the player', async () => {
    const { controller, engine, out } = makeController();
    await controller.start();
    await flush();

    expect(engine.ready).toBe(true);
    expect(out.spoken.join(' ')).toMatch(/welcome/i);
  });

  it('accepts a spoken move and plays it', async () => {
    const { controller, out } = makeController();
    await controller.start();
    await flush();

    controller.handleUtterance('e4');
    await flush();

    // The engine answers with e5, so the full history is two plies.
    expect(playerMoves(controller)).toEqual(['e4']);
    expect(controller.getState().history).toContain('e4');
    // The app announced the player's move before the engine replied.
    expect(out.spoken.some((s) => /e4/i.test(s))).toBe(true);
  });

  it('replies with an engine move and hands the turn back', async () => {
    const { controller, engine, out } = makeController();
    engine.replies = [{ from: 'e7', to: 'e5' }];
    await controller.start();
    await flush();

    controller.handleUtterance('e4');
    await flush(30);

    const state = controller.getState();
    expect(state.history).toEqual(['e4', 'e5']);
    expect(state.turn).toBe('w');
    expect(lastSpoken(out)).toMatch(/engine plays/i);
  });

  it('refuses a move that is not legal', async () => {
    const { controller, out } = makeController();
    await controller.start();
    await flush();

    controller.handleUtterance('e5');
    await flush();

    expect(controller.getState().history).toEqual([]);
    expect(lastSpoken(out)).toMatch(/not a legal move|not legal|did not|cannot|no /i);
  });

  it('asks which piece when two different pieces can move to the same square', async () => {
    const { controller, out } = makeController();
    await controller.start();
    await flush();

    // Pawn on d3 and knight on f3 can both reach d4 — different piece types,
    // so the app must ask which one.
    controller.loadPosition('4k3/8/8/8/8/3P1N2/8/4K3 w - - 0 1');

    controller.handleUtterance('d4');
    await flush(30);

    const state = controller.getState();
    expect(state.pendingQuestion).toBeTruthy();
    expect(state.pendingQuestion?.reason).toBe('piece');
    expect(lastSpoken(out)).toMatch(/which one/i);
  });

  it('asks which square when two knights can reach the same square', async () => {
    const { controller, out } = makeController();
    await controller.start();
    await flush();

    // Knights on d2 and h2 both reach f3 — same piece, two origins.
    controller.loadPosition('4k3/8/8/8/8/8/3N3N/4K3 w - - 0 1');

    controller.handleUtterance('f3');
    await flush(30);

    const state = controller.getState();
    expect(state.pendingQuestion).toBeTruthy();
    expect(state.pendingQuestion?.reason).toBe('square');
    expect(lastSpoken(out)).toMatch(/which one/i);
  });

  it('resolves a disambiguation when the player answers with the piece', async () => {
    const { controller, out } = makeController();
    await controller.start();
    await flush();

    controller.loadPosition('4k3/8/8/8/8/3P1N2/8/4K3 w - - 0 1');
    controller.handleUtterance('d4');
    await flush(30);
    expect(controller.getState().pendingQuestion).toBeTruthy();

    controller.handleUtterance('knight');
    await flush(30);

    expect(controller.getState().pendingQuestion).toBeFalsy();
    // The knight moved: the player now has a knight on d4.
    expect(controller.getState().fen).toMatch(/3N4/);
    expect(lastSpoken(out)).not.toMatch(/which one/i);
  });

  it('resolves a disambiguation when the player answers with the square', async () => {
    const { controller, out } = makeController();
    await controller.start();
    await flush();

    controller.loadPosition('4k3/8/8/8/8/8/3N3N/4K3 w - - 0 1');
    controller.handleUtterance('f3');
    await flush(30);
    expect(controller.getState().pendingQuestion).toBeTruthy();

    controller.handleUtterance('h two');
    await flush(30);

    expect(controller.getState().pendingQuestion).toBeFalsy();
    // The h2 knight moved to f3 (not the d2 knight).
    expect(controller.getState().fen).toMatch(/5N2/);
  });

  it('undo takes back the player move and the engine reply', async () => {
    const { controller, engine } = makeController();
    engine.replies = [{ from: 'e7', to: 'e5' }];
    await controller.start();
    await flush();

    controller.handleUtterance('e4');
    await flush(30);
    expect(controller.getState().history).toEqual(['e4', 'e5']);

    controller.handleUtterance('undo');
    await flush(30);

    expect(controller.getState().history).toEqual([]);
    expect(controller.getState().turn).toBe('w');
  });

  it('new game resets the position', async () => {
    const { controller } = makeController();
    await controller.start();
    await flush();

    controller.handleUtterance('e4');
    await flush(30);

    controller.handleUtterance('new game');
    await flush(30);

    const state = controller.getState();
    expect(state.history).toEqual([]);
    expect(state.fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(state.over).toBe(false);
  });

  it('reads the board out loud', async () => {
    const { controller, out } = makeController();
    await controller.start();
    await flush();

    controller.handleUtterance('read the board');
    await flush();

    expect(lastSpoken(out)).toMatch(/rank eight/i);
    expect(lastSpoken(out)).toMatch(/rook|knight|bishop|queen|king|pawn/i);
  });

  it('answers "where is the queen"', async () => {
    const { controller, out } = makeController();
    await controller.start();
    await flush();

    controller.handleUtterance('where is the queen');
    await flush();

    expect(lastSpoken(out)).toMatch(/queen/i);
    expect(lastSpoken(out)).toMatch(/d one|d 1|one/i);
  });

  it('reports status', async () => {
    const { controller, out } = makeController();
    await controller.start();
    await flush();

    controller.handleUtterance('status');
    await flush();

    expect(lastSpoken(out)).toMatch(/to move/i);
  });

  it('repeats the last thing it said', async () => {
    const { controller, out } = makeController();
    await controller.start();
    await flush();

    controller.handleUtterance('status');
    await flush();
    const before = out.spoken.length;

    controller.handleUtterance('repeat');
    await flush();

    expect(out.spoken.length).toBe(before + 1);
    expect(lastSpoken(out)).toMatch(/to move/i);
  });

  it('resigns', async () => {
    const { controller, out } = makeController();
    await controller.start();
    await flush();

    controller.handleUtterance('resign');
    await flush();

    expect(controller.getState().over).toBe(true);
    expect(lastSpoken(out)).toMatch(/resign/i);
  });

  it('pauses the mic while speaking so it does not hear itself', async () => {
    const { controller, out, input } = makeController();
    await controller.start();
    await flush();

    const order: string[] = [];
    const originalSpeak = out.speak.bind(out);
    out.speak = async (text: string) => {
      order.push(`speak-start:${input.listening ? 'listening' : 'paused'}`);
      await originalSpeak(text);
      order.push(`speak-end:${input.listening ? 'listening' : 'paused'}`);
    };

    controller.handleUtterance('status');
    await flush(30);

    // The mic must be paused while the utterance is in flight.
    expect(order[0]).toBe('speak-start:paused');
    // And restored afterwards.
    expect(input.listening).toBe(true);
  });

  it('sleep pauses the mic and wake resumes it', async () => {
    const { controller, input } = makeController();
    await controller.start();
    await flush();

    controller.handleUtterance('sleep');
    await flush(30);
    expect(input.listening).toBe(false);

    controller.handleUtterance('wake up');
    await flush(30);
    expect(input.listening).toBe(true);
  });

  it('survives an engine that fails to search', async () => {
    const { controller, engine, out } = makeController();
    engine.search = async () => {
      throw new Error('boom');
    };
    await controller.start();
    await flush();

    controller.handleUtterance('e4');
    await flush(40);

    expect(controller.getState().thinking).toBe(false);
    expect(lastSpoken(out)).toMatch(/problem|restart/i);
  });

  it('notifies subscribers of state changes', async () => {
    const { controller } = makeController();
    const seen: GameViewState[] = [];
    const unsub = controller.subscribe((s) => seen.push(s));

    await controller.start();
    await flush();
    controller.handleUtterance('e4');
    await flush(30);

    expect(seen.length).toBeGreaterThan(1);
    expect(playerMoves(controller)).toEqual(['e4']);
    unsub();
  });
});
