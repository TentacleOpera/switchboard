# Claudify "Colour Kanban Board Icons" Not Applied Live When Switching to Claudify

## Goal

When the user switches the Switchboard theme to **Claudify**, the kanban board icons should immediately render in colour (terracotta) — matching the "Colour kanban board icons" checkbox, which correctly shows **ON** by default for Claudify. Today the checkbox reads ON but the icons stay grey until the kanban webview is reloaded. Make the default-ON behaviour apply to **both** the checkbox *and* the actual rendered setting the moment Claudify is selected, with no reload needed.

### Problem analysis

The colour treatment is driven by the body class `kanban-icons-colour`. The CSS (`src/webview/kanban.html:101-142`) only recolours icons when the body has **both** `theme-claudify` **and** `kanban-icons-colour`:

```css
body.theme-claudify.kanban-icons-colour .strip-icon-btn img, /* …etc… */ { filter: /* terracotta */ }
```

The effective default is already correct: `getEffectiveColourKanbanIcons()` (`src/services/themeBodyClass.ts:30-41`) returns **`true`** for Claudify when the setting is unset (explicit workspace value wins, else explicit global, else `theme === 'claudify'`). On **first paint**, `getThemeBodyClass()` (`themeBodyClass.ts:43-63`) folds that into the injected body class (`' kanban-icons-colour'` at line 55-56), so a freshly-loaded Claudify board is coloured. The Theme-tab checkbox reads the same function via `handleGetColourKanbanIconsSetting()` (`TaskViewerProvider.ts:4692-4694`), so the checkbox also shows ON. Both agree — **on load**.

### Root cause

The failure is on a **live theme switch** (afterburner → claudify without a reload). Two separate class mutations are needed but only one happens:

1. The kanban webview's `switchboardThemeChanged` handler (`src/webview/kanban.html:6594-6621`) adds `theme-claudify` and removes `cyber-theme-enabled`. It **deliberately leaves `kanban-icons-colour` untouched** (comment at `kanban.html:6597-6599`: "without touching unrelated classes … that may have been injected server-side"). So the class is never *added* during a live switch.

2. The only message that toggles `kanban-icons-colour` is `colourKanbanIconsChanged` (`kanban.html:6623-6626`), which is broadcast **only when the user manually toggles the checkbox** (`SetupPanelProvider.ts:964-969`), never on a theme change.

So when switching to Claudify at runtime: `theme-claudify` gets added, but `kanban-icons-colour` does not — even though the effective default for Claudify is `true`. The icons stay grey until a reload re-runs `getThemeBodyClass()` and injects the class server-side.

