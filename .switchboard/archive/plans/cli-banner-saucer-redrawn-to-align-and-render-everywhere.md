# The CLI Banner Renders The Product's Own UFO, Not A Hand-Drawn Approximation

## Goal

Replace the hand-drawn ASCII saucer in `banner()` (`src/standalone/cli.ts:913`) with a half-block render of `icons/switchboard-ufo-static.svg` — the pixel-art UFO the product already ships and already uses in its UI. One drawing, one palette, one source of truth, generated at build time into a constant the CLI prints.

### Problem Analysis & Root Cause

**The current art is a crude approximation of an asset that already exists.** `banner()` hand-draws six lines of `.-~` characters:

```
       .---.
 _...-'     '-..._       SWITCHBOARD v1.7.13
.-~  ●   ●   ●   ●  ~-.   Agent Fleet Command
(________________________)
      \   :    :   /       https://github.com/TentacleOpera/switchboard
       \  :    :  /        Host: Standalone (linux x64)
```

Meanwhile `icons/switchboard-ufo-static.svg` is a finished, deliberate piece of pixel art — `shape-rendering="crispEdges"`, a 320×180 viewBox on a strict 4px grid (a native **80 × 45 pixel** canvas), with the product's palette: hull greys `#0b0f0f / #1d2323 / #363a3a / #5e6666 / #a0a6a6`, cyan `#00e5ff` ports and cockpit. The CLI reimplements this badly in line-drawing characters instead of rendering it.

**Measured defects in the hand-drawn version**, all of which disappear when the art is derived rather than typed:

