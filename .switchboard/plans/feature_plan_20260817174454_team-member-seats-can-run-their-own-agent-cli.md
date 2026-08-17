# Team Member Seats Can Run Their Own Agent CLI Instead of Inheriting the Role's

## Goal

Expose the per-member `startupCommand` in the TEAMS tab's member editor, so a team seat can run a different (cheaper, faster, or simply other) agent CLI than the one the same role uses for the operator's own standalone terminals. The field already exists on the stored member shape and is already honoured end to end by the spawn path — it is simply not editable anywhere, so today every seat of role R runs whatever CLI role R is globally configured with, and the only way to make a team's seats cheaper is to make *every* terminal of that role cheaper.

### Problem analysis and root cause

**The plumbing is complete and unreachable.** `DelegateDefinition` carries `startupCommand` (`src/services/agentConfig.ts:3-12`). `spawnDelegates` passes it to `create()` for both member scopes (`src/standalone/ptyFleetService.ts:496` shared, `:533` per-team). `create()` hands it to `injectStartupCommand`, which prefers it and falls back to the role's global command only when it is absent (`:360-370`):

```ts
private async injectStartupCommand(handle, role, startupCommand?) {
    let cmd = startupCommand;
    if (!cmd) {
        const commands = await GlobalIntegrationConfigService.getAgentStartupCommands() || {};
        cmd = commands[role];
    }
    if (!cmd) { return; }
    …
}
```

`instantiateAgentGroupCore` and both hosts' team-start arms pass the group's `members` through untouched (`agentGroupInstantiation.ts:96-101`; `bootstrap.ts:2177-2179`), and the extension-host comment at `bootstrap.ts:2152-2156` names this exact field as something the wrapper must not be allowed to discard: *"the wrapper overwrites `delegates` from role config, which would silently discard the group's members and their per-member startup commands."* The whole path was built for this.

**The editor refuses to render it, on purpose.** `teamsTabAgentGroupMemberRow` (`src/webview/kanban.html:5188-5192`):

```js
            // Member editor row: role, count, scope, relationship.
            // No per-member label or command — the tab composes roles, it never
            // configures them. label and startupCommand remain on the stored
            // DelegateDefinition shape and are preserved on write.
```

That rule was right when the only writer of `startupCommand` was the retired `addons.delegates` import (`importDelegatesIntoTeams`) and the tab's job was purely compositional. It is wrong now: choosing which CLI a seat runs is *the* difference between a team of peers and a team of cheap workers, and there is no other surface that can express it. The Agents tab configures a role globally; the terminals panel's `START TEAM` form chooses a team and a workspace; nothing chooses a command for a seat.

**The preservation shim is also quietly lossy for same-role members.** Because the editor does not render the field, the save path reconstructs it by role lookup (`:5307-5326`):

```js
const prev = existing.find(m => m.role === role);
members.push({ role, count, scope, relationship,
    ...(prev?.label ? { label: prev.label } : {}),
    ...(prev?.startupCommand ? { startupCommand: prev.startupCommand } : {}) });
```

`existing.find(m => m.role === role)` returns the **first** member of that role. A team with two `coder` rows carrying different labels or different commands collapses to the first row's values on any edit-and-save — silently, with no error. Rendering the fields and reading them back from their own row removes the shim and the defect with it.

**Root cause:** the field was plumbed for a migration path (importing legacy `addons.delegates`) and never given an authoring surface, and the editor's "compose, never configure" rule froze it out.

### Design

One text input per member row, after `relationship`, placeholder showing what the seat inherits today. Nothing else changes: no new message, no new verb, no new stored key, no host change.

- **Empty means inherit.** An empty field stores no `startupCommand` key at all, so `injectStartupCommand` falls through to the role's global command — the current behaviour, byte-identical stored shape for every team nobody edits.
- **Placeholder names the inherited command.** `lastStartupCommands` already holds the role → command map in this webview (`kanban.html:9756-9758`), so the placeholder can read `inherits: claude` rather than a generic hint. When the role has no configured command the placeholder is `inherits: (none)`.
- **`label` gets its own input in the same row**, for the same reason: it is the other half of the lossy shim, it determines the member's terminal name (`` `${parent.friendlyName}-${d.label || d.role}${suffix}` ``, `ptyFleetService.ts:526`), and leaving it unrendered means the shim has to stay.

## Metadata

**Complexity:** 4
**Tags:** feature, ui, ux, frontend
**Project:** Browser Switchboard

## Complexity Audit

### Routine

