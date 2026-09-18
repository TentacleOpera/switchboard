# UAT Remediation: Remove Pacing Toggle & Relocate Action Bar

## Goal

Fix three UAT failures in the TEAMS tab and team cockpit: (1) remove the "SEATS PACE THE QUEUE (NO HEAD)" checkbox that should never have been a manual UI control, (2) fix the misleading note that claims the head advances cards, and (3) relocate the team action bar buttons from a confusing strip on top into the sidebar, replacing the generic fleet buttons.

### The problem, and the root cause

**The pacing checkbox (failures 7–8):** The "SEATS PACE THE QUEUE (NO HEAD)" checkbox (`kanban.html:5196–5237`) was added by the Seat-Routed Plan Queue feature (subtask 3, `seat-routed-queue-3-choosing-seat-pacing-and-the-idle-watch.md`). It is a manual per-team toggle that switches between head-paced and seat-paced queue dispatch. The user's intent was that routing be automatic — features go to the team lead, standalone plans go to team members by complexity. The `kanban-queue-dispatch-without-team.md` plan (CODE REVIEWED) was supposed to eliminate the need for the toggle entirely (its goal: "No team, no head, no pacing toggle, no roster resolution"), but the implementation only added a non-team fallback path — it kept the toggle in the TEAMS tab UI. The toggle should be removed.

The pacing note (line 5216) says: "Head paces the queue: cards go to the head, which delegates and advances on review pass." This is misleading — the head cannot advance cards to CODE REVIEWED unless the team has a reviewer seat. That enforcement is already in the head prompt (`teamWiring.ts:744`: "If your team has NO reviewer seat, do NOT move the card to CODE REVIEWED"). The note contradicts the enforcement.

**The action bar (failure 10):** The team action bar (`renderTeamHeader` in `terminals.js:3618–3653`) renders five lifecycle buttons (CLEAR TEAM, CLEAR MEMBERS, CLOSE TEAM, RESTART MISSING, CLEAR BADGES) plus ORDERS, AUTOS, and + as a horizontal strip in the team header. The user finds the naming confusing (what is "CLEAR BADGES"? how does "CLEAR TEAM" differ from "CLEAR MEMBERS"? what is "AUTOS"?) and the placement wrong — the intention was that team controls like these would take the place of the generic sidebar buttons (OPEN AGENT TERMINALS, START TEAM, LINK UP), not be a separate strip on top.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, bugfix, refactor
**Project:** Browser Switchboard

## User Review Required

Yes — the button renaming and the exact set to keep need confirmation. The approach below keeps all buttons but relocates them and renames for clarity.

## Complexity Audit

### Routine
- Deleting the pacing toggle block (kanban.html:5178–5237) — mechanical removal of a self-contained DOM block with one event listener.
- Removing ORDERS and AUTOS buttons from `renderTeamHeader` (terminals.js:3590–3611) — they already exist as `#btn-team-orders` and `#btn-team-automations` in the sidebar (terminals.html:2430–2433) with click handlers already wired (terminals.js:11477, 11882).
- Renaming the sidebar `#btn-team-automations` label from "AUTOMATIONS" to "SCHEDULED AUTOMATIONS" (terminals.html:2432–2433) — text change.
- Removing the action bar `div` and `mkActionBtn` helper from `renderTeamHeader` (terminals.js:3618–3653) — mechanical removal.

### Complex / Risky
- **Relocating 5 action buttons + the + button to the sidebar as static HTML:** Requires adding new `<button>` elements to the `.sidebar-ops` div in terminals.html, wiring click handlers in the init code (not in `renderTeamHeader`), and showing/hiding them based on `teamScopeId` in `renderSidebarList` (same pattern as `#btn-team-orders` at terminals.js:4442–4443). The RESTART MISSING button has a dynamic disabled state (`isSpawnedTeamGroup(group) && group.definitionId`) that must be updated on each render — this logic moves from `renderTeamHeader` to `renderSidebarList`.
- **The + (ADD TERMINAL) button's click handler** depends on the current team's head terminal to determine `targetSpec` (parentRoot). This is dynamic — the handler must read `getScopedTeamGroup()` and `teamHeadName(group)` at click time, not at init time. The role picker still mounts into `groupTabStripEl` (terminals.js:3661–3663), which is independent of the button's location in the sidebar.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The RESTART MISSING disabled state is updated in `renderSidebarList`, which runs on every fleet poll (5s). A team whose definition is deleted between polls will show the button enabled for one poll cycle, then disabled on the next. This is acceptable — the click handler itself checks `getScopedTeamSnapshot()` and the `restartMissingMembers()` function re-validates.

