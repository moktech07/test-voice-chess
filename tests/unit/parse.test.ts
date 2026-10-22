import { describe, expect, it } from 'vitest';

import {
  normalizeSpeech,
  parseSquare,
  parseUtterance,
  SPEECH_COMMANDS,
} from '../../src/core/parse';
import type { CommandIntent, MoveIntent } from '../../src/core/types';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function move(text: string): MoveIntent {
  const intent = parseUtterance(text);
  expect(intent, `expected a move intent for "${text}"`).not.toBeNull();
  expect(intent!.kind).toBe('move');
  return intent as MoveIntent;
}

function command(text: string): CommandIntent {
  const intent = parseUtterance(text);
  expect(intent, `expected a command intent for "${text}"`).not.toBeNull();
  expect(intent!.kind).not.toBe('move');
  return intent as CommandIntent;
}

/* ------------------------------------------------------------------ */
/* Bare squares                                                       */
/* ------------------------------------------------------------------ */

describe('parseUtterance — bare squares', () => {
  it('parses a bare square into a move to that square', () => {
    const intent = move('e4');
    expect(intent.to).toBe('e4');
    expect(intent.from).toBeUndefined();
    expect(intent.piece).toBeUndefined();
  });

  it('parses an upper-case square', () => {
    expect(move('E4').to).toBe('e4');
  });

  it('parses a hyphenated square', () => {
    expect(move('E-4').to).toBe('e4');
  });

  it('parses a spaced square', () => {
    expect(move('e 4').to).toBe('e4');
  });

  it('parses a square with a spoken rank', () => {
    expect(move('e four').to).toBe('e4');
    expect(move('e two').to).toBe('e2');
    expect(move('e eight').to).toBe('e8');
    expect(move('a one').to).toBe('a1');
    expect(move('h eight').to).toBe('h8');
  });

  it('sets raw to the original trimmed input', () => {
    expect(move('  e4  ').raw).toBe('e4');
    expect(command('  help ').raw).toBe('help');
  });
});

/* ------------------------------------------------------------------ */
/* Piece + square                                                     */
/* ------------------------------------------------------------------ */

describe('parseUtterance — piece and square', () => {
  it('parses "knight f3"', () => {
    const intent = move('knight f3');
    expect(intent.piece).toBe('n');
    expect(intent.to).toBe('f3');
  });

  it('parses "knight takes f3"', () => {
    const intent = move('knight takes f3');
    expect(intent.piece).toBe('n');
    expect(intent.to).toBe('f3');
  });

  it('parses "knight x f3"', () => {
    const intent = move('knight x f3');
    expect(intent.piece).toBe('n');
    expect(intent.to).toBe('f3');
  });

  it('parses "bishop c4"', () => {
    const intent = move('bishop c4');
    expect(intent.piece).toBe('b');
    expect(intent.to).toBe('c4');
  });

  it('parses "queen d1"', () => {
    const intent = move('queen d1');
    expect(intent.piece).toBe('q');
    expect(intent.to).toBe('d1');
  });

  it('parses "rook a1"', () => {
    const intent = move('rook a1');
    expect(intent.piece).toBe('r');
    expect(intent.to).toBe('a1');
  });

  it('parses "pawn e4"', () => {
    const intent = move('pawn e4');
    expect(intent.piece).toBe('p');
    expect(intent.to).toBe('e4');
  });

  it('parses "bishop to e4"', () => {
    const intent = move('bishop to e4');
    expect(intent.piece).toBe('b');
    expect(intent.to).toBe('e4');
  });

  it('parses "knight on f3"', () => {
    const intent = move('knight on f3');
    expect(intent.piece).toBe('n');
    expect(intent.to).toBe('f3');
  });

  it('parses "move to e4"', () => {
    expect(move('move to e4').to).toBe('e4');
  });

  it('parses "night f3" as a knight', () => {
    expect(move('night f3').piece).toBe('n');
  });

  it('parses "rock a1" as a rook', () => {
    expect(move('rock a1').piece).toBe('r');
  });

  it('leaves from undefined for a single square', () => {
    expect(move('knight f3').from).toBeUndefined();
  });

  it('fills from when two squares are spoken', () => {
    const intent = move('e2 to e4');
    expect(intent.from).toBe('e2');
    expect(intent.to).toBe('e4');
  });

  it('treats a square with a piece as a MOVE, not a disambiguation', () => {
    const intent = parseUtterance('knight f3');
    expect(intent!.kind).toBe('move');
  });
});

/* ------------------------------------------------------------------ */
/* Promotion                                                           */
/* ------------------------------------------------------------------ */

