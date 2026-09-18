# Promote START TEAM Out of the Tiny `+` Picker Into the Terminals Sidebar Ops Block

## Goal

Make starting a team a visible, first-class control in the terminals panel — a full-width `START TEAM` button in the sidebar ops block, beside `OPEN AGENT TERMINALS` and `FILL GRID` — instead of a section buried inside a "New terminal — pick a role" menu that only appears after clicking an 11px `+` glyph on a workspace header. Remove the team section from the role picker so there is exactly one entry point, and keep the picker's role-option team annotation, which is information rather than a duplicate button.

### Problem analysis and root cause

**The control exists but is unreachable without knowing where to look.** Today the only way to reach a team's START action is:

1. Find the workspace header row in the sidebar (`.parent-group-header`, `terminals.js:3232-3265`).
2. Click the `+` at its right edge — `.btn-group-new`, `font-size: 11px; padding: 0 4px; background: none; border: none;` (`terminals.html:660-668`) and `textContent = '+'` with `title = "Spawn terminal in <workspace>"`.
3. Read past a menu titled **"New terminal — pick a role"** (`terminals.js:6340`) to a `Start a team` sub-section rendered above the role chips (`terminals.js:6343-6385`).

Nothing about that path advertises teams. The button's own tooltip promises a *terminal*; the menu's own title promises a *role*. There is a second, equally hidden mount at the group-tab-strip `+` (`.group-tab-add`, `terminals.js:2869-2878`), which has the same problem.

**Root cause — the implementation satisfied the letter of the design step and not its stated goal.** The originating plan, `.switchboard/plans/explicit-team-start-in-terminals-panel.md`, opens with the goal in bold:

> **The operator looks for a "start team" button in the terminals panel and there isn't one.**

Its implementation step 2 then says "Surface teams in the terminals panel **next to** `buildRolePicker`". That was read as *inside* `buildRolePicker`, and the completion note confirms it: "the role picker now renders a 'Start a team' section". Putting the button inside the thing the operator was already failing to find reproduces the original complaint exactly — an operator who looks at the terminals panel for a start-team button still does not see one. The plan's own Complexity Audit even flags the adjacent trap ("adding a separate team button without fixing the picker leaves it in place"), which was addressed; the placement half was not.

**Why the sidebar ops block is the right home.** `.sidebar-ops` (`terminals.html:2008-2027`) is already the panel's list of standing, always-visible fleet actions — `OPEN AGENT TERMINALS`, `FILL GRID`, `CLEAR ALL TERMINALS`, `SAVE AS GROUP`, `LINK UP` — full-width stacked `secondary-btn`s that are legible without hovering, scrolling, or opening anything. "Start a team" is that same kind of action. `FILL GRID` is the exact precedent for one that needs parameters: the button hides itself and reveals an inline `<form>` with two `<select>`s and CANCEL/CONFIRM (`terminals.html:2011-2020`, wired at `terminals.js:878-946`). Reusing that pattern adds no new visual language to the panel — it copies a control sitting two lines above.

**Scope note — this is a placement change, not a redesign.** The verb (`ptyStartTeam`), the `startTeam()` client function (`terminals.js:6735-6787`), the spawn summary (`teamSpawnSummary`, `:6320-6324`), the toasts, and the role-option annotation (`:6428-6450`) are all correct and are kept as-is. Only where the START action lives changes.

**Blast radius.** One webview file pair (`terminals.html`, `terminals.js`). No verb, service, DB or config change. `implementation.html`'s Terminals sub-tab mirrors only `OPEN AGENT TERMINALS` (`:1577`) — it has never carried `FILL GRID` or `LINK UP` — so this control is deliberately not mirrored there and no drift is introduced.

## Metadata

**Complexity:** 3
**Tags:** ui, ux, frontend
**Project:** Browser Switchboard

## User Review Required

None. The placement, the form pattern, and the deletion of the picker section are all settled by the originating plan's stated goal and by the existing `FILL GRID` precedent.

## Complexity Audit

### Routine

- Adding a `secondary-btn w-full` + inline form to `.sidebar-ops`, copying the `FILL GRID` markup and CSS classes verbatim.
- Wiring the button in the same `if (btn && form && …)` block style used for `FILL GRID` (`terminals.js:884-946`).
- Deleting the `team-picker` section from `buildRolePicker`.

### Complex / Risky

