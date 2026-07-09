# Feature-create modal: start with a blank title, don't pre-fill a wrong suggestion

## Goal

When the user selects two or more plan cards on the Kanban board and clicks **GROUP INTO FEATURE**, the feature-create modal opens with the name field **pre-filled with an auto-generated suggestion** (the first selected plan's topic, truncated, with the word " Feature" appended). This suggestion is *always wrong* — it names the new feature after one arbitrary member plan, which is never what the grouping should be called. The user then has to select-all and delete the junk before they can type the real name.

The fix: the multi-plan "group into feature" flow must open with an **empty** name field so the user is required to type a title before the feature is created. No pre-population.

### Problem analysis & root cause

`openFeatureCreateModal(opts)` in `src/webview/kanban.html` (`:8016`) handles three modes:

- **blank-feature** (`opts.blankFeature`) — already opens with an empty name (`nameInput.value = ''`, `src/webview/kanban.html:8033`) and early-returns at `:8039`. Correct; untouched by this change.
- **single-plan promote** (`opts.singlePlanPromote`) — pre-fills the one plan's topic verbatim as the feature name (`src/webview/kanban.html:8051`). This is reasonable (promoting one plan → naming the feature after it) and is **not** what the user complained about.
- **multi-plan group** (the `else` branch, reached from the GROUP INTO FEATURE button when >1 non-feature card is selected — `src/webview/kanban.html:10826` → `openFeatureCreateModal({ singlePlanPromote: false })`) — this is the offender:

```js
// src/webview/kanban.html:8056-8063
} else {
    const suggestion = firstTopic.length > 40 ? firstTopic.substring(0, 37) + '...' : firstTopic;
    if (nameInput) nameInput.value = suggestion ? suggestion + ' Feature' : '';
    if (titleText) titleText.textContent = 'Create Feature';
    ...
}
```

`firstTopic` is `selectedPlans[0]?.topic` — the topic of whichever card happens to be first in selection order. Appending `' Feature'` yields titles like *"Fix Tickets Import Wiping Remote Tickets Feature"* — a single member plan's name masquerading as the group name. There is no signal in one member's topic about what the *group* represents, so the suggestion is structurally always wrong.

**Root cause:** the multi-plan branch treats the first member's topic as a feature-name seed. It should not seed at all.

The submit path already enforces a non-empty name — `src/webview/kanban.html:10835-10841` trims the input and, if empty, focuses the field and paints its border red (`var(--status-red)`) without submitting. So clearing the pre-fill does **not** create an "empty submit" hole; the guard that requires a title is already in place. We are only removing the bad default.

## Metadata

- **Tags:** frontend, ui, ux, bugfix
- **Complexity:** 2
- **Files touched:** `src/webview/kanban.html`

## User Review Required

None. The behavior the user wants is explicit ("open with an empty name field") and the implementation is a single-branch value change with no product tradeoff to adjudicate.

## Complexity Audit

### Routine
- Three localized edits inside a single webview helper's `else` branch: change the value assignment (`nameInput.value = suggestion...` → `nameInput.value = ''`), delete the now-dead `suggestion` computation, and add one `setTimeout(() => nameInput.focus(), 0)` line.
- No data model, migration, message-protocol, or backend change. The `createFeature` payload (`:10850`) is unchanged.
- The empty-name guard already exists downstream (`:10835-10841`), so the required-title behavior is fully covered by existing code.
- Isolated to the multi-plan `else` branch — the single-promote and blank-feature modes are structurally separate and untouched.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions** — None. Synchronous DOM assignment in a single webview; no async, no state shared across processes. The `setTimeout(…, 0)` focus is a one-tick defer, not a race surface.
- **Security** — None. No new input flows to the backend; the name still comes from user input and is trimmed at submit. No new `innerHTML`/injection surface (the plan-list rendering at `:8046` already escapes via `escapeHtml` and is unchanged).
- **Side Effects**
  - **Single-plan promote unaffected.** The `singlePlanPromote` branch (`:8050-8055`) is a separate code path and keeps its topic pre-fill (`:8051`, which reads `firstTopic` from `:8049`). Only the `else` (multi-plan group) branch changes.
  - **Blank-feature mode unaffected.** Early-returns at `:8039` before reaching the changed branch.
  - **Stale-value carryover.** The modal DOM is reused across opens. Setting `nameInput.value = ''` *explicitly* (not merely omitting the assignment) ensures a title typed in a prior open — or a prior single-promote pre-fill — does not leak into the next group-into-feature open.
  - **Stale error-border carryover.** Already handled: `openFeatureCreateModal` resets `nameInput.style.borderColor = ''` at the top on every open (`:8026`), so a red border left by a prior empty-submit is cleared.
- **Dependencies & Conflicts**
  - **Empty-submit already guarded.** `feature-create-submit` handler (`:10835-10841`) blocks submission on an empty/whitespace name (`.value.trim()`) and highlights the field. No new validation needed.
  - **Placeholder present.** The input carries `placeholder="Feature name..."` (`:3285`), so the empty field reads as intentional, not broken.
  - **`firstTopic` declaration must stay.** `firstTopic` (`:8049`) is still referenced by the single-promote branch (`:8051`); only the `suggestion` line (`:8057`) is removed. Do not delete the `firstTopic` declaration.
  - **No other caller reaches the `else` branch.** The three call sites are `blankFeature:true` (`:5259`), `singlePlanPromote:true` (`:10824`), and `singlePlanPromote:false` (`:10826`); there is no bare `openFeatureCreateModal()` caller, so the edit is precisely scoped to multi-plan grouping.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) stale value/border leaking from a prior modal open — both already neutralized (explicit `value = ''`, plus the existing `borderColor = ''` reset at `:8026`); (2) accidentally clearing the pre-fill for single-plan promote — avoided because promote is a separate branch that reads `firstTopic` independently. Mitigation is simply to edit *only* the `else` branch and keep the `firstTopic` declaration. This is a genuinely low-risk, self-contained UI default change with the required-title guard already enforced downstream.

