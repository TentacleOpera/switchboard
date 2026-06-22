# Persist Theme Selection in Setup Across Reopen / IDE Restart

## Goal

In `setup.html` the **Theme** selector does not reflect the actually-saved theme after closing Setup or restarting the IDE. It always shows the default (Afterburner), creating a confusing state where the radio shows the wrong "currently selected" theme even though a different theme is active everywhere else.

### Problem Analysis

The saved theme lives in VS Code config `switchboard.theme.name`. Other panels read it on load and push it to their webview — e.g. KanbanProvider ([KanbanProvider.ts:4282-4284](src/services/KanbanProvider.ts#L4282)) and PlanningPanelProvider `_handleFetchRoots` ([PlanningPanelProvider.ts:6032-6033](src/services/PlanningPanelProvider.ts#L6032)) both post `switchboardThemeNameSetting`.

The Setup panel does **not** do this. In [setup.html](src/webview/setup.html):
- `currentSwitchboardTheme` defaults to `'afterburner'` ([1623](src/webview/setup.html#L1623)).
- When the Theme tab opens, the section handler only posts `getCyberAnimationDisabledSetting` and then sets the radio from `currentSwitchboardTheme` ([1712-1717](src/webview/setup.html#L1712)) — it never requests the persisted theme.
- `currentSwitchboardTheme` is only updated when a `switchboardThemeNameSetting` / `switchboardThemeChanged` message arrives ([4019-4031](src/webview/setup.html#L4019)), which the Setup panel only emits in response to the user *changing* the theme ([SetupPanelProvider.ts:125-132](src/services/SetupPanelProvider.ts#L125)).

So on a fresh panel load there is no inbound theme message, `currentSwitchboardTheme` stays `'afterburner'`, and the radio shows Afterburner regardless of the real setting.

### Root Cause

`SetupPanelProvider` never sends the current `switchboard.theme.name` to the webview on load/ready, and the webview never requests it. The selector is initialized from a hardcoded default instead of persisted config.

**Config scope note:** `handleSetThemeSetting` writes at `ConfigurationTarget.Workspace` ([TaskViewerProvider.ts:3780](src/services/TaskViewerProvider.ts#L3780)). The read via `getConfiguration('switchboard').get('theme.name', 'afterburner')` returns the effective merged value (Global → Workspace override), so no scope-specific handling is needed.

## Metadata

**Complexity:** 2
**Tags:** frontend, backend, bugfix, ui

## User Review Required

No — this is a straightforward bugfix mirroring an existing, proven pattern (KanbanProvider `ready` handler). No product decisions or UX trade-offs involved.

## Complexity Audit

### Routine
- Reading `switchboard.theme.name` and posting `switchboardThemeNameSetting` on Setup panel `ready` — mirrors what Kanban/Planning already do.
- Adding a `getThemeSetting` message handler in `SetupPanelProvider` that reads config and posts the same payload.
- Adding a `getThemeSetting` request in the webview theme-tab callback.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** The webview must already have its `switchboardThemeNameSetting` handler registered before the message arrives — it is registered at script load ([setup.html:4019](src/webview/setup.html#L4019)), and `ready` is posted from the webview after script load, so the round-trip is safe. The `getThemeSetting` request from the theme-tab callback may arrive at the provider concurrently with `ready`; both post `switchboardThemeNameSetting` back, and the webview handler is idempotent (sets radio + body class), so the double-post is harmless.
- **Security:** None.
- **Side Effects:** The handler also applies the body theme class ([4025-4029](src/webview/setup.html#L4025)); sending the real theme on load means the Setup panel body now visually matches the active theme too — a desirable side effect.
- **Dependencies & Conflicts:** Pairs naturally with the "hide animation toggle for non-Afterburner" change, which also keys off the resolved theme. Apply the theme send first so that fix has correct state on load.
- **`open` reveal path:** When the panel already exists, `open()` ([SetupPanelProvider.ts:47-54](src/services/SetupPanelProvider.ts#L47)) reveals and calls `postSetupPanelState()` but does not send the theme. This is correct — `retainContextWhenHidden: true` ([line 63](src/services/SetupPanelProvider.ts#L63)) preserves webview state, so `currentSwitchboardTheme` is still valid. No change needed for the reveal path.
- **Persisted tab is `theme`:** If `vscode.getState().activeTabId` is `'theme'`, `initTabs()` fires the theme callback during webview load, before the `ready` round-trip completes. The radio briefly shows Afterburner until the `switchboardThemeNameSetting` response arrives. The `getThemeSetting` request from the tab callback provides a second sync opportunity. The sub-second flash is cosmetic and acceptable.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) line-number drift between plan and source — mitigated by verifying against current source before editing. (2) Double-post of `switchboardThemeNameSetting` when persisted tab is `theme` — mitigated by idempotent webview handler. (3) Brief radio flash before theme response arrives — cosmetic only, acceptable. The core fix is a proven pattern reuse with zero regression risk.

## Proposed Changes

### 1. `src/services/SetupPanelProvider.ts` — send theme on `ready`

In the `ready` case ([line 134-140](src/services/SetupPanelProvider.ts#L134)), after `postSetupPanelState()`, post the persisted theme. This mirrors KanbanProvider.ts:4282-4284 exactly.

```ts
case 'ready':
    await this._taskViewerProvider.postSetupPanelState();
    {
        const currentTheme = vscode.workspace.getConfiguration('switchboard')
            .get<string>('theme.name', 'afterburner');
        this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
    }
    if (this._pendingSection) {
        this._panel.webview.postMessage({ type: 'openSetupSection', section: this._pendingSection });
        this._pendingSection = undefined;
    }
    break;
```

**Context:** The block scope `{ ... }` is required to avoid a `const` declaration directly in a `switch` case without its own block.

### 2. `src/webview/setup.html` — also request on theme-tab open (belt-and-suspenders)

In the `'theme'` section handler ([line 1712-1717](src/webview/setup.html#L1712)), add a `getThemeSetting` request so re-entering the tab re-syncs even if the initial `ready` message was missed:

```js
'theme': () => {
    vscode.postMessage({ type: 'getCyberAnimationDisabledSetting' });
    vscode.postMessage({ type: 'getThemeSetting' });   // NEW
    const savedTheme = currentSwitchboardTheme || 'afterburner';
    const themeRadio = document.querySelector(`input[name="theme-selection"][value="${savedTheme}"]`);
    if (themeRadio) themeRadio.checked = true;
},
```

### 3. `src/services/SetupPanelProvider.ts` — handle `getThemeSetting`

Add a new case (near the existing `getCyberAnimationDisabledSetting` case at [line 661](src/services/SetupPanelProvider.ts#L661)) that reads config and posts `switchboardThemeNameSetting`:

```ts
case 'getThemeSetting': {
    const currentTheme = vscode.workspace.getConfiguration('switchboard')
        .get<string>('theme.name', 'afterburner');
    this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
    break;
}
```

**Context:** This is the same read-and-post pattern used by `getCyberAnimationDisabledSetting` ([line 661-666](src/services/SetupPanelProvider.ts#L661)). No new dependencies or helper methods needed.

**Edge Cases:** If `switchboard.theme.name` is unset, `.get('theme.name', 'afterburner')` returns the `'afterburner'` default — matching the webview's own default. No special handling needed.

## Verification Plan

### Automated Tests

> **Session directive:** Compilation and automated tests are skipped for this session. The test suite will be run separately by the user. The plan below documents what should be verified.

1. Set theme to Claudify in Setup → Theme.
2. Close the Setup panel and reopen it → confirm the Claudify radio is selected (not Afterburner) and the Setup body reflects Claudify.
3. Reload the window (Developer: Reload Window) → open Setup → Theme → confirm the radio still shows Claudify.
4. Switch back to Afterburner, reopen → confirm Afterburner is selected.
5. With persisted tab set to `theme`, reload window → confirm the theme tab loads with the correct radio selected (brief flash of Afterburner is acceptable).
6. Add/extend a SetupPanelProvider test asserting `ready` triggers a `switchboardThemeNameSetting` post with the configured theme.

---

**Recommendation:** Complexity 2 → **Send to Intern**
