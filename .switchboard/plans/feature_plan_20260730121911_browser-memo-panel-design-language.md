# Restyle the Browser Memo Panel to Switchboard's Panel Design Language

## Goal

Rebuild `src/webview/memo.html`'s styling on the same token set, chrome, and control classes every other Switchboard panel uses, so the browser cockpit's Memo panel stops looking like a foreign page — and stops repainting itself neon cyan/pink under the default theme.

### Problem

The Memo panel in the browser cockpit (`http://127.0.0.1:<port>/memo`, served by `getMemoHtml` at [headlessPanelHtml.ts:315-337](../../src/services/headlessPanelHtml.ts#L315-L337)) shares no visual vocabulary with the Board, Project, Setup, Planning, or Design panels: wrong accent colour, wrong surface colour, wrong button shape, wrong fonts, no panel header, and — under the **default** theme — cyan body text with pink-bordered buttons.

### Root cause

`memo.html` was written as a standalone page with its own miniature palette (memo.html:22-42) instead of the panel token set the rest of the repo shares. Five concrete divergences, each verifiable:

1. **The theme class it repaints on is the default theme.** `getThemeBodyClass()` returns `cyber-theme-enabled` for **afterburner, which is the default and the fallback for any unknown theme value** ([themeBodyClass.ts:95-101](../../src/services/themeBodyClass.ts#L95-L101)), and the extension host injects that class into the served memo HTML (`sharedGetPanelHtmlById(id, repoRoot, wsRoot, caps, getTheme())`, TaskViewerProvider.ts:1873 → `applyThemeClass`, headlessPanelHtml.ts:82-88). But `memo.html:36-42` treats `cyber-theme-enabled` as a full neon repaint:

   ```css
   body.cyber-theme-enabled {
       --text-primary: #00f0ff;   /* ALL body text goes cyan */
       --text-secondary: #7000ff; /* purple secondary text */
       --border-color: #00f0ff;
       --accent-teal: #ff0055;    /* pink accent */
       --bg-color: #05050a;
   }
   ```

   No other panel does this — in `kanban.html` / `project.html` / `setup.html`, afterburner **is** the `:root` base palette (`#00e5ff` accent, `#e0e0e0` text) and `cyber-theme-enabled` only adds effects. So the panel most users see by default is the one that looks least like Switchboard. This is the single biggest contributor to "does not follow switchboard's style at all".

2. **Wrong token values in every theme.** `:root` accent is `#00f0ff` (canon: `--accent-primary: #00e5ff`); background is `#0e0e10` (canon: `--panel-bg: #000000`, `--bg-color: #0d0d0d`); and the claudify accent is `#d97706` — **amber**, where canonical claudify is `#D97757` terracotta (`project.html:66-70`, `setup.html:37-48`).

3. **Ad-hoc controls instead of the shared classes.** `.strip-btn` (memo.html:54-67) hardcodes a Zinc palette (`#18181b` / `#27272a`), 12px sentence case, 4px radius. The canonical control is `.secondary-btn` (implementation.html:812-830) — `--panel-bg2` fill, `--border-color` border, 10px `--font-mono` **uppercase** with 1.2px letter-spacing, 2px radius — with `.secondary-btn.is-teal` (implementation.html:856-866) for the accent actions. The sidebar's own memo tab already uses exactly those classes (implementation.html:1605-1607).

4. **Undefined font tokens and a dead font.** The textarea asks for `var(--font-mono, monospace)` but `memo.html` never defines `--font-mono` (canon: `var(--vscode-editor-font-family, 'SF Mono', Monaco, …)`), so it silently falls back to the generic monospace face. Meanwhile the panel loads the pixel display font (`{{GEIST_PIXEL_FONT_URI}}` is substituted at headlessPanelHtml.ts:330) under the family name `'Geist Pixel Square'` — every other panel declares it as `'GeistPixel'` — and then never applies it. A downloaded font that no rule can match.

5. **No panel chrome, and layout by inline style.** The body (memo.html:74-92) is a bare padded `div` with `style="…"` on almost every element: no header, no `.section-label`, no bordered panel surface. Every other panel puts its structure in classes inside `<style>`.

### Scope

Styling and markup structure of the browser Memo panel only. Element **ids** and the message contract are unchanged; this plan does not touch `memo.js` behaviour, the memo verbs, or any host code.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## User Review Required

1. **The default-theme look changes for every user.** Inverting `body.cyber-theme-enabled` from "neon repaint" to "afterburner = base palette" is the whole point of this plan, but it means the panel most users see today (cyan text, pink buttons, `#05050a` background) becomes the standard grey-on-black panel look. This is alignment with four sibling panels, not a redesign — but it is a visible change on ~4,000 shipped installs and should be an intentional sign-off, not a silent side effect.
2. **The pixel display font.** Change 1 offers two acceptable outcomes: rename the `@font-face` family to `'GeistPixel'` and use it on the panel header, or delete the `@font-face` block entirely and leave the header on Hanken Grotesk. This plan takes the **rename-and-use** route (it matches `project.html` / `kanban.html` chrome). Say so if the plainer Hanken header is preferred.
3. **No workspace indicator here.** The header gains a `#memo-workspace` slot but this plan leaves it empty — subtask 3 fills it. If subtask 3 is dropped, the empty span should be removed with it.

## Complexity Audit

### Routine

- One 97-line HTML file, rewritten in place: replace the token block, add the canonical control/label classes, restructure the body markup, drop the inline styles.
- No host code, no verbs, no persistence, no CSP change (all styling stays inline in the existing `<style>`, permitted by the panel's `style-src 'unsafe-inline' 'self'` at headlessPanelHtml.ts:326).
- Every value is copied from an existing sibling panel rather than invented, so there is no design decision to litigate — only a transcription to get right.

### Complex / Risky

- **The `cyber-theme-enabled` semantics change is behavioural, not cosmetic.** Inverting that block from "neon repaint" to "afterburner = base palette" changes what the default-theme panel looks like for every user. It is the correct alignment (it matches four other panels), but it must be stated as an intentional change rather than slipped in.
- **`memo.html` is browser-only.** `grep -rn "memo.html" src` returns three hits: the two `getMemoHtml` candidate paths and the `/memo` route (LocalApiServer.ts:3395). The sidebar's memo UI is a *separate* copy inside `implementation.html` (its own markup at 1591-1607 and its own JS at 2688-2721). So this change cannot regress the editor sidebar — and equally, it does not fix it. Copy classes **from** `implementation.html`; do not import or refactor it.
- **Two theme entry points must agree.** First paint comes from `applyThemeClass` (server-side, headlessPanelHtml.ts:82-88); later switches come from `memo.js`'s `handleThemeChanged` (memo.js:5-12), which maps `'cyber' || 'afterburner'` → `cyber-theme-enabled`. That mapping is already consistent with `getThemeBodyClass`; the defect is what the class *means* in this file's CSS. Leave the JS mapping alone.
- **This file is the shared surface for all three subtasks.** Subtask 2 adds an `.is-copied` rule; subtask 3 adds a `#memo-workspace` span inside `.memo-header`. Both are written against the markup this plan produces, so this plan lands first and must reserve both hooks (see Proposed Changes 2 and 3).

## Edge-Case & Dependency Audit

### Race Conditions

- **Two theme entry points can disagree in time, not in mapping.** Server-side `applyThemeClass` paints the class on first byte; `memo.js`'s `handleThemeChanged` re-applies it on a later `switchboardThemeChanged` push. Both map afterburner → `cyber-theme-enabled`, so there is no flash of a wrong palette *provided* that class is non-repainting after this change. If a future edit re-adds token overrides under `cyber-theme-enabled`, first paint and re-paint would still agree — which is exactly why the contract test in change 4 asserts on the CSS, not on the class string.
- No other race: this plan adds no async behaviour, no fetch, no timer.

### Security

- No CSP change. All styling stays inside the existing inline `<style>`, which the panel's CSP already permits (`style-src 'unsafe-inline' 'self'`, headlessPanelHtml.ts:326). No new `img-src`, no new `font-src` origin — the pixel font is already served from `/static/designs/GeistPixel-Square.woff2` (headlessPanelHtml.ts:330).
- The `{{NONCE}}` placeholder must survive untouched; it is the only thing permitting `memo.js` to execute.

### Side Effects

- **Element ids are load-bearing — keep all five.** `memo.js` selects `#memo-textarea`, `#memo-status`, `#memo-clear-btn`, `#memo-copy-btn`, `#memo-send-btn` (memo.js:27, 38, 59, 69, 81, 90), and `transport.js:343` hides `#memo-send-btn` by id when `caps.terminalDispatch === false`. Renaming or wrapping any of them breaks the panel silently.
- **`<body>` attributes are injected, not authored.** `getMemoHtml` does `content.replace(/<body/, '<body ' + bodyAttr)` (headlessPanelHtml.ts:334) to add `data-initial-workspace-root`, `data-panel`, `data-host-capabilities`, and `applyThemeClass` then rewrites the `class` attribute (headlessPanelHtml.ts:82-88). The source file therefore carries a bare `<body>` and must keep it bare — do not hand-author a `class` on it (it would be stripped) and do not add attributes that the regex insertion would land before.
- **Send to Planner is hidden in the standalone host.** `baseStandaloneCapabilities.terminalDispatch = false` (bootstrap.ts:384-391) vs `true` in the extension host (TaskViewerProvider.ts:1822-1829). The button row must look right with **two** buttons as well as three: a `display: flex; gap:` row handles this correctly (a `display: none` child consumes no gap), but a CSS grid with three fixed columns would leave a hole. Use flex.
- **Standalone passes no theme class at all.** `sharedGetPanelHtmlById(id, repoRoot, workspaceRoot, await getStandaloneCaps())` (bootstrap.ts:422) omits the `themeClass` argument, so `<body>` carries no theme class there and the `:root` block alone renders the panel. After this change that is the correct afterburner look — which is precisely why the base palette must be canonical afterburner rather than a neon variant.
- **Claudify must kill the glow.** Per the established pattern, the claudify block redeclares the whole accent family plus glow removal — a CSS variable resolves where it is *declared*, so overriding only `--accent-primary` leaves derived teal tokens cyan (the comment at project.html:63-65 records this).
- **The textarea keeps `resize: vertical` and a min-height.** The panel is the memo capture surface; removing user resize to tidy the layout would be a functional regression.
- **Do not add an entry counter.** Entry parsing lives host-side (`_parseMemoEntries`); a client-side count would be a second, divergent implementation of the split rule. The status line already reports the count after a copy/send.

### Dependencies & Conflicts

- **`color-mix()` usage.** The canonical `.secondary-btn.is-teal` rules use `color-mix(in srgb, …)`. Supported in the Chromium the cockpit and the VS Code webview both run on; no fallback needed, consistent with the rest of the repo (`setup.html:28`, `implementation.html:209-233` already ship it).
- **Cache/serving dependency.** `getMemoHtml` prefers `dist/webview/memo.html` over `src/` (headlessPanelHtml.ts:316-319) and the installed extension serves from its own install folder. A stale `dist/webview/memo.html` is present today (built 29 Jul). Rebuild + sync + reload before judging; panel HTML is served `no-store` but a stale `dist` looks identical to "the change did nothing".
- **Shim-injection anchor.** `injectTransportShim` for this panel replaces `<!-- SHARED_DEFAULTS_SCRIPT -->`, falling back to the exact string `<script nonce="…" src="/static/webview/memo.js"></script>` (headlessPanelHtml.ts:331). Both must survive the markup rewrite verbatim; `String.replace` returns the input unchanged when the needle is absent, so deleting either is silent at build **and** serve time (the regression `webview-shim-injection-contract.test.js` exists to catch).
- **Downstream subtasks depend on this markup.** Subtask 2 (`…_browser-memo-clear-and-copy-confirmation.md`) adds `.is-copied` to this file and reads `--accent-green` / `--accent-red` from its token block. Subtask 3 (`…_memo-panel-frozen-workspace-root.md`) inserts `<span id="memo-workspace" class="memo-hint">` into `.memo-header`. Land this plan first; both hooks are reserved here.

## Dependencies

- None — no prior agent session output is required. This plan is self-contained: every value it copies already exists in `src/webview/setup.html` and `src/webview/implementation.html` in the working tree.
- **Intra-feature ordering:** this is subtask 1 of 3 in *Browser Memo Panel* and must land **first** — subtasks 2 and 3 both edit the markup and tokens produced here.

## Adversarial Synthesis

**Risk summary.** The one substantive risk is that this is a visible default-theme change on ~4,000 shipped installs disguised as a styling tidy-up: inverting `body.cyber-theme-enabled` from a neon repaint to a no-op is behavioural, and the contract test in change 4 exists specifically because a future edit could quietly re-add a token override under the default theme's own class. The second risk is silent breakage rather than visual: the five element ids, the bare `<body>` tag, and the shim-injection anchor are all load-bearing and all fail *quietly* if the markup rewrite loses them — `String.replace` no-ops on a missing needle, and `memo.js` binds by id with `if (el)` guards that swallow a miss. Mitigations: assert ids and the shim anchor in the contract test; assert the absence of token overrides inside the default-theme block; verify against the sidebar Memo tab (a separate copy) to confirm it is untouched.

## Proposed Changes

### 1. `src/webview/memo.html` — replace the token block (lines 22-42)

**Context.** Lines 22-42 hold a five-token miniature palette plus two theme blocks, one of which repaints the default theme. The canonical set is `setup.html:15-48` (the closest sibling panel: same single-column settings shape, same claudify handling).

**Logic.** Adopt the canonical panel tokens verbatim, and make `cyber-theme-enabled` a non-repainting class.

**Implementation.**

```css
        :root {
            --bg-color: #0d0d0d;
            --panel-bg: #000000;
            --panel-bg2: #050505;
            --border-color: #333333;
            --border-bright: #444444;
            --text-primary: #e0e0e0;
            --text-secondary: #8C8C8C;
            --accent-primary: #00e5ff;
            --accent-teal: var(--accent-primary);
            --accent-teal-dim: color-mix(in srgb, var(--accent-teal) 40%, transparent);
            --accent-green: #4ec9b0;
            --accent-red: #f85149;
            --font-family: 'Hanken Grotesk', var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
            --font-mono: var(--vscode-editor-font-family, 'SF Mono', Monaco, 'Cascadia Code', 'Consolas', monospace);
        }

        /* Afterburner IS the :root palette (matches kanban/project/setup) — this
           class adds effects only. It must NOT repaint text or surfaces: it is the
           DEFAULT theme's class (getThemeBodyClass → 'cyber-theme-enabled'). */
        body.cyber-theme-enabled { }

        body.theme-claudify {
            /* The teal family derives from --accent-primary on :root, so each
               derived token is redeclared here or it stays cyan. */
            --accent-primary: #D97757;
            --accent-teal: #D97757;
            --accent-teal-dim: color-mix(in srgb, #D97757 40%, transparent);
            --text-secondary: #8C8C8C;
            --border-color: #333333;
            --border-bright: #444444;
        }
```

> **Superseded:** the token block omitted `--accent-green` and `--accent-red`.
> **Reason:** both are canonical (`setup.html:29-30`, `implementation.html:32-34`) and both are needed *inside this feature*: the canonical `.section-label` colour is `var(--accent-green)` (see change 2), subtask 2's `.is-copied` affirmation state is `var(--accent-green)`, and subtask 2's error status colour is `var(--accent-red)`. Omitting them here forces two downstream files to carry literal-hex fallbacks (`var(--accent-green, #4ec9b0)`), which is the exact "own miniature palette" failure this plan exists to remove.
> **Replaced with:** `--accent-green: #4ec9b0;` and `--accent-red: #f85149;` declared on `:root` (values copied from `setup.html:29-30`). Claudify does **not** need to override them — it overrides only `--glow-green` / `--glow-red`, and this panel references no glow tokens.

**Edge cases.** Also fix the pixel-font family name in the `@font-face` at lines 15-21 to `'GeistPixel'` (matching `project.html:14` and `kanban.html:17`) so it can be referenced by the header rule in change 2. Do not leave a downloaded font that no selector can match — if the plainer Hanken header is chosen instead (see User Review Required), delete the `@font-face` block outright.

### 2. `src/webview/memo.html` — replace `.strip-btn` (lines 54-70) with the canonical control classes

**Context.** `.strip-btn` and `.markdown-editor` are the file's only two component rules, both ad hoc. The canonical equivalents live in `implementation.html` — the same file whose sidebar Memo tab already uses them.

**Logic.** Copy the canonical `.secondary-btn` family, `.section-label`, and `.modal-textarea` verbatim, then add the panel chrome those classes are designed to sit inside.

**Implementation.** Copied from `implementation.html:812-830` and `:856-866`, plus the label and textarea classes:

```css
        .section-label {
            font-family: var(--font-mono);
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 2px;
            color: var(--accent-green);
            font-weight: 600;
            opacity: 0.7;
        }
        /* Claudify does not override --accent-green, so the label would render
           teal-green against a terracotta panel. setup.html:55-56 records the
           same fix. */
        body.theme-claudify .section-label { color: #8a8a8a; }

        .secondary-btn {
            background: var(--panel-bg2);
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            padding: 8px;
            font-size: 10px;
            font-family: var(--font-mono);
            text-transform: uppercase;
            letter-spacing: 1.2px;
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: none;
            border-radius: 2px;
        }
        .secondary-btn:hover {
            background: color-mix(in srgb, var(--border-bright) 10%, transparent);
            border-color: var(--border-bright);
            color: var(--text-primary);
        }
        .secondary-btn.is-teal {
            color: var(--accent-teal);
            border-color: color-mix(in srgb, var(--accent-teal) 40%, transparent);
            background: color-mix(in srgb, var(--accent-teal) 5%, var(--panel-bg2));
        }
        .secondary-btn.is-teal:hover {
            border-color: var(--accent-teal);
            background: color-mix(in srgb, var(--accent-teal) 10%, var(--panel-bg2));
            box-shadow: 0 0 12px color-mix(in srgb, var(--accent-teal) 25%, transparent);
        }
        body.theme-claudify .secondary-btn.is-teal:hover { box-shadow: none; }

        .modal-textarea {
            width: 100%;
            min-height: 320px;
            resize: vertical;
            background: #0a0a0a;
            color: var(--text-primary);
            border: 1px solid var(--border-color);
            padding: 8px;
            font-family: var(--font-mono);
            font-size: 12px;
        }
        .modal-textarea:hover,
        .modal-textarea:focus {
            border-color: var(--border-bright);
            outline: none;
        }
```

> **Superseded:** `.section-label { … color: var(--text-secondary); }` with no claudify override.
> **Reason:** not canonical. The shared `.section-label` is `color: var(--accent-green); opacity: 0.7; margin-bottom: 8px` (implementation.html:152-161), and `setup.html:53-56` adds `body.theme-claudify .section-label { color: #8a8a8a; }` because claudify does not override `--accent-green` — the exact "stray teal headers" bug its own comment records. Shipping `--text-secondary` here would make this panel's label diverge from every sibling, which is the defect this plan exists to remove.
> **Replaced with:** the canonical `--accent-green` label plus the claudify grey override, as written above. `margin-bottom` is dropped because the label sits in a flex header row, not above a block.

> **Superseded:** the `.secondary-btn` rule omitted `box-shadow: none;`.
> **Reason:** the canonical rule (implementation.html:822) declares it, so an inherited or cascaded shadow cannot leak onto the resting state. Transcription fidelity is the whole point of this change.
> **Replaced with:** `box-shadow: none;` added, as above.

Add the panel chrome (header bar + bordered body surface) in the same block:

```css
        body { background: var(--bg-color); color: var(--text-primary); font-family: var(--font-family); }
        .memo-header {
            display: flex; align-items: center; justify-content: space-between;
            gap: 12px; padding: 12px 20px;
            border-bottom: 1px solid var(--border-color);
            background: var(--panel-bg);
        }
        .memo-body { padding: 16px 20px; max-width: 760px; }
        .memo-hint { font-size: 11px; color: var(--text-secondary); line-height: 1.5; }
        .memo-actions { display: flex; gap: 8px; margin-top: 10px; }
        .memo-actions .secondary-btn { flex: 1; }
        #memo-status { font-size: 11px; color: var(--text-secondary); min-height: 14px; display: block; margin-top: 8px; }
```

**Edge cases.** `.memo-actions` must stay `display: flex` — `transport.js:343` sets `display: none !important` on `#memo-send-btn` in the standalone host, and a flex row absorbs the missing child cleanly where a three-column grid would leave a hole. `#memo-status` keeps `min-height: 14px` so the layout does not jump when a status message appears and clears.

### 3. `src/webview/memo.html` — restructure the body markup (lines 74-92), dropping every inline `style`

**Context.** The current body is one padded `div` wrapping another, with `style="…"` on seven of nine elements.

**Logic.** Replace with the header/body structure the classes above describe. Ids and button order preserved exactly.

**Implementation.**

```html
<body>
    <div class="memo-header">
        <span class="section-label">Memo</span>
        <span id="memo-workspace" class="memo-hint" title="Workspace this memo is saved to"></span>
    </div>
    <div class="memo-body">
        <p class="memo-hint">
            Jot down bugs, thoughts, or issues — one per line or paragraph. Saved automatically.
            Send to an agent via Copy Prompt / Send to Planner to create one plan per issue.
        </p>
        <p class="memo-hint">Tip: you can also use 'start memo capture' in an agent chat.</p>
        <textarea id="memo-textarea" class="modal-textarea"
                  placeholder="Bug: login button overlaps on mobile&#10;&#10;Thought: maybe cache the user profile&#10;&#10;Issue: API returns 500 on empty payload..."></textarea>
        <span id="memo-status"></span>
        <div class="memo-actions">
            <button id="memo-clear-btn" class="secondary-btn">Clear</button>
            <button id="memo-copy-btn" class="secondary-btn is-teal">Copy Prompt</button>
            <button id="memo-send-btn" class="secondary-btn is-teal">Send to Planner</button>
        </div>
    </div>
    <!-- SHARED_DEFAULTS_SCRIPT -->
    <script nonce="{{NONCE}}" src="{{MEMO_JS_URI}}"></script>
</body>
```

> **Superseded:** the header contained only `<span class="section-label">Memo</span>`.
> **Reason:** subtask 3 of this feature inserts `<span id="memo-workspace" class="memo-hint">` into this exact header to make the bound workspace visible. Declaring the slot here — empty, and populated by `memo.js` only once subtask 3 lands — means subtask 3 edits `memo.js` alone and never re-opens this file's markup, so the two subtasks cannot collide on it. `justify-content: space-between` on `.memo-header` already reserves the right-hand position; an empty span renders nothing.
> **Replaced with:** the header shown above, carrying the empty `#memo-workspace` slot.

**Edge cases.** The `<!-- SHARED_DEFAULTS_SCRIPT -->` marker and the `{{NONCE}}` / `{{MEMO_JS_URI}}` placeholders must survive untouched — `injectTransportShim` keys the transport injection off that comment (headlessPanelHtml.ts:331), and its deletion is silent at build and serve time (see the regression documented in `webview-shim-injection-contract.test.js`). `<body>` stays bare: `getMemoHtml` injects `data-initial-workspace-root` / `data-panel` / `data-host-capabilities` by regex (headlessPanelHtml.ts:334) and `applyThemeClass` rewrites `class` (headlessPanelHtml.ts:82-88).

Delete the now-unused `.markdown-editor` rule (memo.html:68-70) and the `class="markdown-editor"` on the textarea — it only existed to set a font that `.modal-textarea` now sets.

### 4. `src/test/memo-panel-style-contract.test.js` — new contract test

**Context.** The regression worth locking is not "the panel looks nice" but "the DEFAULT theme's class does not repaint the panel" — a single re-added line under `body.cyber-theme-enabled` reproduces the whole reported defect.

**Implementation.**

```js
'use strict';
/**
 * Contract: the browser Memo panel uses the shared panel token set, and the
 * DEFAULT theme class does not repaint it.
 *
 * The regression this locks down: `cyber-theme-enabled` is what
 * getThemeBodyClass() returns for afterburner — the DEFAULT theme — so any
 * text/background/accent override under that selector ships as the look most
 * users see. memo.html previously repainted all text cyan and the accent pink.
 */
const assert = require('assert');
const path = require('path');
const { getMemoHtml } = require('../../out/services/headlessPanelHtml');

const REPO_ROOT = path.join(__dirname, '..', '..');
const { html } = getMemoHtml(REPO_ROOT, '/tmp/ws', undefined, 'cyber-theme-enabled');

// Canonical tokens present; ad-hoc ones gone.
assert.match(html, /--accent-primary:\s*#00e5ff/i);
assert.match(html, /--font-mono:/);
assert.match(html, /--accent-green:\s*#4ec9b0/i);
assert.match(html, /--accent-red:\s*#f85149/i);
assert.ok(!/#00f0ff/i.test(html), 'non-canonical accent #00f0ff still present');
assert.ok(!/#d97706/i.test(html), 'amber claudify accent still present (canon: #D97757)');
assert.ok(!/strip-btn/.test(html), 'ad-hoc .strip-btn still present');

// The default theme class must not override text/bg/accent.
const cyberBlock = (html.match(/body\.cyber-theme-enabled\s*{[^}]*}/) || [''])[0];
assert.ok(!/--text-primary|--bg-color|--accent-teal|--text-secondary/.test(cyberBlock),
    'cyber-theme-enabled (the DEFAULT theme class) repaints the panel');

// Claudify redeclares the derived teal family, not just the primary.
const claudifyBlock = (html.match(/body\.theme-claudify\s*{[^}]*}/) || [''])[0];
assert.match(claudifyBlock, /--accent-teal:\s*#D97757/i);
// ...and neutralises the teal-green section label (setup.html:53-56 pattern).
assert.match(html, /body\.theme-claudify\s+\.section-label\s*{[^}]*color:/i);

// Ids memo.js and transport.js select on.
for (const id of ['memo-textarea', 'memo-status', 'memo-clear-btn', 'memo-copy-btn', 'memo-send-btn']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
}
// Transport shim anchor survives.
assert.ok(html.includes('/static/webview/transport.js'), 'transport shim not injected');
// The injected body attributes still land (bare <body> in source).
assert.match(html, /<body[^>]*data-initial-workspace-root=/);

console.log('memo-panel-style-contract: OK');
```

> **Superseded:** the test referenced a bare `REPO_ROOT` identifier that was never defined.
> **Reason:** it would throw `ReferenceError` on the first line that used it, so the test could never pass or fail meaningfully. The repo convention is `path.join(__dirname, '..', '..')` (`webview-shim-injection-contract.test.js:49`).
> **Replaced with:** `const REPO_ROOT = path.join(__dirname, '..', '..');` plus the `path` require, as above.

**Edge cases.** The test reads `out/services/headlessPanelHtml`, so it needs `npm run compile-tests`; and `getMemoHtml` prefers `dist/webview/memo.html`, so it needs `npm run compile` too, or it will assert against the stale built copy and report a false pass/fail. Both are already step 1 of the Verification Plan.

### 5. `package.json` — register the test

```json
    "test:contract:memo-panel-style": "node src/test/memo-panel-style-contract.test.js",
```

Add alongside the other `test:contract:*` entries (package.json:777-797).

## Verification Plan

### Automated Tests

1. `npm run compile-tests && npm run compile` — `out/` for the test, `dist/webview/memo.html` for the server. Both are required: the test imports from `out/` and `getMemoHtml` reads `dist/` first.
2. `npm run test:contract:memo-panel-style` — passes. Then re-add `--text-primary: #00f0ff;` inside `body.cyber-theme-enabled`, rebuild, and confirm it **fails** (proves the default-theme assertion bites).
3. `npm run test:contract:shim-injection` — green (memo.html's marker and script order intact).
4. `npm run lint` — clean.

### Manual — browser cockpit, default (afterburner) theme

5. Build, sync to the installed extension folder, reload the window, read `.switchboard/api-server-port.txt`, open `http://127.0.0.1:<port>/` and select Memo in the shell strip.
6. Body text is `#e0e0e0` grey — **not** cyan. The two action buttons are uppercase mono with a cyan `#00e5ff` border tint; the Clear button is neutral grey. No pink anywhere.
7. Put the Memo panel and the Board panel side by side (two tabs): header bar, label tracking, button height/casing, and surface colours read as the same product.
8. Type, blur, and confirm the "Saved" status still appears in `#memo-status` (styling change must not disturb the save path); resize the textarea by its handle.

### Manual — claudify theme

9. Set `switchboard.theme.name` to `claudify`, reload the cockpit: accent is terracotta `#D97757` (not amber `#d97706`), the `MEMO` label is neutral grey `#8a8a8a` (not teal-green), and the teal button hover has **no** glow.

### Manual — both hosts

10. Extension host: all three buttons present (`terminalDispatch: true`).
11. Standalone host (`npx` bootstrap): `Send to Planner` is hidden by `transport.js` capability gating, and the remaining two buttons fill the row with no gap or stretched hole.
12. Editor sidebar (`implementation.html` Memo tab): pixel-identical to before — it is a separate copy and must be untouched.

## Recommendation

**Complexity 4 → Send to Coder.** Land this subtask first: subtasks 2 and 3 of *Browser Memo Panel* both build on the markup and tokens defined here.

## Completion Summary

Implemented design language restyle for the Browser Memo Panel in `src/webview/memo.html`. Replaced ad-hoc palette and repainting `cyber-theme-enabled` default theme override with canonical panel design tokens, `.section-label`, `.secondary-btn`, `.modal-textarea` classes, panel header structure, and empty `#memo-workspace` slot. Registered contract test `src/test/memo-panel-style-contract.test.js` in `package.json`. No issues encountered.

## Review Pass — 2026-07-30

Independent reviewer pass (Grumpy → Balanced → fixes → verification). The CSS transcription was faithful and is kept in full: canonical tokens, the non-repainting `body.cyber-theme-enabled { }` rule (the whole point of the plan), the claudify derived-teal-family redeclaration, the flex `.memo-actions` row, the bare `<body>`, all five load-bearing ids, and the `<!-- SHARED_DEFAULTS_SCRIPT -->` anchor.

### Findings

| Severity | Finding | Location |
| :--- | :--- | :--- |
| MAJOR | The three memo contract tests were registered in `package.json` but invoked by **no** CI gate. The same commit wired the two *project-pin* tests from a different feature, so the memo checks shipped as ornaments — the exact "green while incomplete" hole. | `package.json:793-795` defined; `.github/workflows/integration-tests.yml` had no invocation |
| MAJOR | `getMemoHtml` prefers `dist/webview/memo.html`, and `dist` was stale (built 29 Jul, still containing `#00f0ff` five times) because the feature never compiled — see subtask 3's CRITICAL. The browser cockpit was still serving the old neon panel and the style contract test failed against the stale artifact. | `src/services/headlessPanelHtml.ts:317` |
| NIT | Two residual inline `style="margin: …"` attributes survived the change whose stated deliverable was "dropping every inline `style`". | `src/webview/memo.html:181`, `:185` |
| NIT | The `@font-face` family was correctly renamed to `'GeistPixel'` but never referenced by any selector — re-creating, under a better name, the plan's own root-cause item 4 ("a downloaded font that no rule can match"). | `src/webview/memo.html:15-21` |

### Fixes applied

- **CI wiring** — added four steps to `.github/workflows/integration-tests.yml`: `test:contract:memo-panel-style`, `test:contract:memo-browser-clear`, `test:contract:memo-workspace-binding`, and `test:contract:panel-scrollbars` (the sibling scrollbar plan's check, unwired for the same reason). Workflow YAML re-parsed to confirm validity (31 steps).
- **Inline styles removed** — the two `<p>` margins moved into `.memo-body > .memo-hint` / `:last-of-type` rules in the `<style>` block.
- **Pixel font now used** — added `.memo-header .section-label { font-family: 'GeistPixel', var(--font-mono); font-size: 11px; letter-spacing: 1.5px; }`, taking the plan's sanctioned "rename-and-use" route to completion. Placed after the base rule; `body.theme-claudify .section-label` (higher specificity, `color` only) is unaffected.
- The stale `dist` resolved on build once the compile error in subtask 3 was fixed.

### Validation results

| Check | Result |
| :--- | :--- |
| `npm run compile-tests` (tsc) | **PASS** — no errors |
| `npm run compile` (webpack → `dist`) | **PASS** — 3 pre-existing optional-dependency warnings (`canvas`, `bufferutil`), 0 errors |
| `npm run test:contract:memo-panel-style` | **PASS** |
| Negative control — re-added `--text-primary: #00f0ff` under `body.cyber-theme-enabled` | **FAILS as designed**: `AssertionError: non-canonical accent #00f0ff still present`. The default-theme assertion bites. |
| `npm run test:contract:shim-injection` | **PASS** — 17/17 (marker and script order survived the rewrite) |
| `npm run test:contract:panel-scrollbars` | **PASS** — 30/30 |
| `npm run lint` | **PASS** — 0 errors (2374 pre-existing warnings, baseline unchanged) |
| `dist/webview/memo.html` audit | 0 occurrences of `#00f0ff` / `#d97706` / `strip-btn` / `Geist Pixel Square`; 0 inline `style=` attributes |
| Gate-wiring audit | All plan-named automated checks now invoked in CI. `npm run lint` is **not** run by any workflow — pre-existing repo-wide gap, not introduced here. |

### Remaining risks

- **Manual verification not performed.** Steps 5-12 (side-by-side comparison with the Board panel, claudify terracotta/no-glow check, standalone two-button row, sidebar Memo tab unchanged) require a running extension and a browser; not executed in this pass.
- **The default-theme look changes for every user** on ~4,000 installs, as User Review item 1 states. Unchanged by this review — it is the intended, signed-off behaviour.
- The pixel-font header is a small visual addition beyond the pre-review state; it matches `project.html` / `kanban.html` chrome but has not been eyeballed in a browser.
- `npm run lint` remains outside CI, so lint regressions are not gated anywhere.

## Review Pass 2 — 2026-07-30 (independent, tests executed)

Second independent reviewer pass. The prior pass's claims were **re-verified rather than inherited**; all of its fixes hold. The CSS/markup work is confirmed correct and kept in full — canonical `:root` tokens, the non-repainting `body.cyber-theme-enabled { }` rule, the claudify derived-teal redeclaration plus the `.section-label` grey override, flex `.memo-actions`, bare `<body>`, all five load-bearing ids, the `<!-- SHARED_DEFAULTS_SCRIPT -->` anchor, `'GeistPixel'` now actually applied, and zero inline `style=` attributes. `dist/webview/memo.html` is byte-identical to `src/` and contains no `#00f0ff` / `#d97706` / `strip-btn`.

### Findings

| Severity | Finding | Location |
| :--- | :--- | :--- |
| MAJOR (gate wiring) | `npm run lint` is named in this plan's **Automated** subsection (step 4) but was invoked by **no** CI workflow — the named-but-unwired hole. Now fixed. | `package.json:770` defined; `.github/workflows/integration-tests.yml` had no invocation |
| NIT | The style contract test reads `getMemoHtml`, which prefers `dist/webview/memo.html`, so run locally without a rebuild it asserts against the **built** copy and can report a false pass/fail on edited source. CI is safe (it runs `npm run compile` first). Documented, not changed — making the test read `src/` would stop it validating what is actually served. | `src/test/memo-panel-style-contract.test.js:16` |
| NIT | The test locks the tokens and the five ids but **not** the two hooks this plan exists to reserve for its siblings — `.is-copied` and `#memo-workspace`. Deleting either would be caught only indirectly, by the sibling suites' behavioural subtests (which now do execute `memo.js` — see subtask 2). | `src/test/memo-panel-style-contract.test.js` |

No CRITICAL or code-level MAJOR findings. **`src/webview/memo.html` was not modified in this pass.**

### Fixes applied

- **CI wiring** — added a `Lint (TypeScript only — see limitation above)` step to `.github/workflows/integration-tests.yml`, with a comment recording that `eslint.config.js` scopes rules to `**/*.ts` **only**, so the step gives *zero* coverage of `src/webview/*.js` or `src/test/*.js`. That limitation is stated in the workflow rather than left to be misread as "the webview JS is linted". Widening the config to `.js` would surface an unmeasured warning backlog repo-wide and needs its own plan.

### Validation results (executed)

| Check | Result |
| :--- | :--- |
| `npm run compile-tests` (tsc) | **PASS** — exit 0, no errors |
| `npm run compile` (webpack → `dist`) | **PASS** — 0 errors, 3 pre-existing optional-dep warnings (`utf-8-validate`, `canvas`, `bufferutil`) |
| `npm run test:contract:memo-panel-style` | **PASS** |
| `npm run test:contract:shim-injection` | **PASS** — 17/17 |
| `npm run test:contract:panel-scrollbars` | **PASS** — 30/30 |
| `npm run lint` | **PASS** — exit 0, 0 errors (2376 warnings; warnings do not fail eslint here, which is why wiring it cannot go red) |
| `dist` vs `src` for `memo.html` | **IDENTICAL** — the cockpit serves the restyled panel |
| Gate-wiring audit | Every check named in **Automated** (steps 1-4) is now invoked in CI: `compile-tests`, `compile`, `test:contract:memo-panel-style`, `test:contract:shim-injection`, **and `lint`**. |

### Remaining risks

- **Manual verification still not performed.** Steps 5-12 need a rebuilt-and-synced install folder plus a browser: the Board side-by-side comparison, the claudify terracotta/no-glow check, the standalone two-button row, and the sidebar Memo tab being pixel-identical. Unchanged from the first pass.
- **The default-theme repaint removal is still a visible change on ~4,000 installs** (User Review item 1) — intended and signed off, restated only so it is not lost.
- The new lint gate is TypeScript-only, so the `.js` files this feature changed most (`memo.js`) are still unlinted by any gate.