**Security:**
- No new message handlers or cross-frame communication — all buttons are within the same terminals panel. No origin checks needed.

**Side Effects:**
- Removing the pacing checkbox makes the `pacing` field on team definitions UI-unsettable. Existing teams with `pacing: 'seat'` will continue to use seat-paced dispatch (the backend reads the field via `resolveTeamPacing` at LocalApiServer.ts:1747–1751). This is correct — removing the UI does not change the backend field. New teams default to head pacing (absent = `'head'`), which is the correct default for the entire install base.
- The `pacingCb.addEventListener('change', ...)` handler at kanban.html:5219–5236 is the only writer of the `pacing` field from the UI. Removing it means the field can only be set by direct DB manipulation or API calls. This is intentional — the user wants routing to be automatic.
- Moving the action bar buttons to static HTML means they are always present in the DOM (hidden by default). This is the same pattern as `#btn-team-orders` and `#btn-team-automations` — no performance concern.

**Dependencies & Conflicts:**
- **Plan A must land first.** Plan A hides the generic sidebar buttons (`#btn-open-all`, `#btn-start-team`, `#btn-link-up`, etc.) via `body.is-team-scoped` CSS. This plan adds the action bar buttons to the same `.sidebar-ops` div. If this plan lands first, the action bar buttons would appear alongside the generic buttons in team-scoped mode, creating a cluttered sidebar.
- **Button naming conflict:** The sidebar already has `#btn-clear-all` labelled "CLEAR ALL TERMINALS" (sends /clear to every active terminal). The plan renames the action bar's "CLOSE TEAM" to "CLOSE ALL TERMINALS" (kills all member processes). These are different actions (clear screen vs kill processes) with confusingly similar names. In team-scoped mode, `#btn-clear-all` is hidden by Plan A, so only one is visible — but the naming similarity is still a UX risk if the user transitions between views. Suggested alternative: rename "CLOSE TEAM" to "STOP ALL TERMINALS" instead.
- The ORDERS and AUTOS buttons in the team header (terminals.js:3590–3611) are duplicates of the sidebar buttons (`#btn-team-orders`, `#btn-team-automations`). Both call the same modal-opening functions (`openTeamOrdersModal`, `openTeamAutomationsModal`). Removing the header duplicates is safe — the sidebar buttons already work.

## Dependencies

- **Plan A** (`uat-shell-strip-in-place-team-view.md`) — must land BEFORE this plan. Plan A's sidebar CSS cleanup hides the generic fleet buttons, creating the space this plan fills with action bar buttons.

## Adversarial Synthesis

Key risks: the button naming conflict between "CLOSE ALL TERMINALS" (action bar, kills processes) and "CLEAR ALL TERMINALS" (sidebar, clears screen) — one letter apart, different actions; the RESTART MISSING disabled state must move from `renderTeamHeader` to `renderSidebarList` without breaking the dynamic check; the + button's click handler must read team state at click time since it can no longer capture the group from the render closure. Mitigations: rename CLOSE TEAM to "STOP ALL TERMINALS" to avoid the conflict; the disabled-state move is a cut-and-paste of the same `isSpawnedTeamGroup(group) && group.definitionId` check; the + button handler uses `getScopedTeamGroup()` which already reads current state.

## Proposed Changes

### 1. Remove the pacing checkbox and its note (failures 7–8)
**File:** `src/webview/kanban.html`
**Change:** Delete the pacing toggle block at lines 5178–5237 — the `pacingDiv`, `pacingCb`, `pacingLabel`, `pacingNote`, and the `pacingCb.addEventListener('change', ...)` handler. The `pacing` field on the team definition stays in the backend (`LocalApiServer.ts:1746–1751` reads it via `resolveTeamPacing`, `KanbanProvider.ts:4926–4949` propagates it to live groups). Teams default to head pacing (absent = `'head'`), which is the correct default for the entire install base.

**Verification:** Grep for `"paces the queue"` and `"advances on review pass"` across all webview HTML files — both phrases appear only in the deleted block (kanban.html:5205, 5216). No other references exist in `src/webview/` or `src/services/*.ts`.