There is a near-miss in the code that confirms the intent: on `setThemeSetting`, `SetupPanelProvider` *does* recompute and re-broadcast the effective value — but as `colourKanbanIconsSetting` and via **`this.postMessage`** (setup panel only, `SetupPanelProvider.ts:322-332`). The kanban webview neither receives that message (it's not broadcast) nor handles the `colourKanbanIconsSetting` type (it only handles `colourKanbanIconsChanged`). The checkbox updates; the board does not.

### Fix strategy

Broadcast the **effective** `colourKanbanIcons` value to **all** webviews whenever the theme name changes, using the message type the kanban board already understands (`colourKanbanIconsChanged`). Because the effective default is theme-derived when the setting is unset, a theme change *is* a change to the effective value even though `switchboard.theme.colourKanbanIcons` itself didn't change.

The single central chokepoint every theme switch passes through is the config watcher in `TaskViewerProvider` (`src/services/TaskViewerProvider.ts:691-696`), which fires on `switchboard.theme.name` regardless of which panel triggered it. Adding the broadcast there covers all entry points (setup dropdown, command palette, settings.json edit) in one place.

## Metadata

- **Tags:** ui, bugfix, frontend
- **Complexity:** 3 / 10
- **Area:** `src/services/TaskViewerProvider.ts` (config watcher), depends on `themeBodyClass.ts` + existing `colourKanbanIconsChanged` handler

## User Review Required

- **None.** The fix wires two existing, correct pieces together (`getEffectiveColourKanbanIcons` + the `colourKanbanIconsChanged` handler) at the single theme-change chokepoint. It respects the existing default logic and explicit user overrides; there is no product decision to make.

## Complexity Audit

### Routine
- A single added broadcast in an existing `onDidChangeConfiguration` block.
- The kanban-side handler (`colourKanbanIconsChanged`) and the effective-value function (`getEffectiveColourKanbanIcons`) already exist and are correct; we are only wiring them together on the theme-change event.
- No new message type, no new state, no CSS change, no migration.

### Complex / Risky
- **One cross-file dependency to get right:** picking the correct broadcast site so every theme-switch path is covered, and confirming the broadcast actually reaches the kanban webview (resolved below — it does, via `broadcastToWebviews` → `_kanbanProvider.postMessage`).

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The broadcast fires synchronously inside the config-change handler; the kanban handler only toggles a class and posts nothing back (no feedback loop).
- **Security:** None. No user input, no new surface — an internal boolean flows to a `classList.toggle`.
- **Side Effects:**
  - **Default is already correct — do NOT change it.** `getEffectiveColourKanbanIcons()` already returns `true` for Claudify when unset, and `getThemeBodyClass()` already applies it on first paint. This plan does **not** touch the default logic (and must not — changing it risks the first-paint path). It only makes the *live switch* honour the existing default.
  - **Switching *away* from Claudify (→ afterburner):** `getEffectiveColourKanbanIcons()` returns `false` for afterburner when unset, so the broadcast toggles `kanban-icons-colour` off. Harmless either way — the colour CSS is scoped to `body.theme-claudify.kanban-icons-colour`, so afterburner ignores the class regardless.
  - **User explicitly set the toggle OFF for Claudify:** `inspect()` returns an explicit global/workspace `false`, so `getEffectiveColourKanbanIcons()` returns `false` and the broadcast keeps icons grey — respecting the user's choice. Explicit values still win.
  - **Double-broadcast / redundancy:** `SetupPanelProvider.setThemeSetting` already broadcasts `switchboardThemeChanged` (`:320`) *and* the config watcher does too (`TaskViewerProvider.ts:695`). Adding one more idempotent `colourKanbanIconsChanged` broadcast is safe — the handler just toggles a class (`classList.toggle`), which is idempotent.
  - **Other panels (design, planning) also add `theme-claudify`** and would receive the broadcast, but none of them render kanban icons, so the extra message is a no-op there. Acceptable.
- **Dependencies & Conflicts:**
  - **`package.json` default is `false` (`package.json:726`) but is not consulted:** `getEffectiveColourKanbanIcons` uses `inspect()` and reads only `workspaceValue`/`globalValue`, falling back to the theme-derived default — it never reads the package `defaultValue`. So the package default being `false` does not undermine the Claudify=true behaviour. No change needed there.
  - **Setup checkbox still updates:** `SetupPanelProvider.setThemeSetting` already re-broadcasts `colourKanbanIconsSetting` to itself (`:329-332`) to refresh the checkbox. That path is untouched, so the checkbox continues to reflect the effective value.

  > **Superseded:** "`KanbanProvider.ts:417-421` has its own theme-name watcher … If the kanban webview is served by `KanbanProvider` and not reached by `broadcastToWebviews`, mirror the same two lines there — verify during implementation which provider owns the kanban webview registration."
  > **Reason:** This open question is now resolved by reading the code. `TaskViewerProvider.broadcastToWebviews()` (`TaskViewerProvider.ts:4975-4980`) explicitly forwards every message to `this._kanbanProvider?.postMessage(message)` (line 4977) in addition to the shared/design/planning webviews. The existing `switchboardThemeChanged` broadcast (line 695) already rides this exact path — and the whole premise of this bug is that `theme-claudify` *does* get added on live switch, which proves the kanban webview receives `broadcastToWebviews` traffic.
  > **Replaced with:** No `KanbanProvider` change is required. The single broadcast added to the `TaskViewerProvider` config watcher reaches the kanban webview via `_kanbanProvider.postMessage`. `KanbanProvider.ts:417-421` does **not** need to be touched.

  - **Cross-subtask coordination (intra-feature):** the sibling subtask *"'Colour Kanban Board Icons' Label & Description Should Use American 'Color'"* renames only user-facing *display copy* and explicitly leaves the message type `colourKanbanIconsChanged`, the function `getEffectiveColourKanbanIcons`, and the body class `kanban-icons-colour` unchanged. Those are exactly the identifiers this plan depends on, so the two subtasks are compatible and order-independent.

## Dependencies

- None (no cross-session dependencies). Compatible with the sibling "American Color spelling" subtask, which preserves every identifier this fix relies on (see Dependencies & Conflicts above).

## Adversarial Synthesis

Key risks: (1) choosing a broadcast site that misses some theme-switch entry point (mitigated by using the central `switchboard.theme.name` config watcher, which every path funnels through); (2) accidentally altering the first-paint default logic while wiring the live path (mitigated by touching only the config watcher, not `themeBodyClass.ts`); (3) the broadcast failing to reach the kanban webview (resolved — `broadcastToWebviews` forwards to `_kanbanProvider.postMessage`, the same path the working `switchboardThemeChanged` broadcast uses). The change is idempotent and respects explicit user overrides, so redundant broadcasts and the switch-away case are safe.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — theme-name config watcher (lines 691-696)

Add an effective-value broadcast next to the existing `switchboardThemeChanged` broadcast. `getEffectiveColourKanbanIcons` is already imported at the top of this file (`TaskViewerProvider.ts:9`).

```ts
vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('switchboard.theme.name')) {
        const theme = this.handleGetThemeSetting();
        this.broadcastToWebviews({ type: 'switchboardThemeChanged', theme });
        // The effective "colour kanban icons" default is theme-derived when the
        // setting is unset (true for Claudify). Switching themes therefore changes
        // the effective value even though switchboard.theme.colourKanbanIcons itself
        // did not — so re-broadcast it here. Without this, switching to Claudify at
        // runtime adds `theme-claudify` but never `kanban-icons-colour`, leaving icons
        // grey until reload despite the checkbox reading ON.
        this.broadcastToWebviews({
            type: 'colourKanbanIconsChanged',
            enabled: getEffectiveColourKanbanIcons()
        });
    }
    // …existing disableCyberAnimation / other blocks unchanged…
```

`broadcastToWebviews` (`TaskViewerProvider.ts:4975-4980`) fans the message out to the shared sidebar webview and to `_kanbanProvider`, `_designPanelProvider`, and `_planningPanelProvider` — so the kanban webview receives it and its existing `colourKanbanIconsChanged` handler (`kanban.html:6623-6626`) toggles the class live. **No change to `KanbanProvider` is required.**

### 2. (Optional consistency) `src/services/SetupPanelProvider.ts` — `setThemeSetting` (lines 316-333)

The setup panel already re-broadcasts `colourKanbanIconsSetting` to itself for the checkbox. This still works via the existing code. The redundant `this.postMessage({ type: 'colourKanbanIconsSetting', … })` block (`:329-332`) can stay as-is (belt-and-braces) — no change required. **Do not remove it** unless verification proves the checkbox still updates without it.

*No CSS, no HTML, no `themeBodyClass.ts`, and no `package.json` changes are required.*

## Verification Plan

### Automated Tests
- None. Per session directive (SKIP TESTS) and because this is a live cross-webview theme behaviour with no unit-test harness. Verification is manual (below).

### Manual verification
1. Load the change in an installed VSIX (no project compilation step is part of this plan).
2. Start on the **Afterburner** theme with the kanban board open (icons grey/cyber). Do **not** reload.
3. Open Setup → Theme tab → switch theme to **Claudify**.
   - **Expected:** kanban icons turn terracotta **immediately** (no reload), and the "Colour kanban board icons" checkbox shows **ON**.
4. Switch back to **Afterburner** live → icons return to the afterburner treatment immediately; checkbox reflects afterburner default (OFF).
5. On Claudify, manually **uncheck** "Colour kanban board icons" → icons go grey; switch to Afterburner and back to Claudify → icons **stay grey** (explicit OFF is respected, not reset to the default).
6. Re-check the box on Claudify → icons colour again; reload the board → still coloured (first-paint path unaffected).
7. Regression: confirm afterburner CRT effects, pixel-font, and other theme classes still toggle correctly on live switch (the `switchboardThemeChanged` handler is unchanged).

## Recommendation

Complexity 3 → **Send to Intern.** A single wiring change at a well-identified chokepoint, with the reaching-the-webview question now resolved. Borderline Intern/Coder because of the one cross-file dependency; the resolved provider-ownership note removes the main uncertainty.