1. **`●` is U+25CF, East Asian Width = Ambiguous** — two cells wide in any terminal or locale that resolves ambiguous as wide, which shifts that line four columns right and breaks every alignment.
2. **The right-hand text column lands on three offsets** — 25, 26, 27 across four text lines.
3. **The dome is 3.5 columns off-centre** — hull spans cols 0–25 (centre 12.5), dome 7–11 (centre 9.0).
4. **The beam narrows downward** — 14 then 12 columns, drawn `\ … /`. A projected beam widens and is drawn `/ … \`. It currently reads as the saucer being pulled down.
5. **The dome is 5 columns over a 26-column hull**, so the silhouette does not read as a saucer.

**Nothing guards it.** The only test touching the banner (`src/test/cli-board-commands-contract.test.js:426-431`) asserts the tagline *string*; geometry and glyph width are unchecked, which is how all five survived.

**Feasibility is established, not assumed.** A prototype rasterised the SVG's `<g class="ufo">` group onto its native grid and rendered it with half-block cells (`▀` / `▄` carrying a foreground and background colour, so each cell holds two vertical pixels). Result: **8 rows × 44 columns**, recognisably the same craft, in the same palette.

> **Superseded:** "rasterised the SVG's `<g class="ufo">` group onto its native 80×45 grid (every coordinate is a multiple of 4 — divide, do not resample)" and "The 4px grid means the downsample is exact — no resampling, no anti-aliasing, no judgement calls."
> **Reason:** This is factually incorrect for the Y axis. A programmatic scan of every `<rect>`/`<path>` in `<g class="ufo">` (`icons/switchboard-ufo-static.svg`) shows: **X coordinates are all multiples of 4** (exact divide-by-4), **widths and heights are all multiples of 4**, but **Y coordinates are a mix of 0 mod 4 and 2 mod 4** — e.g. `y="50"`, `y="70"`, `y="90"`, `y="46"`, `y="54"`, `y="82"`, `y="98"` are all 2 mod 4, while `y="88"` is 0 mod 4. A uniform shift cannot align them all to a 4px cell boundary because the set is `{0, 2} mod 4` and a constant offset preserves the mix. Therefore "divide Y by 4, no resample" would place rects straddling every 4px cell boundary and produce a broken half-render. The prototype's own result (8 rows from a craft spanning y=42→106, i.e. 64 SVG-px) implies an 8:1 vertical reduction — which *is* resampling, with an implicit judgement rule. The claim hid the real work the rasteriser must do.
> **Replaced with:** The rasteriser divides **X by 4 exactly** (every X is a multiple of 4 → 80-column grid, hull occupies cols 18–62 → 44 columns wide). For **Y**, the group lives on a **2px grid** (every Y is even). The implementer must pick and document ONE of these explicit vertical strategies — there is no "free" exact 4px mapping:
> - **(preferred) 2px half-block cells:** each terminal cell maps to 2 SVG-px vertically (foreground = upper 2px row, background = lower 2px row). All Y are even → exact, no resampling. This yields more rows (the UFO spans 64px → 32 half-block rows over a 2px cell, or 16 rows over a 4px cell pairing two 2px rows). The exact row count depends on the chosen cell height; **the implementer must state the cell height and the resulting row count**, then verify ≤ a sensible banner height (the prototype's 8 rows is the target silhouette density — if 2px-exact rendering is too tall, use option 2).
> - **(fallback) documented 4px-cell downsample with an explicit rule:** render at 4px Y-cells and decide, per straddled cell, which half gets the colour (e.g. "majority pixel wins; ties → background"). This *is* resampling — name the rule in the generator's header comment so it is auditable and deterministic, not silent.
>
> Either way, the generator must be **deterministic** (same SVG → identical output) and the drift check (change 7) must still catch a stale generated file. The "no judgement calls" promise is withdrawn; the replacement promise is "the judgement is explicit, documented, and deterministic."

**Two portability constraints the render must handle** — neither is a reason not to do it, both are reasons to have a fallback:

- **`▀` U+2580 is also East Asian Width = Ambiguous**, the same class as the `●` being removed. The difference is that a half-block render can degrade to plain ASCII, whereas the current art has no fallback and is simply wrong in those terminals.
- **24-bit colour is not universal.** The prototype emits `\033[38;2;r;g;b`. Terminals limited to 256 colours, and pipes with no TTY at all, need their own path.

**The CLI must not parse SVG at runtime.** `banner()` is on the startup path of four commands — the call sites are `cli.ts:954` (`cmdAbout`), `cli.ts:1613` (the setup wizard, via `.replace`), `cli.ts:1686` (`cmdMainMenu`), and `cli.ts:1845` (`cmdBoardConsole`). The art is generated at build time into a constant.

> **Superseded:** Call-site line numbers "947, 1563, 1722" and the wizard at "1490"; `banner()` at "906"; the test at "`cli-board-commands-contract.test.js:426`".
> **Reason:** The cited line numbers have drifted from the current source by 7–130 lines and would send the implementer to the wrong functions (e.g. 906 lands inside `readVersion`, not `banner`).
> **Replaced with:** `banner()` at `src/standalone/cli.ts:913`; call sites at `954`, `1613`, `1686`, `1845`; the tagline contract assertion at `src/test/cli-board-commands-contract.test.js:426-431`.

**The trap for whoever implements this.** `cli.ts:1613` does not print the banner as-is:

```ts
console.log(banner(version).replace('Agent Fleet Command', 'Workspace & Scaffolding Wizard'));
```

The setup wizard string-matches into the banner output, and `cli-board-commands-contract.test.js:429` asserts the same literal. **`Agent Fleet Command` must survive byte-for-byte**; only the art around it changes.

## Metadata
**Topic:** Render the shipped UFO pixel art in the CLI banner
**Tags:** cli, ui, bugfix

> **Superseded:** `Tags: cli, standalone, ui, ascii-art, build, bugfix`
> **Reason:** `standalone`, `ascii-art`, and `build` are not in the allowed tag set (`frontend, backend, auth, authentication, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library`). The schema rejects invented tags.
> **Replaced with:** `Tags: cli, ui, bugfix`

**Complexity:** 5

> **Superseded:** `Complexity: 4`
> **Reason:** Undersold. The work spans multiple files (`scripts/`, `src/generated/`, `src/standalone/cli.ts`, `src/test/cli-board-commands-contract.test.js`), introduces net-new patterns with no existing code to reuse (there is currently NO terminal-capability/colour detection anywhere in `cli.ts` — no `COLORTERM`, `NO_COLOR`, `isTTY`, or ANSI-escape usage), and the rasteriser has a non-trivial Y-grid subtlety (the 2px-vs-4px issue corrected above). That is "majority routine but with one or two moderate, well-scoped risks extending existing patterns" → Mixed (5-6), not Low (3-4).
> **Replaced with:** `Complexity: 5` (Mixed). The build-time-generator + drift-check pattern is routine (it mirrors `catalog:generate`/`catalog:check`); the net-new tier-detection helper and the honest Y-rasterisation are the moderate risks.

## User Review Required

None.

## Complexity Audit

### Routine
- Generator script under `scripts/` reading a static SVG and emitting a TS module — direct copy of the `scripts/generate-verb-allowlist.js` → `src/generated/verbAllowlist.ts` pattern (header comment, `--write` flag, drift check without `--write`).
- Wiring `banner:generate` / `banner:check` npm scripts and chaining `banner:check` into the `test` script next to `catalog:check` — the `test` script already runs `npm run standalone-parity:check && npm run catalog:check && npm run icons:parity` (`package.json:872`); add `&& npm run banner:check`.
- Replacing the six-line hand-drawn array in `banner()` with an import of the generated constant.
- Keeping `Agent Fleet Command` as its own literal line for the `.replace` at `cli.ts:1613` and the contract test at `cli-board-commands-contract.test.js:429`.
- ASCII fallback tier — a corrected hand-drawn form (centred, beam widening `/ … \`, no code point above 0x7E).

### Complex / Risky
- **Net-new terminal-capability detection.** `cli.ts` currently has no `COLORTERM`/`NO_COLOR`/`isTTY`/escape-code handling. A single helper (e.g. `detectBannerTier()` returning `truecolor | x256 | ascii`) must be added and called once per `banner()` invocation; all four call sites reuse `banner()`, so detection runs once per call, not four times. No existing helper to reuse — this is new utility code.
- **The Y-axis rasterisation** (see Superseded callout in Problem Analysis). X divides by 4 exactly; Y is on a 2px grid and requires an explicit, documented, deterministic vertical strategy. An implementer who literally "divides by 4" ships a broken half-render.
- **Three ANSI emission paths** (truecolor `\033[38;2;r;g;b`, 256-cube quantisation of the six palette entries via a fixed lookup, plain ASCII) must never leak escape codes into a non-TTY/pipe — the tier selector gates this.

## Edge-Case & Dependency Audit

**Race Conditions**
- None. `banner()` is pure (builds a string from a generated constant + `version` + `process.platform`/`process.arch`); the generated module is static. No async, no shared mutable state, no FS access at runtime.

**Security**
- The generator reads `icons/switchboard-ufo-static.svg` at build time only. No runtime FS read, no `eval`, no dynamic import of the SVG. The generated constant is checked in and reviewed like `verbAllowlist.ts`. No untrusted input reaches `banner()`.

**Side Effects**
- `banner()` currently prints to stdout via `console.log` at four call sites; behaviour unchanged except the string content. The wizard path (`cli.ts:1613`) still does `.replace('Agent Fleet Command', 'Workspace & Scaffolding Wizard')` — the literal must remain on its own line for the replace to hit.
- Startup cost: `banner()` is on the startup path of four commands. The generated constant is a static import — no SVG parsing, no FS read at runtime. Verify `switchboard version` timing does not regress (Verification step 7).

**Dependencies & Conflicts**
- No new runtime dependency. `chalk`/`kleur` exist in `node_modules` as transitive deps but are NOT direct dependencies and are not used by `cli.ts` — do NOT introduce them. Emit raw ANSI escape sequences directly (the palette is six fixed colours; the escape strings are trivial and keep the standalone CLI dependency-free).
- The generator is a build-time `node` script (like `generate-verb-allowlist.js`); it may use only Node built-ins (`fs`, `path`) — no SVG library. The SVG is simple enough to parse with a regex over `<rect>`/`<path>` (every shape is axis-aligned rects + one path on the grid); a full SVG parser is unnecessary and would add a build-time dep.
- `src/generated/` already exists (`verbAllowlist.ts`); the new module joins it. The `test` script's drift-check chain gains one more `banner:check` entry.

## Dependencies

None. No prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) the Y-axis is a 2px grid, not the 4px grid the original plan claimed — a literal "divide by 4" rasteriser ships broken art, so the vertical strategy must be explicit and documented; (2) the sync/drift check is self-referential (deterministic ≠ correct), so machine-checkable pixel-colour invariants are needed to catch a wrong rasteriser without a human; (3) a colour tier could leak raw escape codes into a pipe, so a no-ESC-in-non-TTY invariant is needed. Mitigations: state the Y strategy in the generator header, add pixel-colour Goal Invariants at known cyan-port/hull coordinates, add a no-ESC-when-not-a-TTY invariant, and wire `banner:check` into `npm test` so drift fails CI exactly as `catalog:check` already does.

## Proposed Changes

### `scripts/generate-banner-art.js` (new)
- **Context:** Build-time generator mirroring `scripts/generate-verb-allowlist.js`. Reads `icons/switchboard-ufo-static.svg`, rasterises `<g class="ufo">`, emits `src/generated/bannerArt.ts`.
- **Logic:** Parse the `<g class="ufo">` group's `<rect>`/`<path>` elements. X: divide by 4 (all X are multiples of 4 → exact). Y: implement the chosen vertical strategy from the Superseded callout (prefer 2px-exact half-block cells; if the result is too tall for a banner, use the documented 4px-cell downsample with an explicit, commented rule). Trim to the occupied bounding box. Emit one TS constant per tier: `BANNER_ART_TRUECOLOR` (rows of `▀`/`▄` with `\033[38;2;r;g;b`/`48;2;r;g;b` escapes), `BANNER_ART_256` (same cells, palette quantised to the xterm-256 cube via a fixed 6-entry lookup), `BANNER_ART_ASCII` (corrected hand-drawn form, no code point > 0x7E). Header comment must state the X/Y grid facts and the vertical strategy chosen, so the "no judgement calls" correction is auditable in the file itself.
- **Implementation:** `--write` overwrites `src/generated/bannerArt.ts`; without `--write`, regenerates in-memory and diffs against the checked-in file, exiting non-zero on drift (identical contract to `generate-verb-allowlist.js`).
- **Edge Cases:** Deterministic — same SVG → byte-identical output (run twice, diff). The `<path d="M136 42h48v4h12v8h8v16h-88V54h8v-8h12z">` dome outline must be rasterised too (it is the hull silhouette), not just the `<rect>`s. Opacity attributes (`opacity=".55"` etc.) on the cockpit cyan must be composed against the underlying rect, not dropped.

### `src/generated/bannerArt.ts` (new, generated)
- **Context:** Checked-in generated module, imported by `cli.ts`. Same status as `verbAllowlist.ts` — never hand-edited; regenerated by `banner:generate`.
- **Logic:** Exports the three tier constants above plus the palette array (so the test can assert specific colours). No runtime logic — pure data.

### `src/standalone/cli.ts` (edit)
- **Context:** `banner()` at line 913; call sites at 954, 1613, 1686, 1845. Currently no terminal-capability detection exists in this file.
- **Logic:**
  - Add a single `detectBannerTier(): 'truecolor' | 'x256' | 'ascii'` helper. Detection order: `NO_COLOR` set → `ascii`; not `process.stdout.isTTY` → `ascii`; `COLORTERM` contains `truecolor` or `24bit` → `truecolor`; else → `x256`. Call it once inside `banner()`.
  - Rewrite `banner()` to import the tier constants from `src/generated/bannerArt.ts`, select by `detectBannerTier()`, and lay out: art block, then `Agent Fleet Command` on its own line, then version, URL, and `Host: Standalone (...)` lines beneath (text moves below the art — at 44 columns wide the art plus the 44-char URL exceeds 80 side-by-side).
  - **`Agent Fleet Command` stays byte-for-byte** on its own line so `cli.ts:1613`'s `.replace` and the contract test still hit.
- **Implementation:** Four call sites already call `banner(version)`; no call-site changes except they inherit the new output. Do not inline detection per call site — one helper, one call per `banner()`.
- **Edge Cases:** When stdout is not a TTY (pipe/redirect), `detectBannerTier()` returns `ascii` and no escape codes are emitted — the ASCII constant contains none. Long version strings (`1.7.13-rc.1+build.20260901`) go on their own line beneath the art and must not wrap (Verification step 9).

### `package.json` (edit)
- **Context:** `test` script at line 872 runs `standalone-parity:check && catalog:check && icons:parity`; `catalog:generate`/`catalog:check` at lines 945-946.
- **Logic:** Add `"banner:generate": "node scripts/generate-banner-art.js --write"` and `"banner:check": "node scripts/generate-banner-art.js"`. Append `&& npm run banner:check` to the `test` script so CI fails on a stale generated file, exactly as `catalog:check` already does.
- **Edge Cases:** None — additive, mirrors an existing pattern.

### `src/test/cli-board-commands-contract.test.js` (edit)
- **Context:** Existing tagline assertion at lines 426-431. Add geometry, portability, and rasteriser-correctness guards alongside it.
- **Logic — add assertions:**
  - ASCII fallback constant contains no code point above `0x7E`.
  - Every tier constant is ≤ 80 columns wide (measure the widest row, accounting for ambiguous-width cells by counting code points, not display columns — or assert on the ASCII tier width only and rely on the half-block tiers being bounded by the same 44-column hull).
  - `Agent Fleet Command` literal is present in `cli.ts` source (keep the existing assertion at 429) AND in the generated ASCII fallback.
  - **Rasteriser-correctness invariant (the load-bearing one):** import the palette from `bannerArt.ts` and assert specific cells carry the expected colours — e.g. a cyan-port cell is `#00e5ff` and a hull cell is `#1d2323`/`#363a3a`. This catches a broken rasteriser that is "in sync with itself" but wrong, which the drift check alone cannot.
  - **No-ESC-in-pipe invariant:** assert that when `banner()` is rendered with a non-TTY stdout (or by forcing the `ascii` tier), the output contains no `\x1b` byte. This catches tier leakage into a pipe.
  - **Sync guard:** run the generator in `--check` mode (no `--write`) and assert zero drift vs the checked-in `bannerArt.ts` — the same contract `catalog:check` enforces.
- **Edge Cases:** The pixel-colour assertions must reference coordinates derived from the SVG (e.g. the cyan ports are at `x=96,120,144,168,192,216; y=82-94`), so if the SVG changes the test is updated deliberately, not silently.

## Verification Plan

### Automated Tests
1. **Existing contract test passes** with the added assertions (pixel-colour, no-ESC-in-pipe, ASCII-no-high-codepoints, ≤80 cols, sync/drift).
2. **Generator is deterministic and in sync.** Run `banner:check` — passes. Run `banner:generate` twice and diff the output — byte-identical. Edit the SVG, run `banner:check` — it fails (drift detected). Regenerate, confirm the art changes, `banner:check` passes again.
3. **`npm test`** now includes `banner:check` and passes end-to-end.

### Goal Invariants
- **Rasteriser correctness (positive):** in `src/generated/bannerArt.ts`, the cell at the cyan-port coordinate (derived from SVG `x∈{96,120,144,168,192,216}`, `y∈[82,94]`) carries colour `#00e5ff`; a hull-band cell carries `#1d2323` or `#363a3a`. (Catches a deterministic-but-wrong rasteriser — the failure mode the drift check alone misses.)
- **No hand-drawn `●` (negative, paired):** the code point `U+25CF` (`●`) is absent from `src/standalone/cli.ts`'s `banner()` body; the UFO art is resolvable from `src/generated/bannerArt.ts` (positive) — i.e. the hand-drawn approximation is gone *here*, the derived art is present *there*. (The goal is to replace the hand-drawn saucer, so a negative invariant on the removed glyph is mandatory.)
- **No escape codes in a non-TTY (negative, paired):** `banner()` output rendered with a non-TTY stdout contains no `\x1b` byte (absent here); the same call rendered with `COLORTERM=truecolor` DOES contain a truecolor escape sequence (present there) — so the gate is "no ESC when piped" not "no ESC ever".
- **Tagline survives (positive):** the literal `Agent Fleet Command` is present both in `src/standalone/cli.ts` and in the generated ASCII fallback constant — so the wizard `.replace` at `cli.ts:1613` and the contract test at `cli-board-commands-contract.test.js:429` still hit.
- **Width (positive):** the widest row of every tier constant in `src/generated/bannerArt.ts` is ≤ 80 columns.

### Manual / Visual Checks
4. **Render each tier by forcing it**: `COLORTERM=truecolor`, then a 256-colour term, then `NO_COLOR=1`, then piped to `cat`. All four produce sensible output; none emits raw escape codes into a pipe.
5. **It reads as the product's UFO.** Put the terminal render beside the SVG in a browser. Same silhouette, same cyan ports, same hull banding. If it is not recognisably the same craft, the rasteriser is wrong. (The pixel-colour Goal Invariant above is the automated backstop for this manual check.)
6. **Ambiguous-width proof.** Run under `LANG=ja_JP.UTF-8` and in a terminal treating ambiguous width as wide. Either the half-block render still aligns, or the ASCII fallback engages — a broken half-render is a fail.
7. **All four call sites**: `switchboard about`, `switchboard version`, bare `switchboard`, and the wizard path.
8. **The wizard tagline still swaps** — `cli.ts:1613` prints `Workspace & Scaffolding Wizard`. A silent no-op here means the literal moved.
9. **Startup cost.** Time `switchboard version` before and after. It must not measurably change — if it does, the SVG is being parsed at runtime (it must not be).
10. **Long version string** (`1.7.13-rc.1+build.20260901`) does not wrap.

> Note: the session that produced this plan skipped running compilation and automated tests during the review pass; the checks above remain the verification contract for the implementer.

## Review Findings

**The implementation was entirely absent when this card reached review** — no generator, no generated module, `banner()` byte-for-byte unchanged (verified across the working tree, all branches, `git stash` and `git worktree list`), so the reviewer implemented the plan and then verified it. Files changed: `scripts/generate-banner-art.js` (new), `src/generated/bannerArt.ts` (new, generated), `src/standalone/cli.ts` (`detectBannerTier()` added, `banner()` rewritten), `src/test/cli-board-commands-contract.test.js` (banner assertions), `package.json` (`banner:generate` / `banner:check`, chained into `test`), `.github/workflows/integration-tests.yml` (a `banner:check` CI step — the plan's claim that chaining into the `test` script gates CI "exactly as `catalog:check` does" is false, because CI invokes `catalog:check` as its own named step and never runs the bare `test` script). Validation: `npm test` green including the new `banner:check`; the CLI contract suite green with 10 new gates, each proved to fail under a deliberate mutation (10/10 caught); generator byte-identical across runs; `tsc` and `eslint` clean for the changed files (5 pre-existing TS2835 errors and 28 pre-existing lint warnings are untouched); all four call sites plus the wizard's tagline `.replace` exercised against the built CLI in a real pty across the truecolor, 256, ASCII, `NO_COLOR` and CJK-locale paths; the full 154-suite contract sweep is 125 pass / 29 fail with all 29 proved red at HEAD before this change. Remaining risk: the CJK degrade keys on locale environment variables, which a terminal that resolves ambiguous width as wide without a CJK locale will not set.

## Deferred Findings

- NIT `scripts/generate-banner-art.js:296` — the truecolor/256 renderers emit a full SGR per cell rather than tracking colour state across a run, so the generated constants are ~8 KB larger than a run-length-encoded emitter would produce. Output is correct; only bundle size is affected.
- NIT `scripts/generate-banner-art.js:141` — the path parser supports only the `M/L/H/V/Z` subset and throws on anything else. Correct for the one rectilinear path in this SVG, and failing loudly is the right behaviour, but a future curved dome outline would need parser work rather than a config change.
- NIT `src/standalone/cli.ts:930` — the ambiguous-width degrade keys on `LC_ALL`/`LC_CTYPE`/`LANG`. A terminal configured to render ambiguous-width glyphs as wide while running under a non-CJK locale still receives the half-block tier. There is no environment signal for that case short of a cursor-position probe, which is not worth it on a banner.

### Review Deviations

Inert prose for the author — not a directive to any future agent. Three points where the delivered work differs from the plan's letter, none of them a change of destination or goal:

1. **The ASCII fallback is derived from the same raster, not hand-drawn.** The plan's Complexity Audit called for "a corrected hand-drawn form (centred, beam widening `/ … \`)". Deriving it from the identical pixel grid via a luminance ramp serves the stated Goal ("One drawing, one palette, one source of truth") better than a second hand-typed drawing, and makes the centring correct by construction rather than by hand. Note the beam is not in scope at all: it lives in `<g class="beam">`, outside the `<g class="ufo">` group the Goal names, so no tier renders a beam and the "beam widens downward" defect is resolved by removal rather than by redrawing.
2. **`Agent Fleet Command` is not emitted into the generated ASCII constant.** The plan's "Tagline survives" Goal Invariant asks for the literal in both `cli.ts` and the generated fallback. Injecting a product tagline into a file generated from an SVG has no sensible source; the tagline stays a layout line in `banner()`. The invariant's actual purpose — that the wizard `.replace` at `cli.ts:1678` and the contract assertion still hit — is met and now gated on all four tiers by an executed test, not a regex.
3. **The version line precedes the tagline**, preserving the original banner's reading order (`SWITCHBOARD v…` then `Agent Fleet Command`) rather than the order the Proposed Changes section lists. Placement below the art, which is what that clause is about, is as specified.

Also worth the author's attention: the plan's Goal Invariant naming the cyan-port coordinate assumed the port band was uniform. It is not — the SVG's own ports sit at three different Y offsets (82, 86, 88) and are **not** mirror-symmetric across the hull (outer ports at x=96 and x=216 against a hull centred on x=160, so the left port lands one cell further in). The contract test pins the full per-row cyan span map derived from the SVG rather than assuming symmetry.