- Two `<input type="text">` elements appended to an existing row builder, with the same inline-style idiom the row already uses.
- Reading them back in `teamsTabSaveAgentGroup` from the row's own inputs.

### Complex / Risky

- **The new input must NOT carry a `data-role` attribute.** `agentsTabCollectConfig` (`kanban.html:5361-5373`) collects role startup commands with:

  ```js
  document.querySelectorAll('#agents-tab-content input[type="text"][data-role], #teams-tab-content input[type="text"][data-role]')
  ```

  It deliberately includes `#teams-tab-content` (comment at `:5364-5365`: "the Delegation section moved to #teams-tab-content"). A member-command input tagged `data-role="planner"` would be scooped up and saved as the **global** planner command the next time the Agents config is saved — turning a per-seat override into a workspace-wide clobber of exactly the setting this feature exists to avoid touching. Use a class or `data-member-cmd`, never `data-role`. This is the single highest-risk detail in the plan.
- **The save path's index-based DOM read is positional and must stay in lockstep.** `teamsTabSaveAgentGroup` reads `r.querySelectorAll('input')[0]`/`[1]` and `selects[0]`/`[1]` and gates on `inputs.length >= 2 && selects.length >= 2` (`:5311-5318`). Adding two inputs makes `inputs.length` 4 and shifts nothing already indexed, but relying on further positional indices for the new fields is how this breaks on the next edit. Read the new fields by class from the row (`r.querySelector('.member-cmd')`), not by index.
- **The `>= 2` guard is a row-validity test, not a schema.** Do not tighten it to `>= 4`: a row rendered by an older cached webview build would then be silently dropped, deleting members on save.
- **Deleting the `existing.find(m => m.role === role)` shim is required, not optional.** Leaving it in place while also reading the row would make the row's empty command lose to a stale stored value — an operator clearing the field would find it restored. Remove the shim in the same change and note in the comment that the row is now the sole source.
- **No new wire capability.** `saveAgentGroup` already persists whatever member objects the webview sends, verbatim and unfiltered (`KanbanProvider.ts:11603-11617` → `_saveAgentGroup`), and members have carried `startupCommand` since `importDelegatesIntoTeams`. So a caller on the board's HTTP channel could already store a member command; this change gives the *operator who owns the board* a control for a field the wire could always write. It widens no boundary. The wire-facing guards that matter are elsewhere and stay untouched: both hosts reject a wire-supplied `group` on `ptyStartTeam` (`TaskViewerProvider.ts:2801-2803`, `bootstrap.ts:1273-1275`) and overwrite wire-supplied `delegates`/`startupCommand` on `ptyCreateTerminal` (`:2836-2837`). Team definitions stay host-resolved.
- **Do not add validation that rejects commands.** The Agents tab's role-command inputs are free-text with an `e.g.` placeholder and no validation; a member command is the same kind of value and gets the same treatment. Inventing an allowlist here would diverge from the sibling control for no gain.
- **No confirm gate.** The field saves with the form, like every other field in it.

## Edge-Case & Dependency Audit

**Empty vs whitespace.** Trim on read; an all-whitespace value stores no key. Otherwise `injectStartupCommand` would `sendText('   ')` into the seat and the role's real command would never run — a seat that boots into a bare shell and looks hung.

**Existing teams are untouched.** A team whose members have no `startupCommand` re-saves with no `startupCommand`, so the persisted JSON is byte-identical. No migration is needed and none is added: this exposes an existing optional key rather than changing a shape. (`terminals.agentGroups` is released state, so a shape change *would* have needed one — this is not one.)

**Legacy imported commands become visible.** Installs whose `addons.delegates` were folded into teams by `importDelegatesIntoTeams` may already have member commands on disk. Today they are invisible and preserved by the shim; after this change they render in their own row's input. That is the point, and it must be verified explicitly (step 6 below) — the field populating from an existing definition is what proves the round-trip.

**Two members of the same role.** The reason the shim is being removed. After the change, `[{role:'coder', label:'fast', startupCommand:'x'}, {role:'coder', label:'slow', startupCommand:'y'}]` survives an edit-and-save with both rows intact. Add a test for exactly this.

**Shared-scope members.** A shared member is looked up by name and reused if already live (`ptyFleetService.ts:485-491`); its command only takes effect on the spawn that creates it. Changing the command on a shared member that is already running does nothing until that terminal is closed and the team restarted. State this in the placeholder? No — one input, no essay. It is a property of shared scope, already true of every other member field.

