# Adding a Team Member Makes You Type the Role by Hand

## Goal

Adding a member to a team in the TEAMS tab must be a pick, not a spelling test. The member row's role field must be a dropdown of the same agent roles the rest of the board offers — exactly like the Head role field directly above it — so a member can never be created against a role that does not exist.

### Problem analysis

The team editor's member row is built by `teamsTabAgentGroupMemberRow` (`src/webview/kanban.html:5188-5246`). Four fields; three are pickers and one is not:

```js
const roleIn = document.createElement('input');
roleIn.type = 'text'; roleIn.placeholder = 'role';        // ← free text
roleIn.value = member.role || '';

const countIn  = document.createElement('input'); countIn.type = 'number';
const scopeSel = document.createElement('select'); // per-team | shared
const relSel   = document.createElement('select'); // MEMBER_RELATIONSHIP_PRESETS
```

Meanwhile the **Head role** field one section up is a `<select>` (`kanban.html:3317-3327`). So the same form asks the operator to pick the head from a list and then type the members from memory.

### Why this is worse than an inconvenience

Nothing validates the typed string. On save (`teamsTabSaveAgentGroup`, `kanban.html:5311-5328`):

```js
const role = inputs[0].value.trim() || 'coder';
```

A typo (`intren`, `Coder`, `phone-a-friend`) is stored verbatim as a member role. The failure is then silent and downstream:

- `spawnDelegates` → `ptyFleetService.injectStartupCommand` looks the role up in the machine-global startup-commands map (`src/standalone/ptyFleetService.ts:360-371`). No match → `if (!cmd) { return; }` → the member spawns as a **plain shell** with no agent CLI in it.
- The seat then has no CLI label, no brand icon, and no startup curtain (curtain arming is gated on the role having a command, `terminals.js:6632`).
- Nothing anywhere says "that role does not exist". The team simply comes up one agent short of what it looks like.

Role case matters too: every consumer compares raw strings (`t.role === headRole` in `teamWiring.ts:814`, `commands[role]` in `injectStartupCommand`), so `Coder` ≠ `coder`.

### Root cause

The member row was written as a free-form editor for a `DelegateDefinition`, and never picked up the role-roster the rest of the webview already has in scope. The board has a working precedent for precisely this dropdown eleven hundred lines further down — `renderKanbanAssignedAgentOptions` (`kanban.html:11476-11481`) builds a role `<select>` from `BUILT_IN_AGENT_LABELS` plus a "Custom Agents" `<optgroup>` from `lastCustomAgents`. The member row just does not use it.

### The second half of the fix

`teamsTabSaveAgentGroup` reads the row **positionally**:

```js
const inputs  = r.querySelectorAll('input');
const selects = r.querySelectorAll('select');
if (inputs.length >= 2 && selects.length >= 2) {
    const role         = inputs[0].value.trim() || 'coder';
    const count        = parseInt(inputs[1].value, 10) || 1;
    const scope        = selects[0].value;
    const relationship = selects[1].value;
```

Turning the role into a `<select>` changes both collections (`inputs` → `[count]`, `selects` → `[role, scope, relationship]`), and the `inputs.length >= 2` guard would then reject **every row** — saving a team with zero members and no error. The reader must move to explicit `data-field` addressing in the same change. This is the load-bearing part of the work; the dropdown itself is trivial.

### Also worth fixing while here

The Head role `<select>` is a hardcoded eight-option list in the HTML (`kanban.html:3318-3327`): `lead, coder, planner, reviewer, intern, tester, analyst, researcher`. It omits `phone_a_friend`, `claude_designer`, `jules`, `project_manager` and every custom agent — all of which are legitimate terminal-owning roles (`BUILT_IN_AGENT_LABELS`, `src/webview/sharedDefaults.js:38-52`). Populating both selects from the one helper removes the second hardcoded list rather than adding one.

## Metadata

- **Complexity:** 4
- **Tags:** ux, ui, frontend, bugfix
- **Project:** Browser Switchboard

## Complexity Audit

### Routine

- Swapping one `<input type="text">` for a `<select>` and populating it from state already in scope (`BUILT_IN_AGENT_LABELS`, `lastCustomAgents`).
- Reusing the option-building shape of `renderKanbanAssignedAgentOptions`.

### Complex / Risky

- **The positional DOM reader must change in the same commit.** Leaving `teamsTabSaveAgentGroup` as-is turns "type the role" into "silently save no members". `data-field` addressing removes the coupling permanently.
- **Round-tripping an unknown stored role.** Existing saved teams may hold a role that is not in the roster (a typo already saved, or a custom agent since deleted). A `<select>` with no matching `<option>` silently selects the first option — which would **rewrite the operator's stored team on the next save**. The row must inject a preserved `<option>` for any unknown incoming value, labelled so it reads as suspect (e.g. `intren (not configured)`), rather than snapping it to `lead`.
- **`label` and `startupCommand` preservation.** The save path deliberately carries these forward from the previous definition keyed on role (`kanban.html:5319-5326`), because the editor does not expose them and dropping them would destroy configuration. Changing how `role` is read must not change how `prev` is found.
- **Two hosts render this webview.** `kanban.html` is served both as a VS Code webview and by the browser cockpit; the change is pure client-side DOM with no host dependency, so both get it — but it must not reach for any VS Code API.
- **No confirmation dialogs.** The row's `×` delete button removes the row immediately (`kanban.html:5241-5244`). Keep it that way.

