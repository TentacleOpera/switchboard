# Default "Colour Kanban Board Icons" to ON for Claudify & Afterburner Professional

## Goal

In `setup.html`, the Theme tab exposes a "Colour kanban board icons" toggle. For the **Claudify** and **Afterburner Professional** themes, this toggle currently defaults to **OFF**. It should default to **ON** instead, so that users selecting either of those themes immediately see coloured kanban icons without having to manually enable the option.

### Problem Analysis

The "Colour kanban board icons" setting controls whether kanban board card icons are rendered in colour (theme accent) or monochrome. The default value is determined per-theme (or via a single global default that the theme selection overrides). For Claudify and Afterburner Professional — both "professional" themes with neutral chrome — coloured icons are the intended visual default, but the current code leaves them off, producing a drabber board than expected and forcing the user to discover and flip the toggle.

#### Root Cause

The setting `switchboard.theme.colourKanbanIcons` is a single boolean persisted at the Workspace configuration target, with a global default of `false` (defined in `package.json:670`, `scope: "window"`). It is read in **two** places:

1. **`src/services/TaskViewerProvider.ts:3650-3652`** — `handleGetColourKanbanIconsSetting()` returns `get<boolean>('theme.colourKanbanIcons', false)`. This feeds the toggle in the Theme tab.
2. **`src/services/themeBodyClass.ts:21`** — `getThemeBodyClass()` reads `get<boolean>('theme.colourKanbanIcons', false)` to decide whether to add the `kanban-icons-colour` body class at HTML generation time (prevents flash-of-wrong-theme on first paint).

Both sites use `get(key, false)`, which returns `false` for **both** "explicitly set to false" and "never set, defaulting to false." There is no way to distinguish these two cases through the plain `get()` API. This is the core technical challenge: the plan requires that only **unset** (first-use) values get the new per-theme default, while **explicitly set** values (true or false) are always respected.

The solution is `vscode.workspace.getConfiguration().inspect<boolean>(key)`, which returns `{ workspaceValue, globalValue, defaultValue, ... }` — when both `workspaceValue` and `globalValue` are `undefined`, the setting was never explicitly set, and the per-theme default applies.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, ux, bugfix

## User Review Required

Yes — this changes the visual default for ~4,000 installed users on Claudify and Afterburner Professional who have never touched the toggle. Users who explicitly toggled OFF are unaffected (their explicit `false` is preserved). Users who never touched the toggle will see coloured icons appear on next load. Confirm this is the desired behaviour.

## Complexity Audit

### Routine
- Add a shared `getEffectiveColourKanbanIcons()` helper function in `src/services/themeBodyClass.ts` that uses `inspect()` to detect unset values and applies the per-theme default (`true` for `claudify` and `afterburner-professional`, `false` otherwise).
- Patch `handleGetColourKanbanIconsSetting()` in `TaskViewerProvider.ts:3650` to call the shared helper instead of the plain `get()`.
- Patch `getThemeBodyClass()` in `themeBodyClass.ts:21` to call the shared helper.
- Patch the `setThemeSetting` handler in `SetupPanelProvider.ts:125-132` to re-broadcast the effective `colourKanbanIconsSetting` value after a theme switch, so the toggle updates live.
- Fix the `bug` → `bugfix` tag (already done in this plan's Metadata).

### Complex / Risky
- The `inspect()` logic must check **both** `workspaceValue` and `globalValue` for `undefined` — the setting can be set at either level. Missing the `globalValue` check would override a user who explicitly set it to `false` at the global (user) level.
- The `setThemeSetting` re-broadcast must not create a feedback loop: pushing `colourKanbanIconsSetting` triggers the webview's `colourKanbanIconsSetting` case (`setup.html:4544`) which only sets `toggle.checked` — it does **not** send a `setColourKanbanIconsSetting` message back, so no loop. Safe.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The `inspect()` call is synchronous and reads the current config state. The `setThemeSetting` handler is async but the re-broadcast happens after the theme update completes.
- **Security:** No security implications — this is a UI default value change.
- **Side Effects:** No config mutation. The effective default is computed on read; the setting is only persisted when the user explicitly toggles the checkbox (existing `setColourKanbanIconsSetting` flow). This is the least surprising approach.
- **Dependencies & Conflicts:**
  - **Existing users (explicit OFF):** `inspect()` returns `workspaceValue: false` → helper returns `false`. Toggle stays OFF. Respected.
  - **Existing users (explicit ON):** `inspect()` returns `workspaceValue: true` → helper returns `true`. Toggle stays ON. Respected.
  - **Existing users (unset, on claudify/afterburner-pro):** `inspect()` returns `workspaceValue: undefined, globalValue: undefined` → helper returns `true` (new default). Toggle shows ON. Icons become coloured. This is the intended behaviour change.
  - **Existing users (unset, on afterburner):** `inspect()` returns undefined → helper returns `false` (afterburner is not in the per-theme-ON list). Unchanged.
  - **Afterburner (plain):** Unchanged — not in the per-theme-ON list. The colour-icons section is hidden for afterburner anyway (`setup.html:1695-1696`).
  - **Live theme switch (afterburner → claudify, unset):** `setThemeSetting` handler re-broadcasts effective value → toggle updates to ON live. No stale state.
  - **Live theme switch (claudify → afterburner, unset):** Re-broadcast → toggle updates to OFF live (afterburner not in per-theme-ON list). Section also hides.
  - **No backend schema changes** — this is a config-read default value change only.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) the `inspect()` unset-detection logic must check both `workspaceValue` and `globalValue`, or it will override globally-set explicit OFF values; (2) the second read site in `themeBodyClass.ts` must be patched or kanban boards will flash grey-then-colour on first paint; (3) the `setThemeSetting` handler must re-broadcast the effective value or the toggle goes stale on live theme switches. Mitigations: a single shared helper function ensures both read sites use identical logic; the re-broadcast is a one-line addition to the existing theme-switch flow with no feedback-loop risk.

