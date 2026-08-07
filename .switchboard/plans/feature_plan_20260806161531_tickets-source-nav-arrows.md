# Tickets Source Navigation Arrows — Prev/Next List & Project

## Goal

After selecting a source in the Tickets panel, the user currently sees a static
text summary (e.g. `ClickUp ▸ Space ▸ Folder ▸ List` or just `Linear`) beside the
**Source** button. To switch to a different list in the same ClickUp folder — or a
different Linear project — the user must re-open the Source modal and manually
re-select from the hierarchy dropdowns. This is slow when reviewing tickets across
many lists/projects sequentially.

**Problem analysis & root cause:**

The controls strip in `tickets.html` renders the source summary as a plain
`<span id="tickets-source-summary">` with no navigation affordance. The summary is
populated by `updateTicketsSourceSummary()` in `tickets.js`, which builds a
display string but provides no interactive controls. All list/project switching is
funneled through the Source modal's `<select>` dropdowns
(`attachTicketsHierarchyListeners` for ClickUp, the project picker change handler
for Linear). There is no quick "go to adjacent sibling" path.

The data needed to navigate already exists in memory:
- **ClickUp:** `clickUpAvailableListsInFolder` (lists in the current folder) or
  `clickUpAvailableDirectLists` (root-level lists), keyed by `clickUpSelectedListId`.
- **Linear:** the project picker options (derived from `linearProjectIssues`
  project names), keyed by `linearProjectPickerValue`.

So the fix is purely front-end: add left/right arrow buttons beside the summary
span and wire them to reuse the existing list-selection / project-selection flows.

**Verified against HEAD (improve pass, 2026-08-07).** Every line reference below was
re-resolved against the current `src/webview/tickets.js` (7849 lines) and
`src/webview/tickets.html` (4693 lines). The original draft's `tickets.js` line
numbers were stale by roughly +50 (they pre-dated an insertion earlier in the file);
they are corrected throughout.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, feature
**Project:** Browser Switchboard

> **Superseded:** Complexity 3.
> **Reason:** The improve pass found three latent correctness defects in the drafted
> approach (Linear picker DOM desync, the `!provider` early-return skipping the arrow
> block, and move-mode enter/exit never refreshing arrow state). Fixing them raises the
> edit surface from "two buttons + one function" to six coordinated edit sites across
> two files, including two functions the draft never touched (`showMoveTicketModal`,
> `exitMoveMode`). That is squarely a Coder-tier change, not an Intern-tier one.
> **Replaced with:** Complexity 4 — routing to Coder.

## User Review Required

- None. Placement (arrows flanking the summary text, prev on the left of the span and
  next on the right), no-wrap-around at the boundaries, and disabled-rather-than-hidden
  at the edges are all decided in this plan.

## Complexity Audit

### Routine

- Self-contained front-end change to a single panel (`tickets.html` + `tickets.js`).
  No backend changes, no new message types, no new verbs, no schema entries, no data
  model changes.
- Two `<button>` elements, one CSS rule, one sibling-computation function, two click
  handlers.
- The navigation logic reuses existing selection code paths — the arrows are a
  shortcut to the same code the `<select>` change event runs, extracted into shared
  helpers rather than duplicated.
- Because this lives entirely in the shared webview assets, both hosts (VS Code
  extension and `npx` standalone) get the feature from one edit — PRD contract #1
  (anti-divergence, reuse verbatim) is satisfied by construction.

### Complex / Risky

- **State-sync discipline, not logic complexity.** Every risk here is "some state
  path forgot to refresh the arrows". The arrows derive their enabled/disabled state
  from four independent variables (`_moveMode`, `lastIntegrationProvider`,
  the ClickUp list arrays / `clickUpSelectedListId`, and the Linear picker options /
  `linearProjectPickerValue`), and there is no single render funnel that all four flow
  through. The mitigation is to make `updateTicketsSourceSummary()` the *sole* writer
  of arrow state and to guarantee it is called on every transition — including the two
  transitions that currently do not call it (`showMoveTicketModal`, `exitMoveMode`).
- **Linear selection does not re-render the picker.** `selectLinearProject` changes a
  JS variable that the visible `<select>` also displays. Unlike ClickUp (where
  `loadClickUpProject` → `renderTicketsClickUpPanel` → `renderTicketsClickUpHierarchyNav`
  rebuilds the `<select>` markup), the Linear path must explicitly resync the DOM value
  or the dropdown will disagree with the list it is filtering.
- **Move mode wipes the ClickUp hierarchy arrays.** `showMoveTicketModal`
  (`tickets.js:3948-3984`) snapshots and then blanks `clickUpSelectedListId`,
  `clickUpAvailableListsInFolder`, and `clickUpAvailableDirectLists`. Arrow-state
  computation must not run against that wiped state — hence the `_moveMode` guard is
  load-bearing, not cosmetic.

