import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NoopSpeechInput,
  WebSpeechInput,
  WebSpeechOutput,
  chunkSpeechText,
  createEchoGuard,
  createSpeechInput,
  createSpeechOutput,
  isSpeechRecognitionSupported,
  isSpeechSynthesisSupported,
  speechSupportReport,
} from '../../src/core/speech.ts';

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

class FakeUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  constructor(text = '') {
    this.text = text;
  }
}

class FakeSynthesis {
  spoken: FakeUtterance[] = [];
  cancelCount = 0;
  paused = false;
  speaking = false;
  pending = false;
  voices: Array<{ name: string; lang: string; default?: boolean }> = [
    { name: 'Alex', lang: 'en-US' },
    { name: 'Google US English', lang: 'en-US' },
    { name: 'Marlene', lang: 'de-DE' },
  ];

  speak(u: FakeUtterance): void {
    this.spoken.push(u);
    this.speaking = true;
    u.onstart?.();
  }

  cancel(): void {
    this.cancelCount += 1;
    this.spoken.length = 0;
    this.speaking = false;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  getVoices(): Array<{ name: string; lang: string; default?: boolean }> {
    return this.voices;
  }
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];

  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;

  startCount = 0;
  abortCount = 0;
  stopCount = 0;

  onstart: (() => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    this.startCount += 1;
    this.onstart?.();
  }

  abort(): void {
    this.abortCount += 1;
    this.onend?.();
  }

  stop(): void {
    this.stopCount += 1;
    this.onend?.();
  }

  /* helpers to simulate the engine */
  emit(transcripts: Array<{ text: string; isFinal: boolean }>): void {
    const results = transcripts.map((t) => ({
      isFinal: t.isFinal,
      length: 1,
      0: { confidence: 0.9, transcript: t.text },
      item: () => ({ confidence: 0.9, transcript: t.text }),
    }));
    this.onresult?.({ resultIndex: 0, results });
  }

  emitError(error: string): void {
    this.onerror?.({ error });
  }

  emitEnd(): void {
    this.onend?.();
  }
}

const g = globalThis as unknown as {
  window?: Record<string, unknown>;
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
};

function installWindow(opts: {
  synthesis?: boolean;
  recognition?: boolean;
  voices?: FakeSynthesis['voices'];
}): void {
  const win: Record<string, unknown> = {};
  if (opts.synthesis !== false) {
    const synth = new FakeSynthesis();
    if (opts.voices) synth.voices = opts.voices;
    win.speechSynthesis = synth;
    win.SpeechSynthesisUtterance = FakeUtterance;
  }
  if (opts.recognition !== false) {
    win.SpeechRecognition = FakeRecognition;
  }
  g.window = win;
}

function uninstallWindow(): void {
  delete g.window;
  delete g.SpeechRecognition;
  delete g.webkitSpeechRecognition;
}

function synth(): FakeSynthesis {
  return g.window!.speechSynthesis as FakeSynthesis;
}

function rec(): FakeRecognition {
  return FakeRecognition.instances[FakeRecognition.instances.length - 1];
}

/** Let queued microtasks (promise callbacks) run. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/* ------------------------------------------------------------------ */

beforeEach(() => {
  FakeRecognition.instances = [];
  installWindow({});
});

afterEach(() => {
  vi.useRealTimers();
  uninstallWindow();
});

describe('chunkSpeechText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkSpeechText('Knight to f3.')).toEqual(['Knight to f3.']);
  });

  it('returns nothing for empty text', () => {
    expect(chunkSpeechText('   ')).toEqual([]);
  });

  it('splits long text on sentence boundaries', () => {
    const sentence = 'The bishop is blocked on the long diagonal. ';
    const text = sentence.repeat(5);
    const chunks = chunkSpeechText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it('never splits a word in half', () => {
    const words = Array.from({ length: 120 }, (_, i) => `square${i}`);
    const chunks = chunkSpeechText(words.join(' '), 50);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(50);
      for (const w of c.split(' ')) expect(words).toContain(w);
    }
  });
});