## Proposed Changes

### `src/services/themeBodyClass.ts` — add shared effective-default helper

- **Context:** This lightweight standalone module already reads `switchboard.theme.colourKanbanIcons` at line 21 to decide the body class at HTML generation time. It imports only `vscode`, so it's the ideal home for a shared helper that `TaskViewerProvider` can also import.
- **Logic:** Add an exported function `getEffectiveColourKanbanIcons(): boolean` that:
  1. Calls `vscode.workspace.getConfiguration('switchboard').inspect<boolean>('theme.colourKanbanIcons')`.
  2. If `inspect.workspaceValue !== undefined`, return `inspect.workspaceValue` (explicit workspace-level value wins).
  3. Else if `inspect.globalValue !== undefined`, return `inspect.globalValue` (explicit user-level value).
  4. Else (both undefined → unset): read the current theme via `cfg.get<string>('theme.name', 'afterburner')`. Return `true` if theme is `'claudify'` or `'afterburner-professional'`; return `false` otherwise.
- **Implementation:** Add the function above `getThemeBodyClass()`. Then replace line 21 (`const colourIcons = cfg.get<boolean>('theme.colourKanbanIcons', false);`) with `const colourIcons = getEffectiveColourKanbanIcons();`.
- **Edge Cases:** The `inspect()` call is synchronous and safe. The theme read inside the helper uses the same config section, so there's no stale-config risk.

### `src/services/TaskViewerProvider.ts:3650-3652` — use shared helper

- **Context:** `handleGetColourKanbanIconsSetting()` currently returns `get<boolean>('theme.colourKanbanIcons', false)`. This feeds the Theme tab toggle via the `getColourKanbanIconsSetting` message handler in `SetupPanelProvider.ts:689-693`.
- **Logic:** Replace the body with a call to `getEffectiveColourKanbanIcons()` imported from `themeBodyClass.ts`.
- **Implementation:**
  - Add import: `import { getEffectiveColourKanbanIcons } from './themeBodyClass';` (check existing imports at top of file; merge if `themeBodyClass` is already imported).
  - Replace `return vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.colourKanbanIcons', false);` with `return getEffectiveColourKanbanIcons();`.
- **Edge Cases:** None — the helper encapsulates all the unset-detection logic. `handleSetColourKanbanIconsSetting()` (line 3654-3657) is unchanged; it still persists to `ConfigurationTarget.Workspace`, which `inspect()` will pick up as `workspaceValue` on subsequent reads.

### `src/services/SetupPanelProvider.ts:125-132` — re-broadcast effective value on theme switch