## Proposed Changes

### `src/webview/kanban.html` — clear the multi-plan feature-name pre-fill

In `openFeatureCreateModal`, replace the body of the multi-plan `else` branch (currently `:8056-8063`). Remove the topic-derived `suggestion` line (`:8057`), set the field empty, and focus it:

```js
} else {
    // Group-into-feature: no pre-filled title. The first member's topic is never a
    // correct name for the group, so require the user to type one. The submit handler
    // (feature-create-submit) already blocks an empty name.
    if (nameInput) nameInput.value = '';
    if (titleText) titleText.textContent = 'Create Feature';
    if (descLabel) descLabel.style.display = '';
    if (descInput) descInput.style.display = '';
    if (submitBtn) submitBtn.textContent = 'Create Feature';
    // Focus the empty field so the user can type the title immediately. setTimeout(…, 0)
    // defers focus to the next tick — after modal.classList.remove('hidden') runs below —
    // because focusing a still-hidden element is a no-op.
    if (nameInput) setTimeout(() => nameInput.focus(), 0);
}
```

**Context:** the `else` branch is the multi-plan group path; the `suggestion`/`' Feature'` seed at `:8058` is the exact behavior being removed.
**Logic:** assign empty string explicitly (guards against stale-value carryover per the Edge-Case audit); auto-focus so the empty field is immediately typeable.
**Implementation:**
- Delete `:8057` (the `suggestion` line); change `:8058` to `if (nameInput) nameInput.value = '';`.
- Add the `setTimeout(() => nameInput.focus(), 0)` line as the last statement **inside** the `else` branch (not at the shared `:8064` exit). Scoping it here focuses only the group modal and leaves single-promote's behavior byte-for-byte unchanged. The deferred callback still runs after the synchronous un-hide at `:8064`, so focus lands on a visible field.
- Leave `:8049` (`const firstTopic = ...`) in place — the single-promote branch at `:8051` still uses it. Leave the other three lines (`titleText`, `descLabel`/`descInput`, `submitBtn`) unchanged.

**Edge Cases:** covered above — single-promote and blank-feature branches are not on this path; empty submit is blocked at `:10835-10841`; placeholder at `:3285` keeps the empty field legible.

## Verification Plan

**Precondition (not a build step to run now):** webview changes take effect only after the extension is repackaged and reinstalled — the webview loads from the packaged VSIX, not the repo `dist/` (see CLAUDE.md). Do that before running the manual checks below.

### Automated Tests
None apply. `src/webview/kanban.html` is an inline-scripted VS Code webview with no unit/integration test harness in this repo, and a one-line UI-default change does not warrant standing up one. Verification is manual (below).

### Manual verification
1. On the Kanban board, select **two or more** plan cards, click **GROUP INTO FEATURE**.
   - **Expect:** the modal opens with an **empty** name field showing the `Feature name...` placeholder, the field is **focused** (cursor ready), and the title reads "Create Feature".
2. Click **Create Feature** with the field left blank (and again with only whitespace).
   - **Expect:** no submission; the field is focused and its border turns red.
3. Type a name, click **Create Feature**.
   - **Expect:** the feature is created with exactly the typed name (no " Feature" suffix, no member-plan topic).
4. Select a **single** plan card → promote to feature.
   - **Expect:** unchanged — the field is still pre-filled with that plan's topic (regression check on the `singlePlanPromote` branch).
5. Open the blank "+ Add Feature" entry point.
   - **Expect:** unchanged — empty field, "Add Feature" title/button.
6. Reopen the group modal after a single-promote open (stale-value regression check).
   - **Expect:** the group modal's name field is empty — no carryover of the promote pre-fill.

---

**Recommendation:** Complexity 2 → **Send to Intern.**

## Completion Report

Implemented the change in `src/webview/kanban.html`: the multi-plan group-into-feature branch now opens the feature-create modal with an empty `feature-create-name` field and immediately focuses it via `setTimeout(..., 0)` after the modal is unhidden. Removed the `firstTopic`-derived suggestion logic and `' Feature'` suffix. The single-plan promote and blank-feature modes are untouched, and the existing empty-name submit guard still enforces a required title. No automated tests were run per the plan's verification instructions. The working tree also contains unrelated pre-existing changes in `kanban.html` and other files that were not part of this plan.
