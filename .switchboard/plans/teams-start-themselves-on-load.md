# Teams Start Themselves on Load

## Goal

Mark a team **start on load** and it comes up on its own when Switchboard opens — head and members spawned and seated in the terminal grid. More than one team can be marked. A marked team can optionally name a worktree to come up in; by default it does not, and comes up in the workspace root.

### Why

Every session begins the same way: open the app, open terminals, start a team, wait for it to seat, then begin. The configuration for all of that already exists and is already persisted — it just does not act until a human clicks. Nothing about "which teams do I run" changes day to day, so the click is pure ceremony.

An explicit start path already exists (`ptyStartTeam` → `startTeamById`), and it already reconciles a double-start. Boot-time start is that same call, made by the host instead of by a click.

### Root cause analysis — the two things that make this harder than it looks

Neither is visible from the feature description, and both are load-bearing.

**1. The TEAMS-tab save path destroys unknown fields.** `teamsTabSaveAgentGroup` (`kanban.html:4785-4839`) does **not** spread the existing definition. It rebuilds the object from scratch at `:4830`:

```js
const group = { id, name, headRole, members, ...(promptText ? { prompt: promptText } : {}), ...(headPromptText ? { headPrompt: headPromptText } : {}) };
```

Anything not in that literal is gone. The comment two lines above (`:4825-4827`) confirms it is deliberate for `unassigned`/`unassignedReason`. So a `startOnLoad` field written by the toggle would be **silently wiped the next time the operator opens EDIT and saves** — the toggle would appear to work, then quietly reset, with nothing in any log. The storage layers below are fine (`migrateAgentGroups` does `{ ...group }` at `teamWiring.ts:185`/`:228` and preserves unknown keys; `_saveAgentGroup` at `KanbanProvider.ts:4556-4564` writes whatever it is handed) — the webview is the only lossy hop, and it is the one this feature writes through.

**2. The obvious boot hook fires repeatedly.** `_startLocalApiServer` (`TaskViewerProvider.ts:2419`) is **re-entrant by design** — the liveness watchdog calls it again on every check (documented at `:748` and `:2440`, re-invoked at `:3496`). A team-start pass placed inside it would run on every watchdog tick. `startTeamById` only refuses when the head is *currently live*, so a team whose head the operator closed would be silently re-spawned minutes later. The hook needs a one-shot latch and a location chosen on purpose.

## What changes

**On a team, two new fields.** Added to the team definition in `terminals.agentGroups`:

- `startOnLoad: boolean` — default `false`.
- `startWorktree?: string` — absent by default. When set, the team spawns there instead of the workspace root.

This is shipped state on ~4,000 installs, so both are additive and absence means off. Teams saved before this change read as `startOnLoad: false` with no migration pass.

> **Superseded:** "and every unknown key in the stored definition is preserved on write."
> **Reason:** False on the path this feature actually writes through. `teamsTabSaveAgentGroup` (`kanban.html:4830`) constructs a fresh object literal and drops every field not named in it. The claim is true of `migrateAgentGroups` and `_saveAgentGroup`, which is presumably where it came from — but the webview save sits above both and is lossy.
> **Replaced with:** `startOnLoad` and `startWorktree` must be **explicitly named** in `teamsTabSaveAgentGroup`'s object literal, read from the toggle and the worktree input. Additive-and-absent-means-off still holds for reading; it does not survive a round-trip through the editor unless the editor is taught the fields.

**On the TEAMS tab**, on each team card: a `START ON LOAD` toggle, and when it is on, an optional worktree field that is empty unless the operator fills it. Empty is the normal case and should read that way — no placeholder implying a worktree is expected.

**On boot**, after the API server is up and the terminals surface is ready, the host reads the teams for the workspace, takes those with `startOnLoad === true`, and starts each one through the host's single team-start entry point — the same path the START button uses, with the spawn cwd set to `startWorktree` when present and the workspace root otherwise. Teams start in the order they appear in the definitions list.

If a team's head is already live — a reload, a second window — `startTeamById` already reconciles that. No new liveness check.

