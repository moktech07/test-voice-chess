import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';

import {
  describePiece,
  legalCandidates,
  resolveDisambiguation,
  resolveMove,
  squareName,
} from '../../src/core/resolve';
import type { MoveIntent } from '../../src/core/types';

/* ------------------------------------------------------------------ */
/* Positions used below                                               */
/*                                                                     */
/*  - Two white knights on d2 and h2 both attack f3                    */
/*      -> "knight f3" is ambiguous on the ORIGIN (reason 'square').    */
/*  - A pawn on d3 and a knight on f3 both reach d4                    */
/*      -> "d4" is ambiguous on the PIECE (reason 'piece').             */
/*  - A pawn on e5 and a knight on f7 both reach d6                    */
/*      -> two different piece types, one of them a capture             */
/*         (used to prove we do NOT auto-pick the capture).             */
/*  - A pawn on a7 with an enemy piece on a8                            */
/*      -> promotion candidates (a8=N/B/R/Q).                           */
/*  - r3k2r/8/8/8/8/8/8/R3K2R with castling rights                    */
/*      -> O-O (e1->g1) and O-O-O (e1->c1).                             */
/* ------------------------------------------------------------------ */

const FEN_TWO_KNIGHTS_F3 = '4k3/8/8/8/8/8/3N3N/4K3 w - - 0 1';
const FEN_PAWN_AND_KNIGHT_D4 = '4k3/8/8/8/8/3P1N2/8/4K3 w - - 0 1';
const FEN_CAPTURE_AND_KNIGHT_D6 = '4k3/5N2/8/3pP3/8/8/8/4K3 w - d6 0 2';
const FEN_PROMOTION = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
const FEN_CASTLE = '4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1';

function intent(partial: Partial<MoveIntent>): MoveIntent {
  return { kind: 'move', to: '', raw: '', ...partial };
}

describe('legalCandidates', () => {
  it('lists every legal move of the position', () => {
    const chess = new Chess();
    const candidates = legalCandidates(chess);
    expect(candidates.length).toBe(chess.moves().length);
    expect(candidates.length).toBe(20);
  });

  it('describes a candidate fully', () => {
    const chess = new Chess();
    const e4 = legalCandidates(chess).find((c) => c.to === 'e4');
    expect(e4).toEqual({
      from: 'e2',
      to: 'e4',
      piece: 'p',
      san: 'e4',
      capture: false,
      castle: false,
      promotion: false,
    });
  });
});

describe('resolveMove — unique moves', () => {
  it('resolves "e4" to the pawn on e2', () => {
    const chess = new Chess();
    const result = resolveMove(chess, intent({ to: 'e4', raw: 'e4' }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.from).toBe('e2');
    expect(result.move.to).toBe('e4');
    expect(result.move.piece).toBe('p');
    expect(result.move.san).toBe('e4');
    expect(result.move.capture).toBe(false);
    expect(result.move.castle).toBe(false);
    expect(result.move.promotion).toBe(false);
  });

  it('resolves a fully specified move', () => {
    const chess = new Chess();
    const result = resolveMove(chess, intent({ from: 'e2', to: 'e4', piece: 'p' }));
    expect(result.status).toBe('ok');
  });

  it('resolves a knight move with a named piece', () => {
    const chess = new Chess();
    const result = resolveMove(chess, intent({ to: 'f3', piece: 'n' }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.from).toBe('g1');
    expect(result.move.san).toBe('Nf3');
  });
});

describe('resolveMove — ambiguity', () => {
  it('is ambiguous on the square when two knights reach the same square', () => {
    const chess = new Chess(FEN_TWO_KNIGHTS_F3);
    // Sanity check the position really has two knights able to reach f3.
    const toF3 = legalCandidates(chess).filter((c) => c.to === 'f3');
    expect(toF3.map((c) => c.from).sort()).toEqual(['d2', 'h2']);

    const result = resolveMove(chess, intent({ to: 'f3', piece: 'n' }));
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.reason).toBe('square');
    expect(result.candidates.length).toBe(2);
    expect(result.candidates.every((c) => c.piece === 'n')).toBe(true);
  });

  it('is ambiguous on the piece when different piece types reach the same square', () => {
    const chess = new Chess(FEN_PAWN_AND_KNIGHT_D4);
    const toD4 = legalCandidates(chess).filter((c) => c.to === 'd4');
    expect(toD4.map((c) => c.piece).sort()).toEqual(['n', 'p']);

    const result = resolveMove(chess, intent({ to: 'd4' }));
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.reason).toBe('piece');
    expect(result.candidates.length).toBe(2);
    expect(new Set(result.candidates.map((c) => c.piece))).toEqual(new Set(['n', 'p']));
  });

  it('uses reason "square" when the intent already named the piece', () => {
    const chess = new Chess(FEN_TWO_KNIGHTS_F3);
    const result = resolveMove(chess, intent({ to: 'f3', piece: 'n' }));
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.reason).toBe('square');
  });

  it('does not auto-pick the capture when one candidate captures and another does not', () => {
    const chess = new Chess(FEN_CAPTURE_AND_KNIGHT_D6);
    const toD6 = legalCandidates(chess).filter((c) => c.to === 'd6');
    expect(toD6.length).toBe(2);
    expect(toD6.filter((c) => c.capture).length).toBe(1);

    const result = resolveMove(chess, intent({ to: 'd6' }));
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.reason).toBe('piece');
  });

  it('narrows to one move when the origin square is given', () => {
    const chess = new Chess(FEN_TWO_KNIGHTS_F3);
    const result = resolveMove(chess, intent({ to: 'f3', piece: 'n', from: 'h2' }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.from).toBe('h2');
    expect(result.move.san).toBe('Nhf3');
  });
});

