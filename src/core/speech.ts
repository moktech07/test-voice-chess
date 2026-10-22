/**
 * Speech layer for voice-chess.
 *
 * The app is HEADPHONES-ONLY and EYES-CLOSED: everything the player says must
 * be picked up by the microphone, and everything the app says must be heard by
 * the player. That creates the single most dangerous interaction in the whole
 * app: **the app must never hear itself**.
 *
 * THE TTS/MIC CONTRACT
 * --------------------
 *   1. `SpeechOutput.speak()` resolves when the utterance has finished.
 *   2. `SpeechInput.pause()` uses `recognition.abort()` (NOT `stop()`), which
 *      discards any in-flight utterance so a half-spoken phrase can never be
 *      promoted to a *final* result after the mic comes back.
 *   3. `SpeechInput.resume()` re-starts recognition from scratch.
 *   4. The controller MUST therefore do:
 *
 *          input.pause();
 *          await output.speak('Knight to f3.');
 *          input.resume();
 *
 *      `createEchoGuard()` below wraps exactly that sequence so a caller
 *      cannot get the order wrong.
 *
 * Both `pause()` and `resume()` are idempotent: calling them twice (or
 * calling resume without a prior pause) is harmless.
 *
 * Everything degrades gracefully: on a browser without the Web Speech API
 * (Firefox desktop, old Safari, some webviews) the factories return no-op
 * implementations so the app still runs and can show a clear message.
 */

import type { SpeechInput, SpeechOutput } from './types.ts';

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface SpeechOutputOptions {
  /** Speaking rate, 0.1 - 10 (1 = normal). */
  rate?: number;
  /** Pitch, 0 - 2 (1 = normal). */
  pitch?: number;
  /** Preferred voice name (substring match), e.g. 'Samantha'. */
  voiceHint?: string;
}

export interface SpeechInputOptions {
  /** BCP-47 language tag for recognition. Defaults to 'en-US'. */
  lang?: string;
  /** Called for non-recoverable / noteworthy recognition errors. */
  onError?: (e: Error) => void;
  /** Called whenever the mic goes live or stops listening. */
  onStateChange?: (listening: boolean) => void;
}

/* ------------------------------------------------------------------ */
/* Minimal local typings for the Web Speech recognition API.           */
/*                                                                     */
/* `@types/dom-speech-recognition` is NOT installed and the DOM lib     */
/* does not ship the recognition interfaces, so we declare the bits we   */
/* use here (kept module-local so we cannot clash with the DOM lib).    */
/* ------------------------------------------------------------------ */

interface SRAlternative {
  readonly confidence: number;
  readonly transcript: string;
}

interface SRResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SRAlternative;
  item(index: number): SRAlternative;
}

interface SRResultList {
  readonly length: number;
  [index: number]: SRResult;
  item(index: number): SRResult;
}

interface SRErrorEvent {
  readonly error: string;
  readonly message?: string;
}

interface SRResultEvent {
  readonly resultIndex: number;
  readonly results: SRResultList;
}

