# Read Verbs Return a Bare Ack and Ship Their Value Only on the Webview Push — the Opposite of the Documented Contract

## Metadata

**Complexity:** 4
**Tags:** local-api, verb-contract, setup-panel, both-hosts, ci-guard
**Project:** Browser Switchboard

## Goal

Make read verbs return their value in the HTTP response body, as `reference/local-api-server.md` and PRD contract #4 both require, instead of computing the value, pushing it to the webview, and returning `{success: true}` with the value discarded — and add the missing dimension to the existing return-contract ratchet, which currently rates the worst-affected provider as perfectly migrated.

### Problem analysis and root cause

`reference/local-api-server.md:171` states the contract in terms that leave no ambiguity:

> **Contract:** verbs return their result in the HTTP response body as `{ "success": true, ...data }` — read verbs are directly readable, **no WebSocket subscription needed**. (The webview still receives its live-update push; that's additive.)

The project PRD restates it as standing engineering contract #4. The code has it exactly inverted for a whole family of read verbs: **the push is the only carrier, and the return is the bare ack.**

**Root cause, verified against the tree at HEAD.** The pattern in `src/services/SetupPanelProvider.ts` is mechanical and repeated:

```ts
case 'getAccurateCodingSetting':
    this.postMessage({ type: 'accurateCodingSetting',
                       enabled: this._taskViewerProvider.handleGetAccurateCodingSetting() });
    return { success: true };                      // ← value computed, pushed, then dropped
```

The value is resolved, handed to `postMessage`, and then **not** included in the return. Confirmed instances in `SetupPanelProvider.ts` (line numbers current): `getAccurateCodingSetting:712`, `getAdvancedReviewerSetting:718`, `getLeadChallengeSetting:724`, `getAutoCommitOnCodeReviewSetting:732`, `getExcludeReviewedBacklogSetting:740`, `getPersistPanelsSetting:746`, `getStatusShowTerminalsSetting:777`, `getStatusShowKanbanSetting:787`, `getStatusShowArtifactsSetting:797`, `getStatusShowDesignSetting:807`, `getStatusShowProjectSetting:817`, `getStatusShowMemoSetting:827`, `getThemeSetting:852`, `getCyberAnimationDisabledSetting:857`, `getCyberScanlinesDisabledSetting:868`, `getColourKanbanIconsSetting:879`, `getUltracodeAnimationSetting:894`, `getDesignSystemDocSetting:906`.

`getKanbanStructure` (`KanbanProvider.ts:11294-11306`) shows the **correct** shape for comparison — it pushes *and* returns `{ success: true, structure, customColumns, collapseCoders }`, with an inline comment explaining that an HTTP reader needs the data in the body. The fix is to make the listed verbs look like that one.

**One instance is a harder sub-case than the rest, and it is the one the guard must be built to catch.** `getFeatureWorktreeMode` (`KanbanProvider.ts:11852-11857`) does not push inline at all:

```ts
case 'getFeatureWorktreeMode': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) return { success: false, error: 'No workspace root resolved' };
    await this._sendWorktreeConfig(workspaceRoot);
    return { success: true };
}
```

The value never exists inside the arm — it is resolved and pushed entirely inside `_sendWorktreeConfig`. "Add the value to the return" is not available here; the helper has to return what it sent, and then the arm returns that. Any guard that looks for a literal `postMessage(...)` next to a bare ack finds the eighteen easy cases and misses this one — and this shape (`_send*` / `_post*` helper + bare ack) is the one most likely to recur, because it looks tidier than the arms that do have the bug visibly.

**The existing ratchet cannot see any of this, and says so in the loudest possible way.** `scripts/check-verb-return-contract.js` enforces per-provider ceilings on `break` statements inside `_handleMessage`, baselined in `scripts/verb-return-contract-baseline.json`. That file currently reads:

```json
{ "Kanban": 1, "Planning": 152, "Tickets": 55, "Design": 9, "TaskViewer": 1, "Setup": 0 }
```

**`Setup` is at 0.** By the PRD's own machine-checked definition of done — the ratchet is green, the ceiling is at its floor, CI passes — `SetupPanelProvider` is fully migrated. It is also the provider hosting all eighteen confirmed violations of contract #4. The gate measures `break` versus `return` and is blind to *what* is returned, so `return { success: true }` scores identically to `return { success: true, ...data }`. This is not an argument that the ratchet is wrong; it measures what it was built to measure. It is the argument for a second dimension in the same gate, and the strongest available evidence that "the ratchet is green" has been standing in for "the contract is honoured".

**Who this breaks.** Not the webview — it subscribes to the push and gets the value. It breaks precisely the audience the doc is written for: an agent or external tool calling `POST /setup/verb/getThemeSetting` over HTTP. That caller receives `{"success":true}`, has no WebSocket subscription, and cannot read the setting at all. The documented promise of "directly readable, no WebSocket subscription needed" is false for every verb listed above.

**Why it looked fine.** `{"success":true}` is a success response. Any check asking "does the verb work?" gets a yes; so does the ratchet. Reading the *body* is the only thing that surfaces it — which is why the doc-parity audit that ran on catalog membership found this only where it happened to inspect a response, and then misfiled it as a standalone parity gap. It is neither standalone-specific nor a parity issue: it is a shared contract violation in shared code, present in both hosts.

## User Review Required

None. Decisions taken:

- **`set*` arms that already push their resulting value are in scope.** `setPlanScannerConfig:705`, `setPersistPanelsSetting`, `setCyberAnimationDisabledSetting`, `setColourKanbanIconsSetting` and their siblings compute or receive the new state, push it, and return a bare ack. An HTTP caller that has just written a setting and wants to confirm the resulting state has the same problem as a reader, and the fix is the same one line. They are included; arms that push nothing stay as they are.
- **The guard extends the existing ratchet rather than becoming a new script.** A ninth CI script measuring an adjacent property of the same switch blocks is how two gates end up disagreeing about which arms exist.

## Complexity Audit

### Routine

- Adding the resolved value to an existing return statement, eighteen times.

### Complex / Risky

- **The push must stay.** The doc calls the push "additive" and the webview depends on it. This is a purely **additive** change to the return value — removing or altering `postMessage` would break every panel listening for `accurateCodingSetting`, `switchboardThemeNameSetting` and siblings.
- **Field naming has to match the push, not be invented.** Each verb's push already names its field (`enabled`, `theme`, `link`, …). The return must use the same name, or a consumer reading the doc and a consumer reading the push disagree — which is a second contract, not a fix.
- **The push-only-helper case needs a real signature change.** `_sendWorktreeConfig` must return its payload for `getFeatureWorktreeMode` to return anything. Check whether other `_send*`/`_post*` helpers are used the same way before deciding this is a one-off.
- **The list is a floor, not a ceiling.** The instances above were found by inspection of two files. The same pattern very likely exists in the other panel providers — note `Planning: 152` and `Tickets: 55` on the break ratchet, which is a different defect but marks those providers as the least-migrated and therefore the likeliest to hold more of this one.
- **The ratchet dimension is the durable deliverable.** Without it, the next `case 'getXSetting'` written by copy-paste reintroduces this on day one, and CI stays green while it happens — exactly as it does today.
- **Adding the dimension will not start green.** The existing ratchet's baselines were captured from true current counts so CI was green from the first commit; the new dimension must be baselined the same way, then lowered as arms are converted. Forcing it to zero on introduction reds CI on providers this plan is not converting.

## Edge-Case & Dependency Audit

**Race Conditions** — none. The value is already resolved synchronously (or awaited) before `postMessage`; returning it introduces no new ordering.

**Security** — do not widen any verb that resolves a credential, token or secret into a returnable value. The verbs in this family return booleans, theme names, a doc link and enum modes; confirm per verb before including it in the return, and exclude anything secret-bearing explicitly. Note that the standalone host constructs `LocalApiServer` with `allowSecretWritesOverHttp: true`, so "the HTTP surface is trusted" is not an available argument for skipping that check.

**Side Effects** — none. Additive response fields; existing consumers that ignore unknown fields are unaffected.

**Dependencies & Conflicts**

- This is the correct home for the register's `GAP-8` (rows `REF-042`, `REF-057`, `REF-062`, `BRD-038`, `BRD-047`). Those rows framed it as a standalone parity gap; it is not, and the fix belongs in shared code.
- **This plan owns the read-verb enumeration for the whole feature.** `standalone-code-verification-sweep-stubs-and-omissions.md` lists the same sweep as its third defect shape. It does not re-derive it: this plan produces the machine-checked version and the sweep consumes it. That makes this plan a prerequisite of the sweep.

## Dependencies

None inbound. Outbound: the sweep subtask consumes this plan's ratchet dimension rather than hand-sweeping `get*` arms.

## Implementation

1. For each confirmed arm in `SetupPanelProvider.ts`, add the resolved value to the return using the **same field name** the push uses. Keep the push unchanged. Use `getKanbanStructure` (`KanbanProvider.ts:11294-11306`) as the reference shape.
2. Fix `getFeatureWorktreeMode` (`KanbanProvider.ts:11852-11857`) by making `_sendWorktreeConfig` return the config it pushes, and returning that from the arm. Check the other `_send*`/`_post*` helpers for the same usage before treating it as isolated.
3. Extend the scope to `set*` arms that already push a resulting value, per the decision above.
4. Exclude any verb whose value is secret-bearing, and state the exclusion inline so it reads as a decision rather than an oversight.
5. **Add a second measured dimension to `scripts/check-verb-return-contract.js`**: per provider, the count of `_handleMessage` arms that return a bare `{ success: true }` (no data fields) while either calling `postMessage` inline or delegating to a `_send*`/`_post*` helper. Store it alongside the break count in `scripts/verb-return-contract-baseline.json`, ratcheting **down only**, with the same `--write` maintainer path and the same refusal to raise a ceiling.
6. Baseline the new dimension from true current counts, then lower `Setup` and `Kanban` in the same change to lock in this plan's conversions — the ratchet discipline the PRD requires.

## Proposed Changes

### `src/services/SetupPanelProvider.ts`
- **Context:** Eighteen `get*Setting` arms push their value and return a bare ack; several `set*` arms do the same with the value they just wrote.
- **Logic:** Include the resolved value in the return, field-named as the push names it.
- **Edge Cases:** Push must remain; field names must match; secret-bearing verbs excluded explicitly.

### `src/services/KanbanProvider.ts`
- **Context:** `getFeatureWorktreeMode:11852-11857` pushes via a helper and returns a bare ack — the value does not exist in the arm.
- **Logic:** `_sendWorktreeConfig` returns its payload; the arm returns it.
- **Edge Cases:** Other callers of `_sendWorktreeConfig` must be unaffected by the added return value.

### `scripts/check-verb-return-contract.js` + `scripts/verb-return-contract-baseline.json`
- **Context:** Measures `break` counts only. `Setup: 0` — green, at floor, and hosting every violation this plan fixes.
- **Logic:** Second ratcheted dimension: bare-ack-with-push arm count per provider.
- **Edge Cases:** Must catch the helper-delegation shape, not just inline `postMessage`; must be baselined from current counts rather than forced to zero; deliberate exclusions need an explicit, reasoned allowlist entry.

## Verification Plan

*Per session directive, no compilation or automated-test execution is part of this plan's verification; the ratchet is CI-gated on merge (`.github/workflows/integration-tests.yml` already runs `verb-returns:check`).*

1. `POST /setup/verb/getThemeSetting` over HTTP, with no WebSocket connection open, returns the theme name in the body.
2. The same holds for every verb in the confirmed list, each using the field name its push uses.
3. `POST /kanban/verb/getFeatureWorktreeMode` returns the mode in the body, and every other caller of `_sendWorktreeConfig` still behaves as before.
4. Panels still receive their pushes and render unchanged — the webview path is untouched.
5. No verb returning a credential, token or secret was widened; exclusions are listed with reasons.
6. The new ratchet dimension counts zero bare-ack arms for `Setup` after the change, and its baseline entry reflects that rather than the pre-change number.
7. Reverting any one converted arm to a bare ack raises the new dimension above its ceiling.
8. A newly written `get*` arm that pushes via a helper and returns a bare ack is caught, not just one that pushes inline.

## Recommendation

Complexity 4 → **Send to Coder.** Each individual edit is trivial. The value is in the helper-delegation case, in sweeping past the enumerated list, and above all in the ratchet dimension — because the provider hosting all eighteen violations is currently scored as perfectly migrated by the gate that is supposed to catch them.