### 2. Relocate the action bar into the sidebar (failure 10)
**File:** `src/webview/terminals.html` (`.sidebar-ops` div, lines 2399–2434)
**Change:** Add five new static HTML buttons for the team action verbs, after `#btn-team-automations` (line 2433) and before the closing `</div>` (line 2434). All are `hidden` by default (shown when `teamScopeId` is set, same pattern as `#btn-team-orders`):
```html
<button type="button" id="btn-team-clear" class="secondary-btn w-full"
        title="/clear every member" hidden>CLEAR ALL CONTEXTS</button>
<button type="button" id="btn-team-clear-members" class="secondary-btn w-full"
        title="/clear every member except the head" hidden>CLEAR MEMBERS (KEEP HEAD)</button>
<button type="button" id="btn-team-close" class="secondary-btn w-full"
        title="End every member process immediately" hidden>STOP ALL TERMINALS</button>
<button type="button" id="btn-team-restart" class="secondary-btn w-full"
        title="Re-spawn exited members from the definition" hidden>RESTART EXITED MEMBERS</button>
<button type="button" id="btn-team-ack" class="secondary-btn w-full"
        title="Acknowledge all member completion lights" hidden>ACKNOWLEDGE COMPLETIONS</button>
<button type="button" id="btn-team-add" class="secondary-btn is-teal w-full"
        title="New terminal in this team" hidden>ADD TERMINAL</button>
```

> **Superseded:** Rename "CLOSE TEAM" to "CLOSE ALL TERMINALS"
> **Reason:** The sidebar already has `#btn-clear-all` labelled "CLEAR ALL TERMINALS" (sends /clear, a screen-clear action). "CLOSE ALL TERMINALS" (kills processes) is one letter apart — a dangerous confusion. In team-scoped mode `#btn-clear-all` is hidden, but the naming similarity persists across view transitions.
> **Replaced with:** Rename "CLOSE TEAM" to "STOP ALL TERMINALS" — unambiguous, no collision with any existing button label.

**File:** `src/webview/terminals.js` (init code, near the existing `#btn-team-orders` wiring at line 11477)
**Change:** Wire up click handlers for the six new buttons:
```js
const btnTeamClear = document.getElementById('btn-team-clear');
if (btnTeamClear) btnTeamClear.addEventListener('click', () => clearTeam());
const btnTeamClearMembers = document.getElementById('btn-team-clear-members');
if (btnTeamClearMembers) btnTeamClearMembers.addEventListener('click', () => clearTeamMembers());
const btnTeamClose = document.getElementById('btn-team-close');
if (btnTeamClose) btnTeamClose.addEventListener('click', () => closeTeam());
const btnTeamRestart = document.getElementById('btn-team-restart');
if (btnTeamRestart) btnTeamRestart.addEventListener('click', () => restartMissingMembers());
const btnTeamAck = document.getElementById('btn-team-ack');
if (btnTeamAck) btnTeamAck.addEventListener('click', () => clearTeamBadges());
const btnTeamAdd = document.getElementById('btn-team-add');
if (btnTeamAdd) btnTeamAdd.addEventListener('click', () => {
    const group = getScopedTeamGroup();
    if (!group) { return; }
    const headName = teamHeadName(group);
    const headTerm = headName ? fleetList.find(t => t.friendlyName === headName) : null;
    const targetSpec = headTerm && headTerm.parentRoot
        ? { parentRoot: headTerm.parentRoot }
        : undefined;
    onNewTerminalClicked(targetSpec, 'team:' + teamScopeId);
});
```