describe('WebSpeechOutput', () => {
  it('resolves after onend fires', async () => {
    const out = new WebSpeechOutput();
    let done = false;
    const p = out.speak('Pawn to e4').then(() => {
      done = true;
    });

    expect(out.speaking).toBe(true);
    expect(synth().spoken).toHaveLength(1);
    expect(synth().spoken[0].text).toBe('Pawn to e4');

    await flush();
    expect(done).toBe(false);

    synth().spoken[0].onend?.();
    await p;
    expect(done).toBe(true);
    expect(out.speaking).toBe(false);
  });

  it('chunks long text and resolves only after ALL chunks finish', async () => {
    const out = new WebSpeechOutput();
    const long = 'The knight leaps to f3 with a sudden grace. '.repeat(6);
    let done = false;
    const p = out.speak(long).then(() => {
      done = true;
    });

    // Only the first chunk is in flight initially.
    expect(synth().spoken).toHaveLength(1);
    await flush();
    expect(done).toBe(false);

    // Each onend starts exactly the next chunk; the promise stays pending
    // until the very last one ends.
    let guard = 0;
    while (!done && guard++ < 50) {
      const last = synth().spoken[synth().spoken.length - 1];
      expect(last).toBeDefined();
      last.onend?.();
      await flush();
      if (!done) expect(synth().spoken.length).toBeGreaterThan(0);
    }

    await p;
    expect(done).toBe(true);
    expect(synth().spoken.length).toBeGreaterThan(1);
    expect(out.speaking).toBe(false);

    // Every chunk is under the 200 char limit and the text is preserved.
    for (const u of synth().spoken) expect(u.text.length).toBeLessThanOrEqual(200);
    const rebuilt = synth().spoken.map((u) => u.text).join(' ');
    expect(rebuilt.replace(/\s+/g, ' ').trim()).toBe(long.replace(/\s+/g, ' ').trim());
  });

  it('cancel() stops the utterance and resolves pending promises (no dangling promise)', async () => {
    const out = new WebSpeechOutput();
    let first = false;
    let second = false;
    const p1 = out.speak('One').then(() => {
      first = true;
    });
    const p2 = out.speak('Two').then(() => {
      second = true;
    });

    await flush();
    // The second speak() interrupted the first one.
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(synth().cancelCount).toBeGreaterThan(0);

    out.cancel();
    await flush();
    await Promise.all([p1, p2]);
    expect(second).toBe(true);
    expect(out.speaking).toBe(false);
  });

  it('cancel() on a quiet output still resolves the pending promise', async () => {
    const out = new WebSpeechOutput();
    let resolved = false;
    const p = out.speak('Knight takes f3').then(() => {
      resolved = true;
    });
    await flush();
    out.cancel();
    await p;
    expect(resolved).toBe(true);
  });

  it('resolves (does not hang) when the utterance errors', async () => {
    const out = new WebSpeechOutput();
    const p = out.speak('Broken');
    synth().spoken[0].onerror?.({ error: 'synthesis-failed' });
    await p;
    expect(out.speaking).toBe(false);
  });

  it('speak() with no speechSynthesis available resolves and does not throw', async () => {
    uninstallWindow();
    const out = new WebSpeechOutput();
    await expect(out.speak('Anything at all')).resolves.toBeUndefined();
    expect(out.speaking).toBe(false);
    expect(() => out.cancel()).not.toThrow();
  });

  it('prefers a good english voice', () => {
    const out = new WebSpeechOutput();
    out.speak('Hello');
    expect(synth().spoken[0].voice).toEqual(
      expect.objectContaining({ name: 'Google US English' }),
    );
  });

  it('honours a voiceHint', () => {
    const out = new WebSpeechOutput({ voiceHint: 'Alex' });
    out.speak('Hello');
    expect(synth().spoken[0].voice).toEqual(expect.objectContaining({ name: 'Alex' }));
  });
});