**The head is not a member and gets no command field.** `createHeadWithDelegates` passes no `startupCommand` for the head on either host (`TaskViewerProvider.ts:12018-12031`, `bootstrap.ts:2174-2176`), so the head always runs its role's configured CLI. That is deliberate — the head is the seat you *want* on your strongest agent — and this plan does not change it. Do not add a head-command field "for symmetry".

**Row width.** The member row is `flex-wrap: wrap` with `gap: 4px` (`:5194-5196`). Two more inputs wrap to a second line in a narrow panel rather than overflowing. Give the command input `flex: 1; min-width: 110px` and the label input `width: 70px`, matching the existing sizing idiom.

**Curtains.** `startTeam` arms a startup curtain for every worker unconditionally (`terminals.js:6831-6834`), so a seat with its own command is covered exactly as one inheriting the role's is. No change.

## Proposed Changes

### `src/webview/kanban.html` — render label and command on the member row

Replace the header comment and add the two inputs in `teamsTabAgentGroupMemberRow` (`:5188-5246`):

```js
        function teamsTabAgentGroupMemberRow(member) {
            // Member editor row: role, count, scope, relationship, label, command.
            // `command` is the seat's own startupCommand — empty means inherit the
            // role's global command (injectStartupCommand, ptyFleetService.ts:360-370).
            // NEVER tag these inputs with data-role: agentsTabCollectConfig (:5366)
            // scoops `#teams-tab-content input[type="text"][data-role]` into the
            // GLOBAL role-command map, so a data-role here would overwrite the
            // workspace's role command on the next Agents-config save.
            const row = document.createElement('div');
            row.className = 'startup-row';
            row.style.flexWrap = 'wrap';
            row.style.gap = '4px';

            // … roleIn / countIn / scopeSel / relSel unchanged …

            const labelIn = document.createElement('input');
            labelIn.type = 'text';
            labelIn.className = 'member-label';
            labelIn.placeholder = 'label';
            labelIn.style.width = '70px';
            labelIn.value = member.label || '';

            const cmdIn = document.createElement('input');
            cmdIn.type = 'text';
            cmdIn.className = 'member-cmd';
            cmdIn.style.flex = '1';
            cmdIn.style.minWidth = '110px';
            cmdIn.value = member.startupCommand || '';

            // Placeholder names what the seat inherits when the field is empty.
            // lastStartupCommands is the role -> command map this webview already
            // receives on the `startupCommands` message (:9756-9758).
            const syncCmdPlaceholder = () => {
                const inherited = (lastStartupCommands || {})[roleIn.value.trim()] || '';
                cmdIn.placeholder = inherited ? `inherits: ${inherited}` : 'inherits: (none)';
            };
            syncCmdPlaceholder();

            row.appendChild(roleIn);
            row.appendChild(countIn);
            row.appendChild(scopeSel);
            row.appendChild(relSel);
            row.appendChild(labelIn);
            row.appendChild(cmdIn);
            row.appendChild(delBtn);

            function save() {
                member.role = roleIn.value.trim() || 'coder';
                member.count = parseInt(countIn.value, 10) || 1;
                member.scope = scopeSel.value;
                member.relationship = relSel.value;
                const label = labelIn.value.trim();
                const cmd = cmdIn.value.trim();
                if (label) { member.label = label; } else { delete member.label; }
                if (cmd) { member.startupCommand = cmd; } else { delete member.startupCommand; }
                syncCmdPlaceholder();
            }
            [roleIn, countIn, labelIn, cmdIn].forEach(el => el.addEventListener('blur', save));
            [scopeSel, relSel].forEach(el => el.addEventListener('change', save));
            // … delBtn handler unchanged …
            return row;
        }
```

### `src/webview/kanban.html` — read them back, and delete the role-lookup shim

In `teamsTabSaveAgentGroup` (`:5298-5329`):

```js
            // Read members from the DOM rows. Role/count/scope/relationship are
            // read positionally (unchanged); label and startupCommand are read BY
            // CLASS from the row that owns them. The old `existing.find(m => m.role
            // === role)` preservation shim is gone: it returned the FIRST member of
            // a role, so two same-role rows collapsed onto the first row's label and
            // command on every save. The row is now the sole source.
            const membersDiv = document.getElementById('agent-groups-members');
            const members = [];
            if (membersDiv) {
                const rows = membersDiv.querySelectorAll('.startup-row');
                for (const r of rows) {
                    const inputs = r.querySelectorAll('input');
                    const selects = r.querySelectorAll('select');
                    // Row-validity test, NOT a schema check — do not tighten to >= 4
                    // or a row from a stale cached build silently drops its member.
                    if (inputs.length >= 2 && selects.length >= 2) {
                        const role = inputs[0].value.trim() || 'coder';
                        const count = parseInt(inputs[1].value, 10) || 1;
                        const scope = selects[0].value;
                        const relationship = selects[1].value;
                        const label = (r.querySelector('.member-label')?.value || '').trim();
                        const startupCommand = (r.querySelector('.member-cmd')?.value || '').trim();
                        members.push({
                            role, count, scope, relationship,
                            ...(label ? { label } : {}),
                            ...(startupCommand ? { startupCommand } : {}),
                        });
                    }
                }
            }