## Edge-Case & Dependency Audit

### Race Conditions

| Race | Handling |
|------|----------|
| Arrow clicked while a ClickUp hierarchy load is in flight (`clickUpHierarchyLoading === true`) | `navigateTicketsSource` returns early; `updateTicketsSourceSummary` also renders both arrows disabled. Double-guarded: the state guard survives even if a render is skipped. |
| Arrow clicked while a ClickUp project load is in flight (`clickUpProjectLoading === true`) | `selectClickUpList` sets `clickUpProjectLoading = false` before calling `loadClickUpProject(false, listId)`, exactly as the existing `listSelect` change handler does (`tickets.js:3850`). Without that reset, `loadClickUpProject`'s `if (clickUpProjectLoading && !force) return;` guard (`tickets.js:3896`) would silently swallow the navigation. |
| Rapid double-click on `next` | Second click lands while the first `clickupProjectLoaded` reply is outstanding. Harmless: the second `selectClickUpList` supersedes the first, and `_isForThisPanel` (`tickets.js:192`) drops the stale reply because `message.listId` no longer matches `clickUpSelectedListId`. |
| `clickupListsLoaded` arrives after a navigation | That arm already calls `renderTicketsTab(); updateTicketsSourceSummary();` (`tickets.js:6798-6799`), so arrow state re-derives from the fresh array. |

### Security

- No new network calls, no new message types, no user-supplied strings rendered as
  HTML. The arrows only re-dispatch ids/names that already round-tripped through the
  existing `<select>` path. `clickupSaveListSelection` is re-sent with the same field
  set the change handler sends — no new payload shape, so no `verbSchemas.ts` change.

### Side Effects

- `selectClickUpList` posts `clickupSaveListSelection`, which **persists** the new
  space/folder/list selection to the ClickUp config on the backend
  (`TicketsPanelProvider.ts:1340-1362`). Arrow navigation is therefore a persistent
  action, not a transient view filter — identical to picking from the dropdown, which
  is the intended parity.
- Both helpers call `saveTicketsState()`, so the navigated-to selection survives tab
  switches and panel reloads.
- ClickUp navigation resets the status filter, the assignee filter, the cached filter
  HTML, and the sidebar drill-down. Linear navigation resets `selectedLinearIssue` and
  the drill-down. These resets are copied from the existing change handlers, not
  invented — the point of extracting shared helpers is that arrow and dropdown paths
  cannot drift.

### Dependencies & Conflicts

- **No external dependencies.** No new npm packages, no backend changes, no new verbs.
- **Return-contract / ratchet impact: none.** No `_handleMessage` arm is touched, so
  `npm run verb-returns:check` (Tickets ceiling = 56 in
  `scripts/verb-return-contract-baseline.json`) is unaffected. `npm run parity:check`
  and `npm run catalog:check` are likewise unaffected — no verb surface change.
- **Conflicts:** anything else editing `updateTicketsSourceSummary`,
  `attachTicketsHierarchyListeners`, or the Linear project-picker change handler in
  `tickets.js`. Per PRD orchestration discipline (one agent stream per file),
  serialise with any concurrent `tickets.js` work — notably the auto-refresh plan
  (`feature_plan_20260806153624`), which is backend-only but shares the panel.

### Functional edge cases

