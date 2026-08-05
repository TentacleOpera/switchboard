# Design Panel: Stitch HTML Source Must Default to the Project Showing in the Stitch Tab

## Goal

When the Previews tab's source is switched to **Stitch HTML**, seed its project picker from whatever project the STITCH tab currently has selected, instead of leaving it on `Select Project...`.

### Problem Analysis & Root Cause

The Design panel holds **two independent Stitch project selections** in `src/webview/design.js`:

| State | Dropdown | Set by |
| --- | --- | --- |
| `state.selectedStitchProjectId` | `#stitch-project-select` (STITCH tab) and `#design-system-project-select` | user change handlers at `design.js:2731-2739` and `:2726-2737`; project-create response at `:3736-3742` |
| `state.selectedStitchHtmlProjectId` | `#stitch-html-project-select` (Previews → Stitch HTML) | user change handler at `design.js:4484-4488`; gallery deep link at `:2387-2392` |

`selectPreviewsSource('stitch-html')` populates the Stitch HTML dropdown from `state.stitchProjects` (`design.js:189-193`), and `populateStitchHtmlProjectSelect` selects only what `state.selectedStitchHtmlProjectId` already holds (`design.js:1086-1102`):

```js
const current = state.selectedStitchHtmlProjectId || '';
select.innerHTML = '<option value="">Select Project...</option>';
sorted.forEach(p => { …; if (p.id === current) opt.selected = true; … });
select.value = current;
```

`state.selectedStitchHtmlProjectId` is initialised empty and is only ever written by the two paths in the table above. So the common flow — pick a project in STITCH, browse its screens, then switch Previews to Stitch HTML — leaves the Stitch HTML picker at `Select Project...`, the sidebar showing *"Select a project to browse cached HTML"*, and the status line reading *"No project selected"*. The user has to re-pick the same project they are already looking at one tab over.

The one path that *does* bridge the two is the gallery's per-screen HTML button (`design.js:2384-2392`), which explicitly copies `screen.projectId` into `state.selectedStitchHtmlProjectId` before navigating. That proves the bridge is desirable and that the plumbing (`stitchHtmlListDocs` + `persistTab('stitchHtml.projectId', …)`) already exists — it is just not reached when the user switches source by hand.

**Root cause:** the two selections were modelled as fully independent with no default relationship, and only one navigation path (the deep link) bothers to relate them. Switching source is a navigation event too, and it has no seeding step.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, ux
- **Project:** Browser Switchboard
- **Files touched:** `src/webview/design.js`
- **Risk:** Low — one seeding step on an existing code path. Does not touch the STITCH tab's own selection, and must not override an explicit Stitch HTML choice.

## User Review Required

None. "Default to whatever is showing in the stitch tab" defines the behaviour precisely: seed when unset, never clobber an explicit choice.

## Complexity Audit

### Routine
- In `selectPreviewsSource`, when the source becomes `stitch-html` and `state.selectedStitchHtmlProjectId` is empty, copy `state.selectedStitchProjectId` into it before populating the dropdown.
- Fire `stitchHtmlListDocs` for the seeded project so the sidebar fills.

### Complex / Risky
- **Seed vs. clobber.** The two selections must stay independently *steerable*: a user who deliberately points Stitch HTML at project B while STITCH shows project A must keep B across source switches. So the seed is conditional on the Stitch HTML selection being empty — never an unconditional mirror.
- **Persistence interaction.** `stitchHtml.projectId` is persisted per workspace root (`design.js:4486-4488`) and restored… nowhere. A seed that also persists could permanently pin a value the user never chose. **Decision: seed in memory and persist it**, matching what the deep link already does (`design.js:2388-2390` persists `screen.projectId`). Consistency with the existing bridge beats a special case, and the value is a UI convenience that the user can change with one click.
- **Message-count discipline.** `selectPreviewsSource` deliberately posts exactly one `activeTabChanged` and one `stitchListProjects` on this branch; the comment at `design.js:2396-2402` records that duplicating them costs a real Stitch API call. The seed must add at most one local `stitchHtmlListDocs`, not a second `stitchListProjects`.