- **Context:** The `setThemeSetting` case updates the theme, broadcasts `switchboardThemeChanged` to all webviews, and pushes `switchboardThemeNameSetting` to the setup panel. The setup panel's handler (`setup.html:4163-4179`) updates the radio and body classes but does **not** re-fetch the colour kanban icons setting, leaving the toggle stale on live theme switches.
- **Logic:** After the existing broadcast, also push the effective `colourKanbanIconsSetting` value so the toggle updates live.
- **Implementation:** After line 131 (`this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme });`), add:
  ```typescript
  this._panel?.webview.postMessage({
      type: 'colourKanbanIconsSetting',
      enabled: this._taskViewerProvider.handleGetColourKanbanIconsSetting()
  });
  ```
  This reuses the existing `colourKanbanIconsSetting` message case in `setup.html:4544-4549`, which sets `toggle.checked` — no webview-side changes needed.
- **Edge Cases:** No feedback loop — the `colourKanbanIconsSetting` handler in setup.html only sets `toggle.checked`; it does not send a `setColourKanbanIconsSetting` message back. The kanban panel also receives `switchboardThemeChanged` and re-applies body classes independently; it does not need the colour-icons re-broadcast because its body class is driven by `getThemeBodyClass()` at HTML generation time and the `colourKanbanIconsChanged` message (only sent on explicit toggle, not on theme switch). However, the kanban panel's body class won't update live on theme switch for the colour-icons class — this is a **pre-existing limitation** (the `switchboardThemeChanged` handler in `kanban.html` at line 5950-5963 does not toggle `kanban-icons-colour`). This plan does not widen scope to fix that; the kanban panel will pick up the correct class on next open/refresh. If live kanban-panel colour update on theme switch is desired, that's a separate enhancement.

## Verification Plan

### Automated Tests

Per session directives: **skip compilation** and **skip automated tests**. The test suite will be run separately by the user.

### Manual Verification

- [ ] **Clean state, Claudify:** Clear the persisted `switchboard.theme.colourKanbanIcons` setting (remove from workspace settings.json). Select Claudify theme → toggle shows ON, kanban icons are coloured.
- [ ] **Clean state, Afterburner Professional:** Same as above with Afterburner Professional → toggle shows ON, kanban icons are coloured (cyan).
- [ ] **Afterburner (plain), clean state:** Select Afterburner → toggle default unchanged (OFF; colour-icons section is hidden).
- [ ] **Explicit OFF respected:** Manually toggle OFF on Claudify, switch away and back → toggle stays OFF (persisted `false` via `inspect().workspaceValue`).
- [ ] **Explicit ON respected:** Manually toggle ON on Afterburner Professional, switch to Afterburner (plain) and back → toggle stays ON.
- [ ] **Live theme switch (unset):** From a clean state on Afterburner, switch to Claudify via the radio button (without closing the Theme tab) → toggle updates to ON live (no stale state).
- [ ] **Live theme switch (explicit OFF):** With Claudify toggle explicitly OFF, switch to Afterburner Professional → toggle stays OFF live.
- [ ] **No flash of grey on first paint:** Open the kanban board on Claudify from a clean state → icons are coloured on first paint (no grey-then-colour flash). This verifies the `themeBodyClass.ts` patch.
- [ ] **Global-level explicit value:** Set `switchboard.theme.colourKanbanIcons: false` at the **user** (global) level, not workspace. Select Claudify → toggle shows OFF (the `globalValue` check in the helper respects it).

---

**Recommendation:** Complexity is 3 → **Send to Coder**.

---

## Reviewer Pass (2026-06-24)

### Stage 1 — Grumpy Principal Engineer

> *"I asked for ONE shared helper. You gave me TWO copy-pasted blobs of the same logic. And you forgot the third requirement entirely. Let me count the ways this disappoints me."*

**[MAJOR] DRY violation — shared helper never created; logic duplicated inline.**
`themeBodyClass.ts:21-24` and `TaskViewerProvider.ts:3652-3658` contain **byte-for-byte equivalent** `inspect()` + per-theme-default logic, inlined at both read sites. The plan's own Adversarial Synthesis explicitly called out that "a single shared helper function ensures both read sites use identical logic." The whole point of centralising this was so that when the per-theme-ON list changes (e.g. a third theme gets added), you update ONE function, not hunt for two copies that are already drifting. This is exactly the kind of "it works today" shortcut that becomes a bug six months from now when someone updates one site and not the other.