If one team fails to start, the others still start, and the failure surfaces the same way a failed manual START does. Boot never blocks on it.

## Prerequisite

`ptyStartTeam` resolved team definitions from a single root (`TaskViewerProvider.ts:2603`, `root || effectiveRoot`) while the TEAMS tab writes to the board's selected root. In a multi-root window those differ, and start finds the wrong team or none. Autostart calls the same path and would inherit it exactly.

That fix is `feature_plan_20260816212416_team-verbs-read-the-wrong-workspace-db.md`, and it extracts `TaskViewerProvider.startTeamForWorkspace(...)` as the extension host's single team-start entry point. **This plan calls that method.** It does not re-solve the resolution problem and does not work around it.

> **Superseded:** "It is still shippable before that fix, with a known limit… In a single-root window the two roots are the same folder, so autostart works correctly… If this ships first, that limit must be stated wherever the toggle is set, and removed once the prerequisite lands."
> **Reason:** Superseded by construction, not by disagreement. The reasoning was sound when the two plans were independent. They are no longer: this plan's boot hook now calls `startTeamForWorkspace`, which the prerequisite creates, so there is no version of this work that compiles before it. The escape hatch would also have cost a warning string in the UI that had to be found and deleted later — a documented false statement with a deletion deadline.
> **Replaced with:** The prerequisite is hard. Land `feature_plan_20260816212416_…` first. No caveat copy is written into the toggle, because there is no window in which the limit exists.

## Metadata

**Complexity:** 5
**Tags:** feature, backend, ui, reliability
**Project:** Browser Switchboard

## User Review Required

None. The multi-window duplicate-start question is decided below (a DB-backed debounce), not deferred.

## Complexity Audit

### Routine

- Two additive fields on an existing stored shape, both defaulting to off.
- A toggle and a text input on a card that this feature is already rebuilding.
- Reading a config key at boot and looping over a filtered list.

### Complex / Risky

- **The editor drops unknown fields (root cause 1).** Without an explicit carry in `teamsTabSaveAgentGroup`, the toggle resets on the next EDIT+SAVE and nothing logs it.
- **The boot hook must fire exactly once per host launch (root cause 2).** `_startLocalApiServer` is re-entrant; a hook placed there re-spawns teams on every watchdog tick.
- **Two windows on one workspace are two pty fleets.** Each VS Code window runs its own extension host, its own pty host child, and its own `ptyListTerminals`. `startTeamById`'s double-start check (`teamWiring.ts:532-545`) asks *this host's* fleet, so window 2 does not see window 1's head and starts a second full team. Verification step 5 of the original plan asserts the opposite. This needs a cross-process guard, and the DB `config` table is the only shared state both windows already open.
- **Boot-time failure is unattended failure.** A manual START surfaces errors in a toast the operator is looking at. At boot nobody is watching, so a failure that only reaches a toast is a failure that reaches nobody. Every outcome must reach the extension log with the team name and the reason.
- **Spawning at boot competes with everything else boot does.** Each member is a real agent CLI. Starting three marked teams means up to a dozen processes launching while the extension is still activating. The hook must run *after* activation's other work, not inside it.
- **The two hosts have different start paths and different boot sequences.** Extension: `TaskViewerProvider.startTeamForWorkspace`, hooked in `extension.ts`. Standalone: `kanbanProvider.startAgentGroupById`, hooked in `bootstrap.ts` beside the existing `restoreAutobanOnStartup()` precedent.

## Edge-Case & Dependency Audit

**Race Conditions** —
- *Re-entrant hook:* solved by a one-shot instance latch (`_teamAutostartDone`) plus placement outside `_startLocalApiServer`.
- *Two windows / two hosts:* solved by a debounce row in the shared DB. Before starting, the hook reads `terminals.autostart.lastRunAt` from the workspace's `kanban.db` `config` table; if it is within 60 s, the hook logs and skips entirely. On proceeding it writes the current timestamp first. Both windows open the same DB file, so this is genuinely shared state — unlike the pty fleet, which is not. (The `config` table is the blessed home for cross-process state in this codebase; a lock file is not.)
- *Boot vs. a fast manual click:* if the operator clicks START on a marked team inside the debounce window, the click wins — it goes through the verb, which has no debounce. `startTeamById`'s liveness check then refuses whichever arrives second. Correct: an explicit action is never blocked by an automatic one.
- *PTY host not yet ready:* on the extension host, `ptyStartTeam` is gated on `ptyHostReady()` (`TaskViewerProvider.ts:2527`, `:2588`). The hook must wait for the same condition rather than firing into a host with no fleet; a poll-with-timeout (a few seconds, then log and give up) is sufficient and must not block activation.