describe('resolveMove — castling', () => {
  it('resolves a kingside castle, ignoring the destination square', () => {
    const chess = new Chess(FEN_CASTLE);
    const result = resolveMove(chess, intent({ to: 'g1', castling: 'k', raw: 'castle' }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.san).toBe('O-O');
    expect(result.move.from).toBe('e1');
    expect(result.move.castle).toBe(true);
  });

  it('resolves a queenside castle, ignoring the destination square', () => {
    const chess = new Chess(FEN_CASTLE);
    const result = resolveMove(chess, intent({ to: 'c1', castling: 'q', raw: 'castle' }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.san).toBe('O-O-O');
    expect(result.move.from).toBe('e1');
    expect(result.move.castle).toBe(true);
  });

  it('resolves a castle even when the spoken destination is nonsense', () => {
    const chess = new Chess(FEN_CASTLE);
    const result = resolveMove(chess, intent({ to: 'e4', castling: 'k' }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.san).toBe('O-O');
  });

  it('reports an illegal castle when castling is not available', () => {
    const chess = new Chess('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    const result = resolveMove(chess, intent({ to: 'g1', castling: 'k' }));
    expect(result.status).toBe('illegal');
  });
});

describe('resolveMove — capture and promotion flags', () => {
  it('flags a capture', () => {
    const chess = new Chess('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
    const result = resolveMove(chess, intent({ to: 'd5', piece: 'p' }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.capture).toBe(true);
    expect(result.move.san).toBe('exd5');
  });

  it('flags an en-passant capture', () => {
    const chess = new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    const result = resolveMove(chess, intent({ to: 'd6', piece: 'p' }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.capture).toBe(true);
    expect(result.move.san).toBe('exd6');
  });

  it('flags a promotion and can select the promotion piece', () => {
    const chess = new Chess(FEN_PROMOTION);
    const all = legalCandidates(chess).filter((c) => c.to === 'a8');
    expect(all.length).toBe(4);
    expect(all.every((c) => c.promotion)).toBe(true);

    const result = resolveMove(chess, intent({ to: 'a8', piece: 'p', promotion: 'q' }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.promotion).toBe(true);
    // The black king sits on e8 in this FEN, so promoting to a queen gives check.
    expect(result.move.san).toBe('a8=Q+');
  });
});

describe('resolveMove — illegal', () => {
  it('reports an illegal move to an unreachable square', () => {
    const chess = new Chess();
    const result = resolveMove(chess, intent({ to: 'h5', raw: 'h5' }));
    expect(result.status).toBe('illegal');
    if (result.status !== 'illegal') return;
    expect(result.reason).toContain('h5');
    expect(result.reason).toContain('not a legal move');
    expect(result.intent).toBeDefined();
    expect(result.intent.kind).toBe('move');
  });

  it('reports that no piece of that type can go there', () => {
    const chess = new Chess();
    const result = resolveMove(chess, intent({ to: 'h5', piece: 'n' }));
    expect(result.status).toBe('illegal');
    if (result.status !== 'illegal') return;
    expect(result.reason).toBe('no knight can go to h5');
  });

  it('reports that it is not your turn when the origin square holds an enemy piece', () => {
    // White to move; e7 holds a BLACK pawn, so the player is speaking for
    // the wrong side.
    const chess = new Chess();
    const result = resolveMove(chess, intent({ to: 'e5', from: 'e7', piece: 'p' }));
    expect(result.status).toBe('illegal');
    if (result.status !== 'illegal') return;
    expect(result.reason).toBe('it is not your turn');
  });

  it('always carries an intent on an illegal result', () => {
    const chess = new Chess();
    const result = resolveMove(chess, intent({ to: 'e5' }));
    expect(result.status).toBe('illegal');
    if (result.status !== 'illegal') return;
    expect(result.intent).toEqual(expect.objectContaining({ kind: 'move' }));
    expect(typeof result.intent.to).toBe('string');
  });
});

describe('resolveDisambiguation', () => {
  it('picks the move when the answer is a piece', () => {
    const chess = new Chess(FEN_PAWN_AND_KNIGHT_D4);
    const pending = resolveMove(chess, intent({ to: 'd4' }));
    expect(pending.status).toBe('ambiguous');
    if (pending.status !== 'ambiguous') return;

    const result = resolveDisambiguation(chess, pending, { piece: 'n' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.piece).toBe('n');
    expect(result.move.from).toBe('f3');
    expect(result.move.san).toBe('Nd4');
  });

  it('picks the move when the answer is a square', () => {
    const chess = new Chess(FEN_TWO_KNIGHTS_F3);
    const pending = resolveMove(chess, intent({ to: 'f3', piece: 'n' }));
    expect(pending.status).toBe('ambiguous');
    if (pending.status !== 'ambiguous') return;

    const result = resolveDisambiguation(chess, pending, { square: 'd2' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.from).toBe('d2');
    expect(result.move.san).toBe('Ndf3');
  });

  it('stays ambiguous with reason "square" when several origins remain', () => {
    // Three white knights (d2, d4, h2) all reach f3.
    const chess = new Chess('4k3/8/8/8/3N4/8/3N3N/6K1 w - - 0 1');
    const pending = resolveMove(chess, intent({ to: 'f3', piece: 'n' }));
    expect(pending.status).toBe('ambiguous');
    if (pending.status !== 'ambiguous') return;
    expect(pending.candidates.length).toBe(3);

    const result = resolveDisambiguation(chess, pending, { piece: 'n' });
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.reason).toBe('square');
    expect(result.candidates.length).toBe(3);
  });

  it('is illegal when the answered piece is not among the candidates', () => {
    const chess = new Chess(FEN_PAWN_AND_KNIGHT_D4);
    const pending = resolveMove(chess, intent({ to: 'd4' }));
    if (pending.status !== 'ambiguous') throw new Error('expected ambiguity');

    const result = resolveDisambiguation(chess, pending, { piece: 'q' });
    expect(result.status).toBe('illegal');
    if (result.status !== 'illegal') return;
    expect(result.reason).toContain('queen');
    expect(result.intent.kind).toBe('move');
  });

  it('is illegal when the answered square is not among the candidates', () => {
    const chess = new Chess(FEN_TWO_KNIGHTS_F3);
    const pending = resolveMove(chess, intent({ to: 'f3', piece: 'n' }));
    if (pending.status !== 'ambiguous') throw new Error('expected ambiguity');

    const result = resolveDisambiguation(chess, pending, { square: 'a1' });
    expect(result.status).toBe('illegal');
    if (result.status !== 'illegal') return;
    expect(result.reason).toContain('a1');
    expect(result.intent.kind).toBe('move');
  });

  it('combines a piece and a square answer', () => {
    const chess = new Chess(FEN_PAWN_AND_KNIGHT_D4);
    const pending = resolveMove(chess, intent({ to: 'd4' }));
    if (pending.status !== 'ambiguous') throw new Error('expected ambiguity');

    const result = resolveDisambiguation(chess, pending, { piece: 'p', square: 'd3' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.move.piece).toBe('p');
    expect(result.move.from).toBe('d3');
    expect(result.move.san).toBe('d4');
  });
});

describe('helpers', () => {
  it('describes a piece', () => {
    expect(describePiece('n')).toBe('knight');
    expect(describePiece('n', 'w')).toBe('white knight');
    expect(describePiece('q', 'b')).toBe('black queen');
    expect(describePiece('k')).toBe('king');
    expect(describePiece('p', 'w')).toBe('white pawn');
  });

  it('describes a square', () => {
    expect(squareName('e4')).toBe('e4');
    expect(squareName(' E4 ')).toBe('e4');
  });
});
