# The Terminals Panel Costs a Megabyte and a Half Before It Can Take a Click

## Goal

Opening the Terminals panel becomes fast enough that it is not the slowest surface in the
product. The first load stops shipping payload it will not use, the largest file stops being
one 13,350-line script, and a repeat load stops re-downloading bytes that have not changed.

### Problem analysis

**Measured on this host, 2026-09-12, against the running standalone board:**

| Page | HTML | Assets | Total |
| :--- | ---: | ---: | ---: |
| `/terminals` | 159 KB | 1395 KB | **1517 KB** |
| `/` (board) | 18 KB | 89 KB | **104 KB** |

The panel is **14.6× the board**. The operator's report is that it "takes forever to be ready
for starting terminals, far slower than the board startup" — which is exactly what the numbers
predict.

The asset breakdown:

```
terminals.js            681 KB   13,350 lines
xterm.js                289 KB
terminalViewport.js     119 KB
addon-webgl.js          101 KB
addon-canvas.js          95 KB   <- only used when WebGL is unavailable
transport.js             45 KB
sharedDefaults.js        30 KB
sharedUtils.js           25 KB
clipboardFallback.js      2 KB
addon-fit.js              1 KB
                     ────────
                       1388 KB
```

plus `terminals.html` at 152 KB, of which **121 KB is inline CSS** and 29 KB is markup.

**Already fixed, and not this plan's work.** The seven panel scripts were parser-blocking, so
the browser fetched and compiled all 1311 KB of them strictly in series before wiring a single
button. `defer` (commit `b8f3d275`) makes them download in parallel. That is the cheap half and
it is done; what remains is the payload itself, which `defer` does not reduce by a byte.

**Three costs remain, each independent.**

1. **`addon-canvas.js` (95 KB) is downloaded on every load and used almost never.** It is the
   fallback renderer: `terminalViewport.js:389` `webglAvailable()` gates on `window.WebglAddon`,
   and `attachCanvasRenderer` (`:393`) is reached only when WebGL is absent. On any machine with
   WebGL — which is the normal case — those 95 KB are fetched, parsed and discarded.

2. **121 KB of CSS is inlined into the HTML.** It cannot be cached separately from the document,
   so it is re-sent and re-parsed on the main thread on every single load, including loads where
   nothing changed.

3. **`terminals.js` is 681 KB in one file** — half the payload, 13,350 lines, ~495 functions.
   Nothing can be loaded lazily because there is no boundary to load lazily across.

**And repeat loads pay full price.** `Cache-Control: no-cache` is set correctly on both the page
and the scripts (verified: `no-cache` on `/static/webview/*`, `no-store, no-cache,
must-revalidate` on `/terminals`) — but **no `ETag` and no `Last-Modified` are sent**. `no-cache`
means "revalidate before use", and revalidation without a validator is a full re-download. So
every load transfers the whole 1.4 MB even when not a byte has changed.

> **Note on a wrong diagnosis, recorded so it is not repeated.** An earlier pass reported that
> the panel sent *no* cache headers at all and concluded that every rebuild needed a manual hard
> reload. That was measured with `curl -I`, which sends `HEAD`; this server answers `HEAD` with
> `405 Method Not Allowed`, and the headers read were the error's. The headers are correct. The
> real gap is the missing validator, which is a different fix. Measure with `curl -s -o /dev/null -D -`.

### Root cause

The panel grew by accretion and nothing ever had a size budget. Each addition was individually
defensible — a renderer fallback, a stylesheet kept next to its markup, another feature in the
panel script — and no step was large enough to argue with. The result is a surface that costs
more than fourteen times the board and is the first thing an operator waits on.

### Non-goals

- **Rewriting the panel.** This is a payload plan, not a refactor of behaviour. Every change
  below must be observable only as "the same panel, sooner".
- **Touching the shared transport shim.** `injectTransportShim` (`headlessPanelHtml.ts:73`)
  injects `sharedDefaults`/`clipboardFallback`/`transport` into `kanban.html` and `setup.html`
  as well, whose inline scripts are positioned against them. 77 KB is not worth breaking two
  other panels for, and the deliberate omission is already recorded in `terminals.html`.
- **Removing either renderer.** WebGL and canvas are both genuinely reachable. This plan changes
  *when* the fallback is fetched, never *whether* it exists.

## Metadata

- **Complexity:** 6
- **Tags:** terminals, performance, webview, standalone

## User Review Required

None.

## Proposed Changes

### 1. Fetch `addon-canvas.js` only when WebGL is unavailable

Drop the eager `<script defer src="{{XTERM_ADDON_CANVAS_URI}}">` from `terminals.html:3620` and
load it on demand.

**The hazard is the call shape, not the download.** `attachCanvasRenderer(term)` returns the
addon *synchronously* and its result is assigned to `holder.current` at `terminalViewport.js:473`
and `:507`. A naive lazy load makes that return `undefined` and the terminal silently gets no
renderer — on precisely the machines where WebGL already failed, so the degradation lands on the
users least able to absorb it.