**Security** — none new. No definition crosses any wire; the hook reads `terminals.agentGroups` host-side and passes an id. `startWorktree` is an operator-authored path from the operator's own board and is used only as a spawn cwd — the same class of value `payload.cwd` already is on the manual path.

**Side Effects** —
- Marked teams spawn agent CLIs at every launch. That is the point, and it is also the reason both fields default to off and no team ships marked.
- A bad `startWorktree` fails that team's start. The other marked teams still start (per-team try/catch), and the failure is logged with the team name and the path.
- Boot takes longer for operators who mark teams. Not blocking: the hook is fire-and-forget, exactly as `restoreAutobanOnStartup()` is at `bootstrap.ts:2198`.

**Migration** — none. Both fields are additive; absence reads as off. A team saved before this change has neither key, `startOnLoad === true` is false, and it is skipped. `migrateAgentGroups` preserves unknown keys on both spread paths (`teamWiring.ts:185`, `:228`), so no converter step is needed. **The one required change is in the webview editor, not in storage** — see root cause 1.

**Dependencies & Conflicts** — edits `src/webview/kanban.html` (toggle + save carry), `src/services/TaskViewerProvider.ts` (the hook + latch), `src/extension.ts` (extension-host call site), `src/standalone/bootstrap.ts` (standalone call site). It **conflicts on `kanban.html` with the TEAMS-tab redesign** and must not run concurrently with it. It does not touch `terminals.html` / `terminals.js`.

## Dependencies

- `sess_20260816212416 — team verbs read the wrong workspace DB` — **hard prerequisite.** Provides `TaskViewerProvider.startTeamForWorkspace(...)`, which this hook calls.
- `sess_teamsthreecards — TEAMS Tab: Pick a Team From Three Cards` — **ordering dependency.** The `START ON LOAD` toggle lands on the team cards that subtask reshapes. Land the redesign first, or run the two as one stream, or the toggle is placed twice.

## Adversarial Synthesis

**Risk summary.** The two dangerous failures are both silent. A toggle that resets on the next EDIT+SAVE looks like it worked and then quietly stops, because the webview save path rebuilds the group object and drops unknown fields; and a boot hook attached to the re-entrant `_startLocalApiServer` re-spawns teams on every watchdog tick, which reads as "agents keep appearing" rather than as a hook bug. Mitigations: `startOnLoad`/`startWorktree` are named explicitly in `teamsTabSaveAgentGroup`'s literal with a round-trip verification step; the hook lives outside `_startLocalApiServer` behind a one-shot instance latch and a DB-backed 60 s cross-window debounce; and every boot outcome — started, skipped, failed — is logged with the team name, because at boot the log is the only surface anyone can read afterwards.

## Proposed Changes

### `src/webview/kanban.html` — the toggle, the worktree field, and the save carry

