# Remove the Inaccurate "Design-Doc Fetching" Toggle from the Setup Notion Tab

## Goal
Remove the mislabeled `#notion-option-enable-design-doc` checkbox from the Setup → Notion tab and sever the Notion apply flow's accidental write to `switchboard.planner.designDocEnabled`, so saving a Notion token can no longer silently flip the planner's design-doc setting. The Planning tab remains the sole owner of that config.

## Metadata
**Tags:** frontend, backend, UI, bugfix, reliability, testing
**Complexity:** 4

## User Review Required
Two points need a human decision before coding:

1. **Rationale correction (must read).** The original plan stated the design-doc setting is "really about the epics feature in `project.html`, which has no Notion integration." This is **inaccurate**: `TaskViewerProvider._getDesignDocContent` (lines 14757–14772) explicitly fetches **Notion** content when `planner.designDocLink` points at a `notion.so` / `notion.site` URL. So `planner.designDocEnabled` *is* connected to Notion-backed design-doc fetching for the planner prompt.
   - **The fix is still correct**, but for a different reason than originally stated: the bug is **duplicate ownership + a silent side-effect write**, not "wrong feature." The Planning tab's `#design-doc-toggle` is the canonical, explicit owner of `planner.designDocEnabled`. The Notion tab additionally wrote the same config from a checkbox on every "APPLY NOTION SETTINGS" click — so a user who only wanted to save a token would silently overwrite their planner design-doc preference. Removing the Notion-tab write eliminates the duplicate/silent control while leaving the explicit Planning-tab control intact.
   - **Confirm:** you accept removing the Notion tab's quick toggle for `planner.designDocEnabled`, knowing the same on/off control still exists (canonically) in the Planning tab.

2. **Descriptive copy left in place.** The Notion tab still carries prose describing design-doc fetching at `setup.html:948–949` ("Configure Notion integration for design document fetching.") and `957–958` ("Fetch design documents from Notion pages for planner prompts."). Given point #1, this copy is actually **accurate** for Notion's retained doc-source role (the token + `designDocUrl` plumbing in `notionService` stays). The plan leaves it untouched. Confirm you do **not** want a copy rewrite in this change.

## Complexity Audit

### Routine
- Deleting the checkbox `<label>` block and the summary `<div>` in `setup.html`.
- Deleting `collectNotionApplyOptions()` and `renderNotionOptionSummary()` and simplifying `renderNotionSetupState()`.
- Dropping the `options` field from the `applyNotionConfig` postMessage.
- Trimming two `designDocEnabled` / `designDocLink` field assignments in `NotionSetupState` construction.
- Changing `handleApplyNotionConfig` signature and dropping the `options.enableDesignDocFetching` argument in `SetupPanelProvider`.
- Test edits: removing two positive existence assertions, adding two negative absence assertions, and trimming the `NotionSetupState` regex.

### Complex / Risky
- **None.** All edits are localized deletions/trims that reuse existing patterns. The one behavioral change (Notion apply no longer writes `planner.designDocEnabled`) is the intended fix, scoped to a single method.

## Edge-Case & Dependency Audit

- **Race Conditions:** None introduced. The change *removes* a write to shared config (`planner.designDocEnabled`); it does not add concurrent access. If anything, it eliminates a write-write race between the Notion apply flow and the Planning-tab toggle when both fire close together.
- **Security:** None. No change to token storage, validation, or secret handling — `handleApplyNotionConfig` keeps its existing store/validate/rollback logic (lines 4847–4867) verbatim; only the trailing config write is removed.
- **Side Effects:**
  - *Intended:* "APPLY NOTION SETTINGS" no longer mutates `planner.designDocEnabled`. Users who relied on the Notion checkbox as a shortcut to toggle planner design-doc fetching must now use the Planning tab.
  - *Unintended risk:* a dangling reference to the removed checkbox id, `collectNotionApplyOptions`, or `renderNotionOptionSummary` would throw at webview runtime. Mitigated by the grep verification step (zero hits in `src/`).
  - *Lint/type risk:* the `designDocSetting` local in `getIntegrationSetupStates` (line 3963) is used **only** at lines 3982–83 and 4006–07; removing both consumers makes it an unused variable. It **must** be deleted. (The identically-named locals at 3811 and 3930 are in *other* methods that still post a `designDocSetting` message — leave those alone.)