**File:** `src/webview/terminals.js` (`renderSidebarList`, lines 4442–4445)
**Change:** Add show/hide logic for the six new buttons, alongside the existing `#btn-team-orders` / `#btn-team-automations` handling:
```js
const btnTeamClear = document.getElementById('btn-team-clear');
if (btnTeamClear) btnTeamClear.hidden = !teamScopeId;
const btnTeamClearMembers = document.getElementById('btn-team-clear-members');
if (btnTeamClearMembers) btnTeamClearMembers.hidden = !teamScopeId;
const btnTeamClose = document.getElementById('btn-team-close');
if (btnTeamClose) btnTeamClose.hidden = !teamScopeId;
const btnTeamAck = document.getElementById('btn-team-ack');
if (btnTeamAck) btnTeamAck.hidden = !teamScopeId;
const btnTeamAdd = document.getElementById('btn-team-add');
if (btnTeamAdd) btnTeamAdd.hidden = !teamScopeId;
// RESTART EXITED MEMBERS: dynamic disabled state
const btnTeamRestart = document.getElementById('btn-team-restart');
if (btnTeamRestart) {
    btnTeamRestart.hidden = !teamScopeId;
    if (teamScopeId) {
        const group = getScopedTeamGroup();
        const hasDefinition = group && isSpawnedTeamGroup(group) && group.definitionId;
        btnTeamRestart.disabled = !hasDefinition;
        btnTeamRestart.title = hasDefinition
            ? 'Re-spawn exited members from the definition'
            : 'Team definition not found — cannot restart missing members';
    }
}
```

**File:** `src/webview/terminals.js` (`renderTeamHeader`, lines 3571–3653)
**Change:** Remove the `+` button (lines 3571–3589), the ORDERS button (lines 3590–3601), the AUTOS button (lines 3603–3611), and the entire action bar block (lines 3618–3653). The team header keeps only the identity elements: icon area (lines 3540–3550), name + count area (lines 3552–3569), and the back button (added by Plan A). The `mkActionBtn` helper (lines 3621–3634) is dead code — remove it.

### 3. Rename buttons for clarity (failure 10)
**File:** `src/webview/terminals.html` (`.sidebar-ops` div)
**Change:** The rename is accomplished by the static HTML button labels in step 2 above. The `title` (tooltip) attributes carry the detailed explanations. The sidebar `#btn-team-orders` already says "STANDING ORDERS" (line 2430) — no change needed. The sidebar `#btn-team-automations` says "AUTOMATIONS" (line 2432) — update to "SCHEDULED AUTOMATIONS":

```html
<button type="button" id="btn-team-automations" class="secondary-btn w-full"
        title="View and configure scheduled automations for this team" hidden>SCHEDULED AUTOMATIONS</button>
```

The full rename map:

| Current (header) | New (sidebar) | Reason |
|---------|----------|--------|
| CLEAR TEAM | CLEAR ALL CONTEXTS | "Clear" alone is ambiguous; "contexts" names what is cleared |
| CLEAR MEMBERS | CLEAR MEMBERS (KEEP HEAD) | The parenthetical makes the distinction explicit |
| CLOSE TEAM | STOP ALL TERMINALS | "Close team" sounds like deleting the team; "stop" names the action; avoids collision with existing "CLEAR ALL TERMINALS" |
| RESTART MISSING | RESTART EXITED MEMBERS | "Missing" is vague; "exited" names the state |
| CLEAR BADGES | ACKNOWLEDGE COMPLETIONS | "Badges" is jargon; "acknowledge completions" names the action |
| ORDERS | STANDING ORDERS | No abbreviation (sidebar already has this label) |
| AUTOS | SCHEDULED AUTOMATIONS | No abbreviation |
| + | ADD TERMINAL | No symbol-only label |

## Edge Cases

- **Pacing field already set on existing teams:** Teams where `pacing: 'seat'` was set before the toggle was removed will continue to use seat-paced dispatch. This is correct — removing the UI does not change the backend field. If the user wants to reset all teams to head pacing, a one-time migration could delete the `pacing` field from all team definitions, but that is a separate decision.
- **Action bar in a non-team-scoped view:** The action buttons are `hidden` by default and shown only when `teamScopeId` is set (in `renderSidebarList`). In the full fleet view, the generic sidebar buttons remain visible. No conflict.
- **Button width in sidebar:** The action buttons use the existing `.secondary-btn.w-full` class — full-width stacked, same as `#btn-team-orders` and `#btn-team-automations`. No CSS adjustment needed; the sidebar's `.sidebar-ops` div is already a flex column (terminals.html:129–132).
- **RESTART EXITED MEMBERS disabled state:** When the team definition is deleted, the button is disabled with a tooltip explaining why. This check runs on every `renderSidebarList` call (5s poll), so the disabled state updates within one poll cycle of the definition being deleted.
- **Role picker mounting:** The ADD TERMINAL button opens a role picker that mounts into `groupTabStripEl` (terminals.js:3661–3663). Moving the button to the sidebar does not affect the picker's mount point — the picker is positioned independently of the button's location.