- **Context:** the team card built by `teamsTabGalleryCard` (`:4523`, reshaped by the three-cards subtask); the editor form at `#agent-groups-inline-form` (`:3113-3140`); `teamsTabShowGroupForm` (`:4742-4777`); `teamsTabSaveAgentGroup` (`:4785-4839`).
- **Logic:**
  1. On each **adopted** team's card: a `START ON LOAD` checkbox bound to `group.startOnLoad`. Shipped *types* do not get one — they have no persisted row to hold it; the toggle appears once the team is adopted.
  2. When checked, reveal a single text input for `startWorktree`, empty by default, `placeholder=""` — no placeholder text implying a worktree is expected.
  3. Toggling either writes the field onto the in-memory group and posts `saveAgentGroup` immediately (the card is a live control, not a form with an OK button — matching how the rest of this tab persists).
  4. **`teamsTabSaveAgentGroup` (`:4830`) — carry the fields explicitly.** Read the existing definition and name both fields in the literal:

     ```js
     const prevGroup = agentsTabEditingGroupId
         ? agentsTabAgentGroups.find(g => g.id === agentsTabEditingGroupId)
         : null;
     const group = {
         id, name, headRole, members,
         ...(promptText ? { prompt: promptText } : {}),
         ...(headPromptText ? { headPrompt: headPromptText } : {}),
         // Autostart fields are NOT editor fields — they are set on the card.
         // This literal rebuilds the group from scratch and drops everything it
         // does not name (see the unassigned comment above), so an EDIT+SAVE
         // would silently clear the operator's START ON LOAD without it.
         ...(prevGroup?.startOnLoad ? { startOnLoad: true } : {}),
         ...(prevGroup?.startWorktree ? { startWorktree: prevGroup.startWorktree } : {}),
     };
     ```
  5. The same carry is needed in the `USE`/adopt fork (`:4561-4568`) only in the sense that a *new* team correctly has neither field — no change required there, and none should be added.
- **Edge Cases:**
  - `startOnLoad: false` is written as **absent**, not as `false`. Absence is the documented default and keeps the stored shape byte-identical for the ~4,000 installs that never touch the toggle.
  - Un-checking the toggle removes the key (and `startWorktree` with it) rather than writing `false`.
  - Whitespace-only `startWorktree` is treated as empty and the key is omitted.

### `src/services/TaskViewerProvider.ts` — the autostart pass

- **Context:** `startTeamForWorkspace` (added by the prerequisite subtask), `_teamLookupRoots` (`:8811`), `_getKanbanDbIfPresent` (`:8850`), `ptyHostReady` (`:2527`), `listTeamsInRoots` (added by the prerequisite). `_startLocalApiServer` (`:2419`) is re-entrant and is **not** the host for this.
- **Logic:** a public, awaited-by-nobody method with a one-shot latch:

```ts
private _teamAutostartDone = false;

/**
 * Start every team marked `startOnLoad` for this workspace, once per host
 * launch. Called from activation (extension.ts) and from bootstrap.ts.
 *
 * Deliberately NOT called from _startLocalApiServer: that method is re-entrant
 * (the liveness watchdog re-invokes it on every check, :748 / :2440 / :3496),
 * and a team-start pass inside it would re-spawn a team every time the operator
 * closed its head. The latch below is the second guard, not the only one.
 *
 * Definitions are resolved by listTeamsInRoots — the same candidate walk the
 * picker and START use — so autostart cannot read a different board than the
 * one the operator authored teams in.
 */
public async startTeamsOnLoad(workspaceRoot: string): Promise<void> {
    if (this._teamAutostartDone) { return; }
    this._teamAutostartDone = true;

    const roots = this._teamLookupRoots(undefined, workspaceRoot);
    const { teams, root: sourceRoot } = await listTeamsInRoots(roots, (r) => this._getKanbanDbIfPresent(r));
    const marked = (teams || []).filter(t => t && t.startOnLoad === true);
    if (marked.length === 0) { return; }

    // Cross-window debounce. Two VS Code windows on one workspace are two
    // extension hosts with two pty fleets, so startTeamById's liveness check
    // (which asks THIS host's fleet) cannot see the other window's head and
    // would start a duplicate team. The DB config table is the only state both
    // windows actually share.
    const db = sourceRoot ? await this._getKanbanDbIfPresent(sourceRoot) : undefined;
    const AUTOSTART_DEBOUNCE_MS = 60_000;
    if (db) {
        const last = Number(await db.getConfigJson('terminals.autostart.lastRunAt', 0)) || 0;
        if (Date.now() - last < AUTOSTART_DEBOUNCE_MS) {
            console.log(`[TaskViewerProvider] Team autostart: skipped — another host started teams `
                + `for '${sourceRoot}' ${Math.round((Date.now() - last) / 1000)}s ago.`);
            return;
        }
        await db.setConfigJson('terminals.autostart.lastRunAt', Date.now());
    }

    // The pty fleet must exist before we ask it for terminals. Poll briefly
    // rather than blocking activation; give up with a log if it never arrives.
    if (!(await this._waitForPtyHost(10_000))) {
        console.warn(`[TaskViewerProvider] Team autostart: PTY host never became ready; `
            + `${marked.length} marked team(s) not started.`);
        return;
    }

    for (const team of marked) {
        // Per-team try/catch: one bad startWorktree must not stop the rest.
        try {
            const result = await this.startTeamForWorkspace({
                teamId: team.id,
                pinnedRoot: workspaceRoot,
                payloadCwd: team.startWorktree || undefined,
            });
            if (result?.success === false) {
                console.warn(`[TaskViewerProvider] Team autostart: '${team.name}' failed — ${result.error}`);
            } else {
                console.log(`[TaskViewerProvider] Team autostart: started '${team.name}'`
                    + (team.startWorktree ? ` in '${team.startWorktree}'` : ''));
            }
        } catch (err) {
            console.warn(`[TaskViewerProvider] Team autostart: '${team?.name}' threw —`, err);
        }
    }
}
```