describe('parseUtterance — promotion', () => {
  it('parses "pawn e8 queen"', () => {
    const intent = move('pawn e8 queen');
    expect(intent.to).toBe('e8');
    expect(intent.promotion).toBe('q');
  });

  it('parses "pawn e8 knight"', () => {
    const intent = move('pawn e8 knight');
    expect(intent.to).toBe('e8');
    expect(intent.promotion).toBe('n');
  });

  it('parses "pawn e8 eight"', () => {
    const intent = move('pawn e8 eight');
    expect(intent.to).toBe('e8');
    expect(intent.promotion).toBe('r');
  });

  it('parses "promote to queen" on e8', () => {
    const intent = move('promote to queen e8');
    expect(intent.to).toBe('e8');
    expect(intent.promotion).toBe('q');
  });
});

/* ------------------------------------------------------------------ */
/* Castling                                                            */
/* ------------------------------------------------------------------ */

describe('parseUtterance — castling', () => {
  it('parses "castle"', () => {
    const intent = move('castle');
    expect(intent.castling).toBe('k');
  });

  it('parses "castle short"', () => {
    expect(move('castle short').castling).toBe('k');
  });

  it('parses "castle long"', () => {
    expect(move('castle long').castling).toBe('q');
  });

  it('parses "kingside castle"', () => {
    expect(move('kingside castle').castling).toBe('k');
  });

  it('parses "castle kingside"', () => {
    expect(move('castle kingside').castling).toBe('k');
  });

  it('parses "queenside castle"', () => {
    expect(move('queenside castle').castling).toBe('q');
  });

  it('parses "queen side castle"', () => {
    expect(move('queen side castle').castling).toBe('q');
  });

  it('parses "castle queen side"', () => {
    expect(move('castle queen side').castling).toBe('q');
  });

  it('parses "king side castle"', () => {
    expect(move('king side castle').castling).toBe('k');
  });
});

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

describe('parseUtterance — commands', () => {
  it('parses undo', () => {
    expect(command('undo').kind).toBe('undo');
    expect(command('take back').kind).toBe('undo');
    expect(command('takeback').kind).toBe('undo');
    expect(command('undo move').kind).toBe('undo');
    expect(command('go back').kind).toBe('undo');
  });

  it('parses new game', () => {
    expect(command('new game').kind).toBe('new');
    expect(command('new').kind).toBe('new');
    expect(command('restart').kind).toBe('new');
    expect(command('start over').kind).toBe('new');
    expect(command('reset').kind).toBe('new');
  });

  it('parses help', () => {
    expect(command('help').kind).toBe('help');
    expect(command('what can I say').kind).toBe('help');
    expect(command('commands').kind).toBe('help');
  });

  it('parses read board', () => {
    expect(command('read the board').kind).toBe('read_board');
    expect(command('board').kind).toBe('read_board');
    expect(command('where are the pieces').kind).toBe('read_board');
    expect(command('describe the board').kind).toBe('read_board');
    expect(command('read board').kind).toBe('read_board');
  });

  it('parses status', () => {
    expect(command('status').kind).toBe('status');
    expect(command('whose turn').kind).toBe('status');
    expect(command("what's the score").kind).toBe('status');
  });

  it('parses resign', () => {
    expect(command('resign').kind).toBe('resign');
    expect(command('i resign').kind).toBe('resign');
    expect(command('give up').kind).toBe('resign');
  });

  it('parses repeat', () => {
    expect(command('repeat').kind).toBe('repeat');
    expect(command('say again').kind).toBe('repeat');
    expect(command('again').kind).toBe('repeat');
    expect(command('what did you say').kind).toBe('repeat');
  });

  it('parses cancel', () => {
    expect(command('cancel').kind).toBe('cancel');
    expect(command('never mind').kind).toBe('cancel');
    expect(command('scratch that').kind).toBe('cancel');
  });

  it('parses sleep and wake', () => {
    expect(command('sleep').kind).toBe('sleep');
    expect(command('pause').kind).toBe('sleep');
    expect(command('wake up').kind).toBe('wake');
    expect(command('resume').kind).toBe('wake');
  });
});

/* ------------------------------------------------------------------ */
/* where                                                               */
/* ------------------------------------------------------------------ */

describe('parseUtterance — where', () => {
  it('parses "where is the knight"', () => {
    const intent = command('where is the knight');
    expect(intent.kind).toBe('where');
    expect(intent.piece).toBe('n');
  });

  it("parses \"where's the bishop\"", () => {
    const intent = command("where's the bishop");
    expect(intent.kind).toBe('where');
    expect(intent.piece).toBe('b');
  });

  it('parses "where are the rooks"', () => {
    const intent = command('where are the rooks');
    expect(intent.kind).toBe('where');
    expect(intent.piece).toBe('r');
  });

  it('parses "where is the queen"', () => {
    expect(command('where is the queen').piece).toBe('q');
  });
});