describe('support probes and factories', () => {
  it('reports support', () => {
    expect(isSpeechSynthesisSupported()).toBe(true);
    expect(isSpeechRecognitionSupported()).toBe(true);
    const report = speechSupportReport();
    expect(report.input).toBe(true);
    expect(report.output).toBe(true);
    expect(report.reason).toBeUndefined();
  });

  it('reports why speech is unavailable', () => {
    uninstallWindow();
    expect(isSpeechSynthesisSupported()).toBe(false);
    expect(isSpeechRecognitionSupported()).toBe(false);
    const report = speechSupportReport();
    expect(report.input).toBe(false);
    expect(report.output).toBe(false);
    expect(report.reason).toBeTruthy();
  });

  it('createSpeechOutput falls back to a no-op', async () => {
    uninstallWindow();
    const out = createSpeechOutput();
    await expect(out.speak('quiet')).resolves.toBeUndefined();
    expect(out.speaking).toBe(false);
  });

  it('createSpeechInput falls back to a harmless no-op', () => {
    uninstallWindow();
    const input = createSpeechInput();
    expect(input).toBeInstanceOf(NoopSpeechInput);
    expect(input.listening).toBe(false);
    expect(() => input.start(() => {})).not.toThrow();
    expect(() => input.pause()).not.toThrow();
    expect(() => input.resume()).not.toThrow();
    expect(() => input.stop()).not.toThrow();
  });
});