- **Edge Cases:**
  - `payloadCwd: team.startWorktree` flows into `startTeamForWorkspace`'s existing spawn-cwd rule and falls through to `pinnedRoot` when absent — exactly the documented default. Note that `startWorktree` is a **spawn** directory, never a definition root; `startTeamForWorkspace` keeps those separate by construction.
  - A marked team whose head is already live is refused by `startTeamById` with its existing message, which the loop logs as a failure. That is correct and not an error condition — the log line names it.
  - `_waitForPtyHost` is a small helper polling `ptyHostReady()`; if one already exists in the file, reuse it rather than adding a second.
  - The latch is per-provider-instance. A window reload constructs a new provider, which is the intended reset — the debounce row is what stops a reload from double-starting.

### `src/extension.ts` — the extension-host call site

- **Context:** the delegate-import-at-activation pass at `:819-825` is the closest precedent — a boot-time, awaited, try/caught team-config pass. Autostart must run *after* it (so the import has landed) and must **not** be awaited (spawning agent CLIs must not extend activation).
- **Logic:** immediately after the delegate-import block at `:825`:

```ts
    // Boot-time team autostart. Fire-and-forget, exactly as the standalone host
    // treats restoreAutobanOnStartup (bootstrap.ts:2198): starting agent CLIs
    // must never extend activation, and a failure must never take it down.
    // Placed after the delegate import so a team assembled by that import is
    // eligible on the very first launch after an upgrade.
    if (workspaceRoot) {
        void taskViewerProvider.startTeamsOnLoad(workspaceRoot)
            .catch(err => console.warn('[Switchboard] Team autostart failed:', err));
    }
```

- **Edge Cases:** `taskViewerProvider` is constructed at `:1073`, *after* this point in the file. Place the call after that construction (and after `kanbanProvider!.setTaskViewerProvider(taskViewerProvider)` at `:1187`) rather than literally at `:825` — the ordering requirement is "after the delegate import and after the provider exists", and the provider is the later of the two.

### `src/standalone/bootstrap.ts` — the standalone call site

- **Context:** the delegate-import pass at `:2188-2192` and `void taskViewerProvider.restoreAutobanOnStartup()` at `:2198` — the established boot tail, after the server is listening and the pty fleet is up.
- **Logic:** beside the autoban restore, same fire-and-forget shape:

```ts
    void taskViewerProvider.startTeamsOnLoad(workspaceRoot)
        .catch(err => log(opts, `team autostart failed: ${err}`));
```

- **Edge Cases:** this host is single-root, so `_teamLookupRoots` collapses to one candidate and `listTeamsInRoots` reads the one board — no behaviour difference, no separate code path. The pty fleet is already constructed by this point in `bootstrap`, so `_waitForPtyHost` returns immediately.

## Verification Plan

### Automated Tests

