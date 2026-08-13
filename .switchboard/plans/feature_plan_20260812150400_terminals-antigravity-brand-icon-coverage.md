# Show the Antigravity Brand Icon Everywhere terminals.html Names an Agent

## Goal

An Antigravity agent must be visually identifiable by its brand icon in every place the Terminals panel names an agent — including the pane header and the new-terminal role picker, which today carry no brand icon at all for any agent.

### The problem

Antigravity has no brand icon in `terminals.html`. Other brands appear to.

### What was verified against the live server on 2026-08-12

The five links in the sidebar-row icon chain were checked end to end and all resolve for Antigravity. **None of these is the defect; do not "fix" them.**

1. The asset exists: `icons/brand-antigravity.svg` (378 bytes, `viewBox="0 0 16 15" fill="#4285F4"`, single valid `<path>`).
2. It is served: `GET /static/icons/brand-antigravity.svg` → `200`, `Content-Type: image/svg+xml`, byte-identical to the repo file.
3. The body attribute is emitted: `headlessPanelHtml.ts:411` writes `data-brand-icon-antigravity="/static/icons/brand-antigravity.svg"`, and it is present in the live-served `/terminals` HTML.
4. The label derives correctly: `TaskViewerProvider.CLI_BRAND_NAMES` (line 1104) maps `agy` → `Antigravity CLI`; `POST /kanban/verb/getStartupCommands` returns `"researcher": "Antigravity CLI"` for the live `researcher: "agy"` command.
5. The matcher resolves: `brandIconForCliLabel` (`terminals.js:1929`) tests `key.startsWith('antigravity')` **first** in its chain, and `brandIconUri` (line 1956) maps `antigravity: ds.brandIconAntigravity`. Both survive minification in the served bundle (`grep` on `/static/webview/terminals.js` finds `brandIconAntigravity` and `startsWith("antigravity")`).

### Root cause — one of the two named surfaces still renders text only

> **Superseded:** "`brandIconUri()` has exactly three call sites in `terminals.js` — line 1242 (shell rail), line 1720 (startup curtain), line 1970 (sidebar row) — and the two remaining surfaces that name an agent render text only: the pane header (`updatePaneElement`) and the new-terminal role picker (`buildRolePicker`)."
> **Reason:** Verified against `src/` at HEAD: `brandIconUri` now has **four** call sites — `postFleetStateToShell` (line 1273), `renderStartupCurtain` (line 1786), `renderTerminalRow` (line 2043) and **`updatePaneElement` (line 4518)**. The pane header was implemented after this plan was written: lines 4510-4537 build a `.pane-brand-icon` `<img>` from `brandIconForCliLabel(agentLabel) || 'default'`, dim it for exited terminals, deliberately omit the `data-terminal` stamp, and mark it `aria-hidden`; `terminals.html:1140-1176` carries the matching CSS including a reduced size for the terse `1x3`/`2x3`/`3x3` layouts. `src/` is the source of truth for this repo, so that half of the plan is **already done** and must not be re-implemented.
> **Replaced with:** One surface remains text-only — the **new-terminal role picker**. `buildRolePicker` (`terminals.js:6121`) renders each option as bare text, and the text is the *role* label, not the CLI:
> ```js
> const meta = BUILT_IN_AGENT_LABELS.find(r => r.key === role);
> const label = meta ? meta.label : role;
> btn.textContent = label;
> ```
> So the row that spawns an Antigravity agent reads `Researcher`, with no icon and no mention of Antigravity anywhere. This is the most likely surface behind the report: the operator picking an agent sees no brand at all.

### Secondary finding — a dead lookup table that will drift

`CLI_BRAND_ICON_KEYS` (`terminals.js:1907`), the documented "Binary name → icon key" map including `agy: 'antigravity'`, is **never referenced** — confirmed at HEAD, the only occurrence of the identifier is its own declaration. The only live resolver is the hand-written `startsWith` chain at lines 1933-1953, which duplicates the same eighteen mappings. Two copies of one table, one of them dead, is how the next brand gets added to the wrong one and silently renders as `default`.

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## User Review Required

None. The pane-header half of the original scope is already implemented in `src/` and is dropped from this plan rather than re-done; the remaining work is the role picker plus the dead-table collapse.

## Complexity Audit