| Edge case | Handling |
|-----------|----------|
| No provider selected (`lastIntegrationProvider` falsy) | Arrows hidden. Requires the arrow block to run **before** `updateTicketsSourceSummary`'s early return — see Change 2f. |
| No list selected (ClickUp) / no project selected (Linear) | Arrows visible but both disabled — the affordance is discoverable, but inert until a source exists. (For Linear "All projects", `next` is enabled: it selects the first project. See below.) |
| Only one list/project in scope | Both arrows disabled (`:disabled` opacity + `not-allowed` cursor), not hidden. |
| At the first list (prev) or last list (next) | Disable the respective arrow. **No wrap-around** — wrap is disorienting in a hierarchy. |
| Move mode active (`_moveMode === true`) | Arrows hidden. Move mode repurposes the Source modal as a target picker and blanks the hierarchy arrays; navigation would read wiped state. Requires explicit refresh calls in `showMoveTicketModal` / `exitMoveMode` — see Change 2g. |
| Hierarchy loading (`clickUpHierarchyLoading` / `linearProjectLoading`) | Arrows disabled to prevent re-entrant navigation while a load is in flight. |
| ClickUp root lists vs folder lists | Use `clickUpAvailableListsInFolder` when `clickUpSelectedFolderId` is truthy, else `clickUpAvailableDirectLists`. This matches `buildTicketsHierarchyHtml` at `tickets.js:3657-3659`. Confirmed safe: the `_root_` option value is normalised to `''` by the folder change handler (`tickets.js:3798`, `tickets.js:3772`), so a root selection always falls to the `clickUpAvailableDirectLists` branch. |
| Linear picker is issue-derived, not `linearAvailableProjects` | Use the rendered `<option>` values of `#tickets-project-picker` (project names) as the navigation source — that is exactly what the user sees and what `linearProjectPickerValue` stores (`renderTicketsLinearProjectPickerOptions`, `tickets.js:815-836`). No dependency on `linearAvailableProjects`. |
| Linear picker options change under the user (new issues load, adding projects) | `renderTicketsLinearProjectPickerOptions` re-derives options and re-asserts `projectPicker.value` on every `renderTicketsLinearPanel`; `updateTicketsSourceSummary` (called at the end of the same render, `tickets.js:1210`) then re-derives arrow state from the new option set. Self-healing. |
| ClickUp list selection side effects (status/assignee filter reset, drill-down reset) | The arrow handler must perform the SAME resets as the `listSelect` change handler (`tickets.js:3839-3879`), not just set the id. Achieved by extracting `selectClickUpList(listId)` and having the change handler call it. |
| Linear project selection side effects (`selectedLinearIssue` reset, drill-down reset) | Same — extract `selectLinearProject(projectName)` from the picker change handler (`tickets.js:4680-4693`). |
| State persistence | Both extracted helpers call `saveTicketsState()`. |
| Panel HTML is shared between hosts | `tickets.html` is served by `headlessPanelHtml.ts` to both the extension host and the standalone `npx` host, so the arrows appear identically in both with no second edit. No `/panels` manifest change (no new panel, no new verb). |

## Dependencies

- None. No prior session work is required; no `sess_*` prerequisites.

## Adversarial Synthesis

**Risk Summary.** The feature is small but its correctness is entirely about state
synchronisation, and the original draft had three sync holes: the Linear helper never
resynced the visible `<select>` or re-derived arrow state, the arrow-state block was
appended after an early `return` that skips it whenever no provider is selected, and
neither move-mode entry nor exit refreshes the arrows. Left unfixed, each produces a
*dead or lying control* — a `next` arrow that stays enabled at the last project and
does nothing on click, or a dropdown that displays a project the list is no longer
filtered by — which directly violates PRD contract #6 (capability-gating honesty, no
dead buttons). Mitigations: make `updateTicketsSourceSummary()` the single writer of
arrow state and call it on every transition (including the two move-mode transitions);
have `selectLinearProject` explicitly set `projectPicker.value`; hoist the arrow block
above the `!provider` early return; and double-guard navigation with early returns in
`navigateTicketsSource` so a missed render cannot turn into a wrong action.

## Proposed Changes

### 1. `src/webview/tickets.html` — Add arrow buttons beside the source summary

**Context:** The controls strip is `#controls-strip-tickets` (`tickets.html:3950`).
Line 3960 is the summary span; line 3961 is the (Linear-only) project picker.

**Change 1a — markup.** Replace line 3960 with three elements: prev button, the
existing span (unchanged), next button.

```html
<!-- tickets.html:3960 — replace the single <span> line with these three -->
<button id="tickets-source-prev" class="strip-btn tickets-source-nav-btn" title="Previous list" aria-label="Previous list" style="display:none">‹</button>
<span id="tickets-source-summary" class="workspace-static-label"></span>
<button id="tickets-source-next" class="strip-btn tickets-source-nav-btn" title="Next list" aria-label="Next list" style="display:none">›</button>
```

**Change 1b — CSS.** Add one rule beside the existing `.workspace-static-label` rule
(`tickets.html:3736-3744`).

> **Superseded:** the draft's CSS block —
> ```css
> .tickets-source-nav-btn { padding: 2px 6px; min-width: 20px; font-size: 14px; line-height: 1; }
> .tickets-source-nav-btn:disabled { opacity: 0.3; cursor: not-allowed; }
> ```
> **Reason:** two problems. (1) `.strip-btn:disabled` already exists at
> `tickets.html:324-329` with `opacity: 0.4; cursor: not-allowed;` plus border/colour
> resets; a second same-specificity rule adds nothing and fights the panel's
> established disabled treatment. (2) `.strip-btn` sets `text-transform: uppercase`
> and `letter-spacing: 1px`, which pads a trailing gap to the right of a single `‹`
> glyph and visually decentres it — the draft never reset either.
> **Replaced with:** one rule, sizing only, with the inherited text treatment neutralised:

```css
/* Compact chevron buttons flanking the source summary. Inherits .strip-btn's
   border/hover/disabled treatment; only the text metrics need overriding —
   .strip-btn's uppercase + 1px letter-spacing decentres a single glyph. */
.tickets-source-nav-btn {
    padding: 2px 6px;
    min-width: 20px;
    font-size: 14px;
    line-height: 1;
    letter-spacing: 0;
    text-transform: none;
}
```

**Edge cases:** the inline `style="display:none"` is the initial state only; JS owns
visibility from the first `updateTicketsSourceSummary()` call onward.

### 2. `src/webview/tickets.js` — Register arrow elements and wire navigation

#### 2a. Add element accessors

In `getTicketsTabElements()` (`tickets.js:273-324`), after `ticketsSourceSummary`
(line 315):

```js
ticketsSourcePrev: document.getElementById('tickets-source-prev'),
ticketsSourceNext: document.getElementById('tickets-source-next'),
```

#### 2b. Extract a shared ClickUp list-selection helper

**Context:** the `listSelect` change handler is at `tickets.js:3838-3879`, inside
`attachTicketsHierarchyListeners`. Its non-move-mode body (lines 3849-3878) is the
logic to extract. Note the handler is re-attached on every hierarchy re-render, so the
helper must be declared at module scope (alongside `updateTicketsSourceSummary`), not
inside `attachTicketsHierarchyListeners`.

```js
// Shared by the hierarchy <select> change handler and the source nav arrows.
// Both paths MUST run the same resets — a divergence here is how the arrow
// path would leave a stale status/assignee filter over a different list.
function selectClickUpList(listId) {
    _restoringClickUpHierarchy = false;
    clickUpSelectedListId = listId;
    clickUpProjectLoading = false;
    clickUpProjectIssues = [];
    selectedClickUpIssue = null;
    _resetSidebarDrillDown();
    clickUpProjectStatusFilterValue = '';
    clickUpProjectAssigneeFilterValue = '';
    availableClickUpStatuses = [];
    _lastTicketsClickUpStateFilterHtml = '';
    _lastTicketsAssigneeFilterHtml = '';
    saveTicketsState();
    if (listId) {
        const spaceName = clickUpAvailableSpaces.find(s => s.id === clickUpSelectedSpaceId)?.name || '';
        const folderName = clickUpAvailableFolders.find(f => f.id === clickUpSelectedFolderId)?.name || '';
        const availableLists = clickUpSelectedFolderId ? clickUpAvailableListsInFolder : clickUpAvailableDirectLists;
        const listName = availableLists.find(l => l.id === listId)?.name || '';
        vscode.postMessage({
            type: 'clickupSaveListSelection',
            spaceId: clickUpSelectedSpaceId,
            spaceName,
            folderId: clickUpSelectedFolderId,
            folderName,
            listId,
            listName,
            workspaceRoot: ticketsWorkspaceRoot || undefined
        });
        loadClickUpProject(false, listId);
    } else {
        renderTicketsClickUpPanel();
    }
}
```

Then reduce the `listSelect` change handler body (lines 3849-3878) to a single call:

```js
const listSelect = document.getElementById('tickets-list-select');
listSelect?.addEventListener('change', (e) => {
    _restoringClickUpHierarchy = false;
    const listId = e.target.value;
    if (_moveMode) {
        // Move-mode branch unchanged (tickets.js:3842-3848) — it records a
        // target, it does not load. Must NOT route through selectClickUpList.
        clickUpSelectedListId = listId;
        _moveSelectedTargetId = listId || null;
        const btn = document.getElementById('btn-apply-move-ticket');
        if (btn) btn.disabled = !_moveSelectedTargetId;
        return;
    }
    selectClickUpList(listId);
});
```

**Edge cases:** `selectClickUpList` sets `clickUpProjectLoading = false` *before*
calling `loadClickUpProject`, preserving the original ordering. Both terminal branches
end in a render that calls `updateTicketsSourceSummary()` — `loadClickUpProject` →
`renderTicketsClickUpPanel` (`tickets.js:1278`), and the `else` branch calls
`renderTicketsClickUpPanel` directly — so arrow state refreshes on both.

#### 2c. Extract a shared Linear project-selection helper

**Context:** the project-picker change handler is at `tickets.js:4680-4693`, inside
`initTicketsTab`. Declare the helper at module scope.