1. `npm run lint`.
2. Source-text contract, added to `src/test/team-autostart-workspace-scope.test.js` (the file that already owns this defect class): `TaskViewerProvider.ts` contains `startTeamsOnLoad` and `_teamAutostartDone`, and `_startLocalApiServer`'s body does **not** contain `startTeamsOnLoad` — pinning "the hook is not on the re-entrant path".
3. Source-text contract: `kanban.html`'s `teamsTabSaveAgentGroup` literal names `startOnLoad` — pinning the field carry against a future re-simplification of that object.

### Manual

4. Mark Coding as start-on-load, close, reopen — a lead, three coders and a reviewer come up seated, with no clicks.
5. Mark a second team as well, reopen — both come up.
6. Leave the worktree field empty: the team spawns in the workspace root.
7. Set a worktree on one team, reopen: that team spawns there, the other still in the root.
8. **Field round-trip (the root-cause-1 gate).** Mark a team, then open `EDIT` on it, change nothing, and save. Re-open the tab: `START ON LOAD` is still on. Then confirm on disk: `sqlite3 .switchboard/kanban.db "select value from config where key='terminals.agentGroups';"` still shows `"startOnLoad":true`.
9. **Re-entrancy gate.** With a team marked, start the extension and leave it running past several liveness-watchdog cycles, then close the team's head terminal manually. No team re-spawns.
10. Open a second window on the same workspace within a minute — no duplicate team, no second set of terminals, and the second window's log carries the `skipped — another host started teams` line naming the elapsed seconds.
11. Open a second window on the same workspace *more* than a minute later with the first window's head closed: the team does start. (The debounce is a duplicate guard, not a lockout.)
12. Give one marked team a deliberately bad worktree path: it fails, the other team still comes up, and the failure is in the extension log naming the team and the path.
13. Load a workspace whose teams were saved before this change — everything behaves as it did, nothing autostarts, and the stored JSON gains no keys.
14. Standalone host (`npx switchboard`): repeat 4, 6 and 12.

---

**Recommendation:** Complexity 5 → **Send to Coder.**

## Completion Report

Implemented the boot-time team autostart feature across four files. `src/webview/kanban.html` gains a `START ON LOAD` checkbox on each adopted team card (with an optional `startWorktree` text input revealed when checked), plus the load-bearing field carry in `teamsTabSaveAgentGroup`'s object literal — `prevGroup?.startOnLoad` and `prevGroup?.startWorktree` are spread into the rebuilt group so an EDIT+SAVE no longer silently wipes the toggle. `src/services/TaskViewerProvider.ts` adds `startTeamsOnLoad(workspaceRoot, opts?)`, gated by a one-shot `_teamAutostartDone` latch and placed outside the re-entrant `_startLocalApiServer`; it resolves definitions via `listTeamsInRoots` (the same candidate walk the picker uses), debounces cross-window duplicates through a `terminals.autostart.lastRunAt` DB row (60 s), polls the pty fleet via a new `_waitForPtyHost` helper, and starts each marked team through `startTeamForWorkspace` (extension host) or `kanbanProvider.startAgentGroupById` (standalone, where `suppressLocalApiServer` means `_ptyHostPort` is never set). `src/extension.ts` fires the pass fire-and-forget after `setTaskViewerProvider`; `src/standalone/bootstrap.ts` fires it beside `restoreAutobanOnStartup` with a `liveTerminals` callback reading the in-process `ptyFleetService`. `src/test/team-autostart-workspace-scope.test.js` gains four source-text contracts: the latch exists, the hook is NOT inside `_startLocalApiServer`, both hosts call it, and the save literal carries `startOnLoad`. One plan correction: the standalone edge-case note claiming "no separate code path" and "`_waitForPtyHost` returns immediately" was aspirational but wrong on mechanism — standalone must route through `startAgentGroupById` (not `startTeamForWorkspace`, which fails on `_ptyHostPort`), and `_waitForPtyHost` short-circuits true via a `suppressLocalApiServer` check rather than via the pty-host condition; the intended behavior is preserved, just with the correct routing.