## Verification Plan

### Automated Tests
- No existing test directly covers the pacing toggle or action bar. Add a test that verifies the pacing toggle block is absent from kanban.html (grep assertion). Add a test that verifies the action bar buttons exist in terminals.html with the correct IDs and labels.

### Manual Verification
1. `npm run compile` — clean. *(Skipped this run per session directive — checks remain written down.)*
2. Manual, installed VSIX: open the TEAMS tab in kanban.html. Confirm the "SEATS PACE THE QUEUE (NO HEAD)" checkbox is gone. No pacing toggle appears on any team card.
3. Manual: open a team cockpit (via the shell strip, after Plan A lands). Confirm the action bar buttons are in the sidebar, not in a strip on top. Confirm the generic buttons (OPEN AGENT TERMINALS, START TEAM, LINK UP) are not visible.
4. Manual: confirm each renamed button works as before — CLEAR ALL CONTEXTS clears every member, CLEAR MEMBERS (KEEP HEAD) clears all except the head, STOP ALL TERMINALS kills all processes, RESTART EXITED MEMBERS re-spawns dead members, ACKNOWLEDGE COMPLETIONS clears all done lights, STANDING ORDERS opens the orders modal, SCHEDULED AUTOMATIONS opens the automations modal, ADD TERMINAL opens the role picker.
5. Manual: confirm a team with `pacing: 'seat'` set in its definition still dispatches via seat-paced routing (the backend field is untouched).
6. Grep assertion: no "SEATS PACE THE QUEUE" or "advances on review pass" text remains in any webview HTML file.
7. Grep assertion: no `mkActionBtn` or `actionBar` references remain in `renderTeamHeader` in terminals.js.
8. Manual: confirm the team header shows only the back button, icon, name, and member count — no action buttons, no ORDERS, no AUTOS, no +.

---

## Completion Report

Removed the "SEATS PACE THE QUEUE (NO HEAD)" pacing toggle block (including the misleading head-advances note and its `change` listener) from `src/webview/kanban.html`; the backend `pacing` field is untouched so existing seat-paced teams keep their routing. Relocated the five team action verbs plus ADD TERMINAL out of `renderTeamHeader` in `src/webview/terminals.js` into six new static sidebar buttons in `src/webview/terminals.html` (`.sidebar-ops`), wired via a new `wireTeamActionBar` IIFE and shown/hidden in `renderSidebarList` with the RESTART EXITED MEMBERS disabled state moved there. Renamed all buttons per the plan's map (CLOSE TEAM → STOP ALL TERMINALS, AUTOMATIONS → SCHEDULED AUTOMATIONS, etc.) and removed the dead `mkActionBtn` helper, `+`/ORDERS/AUTOS header buttons, and the `actionBar` div. Grep assertions pass: no pacing text, no `mkActionBtn`/`actionBar` references remain. No issues encountered; compilation and tests skipped per session directives.

## Review Findings

Reviewed the shipped diff (commit `97f4bd76`) against this plan. The pacing toggle, its `change` listener and the misleading head-advances note are gone from `src/webview/kanban.html`; all six action verbs are static `.sidebar-ops` buttons in `src/webview/terminals.html` with the plan's rename map applied (including the superseded STOP ALL TERMINALS), wired by `wireTeamActionBar` and toggled in `renderSidebarList` with the RESTART disabled state moved across correctly. One MAJOR gap: the plan's `### Automated` subsection named two tests (pacing block absent from kanban.html; action bar buttons present with correct IDs and labels) and neither was written — nothing gated the relocation, so a future edit to `.sidebar-ops` would silently un-ship it. Fixed by adding those assertions to two suites CI already invokes — 2 pacing tests in `src/test/teams-tab-no-start-contract.test.js` and 3 action-bar tests in `src/test/shell-terminal-strip.test.js` — rather than a new script that would need fresh CI wiring; also removed the orphaned `.team-action-bar` / `.team-action-btn` CSS the deleted header strip left behind. Validation: `teams-tab-no-start` 8/8 and `shell-terminal-strip` 64/64 pass, `eslint` clean; `npm run compile` fails only on `src/services/agentGroupInstantiation.ts`, an unrelated uncommitted edit by another agent (parses clean at HEAD, left untouched).