## Edge-Case & Dependency Audit

- **Blank/new row default:** the ADD MEMBER handler seeds `{ role: 'coder', count: 1, scope: 'per-team', relationship: 'reports-to-head' }` (`kanban.html:4437`) and `teamsTabShowGroupForm` seeds the same for a brand-new team (`kanban.html:5270-5272`). `coder` is in the roster, so the select resolves cleanly.
- **Custom agents arriving late:** `lastCustomAgents` is populated by the `customAgents` message (`kanban.html:9838-9840`, `11423-11424`). If the form is opened before that message lands, the optgroup is empty. Build the options at row-render time (as `renderKanbanAssignedAgentOptions` does) rather than caching them at module load.
- **Roles hidden in the AGENTS tab:** a role set invisible is still a valid team member (visibility governs the picker and the open-all grid, not team composition). Do NOT filter the dropdown by `lastVisibleAgents` — that would make previously-authored teams unrepresentable.
- **Head-role "(claimed)" annotation:** `teamsTabShowGroupForm` rewrites every head `<option>`'s `textContent` to add a `(claimed)` suffix (`kanban.html:5261-5264`). If the head select becomes dynamically populated, that loop must run **after** population, and must derive its label from `BUILT_IN_AGENT_LABELS` rather than from `opt.value.charAt(0).toUpperCase() + …` (which today prints `Phone_a_friend` for any role with an underscore).
- **Shipped team types:** `SHIPPED_TEAM_TYPES` (`kanban.html:4643+`) reference `researcher`, `coder`, `reviewer` — all in the roster. Forking one into a workspace team must render without an "unknown role" option.
- **Persistence shape unchanged:** the saved `group.members[]` entries keep `{ role, count, scope, relationship, label?, startupCommand? }`. No migration; `teamWiring.ts` and `agentGroupInstantiation.ts` are untouched.
- **Security:** role values become option `value` attributes. Custom agent roles are operator-authored strings, so escape them the way `renderKanbanAssignedAgentOptions` already does (`escapeAttr` / `escapeHtml`) — or build the options with `document.createElement('option')` and `textContent`, which sidesteps escaping entirely and is preferable in the DOM-built row.

## Proposed Changes

### 1. `src/webview/kanban.html` — a shared role-option builder

Add next to the other `teamsTab*` helpers:

```js
/**
 * Roster for both the Head role select and every member row's role select.
 * Built at call time, not cached: `lastCustomAgents` arrives asynchronously via
 * the `customAgents` message and can land after the form is first opened.
 *
 * `preserve` re-injects a stored role that is no longer in the roster (a typo
 * already saved, a deleted custom agent) as its own option. Without it a
 * <select> silently snaps to its first option and the next save REWRITES the
 * operator's team.
 *
 * Deliberately NOT filtered by lastVisibleAgents: visibility governs the
 * terminal picker and the open-all grid, not team composition.
 */
function teamsTabRoleOptions(selectEl, selectedRole) {
    selectEl.innerHTML = '';
    const add = (value, text, parent) => {
        const o = document.createElement('option');
        o.value = value; o.textContent = text;
        (parent || selectEl).appendChild(o);
    };
    const known = new Set();
    for (const r of BUILT_IN_AGENT_LABELS) { add(r.key, r.label); known.add(r.key); }
    if (Array.isArray(lastCustomAgents) && lastCustomAgents.length) {
        const grp = document.createElement('optgroup');
        grp.label = 'Custom Agents';
        for (const a of lastCustomAgents) { add(a.role, a.name || a.role, grp); known.add(a.role); }
        selectEl.appendChild(grp);
    }
    const want = selectedRole || 'coder';
    if (!known.has(want)) { add(want, `${want} (not configured)`); }
    selectEl.value = want;
}
```

### 2. `src/webview/kanban.html:5198-5201` — the member row's role becomes a select

```js
-            const roleIn = document.createElement('input');
-            roleIn.type = 'text'; roleIn.placeholder = 'role';
-            roleIn.style.flex = '1'; roleIn.style.minWidth = '60px';
-            roleIn.value = member.role || '';
+            const roleSel = document.createElement('select');
+            roleSel.dataset.field = 'role';
+            roleSel.style.flex = '1'; roleSel.style.minWidth = '110px';
+            teamsTabRoleOptions(roleSel, member.role);
```

Stamp the other three as well, append `roleSel` in place of `roleIn`, and move the role onto the `change` listener group:

```js
+            countIn.dataset.field = 'count';
+            scopeSel.dataset.field = 'scope';
+            relSel.dataset.field   = 'relationship';
…
-            row.appendChild(roleIn);
+            row.appendChild(roleSel);
…
             function save() {
-                member.role = roleIn.value.trim() || 'coder';
+                member.role = roleSel.value || 'coder';
                 member.count = parseInt(countIn.value, 10) || 1;
                 member.scope = scopeSel.value;
                 member.relationship = relSel.value;
             }
-            [roleIn, countIn].forEach(el => el.addEventListener('blur', save));
-            [scopeSel, relSel].forEach(el => el.addEventListener('change', save));
+            countIn.addEventListener('blur', save);
+            [roleSel, scopeSel, relSel].forEach(el => el.addEventListener('change', save));
```

### 3. `src/webview/kanban.html:5311-5328` — read by field, not by position

```js
 for (const r of rows) {
-    const inputs = r.querySelectorAll('input');
-    const selects = r.querySelectorAll('select');
-    if (inputs.length >= 2 && selects.length >= 2) {
-        const role = inputs[0].value.trim() || 'coder';
-        const count = parseInt(inputs[1].value, 10) || 1;
-        const scope = selects[0].value;
-        const relationship = selects[1].value;
+    // Addressed by data-field, NOT by index. The role control is a <select>
+    // now, so an index-based read shifts both collections and the old
+    // `inputs.length >= 2` guard rejected every row — saving a team with no
+    // members and no error.
+    const roleEl  = r.querySelector('[data-field="role"]');
+    const countEl = r.querySelector('[data-field="count"]');
+    const scopeEl = r.querySelector('[data-field="scope"]');
+    const relEl   = r.querySelector('[data-field="relationship"]');
+    if (roleEl && countEl && scopeEl && relEl) {
+        const role = (roleEl.value || '').trim() || 'coder';
+        const count = parseInt(countEl.value, 10) || 1;
+        const scope = scopeEl.value;
+        const relationship = relEl.value;
         const prev = existing.find(m => m.role === role);
         members.push({ role, count, scope, relationship, … });
     }
 }
```

### 4. `src/webview/kanban.html:3318-3327` + `5257-5265` — one roster for the head select too

Reduce the markup to an empty select:

```html
-            <select id="agent-groups-head-role" class="modal-input">
-              <option value="lead">Lead</option>
-              … 7 more hardcoded options …
-            </select>
+            <select id="agent-groups-head-role" class="modal-input"></select>
```

and populate it in `teamsTabShowGroupForm` **before** the `(claimed)` annotation loop, taking the label from the roster rather than capitalising the raw key (which prints `Phone_a_friend` today):

```js
 const headSel = document.getElementById('agent-groups-head-role');
+teamsTabRoleOptions(headSel, group?.headRole || 'lead');
 const claimedRoles = new Set(agentsTabAgentGroups
     .filter(g => g.id !== group?.id && !g.unassigned)
     .map(g => g.headRole));
 for (const opt of headSel.options) {
     opt.disabled = false;
-    opt.textContent = opt.value.charAt(0).toUpperCase() + opt.value.slice(1) + (claimedRoles.has(opt.value) ? ' (claimed)' : '');
+    if (claimedRoles.has(opt.value)) { opt.textContent = `${opt.textContent} (claimed)`; }
 }
-headSel.value = group?.headRole || 'lead';
```

Note `headSel.options` flattens optgroup children, so custom agents are annotated too.

## Verification Plan

1. **Dropdown renders.** Open TEAMS → NEW TEAM. The member row's first control is a `<select>` listing Planner, Lead Coder, Coder, Intern, Reviewer, Acceptance Tester, Analyst, Ticket Updater, Researcher, Claude Designer, Jules, Phone-a-Friend, Project Manager, plus a "Custom Agents" group when any exist. No free-text role field remains.
2. **Save round-trip.** Add two members with different roles, counts, scopes and relationships. Save, reopen the team. Every field comes back exactly as set — this is the regression the positional reader would break.
3. **Head select.** The Head role dropdown lists the same roster (including Phone-a-Friend and custom agents), and a role already heading another team is suffixed `(claimed)` with a correctly-cased label — `Phone-a-Friend (claimed)`, not `Phone_a_friend (claimed)`.
4. **Unknown stored role is preserved.** Hand-edit a stored team so a member has `role: "intren"`, reopen the editor: the select shows `intren (not configured)` and selects it. Save without touching that row and confirm the stored value is still `intren`, not `planner`.
5. **Members actually spawn with their CLI.** Start a team whose member role is picked from the dropdown; the member terminal comes up running that role's configured agent CLI (branded row, startup curtain), not a bare shell.
6. **Delete is still immediate.** The row `×` removes the row on one click, no confirmation.
7. **Both hosts.** Repeat steps 1-3 in the VS Code kanban webview and in the browser cockpit's board page.
