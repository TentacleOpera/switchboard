# Read Verbs Return a Bare Ack and Ship Their Value Only on the Webview Push — the Opposite of the Documented Contract

## Metadata

**Complexity:** 4
**Tags:** local-api, verb-contract, setup-panel, both-hosts

## Goal

Make read verbs return their value in the HTTP response body, as `reference/local-api-server.md` promises, instead of computing the value, pushing it to the webview, and returning `{success: true}` with the value discarded.

### Problem analysis and root cause

`reference/local-api-server.md:171` states the contract in terms that leave no ambiguity:

> **Contract:** verbs return their result in the HTTP response body as `{ "success": true, ...data }` — read verbs are directly readable, **no WebSocket subscription needed**. (The webview still receives its live-update push; that's additive.)

The code has this exactly inverted for a whole family of read verbs: **the push is the only carrier, and the return is the bare ack.**

**Root cause, verified against the tree.** The pattern in `src/services/SetupPanelProvider.ts` is mechanical and repeated:

```ts
case 'getAccurateCodingSetting':
    this.postMessage({ type: 'accurateCodingSetting',
                       enabled: this._taskViewerProvider.handleGetAccurateCodingSetting() });
    return { success: true };                      // ← value computed, pushed, then dropped
```

The value is resolved, handed to `postMessage`, and then **not** included in the return. Confirmed instances (`SetupPanelProvider.ts`): `getAccurateCodingSetting:712`, `getAdvancedReviewerSetting:718`, `getLeadChallengeSetting:724`, `getAutoCommitOnCodeReviewSetting:732`, `getExcludeReviewedBacklogSetting:740`, `getPersistPanelsSetting:746`, `getStatusShowTerminalsSetting:777`, `getStatusShowKanbanSetting:787`, `getStatusShowArtifactsSetting:797`, `getStatusShowDesignSetting:807`, `getStatusShowProjectSetting:817`, `getStatusShowMemoSetting:827`, `getThemeSetting:852`, `getCyberAnimationDisabledSetting:857`, `getCyberScanlinesDisabledSetting:868`, `getColourKanbanIconsSetting:879`, `getUltracodeAnimationSetting:894`, `getDesignSystemDocSetting:906`; plus `getFeatureWorktreeMode` at `src/services/KanbanProvider.ts:11239`.

`getKanbanStructure` (`KanbanProvider.ts:10731-10740`) shows the **correct** shape for comparison — it pushes *and* returns `{ success: true, structure, customColumns }`. The fix is to make the listed verbs look like that one.

**Who this breaks.** Not the webview — it subscribes to the push and gets the value. It breaks precisely the audience the doc is written for: an agent or external tool calling `POST /setup/verb/getThemeSetting` over HTTP. That caller receives `{"success":true}`, has no WebSocket subscription, and cannot read the setting at all. The documented promise of "directly readable, no WebSocket subscription needed" is false for every verb listed above.

**Why it looked fine.** `{"success":true}` is a success response. Any check asking "does the verb work?" gets a yes. Reading the *body* is the only thing that surfaces it — which is why the doc-parity audit that ran on catalog membership found this only where it happened to inspect a response, and then misfiled it as a standalone parity gap. It is neither standalone-specific nor a parity issue: it is a shared contract violation in shared code, present in both hosts.

## User Review Required

None.

## Complexity Audit

### Routine

- Adding the resolved value to an existing return statement.

### Complex / Risky

- **The push must stay.** The doc calls the push "additive" and the webview depends on it. This is a purely **additive** change to the return value — removing or altering `postMessage` would break every panel listening for `accurateCodingSetting`, `switchboardThemeNameSetting` and siblings.
- **Field naming has to match the push, not be invented.** Each verb's push already names its field (`enabled`, `theme`, …). The return must use the same name, or a consumer reading the doc and a consumer reading the push disagree — which is a second contract, not a fix.
- **The list is a floor, not a ceiling.** The ~19 sites above were found by inspection of two files. The same pattern very likely exists in the other panel providers. Sweep for it rather than fixing only the enumerated set, or this recurs the moment a new getter is written by copying its neighbour.
- **A guard is the durable deliverable.** Without a check, the next `case 'getXSetting'` written by copy-paste reintroduces this on day one.

## Edge-Case & Dependency Audit

**Race Conditions** — none. The value is already resolved synchronously (or awaited) before `postMessage`; returning it introduces no new ordering.

**Security** — do not widen any verb that resolves a credential, token or secret into a returnable value. Setting getters in this family return booleans, theme names and enum modes; confirm per verb before including it in the return, and exclude anything secret-bearing explicitly.

**Side Effects** — none. Additive response fields; existing consumers that ignore unknown fields are unaffected.

**Dependencies & Conflicts** — this is the correct home for the register's `GAP-8` (rows `REF-042`, `REF-057`, `REF-062`, `BRD-038`, `BRD-047`). Those rows framed it as a standalone parity gap; it is not, and the fix belongs in shared code.

## Dependencies

None.

## Implementation

1. Sweep all panel providers for the `postMessage({...value}); return { success: true };` shape in a `get*` arm. The list above is the confirmed starting set, not the full set.
2. For each, add the resolved value to the return using the **same field name** the push uses. Keep the push unchanged.
3. Exclude any verb whose value is secret-bearing, and state the exclusion inline so it reads as a decision rather than an oversight.
4. Use `getKanbanStructure` (`KanbanProvider.ts:10731-10740`) as the reference shape.
5. Add a guard that fails when a `get*` verb arm pushes a value and returns a bare `{success: true}` — this is what stops the pattern being recreated by copy-paste.

## Proposed Changes

### `src/services/SetupPanelProvider.ts`
- **Context:** ~18 `get*Setting` arms push their value and return a bare ack.
- **Logic:** Include the resolved value in the return, field-named as the push names it.
- **Edge Cases:** Push must remain; field names must match; secret-bearing verbs excluded explicitly.

### `src/services/KanbanProvider.ts`
- **Context:** `getFeatureWorktreeMode:11239` follows the same shape.
- **Logic:** Same fix.

### Verb-contract guard (new)
- **Logic:** Fail when a read verb pushes a value but returns a bare ack.
- **Edge Cases:** Deliberate exclusions need an explicit, reasoned allowlist entry.

## Verification Plan

1. `POST /setup/verb/getThemeSetting` over HTTP, with no WebSocket connection open, returns the theme name in the body.
2. The same holds for every verb in the confirmed list, each using the field name its push uses.
3. Panels still receive their pushes and render unchanged — the webview path is untouched.
4. No verb returning a credential, token or secret was widened; exclusions are listed with reasons.
5. The new guard fails when a `get*` arm is reverted to a bare ack, and passes with the fixes in place.
6. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline (5 `TS2835` errors at HEAD, unrelated).

## Recommendation

Complexity 4 → **Send to Coder.** Each individual edit is trivial; the value is in sweeping past the enumerated list and in the guard that keeps the pattern from returning.
