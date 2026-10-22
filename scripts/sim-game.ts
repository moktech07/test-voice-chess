/**
 * Simulates a full spoken game to sanity-check the voice loop end to end.
 * Prints every utterance the player "says" and every line the app speaks.
 */
import { VoiceChessController } from '../src/core/controller.ts';
import type { Engine, EngineMove, SpeechInput, SpeechOutput } from '../src/core/types.ts';

const spoken: string[] = [];
let heard: ((t: string, f: boolean) => void) | null = null;

const out: SpeechOutput = {
  async speak(text: string) {
    spoken.push(text);
  },
  cancel() {},
  get speaking() {
    return false;
  },
};

const input: SpeechInput = {
  start(cb: (t: string, f: boolean) => void) {
    heard = cb;
  },
  pause() {},
  resume() {},
  stop() {},
  get listening() {
    return true;
  },
};

/** A deterministic stand-in engine: plays a scripted reply. */
const replies: EngineMove[] = [];
const engine: Engine = {
  ready: true,
  async init() {},
  setDifficulty() {},
  async search(fen: string) {
    const scripted = replies.shift();
    if (scripted) return scripted;
    // Fall back to the first legal move in the position.
    const { Chess } = await import('chess.js');
    const c = new Chess(fen);
    const moves = c.moves({ verbose: true });
    const m = moves[0] as { from: string; to: string; promotion?: string } | undefined;
    return m ? { from: m.from, to: m.to, promotion: m.promotion } : { from: 'e7', to: 'e5' };
  },
  stop() {},
  dispose() {},
};

const controller = new VoiceChessController({
  engine,
  speechOut: out,
  speechIn: input,
  playerColor: 'w',
  difficulty: 2,
});

const flush = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

async function say(text: string): Promise<void> {
  spoken.length = 0;
  heard?.(text, true);
  await flush();
  console.log(`  YOU: "${text}"`);
  for (const s of spoken) console.log(`  APP: "${s}"`);
  console.log();
}

await controller.start();
await flush();

console.log('=== A NORMAL GAME ===');
replies.push({ from: 'e7', to: 'e5' });
await say('e4');
replies.push({ from: 'b8', to: 'c6' });
await say('knight takes f3');
replies.push({ from: 'g8', to: 'f6' });
await say('bishop c4');

console.log('=== A COMMAND ===');
await say('status');
await say('where is the queen');
await say('read the board');

console.log('=== AMBIGUITY: two knights can reach f3 ===');
controller.loadPosition('4k3/8/8/8/8/8/3N3N/4K3 w - - 0 1');
await say('f3');
await say('h two');

console.log('=== AMBIGUITY: two different pieces can reach d4 ===');
controller.loadPosition('4k3/8/8/8/8/3P1N2/8/4K3 w - - 0 1');
await say('d4');
await say('knight');

console.log('=== CASTLING ===');
controller.loadPosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
await say('castle kingside');

console.log('=== UNDO ===');
controller.loadPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
replies.push({ from: 'e7', to: 'e5' });
await say('e4');
await say('undo');

console.log('=== MISHEARD / GARBAGE ===');
await say('knight ef three');
await say('okay please e four please');
await say('asdf qwerty');
await say('castle long');
