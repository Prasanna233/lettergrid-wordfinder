# Grid Word Finder

Upload a screenshot of the letter-grid game; the app reads the board in your browser
(no server, no API key) and lists playable words of 4–20 letters, ranked by how good a move they are.

- `reader.js` – finds the board, classifies cells (mine / opponent / capture tile / free), detects 🤔 wildcards, reads letters by matching against `templates.json` (glyphs taken from real screenshots).
- `solver.worker.js` – builds a compact trie of `words.txt` and searches all 8-direction paths (each cell once per word).
- `app.js`, `index.html`, `style.css` – mobile UI.

Run locally: `python -m http.server` in this folder, then open http://localhost:8000.
Hosting: any static host (GitHub Pages: Settings → Pages → Deploy from branch → main / root).
