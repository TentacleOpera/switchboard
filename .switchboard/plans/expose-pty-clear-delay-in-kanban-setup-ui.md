# Expose VS Code clear delay and PTY readiness mode in Kanban Setup

## Goal

Make the Kanban “Terminal Context” setup UI accurately control two different delivery systems: an exact fixed delay for indirect VS Code terminals, and Automatic CLI readiness versus a manual fixed-delay override for directly-owned PTY seats. Preserve existing explicit values and make the effective compatibility source visible instead of allowing a 600ms slider to silently defeat known-CLI readiness detection.

> **Superseded:** Expose both delays as independent, unconditional sliders: VS Code terminals at 2000ms and PTY fleet/browser seats at 600ms.
> **Reason:** `.switchboard/plans/bracketed-paste-submit-cr-not-firing-on-devin-3000-5-20-under-load.md` proved that Devin can require roughly 8.85 seconds and multiple enable/disable cycles before it is actually ready after `/clear`. Treating 600ms as the active PTY delay for a known Devin seat recreates the exact race the readiness detector fixes.
> **Replaced with:** Keep the VS Code exact-delay slider; replace the PTY unconditional slider with Auto/Manual policy plus a manual-delay control.

### Problem Analysis

The existing `terminal.clearBeforePromptDelay` setting belongs to indirect `vscode.Terminal` delivery. Those paths use clipboard paste, focus acquisition, `terminal.sendText()`, and extension-host IPC. The stable VS Code terminal API does not expose the raw TUI output stream needed to prove that `/clear` finished, so a configured fixed wait remains necessary.

The direct PTY path is different: `ExtendedTerminalHandle.onData` exposes raw output and supports CLI-specific readiness detection. The related readiness plan adds profiles for Devin, Claude, Antigravity, and unknown/custom CLIs.

The old UI plan would clash with that runtime in two ways:

1. It presents 600ms as the PTY path’s active timing even when automatic readiness should own a known CLI.
2. It persists any slider change as an explicit PTY value, causing the current resolver to treat that number as authoritative and bypass automatic behavior.

A second compatibility trap already exists: `resolvePtyClearDelay` falls back to an explicitly-set legacy `terminal.clearBeforePromptDelay` when the PTY key is unset. Simply deleting/unsetting the PTY value cannot select Auto while retaining the still-needed VS Code value.

### Setting Ownership

| Setting | Owner | Semantics |
|---|---|---|
| `terminal.clearBeforePrompt` | Both paths | Whether automatic `/clear` is allowed |
| `terminal.clearBeforePromptDelay` | VS Code terminals | Exact fixed post-clear wait, 0–10000ms |
| `terminal.ptyClearReadinessMode` | PTY fleet | Explicit `auto` or `manual`; absence means compatibility inference |
| `terminal.ptyClearBeforePromptDelay` | PTY fleet | Manual delay override, or unknown/custom fallback while Auto |

### PTY Compatibility Resolution

Runtime and UI must use one source-aware policy:

```ts
type PtyClearPolicy =
    | { mode: 'auto'; unknownDelayMs: number; source: 'mode-explicit' | 'default' }
    | { mode: 'manual'; delayMs: number; source: 'mode-explicit' | 'pty-explicit' | 'legacy-explicit' };
```

Resolution order:

1. Explicit mode `auto` → readiness profiles for known CLIs; PTY delay/default only for `unknown`.
2. Explicit mode `manual` → explicit PTY delay, else explicit legacy VS Code delay, else 600ms.
3. No explicit mode + explicit PTY delay → compatibility manual mode.
4. No explicit mode or PTY delay + explicit legacy VS Code delay → compatibility manual mode.
5. No explicit mode and no explicit delay → Auto; unknown/custom fallback 600ms.

This preserves explicit `0`, historical operator tuning, and the distinction between a contributed default and an actual user value. A user can explicitly select Auto without deleting the VS Code delay because the mode key overrides compatibility inference.

## Metadata

**Tags:** backend, frontend, ui, ux, reliability
**Complexity:** 5
**Project:** Browser Switchboard

> **Superseded:** `**Complexity:** 3` for adding one mirrored PTY delay slider.
> **Reason:** The UI now controls a compatibility-sensitive policy union, must distinguish explicit/default sources, can remove neither shipped delay key, and must stay synchronized with the readiness runtime on extension and standalone hosts.
> **Replaced with:** `**Complexity:** 5`.

## User Review Required

None. The operator explicitly confirmed that VS Code terminals still need a fixed delay because clear completion cannot be observed there, while PTY known-CLI profiles should use readiness detection unless manually overridden.

## Complexity Audit

### Routine

- Relabel the existing VS Code delay input.
- Add PTY Auto/Manual controls and helper text.
- Persist a new enum setting through the existing path-config seam.
- Extend the existing Terminal Context state push.

### Complex / Risky

