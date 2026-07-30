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

## Complexity Audit (Routine vs Complex/Risky)

**Routine-plus.** One 97-line HTML file, rewritten in place: replace the token block, add the canonical control/label classes, restructure the body markup, drop the inline styles. No host code, no verbs, no persistence, no CSP change (all styling stays inline in the existing `<style>`, permitted by the panel's `style-src 'unsafe-inline' 'self'` at headlessPanelHtml.ts:326).

What makes it more than trivial:

- **The `cyber-theme-enabled` semantics change is behavioural, not cosmetic.** Inverting that block from "neon repaint" to "afterburner = base palette" changes what the default-theme panel looks like for every user. It is the correct alignment (it matches four other panels), but it must be stated as an intentional change rather than slipped in.
- **`memo.html` is browser-only.** `grep -rn "memo.html" src` returns three hits: the two `getMemoHtml` candidate paths and the `/memo` route (LocalApiServer.ts:3395). The sidebar's memo UI is a *separate* copy inside `implementation.html` (its own markup at 1591-1607 and its own JS at 2688-2721). So this change cannot regress the editor sidebar — and equally, it does not fix it. Copy classes **from** `implementation.html`; do not import or refactor it.
- **Two theme entry points must agree.** First paint comes from `applyThemeClass` (server-side, headlessPanelHtml.ts:82-88); later switches come from `memo.js`'s `handleThemeChanged` (memo.js:5-12), which maps `'cyber' || 'afterburner'` → `cyber-theme-enabled`. That mapping is already consistent with `getThemeBodyClass`; the defect is what the class *means* in this file's CSS. Leave the JS mapping alone.

## Edge-Case & Dependency Audit

- **Element ids are load-bearing — keep all five.** `memo.js` selects `#memo-textarea`, `#memo-status`, `#memo-clear-btn`, `#memo-copy-btn`, `#memo-send-btn` (memo.js:27, 38, 59, 69, 81, 90), and `transport.js:343` hides `#memo-send-btn` by id when `caps.terminalDispatch === false`. Renaming or wrapping any of them breaks the panel silently.
- **Send to Planner is hidden in the standalone host.** `baseStandaloneCapabilities.terminalDispatch = false` (bootstrap.ts:384-391) vs `true` in the extension host (TaskViewerProvider.ts:1822-1829). The button row must look right with **two** buttons as well as three: a `display: flex; gap:` row handles this correctly (a `display: none` child consumes no gap), but a CSS grid with three fixed columns would leave a hole. Use flex.
- **Standalone passes no theme class at all.** `sharedGetPanelHtmlById(id, repoRoot, workspaceRoot, await getStandaloneCaps())` (bootstrap.ts:422) omits the `themeClass` argument, so `<body>` carries no theme class there and the `:root` block alone renders the panel. After this change that is the correct afterburner look — which is precisely why the base palette must be canonical afterburner rather than a neon variant.
- **Claudify must kill the glow.** Per the established pattern, the claudify block redeclares the whole accent family plus glow removal — a CSS variable resolves where it is *declared*, so overriding only `--accent-primary` leaves derived teal tokens cyan (the comment at project.html:63-65 records this).
- **`color-mix()` usage.** The canonical `.secondary-btn.is-teal` rules use `color-mix(in srgb, …)`. Supported in the Chromium the cockpit and the VS Code webview both run on; no fallback needed, consistent with the rest of the repo.
- **The textarea keeps `resize: vertical` and a min-height.** The panel is the memo capture surface; removing user resize to tidy the layout would be a functional regression.
- **Cache/serving dependency.** `getMemoHtml` prefers `dist/webview/memo.html` over `src/` (headlessPanelHtml.ts:316-319) and the installed extension serves from its own install folder. Rebuild + sync + reload before judging; panel HTML is served `no-store` but a stale `dist` looks identical to "the change did nothing".
- **Do not add an entry counter.** Entry parsing lives host-side (`_parseMemoEntries`); a client-side count would be a second, divergent implementation of the split rule. The status line already reports the count after a copy/send.

## Proposed Changes

### 1. `src/webview/memo.html` — replace the token block (lines 22-42)

Adopt the canonical panel tokens (values taken from `setup.html:15-48`, the closest sibling panel), and make `cyber-theme-enabled` a non-repainting class:

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

Also fix the pixel-font family name in the `@font-face` at lines 15-21 to `'GeistPixel'` (matching `project.html:14` and `kanban.html:17`) so it can be referenced by the header rule below — or delete the `@font-face` outright if the header stays on Hanken Grotesk. Do not leave a downloaded font that no selector can match.

### 2. `src/webview/memo.html` — replace `.strip-btn` (lines 54-70) with the canonical control classes

Copied verbatim from `implementation.html:812-830` and `:856-866`, plus the label and textarea classes:

```css
        .section-label {
            font-family: var(--font-mono);
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 2px;
            color: var(--text-secondary);
            font-weight: 600;
        }

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

### 3. `src/webview/memo.html` — restructure the body markup (lines 74-92), dropping every inline `style`

Ids and button order preserved exactly:

```html
<body>
    <div class="memo-header">
        <span class="section-label">Memo</span>
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

The `<!-- SHARED_DEFAULTS_SCRIPT -->` marker and the `{{NONCE}}` / `{{MEMO_JS_URI}}` placeholders must survive untouched — `injectTransportShim` keys the transport injection off that comment (headlessPanelHtml.ts:331), and its deletion is silent at build and serve time (see the regression documented in `webview-shim-injection-contract.test.js`).

Delete the now-unused `.markdown-editor` rule (memo.html:68-70) and the `class="markdown-editor"` on the textarea — it only existed to set a font that `.modal-textarea` now sets.

### 4. `src/test/memo-panel-style-contract.test.js` — new contract test

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
const { getMemoHtml } = require('../../out/services/headlessPanelHtml');

const { html } = getMemoHtml(REPO_ROOT, '/tmp/ws', undefined, 'cyber-theme-enabled');

// Canonical tokens present; ad-hoc ones gone.
assert.match(html, /--accent-primary:\s*#00e5ff/i);
assert.match(html, /--font-mono:/);
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

// Ids memo.js and transport.js select on.
for (const id of ['memo-textarea', 'memo-status', 'memo-clear-btn', 'memo-copy-btn', 'memo-send-btn']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
}
// Transport shim anchor survives.
assert.ok(html.includes('/static/webview/transport.js'), 'transport shim not injected');
```

### 5. `package.json` — register the test

```json
    "test:contract:memo-panel-style": "node src/test/memo-panel-style-contract.test.js",
```

## Verification Plan

**Automated**

1. `npm run compile-tests && npm run compile` — `out/` for the test, `dist/webview/memo.html` for the server.
2. `npm run test:contract:memo-panel-style` — passes. Then re-add `--text-primary: #00f0ff;` inside `body.cyber-theme-enabled`, rebuild, and confirm it **fails** (proves the default-theme assertion bites).
3. `npm run test:contract:shim-injection` — green (memo.html's marker and script order intact).
4. `npm run lint` — clean.

**Manual — browser cockpit, default (afterburner) theme**

5. Build, sync to the installed extension folder, reload the window, read `.switchboard/api-server-port.txt`, open `http://127.0.0.1:<port>/` and select Memo in the shell strip.
6. Body text is `#e0e0e0` grey — **not** cyan. The two action buttons are uppercase mono with a cyan `#00e5ff` border tint; the Clear button is neutral grey. No pink anywhere.
7. Put the Memo panel and the Board panel side by side (two tabs): header bar, label tracking, button height/casing, and surface colours read as the same product.
8. Type, blur, and confirm the "Saved" status still appears in `#memo-status` (styling change must not disturb the save path); resize the textarea by its handle.

**Manual — claudify theme**

9. Set `switchboard.theme.name` to `claudify`, reload the cockpit: accent is terracotta `#D97757` (not amber `#d97706`), and the teal button hover has **no** glow.

**Manual — both hosts**

10. Extension host: all three buttons present (`terminalDispatch: true`).
11. Standalone host (`npx` bootstrap): `Send to Planner` is hidden by `transport.js` capability gating, and the remaining two buttons fill the row with no gap or stretched hole.
12. Editor sidebar (`implementation.html` Memo tab): pixel-identical to before — it is a separate copy and must be untouched.