**[MAJOR] `setThemeSetting` re-broadcast completely missing.**
`SetupPanelProvider.ts:125-132` was **not touched**. The plan's third Proposed Change — re-broadcasting `colourKanbanIconsSetting` after a theme switch so the Theme tab toggle updates live — was skipped entirely. Result: switch from Afterburner → Claudify with an unset value and the toggle stays OFF until you close and reopen the panel. This directly fails the "Live theme switch (unset)" manual verification case in the plan's own Verification Plan. You wrote the test case and then didn't implement the code that satisfies it.

**[NIT] `!!cfg.get<boolean>(...)` double-negation in the inlined version.**
The inlined copies used `!!config.get<boolean>('theme.colourKanbanIcons')` to coerce. The shared helper uses `!!inspection.workspaceValue` / `!!inspection.globalValue` directly off the `inspect()` result, which is cleaner — it reads the already-fetched value rather than re-querying. Minor, but it shows the inline path was doing redundant config reads.

### Stage 2 — Balanced Synthesis

**Keep:** The core `inspect()` unset-detection logic is correct in both inline copies — it checks both `workspaceValue` and `globalValue` before falling back to the per-theme default, exactly as the plan specified. No logic bug; purely a structural/DRY problem. The `themeBodyClass.ts` first-paint integration is correct and the `TaskViewerProvider.ts` toggle-feed integration is correct.

**Fix now (both are valid MAJOR):**
1. Extract the shared `getEffectiveColourKanbanIcons()` helper into `themeBodyClass.ts` as the plan required; refactor `getThemeBodyClass()` and `TaskViewerProvider.handleGetColourKanbanIconsSetting()` to call it. Eliminates the duplicate and the redundant `get()` re-read.
2. Add the `colourKanbanIconsSetting` re-broadcast to the `setThemeSetting` case in `SetupPanelProvider.ts` after the existing `switchboardThemeNameSetting` push. No feedback-loop risk (confirmed: `setup.html:4544-4549` only sets `toggle.checked`).

**Defer:** Nothing — both findings are material and low-risk to fix.

### Fixes Applied

1. **`src/services/themeBodyClass.ts`** — Added exported `getEffectiveColourKanbanIcons(): boolean` helper (lines 14-39) implementing the `inspect()` → workspaceValue → globalValue → per-theme-default cascade. Refactored `getThemeBodyClass()` (line 48) to call the helper instead of inlining the logic.
2. **`src/services/TaskViewerProvider.ts`** — Extended the existing `themeBodyClass` import (line 4) to include `getEffectiveColourKanbanIcons`. Replaced the 8-line inlined body of `handleGetColourKanbanIconsSetting()` (now line 3650-3652) with a single `return getEffectiveColourKanbanIcons();` call.
3. **`src/services/SetupPanelProvider.ts`** — Added the `colourKanbanIconsSetting` re-broadcast (lines 132-141) inside the `setThemeSetting` case, after the `switchboardThemeNameSetting` push. Calls `this._taskViewerProvider.handleGetColourKanbanIconsSetting()` (which now delegates to the shared helper) and posts the effective value to the setup panel webview.

### Validation Results

- **Compilation:** Skipped per session directives.
- **Automated tests:** Skipped per session directives.
- **Static verification (grep):** `inspect<boolean>('theme.colourKanbanIcons')` now appears in exactly **one** source location (`themeBodyClass.ts:30`) — the duplicate in `TaskViewerProvider.ts` is eliminated. The only other match is in this plan file.
- **Import check:** `TaskViewerProvider.ts:4` imports `getEffectiveColourKanbanIcons` alongside the pre-existing `applyThemeBodyClass` import — no new import line, merged cleanly.
- **Feedback-loop safety:** Confirmed `setup.html:4544-4549` `colourKanbanIconsSetting` handler only sets `toggle.checked`; it does not emit a `setColourKanbanIconsSetting` message. No loop.

### Remaining Risks

- **Pre-existing (out of scope, noted in plan):** The kanban panel's body class does not update the `kanban-icons-colour` class live on theme switch — only on next open/refresh. The `switchboardThemeChanged` handler in `kanban.html` does not toggle that class. This plan explicitly scoped this out; behaviour is unchanged by this review.
- **Manual verification still required:** The 8 manual checklist items in the Verification Plan above have not been executed in this session (no VS Code runtime). The user should run them against an installed VSIX.

