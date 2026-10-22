# Voice Chess

Play chess by **voice only**. Put on headphones, close your eyes, and play.
No touching the phone once the game starts.

The app is an installable PWA: it runs in the browser, installs to your home
screen like a native app, and works **offline** once loaded.

---

## How it plays

You speak moves in plain English. The app listens, works out what you meant,
asks you to disambiguate when it has to, and answers out loud.

| You say | The app does |
| --- | --- |
| `e4` | plays e2-e4 |
| `knight takes f three` | plays Nxf3 |
| `bishop c4` | plays Bc4 |
| `castle kingside` | castles short |
| `pawn e8 queen` | promotes |
| `read the board` | reads the whole position out loud, rank by rank |
| `where is the queen` | "white queen on d one" |
| `status` | whose turn, move number, difficulty |
| `undo` | takes back your move (and the engine's reply) |
| `resign` | resigns |
| `new game` | starts over |
| `help` | lists what you can say |
| `repeat` | repeats the last thing it said |
| `difficulty three` | changes engine strength, 0-4 |
| `sleep` / `wake up` | turns the microphone off and on |

### Disambiguation

Chess moves spoken aloud rarely name the origin square. When two pieces can
reach the same square, the app asks instead of guessing:

> "A knight or a pawn can go there. Which one?"

> "Two knights can go there, from b one or f three. Which one?"

Answer with the piece name (`knight`) or the square (`f three`).

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build into dist/
npm run preview    # serve the production build
npm test           # unit tests
npm run e2e        # browser tests (builds and drives a real Chromium)
```

### Testing on your phone

The voice APIs (`SpeechRecognition` / `speechSynthesis`) are browser features.
**Chrome on Android** and **Safari on iOS 14.5+** both support them. Desktop
Firefox does not support speech recognition.

To try it on your phone from a dev machine:

```bash
npm run build
npm run preview -- --host    # prints a LAN URL
```

then open that URL on the phone (same Wi-Fi). For something durable, deploy to
GitHub Pages — see below.

---

## Deploying to GitHub Pages

The app is fully static and uses **relative paths only**, so it works from a
project subpath like `https://<user>.github.io/voice-chess/`.

```bash
npm run build
cp -r dist/* ../<repo>/   # or push dist/ to a gh-pages branch
```

---

## Architecture

```
src/
  core/
    types.ts        shared contract (Intent, Engine, SpeechOutput, ...)
    parse.ts        spoken text  -> Intent      (fuzzy, ASR-tolerant)
    resolve.ts      Intent      -> legal move  (disambiguation logic)
    engine.ts       Stockfish 19 in a Web Worker (WASM)
    speech.ts       speech synthesis + recognition wrappers
    controller.ts   the game loop: intent -> move -> engine -> spoken reply
  ui/
    board.ts        visual board (a helper only; never required to play)
  main.ts           wiring + DOM
```

### The three hard problems, and how they are solved

**1. The app must not hear itself.**
If the microphone stays open while the app speaks, the engine hears its own
voice-over and plays it as a move. `controller.say()` pauses recognition before
speaking and resumes it afterwards, and utterances are serialised through a
promise chain so they can never overlap.

**2. Speech recognition is unreliable.**
Mobile browsers end recognition sessions on their own, restart after silence,
and fire `no-speech` / `not-allowed` / `network` errors. The input wrapper
auto-restarts on recoverable errors with backoff, and stops permanently on
`not-allowed` instead of hot-looping. If the browser has no speech support at
all, the app runs with a no-op input and says so.

**3. Spoken chess is ambiguous and messy.**
`parse.ts` normalises filler words, ASR homophones (`ef` for `f`, `night` for
`knight`, `rock` for `rook`), spoken ranks (`e four` -> `e4`), and casts
(`castle long` -> `O-O-O`). `resolve.ts` then matches the intent against the
legal moves and asks a targeted question when it cannot decide.

### Engine

Stockfish 19, `lite-single` build (≈1.8 MB of JS+WASM). Single-threaded on
purpose: the multi-threaded build needs `SharedArrayBuffer`, which needs
COOP/COEP headers, which GitHub Pages does not send. Difficulty maps to search
depth:

| Level | Depth |
| --- | --- |
| 0 | 2 |
| 1 | 4 |
| 2 | 8 |
| 3 | 12 |
| 4 | 16 |

---

## Accessibility notes

- The board is decorative. Everything needed to play is spoken.
- `navigator.wakeLock` keeps the screen on while you play.
- The app re-acquires the wake lock when the tab becomes visible again.
- Touch controls exist as a convenience, but nothing requires them mid-game.

## Licence

Stockfish is GPLv3 (© the Stockfish developers, distributed via
[stockfish.js](https://github.com/nmrugg/stockfish.js) by Nathan Rugg).
`chess.js` is BSD-2-Clause.