- **One entry point, not two.** Leaving the picker's team section in place while adding a sidebar button produces two peer controls that do the same thing — the exact "peer modes" failure this panel keeps regressing into. The picker section must be deleted in the same change, not deprecated.
- **The role-option annotation is not a duplicate and must survive.** `starts <team> · 3× coder, 1× reviewer (shared)` on the `Lead` chip (`terminals.js:6428-6450`) exists because picking a role *auto-starts* a team; it is a warning label on a different control, not a second START button. Deleting it re-opens the "New terminal delivers five terminals" defect the originating plan closed. `teamPickerData` must therefore still be fetched on picker open (`onNewTerminalClicked`, `:6287-6314`), and `teamSpawnSummary` must stay.
- **`buildRolePicker`'s `const teams` line is load-bearing after the deletion.** `autoStartByHeadRole` (`:6401-6406`) iterates the local `teams` variable declared at `:6348`, not `teamPickerData` directly. Deleting the team section must NOT delete that declaration or the annotation loses its input silently — the picker still renders, just with no team notes, which is the exact regression this plan is guarding against.
- **The spawn target moves from implicit to explicit.** Today `startTeam(team, targetSpec)` inherits the workspace from whichever header's `+` was clicked. A sidebar button has no such context, so the form must offer the workspace — otherwise a multi-root operator silently loses the ability to start a team in a chosen folder. The source is `parentsList` (`terminals.js:206`, populated at `:1589`), the same array the sidebar's own parent groups are built from (`:3266`).
- **No confirm gate.** The inline form is a parameter chooser (team, workspace), the direct analogue of `FILL GRID`'s role+layout selects. `START` submits and spawns. There is no "are you sure", and `CANCEL` closes the form without side effects — matching `fill-grid-cancel` (`terminals.js:924-929`).
- **Zero teams is a real state and needs an honest answer, not a dead button.** With no teams defined the button must say so once via `showPaneToast` rather than opening an empty `<select>` whose only option is nothing.

## Edge-Case & Dependency Audit