interface SRInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((e: unknown) => void) | null;
  onresult: ((e: SRResultEvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: ((e: unknown) => void) | null;
}

type SRCtor = new () => SRInstance;

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_RATE = 1;
const DEFAULT_PITCH = 1;
const DEFAULT_LANG = 'en-US';

/** Chrome silently truncates long utterances after ~15s: keep chunks short. */
const MAX_CHUNK_CHARS = 200;

/** First restart delay after a recoverable recognition error. */
const INITIAL_BACKOFF_MS = 300;
/** Upper bound of the exponential restart backoff. */
const MAX_BACKOFF_MS = 5000;
/** How often we check that the synthesis engine is still alive. */
const KEEPALIVE_INTERVAL_MS = 5000;
/** Chrome's 15s truncation happens around here; nudge the engine before it. */
const NUDGE_AFTER_MS = 12_000;

/** Voice names we consider "good" English voices, best first. */
const PREFERRED_VOICE_PATTERNS = [
  'google',
  'samantha',
  'daniel',
  'karen',
  'microsoft',
  'natural',
  'enhanced',
];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function getWindow(): (Window & typeof globalThis) | undefined {
  return typeof window !== 'undefined' ? window : undefined;
}

function getSynthesis(): SpeechSynthesis | null {
  const w = getWindow() as unknown as { speechSynthesis?: SpeechSynthesis } | undefined;
  const synth = w?.speechSynthesis;
  if (!synth || typeof synth.speak !== 'function') return null;
  return synth;
}

type UtteranceCtor = new (text?: string) => SpeechSynthesisUtterance;

function getUtteranceCtor(): UtteranceCtor | null {
  const w = getWindow() as unknown as { SpeechSynthesisUtterance?: UtteranceCtor } | undefined;
  const fromWindow = w?.SpeechSynthesisUtterance;
  if (typeof fromWindow === 'function') return fromWindow;
  const fromGlobal = (globalThis as unknown as { SpeechSynthesisUtterance?: UtteranceCtor })
    .SpeechSynthesisUtterance;
  return typeof fromGlobal === 'function' ? fromGlobal : null;
}

function getRecognitionCtor(): SRCtor | null {
  const w = getWindow() as unknown as {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  } | undefined;
  const ctor = w?.SpeechRecognition ?? w?.webkitSpeechRecognition;
  if (typeof ctor === 'function') return ctor;
  const g = globalThis as unknown as {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  };
  const gCtor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  return typeof gCtor === 'function' ? gCtor : null;
}

function isInvalidStateError(err: unknown): boolean {
  if (!err) return false;
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return err.name === 'InvalidStateError';
  }
  const name = (err as { name?: string }).name;
  return name === 'InvalidStateError';
}

