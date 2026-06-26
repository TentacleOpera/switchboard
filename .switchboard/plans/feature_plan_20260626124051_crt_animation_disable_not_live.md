# Make the "Disable CRT Animation" Toggle Take Effect Live

## Goal

When the user disables the afterburner CRT animation via the toggle in `setup.html`, the animation must stop **immediately** on all open panels that render it. Today it keeps animating until the user closes and reopens an HTML panel — the live update path is missing for several panels.

### Problem Analysis & Root Cause

The CRT sweep is gated by the `cyber-animation-disabled` body class: `.cyber-theme-enabled:not(.cyber-animation-disabled) .cyber-scanlines::before` animates. On first paint this class is baked in correctly by `getThemeBodyClass()` (`themeBodyClass.ts:46-49`) — which is exactly why a close+reopen "fixes" it: the regenerated HTML includes the class. The defect is that the **live** toggle path never adds/removes that class on already-open panels.

Three compounding gaps:

1. **No central broadcast for the setting.** `TaskViewerProvider`'s global config listener (`TaskViewerProvider.ts:457-463`) only handles `switchboard.theme.name`; it has **no** branch for `switchboard.theme.disableCyberAnimation`, so changing the setting broadcasts nothing centrally.

2. **The setup handler doesn't broadcast either.** `SetupPanelProvider.ts:707-711` (`setCyberAnimationDisabledSetting`) writes the config and calls `postSetupPanelState()` + `switchboard.refreshUI`, but never broadcasts a `cyberAnimationSetting` message — unlike the theme-name handler right above it (`SetupPanelProvider.ts:129`) which does `broadcastToWebviews`.

3. **Two client panels can't act on the message even when sent:**
   - **Project** (`project.js`) has no `case 'cyberAnimationSetting'` handler; its `handleThemeChanged` deliberately leaves `cyber-animation-disabled` alone (`project.js:133-157`). So `PlanningPanelProvider`'s post of `cyberAnimationSetting` to the project panel (`PlanningPanelProvider.ts:352, 360`) is silently dropped.
   - **Setup** (`setup.html`) only handles `cyberAnimationDisabledSetting` (`setup.html:4678-4684`), and that handler only flips the checkbox — it never toggles `document.body.classList`. So Setup's own animation keeps running until reload.

Panels that already update live (reference implementations): **Design** — `DesignPanelProvider.ts:170-174` posts `cyberAnimationSetting`, `design.js:3457-3458` toggles the class; **Planning/Artifacts** — `PlanningPanelProvider.ts:499-505/619-625` posts, `planning.js:3615-3616` toggles.

> Coupling note: a companion plan removes the CRT scanlines from Design and Setup entirely. This plan is still required for the panels that legitimately animate — **Project** and **Artifacts/Planning** — and it also restores Setup's own live behavior in case the scanline removal is not applied. The two distinct message types must not be conflated: `cyberAnimationSetting { disabled }` (drives the body-class toggle) vs `cyberAnimationDisabledSetting { enabled }` (drives only the setup checkbox state).

### Panels that render CRT scanlines (verified)

Only four webview HTML files contain a `cyber-scanlines` element/CSS: `planning.html`, `project.html`, `setup.html`, `design.html`. The sidebar (`TaskViewerProvider._view`, which serves `implementation.html` — see `TaskViewerProvider.ts:17948-17961`) and `kanban.html` do **not** render scanlines and therefore need no `cyberAnimationSetting` handler. This scopes the live-update work to exactly those four panels.

## Metadata

- **Tags:** `bugfix`, `ui`, `frontend`
- **Complexity:** 4/10
- **Primary files:** `src/webview/project.js`, `src/webview/setup.html`, `src/services/TaskViewerProvider.ts`, `src/services/SetupPanelProvider.ts`

## User Review Required

Yes — confirm the intended product behavior: should the CRT sweep stop *immediately* (no panel reopen) on every open scanline panel when the toggle is flipped, and resume immediately when re-enabled? The plan assumes yes. Also confirm whether the companion "remove scanlines from Design/Setup" plan will land; if it does, the Setup body-class changes here become a no-op safety net (harmless to keep).