- **Dependencies & Conflicts:**
  - `planner.designDocEnabled` remains referenced in `TaskViewerProvider.ts` at lines 7124 (Planning-tab `saveStartupCommands` write), 14740, and 14759 (`_isDesignDocEnabled` / `_getDesignDocContent` reads). Therefore the regex assertion in `prompts-tab-move-regression.test.js:371` (`/planner\.designDocEnabled/`) **stays green** — confirmed.
  - `cloneNotionSetupState` (`setup.html:2331`) is a generic `JSON.parse(JSON.stringify(...))` deep-clone with no field-specific logic; it needs **no** change when `NotionSetupState` shrinks.
  - **MR-merge hazard:** this change deletes fields from `NotionSetupState` and changes a public method signature. If another branch touches `handleApplyNotionConfig`, `NotionSetupState`, or the Notion hydration path, a careless merge could resurrect the removed `options` param or `designDocEnabled` field. Re-grep after any merge.

## Dependencies
- `sess_XXXXXXXXXXXXX — none` (no prior session work this plan depends on; standalone cleanup).

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) the original plan's rationale ("epics feature, no Notion integration") is factually wrong — `planner.designDocEnabled` *does* drive Notion design-doc fetching for the planner prompt, so the change must be justified as removing a duplicate/silent-write control, not a wrong-feature control; (2) an unused `designDocSetting` local at line 3963 will break lint/compile if not deleted; (3) dangling webview references to the removed checkbox/functions would throw at runtime. Mitigations: correct the rationale (done above), delete line 3963, and grep `src/` for zero residual references plus a user-run TypeScript compile and the two Jest tests.

## Problem & Why

The Notion tab in `setup.html` exposes a checkbox labeled *"Use the existing planner design-doc setting for Notion-backed design document fetching"* (`#notion-option-enable-design-doc`). The label is misleading and the control is redundant: `switchboard.planner.designDocEnabled` is **canonically owned by the Planning tab** (`#design-doc-toggle` → `case 'designDocSetting'`). The Notion tab duplicating that toggle is the root problem.