> **Superseded:** the draft's helper —
> ```js
> function selectLinearProject(projectName) {
>     linearProjectPickerValue = projectName;
>     selectedLinearIssue = null;
>     _resetSidebarDrillDown();
>     renderTicketsLinearList();
>     renderTicketsLinearTaskDetail();
>     saveTicketsState();
> }
> ```
> **Reason:** correct for the dropdown path (where the browser already updated
> `<select>.value` before the change event fired) but **wrong for the arrow path**,
> which mutates the JS variable with no DOM event. Two concrete failures follow:
> (1) `#tickets-project-picker` is visible in the same controls strip for Linear
> (`tickets.html:3961`), so after an arrow click the dropdown displays the *old*
> project while the sidebar is filtered by the *new* one — the UI contradicts itself;
> (2) neither `renderTicketsLinearList` nor `renderTicketsLinearTaskDetail` calls
> `updateTicketsSourceSummary`, so arrow enabled/disabled state never re-derives —
> at the last project the `next` arrow stays enabled and clicking it does nothing.
> A visibly-enabled control that silently no-ops is exactly the dead button PRD
> contract #6 forbids.
> **Replaced with:**

```js
// Shared by the project-picker change handler and the source nav arrows.
// `syncPicker` is true only for the arrow path: the change handler runs AFTER
// the browser has already committed <select>.value, so re-writing it there is
// redundant; the arrow path mutates only the JS variable and must push the
// value back into the DOM or the visible dropdown will lie about the filter.
function selectLinearProject(projectName, syncPicker = false) {
    linearProjectPickerValue = projectName;
    if (syncPicker) {
        const { projectPicker } = getTicketsTabElements();
        if (projectPicker) { projectPicker.value = projectName; }
    }
    // Context switch: the previously-selected ticket belongs to the old project.
    selectedLinearIssue = null;
    _resetSidebarDrillDown();
    renderTicketsLinearList();
    renderTicketsLinearTaskDetail();
    updateTicketsSourceSummary();   // re-derive arrow enabled/disabled state
    saveTicketsState();
}
```

Then reduce the picker change handler (`tickets.js:4680-4693`) to:

```js
projectPicker?.addEventListener('change', (e) => {
    selectLinearProject(e.target.value);
    // Reconciliation stays off the read path — selecting a project is a
    // read/selection action and must not trigger a destructive delta sweep.
    // Use Refresh/Refetch to pull remote deltas.
});
```

**Edge cases:** the "Reconciliation moved off the read path" comment
(`tickets.js:4690-4692`) is load-bearing documentation for a previously-fixed
destructive-sweep bug — carry it over verbatim, do not drop it during the refactor.

#### 2d. Add the navigation function

Declare at module scope, next to `updateTicketsSourceSummary`.

```js
// Computes the adjacent sibling and routes through the SAME selection helper
// the dropdown uses. Guards are duplicated with updateTicketsSourceSummary's
// disabled-state logic on purpose: the render can be missed, the guard cannot.
function navigateTicketsSource(direction) {
    if (_moveMode) { return; }
    if (lastIntegrationProvider === 'clickup') {
        if (!clickUpSelectedListId || clickUpHierarchyLoading) { return; }
        const lists = clickUpSelectedFolderId
            ? clickUpAvailableListsInFolder
            : clickUpAvailableDirectLists;
        const idx = lists.findIndex(l => l.id === clickUpSelectedListId);
        if (idx < 0) { return; }
        const nextIdx = direction === 'next' ? idx + 1 : idx - 1;
        if (nextIdx < 0 || nextIdx >= lists.length) { return; }
        selectClickUpList(lists[nextIdx].id);
    } else if (lastIntegrationProvider === 'linear') {
        if (linearProjectLoading) { return; }
        const options = ticketsLinearProjectOptions();
        if (options.length === 0) { return; }
        const idx = options.indexOf(linearProjectPickerValue);
        // "All projects" (empty value) is index -1: `next` selects the first
        // project, `prev` has nowhere to go.
        const nextIdx = direction === 'next' ? idx + 1 : idx - 1;
        if (nextIdx < 0 || nextIdx >= options.length) { return; }
        selectLinearProject(options[nextIdx], true);
    }
}

// Single source of truth for the Linear navigation order: the rendered picker
// options, minus the "All projects" sentinel. Both navigateTicketsSource and
// updateTicketsSourceSummary read it so they can never disagree about bounds.
function ticketsLinearProjectOptions() {
    const { projectPicker } = getTicketsTabElements();
    if (!projectPicker) { return []; }
    return Array.from(projectPicker.options).filter(o => o.value).map(o => o.value);
}
```

