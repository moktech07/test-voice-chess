import { Chess } from 'chess.js';

const GLYPHS: Record<string, string> = {
  wk: '♔',
  wq: '♕',
  wr: '♖',
  wb: '♗',
  wn: '♘',
  wp: '♙',
  bk: '♚',
  bq: '♛',
  br: '♜',
  bb: '♝',
  bn: '♞',
  bp: '♟',
};

/**
 * Render the board from a FEN. This is a *visual aid only* — the game is
 * fully playable with eyes closed. It must never be required to play.
 *
 * `chess.js` returns an 8x8 array in which empty squares are `null`, so we
 * must render those too (they carry the light/dark pattern).
 */
export function renderBoard(
  container: HTMLElement,
  fen: string,
  lastMove?: { from: string; to: string } | null,
): void {
  const chess = new Chess(fen);

  const board = chess.board();
  const inCheck = chess.isCheck() ? chess.turn() : null;

  container.replaceChildren();

  // board[0] is rank 8, so iterating rows top-to-bottom puts rank 8 at the
  // top — the correct orientation for a player sitting at the bottom.
  for (const row of board) {
    for (const sq of row) {
      const file = sq?.square[0] ?? '';
      const rank = sq?.square[1] ?? '';
      const el = document.createElement('div');

      // The colour pattern: a1 is dark, so (file + rank) parity decides.
      const isLight = (file.charCodeAt(0) - 97 + Number(rank)) % 2 === 1;
      el.className = `square ${isLight ? 'square--light' : 'square--dark'}`;
      el.dataset.square = sq?.square ?? '';

      if (lastMove && (sq?.square === lastMove.from || sq?.square === lastMove.to)) {
        el.classList.add('square--last');
      }

      if (sq && sq.type === 'k' && sq.color === inCheck) {
        el.classList.add('square--check');
      }

      if (sq) {
        const piece = document.createElement('span');
        piece.className = `piece piece--${sq.color}`;
        piece.textContent = GLYPHS[`${sq.color}${sq.type}`] ?? '';
        el.appendChild(piece);
      }

      // File letters along the bottom rank, rank numbers down the left file.
      if (rank === '1') {
        const c = document.createElement('span');
        c.className = 'square__coord square__coord--file';
        c.textContent = file;
        el.appendChild(c);
      }
      if (file === 'a') {
        const c = document.createElement('span');
        c.className = 'square__coord square__coord--rank';
        c.textContent = rank;
        el.appendChild(c);
      }

      container.appendChild(el);
    }
  }
}