> **Clarification (corrected rationale — see User Review Required #1):** Earlier wording claimed the design-doc setting "has no Notion integration." That is wrong. `TaskViewerProvider._getDesignDocContent` (14757–14772) loads cached **Notion** content when `planner.designDocLink` is a Notion URL. The setting *is* Notion-related. The justification for removal is the silent-write bug and duplicate ownership below — not a missing integration.

Beyond duplication, this checkbox is a **latent bug**. `handleApplyNotionConfig` unconditionally writes the global `switchboard.planner.designDocEnabled` config from the checkbox value on every "APPLY NOTION SETTINGS" click (lines 4878–4882). So a user who has the design-doc feature enabled via the Planning tab, and then visits the Notion tab only to save a token, **silently disables that feature** if the box is unchecked. Removing the Notion tab's write to `planner.designDocEnabled` fixes this.

`planner.designDocEnabled` legitimately remains owned by the **Planning tab** (`#design-doc-toggle` → `case 'designDocSetting'`) and consumed by `_isDesignDocEnabled` / `_getDesignDocContent` / the planner prompt writer. None of that changes — we only sever the Notion tab's accidental control over it.

## Scope

Full cleanup (per user): remove the checkbox, the backend config write, and all now-orphaned `designDocEnabled` / `designDocLink` plumbing that existed in the Notion code paths. Notion's apply flow should validate/store the token and mark setup complete only.

## Proposed Changes

### `src/webview/setup.html`
- **Context:** Owns the Notion tab UI, the `applyNotionConfig` postMessage, and the `designDocSetting` / `setupPanelState` hydration handlers. The checkbox, its `collectNotionApplyOptions()` reader, and the `notion-option-summary` block are the only places the removed control is surfaced.
- **Logic:** Delete the checkbox + summary UI, delete the two helper functions that read/render them, stop sending `options` in the apply message, and stop injecting `designDocEnabled`/`designDocLink` into `lastNotionSetupState` from the `designDocSetting` handler.
- **Implementation:**
  - **Remove the checkbox block** (lines 967–970): the `<label class="startup-row">` wrapping `#notion-option-enable-design-doc` and its `<span>`.
  - **Delete `collectNotionApplyOptions()`** (2402–2406) — there are no Notion apply options left.
  - **Apply-button handler** (3282–3286): drop the `options: collectNotionApplyOptions()` field from the `applyNotionConfig` postMessage. Send `{ type: 'applyNotionConfig', token }`.
  - **Remove the summary entirely** (per user — the `#notion-setup-status` configured-status marker at the top of the tab already covers this):
    - Delete the `#notion-option-summary` div (line 972).
    - Delete the `renderNotionOptionSummary(state)` function (2484–2499). This also removes the only remaining `setCheckboxState('notion-option-enable-design-doc', ...)` reference (line 2488).
    - Simplify `renderNotionSetupState()` (2882–2885) to just `setApplyButtonBusy('notion', false);` (drop the `renderNotionOptionSummary(lastNotionSetupState);` call at 2883).
  - **`case 'designDocSetting'` handler** (4218–4236): **keep** the Planning-tab `#design-doc-toggle` / `#design-doc-status-line` updates (4220–4228); **remove** the block that injects `designDocEnabled` / `designDocLink` into `lastNotionSetupState` (4229–4233) and the trailing `renderNotionSetupState()` call (4234) that existed only for that.
  - **`case 'setupPanelState'` notion hydration** (4348–4355): keep its `renderNotionSetupState()` call (now just resets the apply button); confirm it still works once the state shape shrinks (see TaskViewerProvider change). `cloneNotionSetupState` (2331) is a generic deep-clone and needs no edit.
- **Edge Cases:** After deletions, grep for `notion-option-enable-design-doc`, `collectNotionApplyOptions`, and `renderNotionOptionSummary` — all must return zero hits in `src/`. Confirm `renderNotionSetupState` still has its single remaining caller paths (`setupPanelState` hydration) and does not reference deleted state.

### `src/services/TaskViewerProvider.ts`
- **Context:** Defines `NotionSetupState`, builds `notionState` in `getIntegrationSetupStates`, and owns `handleApplyNotionConfig`. The provider is also asserted against by both regression tests.
- **Logic:** Trim the two design-doc fields from the type and its two construction sites, delete the now-unused `designDocSetting` local, and remove the `options` param + the `planner.designDocEnabled` write from `handleApplyNotionConfig`.
- **Implementation:**
  - **`NotionSetupState` type** (208–212): remove `designDocEnabled` and `designDocLink`; keep `setupComplete`.
  - **notionState construction** — `getIntegrationSetupStates` early-return branch (3980–3984) and main branch (4004–4008): remove the `designDocEnabled` / `designDocLink` fields. **Then delete the now-unused `const designDocSetting = this.handleGetDesignDocSetting();` at line 3963** (its only consumers were those two field assignments). Leave the identically-named locals at 3811 and 3930 untouched — they live in other methods and still feed `designDocSetting` postMessages.
  - **`handleApplyNotionConfig`** (4838–4884): change signature to `handleApplyNotionConfig(token: string)` — remove the `options: { enableDesignDocFetching: boolean }` param (4840) and **delete the `planner.designDocEnabled` update** (4878–4882). The method should store/validate the token (4847–4867), `saveConfig({ ..., setupComplete: true })` (4869–4877), and `return { success: true }` only.
- **Edge Cases:** `planner.designDocEnabled` must still appear elsewhere in this file (it does — 7124, 14740, 14759) so the regression test stays green. Verify no other caller passes `options` to `handleApplyNotionConfig`.

### `src/services/SetupPanelProvider.ts`
- **Context:** Routes the `applyNotionConfig` webview message to the provider.
- **Logic:** Match the new single-arg signature.
- **Implementation:** **`case 'applyNotionConfig'`** (423–432): drop the `message.options ?? {}` argument; call `handleApplyNotionConfig(message.token)`.
- **Edge Cases:** Leave the surrounding `notionApplyResult` post, `postSetupPanelState()`, and `refreshUI` calls (428–430) unchanged.

### `src/test/setup-panel-migration.test.js`
- **Context:** Asserts the setup panel owns the integration checkboxes and exposes typed hydration state.
- **Logic:** Flip the checkbox/summary from "must exist" to "must be absent" and trim the `NotionSetupState` regex.
- **Implementation:**
  - Line 71: remove the `setupSource.includes('id="notion-option-enable-design-doc"')` assertion from the positive existence `assert.ok(...)` block.
  - Line 73: remove the `setupSource.includes('id="notion-option-summary"')` assertion from the same block.
  - **Add negative assertions** (per user) that `id="notion-option-enable-design-doc"` and `id="notion-option-summary"` are **absent** from `setupSource`, matching the style of the existing removed-element block (the `OPERATION MODE` block at lines 79–84).
  - Lines 126–130: update the `NotionSetupState` regex to match the trimmed type — `/type NotionSetupState = \{[\s\S]*setupComplete: boolean;/m` — dropping `designDocEnabled` / `designDocLink`.
- **Edge Cases:** Ensure removing lines 71/73 does not leave a dangling `&&` / break the boolean chain in the `assert.ok`.

### `src/test/prompts-tab-move-regression.test.js`
- **Context:** Asserts `planner.designDocEnabled` and `planner.designDocLink` config keys still exist in the provider source (371–372, 374–377).
- **Logic:** No change.
- **Implementation:** **No change needed** — those config keys are retained via the Planning-tab path and the planner-prompt reads. Re-run to confirm they stay green.
- **Edge Cases:** None.

## Affected Files & Edits (original itemized list — preserved)

### 1. `src/webview/setup.html`
- **Remove the checkbox block** (lines ~967–970): the `<label>` wrapping `#notion-option-enable-design-doc` and its `<span>`.
- **`collectNotionApplyOptions()`** (~2402–2406): delete this function — there are no Notion apply options left.
- **Apply-button handler** (~3282–3286): drop the `options: collectNotionApplyOptions()` field from the `applyNotionConfig` postMessage. Send `{ type: 'applyNotionConfig', token }`.
- **Remove the summary entirely** (per user — the configured-status marker at the top of the tab, `#notion-setup-status`, already covers this):
  - Delete the `#notion-option-summary` div (line ~972).
  - Delete the `renderNotionOptionSummary(state)` function (~2484–2499).
  - Simplify `renderNotionSetupState()` (~2882–2885) to just `setApplyButtonBusy('notion', false);` (drop the `renderNotionOptionSummary` call).
- **`case 'designDocSetting'` handler** (~4218–4236): keep the Planning-tab `#design-doc-toggle` / `#design-doc-status-line` updates; **remove** the block that injects `designDocEnabled` / `designDocLink` into `lastNotionSetupState` (~4229–4234) and the trailing `renderNotionSetupState()` call that existed only for that.
- `case 'setupPanelState'` notion hydration (~4351–4354) keeps its `renderNotionSetupState()` call (now just resets the apply button); confirm it still works once the state shape shrinks (see #2).

### 2. `src/services/TaskViewerProvider.ts`
- **`NotionSetupState` type** (208–212): remove `designDocEnabled` and `designDocLink`; keep `setupComplete`.
- **notionState construction** (~3980–3984 and ~4004–4008): remove the `designDocEnabled` / `designDocLink` fields. Verify the local `designDocSetting` variable is still used afterward (it feeds the separate `designDocSetting` message for the Planning tab); if it becomes unused in a given block, drop its computation to avoid an unused-variable lint error. **(Confirmed: the local at line 3963 becomes unused and must be deleted.)**
- **`handleApplyNotionConfig`** (4838–4883): change signature to `handleApplyNotionConfig(token: string)` — remove the `options` param and **delete the `planner.designDocEnabled` update** (lines ~4878–4882). The method should store/validate the token and `saveConfig({ ..., setupComplete: true })` only.

### 3. `src/services/SetupPanelProvider.ts`
- **`case 'applyNotionConfig'`** (423–428): drop the `message.options ?? {}` argument; call `handleApplyNotionConfig(message.token)`.

### 4. Tests
- **`src/test/setup-panel-migration.test.js`**
  - Line 71: remove the `id="notion-option-enable-design-doc"` existence assertion. **Also remove the `id="notion-option-summary"` existence assertion** (line ~73), since that element is being deleted.
  - **Add negative assertions** (per user) that `notion-option-enable-design-doc` and `notion-option-summary` are **absent** from `setupSource`, matching the style of the existing "removed" assertion blocks (e.g. the `OPERATION MODE` block at lines ~79–84).
  - Lines ~126–130: update the `NotionSetupState` regex to match the trimmed type (just `setupComplete: boolean;`), dropping `designDocEnabled` / `designDocLink`.
- **`src/test/prompts-tab-move-regression.test.js`** (371–372): asserts `planner.designDocEnabled` still exists in the provider source. **No change needed** — that config is retained via the Planning tab path. Re-run to confirm it stays green.

## Out of Scope / Untouched
- `planner.designDocEnabled` config key, its Planning-tab toggle, and all consumers (`_isDesignDocEnabled`, `_getDesignDocContent`, `PlannerPromptWriter`, `KanbanProvider`, `PlanningPanelProvider`).
- Notion backup (`configureNotionBackup`, `backupToNotion`, etc.) and the "Doc Pull" / planning-source checkboxes — these are the doc-source + backup features that stay.
- The Notion tab's descriptive copy at `setup.html:948–949` and `957–958` (see User Review Required #2).
- `dist/webview/setup.html` — build artifact; regenerated by the build, not hand-edited (per project convention).

## Verification Plan

> Note (this session): compilation and tests are **not** run here — they are listed for the user to execute.

### Automated Tests
1. **`src/test/setup-panel-migration.test.js`** (`--forceExit`): positive existence assertions for the checkbox/summary removed; new negative absence assertions pass; `NotionSetupState` regex matches the trimmed type.
2. **`src/test/prompts-tab-move-regression.test.js`** (`--forceExit`): stays green — `planner.designDocEnabled` / `planner.designDocLink` still present in provider source.
3. Fix only what fails; do not modify unrelated assertions.

### Manual / Static Checks (user-run)
1. `grep` confirms zero remaining references to `notion-option-enable-design-doc`, `enableDesignDocFetching`, `collectNotionApplyOptions`, and `renderNotionOptionSummary` in `src/`.
2. TypeScript build passes (catches the unused `designDocSetting` local at 3963 and the `NotionSetupState` field removals).
3. Rebuild webview, open Setup → Notion tab: checkbox gone, token apply succeeds, and applying a token does **not** flip `planner.designDocEnabled` (toggle the Planning-tab setting on, apply a Notion token, confirm it stays on).

## Risks & Verification (original — preserved)
- **Risk:** leaving a dangling reference to the removed checkbox id or `collectNotionApplyOptions` → runtime error in the webview. Mitigate by grepping `notion-option-enable-design-doc`, `enableDesignDocFetching`, and `collectNotionApplyOptions` for zero remaining hits in `src/` after edits.
- **Risk:** unused-variable / type errors after trimming `NotionSetupState`. Mitigate with a TypeScript compile.
- **Verification steps:**
  1. `grep` confirms no remaining references to the removed id/option/function in `src/`.
  2. TypeScript build passes.
  3. Rebuild webview, open Setup → Notion tab: checkbox gone, token apply succeeds, and applying a token does **not** flip `planner.designDocEnabled` (toggle the Planning-tab setting on, apply a Notion token, confirm it stays on).
  4. Run the two affected Jest tests (`--forceExit`); fix only what fails.

---

**Recommendation:** Complexity 4 (≤ 6) → **Send to Coder.**

---

## Reviewer Pass (2026-06-19) — Direct In-Place Review

### Stage 1 — Grumpy Principal Engineer

*The reviewer cracks his knuckles, glares at the diff, and begins.*

> "A 'design-doc fetching' toggle that secretly clobbers a *global planner setting* every time some poor soul pastes a Notion token? That's not a feature, that's a landmine with a friendly label. So let's see if the cleanup crew actually defused it or just painted over the wire.
>
> **The checkbox** — `#notion-option-enable-design-doc` — *gone* from `setup.html`. Grep returns zero hits in `src/`. Good. I half-expected a ghost `setCheckboxState` call lingering like a bad smell. There isn't one.
>
> **`collectNotionApplyOptions` / `renderNotionOptionSummary`** — vaporized. Zero references. Not a single orphan caller waiting to throw `ReferenceError` the moment a webview hydrates. I am *almost* disappointed I can't yell about it.
>
> **The silent write** — the crime scene itself. `handleApplyNotionConfig` (TaskViewerProvider.ts:4809) now takes `(token: string)` and *only* stores/validates the token and saves `setupComplete: true`. No `planner.designDocEnabled` write. The murder weapon has been removed from the evidence locker. **The actual bug is fixed.**
>
> **The unused-local trap** — plan screamed that `const designDocSetting` at old line 3963 would become an orphan and break the build. I checked. It's *gone*. The two identically-named locals at 3811 and 3919 — the ones that feed the *legitimate* `designDocSetting` postMessages for the Planning tab — are untouched. Someone actually read the warning instead of nuking all three. Miracle.
>
> **`NotionSetupState`** — trimmed to `{ setupComplete: boolean }`. Both construction sites (early-return 3968 + main 3990) carry only `setupComplete`. `cloneNotionSetupState` is still a dumb `JSON.parse(JSON.stringify())` and doesn't care that the shape shrank. Fine.
>
> **The `designDocSetting` message handler** in setup.html — keeps the Planning-tab `#design-doc-toggle` / `#design-doc-status-line` updates, drops the `lastNotionSetupState` injection and the vestigial `renderNotionSetupState()` call. The Planning tab still hydrates. The Notion tab stopped eavesdropping.
>
> **The tests** — positive assertions for the dead checkbox/summary are gone; negative absence assertions slot cleanly into the existing OPERATION-MODE removed-element block (81–82) with no dangling `&&`. The `NotionSetupState` regex is loosened to `setupComplete: boolean;`. The regression test's `planner.designDocEnabled` / `designDocLink` assertions stay green because those keys still live at 7087–7097, 8897, and 14705–14730.
>
> So where's my righteous fury? I went looking for it. **`dist/webview/setup.html`** — the build artifact — *also* shows zero hits for the dead checkbox, so even a stale-bundle ambush isn't lurking. Copy at 1028/1047 left intact per User Review #2 — correct, Notion genuinely is a doc source.
>
> Fine. *Fine.* It's clean. I'll find something to be grumpy about tomorrow."

**Findings:**
- No CRITICAL findings.
- No MAJOR findings.
- **NIT (informational, not a defect):** `dist/webview/setup.html` currently happens to be clean, but per project convention it is a generated artifact — the authoritative fix lives in `src/`. A `npm run compile` is still required before runtime (deferred to user per session directive: SKIP COMPILATION).

### Stage 2 — Balanced Synthesis

**Keep (all correct, no action):**
- `setup.html`: checkbox + summary div deleted; `collectNotionApplyOptions` / `renderNotionOptionSummary` deleted; apply postMessage reduced to `{ type: 'applyNotionConfig', token }`; `renderNotionSetupState()` reduced to `setApplyButtonBusy('notion', false)`; `designDocSetting` handler keeps Planning-tab updates and drops the Notion injection + trailing render call; `setupPanelState` hydration unchanged and still valid against the shrunk state.
- `TaskViewerProvider.ts`: `NotionSetupState` trimmed to `{ setupComplete }`; both construction sites updated; unused `designDocSetting` local at old 3963 deleted; the 3811/3919 locals correctly preserved; `handleApplyNotionConfig(token)` no longer writes `planner.designDocEnabled`.
- `SetupPanelProvider.ts`: `case 'applyNotionConfig'` calls `handleApplyNotionConfig(message.token)` with no `options`.
- Tests: both files match the plan; negative assertions are well-formed; regression test stays green.

**Fix now:** Nothing. No valid CRITICAL/MAJOR findings — no code changes applied by this reviewer pass.

**Defer:** `npm run compile` + the two Jest tests + manual webview smoke-check, all explicitly delegated to the user this session (SKIP COMPILATION / SKIP TESTS directives).

### Code Fixes Applied
None. The implementation already satisfies every plan requirement; there were no material defects to fix.

### Validation Results
- `grep -rn` in `src/` → **0 hits** for `notion-option-enable-design-doc`, `collectNotionApplyOptions`, `renderNotionOptionSummary`, `enableDesignDocFetching` (the only matches are the intended *negative* absence assertions in `setup-panel-migration.test.js:81–82`).
- `NotionSetupState` confirmed = `{ setupComplete: boolean }` (TaskViewerProvider.ts:208–210).
- `handleApplyNotionConfig` confirmed single-arg, no `planner.designDocEnabled` write (TaskViewerProvider.ts:4809–4849).
- `handleApplyNotionConfig` has exactly one caller (SetupPanelProvider.ts:424), already updated to the single-arg signature.
- Unused `designDocSetting` local removed from `getIntegrationSetupStates`; legitimate locals at 3811/3919 preserved.
- `planner.designDocEnabled` / `planner.designDocLink` still present in provider source (7087–7097, 8897, 14705–14730) → regression test assertions stay green.
- `dist/webview/setup.html` → 0 stale hits (no rebuild ambush), though a fresh `npm run compile` remains the user's responsibility.
- TypeScript compile and Jest **not run** this session per SKIP COMPILATION / SKIP TESTS directives.

### Remaining Risks
- **Build step pending (low):** `npm run compile` must run before the change is live; deferred to the user. `dist/` is already coincidentally clean, so no stale-checkbox runtime risk even if rebuild is delayed.
- **Verification pending (low):** the two Jest tests and the manual "toggle Planning-tab design-doc on → apply Notion token → confirm it stays on" smoke check are user-run per session directives.
- **MR-merge hazard (low, as plan noted):** a future branch touching `handleApplyNotionConfig`, `NotionSetupState`, or the Notion hydration path could resurrect the removed `options` param / `designDocEnabled` field on a careless merge. Re-grep after any merge.

### Structured Summary
- **CRITICAL:** none.
- **MAJOR:** none.
- **NIT:** `dist/webview/setup.html` is a generated artifact requiring `npm run compile` (deferred to user); not a code defect.
- **Fixes applied:** none — implementation matched the plan on every point.
- **Remaining risks:** pending build + test/smoke verification (user-run), and the standard merge-resurrection hazard.