## Edge-Case & Dependency Audit

1. **STITCH tab has no project selected.** `state.selectedStitchProjectId` is `''` → nothing to seed; behaviour is unchanged (`Select Project...`). No spurious `stitchHtmlListDocs` with an empty id.
2. **Stitch HTML already has a selection.** Skip the seed entirely — including when it differs from the STITCH tab. Verified by UAT step 5.
3. **Seeded project not present in `state.stitchProjects`.** `populateStitchHtmlProjectSelect` sets `select.value = current`; if no option matches, the browser resolves to the empty first option, leaving the dropdown blank while state says otherwise. Guard: only seed when `state.stitchProjects` contains that id, and clear the seed if it does not.
4. **Projects not loaded yet.** `selectPreviewsSource` populates from the possibly-empty `state.stitchProjects` and *then* posts `stitchListProjects`; the response handler re-runs `populateStitchHtmlProjectSelect` (`design.js:3725-3726`). The seed must therefore also be applied — or re-checked — when that response lands, otherwise a cold open seeds against an empty list and drops the value. Apply the same conditional seed in the `stitchProjectsReady` arm just before `populateStitchHtmlProjectSelect`.
5. **Workspace switch.** `#stitch-workspace-filter` change resets `state.selectedStitchProjectId = ''` (`design.js:4137`) but does **not** reset `state.selectedStitchHtmlProjectId`, leaving a stale cross-workspace id. Clear `selectedStitchHtmlProjectId` there too, so the next seed is honest about which workspace it came from.
6. **Edit bar.** The Stitch HTML edit bar is hidden until a file from the selected project is opened (`design.js:4491-4493`); seeding only selects a project, so the bar correctly stays hidden.
7. **Deep-link path untouched.** The gallery button sets `state.previewsSource = 'stitch-html'` and `selectedStitchHtmlProjectId` *before* clicking the tab; the seed's "already set" guard makes it a no-op there.

## Dependencies

- None

## Adversarial Synthesis

Key risks: the seed clobbering an explicit Stitch HTML choice, seeding an id absent from the loaded project list (`select.value` silently resolves to the empty option, desyncing dropdown from state), a cold open seeding against an empty `state.stitchProjects` and dropping the value, and adding a second Stitch API call to the source-switch path. Mitigations: seed only when the Stitch HTML selection is empty, validate the candidate against the loaded list, re-attempt on `stitchProjectsReady`, clear the Stitch HTML selection on workspace switch, and post at most one local `stitchHtmlListDocs`. Shared surfaces with the sibling restore plan (`stitchProjectsReady` arm, `#stitch-workspace-filter` reset) — merged end-state recorded below; land the restore plan first.

## Proposed Changes

### `src/webview/design.js`

**1. Extract the seeding rule** (new helper, placed next to `populateStitchHtmlProjectSelect` around line 1085):

```js
/**
 * Seed the Stitch HTML project picker from the STITCH tab's selection.
 *
 * Conditional on purpose: the two selections stay independently steerable, so a
 * user who points Stitch HTML at a different project than the gallery keeps it.
 * Only seeds a project the loaded list actually contains — populateStitchHtml-
 * ProjectSelect assigns select.value directly, and an id with no matching option
 * silently resolves to the empty option, desyncing the dropdown from state.
 * Returns true when a seed was applied (caller then needs the docs list).
 */
function seedStitchHtmlProjectFromStitchTab() {
    if (state.selectedStitchHtmlProjectId) { return false; }
    const candidate = state.selectedStitchProjectId || '';
    if (!candidate) { return false; }
    const projects = state.stitchProjects || [];
    if (!projects.some(p => p.id === candidate)) { return false; }
    state.selectedStitchHtmlProjectId = candidate;
    if (state.stitchWorkspaceRoot) {
        persistTab('stitchHtml.projectId', candidate, state.stitchWorkspaceRoot);
    }
    return true;
}
```

**2. `selectPreviewsSource`** (line 189-196) — seed before populating, and list docs only if seeded:

```js
if (state.previewsSource === 'stitch-html') {
    const seeded = seedStitchHtmlProjectFromStitchTab();
    populateStitchHtmlProjectSelect(state.stitchProjects || []);
    if (seeded) {
        // Local cache read, not a Stitch API call — safe to add alongside the
        // single stitchListProjects this branch already posts.
        vscode.postMessage({
            type: 'stitchHtmlListDocs',
            projectId: state.selectedStitchHtmlProjectId,
            workspaceRoot: state.stitchWorkspaceRoot
        });
    }
    vscode.postMessage({
        type: 'stitchListProjects',
        workspaceRoot: state.stitchWorkspaceRoot
    });
}
```

**3. `stitchProjectsReady` handler** (line 3724-3726) — re-attempt the seed once the list exists, for the cold-open case:

**Shared surface:** the sibling plan *Stitch Project Picker Must Restore the Last Active Project* rewrites this same arm (validated resolver in `populateStitchProjects` + a `_lastScreensFetchProjectId` idempotency guard on the auto-load branch). Apply both sets of edits to the one arm; the merged end-state is: resolver-driven `populateStitchProjects` → this seed attempt → `populateStitchHtmlProjectSelect` → the sibling's idempotent auto-fetch. The feature's recommended sequence lands the restore plan first, which also means `state.selectedStitchProjectId` is almost always set when this seed runs — the common case this plan exists for.

```js
populateStitchProjects(state.stitchProjects, msg.defaultProjectId);
if (state.previewsSource === 'stitch-html' && seedStitchHtmlProjectFromStitchTab()) {
    vscode.postMessage({
        type: 'stitchHtmlListDocs',
        projectId: state.selectedStitchHtmlProjectId,
        workspaceRoot: state.stitchWorkspaceRoot
    });
}
populateStitchHtmlProjectSelect(state.stitchProjects);
```

**4. Workspace-filter reset** (line 4128-4148) — clear the Stitch HTML selection alongside the Stitch one so a later seed cannot inherit a foreign-workspace id. **Shared surface:** the sibling restore plan resets `_lastScreensFetchProjectId = ''` in this same handler — additive, apply both.

```js
state.selectedStitchProjectId = '';
// Same reason: a project id is workspace-scoped, and this picker is seeded
// from the Stitch tab's selection.
state.selectedStitchHtmlProjectId = '';
const shSelect = document.getElementById('stitch-html-project-select');
if (shSelect) { shSelect.value = ''; }
```

## Verification Plan

### Automated Tests

None run — the dispatch directive excludes compilation and automated tests from this verification. Signal comes from the UAT below.

1. **UAT — the reported flow.** STITCH tab → select project *Alpha* and let its screens load. Switch to Previews → source `Stitch HTML`. The project picker reads *Alpha*, the status line is not "No project selected", and the sidebar lists Alpha's cached HTML files (or Alpha's "No cached HTML for this project yet" message).
2. **UAT — no STITCH selection.** With STITCH on `Select Project...`, switch Previews to Stitch HTML: picker stays on `Select Project...` and the sidebar shows the "Select a project" empty state. No error, no empty-id fetch.
3. **UAT — cold open.** Reload the panel, go straight to Previews → Stitch HTML before the Stitch project list has loaded. Once `stitchProjectsReady` lands, the picker shows the STITCH tab's project and its files appear.
4. **UAT — explicit choice is not clobbered.** STITCH on *Alpha*; in Previews → Stitch HTML manually select *Beta*. Switch source to `HTML Previews` and back to `Stitch HTML`: it must still read *Beta*.
5. **UAT — STITCH selection is not disturbed.** After the seed, return to the STITCH tab: its project is unchanged and its gallery is intact.
6. **UAT — workspace switch.** With Stitch HTML seeded to *Alpha* in workspace 1, switch `#stitch-workspace-filter` to workspace 2: both pickers reset to `Select Project...`; no workspace-1 project id is offered.
7. **UAT — API-call count.** Switching source to Stitch HTML must still trigger exactly one Stitch project list refresh (unchanged from today), plus at most one local `stitchHtmlListDocs`.