## Complexity Audit

### Routine
- Adding a one-line `case 'cyberAnimationSetting'` handler to `project.js`, mirroring the existing `design.js:3457-3458` / `planning.js:3615-3617` pattern exactly.
- Adding a `case 'cyberAnimationSetting'` handler to `setup.html` (same one-liner) for consistency with the other scanline panels.
- Adding an optimistic `classList.toggle` inside `setup.html`'s existing change listener (`setup.html:3979-3989`) for instant visual feedback.
- Extending the existing `cyberAnimationDisabledSetting` inbound handler (`setup.html:4678-4684`) to also reconcile the body class.
- Adding a config-listener branch in `TaskViewerProvider.ts:457-463` mirroring the adjacent `switchboard.theme.name` branch.

### Complex / Risky
- Message-type/polarity discipline: `cyberAnimationSetting { disabled }` (body class) vs `cyberAnimationDisabledSetting { enabled }` (checkbox). Inverting either flips behavior. Multiple touch sites in `setup.html` must agree on polarity.
- Ensuring the central broadcast and the per-provider listeners are complementary, not redundant or conflicting (see Edge-Case audit).

## Edge-Case & Dependency Audit

- **`broadcastToWebviews` reach (corrected):** it posts to `this._view` (sidebar = `implementation.html`), the setup panel, and kanban (`TaskViewerProvider.ts:4163-4171`). Of these, **only Setup renders scanlines**. The sidebar and kanban have no scanlines and no `cyberAnimationSetting` handler, so the broadcast is a harmless no-op for them. The broadcast becomes useful for Setup *only after* `setup.html` gains a `cyberAnimationSetting` handler (Proposed Change #3). The panels that animate via their **own** per-provider listeners — Project, Planning, Design — are reached independently of the central broadcast (`PlanningPanelProvider.ts:350-353/499-502`, `DesignPanelProvider.ts:171-174`). Central broadcast and per-panel posts are complementary.
- **Two message types:** keep `cyberAnimationSetting { disabled }` and `cyberAnimationDisabledSetting { enabled }` separate. The body-class toggle keys off `disabled`; the checkbox state keys off `enabled`. Inverting either flips the behavior.
- **First-paint parity:** the live class name must remain exactly `cyber-animation-disabled` to match `getThemeBodyClass()` (`themeBodyClass.ts:46-49`).
- **Project panel:** `PlanningPanelProvider` already posts `cyberAnimationSetting` to the project panel on config change (`PlanningPanelProvider.ts:350-353`) and on init (`:359-360`); once `project.js` has the handler, the project panel works with no further provider change.
- **Idempotency of coexisting toggles:** `classList.toggle(cls, force)` is idempotent — calling it repeatedly with the same `force` boolean is a no-op. Setup may therefore have three sites touching `cyber-animation-disabled` (the optimistic toggle, the `cyberAnimationSetting` handler, and the `cyberAnimationDisabledSetting` handler) without risk of a double-toggle or flicker, provided all three compute the same `disabled` value.
- **External change path (VS Code Settings UI):** if the setting is edited directly in the VS Code Settings editor (not the setup toggle), `setCyberAnimationDisabledSetting` is not invoked, so `postSetupPanelState`'s `cyberAnimationDisabledSetting` round-trip may not fire for Setup. The central broadcast + Setup's new `cyberAnimationSetting` handler covers this path; the per-provider listeners cover Project/Planning/Design.
- **No migration:** this is runtime messaging only. No persisted state shape changes.

## Dependencies

- None. This plan is self-contained runtime messaging work.

## Adversarial Synthesis

Key risks: (1) the central broadcast is inert unless `setup.html` also gains a `cyberAnimationSetting` handler — the plan now adds both so they complete each other; (2) `cyberAnimationSetting { disabled }` vs `cyberAnimationDisabledSetting { enabled }` polarity confusion across multiple setup.html touch sites — mitigated by mirroring the exact `force` expression used in the reference panels and noting idempotency; (3) mistaking the central broadcast for the primary fix when the actual root fix is the missing `project.js` handler. Mitigations: lead with the `project.js` handler, add the setup `cyberAnimationSetting` handler for consistency, and keep all toggles idempotent.

## Proposed Changes

### `src/webview/project.js` (PRIMARY FIX — missing client handler)

This is the core defect: the project panel renders scanlines (`project.html:675,700`) and its provider already posts `cyberAnimationSetting` to it (`PlanningPanelProvider.ts:352,360`), but `project.js` has no handler, so the message is silently dropped.

Add a handler mirroring `design.js:3457-3458` / `planning.js:3615-3617`, in the panel's message switch immediately after the existing `switchboardThemeChanged` case (`project.js:300-303`):

```js
case 'switchboardThemeNameSetting':
case 'switchboardThemeChanged':
    handleThemeChanged(msg.theme);
    break;
case 'cyberAnimationSetting':
    document.body.classList.toggle('cyber-animation-disabled', msg.disabled);
    break;
```

- **Context:** `handleThemeChanged` (`project.js:133-157`) deliberately does NOT touch `cyber-animation-disabled` (it only manages `theme-claudify` / `cyber-theme-enabled`), so a dedicated case is required.
- **Logic:** `classList.toggle(cls, force)` sets the class when `msg.disabled === true` and removes it when `false`.
- **Edge cases:** `msg.disabled` is always a boolean from the provider (`get<boolean>(...)`), so no truthy/falsy coercion issues. If the message arrives before the body exists it is harmless (the listener is registered after DOM init).

### `src/webview/setup.html` (consistency + live body class)

Three coordinated edits so Setup behaves like the other scanline panels AND updates instantly:

**1. Optimistic toggle in the change listener (`setup.html:3979-3989`)** — instant visual feedback, no round-trip wait:

```js
document.getElementById('cyber-animation-toggle')?.addEventListener('change', (e) => {
    const isDisabled = !e.target.checked;
    vscode.postMessage({ type: 'setCyberAnimationDisabledSetting', enabled: isDisabled });
    // Optimistically apply the body class immediately (idempotent with the inbound handlers below).
    document.body.classList.toggle('cyber-animation-disabled', isDisabled);
    const statusEl = document.getElementById('cyber-animation-status');
    if (statusEl) {
        statusEl.textContent = 'Saved';
        setTimeout(() => {
            statusEl.textContent = '';
        }, 2000);
    }
});
```

**2. Add a `cyberAnimationSetting` case** (mirrors `design.js:3457-3458`) so the central broadcast and any external post update Setup's body class — making Setup consistent with every other scanline panel. Insert next to the existing `cyberAnimationDisabledSetting` case (`setup.html:4678`):

```js
case 'cyberAnimationSetting': {
    runSetupHydration(() => {
        document.body.classList.toggle('cyber-animation-disabled', message.disabled);
    });
    break;
}
```

**3. Extend the existing `cyberAnimationDisabledSetting` handler (`setup.html:4678-4684`)** to also reconcile the body class (not just the checkbox), so an external `postSetupPanelState` round-trip keeps the body class in sync:

```js
case 'cyberAnimationDisabledSetting': {
    runSetupHydration(() => {
        const toggle = document.getElementById('cyber-animation-toggle');
        if (toggle) toggle.checked = message.enabled !== true;
        document.body.classList.toggle('cyber-animation-disabled', message.enabled === true);
    });
    break;
}
```

- **Context:** `postSetupPanelState` posts `cyberAnimationDisabledSetting { enabled }` to Setup (`TaskViewerProvider.ts:4310-4313`), and `setCyberAnimationDisabledSetting` calls `postSetupPanelState()` (`SetupPanelProvider.ts:709`), so this handler is reached on the user's own toggle as a confirmation pass.
- **Logic:** checkbox keys off `enabled !== true` (checked = animation on = not disabled); body class keys off `enabled === true` (disabled = class present). Both derive from the same `enabled` boolean, so polarity stays consistent.
- **Edge cases:** all three setup touch sites are idempotent (`toggle(cls, force)` with a consistent `force`), so the optimistic toggle + the `cyberAnimationSetting` handler + the `cyberAnimationDisabledSetting` handler coexist without flicker.

### `src/services/TaskViewerProvider.ts` (central broadcast)

In the global config listener (`TaskViewerProvider.ts:457-463`), add a branch for the animation setting mirroring the adjacent `switchboard.theme.name` branch. This is what makes Setup's body class update when the setting is changed outside the setup toggle (e.g. via the VS Code Settings UI):

```ts
this._context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('switchboard.theme.name')) {
            const theme = this.handleGetThemeSetting();
            this.broadcastToWebviews({ type: 'switchboardThemeChanged', theme });
        }
        if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
            const disabled = vscode.workspace
                .getConfiguration('switchboard')
                .get<boolean>('theme.disableCyberAnimation', false);
            this.broadcastToWebviews({ type: 'cyberAnimationSetting', disabled });
        }
    })
);
```

- **Context:** `broadcastToWebviews` (`TaskViewerProvider.ts:4168-4171`) reaches the sidebar (`implementation.html`), Setup, and kanban. Only Setup renders scanlines and (after Proposed Change #2) has a `cyberAnimationSetting` handler, so the broadcast meaningfully reaches Setup; it is a harmless no-op for the sidebar and kanban.
- **Logic:** reads the same config key and default (`theme.disableCyberAnimation`, default `false`) used by `getThemeBodyClass()` (`themeBodyClass.ts:47`) and the per-provider listeners, preserving first-paint parity.
- **Edge cases:** the per-provider listeners in `PlanningPanelProvider` and `DesignPanelProvider` fire on the same config event and post to their own panels independently; the central broadcast does not duplicate into those panels (it cannot reach them), so there is no double-post to Project/Planning/Design.

### `src/services/SetupPanelProvider.ts` (optional belt-and-braces)

If the central broadcast in `TaskViewerProvider` is added (Proposed Change #3), `setCyberAnimationDisabledSetting` (`SetupPanelProvider.ts:707-711`) needs no change — the config write triggers `onDidChangeConfiguration`, which drives the central broadcast and the per-provider listeners. If the central branch is *not* added, have this handler call `this._taskViewerProvider.broadcastToWebviews({ type: 'cyberAnimationSetting', disabled: message.enabled })` mirroring the theme-name handler at `SetupPanelProvider.ts:129`. Prefer the central broadcast (single source of truth in the config listener).

## Verification Plan

### Automated Tests

No automated tests are added or run as part of this session (per session directives). The user will run the test suite separately. The change is runtime webview-messaging behavior verified manually below.

### Manual Verification

1. Build/install the VSIX. Select the **afterburner** theme.
2. Open the **Artifacts** (planning) and **Project** panels side by side so the CRT sweep is visible on both.
3. In **Setup**, toggle "disable CRT animation" ON. Confirm the sweep stops **immediately** on Setup, Project, and Artifacts — with **no** panel close/reopen.
4. Toggle it OFF — confirm the sweep resumes immediately on all open panels.
5. Confirm the Setup checkbox state stays in sync when toggled from another window/panel (inbound `cyberAnimationDisabledSetting`).
6. Confirm first-paint still respects the setting: with animation disabled, open a fresh panel and confirm it starts static (no flash of animation), proving `themeBodyClass.ts` parity.
7. External-change path: change `switchboard.theme.disableCyberAnimation` directly in the VS Code Settings UI (not the setup toggle) and confirm Setup's body class updates live (validates the central broadcast + Setup `cyberAnimationSetting` handler).
8. Regression: confirm `cyberAnimationSetting { disabled }` and `cyberAnimationDisabledSetting { enabled }` are not conflated (toggle direction is correct in both directions on all four scanline panels).

## Recommendation

Complexity 4/10 → **Send to Coder**.