> **Superseded:** the draft's Linear branch computed `baseIdx` as
> `linearProjectPickerValue ? idx : (direction === 'next' ? -1 : 0)` and inlined
> `document.getElementById('tickets-project-picker')`.
> **Reason:** the `baseIdx` ternary is dead arithmetic — `indexOf('')` on an
> option list that has already had empty values filtered out is `-1`, which is
> exactly the value the ternary computes for the `next` case; and for the `prev`
> case it forced `baseIdx = 0`, yielding `nextIdx = -1`, which the bounds check
> rejects — identical to falling straight out of `idx = -1`. Two branches, one
> behaviour. Separately, inlining the `getElementById` duplicated the option-derivation
> logic between `navigateTicketsSource` and `updateTicketsSourceSummary`, which is how
> the two would drift out of agreement about what "last project" means.
> **Replaced with:** plain `idx = options.indexOf(...)` (naturally `-1` for "All
> projects") plus a shared `ticketsLinearProjectOptions()` helper read by both.

**Edge cases:** the `_moveMode` early return at the top is the third guard layer —
even if a stale render left the arrows visible during move mode, a click cannot act on
the blanked hierarchy arrays.

#### 2e. Wire click handlers

In `initTicketsTab`, near the existing refresh-button wiring:

```js
const { ticketsSourcePrev, ticketsSourceNext } = getTicketsTabElements();
ticketsSourcePrev?.addEventListener('click', () => navigateTicketsSource('prev'));
ticketsSourceNext?.addEventListener('click', () => navigateTicketsSource('next'));
```

**Edge cases:** `initTicketsTab` runs once, and the arrow elements are static markup in
`tickets.html` (unlike the hierarchy `<select>`s, which are re-created by
`renderTicketsClickUpHierarchyNav` and therefore need re-attached listeners). No
re-attachment is required.

#### 2f. Update `updateTicketsSourceSummary` to own arrow state

**Context:** `updateTicketsSourceSummary` is at `tickets.js:3588-3627`. It early-returns
at lines 3593-3596 when `lastIntegrationProvider` is falsy.

> **Superseded:** the draft instructed "Append at the end of the function, after the
> summary text is set."
> **Reason:** the function returns at line 3595 when no provider is selected, so an
> appended block is unreachable in exactly the state the plan's own edge-case table
> says must hide the arrows ("Before selecting any source, arrows are hidden").
> Initial page load happens to look correct only because the inline `display:none`
> has not yet been overwritten; once a provider has been selected and then cleared
> (`resetTicketsInMemoryState`, provider-switch teardown), the arrows would remain
> visible and enabled over stale list arrays.
> **Replaced with:** compute and apply arrow state in a helper called from **both**
> exits of `updateTicketsSourceSummary` — structured as a single `_applyTicketsSourceArrowState()`
> invoked immediately before each `return` / at the end.

```js
function updateTicketsSourceSummary() {
    const { ticketsSourceSummary } = getTicketsTabElements();
    if (!ticketsSourceSummary) { return; }

    const provider = lastIntegrationProvider;
    if (!provider) {
        ticketsSourceSummary.textContent = '';
        _applyTicketsSourceArrowState();   // ← hides the arrows; previously unreachable
        return;
    }

    // ... existing ClickUp / Linear summary-string branches unchanged
    // (tickets.js:3598-3626) ...

    _applyTicketsSourceArrowState();
}

// Sole writer of source-arrow visibility and enabled state. Every path that can
// change provider, list, project, move-mode, or loading state must funnel here
// (directly or via updateTicketsSourceSummary) — an unrefreshed arrow is either a
// dead button or a lie about what the next click will do.
function _applyTicketsSourceArrowState() {
    const { ticketsSourcePrev, ticketsSourceNext } = getTicketsTabElements();
    if (!ticketsSourcePrev && !ticketsSourceNext) { return; }

    const provider = lastIntegrationProvider;
    const showArrows = !_moveMode && !!provider;
    let prevDisabled = true;
    let nextDisabled = true;

    if (showArrows && provider === 'clickup' && clickUpSelectedListId && !clickUpHierarchyLoading) {
        const lists = clickUpSelectedFolderId ? clickUpAvailableListsInFolder : clickUpAvailableDirectLists;
        const idx = lists.findIndex(l => l.id === clickUpSelectedListId);
        if (idx >= 0) {
            prevDisabled = idx === 0;
            nextDisabled = idx === lists.length - 1;
        }
    } else if (showArrows && provider === 'linear' && !linearProjectLoading) {
        const options = ticketsLinearProjectOptions();
        const idx = options.indexOf(linearProjectPickerValue);   // -1 = "All projects"
        prevDisabled = idx <= 0;
        nextDisabled = options.length === 0 || idx === options.length - 1;
    }

    if (ticketsSourcePrev) {
        ticketsSourcePrev.style.display = showArrows ? '' : 'none';
        ticketsSourcePrev.disabled = prevDisabled;
    }
    if (ticketsSourceNext) {
        ticketsSourceNext.style.display = showArrows ? '' : 'none';
        ticketsSourceNext.disabled = nextDisabled;
    }
}
```

**Edge cases:** `updateTicketsSourceSummary` is already called on every meaningful
transition — `renderTicketsLinearPanel` (`tickets.js:1210`),
`renderTicketsClickUpPanel` (`tickets.js:1278`), the provider selector
(`tickets.js:4594`), and the three ClickUp hierarchy reply arms (`clickupSpacesLoaded`
`tickets.js:6723`, `clickupFoldersLoaded` `tickets.js:6771`, `clickupListsLoaded`
`tickets.js:6799`). The only uncovered transitions are the two move-mode ones, fixed
next.

#### 2g. Refresh arrow state on move-mode enter and exit

**Context:** `showMoveTicketModal` is at `tickets.js:3928-4081`; `exitMoveMode` at
`tickets.js:4083-4135`.

Neither currently calls `updateTicketsSourceSummary()` unconditionally:

- `showMoveTicketModal` sets `_moveMode = true` (line 3929) and, for ClickUp, blanks
  `clickUpSelectedListId` / `clickUpAvailableListsInFolder` / `clickUpAvailableDirectLists`
  (lines 3971-3984) before calling `renderTicketsClickUpHierarchyNav()` (line 3998) —
  which rebuilds only the `<select>` markup and does **not** touch the summary. The
  arrows therefore stay visible, sitting on top of blanked arrays, until some later
  reply happens to trigger a full panel render.
- `exitMoveMode` restores the snapshot and calls `renderTicketsClickUpPanel()` — but
  only inside `if (wasClickUp && _moveHierarchySnapshot)` (line 4110). Exiting a
  **Linear** move leaves `_moveMode === false` with no render, so the arrows stay
  hidden until the next Linear render.

**Change:** add one call at the end of each function.

```js
// end of showMoveTicketModal, after the provider-specific setup blocks:
_applyTicketsSourceArrowState();

// end of exitMoveMode, outside the `if (wasClickUp && ...)` block:
_applyTicketsSourceArrowState();
```

**Edge cases:** call `_applyTicketsSourceArrowState()` directly rather than
`updateTicketsSourceSummary()` — the latter would rewrite the summary *text* from the
blanked/restored hierarchy mid-transition, which is a separate concern and a visible
flicker. Arrow state is the only thing that needs to move here.

## Verification Plan

> **Superseded:** step 10 of the original plan — "Run existing tests: `npm test` or the
> project's test command — confirm no regressions in tickets-related tests (e.g.
> `tickets-sidebar-list-scoping.test.js`, `tickets-assignee-filter-regression.test.js`)."
> **Reason:** this improve pass runs under explicit SKIP TESTS and SKIP COMPILATION
> session directives, so an automated-test step cannot be part of this verification
> plan. This is a session constraint on *how this plan is verified here*, not a claim
> that the tests are irrelevant — they remain the right regression net when the change
> is actually implemented.
> **Replaced with:** the "Automated Tests" section below, which records the suites a
> future implementer should run, plus the manual UAT steps that constitute verification
> for this pass.