### Routine

- Prepending an `<img>` to each role-picker option and appending the CLI name to its text.
- Collapsing the `startsWith` chain onto the existing `CLI_BRAND_ICON_KEYS` table.
- Two CSS rules in `terminals.html`.

### Complex / Risky

- **The role picker's label is a role, not a CLI.** Mapping role → CLI label requires `agentLabelForRole(role)` (line 6062), which reads the `agentNames` map fetched from `/kanban/verb/getStartupCommands`. That map can be empty (the fetch swallows failures deliberately — "labels are decoration — a failure must not blank the sidebar"). The picker must degrade to the current text-only rendering when it is, never to a broken-image glyph.
- **Roles with no CLI.** `hasCommand[role] === false` means a plain shell. Those must show **no** brand icon, not the `default` one — `agentLabelForRole` returns `''` for a role whose `agentNames` entry is missing or `No agent assigned`, and `brandIconForCliLabel('')` already returns `null`, so gate on the null.
- **`.role-option` is not a flex container.** `terminals.html:202` gives it `padding`, `border` and `text-transform: capitalize` but no `display`. An `<img>` plus a `<span>` inside a default inline-block button will baseline-align, not centre. It must become `display: inline-flex; align-items: center;`. `.role-option.is-no-role` sets `flex-basis: 100%`, which is a property of the *item* inside `.role-picker-options` (already `display: flex`) and is unaffected by changing the button's own inner display.
- **Collapsing the dead table is behaviour-preserving only if the chain and the table agree.** They must be diffed key-by-key before the chain is deleted. Verified at HEAD: both carry exactly `claude, agy, antigravity, devin, jules, gemini, codex→openai, openai, cursor, copilot, windsurf, qwen, amp, cline, kiro, kilo, trae, opencode, zed`, and both fall back to `'default'`. The one behavioural difference is `agy`: the table has it, the chain does not — a label literally starting with `agy` resolves to `default` today and to `antigravity` after the collapse. That is a strict improvement and the only intended change.
- **The font stack carries no symbol glyphs**, and `title=` is not a tooltip in this panel — do not substitute a text glyph or rely on `title` to convey the brand.
- **Do not touch the pane header.** `updatePaneElement` lines 4510-4537 already render `.pane-brand-icon`. `src/test/shell-terminal-strip.test.js:117-121` asserts the `brandIconForCliLabel(agentLabel) || 'default'` / `brandIconUri(iconKey) || brandIconUri('default')` idiom verbatim in the shell-rail relay; the collapse keeps `brandIconForCliLabel`'s signature and its `'default'` fallback, so those assertions stay green.

## Edge-Case & Dependency Audit

### Race Conditions

1. **`agentNames` populated after the picker opens.** `onNewTerminalClicked` awaits `fetchPtyVisibleRoles()` before committing `pickerState`, but `agentNames` is filled by a *separate* startup-commands fetch. A picker opened before that lands renders without icons and is not re-rendered until the next `renderSidebarList`. Accepted: the icon is decoration, and the text label is always correct. Do not add a re-render or a spinner for it.

### Security

- None. No new transport; the icon URIs are the same `data-brand-icon-*` attributes the host already stamps.

### Side Effects