describe('WebSpeechInput', () => {
  it('start() creates the recognition instance and starts it', () => {
    const input = new WebSpeechInput();
    input.start(() => {});
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(rec().startCount).toBe(1);
    expect(rec().continuous).toBe(true);
    expect(rec().interimResults).toBe(true);
    expect(rec().lang).toBe('en-US');
    expect(input.listening).toBe(true);
  });

  it('delivers results with the correct isFinal flags', () => {
    const heard: Array<[string, boolean]> = [];
    const input = new WebSpeechInput();
    input.start((text, isFinal) => heard.push([text, isFinal]));

    rec().emit([{ text: 'knight', isFinal: false }]);
    expect(heard).toEqual([['knight', false]]);

    rec().emit([{ text: 'knight to f3', isFinal: true }]);
    expect(heard).toEqual([
      ['knight', false],
      ['knight to f3', true],
    ]);
  });

  it('no-speech error triggers a restart after a short delay', () => {
    vi.useFakeTimers();
    const input = new WebSpeechInput();
    input.start(() => {});
    expect(rec().startCount).toBe(1);

    rec().emitError('no-speech');
    expect(rec().startCount).toBe(1); // not yet

    vi.advanceTimersByTime(300);
    expect(rec().startCount).toBe(2);
  });

  it('backs off exponentially on repeated recoverable errors', () => {
    vi.useFakeTimers();
    const input = new WebSpeechInput();
    input.start(() => {});

    rec().emitError('no-speech');
    vi.advanceTimersByTime(300);
    expect(rec().startCount).toBe(2);

    rec().emitError('no-speech');
    vi.advanceTimersByTime(300); // 300 is no longer enough
    expect(rec().startCount).toBe(2);
    vi.advanceTimersByTime(300);
    expect(rec().startCount).toBe(3);
  });

  it('not-allowed error does NOT restart and reports via onError', () => {
    vi.useFakeTimers();
    const errors: Error[] = [];
    const input = new WebSpeechInput({ onError: (e) => errors.push(e) });
    input.start(() => {});

    rec().emitError('not-allowed');
    vi.advanceTimersByTime(10_000);

    expect(rec().startCount).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/permission/i);
    expect(input.listening).toBe(false);
  });

  it('service-not-allowed is treated as a permission denial too', () => {
    vi.useFakeTimers();
    const errors: Error[] = [];
    const input = new WebSpeechInput({ onError: (e) => errors.push(e) });
    input.start(() => {});
    rec().emitError('service-not-allowed');
    vi.advanceTimersByTime(10_000);
    expect(rec().startCount).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('network error restarts and reports', () => {
    vi.useFakeTimers();
    const errors: Error[] = [];
    const input = new WebSpeechInput({ onError: (e) => errors.push(e) });
    input.start(() => {});
    rec().emitError('network');
    vi.advanceTimersByTime(300);
    expect(rec().startCount).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/network/);
  });

  it('pause() aborts and drops in-flight results; resume() starts again', () => {
    const heard: Array<[string, boolean]> = [];
    const input = new WebSpeechInput();
    input.start((t, f) => heard.push([t, f]));

    input.pause();
    expect(rec().abortCount).toBe(1);
    expect(input.listening).toBe(false);

    // Anything that arrives while muted is discarded (never promoted to final).
    rec().emit([{ text: 'knight to f3', isFinal: true }]);
    expect(heard).toEqual([]);

    input.resume();
    expect(rec().startCount).toBe(2);
    expect(input.listening).toBe(true);

    rec().emit([{ text: 'pawn to e4', isFinal: true }]);
    expect(heard).toEqual([['pawn to e4', true]]);
  });

  it('pause() while interim speech is in flight never delivers it as final', () => {
    const heard: Array<[string, boolean]> = [];
    const input = new WebSpeechInput();
    input.start((t, f) => heard.push([t, f]));

    rec().emit([{ text: 'knight to', isFinal: false }]);
    expect(heard).toEqual([['knight to', false]]);

    input.pause();
    rec().emit([{ text: 'knight to f3', isFinal: true }]);
    expect(heard).toEqual([['knight to', false]]);

    input.resume();
    rec().emit([{ text: 'knight to f3', isFinal: true }]);
    expect(heard).toEqual([
      ['knight to', false],
      ['knight to f3', true],
    ]);
  });

  it('pause() and resume() are idempotent', () => {
    const input = new WebSpeechInput();
    input.start(() => {});
    input.pause();
    input.pause();
    expect(rec().abortCount).toBe(1);
    input.resume();
    input.resume();
    expect(rec().startCount).toBe(2);
    expect(input.listening).toBe(true);
  });

  it('onend while enabled triggers a restart', () => {
    vi.useFakeTimers();
    const input = new WebSpeechInput();
    input.start(() => {});
    expect(rec().startCount).toBe(1);

    rec().emitEnd();
    vi.advanceTimersByTime(300);
    expect(rec().startCount).toBe(2);
  });

  it('onend while paused does NOT restart', () => {
    vi.useFakeTimers();
    const input = new WebSpeechInput();
    input.start(() => {});
    input.pause();
    rec().emitEnd();
    vi.advanceTimersByTime(10_000);
    expect(rec().startCount).toBe(1);
  });

  it('stop() prevents any further restarts', () => {
    vi.useFakeTimers();
    const input = new WebSpeechInput();
    input.start(() => {});
    input.stop();
    rec().emitEnd();
    rec().emitError('no-speech');
    vi.advanceTimersByTime(10_000);
    expect(rec().startCount).toBe(1);
    expect(input.listening).toBe(false);
  });

  it('reports state changes', () => {
    const states: boolean[] = [];
    const input = new WebSpeechInput({ onStateChange: (l) => states.push(l) });
    input.start(() => {});
    expect(states).toEqual([true]);
    input.pause();
    expect(states).toEqual([true, false]);
    input.resume();
    expect(states).toEqual([true, false, true]);
  });
});

describe('createEchoGuard', () => {
  it('mutes the mic while the app talks and unmutes afterwards', async () => {
    const heard: string[] = [];
    const input = new WebSpeechInput();
    const output = new WebSpeechOutput();
    input.start((t) => heard.push(t));

    const guard = createEchoGuard(input, output);
    const p = guard.speak('Knight to f3');

    // Mic is muted while speaking.
    expect(input.listening).toBe(false);
    expect(rec().abortCount).toBe(1);

    // The app "hears" its own voice while muted -> discarded.
    rec().emit([{ text: 'Knight to f3', isFinal: true }]);
    expect(heard).toEqual([]);

    synth().spoken[0].onend?.();
    await p;

    // Mic is live again.
    expect(input.listening).toBe(true);
    expect(rec().startCount).toBe(2);

    rec().emit([{ text: 'pawn to e4', isFinal: true }]);
    expect(heard).toEqual(['pawn to e4']);
  });
});