Two shapes are acceptable; pick one and state it in the implementation:

- **Kick off the fetch as soon as WebGL is known absent** — after xterm and the WebGL addon have
  run, `if (!webglAvailable()) injectScript(canvasUri)` — and keep `attachCanvasRenderer`
  synchronous. It already handles the addon being missing by falling through to the DOM renderer
  (`:398`, "Canvas renderer unavailable, using DOM renderer"), so the worst case is that the
  *first* terminal on a WebGL-less machine gets the DOM renderer until the script lands.
- **Make the renderer attachment async** and have `holder.current` accept a promise, updating
  both call sites and the disposal path (`WebglAddon.dispose()` teardown is documented at
  `:546` and must keep working).

The first is smaller and its failure mode is a slower renderer, not a missing one. The second is
correct in all cases and costs a real refactor. Do not ship a third shape where
`attachCanvasRenderer` can return `undefined` to a caller that assumes an object.

CSP allows this: the panel serves `script-src 'nonce-…' 'self'`, and the addon is same-origin.

### 2. Move the 121 KB inline stylesheet to a cacheable file

Extract the `<style>` block from `terminals.html` into `src/webview/terminals.css`, served from
the existing `/static/webview/` route, and reference it with `<link rel="stylesheet">`.

**This is the change most likely to go wrong in this repo.** The standing rule is that panel
extraction must port CSS *wholesale* — a hand-written "equivalent" stub produces the wrong
palette, missing fonts and dead theme classes while every gate stays green and the panel fails on
sight. So: move the bytes verbatim, change no selector, and diff the rendered panel before and
after rather than reading the diff of the stylesheet.

Note the two `@font-face` blocks at `terminals.html:11` and `:18` use `{{HANKEN_FONT_URI}}` and
`{{GEIST_PIXEL_FONT_URI}}` placeholders substituted server-side. A static `.css` file is not
template-substituted, so either those two blocks stay inline (leaving ~120 KB to move) or the
CSS route learns to substitute. Keeping them inline is the smaller change and is preferred.

### 3. Send a validator so a repeat load can 304

Add `ETag` (or `Last-Modified`) to the static handler in `LocalApiServer.ts` alongside the
existing `Cache-Control`, and answer `If-None-Match` / `If-Modified-Since` with `304`.

`no-cache` already forces revalidation, so this changes no freshness semantics — it only lets
revalidation cost a round trip instead of 1.4 MB. Derive the validator from the file's mtime and
size; both are already read by `fsSync.statSync` at the serve site.

This is in the **shared** `LocalApiServer` static route, so it benefits every panel on both
composition roots at once, and needs no per-panel work.

### 4. Split `terminals.js`

681 KB in one file is half the payload and the reason nothing else can be deferred. Split along
the seams the file already has — the panel shell, the grid/layout, the team controls, the tmux
tab — so that opening the panel loads the shell and the rest arrives as it is needed.

**Sequencing:** this is the largest item and the only one that is a refactor rather than a tune.
It should land last, after 1–3 have taken the cheap wins, and it may reasonably become its own
plan once its seams are known. Do not begin it by moving code: begin by measuring which exports
the panel shell actually needs before first interaction.

## Verification Plan

### Automated Tests

1. **New** `src/test/terminals-panel-payload-contract.test.js`, wired as
   `test:contract:terminals-payload` **and invoked from `.github/workflows/integration-tests.yml`**
   — a script defined in `package.json` but not called by CI is not a gate. It asserts a **byte
   budget** for the panel's first load, computed from the served HTML plus every non-deferred,
   non-lazy asset it references, and fails when the budget is exceeded. The budget is the point:
   without it the panel re-accretes and nobody notices until an operator complains again.
2. Assert `addon-canvas.js` is **not** referenced by an eager `<script>` tag in the served HTML.
3. Assert the static handler emits an `ETag` (or `Last-Modified`), and that a request carrying a
   matching `If-None-Match` receives `304` with an empty body.
4. Assert the seven panel scripts still carry `defer` — this is already true (`b8f3d275`) and
   must not regress.
5. Regression: `test:contract:tmux-view-chrome`, `test:contract:pty-host-blackbox` and
   `npm run compile-tests` stay green.

### Goal Invariants

- A cold load of `/terminals` transfers materially less than the 1517 KB measured on 2026-09-12,
  and the number is asserted by a gate rather than observed once.
- A warm reload with an unchanged build transfers approximately nothing: the page and every asset
  answer `304`.
- On a machine **with** WebGL, `addon-canvas.js` is never requested.
- On a machine **without** WebGL, a terminal still gets the canvas renderer — verified by
  forcing `webglAvailable()` false, not by reasoning about it.
- The panel renders identically before and after the CSS extraction: same palette, same fonts,
  same theme classes. Compare the rendered panel, not the stylesheet diff.