- Explicit/default detection must use `inspect()` and preserve explicit zero.
- Auto selection must override an inherited legacy delay without deleting the VS Code value.
- Standalone lacks VS Code contributed defaults, so its `NaN`/presence checks must produce the same policy/source as the extension host.
- UI must not show “600ms active” when a known CLI detector owns timing.

## Edge-Case & Dependency Audit

### Race Conditions

- State response carries mode, delay, and source together so live config refresh cannot display a mode from one read and delay from another.
- A mode change and delay change should be persisted sequentially from one UI action; Manual must not become active before its clamped delay is stored.

### Security

- Mode is a fixed enum; reject unknown strings.
- Delay remains clamped 0–10000ms.
- No terminal command, prompt, or CLI family is accepted from this settings surface.

### Side Effects

- Existing users with an explicit PTY delay remain in compatibility Manual mode until they choose Auto.
- Existing users with only an explicit legacy VS Code delay remain compatibility Manual for PTY, preserving old intent.
- Fresh installs with neither explicit value use Auto for known PTY CLIs and 600ms only for unknown/custom PTY CLIs.
- VS Code terminal behavior is unchanged: its delay remains exact and independently tunable.

### Dependencies & Conflicts

- Depends on `.switchboard/plans/bracketed-paste-submit-cr-not-firing-on-devin-3000-5-20-under-load.md` for `PtyClearPolicy`, readiness profiles, and runtime consumption.
- This plan owns the Kanban settings control and state transport; the readiness plan owns PTY detection and prompt sequencing.
- The two plans should land together or runtime first. Shipping this UI first is safe only if Auto degrades to the existing fixed-delay path until the policy consumer exists.

## Dependencies

- `bracketed-paste-submit-cr-not-firing-on-devin-3000-5-20-under-load.md` — PTY clear policy and readiness runtime.

## Adversarial Synthesis

Key risk: a seemingly harmless PTY slider can override the detector and restore the clear race, while silently ignoring old explicit values destroys operator intent. The solution is an explicit policy mode with compatibility inference, separate VS Code ownership, and UI copy that reports whether timing is automatic, manually overridden, inherited from the legacy key, or using the unknown-CLI fallback.

## Proposed Changes

### 1. `package.json` — preserve delays and add PTY mode

Add:

```json
"switchboard.terminal.ptyClearReadinessMode": {
  "type": "string",
  "enum": ["auto", "manual"],
  "description": "Controls directly-owned PTY clear timing. Auto uses known-CLI readiness detection and the PTY delay only for unknown/custom CLIs. Manual always waits terminal.ptyClearBeforePromptDelay. If unset, existing explicit delay settings are preserved through compatibility inference."
}
```

Do not give the mode setting a contributed default that is treated as explicit. Resolver logic must use `inspect()`/presence.

Update descriptions:

- `terminal.clearBeforePromptDelay`: “Exact wait for VS Code terminal seats; PTY fleet uses readiness mode.”
- `terminal.ptyClearBeforePromptDelay`: “Manual PTY delay, or unknown/custom fallback in Auto mode. Known CLI profiles ignore it in Auto.”
- Boolean toggle: mention VS Code delay and PTY readiness/manual policy.

### 2. Shared source-aware resolver

**Files:**

- Runtime location selected by the readiness plan (shared helper preferred)
- `src/services/TaskViewerProvider.ts`
- `src/standalone/bootstrap.ts`

Replace number-only `resolvePtyClearDelay` / `resolveStandalonePtyClearDelay` with `PtyClearPolicy` resolution. Keep `explicitScopeValue`, `inspect()`, explicit-zero handling, and standalone `NaN` presence checks.

Do not delete the legacy fallback. It remains a compatibility source only when no explicit mode overrides it.

### 3. `src/services/KanbanProvider.ts` — state and handlers

Track:

- VS Code exact delay.
- PTY effective mode.
- PTY manual/fallback delay.
- PTY effective source.

Extend `clearTerminalBeforePromptState` with:

```ts
{
  enabled,
  delay,
  ptyMode,
  ptyDelay,
  ptySource
}
```

Add handlers:

- `updateClearTerminalBeforePromptPtyMode`
- `updateClearTerminalBeforePromptPtyDelay`

Mode handler validates `auto|manual` and persists `terminal.ptyClearReadinessMode`. Delay handler retains 0–10000 clamp and persists `terminal.ptyClearBeforePromptDelay`.

When switching to Manual from Auto, persist the clamped delay before or atomically with mode activation. When switching to Auto, preserve delay values; mode explicitly prevents them from disabling known-family detection.

### 4. `src/webview/kanban.html` — accurate Terminal Context controls

Replace the proposed unconditional two-slider structure with:

#### VS Code terminals

- Label: **“VS Code terminals — clear settle delay”**
- Existing 0–10000ms slider/input.
- Helper text: fixed wait required because terminal output readiness is not observable through the stable VS Code API.

#### PTY fleet / browser

- Radio/select segmented control:
  - **Automatic CLI readiness (recommended)**
  - **Manual delay override**
- Delay slider enabled only in Manual.
- Auto helper text:
  - Known Devin/Claude/Antigravity seats use tailored readiness profiles.
  - Unknown/custom CLIs use the displayed PTY fallback.