/* ------------------------------------------------------------------ */
/* difficulty                                                          */
/* ------------------------------------------------------------------ */

describe('parseUtterance — difficulty', () => {
  it('parses "difficulty three"', () => {
    const intent = command('difficulty three');
    expect(intent.kind).toBe('difficulty');
    expect(intent.level).toBe(3);
  });

  it('parses "difficulty 3"', () => {
    expect(command('difficulty 3').level).toBe(3);
  });

  it('parses "level 3"', () => {
    expect(command('level 3').level).toBe(3);
  });

  it('parses "make it harder"', () => {
    expect(command('make it harder').kind).toBe('difficulty');
  });

  it('keeps the level in the 0..4 range', () => {
    const level = command('difficulty 3').level!;
    expect(level).toBeGreaterThanOrEqual(0);
    expect(level).toBeLessThanOrEqual(4);
  });
});

/* ------------------------------------------------------------------ */
/* Disambiguation                                                      */
/* ------------------------------------------------------------------ */

describe('parseUtterance — disambiguation', () => {
  it('parses a bare piece letter as a disambiguation', () => {
    const intent = command('n');
    expect(intent.kind).toBe('disambiguate');
    expect(intent.piece).toBe('n');
  });

  it('parses "king" alone as a disambiguation', () => {
    const intent = command('king');
    expect(intent.kind).toBe('disambiguate');
    expect(intent.piece).toBe('k');
  });

  it('parses "queen" alone as a disambiguation', () => {
    const intent = command('queen');
    expect(intent.kind).toBe('disambiguate');
    expect(intent.piece).toBe('q');
  });

  it('parses a bare square as a disambiguation when asked', () => {
    const intent = parseUtterance('g1', { pendingDisambiguation: true });
    expect(intent!.kind).toBe('disambiguate');
    expect((intent as CommandIntent).square).toBe('g1');
  });

  it('does NOT treat a bare square as a disambiguation without context', () => {
    const intent = parseUtterance('g1');
    expect(intent!.kind).toBe('move');
    expect((intent as MoveIntent).to).toBe('g1');
  });
});

/* ------------------------------------------------------------------ */
/* Robustness                                                         */
/* ------------------------------------------------------------------ */

