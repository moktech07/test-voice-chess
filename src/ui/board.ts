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
 */
export function renderBoard(container: HTMLElement, fen: string, history: string[]): void {
  const chess = new Chess(fen);

  // Which squares are involved in the last move (for the highlight).
  const lastMove = history.length
    ? (() => {
        const before = new Chess();
        before.load(fen);
        // Rebuild the position one ply back to find the move.
        const moves = before.history({ verbose: true }) as unknown as {
          from: string;
          to: string;
        }[];
        const m = moves[moves.length - 1];
        return m ? { from: m.from, to: m.to } : null;
      })()
    : null;

  const board = chess.board();
  const squares = board.flat();

  container.replaceChildren();

  // Row 0 of the array is rank 8. We render rank 8 at the top.
  for (const sq of squares) {
    if (!sq) continue;
    const el = document.createElement('div');
    const file = sq.square[0];
    const rank = sq.square[1];
    const isLight = (file.charCodeAt(0) - 97 + Number(rank)) % 2 === 1;
    el.className = `square ${isLight ? 'square--light' : 'square--dark'}`;

    if (lastMove && (sq.square === lastMove.from || sq.square === lastMove.to)) {
      el.classList.add('square--last');
    }

    if (sq.type === 'k') {
      const inCheck = chess.isCheck() && sq.color === chess.turn();
      if (inCheck) el.classList.add('square--check');
    }

    const piece = document.createElement('span');
    piece.className = `piece piece--${sq.color}`;
    piece.textContent = GLYPHS[`${sq.color}${sq.type}`] ?? '';
    el.appendChild(piece);

    // File letters on the bottom rank, rank numbers on the left file.
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