- Effective-source text when mode was inferred:
  - “Manual compatibility: explicit PTY value”
  - “Manual compatibility: inherited VS Code value”
  - “Automatic: no explicit override”

Both sections remain gated by the shared Clear-before-prompt boolean.

### 5. Protocol catalog and push contracts

Register:

- `updateClearTerminalBeforePromptPtyMode`
- `updateClearTerminalBeforePromptPtyDelay`
- State payload keys `ptyMode`, `ptyDelay`, `ptySource`

Do not add a second clear toggle.

### 6. Tests

Add source/policy/UI contracts for:

- VS Code exact delay remains independent.
- Explicit PTY `0` resolves Manual 0.
- Explicit PTY value with no mode resolves compatibility Manual.
- Explicit legacy value with no PTY/mode resolves compatibility Manual.
- Explicit Auto overrides stored explicit delay for known CLI profiles without deleting values.
- Explicit Manual uses PTY→legacy→600 fallback order.
- No explicit values resolves Auto; unknown delay is 600.
- UI disables manual slider in Auto.
- UI displays effective source.
- Mode enum rejects invalid values.
- State round-trip preserves mode/source/delay.

## Verification Plan

### Automated Tests

- New `PtyClearPolicy` resolver tests for all precedence combinations and explicit zero.
- Kanban Terminal Context message/state tests.
- Existing PTY route and config partition tests.
- Readiness-plan tests proving Auto known-family ignores fixed delay and Manual uses it.

### Goal Invariants

- `terminal.clearBeforePromptDelay` remains an exact VS Code-only wait.
- `terminal.ptyClearReadinessMode` supports only `auto|manual`.
- Explicit Auto can coexist with stored legacy/PTTY delays and still selects known-CLI detection.
- Explicit Manual selects fixed PTY delay.
- Unset mode preserves explicit PTY/legacy values through compatibility Manual.
- Fresh/default state selects Auto for known PTY CLIs.
- UI never labels 600ms as Devin’s active clear delay while Auto is selected.

### Manual Verification

1. Fresh config: UI shows PTY Auto; Devin dispatch uses readiness curtain/detector; VS Code slider remains 2000ms exact.
2. Select PTY Manual 900ms: reload; mode and value persist; PTY uses exact 900ms.
3. Select Auto again: stored 900 remains but known Devin uses detector; unknown CLI uses configured fallback as documented.
4. Existing explicit legacy VS Code delay with no PTY/mode: UI reports inherited Manual compatibility; VS Code behavior unchanged.
5. Explicit zero: Manual mode sends with no additional PTY settle, proving falsy values survive.
6. Change VS Code delay: PTY Auto remains Auto and does not inherit the new value once explicit mode is set.

## Recommendation

Send to Coder after—or together with—the Lead Coder readiness/curtain plan.

## Implementation Summary

Implemented source-aware PTY clear readiness policy and updated the Kanban setup UI. Added `switchboard.terminal.ptyClearReadinessMode` enum to `package.json` and unified resolution logic in `src/services/ptyClearPolicy.ts` for both extension and standalone hosts. Updated `KanbanProvider.ts` to push effective mode, delay, and compatibility source, and handle `updateClearTerminalBeforePromptPtyMode` and `updateClearTerminalBeforePromptPtyDelay`. Configured `kanban.html` with distinct VS Code settle delay and PTY Auto/Manual segmented controls with source status indicators. Regenerated the protocol catalog and allowlist, and added contract test coverage.


## Review Findings

Reviewed and fixed. **Files changed:** `src/services/ptyClearPolicy.ts`, `src/services/KanbanProvider.ts`, `package.json`, `.github/workflows/integration-tests.yml`, `src/test/pty-clear-policy-contract.test.js`. Two defects: `KanbanProvider._getPtyClearPolicy()` called the extension-host resolver unconditionally, but the standalone `vscode` shim's `inspect()` returns all layers undefined by design — so the browser cockpit's Terminal Context panel reported `{auto, 600, source:'default'}` to every headless operator regardless of their actual config, and writing from that panel would then overwrite a real Manual setting (now host-split on the contributed-default discriminator, falling through to `resolveStandalonePtyClearPolicy` over the shim's own config.json reads, the same source bootstrap's runtime resolution uses); and `pty-clear-policy-contract.test.js` hand-reimplemented both resolvers inline and asserted against the copy, so it could never detect drift in the real file (now requires `out/services/ptyClearPolicy.js`). Also collapsed the duplicated precedence ladder into one `resolvePtyClearPolicyFromExplicit`, so the two host entry points cannot diverge. **Validation:** `test:contract:pty-clear-policy` green against the real module and now invoked by CI (it was defined in `package.json` and called by no workflow step — the exact green-while-incomplete hole); `catalog:check`, `parity:check`, `compile`, `lint` clean. **Remaining risk:** none material; the kanban.html controls were verified by source contract only, not by CDP against a live panel.