### Manual verification

1. **ClickUp — basic navigation:**
   - Select a ClickUp space, folder, and a list that has sibling lists in the same folder.
   - Confirm left/right arrows appear beside the source summary.
   - Click right arrow → source summary updates to the next list name, ticket list reloads.
   - Click left arrow → returns to the previous list.
   - Confirm the status filter and assignee filter reset on each navigation (same as
     manually selecting via the dropdown), and the hierarchy `<select>` in the Source
     modal shows the navigated-to list as selected.

2. **ClickUp — boundary disabling:**
   - First list in a folder → left arrow disabled (greyed, not clickable).
   - Last list → right arrow disabled.
   - Folder with a single list → both arrows disabled.

3. **ClickUp — root lists (no folder):**
   - Select the `(Root - Lists not in any Folder)` option, pick a direct list → arrows
     navigate `clickUpAvailableDirectLists`.

4. **Linear — project navigation:**
   - Load a Linear team with multiple projects.
   - Confirm arrows appear beside the "Linear" summary.
   - Click right → **the visible project dropdown's displayed value changes too** (this
     is the regression the Change 2c callout fixes), ticket list re-filters, detail pane
     resets.
   - Click left → returns to previous project, dropdown follows.
   - Confirm `selectedLinearIssue` is cleared (detail pane shows empty state) on each
     navigation.

5. **Linear — "All projects" state:**
   - With no project selected (picker shows "All projects"), right arrow selects the
     first project; left arrow is disabled.
   - Navigate to the **last** project → confirm the right arrow becomes disabled rather
     than staying enabled and no-opping.

6. **Move mode:**
   - Open the move-ticket modal from a ClickUp ticket → arrows hide immediately on open
     (not after some later reply lands).
   - Cancel out → arrows reappear with correct enabled state.
   - Repeat from a **Linear** ticket → arrows hide on open and reappear on cancel
     (this is the `exitMoveMode` gap fixed in Change 2g).

