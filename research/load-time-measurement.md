# Session open time: where it goes

Measured 2026-11-22 on the largest real lesson: a 1.08 MB record with 467 native messages (15 user, 233 assistant, 203 toolResult, 16 custom). The client view projects those into 56 rows, with about 1,740 KaTeX nodes and about 43,000 DOM nodes. The record contains no mermaid diagram or chart. This report gives only sizes and counts, no lesson content.

## Verdict

Opening this session takes about **3.4 s** until the view settles. Nearly all of that time is **rendering the markdown transcript twice**: once as HTML on the server (about 1.0 s) and again during client hydration (about 1.2 s), plus the paint, re-fetch and re-render work around those two passes. Reading and parsing the record takes about 3 ms. Building the view takes about 5 ms, and RSC serialization takes under 10 ms. Together these are under 1% of the total.

Partial loading must therefore cut **the number of rows that go through Streamdown/KaTeX**, on both the server (SSR) and the client (hydration). Trimming only the JSON payload would save almost nothing. Rendering the last ~100 messages instead of all 467 cuts the time to settled view from 3.4 s to 1.0 s. Rendering the last ~50 cuts it to 0.78 s. The floor, with 5 messages, is 0.39 s.

## Method

- **Build:** Next.js 16.4.6 production build (Turbopack, `next build`), served with `next start -H localhost`. `next start` warns about `output: "standalone"` but serves the same compiled output that the packaged `server.js` uses. The worktree used the main checkout's `node_modules` (an APFS clone) and its generated `core-plugins/`. The plugin sources are identical.
- **Data:** a scratch `LH_DATA_DIR` held a copy of the lesson and three truncated copies: the last 100, 51 and 5 messages, each cut so the copy starts on an assistant message. The truncated copies keep the record's `turns`, `tree` and `extractions` (about 74 KB). The scratch `settings.json` was a copy with `models` removed and the CLI providers disabled, and `LH_AUTH_FILE` was an empty `{}`. The server ran under `env -i`, so no model call could happen. As a side effect, the setup pill renders instead of the model pill.
- **Temporary instrumentation (not committed):**
  - `performance.now()` around `getChat` in `app/chat/[id]/page.tsx`.
  - A wrapper in `SessionModel.getState` that times `nativeHistory()` and `projectView()`.
  - In `<Chat>`: a mark at the first client render (hydration start), a `useLayoutEffect` mark (first commit) and a `useEffect` mark (effects done).
- **Server:** `curl` against the HTML page, the RSC request (`RSC: 1`, `?_rsc`) and `GET /api/chats/:id`. One warm-up request per URL, then the median of 9 requests.
- **Node:** `getChat`, `copyImmutableData` and `projectView` called directly with `tsx` against the scratch data. Median of 15 runs.
- **Browser:** headless Chrome 158 driven by puppeteer-core 25.8 at a 1440×900 viewport, with the HTTP cache warm (one warm-up load per chat). Median of 7 loads.
  - "Settled" is the later of the effects mark and the last DOM mutation, after 1.5 s without further mutations.
  - The CPU fields come from CDP `Performance.getMetrics` deltas.
- **Attribution:** CPU profiles, mapped through source maps to the package or source file each sample's code came from.
  - Server: `node --cpu-prof`, over about 5 warm renders of the full chat.
  - Client: one CDP profile of a full-chat load, from a rebuild with `productionBrowserSourceMaps` enabled. That rebuild was used only for this profile and the 5-message floor row.
  - Profiling inflates absolute times, so only the shares are reported.
- **Machine:** Apple M1 Pro (10 cores, 16 GB), macOS 27.0.1, Node 26.13.1, React 19.2.8, streamdown 2.5.0.

## Results (medians)

