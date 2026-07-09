# Feature-create modal: start with a blank title, don't pre-fill a wrong suggestion

## Goal

When the user selects two or more plan cards on the Kanban board and clicks **GROUP INTO FEATURE**, the feature-create modal opens with the name field **pre-filled with an auto-generated suggestion** (the first selected plan's topic, truncated, with the word " Feature" appended). This suggestion is *always wrong* — it names the new feature after one arbitrary member plan, which is never what the grouping should be called. The user then has to select-all and delete the junk before they can type the real name.

The fix: the multi-plan "group into feature" flow must open with an **empty** name field so the user is required to type a title before the feature is created. No pre-population.

### Problem analysis & root cause

`openFeatureCreateModal(opts)` in `src/webview/kanban.html` handles three modes:

- **blank-feature** (`opts.blankFeature`) — already opens with an empty name (`nameInput.value = ''`, `src/webview/kanban.html:8033`). Correct.
- **single-plan promote** (`opts.singlePlanPromote`) — pre-fills the one plan's topic verbatim as the feature name (`src/webview/kanban.html:8051`). This is reasonable (promoting one plan → naming the feature after it) and is **not** what the user complained about.
- **multi-plan group** (the `else` branch, reached from the GROUP INTO FEATURE button when >1 non-feature card is selected — `src/webview/kanban.html:10826` → `openFeatureCreateModal({ singlePlanPromote: false })`) — this is the offender:

```js
// src/webview/kanban.html:8056-8062
} else {
    const suggestion = firstTopic.length > 40 ? firstTopic.substring(0, 37) + '...' : firstTopic;
    if (nameInput) nameInput.value = suggestion ? suggestion + ' Feature' : '';
    if (titleText) titleText.textContent = 'Create Feature';
    ...
}
```

`firstTopic` is `selectedPlans[0]?.topic` — the topic of whichever card happens to be first in selection order. Appending `' Feature'` yields titles like *"Fix Tickets Import Wiping Remote Tickets Feature"* — a single member plan's name masquerading as the group name. There is no signal in one member's topic about what the *group* represents, so the suggestion is structurally always wrong.

**Root cause:** the multi-plan branch treats the first member's topic as a feature-name seed. It should not seed at all.

The submit path already enforces a non-empty name — `src/webview/kanban.html:10834-10841` trims the input and, if empty, focuses the field and paints its border red (`var(--status-red)`) without submitting. So clearing the pre-fill does **not** create an "empty submit" hole; the guard that requires a title is already in place. We are only removing the bad default.

## Metadata

- **Tags:** kanban, features, webview, ux
- **Complexity:** 2/10
- **Files touched:** `src/webview/kanban.html`

## Complexity Audit

**Routine.** A one-line value change (plus an optional focus nicety) inside a single webview helper. No data model, migration, message-protocol, or backend change. The empty-name guard already exists downstream, so behavior is fully covered by existing code. Isolated to the multi-plan `else` branch — the single-promote and blank-feature modes are untouched.

## Edge-Case & Dependency Audit

- **Single-plan promote unaffected.** The `singlePlanPromote` branch (`:8050`) is a separate code path and keeps its topic pre-fill. Only the `else` (multi-plan group) branch changes. Verify the promote flow still pre-fills after the edit.
- **Blank-feature mode unaffected.** Early-returns at `:8039` before reaching the changed branch.
- **Empty-submit already guarded.** `feature-create-submit` handler (`:10831-10841`) blocks submission on an empty/whitespace name and highlights the field. No new validation needed; confirm it still fires.
- **Stale-value carryover.** The modal is reused across opens. Setting `nameInput.value = ''` explicitly (rather than leaving it unset) ensures a title typed in a prior open — or a prior single-promote pre-fill — does not leak into the next group-into-feature open. The edit must *assign* empty string, not just omit the assignment.
- **Placeholder present.** The input already carries `placeholder="Feature name..."` (`src/webview/kanban.html:3285`), so the empty field still reads as intentional, not broken.
- **No backend contract change.** `createFeature` message payload (`:10850`) is unchanged; the name simply comes from user input.

## Proposed Changes

### `src/webview/kanban.html` — clear the multi-plan feature-name pre-fill

In `openFeatureCreateModal`, the multi-plan `else` branch (currently `:8056-8062`), remove the topic-derived suggestion and set the field empty:

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
}
```

The now-unused `suggestion`/`firstTopic` computation can be dropped from this branch. `firstTopic` is still referenced by the `singlePlanPromote` branch (`:8051`), so leave its declaration (`:8049`) in place — only remove the `suggestion` line.

**Optional nicety (recommended):** focus the name input when the modal opens so the user can type immediately. At the end of `openFeatureCreateModal`, after `modal.classList.remove('hidden')` (`:8064`):

```js
if (modal) modal.classList.remove('hidden');
// Focus the name field so the user can type a title right away.
if (nameInput) setTimeout(() => nameInput.focus(), 0);
```

The `setTimeout(…, 0)` defers focus until after the modal is un-hidden (focus on a `display:none`/`hidden` element is a no-op).

## Verification Plan

1. Rebuild/reinstall the VSIX (webview loads from the packaged extension, not the repo `dist/`).
2. On the Kanban board, select **two or more** plan cards, click **GROUP INTO FEATURE**.
   - **Expect:** the modal opens with an **empty** name field showing the `Feature name...` placeholder; title reads "Create Feature". (With the optional nicety, the field is focused.)
3. Click **Create Feature** with the field left blank.
   - **Expect:** no submission; the field is focused and its border turns red.
4. Type a name, click **Create Feature**.
   - **Expect:** the feature is created with exactly the typed name (no " Feature" suffix, no member-plan topic).
5. Select a **single** plan card → promote to feature.
   - **Expect:** unchanged — the field is still pre-filled with that plan's topic (regression check on the `singlePlanPromote` branch).
6. Open the blank "+ Add Feature" entry point.
   - **Expect:** unchanged — empty field, "Add Feature" title/button.