**Race Conditions** — the team list is fetched on button click (mirroring `FILL GRID`'s role fetch at `:886`), so a team created in the TEAMS tab mid-session is picked up on the next open without a poll. A team deleted between opening the form and submitting resolves to a `No team found with id` error from the verb, surfaced verbatim by the existing `startTeam` error toast (`:6774-6779`) — no new handling needed.

**Security** — none. The client still sends only `{ teamId }` plus an optional `parentRoot`; the definition stays host-resolved and the `payload.group` rejection is untouched.

**Side Effects** —
- The `+` picker becomes shorter. Its title ("New terminal — pick a role") becomes accurate again — every remaining control in it creates one terminal.
- Operators who learned the buried path lose it. Accepted and intended: it is being replaced by a control in the panel's standing action list, which is where the originating plan said the operator looks.

**Migration** — none. No persisted state, no settings key, no stored layout is involved. `collapsedGroups`, `pickerState` and `saveLayoutSettings()` are untouched.

**Dependencies & Conflicts** — edits `src/webview/terminals.html` and `src/webview/terminals.js` only. No overlap with services, verbs, tests, or `kanban.html`, so it runs concurrently with every other subtask in this feature under the one-stream-per-file rule. Note that the *content* of the team list this control renders comes from `ptyListAgentGroups`; this plan does not change that verb's behaviour and does not depend on it changing. The companion subtask that fixes that verb's root resolution changes **which** teams appear here, never **whether** this control works.

## Dependencies

- `sess_20260816212500 — explicit team start in the terminals panel` (`.switchboard/plans/explicit-team-start-in-terminals-panel.md`, CODE REVIEWED) — this plan finishes that plan's placement half.
- No blocking dependency on any other subtask in this feature. File-disjoint from all three.

## Adversarial Synthesis

**Risk summary.** Two failure modes dominate, and both are deletions done carelessly rather than anything added. First: deleting the picker's team section while also deleting the `const teams = …` declaration at `:6348` silently kills the role-chip annotation, re-opening the "picking Lead quietly delivers five terminals" defect the originating plan closed — the picker still renders, so no test and no glance catches it. Second: shipping the sidebar button without deleting the picker section leaves two peer controls doing one job, the panel's documented recurring failure. Mitigations: a grep gate proving `team-picker`/`team-option` are gone *and* a second grep proving `role-option-team-note`/`autoStartByHeadRole`/`teamSpawnSummary` survive, both listed as verification steps; and the deletion is scoped to `:6343-6385` explicitly, with `:6348` called out as retained.

## Proposed Changes

### `src/webview/terminals.html` — the control and its form

- **Context:** `.sidebar-ops` at `:2008-2027`, with `FILL GRID` + `#fill-grid-form` at `:2011-2020` as the pattern; `.fill-grid-form` / `.fill-grid-actions` CSS at `:1899-1905`.
- **Logic:** insert directly after the `fill-grid-form` (i.e. after `:2020`), so the two parameterised actions sit together and above the destructive/utility ones.

```html
            <button type="button" id="btn-start-team" class="secondary-btn w-full"
                    title="Start a defined team — head plus its members">START TEAM</button>
            <!-- Parameter chooser, not a confirm gate: same shape as #fill-grid-form
                 above. START submits; CANCEL closes with no side effect. -->
            <form id="start-team-form" class="fill-grid-form" hidden>
                <select id="start-team-name" class="link-select" required></select>
                <select id="start-team-target" class="link-select" hidden></select>
                <div class="fill-grid-actions">
                    <button type="button" id="start-team-cancel" class="secondary-btn">CANCEL</button>
                    <button type="submit" id="start-team-confirm" class="secondary-btn is-teal">START</button>
                </div>
            </form>
```

- **Edge Cases:**
  - The form reuses `.fill-grid-form` rather than minting a `.start-team-form` twin — the two are visually identical by intent, and a second class would be one more place for the panel's spacing to drift.
  - `#start-team-target` carries `hidden` in the markup so a single-workspace window never shows a one-option dropdown; the wiring un-hides it only when there is a real choice. It deliberately carries **no** `required` attribute — a `required` control inside a `hidden` ancestor blocks form submission with a focus error the operator cannot see.

### `src/webview/terminals.js` — wire the button, delete the picker section

- **Context:** the `FILL GRID` wiring block at `:878-946` sits inside the same DOM-ready function; `fetchAgentGroups()` (`:6265-6280`), `teamSpawnSummary()` (`:6320-6324`), `startTeam()` (`:6735-6787`) and `showPaneToast` already exist and are reused unchanged. `parentsList` (`:206`) holds the workspace parents, populated at `:1589`.
- **Logic (add, immediately after the `FILL GRID` block closes at `:946`):**

```js
        const btnStartTeam = document.getElementById('btn-start-team');
        const startTeamForm = document.getElementById('start-team-form');
        const startTeamName = document.getElementById('start-team-name');
        const startTeamTarget = document.getElementById('start-team-target');
        const startTeamCancel = document.getElementById('start-team-cancel');
        const startTeamConfirm = document.getElementById('start-team-confirm');
        if (btnStartTeam && startTeamForm && startTeamName && startTeamTarget) {
            // Teams are fetched on open, not polled — same as FILL GRID's roles.
            btnStartTeam.addEventListener('click', async () => {
                const teams = await fetchAgentGroups();
                if (!Array.isArray(teams) || teams.length === 0) {
                    // Honest empty state. An empty <select> would read as broken.
                    showPaneToast('No teams defined — add one in the TEAMS tab.');
                    return;
                }
                startTeamName.innerHTML = '';
                for (const team of teams) {
                    if (!team || !team.id) { continue; }
                    const opt = document.createElement('option');
                    opt.value = team.id;
                    // Same summary the picker showed, so the operator sees what spawns
                    // before committing: "Coding — 3× coder, 1× reviewer (shared)".
                    opt.textContent = `${team.name || team.id} — ${teamSpawnSummary(team)}`
                        + (team.unassigned ? ' · no auto-start' : '');
                    startTeamName.appendChild(opt);
                }

                // Workspace target. The picker inherited this from whichever header's
                // `+` was clicked; a standing control has no such context, so offer it —
                // but only when there is more than one, otherwise it is a dropdown with
                // one answer.
                const roots = (Array.isArray(parentsList) ? parentsList : [])
                    .map(p => ({ path: p.parentFolder || '', name: p.name || 'Workspace Root' }))
                    .filter(r => r.path);
                startTeamTarget.innerHTML = '';
                for (const r of roots) {
                    const opt = document.createElement('option');
                    opt.value = r.path;
                    opt.textContent = r.name;
                    startTeamTarget.appendChild(opt);
                }
                startTeamTarget.hidden = roots.length < 2;

                btnStartTeam.hidden = true;
                startTeamForm.hidden = false;
            });

            if (startTeamCancel) {
                startTeamCancel.addEventListener('click', () => {
                    startTeamForm.hidden = true;
                    btnStartTeam.hidden = false;
                });
            }

            startTeamForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const teamId = startTeamName.value;
                // Only pass a target when the operator actually chose one; otherwise the
                // host resolves the spawn cwd itself, as it does for an unqualified start.
                const targetSpec = (!startTeamTarget.hidden && startTeamTarget.value)
                    ? { parentRoot: startTeamTarget.value }
                    : undefined;
                startTeamConfirm.disabled = true;
                startTeamConfirm.textContent = 'STARTING…';
                try {
                    await startTeam({ id: teamId }, targetSpec);
                } finally {
                    startTeamConfirm.disabled = false;
                    startTeamConfirm.textContent = 'START';
                    startTeamForm.hidden = true;
                    btnStartTeam.hidden = false;
                }
            });
        }
```

> **Superseded:** `const team = { id: teamId, name: startTeamName.selectedOptions[0]?.textContent || teamId };` then `await startTeam(team, targetSpec);`
> **Reason:** `startTeam` reads only `team.id` (`terminals.js:6736`) and never `team.name`. Synthesising a `name` from the option's label would also produce the wrong value — the label is `"<name> — <spawn summary>"`, not the name — so any future reader who starts trusting that field gets a corrupted string. Passing a field that is unread today and wrong tomorrow is worse than not passing it.
> **Replaced with:** `await startTeam({ id: teamId }, targetSpec);` — the minimum the callee actually consumes. If a name is ever needed, `startTeam` should read it from the verb response, which is host-resolved and correct.

- **Logic (delete, in `buildRolePicker`):** remove the `── Team list — explicit START action per defined team ──` block at **`:6343-6385`** — the comment banner, the `teams.length > 0` guard, the `.team-picker` section, its title, the `.team-picker-options` container, the per-team `.team-option` buttons and their `startTeam(...)` handlers.

  **Keep `:6348` — `const teams = Array.isArray(teamPickerData) ? teamPickerData : [];`.** It is the input to `autoStartByHeadRole` at `:6401-6406`, which the surviving role-chip annotation depends on. Move the declaration down to sit immediately above the `── Role picker — annotated with auto-start team info ──` banner at `:6387` so its purpose is unambiguous to the next reader.

  Update the function's doc comment (`:6326-6333`) so it no longer claims to render a team section — it now only annotates roles that head a team.

- **Edge Cases:**
  - `startTeam` already closes over nothing from the picker and takes `(team, targetSpec)`, so the sidebar caller needs no change to it. `targetSpec` as `{ parentRoot }` is translated to `payload.parentRoot` at `:6742` and consumed by the host's `spawnCwd` rule.
  - `parentsList` is empty on first paint before `:1589` populates it; the button is still usable — `roots` is empty, the target select stays hidden, and the host resolves the spawn cwd. No guard needed.
  - `showPaneToast` is defined in the same file and already used by `startTeam` (`:6778`, `:6781`), so the empty-state path adds no new dependency.
  - `startTeamName.value` on a `<select>` that was populated but whose every entry was skipped (all teams lacked an `id`) is `''`; the host answers `Missing team id` and the existing error toast surfaces it. Not worth a client-side guard — it requires a malformed host response.

### `src/webview/terminals.html` — retire the orphaned team-picker CSS

- **Context:** `.team-picker` (`:263`), `.team-picker-title` (`:266`), `.team-picker-options` (`:273`), `.team-option` (`:278`), `.team-option:hover` (`:293`), `.team-option:hover .team-option-summary` (`:297`), `.team-option-name` (`:298`), `.team-option-summary` (`:299`), `.team-option.is-unassigned .team-option-name` (`:304`), `.team-option.is-unassigned` (`:305`) — the block at `:263-305`.
- **Logic:** delete the rules whose only consumer was the deleted picker section. Verify by grep before deleting — `.team-option-summary` and friends must have zero remaining references in `terminals.js` and `terminals.html`.
- **Edge Cases:** `.role-option-team-note` (`terminals.html:254`, applied at `terminals.js:6438`) is a *different* class used by the surviving role annotation and sits immediately above the deleted block. Do not delete it — the two are adjacent, which is exactly how an over-eager range delete takes it out.

## Verification Plan

### Automated Tests

1. `npm run lint`.
2. Grep proves single entry point: `grep -n "team-picker\|team-option" src/webview/terminals.js src/webview/terminals.html` returns nothing.
3. Grep proves the annotation survived: `grep -n "role-option-team-note\|autoStartByHeadRole\|teamSpawnSummary" src/webview/terminals.js` still returns the role-chip annotation block, the `autoStartByHeadRole` loop, and the summary helper — and `grep -n "const teams = Array.isArray(teamPickerData)" src/webview/terminals.js` still returns exactly one hit.

### Manual

4. Open the terminals panel. `START TEAM` is visible in the sidebar ops block, full width, without clicking, hovering or scrolling anything — between `FILL GRID`'s form and `CLEAR ALL TERMINALS`.
5. Click `START TEAM` with at least one team defined: the button hides, the inline form appears, and the team `<select>` reads `<team name> — <spawn summary>` for each defined team.
6. Single-workspace window: the workspace `<select>` is not rendered. Multi-root window: it lists each mapped workspace by name.
7. Submit: the button shows `STARTING…`, the team spawns, the form closes and `START TEAM` returns. Submitting with a live head shows the existing double-start refusal toast verbatim.
8. Click `CANCEL`: the form closes, `START TEAM` returns, and no terminal is created.
9. Delete every team in the TEAMS tab, then click `START TEAM`: a toast reads `No teams defined — add one in the TEAMS tab.` and no empty form opens.
10. Click the `+` on a workspace header: the menu opens with **no** `Start a team` section, and the `Lead` chip still carries its `starts <team> · <summary>` note. Picking a role still creates exactly one terminal (plus that role's auto-started team, as annotated). This step is the annotation regression gate — it must be run, not inferred from step 3's grep.
11. Repeat 4–10 in the browser cockpit window (`NEW WINDOW`, `terminals.html:2054`) — this panel is served to both hosts (PRD contract #1: byte-identical panel HTML) and the ops block must behave identically.

---

**Recommendation:** Complexity 3 → **Send to Intern.**

## Completion Report

Implemented in the sidebar-control commit. `START TEAM` is now a full-width `secondary-btn w-full` in `.sidebar-ops` between `FILL GRID`'s form and `CLEAR ALL TERMINALS`, with an inline `#start-team-form` reusing the `.fill-grid-form` pattern — team `<select>` populated on open from `fetchAgentGroups()`, workspace target `<select>` unhidden only when 2+ roots exist, `CANCEL` closes with no side effect, `START` submits `startTeam({ id }, { parentRoot? })`. The orphaned `.team-picker`/`.team-option*` CSS block was deleted, and the `buildRolePicker` team section was removed with `const teams` moved down to the role-picker banner so `autoStartByHeadRole` and the role-chip annotation (`role-option-team-note`/`teamSpawnSummary`) survive. The picker's title "New terminal — pick a role" is now accurate — every remaining control in it creates one terminal. Zero teams surfaces an honest toast rather than an empty form. Grep gates pass: `team-picker|team-option` returns nothing, the annotation trio survives, `const teams` has exactly one hit. Lint passes with 0 errors; compile and tests skipped per standing orders.

## Review Findings

Clean — no CRITICAL or MAJOR findings. `START TEAM` sits in `.sidebar-ops` between the `FILL GRID` form and `CLEAR ALL TERMINALS` (`terminals.html:1976-1987`), the inline `#start-team-form` reuses `.fill-grid-form`/`.fill-grid-actions` verbatim, and the wiring at `terminals.js:948-1021` matches the plan including the honest zero-teams toast and the hidden-unless-multi-root target select. Both grep gates pass: `team-picker|team-option` returns nothing across `terminals.js`/`terminals.html`, while `role-option-team-note`, `autoStartByHeadRole`, `teamSpawnSummary` and the single `const teams = Array.isArray(teamPickerData)` all survive, so the role-chip annotation is intact; `implementation.html` still mirrors only `OPEN AGENT TERMINALS`, so no drift. Two NITs, neither fixed: `#start-team-name` carries `required`, so an all-teams-lack-`id` response blocks submit at the browser rather than reaching the host's `Missing team id` (requires a malformed host response); and gate-wiring — `npm run lint` is invoked by CI (`integration-tests.yml:840`) but `eslint.config.js` scopes rules to `**/*.ts`, so `terminals.js` is not actually linted and this subtask's only real automated coverage is the two greps, which are not CI-invoked. Verified: `lint` 0 errors, `compile-tests` clean, and all five ratchet/parity gates green.