2. **Custom agents.** `_getAgentNames` merges `getCustomAgents()` commands, and `deriveAgentDisplayName` falls back to `BASENAME.toUpperCase() + ' CLI'`. An unmatched label must resolve to `default`, never to an empty `src` (a broken-image glyph — the existing comment at line 1272 calls this out).
3. **`No agent assigned`.** `agentLabelForRole` maps it to `''` and `brandIconForCliLabel` returns `null` for both `''` and the literal sentinel. The picker must render no icon.
4. **The `No role` option (`NO_ROLE`).** It is built separately (line ~6185, `.role-option.is-no-role`) and never goes through the role loop, so it is unaffected — but confirm it still lays out correctly once `.role-option` is `inline-flex`, since it shares the base class.
5. **Antigravity via `antigravity` rather than `agy`.** Both keys map to `Antigravity CLI` in `CLI_BRAND_NAMES`; the matcher only sees the label, so both work.
6. **Editor vs browser host.** `headlessPanelHtml.ts:411` is the **only** producer of the `data-brand-icon-*` attributes. If the Terminals panel is ever hosted outside the browser cockpit, `document.body.dataset.brandIcon*` is undefined and `brandIconUri` returns `''`. The new call site must handle `''` by rendering no icon — the existing sites already do (`if (uri) {`).
7. **`brandIconUri('default')` fallback.** The rail, the curtain and the pane header fall back to `default`; the sidebar row does not (it renders nothing when the key is null). Keep the picker consistent with the **sidebar row** — a `default` CLI icon on a plain-shell option would claim an agent that is not there.
8. **The `is-starting` pulse.** The sidebar icon carries `data-terminal` and an `is-starting` class that `dismissStartupCurtain` strips by handle (selectors at lines 1713 and 1760). Do NOT add `data-terminal` to the picker icon — a second node matching the same selector would be stripped or missed inconsistently. (The pane header already documents this rule in its own comment.)
9. **`text-transform: capitalize` on `.role-option`.** With the text now `Researcher · Antigravity CLI`, capitalize leaves both halves unchanged. No reset needed.
10. **No confirm dialogs** (repo rule).

### Dependencies & Conflicts

- **`buildRolePicker` is shared with the sidebar-groups subtask.** "Stop the Terminals Sidebar Inventing Workspace Group Headers Nobody Asked For" adds a spawn-location selector to the same function. **This subtask must land first** — it rewrites the option rows; that one adds a control above them. Landing them in the other order forces a manual merge inside one loop body.
- Same file as the other three subtasks (`src/webview/terminals.js`); serialise the edit stream.

## Dependencies

- None inbound. Outbound: this subtask must precede the sidebar-groups subtask (shared `buildRolePicker`).

## Adversarial Synthesis

Key risks: re-implementing the pane-header icon that already exists in `src/` (wasted work and a duplicate node that would fight `dismissStartupCurtain`'s selector); collapsing the `startsWith` chain onto a table whose entries were never diffed against it; and rendering a `default` brand mark on a plain-shell option, which claims an agent that will not start. Mitigations: the pane header is explicitly out of scope and named as already-done; the two mappings were diffed key-by-key in this pass (identical apart from `agy`, which the table adds and the chain lacks); and the icon builder returns `null` — not `default` — whenever `agentLabelForRole` yields `''`.

## Proposed Changes

### `src/webview/terminals.js`

**a) Collapse the dead table into the live matcher** (replacing the chain at lines 1933-1953 and giving `CLI_BRAND_ICON_KEYS` at line 1907 a purpose):

```js
function brandIconForCliLabel(cliLabel) {
    if (!cliLabel || cliLabel === 'No agent assigned') { return null; }
    // ONE table, not a table plus a hand-written startsWith chain that duplicates
    // it. The chain was the only live resolver and CLI_BRAND_ICON_KEYS was dead —
    // two copies of the same eighteen mappings, so a new brand added to the wrong
    // one silently rendered as `default`. Longest key first so 'antigravity' cannot
    // be shadowed by a shorter prefix if one is ever added.
    const key = cliLabel.toLowerCase();
    const prefixes = Object.keys(CLI_BRAND_ICON_KEYS).sort((a, b) => b.length - a.length);
    for (const p of prefixes) {
        if (key.startsWith(p)) { return CLI_BRAND_ICON_KEYS[p]; }
    }
    return 'default';
}
```

**b) A small shared builder**, placed next to `brandIconUri`, so the picker cannot drift from the sidebar row:

```js
/** An <img> for a role's brand icon, or null when the role has no CLI. */
function brandIconImgForRole(role, className) {
    const label = agentLabelForRole(role);
    const iconKey = brandIconForCliLabel(label);
    if (!iconKey) { return null; }              // no CLI -> no icon (never `default`)
    const uri = brandIconUri(iconKey);
    if (!uri) { return null; }                  // host emitted no data-brand-icon-* attrs
    const icon = document.createElement('img');
    icon.className = className;
    icon.src = uri;
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');   // the button's own text names the agent
    icon.dataset.brand = iconKey;
    // Deliberately NO data-terminal stamp: dismissStartupCurtain strips .is-starting
    // by that handle and a second matching node would be cleared inconsistently.
    return icon;
}
```