```

The `existing` lookup and its two spreads are deleted. Everything below (`id`, `promptText`, `headPromptText`, the `startOnLoad`/`startWorktree` carry) is unchanged.

Add one line of guidance above the members list in the form markup — the section already carries a heading, so this is a hint on an existing block, not a new panel:

```html
<div style="font-size:10px;color:var(--text-secondary);">Leave a member's command empty to use the role's configured CLI.</div>
```

### `src/services/*` — no change

The spawn path already honours `startupCommand` on both hosts and the save arm already persists it verbatim. No service, verb, catalog or allowlist edit.

### Tests

Add a TEAMS-tab editor contract test (extend the existing teams-tab coverage, or add `teams-tab-member-editor-contract.test.js`) asserting against `kanban.html` source:

1. The member row builder creates inputs with classes `member-label` and `member-cmd`, and **neither** sets `data-role` — a regex assertion that no `data-role` assignment appears inside `teamsTabAgentGroupMemberRow`.
2. `teamsTabSaveAgentGroup` no longer contains `existing.find(m => m.role === role)`.
3. `teamsTabSaveAgentGroup` reads `.member-cmd` and `.member-label` by `querySelector`.
4. The `inputs.length >= 2 && selects.length >= 2` guard is still exactly that — pinned so nobody tightens it.

Add a behavioural round-trip test for the two-same-role case: given a stored group `[{role:'coder',label:'fast',startupCommand:'x'},{role:'coder',label:'slow',startupCommand:'y'}]`, the values written back must match per row rather than both taking the first row's values. If the harness cannot drive the DOM, assert the shim's absence (2) plus a unit test of the extracted read helper.

## Verification Plan

**Automated**

1. `node src/test/<teams-tab member editor>.test.js` — all four source assertions pass.
2. `node src/test/team-autostart-workspace-scope.test.js` — the `migrateAgentGroups` member-shape cases still pass, in particular that `label` and `startupCommand` are preserved through the converter (`teamWiring.ts:401-402`).
3. `npx tsc --noEmit -p tsconfig.json` — clean (webview JS is untyped, but the tsc pass guards the services this touches, i.e. none).

**Manual (installed VSIX)**

4. Board → TEAMS → EDIT a team. Each member row now shows `role | count | scope | relationship | label | command | ×`. The command input's placeholder reads `inherits: <the role's configured CLI>` — verify by changing that role's command in the AGENTS tab and reopening the form.
5. Set a member's command to something visibly different (e.g. `claude --model haiku` on a `coder` seat whose role command is `claude`). Save. Reopen the form: the value round-trips.
6. **Legacy value surfaces.** On an install whose teams were built from `addons.delegates` (or by hand-editing `terminals.agentGroups`), open the form and confirm a pre-existing member `startupCommand` renders in the field rather than being invisible.
7. **It actually runs.** Start the team from the terminals panel. The seat with the override boots the override command; a sibling seat with an empty field boots the role's command. Read both panes.
8. **Empty means inherit.** Clear the field, save, restart the team: the seat boots the role's command again, and the persisted group has no `startupCommand` key for that member (check via SETUP → DB or the DB path from `query-switchboard-kanban`).
9. **Two same-role rows survive.** Add two `coder` rows with different labels and different commands. Save, reopen: both rows keep their own values. Start the team: the terminals are named `<head>-<label>` per row and each boots its own command. This is the case that fails on the current build.
10. **No global clobber.** With a member command set, go to the AGENTS tab and save the agent config (toggle any visibility checkbox). Reopen the AGENTS tab and confirm the role's global command is unchanged — the member input was not collected into it.
11. **Standalone.** Repeat 4, 5, 7 against `npx switchboard` in a browser; the spawn path differs by host and the override is applied in `ptyFleetService` on both.