| Metric | Full (467 msgs) | Last 100 | Last 51 | Last 5 (floor) |
|---|---:|---:|---:|---:|
| View rows (`projectView` output) | 56 | 25 | 13 | 1 |
| **Server** | | | | |
| `getChat` read + parse (in-process, Node bench) | 2.8 ms | 1.0 ms | 0.7 ms | 0.25 ms |
| `getChat` in the running server (logged) | 2.8 ms | – | – | – |
| `projectView` (Node bench, first call) | 5.2 ms | 0.4 ms | 0.2 ms | 0.02 ms |
| `copyImmutableData` of history (client `nativeHistory`, Node) | 7.9 ms | 1.2 ms | 0.7 ms | 0.07 ms |
| HTML page: time to response (SSR render) | **1008 ms** | 203 ms | 131 ms | 27 ms |
| RSC-only request (no HTML render) | 9.8 ms | 4.8 ms | 4.0 ms | 3.2 ms |
| `GET /api/chats/:id` | 21 ms | 9 ms | 7 ms | 4 ms |
| **Payload** | | | | |
| HTML document | 3.80 MB (0.49 MB gz) | 0.77 MB (0.13 gz) | 0.51 MB (0.09 gz) | 0.07 MB |
| … RSC flight data inlined in the HTML | 0.93 MB | 0.29 MB | 0.19 MB | 0.02 MB |
| … SSR markup (HTML minus flight) | ~2.86 MB | ~0.48 MB | ~0.32 MB | ~0.05 MB |
| RSC payload (`?_rsc`) | 0.88 MB | 0.27 MB | 0.18 MB | 0.02 MB |
| `GET /api/chats/:id` body | 0.95 MB | 0.34 MB | 0.25 MB | 0.08 MB |
| **Browser (from navigation start)** | | | | |
| responseStart (TTFB) | 1027 ms | 237 ms | 153 ms | 30 ms |
| First contentful paint (SSR HTML visible, not interactive) | 1088 ms | 332 ms | 248 ms | 96 ms |
| DOMContentLoaded | 1333 ms | 343 ms | 264 ms | 40 ms |
| Hydration start (first client render of `<Chat>`) | 1371 ms | 513 ms | 409 ms | 239 ms |
| First commit (layout effect) | 2591 ms | 834 ms | 636 ms | 304 ms |
| → **hydration render duration** | **1220 ms** | 321 ms | 227 ms | 65 ms |
| Effects done | 2723 ms | 860 ms | 658 ms | 314 ms |
| **View settled** | **3396 ms** | 1010 ms | 781 ms | 386 ms |
| `projectView` in browser (1st call / sum of 2 calls) | 4.8 / 7.6 ms | 1.4 / 1.8 ms | 1.0 / 1.3 ms | 0.6 / 0.8 ms |
| Main-thread task time (total) | 2449 ms | 868 ms | 725 ms | 379 ms |
| … script | 1570 ms | 414 ms | 320 ms | 135 ms |
| … style + layout | 325 + 182 ms | 85 + 68 ms | 63 + 57 ms | 17 + 32 ms |
| Long tasks: sum / max | 1107 / 565 ms | 214 / 127 ms | 193 / 125 ms | 124 / 124 ms |
| DOM nodes / `.katex` nodes | 42,973 / 1,738 | 6,151 / 182 | 3,918 / 78 | 677 / 11 |

The JS bundle is 3.9 MB decoded and is the same for every chat. It explains most of the floor: the load event fires at about 230 ms even for 5 messages.

## Where the time goes (full chat, ~3.4 s)

1. **Server SSR of `<Chat>`: about 1.0 s.** The RSC-only request for the same page takes 10 ms, so the data side costs almost nothing. The cost is React rendering the client component tree to HTML. Profile shares of busy CPU over warm renders:

   | Share | Work |
   |---:|---|
   | 47% | Markdown parsing (micromark, mdast-util-from-markdown, remend, streamdown, unist visitors) |
   | 10% | Raw-HTML pass (parse5, hast-util-from-parse5, hastscript) |
   | 6% | hast→JSX (hast-util-to-jsx-runtime, inline-style-parser) |
   | 6% | KaTeX |
   | 8% | React/Next runtime |
   | 5% | App code in `src/` |

   In total, about 68% is the markdown→React pipeline. Its output is 2.86 MB of HTML markup.