/** Unref a timer when running under Node so it can never hold the process open. */
function unrefTimer(timer: unknown): void {
  const t = timer as { unref?: () => void } | null;
  if (t && typeof t.unref === 'function') {
    try {
      t.unref();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Chunking                                                            */
/* ------------------------------------------------------------------ */

/**
 * Split `text` into speakable chunks of at most `maxLen` characters.
 *
 * Sentence boundaries are preferred (so the intonation of the engine resets
 * naturally between sentences) and long sentences are broken on word
 * boundaries so we never cut a word in half.
 */
export function chunkSpeechText(text: string, maxLen: number = MAX_CHUNK_CHARS): string[] {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const limit = Math.max(1, maxLen);
  if (clean.length <= limit) return [clean];

  // Sentences keep their terminating punctuation.
  const sentenceRe = /[^.!?]*[.!?]+["')\]]*\s*|[^.!?]+$/g;
  const sentences = clean.match(sentenceRe) ?? [clean];

  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = '';
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (sentence.length > limit) {
      // Sentence is too long on its own: break it on word boundaries.
      flush();
      let wordChunk = '';
      for (const word of sentence.split(' ')) {
        if (!wordChunk) {
          wordChunk = word;
          continue;
        }
        if (wordChunk.length + 1 + word.length <= limit) {
          wordChunk += ' ' + word;
        } else {
          chunks.push(wordChunk);
          wordChunk = word;
        }
      }
      current = wordChunk;
      continue;
    }

    if (!current) {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= limit) {
      current += ' ' + sentence;
    } else {
      flush();
      current = sentence;
    }
  }
  flush();

  return chunks;
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

interface SpeechJob {
  chunks: string[];
  resolve: () => void;
}

export class WebSpeechOutput implements SpeechOutput {
  private readonly rate: number;
  private readonly pitch: number;
  private readonly voiceHint?: string;

  private readonly jobs: SpeechJob[] = [];
  private active: { job: SpeechJob; index: number; gen: number } | null = null;
  /** Bumped on every cancel so stale utterance callbacks are ignored. */
  private gen = 0;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private chunkStartedAt = 0;
  private _speaking = false;

  constructor(opts: SpeechOutputOptions = {}) {
    this.rate = opts.rate ?? DEFAULT_RATE;
    this.pitch = opts.pitch ?? DEFAULT_PITCH;
    this.voiceHint = opts.voiceHint;
  }

  get speaking(): boolean {
    return this._speaking;
  }

  /**
   * Speak `text`. Resolves when the utterance (and every chunk of it) has
   * finished, or immediately when no speech engine is available.
   */
  speak(text: string, opts?: { interrupt?: boolean }): Promise<void> {
    const interrupt = opts?.interrupt !== false;
    if (interrupt) this.cancel();

    const chunks = chunkSpeechText(text, MAX_CHUNK_CHARS);
    return new Promise<void>((resolve) => {
      if (!chunks.length) {
        resolve();
        return;
      }
      this.jobs.push({ chunks, resolve });
      this.pump();
    });
  }

  /** Stop speaking now and resolve every pending speak() promise. */
  cancel(): void {
    this.gen += 1;

    const queued = this.jobs.splice(0, this.jobs.length);
    for (const job of queued) job.resolve();

    if (this.active) {
      this.active.job.resolve();
      this.active = null;
    }

    const synth = getSynthesis();
    if (synth) {
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
    }

    this._speaking = false;
    this.stopKeepAlive();
  }

  /* ---------------------------------------------------------------- */

  private pump(): void {
    if (this.active) return;
    const job = this.jobs.shift();
    if (!job) {
      this._speaking = false;
      this.stopKeepAlive();
      return;
    }
    this._speaking = true;
    this.startKeepAlive();
    const gen = this.gen;
    this.active = { job, index: 0, gen };
    this.speakChunk(job, 0, gen);
  }

  private speakChunk(job: SpeechJob, index: number, gen: number): void {
    // A cancel() happened in the meantime: this chunk is dead.
    if (gen !== this.gen) return;

    if (index >= job.chunks.length) {
      this.active = null;
      job.resolve();
      this.pump();
      return;
    }

    const synth = getSynthesis();
    const Utterance = getUtteranceCtor();
    if (!synth || !Utterance) {
      // No engine: behave like an instant, silent utterance.
      this.active = null;
      job.resolve();
      this.pump();
      return;
    }

    const utterance = new Utterance(job.chunks[index]);
    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
    const voice = this.pickVoice(synth);
    if (voice) utterance.voice = voice;

    utterance.onend = () => {
      if (gen !== this.gen) return;
      this.speakChunk(job, index + 1, gen);
    };
    utterance.onerror = () => {
      if (gen !== this.gen) return;
      // Do not hang: an error ends this utterance for good.
      this.active = null;
      job.resolve();
      this.pump();
    };

    try {
      this.chunkStartedAt = Date.now();
      synth.speak(utterance);
    } catch {
      this.active = null;
      job.resolve();
      this.pump();
    }
  }

  private pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
    let voices: SpeechSynthesisVoice[] = [];
    try {
      voices = synth.getVoices() ?? [];
    } catch {
      voices = [];
    }
    if (!voices.length) return null;

    const hint = this.voiceHint?.trim().toLowerCase();
    if (hint) {
      const hinted = voices.find((v) => (v.name ?? '').toLowerCase().includes(hint));
      if (hinted) return hinted;
    }

    const english = voices.filter((v) => (v.lang ?? '').toLowerCase().startsWith('en'));
    if (!english.length) return voices[0] ?? null;

    const good = english.filter((v) =>
      PREFERRED_VOICE_PATTERNS.some((p) => (v.name ?? '').toLowerCase().includes(p)),
    );
    const pool = good.length ? good : english;
    return pool[0] ?? null;
  }

  /**
   * Chrome pauses (or silently drops) synthesis when the tab is backgrounded
   * and truncates utterances after ~15s. We watch for a paused engine and
   * resume it, and nudge it before Chrome's truncation kicks in.
   */
  private startKeepAlive(): void {
    if (this.keepAlive !== null) return;
    this.keepAlive = setInterval(() => {
      const synth = getSynthesis();
      if (!synth) return;
      try {
        if (synth.paused) {
          synth.resume();
          return;
        }
        if (
          synth.speaking &&
          !synth.pending &&
          Date.now() - this.chunkStartedAt > NUDGE_AFTER_MS
        ) {
          synth.pause();
          synth.resume();
        }
      } catch {
        /* ignore */
      }
    }, KEEPALIVE_INTERVAL_MS);
    unrefTimer(this.keepAlive);
  }

  private stopKeepAlive(): void {
    if (this.keepAlive === null) return;
    clearInterval(this.keepAlive);
    this.keepAlive = null;
  }
}

/* ------------------------------------------------------------------ */
/* Output fallback                                                     */
/* ------------------------------------------------------------------ */

/** A speech output that does nothing but resolves its promises. */
export class NoopSpeechOutput implements SpeechOutput {
  get speaking(): boolean {
    return false;
  }

  speak(text: string, _opts?: { interrupt?: boolean }): Promise<void> {
    void text;
    return Promise.resolve();
  }

  cancel(): void {
    /* nothing to cancel */
  }
}

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export class WebSpeechInput implements SpeechInput {
  private readonly lang: string;
  private readonly onError?: (e: Error) => void;
  private readonly onStateChange?: (listening: boolean) => void;

  private recognition: SRInstance | null = null;
  private onHeard: ((text: string, isFinal: boolean) => void) | null = null;

  /** The user wants to listen (true between start() and stop()). */
  private desired = false;
  /** The mic is muted on purpose (during TTS). */
  private paused = false;
  /** The engine is believed to be running. */
  private running = false;
  /** Results are dropped while this is true (before start / while paused). */
  private dropResults = true;

  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private announcedState = false;

  constructor(opts: SpeechInputOptions = {}) {
    this.lang = opts.lang ?? DEFAULT_LANG;
    this.onError = opts.onError;
    this.onStateChange = opts.onStateChange;
  }

  get listening(): boolean {
    return this.running && this.desired && !this.paused;
  }

  /** Start continuous recognition. Safe to call twice. */
  start(onHeard: (text: string, isFinal: boolean) => void): void {
    this.onHeard = onHeard;
    this.desired = true;
    this.paused = false;
    this.dropResults = false;
    this.backoff = INITIAL_BACKOFF_MS;
    this.ensureRecognition();
    this.startEngine();
  }

  /**
   * Mute the mic. Uses `abort()` so an in-flight phrase is thrown away rather
   * than delivered as a final result after we resume.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dropResults = true;
    this.clearRestart();
    this.running = false;
    this.setState(false);
    const rec = this.recognition;
    if (rec) {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
  }

  /** Un-mute the mic and restart recognition. Safe to call repeatedly. */
  resume(): void {
    if (!this.desired) return; // never started, or stopped for good
    if (!this.paused) {
      this.startEngine();
      return;
    }
    this.paused = false;
    this.dropResults = false;
    this.startEngine();
  }

  /** Stop recognition permanently. */
  stop(): void {
    this.desired = false;
    this.paused = false;
    this.dropResults = true;
    this.clearRestart();
    this.running = false;
    this.setState(false);
    const rec = this.recognition;
    if (rec) {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------------------------------------------------------------- */

  private ensureRecognition(): void {
    if (this.recognition) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    const rec = new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      this.running = true;
      this.setState(true);
    };
    rec.onresult = (e) => this.handleResult(e);
    rec.onerror = (e) => this.handleError(e);
    rec.onend = () => this.handleEnd();
    this.recognition = rec;
  }

  private startEngine(): void {
    if (!this.desired || this.paused) return;
    const rec = this.recognition;
    if (!rec) return;
    try {
      rec.start();
      this.running = true;
      this.backoff = INITIAL_BACKOFF_MS;
      this.setState(true);
    } catch (err) {
      if (isInvalidStateError(err)) {
        // Already started - Chrome throws InvalidStateError. Nothing to do.
        this.running = true;
        this.setState(true);
        return;
      }
      this.running = false;
      this.setState(false);
      this.reportError(err);
      this.scheduleRestart(this.backoff);
      this.growBackoff();
    }
  }

  private handleResult(event: SRResultEvent): void {
    // Anything that arrives while we are muted is dropped: the app must never
    // hear its own speaker (or a half-spoken phrase) as a final result.
    if (this.dropResults || this.paused || !this.desired) return;
    const results = event?.results;
    if (!results) return;
    const from = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
    for (let i = from; i < results.length; i++) {
      const result = results[i];
      if (!result) continue;
      const alternative = result[0];
      const transcript = (alternative?.transcript ?? '').trim();
      if (!transcript) continue;
      const isFinal = result.isFinal === true;
      try {
        this.onHeard?.(transcript, isFinal);
      } catch {
        /* a throwing consumer must not break recognition */
      }
    }
  }

  private handleError(event: SRErrorEvent): void {
    const code = event?.error ?? 'unknown';
    this.running = false;

    if (code === 'not-allowed' || code === 'service-not-allowed') {
      // Permission denied: stop for good, do not hot-loop restarting.
      this.desired = false;
      this.clearRestart();
      this.setState(false);
      this.reportError(
        new Error(
          'Microphone permission denied. Allow microphone access to play by voice.',
        ),
      );
      return;
    }

    if (code === 'no-speech' || code === 'aborted') {
      // Completely normal for a hands-free app: just come back.
      this.scheduleRestart(this.backoff);
      this.growBackoff();
      return;
    }

    // 'network' and anything unknown: recoverable, but worth surfacing.
    this.reportError(new Error(`Speech recognition error: ${code}`));
    this.scheduleRestart(this.backoff);
    this.growBackoff();
  }

  private handleEnd(): void {
    this.running = false;
    this.setState(false);
    if (this.desired && !this.paused) {
      this.scheduleRestart(this.backoff);
    }
  }

  private scheduleRestart(delay: number): void {
    if (!this.desired || this.paused) return;
    this.clearRestart();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.desired || this.paused) return;
      this.startEngine();
    }, delay);
    unrefTimer(this.restartTimer);
  }

  private clearRestart(): void {
    if (this.restartTimer === null) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private growBackoff(): void {
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private setState(listening: boolean): void {
    if (this.announcedState === listening) return;
    this.announcedState = listening;
    try {
      this.onStateChange?.(listening);
    } catch {
      /* ignore */
    }
  }

  private reportError(err: unknown): void {
    const error =
      err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Speech error');
    try {
      this.onError?.(error);
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Input fallback                                                      */
/* ------------------------------------------------------------------ */

/** A recognition stub for browsers without the Web Speech recognition API. */
export class NoopSpeechInput implements SpeechInput {
  get listening(): boolean {
    return false;
  }

  /** Never throws; simply never hears anything. */
  start(_onHeard: (text: string, isFinal: boolean) => void): void {
    /* no recognition available */
  }

  pause(): void {
    /* no-op */
  }

  resume(): void {
    /* no-op */
  }

  stop(): void {
    /* no-op */
  }
}

/* ------------------------------------------------------------------ */
/* Support probes + factories                                          */
/* ------------------------------------------------------------------ */

export function isSpeechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export function isSpeechSynthesisSupported(): boolean {
  return getSynthesis() !== null;
}

/** Describes why speech is unavailable, for the UI. */
export function speechSupportReport(): {
  input: boolean;
  output: boolean;
  reason?: string;
} {
  const input = isSpeechRecognitionSupported();
  const output = isSpeechSynthesisSupported();
  const reasons: string[] = [];
  if (!input) {
    reasons.push(
      'Speech recognition is not available in this browser (voice input disabled).',
    );
  }
  if (!output) {
    reasons.push('Speech synthesis is not available in this browser (no spoken output).');
  }
  return {
    input,
    output,
    reason: reasons.length ? reasons.join(' ') : undefined,
  };
}

/** Best available speech output for the current browser. */
export function createSpeechOutput(opts?: SpeechOutputOptions): SpeechOutput {
  if (isSpeechSynthesisSupported()) return new WebSpeechOutput(opts);
  return new NoopSpeechOutput();
}

/** Best available speech input for the current browser. */
export function createSpeechInput(opts?: SpeechInputOptions): SpeechInput {
  if (isSpeechRecognitionSupported()) return new WebSpeechInput(opts);
  return new NoopSpeechInput();
}

/* ------------------------------------------------------------------ */
/* Echo guard                                                          */
/* ------------------------------------------------------------------ */

export interface EchoGuard {
  /** Speak `text` with the mic muted, then unmute. */
  speak(text: string, opts?: { interrupt?: boolean }): Promise<void>;
  /** Speak `text` and wait for the mic to be live again. */
  say(text: string, opts?: { interrupt?: boolean }): Promise<void>;
}

/**
 * Binds an input and an output together so the app can never hear itself:
 * the mic is muted for exactly as long as the app is talking.
 */
export function createEchoGuard(input: SpeechInput, output: SpeechOutput): EchoGuard {
  let suspended = false;

  const speak = async (text: string, opts?: { interrupt?: boolean }): Promise<void> => {
    const wasListening = input.listening;
    if (wasListening) {
      input.pause();
      suspended = true;
    }
    try {
      await output.speak(text, opts);
    } finally {
      if (suspended) {
        suspended = false;
        input.resume();
      }
    }
  };

  return { speak, say: speak };
}
