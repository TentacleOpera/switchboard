# Markdown edit mode writes on pure black — give the editor a dark-grey surface

## Goal

Change the shared markdown editor's editing surface from pure black (`#000000`) to a dark grey that matches the panels' existing document-surface token, so long editing sessions in the Planning, Design, Project and Tickets panels are readable instead of a maximum-contrast text-on-void.

> **Superseded:** "…a dark grey that matches the panels' **existing document-surface token**" — i.e. key the editor's surface off `--doc-bg`.
> **Reason:** `--doc-bg` is declared in all four panels but has **zero consumers anywhere in the repo** (`grep -rn "doc-bg" src/` returns only the four `:root` declarations; its siblings `--doc-text` / `--doc-border` / `--doc-heading` / `--doc-text-bright` are all consumed, `--doc-bg` alone is not). The 2026-07-15 preview-unification plan declared it and then deliberately shipped `background: transparent` on every preview scroll pane so the single body grid shows through — so there is no "grey reading surface" for the editor to adopt, and the value has already drifted once in draft (`#101414` in that plan's line 114 vs `#1a1a1a` as shipped). Keying the editor off a dead, drift-prone token means the first person who wires doc previews to `--doc-bg` and retunes it silently re-creates the exact bug this plan fixes.
> **Replaced with:** the shared editor **owns its own surface**: `background: var(--md-editor-bg, #1a1a1a)`. `#1a1a1a` is still the same grey `--doc-bg` names — the value is unchanged, only the carrier is. `--md-editor-bg` stays undefined and exists purely as a per-panel override seam.

The user-visible objective is unchanged: the edit surface must be dark grey (`#1a1a1a`), not `#000000`, in both halves of the editor, in every panel that mounts it, in both hosts, in every theme.

### Problem

Every panel that mounts the shared markdown editor puts the operator on a `#000000` background while typing. Pure black under white-ish body text is the highest-contrast combination the palette can produce, and it is markedly harder to sustain than the same text on a dark grey.

### Root cause (confirmed against the code)

The editor's injected stylesheet paints the shell with the panel's global background token and makes the textarea transparent, so the textarea shows whatever the shell is showing:

- `src/webview/markdownEditor.js:11` — `.md-editor-shell { background: var(--panel-bg, #000000); }`
- `src/webview/markdownEditor.js:91` — `.md-body > textarea.markdown-editor { background: transparent; }`

and every host panel defines `--panel-bg` as literal pure black:

- `src/webview/planning.html:61`, `src/webview/design.html:61`, `src/webview/project.html:40`, `src/webview/tickets.html:96` — all `--panel-bg: #000000;`

So the shell resolves to `#000000` and the transparent textarea inherits it. The live-preview half is only marginally better: `.md-live-preview` uses `var(--panel-bg2, #0a0a0a)` (`markdownEditor.js:108`), which is `#0a0a0a` in every panel — still effectively black.

**The transparency is real, and is what makes this a one-file fix.** Each host panel also ships its own `.markdown-editor` rule that paints a background — `planning.html:2536` / `design.html:2424` `background: var(--panel-bg)`, `project.html:239` a hardcoded `background: #000`, `tickets.html:2554` `background: var(--panel-bg)` — but the injected `.md-body > textarea.markdown-editor` selector scores `(0,2,1)` against their `(0,1,0)`, and none of them use `!important` on `background` (the only `!important` on these elements is `display`). The cyber-theme rules (`.cyber-theme-enabled .markdown-editor { background: transparent; }`, four panels) score `(0,2,0)` and also lose — and set the same value anyway. `.md-body` itself declares no background. So once `attach()` wraps a textarea, the **shell** is the only thing painting the editing surface, in every panel and every theme. Retinting the shell therefore changes what the operator actually sees; it is not a change that only appears to work.

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, ux
- **Project:** Browser Switchboard

## User Review Required

None. The target value (`#1a1a1a`) and the scope (editor surface only, never `--panel-bg`) are both fixed by the report.

## Complexity Audit

### Routine
- The change is CSS-only, in one self-contained injected stylesheet (`markdownEditor.js` guards on `#md-editor-styles` and injects once).
- Both hosts and both themes follow automatically with no extra work: the VS Code webview and the browser cockpit load the **same** `markdownEditor.js` (`PlanningPanelProvider.ts:753`/`1731`, `DesignPanelProvider.ts:958`, `TicketsPanelProvider.ts:811` vs `headlessPanelHtml.ts:251`/`287`/`324`/`433`), and neither `body.theme-claudify` nor `.cyber-theme-enabled` overrides the editor's own surface.
- Nothing persisted changes, so the migration rule (~4,000 installs) does not engage at all.

### Complex / Risky
- **Do not change `--panel-bg`.** It is the whole-panel background for every surface in four panels (and six more: `kanban.html`, `terminals.html`, `memo.html`, `setup.html`, `connections.html`, `implementation.html`). Retinting it to grey would restyle the entire application. The fix must be scoped to the editor's own selectors.
- **The textarea is `background: transparent` for a reason** — it lets the shell own the surface so the toolbar and body read as one panel. Keep it transparent and retint the shell, rather than painting the textarea directly, or the toolbar strip and the text area will diverge.
- **Two halves, one surface.** `.md-body > textarea.markdown-editor` (edit) and `.md-live-preview` (preview) sit side by side. Retinting only the edit half creates a visible seam down the middle in split view — and split *is* the default (`markdownEditor.js:205` `let globalViewMode = 'split'`), so a half-fix ships the seam to every user on first open. Both must move together.
- **The chrome/content relationship inverts.** `.md-toolbar`, `.md-view-toggle` and `.md-table-popover` stay on `--panel-bg2` (`#0a0a0a`). Today that is *lighter* than the `#000000` body; after this change it is *darker* than the `#1a1a1a` body. This is a deliberate, accepted consequence — darker chrome above lighter content is the conventional editor arrangement (VS Code's own tab bar sits darker than its editor) and reads as chrome/content separation. Retuning the toolbar is a separate visual decision and is explicitly out of scope.

## Edge-Case & Dependency Audit

**Race Conditions**
- None. The stylesheet is injected once, synchronously, at script evaluation, behind an `#md-editor-styles` id guard (`markdownEditor.js:3`). There is no async path, no fetch, no timing dependency. `attach()` is idempotent via `textarea.dataset.mdEditorAttached` and re-entry only fires a refresh event.

**Security**
- None. No new network origin, no CSP surface, no user-controlled value reaching CSS. The changed declarations are static literals in a static asset already served under each panel's existing CSP (`style-src 'unsafe-inline' 'self'` — the injected `<style>` element is same-origin script-created, not an inline attribute, and is already how this stylesheet ships today).

**Side Effects**
- **Mount points — five attach sites across four panel scripts**, all inside panels that already serve `markdownEditor.js`:
  - `planning.js:6282` — docs / design / kanban tabs, textarea id resolved as `markdown-editor` / `markdown-editor-design` / `kanban-editor`
  - `planning.js:7629` — the ticket-edit description (`#ticket-edit-description`, built at `planning.js:7605`)
  - `design.js:1881` — `#markdown-editor-design`
  - `project.js:3107` — generic `${tab}-editor`, which covers **six** textareas: `kanban-editor`, `projects-editor`, `features-editor`, `constitution-editor`, `system-editor`, `tuning-editor` (`project.html:1316`–`1511`)
  - `tickets.js:3019` — `#ticket-edit-description` (built at `tickets.js:2995`)

  > **Superseded:** "the editor is attached from `planning.js` and from the tickets edit path (`tickets.js:3019`)… The Design and Project panels serve the script too."
  > **Reason:** Understates the blast radius by more than half. Design and Project do not merely *serve* the script — they attach it (`design.js:1881`, `project.js:3107`), and `project.js` resolves its textarea generically as `${tab}-editor`, so a single call site covers six distinct editors. Eleven textareas across five call sites, not two.
  > **Replaced with:** the enumeration above. Every one of them is wrapped by the same `attach()` and therefore inherits the shell's surface — which is why one stylesheet edit is sufficient, and why the manual verification must sample more than the Planning docs tab.
- **Every mount lands on the intended value regardless of panel tokens.** With `--md-editor-bg` undefined everywhere, the operative value is the literal `#1a1a1a` in the shared asset itself — there is no panel-side prerequisite and therefore no way for a panel to miss the fix.
- **Contrast:**
  > **Superseded:** "`#e0e0e0` on `#1a1a1a` is ~12.6:1… `--text-secondary: #8C8C8C` on `#1a1a1a` is ~5.7:1."
  > **Reason:** Wrong token. The editor text is `color: var(--text-color, #c9d1d9)` (`markdownEditor.js:92`, and `:113` for the preview half), and **`--text-color` is not defined in any of the four host panels** (they define `--text-primary` / `--text-secondary`, never `--text-color`). The rendered editing text is therefore the literal fallback `#c9d1d9`, not `--text-primary`'s `#e0e0e0`.
  > **Replaced with:** `#c9d1d9` on `#1a1a1a` = **~11.3:1**, comfortably above WCAG AAA (7:1) for body text. Toolbar buttons (`--text-muted`, also undefined → `#8b949e`) on the unchanged `#0a0a0a` toolbar are untouched by this change. No token needs re-tuning; the change strictly *reduces* eye strain without dropping any pair below AA.
- **`.md-toggle-btn.active` uses `color: #000`** on an accent-teal fill (`markdownEditor.js:74-78`) — unaffected, it sits on the accent, not on the surface.
- **Nothing persisted changes.** Presentation-only CSS in an injected stylesheet; no state, settings, or on-disk format is touched, so the released-version migration rule does not apply.

**Dependencies & Conflicts**
- `src/webview/markdownEditor.js` is the only source file changed, plus one assertion appended to `src/test/webview-panel-runtime-surface.test.js`.
- No panel HTML is edited. This keeps the change clear of `verbSchemas.ts` and the provider files, so it cannot collide with any in-flight Browser Switchboard provider-burndown stream (PRD "one agent stream per provider file").
- PRD contracts touched: **#1 anti-divergence** — satisfied by construction, both hosts load the identical asset and no UI is forked. Contracts #4/#5/#6/#7 (verb return, schemas, capability gating, two-layer completion) are not engaged: this change adds no verb, route, or capability.

## Dependencies

- None — this change touches one shared webview asset and one contract test, and depends on no other in-flight plan or session.

## Adversarial Synthesis

Key risks: (1) fixing only the edit half and shipping a visible seam down the middle of split view, which is the *default* view mode, so every user sees it immediately; (2) keying the surface off `--doc-bg`, a token with zero consumers whose value has already drifted once in draft, which would let a future preview-styling change silently restore the pure-black editor; (3) "fixing" this by retinting `--panel-bg`, which would restyle ten panels. Mitigations: paint both `.md-editor-shell` and `.md-live-preview` from one self-owned token expression, `var(--md-editor-bg, #1a1a1a)`; leave `--panel-bg`, `--panel-bg2` and the textarea's `transparent` untouched; and lock all three with a structural contract assertion that fails if either rule ever references a `--panel-bg*` token or if the two backgrounds stop being byte-identical.

## Proposed Changes

### `src/webview/markdownEditor.js` — editor surface tokens (injected stylesheet, lines 6–200)

**Context.** The whole stylesheet is one template literal assigned to `style.textContent` inside the `#md-editor-styles` id guard (lines 3–201). All three edits are inside that literal. No JavaScript changes.

**Logic.** The editing surface is a property of the *editor component*, not of the host panel. Today it is derived from the host panel's global background (`--panel-bg`, `#000000` in all ten panels) and from the panel's secondary chrome colour (`--panel-bg2`, `#0a0a0a`) — two tokens that exist to describe the *application*, not a document being edited. Move both halves of the editor onto one expression the component owns, with a per-panel override seam that no panel currently uses.

> **Superseded:** `background: var(--md-editor-bg, var(--doc-bg, #1a1a1a));`
> **Reason:** With `--md-editor-bg` undefined everywhere, the operative value in that chain is `--doc-bg` — a token with no consumers in the repo, which the 2026-07-15 unification declared and then never wired up (preview panes ship `background: transparent`). It is therefore both unprotected by any test and semantically about a *preview* surface. Whoever finally wires previews to it and retunes it (the same plan's draft used `#101414`) would silently drag the editor back toward black — reintroducing this exact bug with no failing test.
> **Replaced with:** `background: var(--md-editor-bg, #1a1a1a);` — the component owns its surface via a literal, exactly as it already owns `#30363d`, `#0a0a0a`, `#c9d1d9` and `#00f0ff` as fallbacks elsewhere in the same stylesheet. `--md-editor-bg` remains undefined and is the override seam for a future panel that wants a different editing surface.

**Implementation.**

`.md-editor-shell` (line 7) — replace the `background` declaration:

```css
            .md-editor-shell {
                display: none;
                flex-direction: column;
                border: 1px solid var(--border-color, #30363d);
                /* Editing surface, NOT the panel surface. This deliberately does not
                   read --panel-bg: that token is #000000 in every host panel
                   (planning/design/project/tickets), which put the operator on pure
                   black for an entire editing session. The editor owns its own dark
                   grey; --md-editor-bg is the per-panel override seam and is
                   intentionally undefined everywhere today. */
                background: var(--md-editor-bg, #1a1a1a);
                border-radius: 6px;
                overflow: hidden;
                width: 100%;
                min-height: 480px;
                box-sizing: border-box;
            }
```

`.md-body > textarea.markdown-editor` (line 87) — no declaration changes; add the comment so a future pass does not "fix" the transparency by painting it:

```css
            .md-body > textarea.markdown-editor {
                flex: 1;
                border: none !important;
                resize: none;
                /* Transparent on purpose — the shell owns the surface so the toolbar
                   and the text area read as one panel. Do not paint this directly.
                   This selector is (0,2,1) and beats every host panel's own
                   .markdown-editor rule, which is how the shell wins. */
                background: transparent;
                color: var(--text-color, #c9d1d9);
                font-family: var(--font-code);
                font-size: 13px;
                padding: 12px;
                box-sizing: border-box;
                outline: none;
                height: auto;
                margin: 0 !important;
                display: block !important; /* override outer display:none */
            }
```

`.md-live-preview` (line 102) — move it off `--panel-bg2` so split view has no seam. The value must stay **byte-identical** to the shell's:

```css
            .md-live-preview {
                flex: 1;
                border-left: 1px solid var(--border-color, #30363d);
                padding: 12px;
                overflow-y: auto;
                box-sizing: border-box;
                /* Must stay byte-identical to .md-editor-shell — --panel-bg2
                   (#0a0a0a) left a visible seam down the middle of split view,
                   which is the default view mode. */
                background: var(--md-editor-bg, #1a1a1a);
                height: 100%;
            }
```

**Edge cases.**
- Leave `.md-toolbar` (line 27), `.md-view-toggle` (line 59) and `.md-table-popover` (line 137) on `--panel-bg2`. They become the darker chrome band above/over the lighter content — accepted, see Complexity Audit.
- Leave the `@media (max-width: 640px)` stacked layout (lines 169–177) alone; it only swaps `border-left` for `border-top`, and both halves now share a surface so the stacked seam disappears for free.
- Do not touch the `.md-editor-shell.view-edit` / `.view-preview` / `.view-split` blocks (lines 179–199) — they control `display` only.
- Keep the comments free of `{`, `}` and line-leading `background:` so the block-extraction assertion below stays simple.

### No panel HTML changes required

All four hosting panels (`planning.html`, `design.html`, `project.html`, `tickets.html`) are untouched. The operative value lives in the shared asset, so both hosts and all six `project.html` editors pick it up with zero panel-side prerequisites.

## Verification Plan

> Session directive: compilation and automated-test execution were **not** run during this planning pass. The steps below are for the implementer.

### Automated Tests

1. Append one assertion to `src/test/webview-panel-runtime-surface.test.js` (plain `node` source-reading test, `check(name, fn)` harness — no runtime, no VS Code). It must be **structural**, not a string-equality match on the exact declaration:

```js
check('markdown editor paints its own surface, and both halves share it', () => {
    const src = fs.readFileSync(path.join(WEBVIEW, 'markdownEditor.js'), 'utf8');
    const ruleBody = (selector) => {
        const i = src.indexOf(`${selector} {`);
        assert.ok(i !== -1, `${selector} rule not found in markdownEditor.js`);
        const open = src.indexOf('{', i);
        const close = src.indexOf('}', open);
        return src.slice(open + 1, close);
    };
    const backgroundOf = (selector) => {
        const m = ruleBody(selector).match(/(?:^|\n)\s*background:\s*([^;]+);/);
        assert.ok(m, `${selector} declares no background`);
        return m[1].trim();
    };
    const shell = backgroundOf('.md-editor-shell');
    const preview = backgroundOf('.md-live-preview');
    for (const [name, value] of [['.md-editor-shell', shell], ['.md-live-preview', preview]]) {
        assert.ok(!/--panel-bg\b/.test(value) && !/--panel-bg2\b/.test(value),
            `${name} must not key its surface off the panel background tokens ` +
            `(--panel-bg is #000000 and --panel-bg2 is #0a0a0a in every host panel) — got: ${value}`);
    }
    assert.strictEqual(shell, preview,
        `the edit half and the preview half must paint the same surface or split view ` +
        `(the default mode) shows a seam — shell=${shell} preview=${preview}`);
});
```

   > **Superseded:** "assert `markdownEditor.js` must not contain `var(--panel-bg,` in the `.md-editor-shell` rule, and must contain `var(--md-editor-bg, var(--doc-bg, #1a1a1a))`."
   > **Reason:** An exact-substring match on a full declaration is brittle to whitespace and to any legitimate future retune of the grey, so it would be deleted the first time it cried wolf — and it pins the *literal* rather than the *invariant*. It also asserts nothing about the preview half, i.e. it would pass while shipping the split-view seam.
   > **Replaced with:** the structural assertion above. It fails on the two things that are actually regressions — a `--panel-bg*` token creeping back into either rule, and the two halves diverging — while staying green through any deliberate retune of the grey.

   `.md-editor-shell {` and `.md-live-preview {` each match their base rule first via `indexOf`; the later `.md-editor-shell.view-*` and `.md-live-preview.markdown-body` selectors do not collide with those exact search strings.

2. Run `npm run test:contract:panel-runtime-surface` (`src/test/webview-panel-runtime-surface.test.js`) and `npm run test:contract:panel-scrollbars` (`src/test/browser-panel-scrollbar-contract.test.js`) — both read the panel webview assets and must stay green.

### Manual (VSIX install)

3. **Planning panel** — open a plan, enter markdown edit mode. The text area must be dark grey (`#1a1a1a`), not black. It opens in split view by default: the preview half must be the *same* grey, with no seam at the divider. Cycle Edit / Preview / Split via the toolbar toggle and confirm the surface is identical in all three.
4. **Planning panel, ticket edit** — open a ticket in Planning and click Edit; `#ticket-edit-description` must show the same grey (this is the second, easily-missed attach site at `planning.js:7629`).
5. **Project panel** — check **more than one** tab; `project.js` attaches generically, so verify at least `constitution-editor` and `projects-editor` in addition to `kanban-editor`. `project.html` is the panel with the hardcoded `background: #000` on `.markdown-editor`, so it is the strongest test that the shell really wins on specificity.
6. **Design panel** — `#markdown-editor-design`, same expectation.
7. **Tickets panel** — click Edit on a ticket; `#ticket-edit-description`, same expectation.
8. **Themes** — switch to claudify and confirm the surface stays `#1a1a1a`; enable the cyber theme and confirm the same (`.cyber-theme-enabled .markdown-editor { background: transparent; }` must not reintroduce black — it sets transparent, and the shell behind it is now grey).
9. **Browser cockpit** — open Planning, Design, Project and Tickets against the standalone server (port in `.switchboard/api-server-port.txt`) and confirm the grey surface renders there too; the stylesheet is injected by the same shared script (`/static/webview/markdownEditor.js`).
10. Sample the rendered colour with dev-tools in both hosts:
    `getComputedStyle(document.querySelector('.md-editor-shell')).backgroundColor` → expect `rgb(26, 26, 26)`, not `rgb(0, 0, 0)`;
    `getComputedStyle(document.querySelector('.md-body > textarea.markdown-editor')).backgroundColor` → expect `rgba(0, 0, 0, 0)` (still transparent — if this is opaque, a panel rule has won and the shell fix is cosmetically hidden).

---

**Recommendation: Send to Intern** (Complexity 2).