2. **Getting the document to hydration start: about 0.3 s.** The browser parses the 3.8 MB document with its 0.93 MB of inlined flight data and evaluates the JS. DOMContentLoaded arrives 250 ms after responseEnd, compared with 80 ms for the last-51 copy.
3. **Hydration render: about 1.2 s.** The client renders every row through Streamdown again. It does not reuse the server HTML for this work. Shares of client JS self time over the whole load:

   | Share | Work |
   |---:|---|
   | 27% | Markdown parsing |
   | 4% | KaTeX |
   | 4% | Raw-HTML pass |
   | 3% | hast→JSX |
   | 13% | App components (`answered-card.tsx` ≈ 5%, `plan-block.tsx`, `question-layout.ts`) |
   | 10% | App `src/` folds (`argument-heal.ts`, `plugin-problems.ts`, `native-messages.ts`) |
   | 10% | React |
   | 10% | Radix/UI libraries |
   | 5% | mermaid/dagre/lodash module initialisation |
   | 4% | typebox |

   `projectView` costs 5–8 ms of this.
4. **After hydration: about 0.7 s.** On open, the client fetches the full record from `GET /api/chats/:id` twice, 0.95 MB each:
   - `components/model-picker.tsx` reads the whole record only to get `settings`.
   - The session model makes a canonical read and adopts it, which triggers a second `getState`/`projectView` and a re-render.

   Style and layout of a 43k-node DOM add about 0.5 s of main-thread time in total.

**How cost scales:** from the last 100 messages to the full chat, messages grow 4.7×, rows 2.2×, KaTeX nodes 9.5× and DOM nodes 7×. SSR time grows 5× and hydration 3.8×. The cost follows the volume of rendered markdown and math, not the message count or the JSON size. Two examples:

- The last 51 messages are about 20% of the record's message bytes (0.19 MB of 0.91 MB) but produce only 13 of the 56 rows. They open in 0.78 s. The last 100 messages are about 31% of the bytes and produce 25 rows.
- The `turns`, `tree` and `extractions` fields (about 74 KB) stay in every `GET /api/chats/:id` response no matter how many messages are cut. They are most of the floor's 82 KB API body.

## Implications for partial loading

- **The layer to cut is the rendered transcript, on both server and client.** Rendering fewer rows through Streamdown/KaTeX (and the answered cards) removes the 1.0 s of SSR and the 1.2 s of hydration together. Two alternatives save very little on their own:
  - Sending fewer messages while still rendering all of them would save only the ~20 ms data path and part of the ~0.25 s spent parsing the document.
  - Rendering fewer rows while still sending all messages keeps the 0.9 MB flight payload. That costs roughly 0.1–0.2 s, which is acceptable.
- **Last ~100 messages:** settled view 3.4 s → 1.0 s (−70%), SSR 1008 → 203 ms, hydration 1220 → 321 ms, HTML 3.8 → 0.77 MB.
- **Last ~50 messages:** settled 0.78 s, SSR 131 ms, hydration 227 ms. Most of the remainder is the floor (about 0.39 s: JS bundle load and app shell).
- **The two post-hydration full-record GETs must be trimmed too.** Otherwise a partially loaded view re-downloads the entire record twice, and adopting the canonical read can re-render the full history. A minimal fix would be for the model picker to read only `settings`. The canonical read would need to page or window its response consistently with the partial view.
- `getChat`, `projectView` and `copyImmutableData` are not worth optimising for open time. Together they take under 20 ms on the full record.

## Caveats

- Headless Chrome, not the Electron shell. Both use the same Chromium engine and the same local server. Absolute times on a slower machine will scale up.
- The settle detection uses DOM quiescence. Late async work that makes no DOM changes is not counted.
- Without a configured model, the scratch setup renders the setup pill instead of the model pill. This differs negligibly from the real app.
- The last-5 floor row and the client CPU profile come from a second build that differs only by having browser source maps enabled.