describe('parseUtterance — robustness', () => {
  it('returns null for empty input', () => {
    expect(parseUtterance('')).toBeNull();
    expect(parseUtterance('   ')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseUtterance('asdfghjkl')).toBeNull();
    expect(parseUtterance('!!!???...')).toBeNull();
    expect(parseUtterance('purple monkey dishwasher')).toBeNull();
  });

  it('never throws on odd input', () => {
    const weird = ['', '   ', 'e', '9', 'z9', 'e9', 'to', 'h8h8', 'a'.repeat(500)];
    for (const text of weird) {
      expect(() => parseUtterance(text)).not.toThrow();
    }
  });

  it('returns null for an out-of-range rank', () => {
    expect(parseUtterance('e9')).toBeNull();
    expect(parseUtterance('z4')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Filler words                                                       */
/* ------------------------------------------------------------------ */

describe('parseUtterance — filler stripping', () => {
  it('strips filler words around a move', () => {
    const plain = move('knight f3');
    const padded = move('okay please knight f3 please');
    expect(padded.to).toBe(plain.to);
    expect(padded.piece).toBe(plain.piece);
  });

  it('strips filler words around a command', () => {
    expect(command('okay please help').kind).toBe('help');
  });

  it('strips "let me" and "lets go"', () => {
    expect(move('let me knight f3').piece).toBe('n');
    expect(move("let's go knight f3").piece).toBe('n');
  });

  it('strips "and then"', () => {
    expect(move('knight f3 and then').to).toBe('f3');
  });

  it('keeps "to" when it precedes a square', () => {
    expect(move('move to e4').to).toBe('e4');
  });

  it('strips "to" when it is just noise', () => {
    expect(move('knight to f3').to).toBe('f3');
  });
});

/* ------------------------------------------------------------------ */
/* ASR mishears                                                       */
/* ------------------------------------------------------------------ */

describe('parseUtterance — ASR mishears', () => {
  it('parses "knight ef three" as a knight to f3', () => {
    const intent = move('knight ef three');
    expect(intent.piece).toBe('n');
    expect(intent.to).toBe('f3');
  });

  it('parses "knight bee four" as a knight to b4', () => {
    const intent = move('knight bee four');
    expect(intent.piece).toBe('n');
    expect(intent.to).toBe('b4');
  });

  it('parses "knight see five" as a knight to c5', () => {
    expect(move('knight see five').to).toBe('c5');
  });

  it('parses "knight gee six" as a knight to g6', () => {
    expect(move('knight gee six').to).toBe('g6');
  });

  it('parses "knight aitch eight" as a knight to h8', () => {
    expect(move('knight aitch eight').to).toBe('h8');
  });

  it('parses "knight dee two" as a knight to d2', () => {
    expect(move('knight dee two').to).toBe('d2');
  });

  it('parses "e for" as e4', () => {
    expect(move('e for').to).toBe('e4');
  });

  it('parses "e ate" as e8', () => {
    expect(move('e ate').to).toBe('e8');
  });

  it('parses "e won" as e1', () => {
    expect(move('e won').to).toBe('e1');
  });

  it('parses "e two" as e2 but keeps "to e4" as a preposition', () => {
    expect(move('e two').to).toBe('e2');
    expect(move('to e4').to).toBe('e4');
  });

  it('parses "night f3" as a knight move', () => {
    expect(move('night f3').piece).toBe('n');
  });

  it('parses "bishup c4" as a bishop move', () => {
    expect(move('bishup c4').piece).toBe('b');
  });
});

/* ------------------------------------------------------------------ */
/* normalizeSpeech                                                    */
/* ------------------------------------------------------------------ */

describe('normalizeSpeech', () => {
  it('lower-cases and strips punctuation', () => {
    expect(normalizeSpeech('E-4')).toBe('e 4');
    expect(normalizeSpeech('Knight, f3!')).toBe('knight f 3');
  });

  it('expands rank words', () => {
    expect(normalizeSpeech('e four')).toBe('e 4');
    expect(normalizeSpeech('e eight')).toBe('e 8');
  });

  it('expands file words next to a rank', () => {
    expect(normalizeSpeech('knight ef three')).toBe('knight f 3');
  });

  it('does not expand "to" when it is a preposition', () => {
    expect(normalizeSpeech('move to e4')).toBe('move to e 4');
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeSpeech('')).toBe('');
    expect(normalizeSpeech('   ')).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* parseSquare                                                        */
/* ------------------------------------------------------------------ */

describe('parseSquare', () => {
  it('parses valid squares', () => {
    expect(parseSquare('e4')).toBe('e4');
    expect(parseSquare('E4')).toBe('e4');
    expect(parseSquare('e 4')).toBe('e4');
    expect(parseSquare('e-4')).toBe('e4');
    expect(parseSquare('e four')).toBe('e4');
    expect(parseSquare('ef three')).toBe('f3');
    expect(parseSquare('a1')).toBe('a1');
    expect(parseSquare('h8')).toBe('h8');
  });

  it('returns null for invalid squares', () => {
    expect(parseSquare('')).toBeNull();
    expect(parseSquare('e9')).toBeNull();
    expect(parseSquare('z4')).toBeNull();
    expect(parseSquare('hello')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* SPEECH_COMMANDS                                                     */
/* ------------------------------------------------------------------ */

describe('SPEECH_COMMANDS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(SPEECH_COMMANDS)).toBe(true);
    expect(SPEECH_COMMANDS.length).toBeGreaterThan(0);
  });

  it('every entry has a phrase, a kind and a description', () => {
    for (const entry of SPEECH_COMMANDS) {
      expect(typeof entry.phrase).toBe('string');
      expect(entry.phrase.length).toBeGreaterThan(0);
      expect(typeof entry.kind).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('covers every command kind the app supports', () => {
    const kinds = new Set(SPEECH_COMMANDS.map((c) => c.kind));
    for (const kind of [
      'undo',
      'new',
      'help',
      'read_board',
      'where',
      'status',
      'resign',
      'difficulty',
      'repeat',
      'cancel',
      'disambiguate',
      'sleep',
      'wake',
    ]) {
      expect(kinds.has(kind as never), `missing kind ${kind}`).toBe(true);
    }
  });

  it('every listed phrase actually parses to the advertised kind', () => {
    for (const entry of SPEECH_COMMANDS) {
      const intent = parseUtterance(entry.phrase);
      if (!intent) continue; // disambiguation phrases need context
      if (intent.kind === 'move') continue; // "e4" is a move without context
      expect(intent.kind, `"${entry.phrase}" parsed as ${intent.kind}`).toBe(
        entry.kind,
      );
    }
  });
});