**c) Role picker** (`buildRolePicker`, the role loop at ~line 6155) — icon plus the CLI name, so the Antigravity option actually says Antigravity:

```js
for (const role of roles) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'role-option';
    const meta = BUILT_IN_AGENT_LABELS.find(r => r.key === role);
    const label = meta ? meta.label : role;
    const cliLabel = agentLabelForRole(role);

    const icon = brandIconImgForRole(role, 'role-option-icon');
    if (icon) { btn.appendChild(icon); }
    const text = document.createElement('span');
    // The role name is what the board calls it; the CLI name is what will
    // actually run. Show both when they differ — "Researcher" alone never
    // mentioned Antigravity anywhere in this picker.
    text.textContent = cliLabel ? `${label} · ${cliLabel}` : label;
    btn.appendChild(text);

    btn.title = hasCommand[role]
        ? `Open ${label} terminal${cliLabel ? ` (${cliLabel})` : ''}`
        : `${label} — no agent CLI configured (plain shell)`;
    /* click handler unchanged */
    optionsEl.appendChild(btn);
}
```

`btn.textContent = label;` is replaced — not supplemented — so no stray text node survives beside the new span.

### `src/webview/terminals.html`

**d)** Make the option a flex row and add the icon rule, modelled on the existing `.item-role-icon` block (line 405). Amend `.role-option` (line 202) and add one new rule:

```css
.role-option {
    /* …existing declarations unchanged… */
    display: inline-flex;
    align-items: center;
}
.role-option-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    align-self: center;
    margin-right: 4px;
    opacity: 0.9;
    object-fit: contain;
    pointer-events: none;
}
```

The pane header needs no CSS — `.pane-brand-icon` (lines 1149-1176), including its terse-layout size override, already ships.

## Verification Plan

### Automated Tests

Execution is **deferred by session directive (SKIP TESTS)**. No new test files are required. One existing contract test reads a span this change affects and must stay green when the suite is next run:

- `src/test/shell-terminal-strip.test.js:117-121` — asserts the shell-rail relay uses `brandIconForCliLabel(agentLabel) || 'default'` and `brandIconUri(iconKey) || brandIconUri('default')`. The collapse keeps `brandIconForCliLabel`'s signature, its `null` returns for empty / `No agent assigned`, and its `'default'` tail, so the idiom is untouched.

### Static checks

1. `grep -n "CLI_BRAND_ICON_KEYS" src/webview/terminals.js` shows the declaration **and** the new use in `brandIconForCliLabel` — the table is no longer dead.
2. `grep -n "key.startsWith(" src/webview/terminals.js` no longer returns the eighteen-line brand chain.
3. Key-by-key diff: every key in `CLI_BRAND_ICON_KEYS` maps to the value the deleted chain returned for a label with that prefix. The only intended difference is `agy` → `antigravity` (previously `default`).
4. `grep -n "data-terminal" src/webview/terminals.js` shows no new stamp inside `brandIconImgForRole`.
5. `grep -n "pane-brand-icon" src/webview/terminals.js src/webview/terminals.html` shows the pre-existing pane-header implementation unchanged by this plan.

### Manual UAT

*(The browser panel is served from the installed VSIX's `dist/`, not `src/` — rebuild and reinstall the VSIX before concluding an icon did not appear. If the pane-header icon is missing in the running panel but present in `src/`, the installed VSIX is stale; rebuild rather than re-implementing it.)*

6. With a `researcher` (`agy`) terminal open, the sidebar row shows the Antigravity icon — the untouched regression guard.
7. The pane header shows it too, in both a `1` layout and a `3x3` layout, without truncating the title. (Pre-existing behaviour; confirm it is not disturbed.)
8. Click `+` on the group tab strip to open the role picker: the Researcher option shows the Antigravity icon and reads `Researcher · Antigravity CLI`.
9. The `No role` option shows no icon and still occupies its own full-width dashed row.
10. A role with no configured command shows the role name alone, no icon, and its `— no agent CLI configured (plain shell)` title.
11. Confirm at least three other brands (Claude, Devin, Gemini) render in the picker, so the change is not Antigravity-specific plumbing.
12. Options with icons are vertically centred, not baseline-dropped, and the picker still wraps to multiple rows at a narrow sidebar width.

---

**Recommendation:** Complexity 2 — **Send to Intern.**