7. **Loading states:**
   - While a ClickUp hierarchy load is in flight, arrows are disabled.
   - While a Linear project load is in flight, arrows are disabled.

8. **State persistence:**
   - Navigate to a new list/project, switch tabs and back → the navigated-to
     list/project is still selected.

9. **No source selected:**
   - Before selecting any source, arrows are hidden.
   - Switch provider so the panel returns to a no-provider state → arrows hide again
     (this is the early-return gap fixed in Change 2f).

10. **Browser host parity:**
    - Open the same Tickets panel over `npx switchboard` and repeat steps 1-2. The
      arrows are shared webview markup, so no host-specific wiring exists — this
      confirms the shared-HTML assumption rather than testing a second code path.

### Automated Tests

Not run in this pass (SKIP TESTS / SKIP COMPILATION session directives). For the
implementer:

- Existing regression suites over the same panel state that must stay green:
  `src/test/tickets-sidebar-list-scoping.test.js`,
  `src/test/tickets-assignee-filter-regression.test.js`,
  `src/test/tickets-delta-sweep-gate-regression.test.js`.
- Gates unaffected by this change (no verb surface touched), but cheap to confirm:
  `npm run verb-returns:check`, `npm run parity:check`, `npm run push-routing:check`.
- No new test is strictly required; if one is added, the highest-value assertion is
  that `_applyTicketsSourceArrowState()` disables `next` when the current list is last
  in its array and hides both arrows when `_moveMode` is true.

## Recommendation

**Send to Coder** (Complexity 4).

## Completion Summary

Implemented prev/next source navigation arrows flanking the Tickets source summary. Files changed: `src/webview/tickets.html` (added two `‹`/`›` chevron buttons with `tickets-source-nav-btn` class + one CSS rule overriding `.strip-btn`'s uppercase/letter-spacing) and `src/webview/tickets.js` (added `ticketsSourcePrev`/`ticketsSourceNext` element accessors; extracted `selectClickUpList` and `selectLinearProject(syncPicker)` shared helpers and reduced the list-select and project-picker change handlers to call them; added `ticketsLinearProjectOptions` + `navigateTicketsSource` + click-handler wiring in `initTicketsTab`; made `updateTicketsSourceSummary` the sole writer of arrow state via `_applyTicketsSourceArrowState` invoked at both exits; added `_applyTicketsSourceArrowState()` calls at the end of `showMoveTicketModal` and `exitMoveMode`). Verified with `node --check` (syntax clean); no compilation or automated tests run per session SKIP directives. No issues encountered — all line references in the plan were accurate up to a ~+27 line shift from pre-existing uncommitted edits, resolved by reading the live code before each edit.

## Review Findings

Implementation matches the plan; the extraction of `selectClickUpList` / `selectLinearProject` is faithful to the original handler bodies and the `syncPicker` flag is genuinely required (`renderTicketsLinearList` does not call `renderTicketsLinearProjectPickerOptions`). One MAJOR gap the plan's own transition audit missed: `restoreTicketsStateForRoot` (`src/webview/tickets.js:4377`) writes three of the four arrow inputs — `lastIntegrationProvider`, `clickUpSelectedListId`, `linearProjectPickerValue` — and its `restoredTabState` callers do not render afterwards, so a root switch left the previous root's arrows visible and potentially dead-clicking (PRD #6); fixed by adding `_applyTicketsSourceArrowState()` at its end (arrow state only, not the summary text, which would show a stale list name mid-restore). Also fixed: the static `title`/`aria-label` said "list" in Linear mode where the arrows walk projects — now provider-derived in the sole arrow-state writer. Files changed by this review: `src/webview/tickets.js` only. Verification (all green, executed — not static-only): `tickets-sidebar-scoping`, `tickets-assignee-filter`, `tickets-delta-sweep-gate`, `panel-runtime-surface`, `tickets-auto-refresh`, `tickets-subtasks`, `tickets-cross-panel-scope`, `verb-engine-tickets`, plus `parity:check`, `push-routing:check`, `verb-returns:check` (Tickets 56/56), `catalog:check`, `compile-tests`, `lint` (0 errors), `webpack compile`; gate-wiring audit confirms all three plan-named tickets suites are invoked in CI via their npm aliases (`integration-tests.yml:251, 260, 326`). Remaining risks are cosmetic and deferred: `showMoveTicketModal`'s `if (!modal) return` skips the arrow refresh with `_moveMode` already true (unreachable — static markup), `exitMoveMode` double-calls the idempotent arrow writer on the ClickUp branch, and manual UAT steps 1–10 (including browser-host parity) are unexecuted — note the browser host serves `dist/webview/tickets.html` in preference to `src/`, so UAT requires a rebuilt VSIX.
