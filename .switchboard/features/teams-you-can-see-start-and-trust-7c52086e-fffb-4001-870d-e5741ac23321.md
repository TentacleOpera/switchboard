# Teams You Can See, Start and Trust

**Complexity:** 6

## Goal

Make a team something the operator can find, understand, launch and rely on. Right now the two team verbs read a different workspace database than the TEAMS tab writes to, so the terminals panel lists a phantom member-less Lead team and START spawns a lead with none of its members; the only route to START is an 11px plus glyph inside a menu titled New terminal; and the tab itself is a roster form you have to assemble in your head. This feature fixes the resolution bug at the root, promotes START TEAM into the terminals sidebar ops block, turns the tab into three pickable cards that draw their own topology, and lets a marked team come up on its own at load.

## How the Subtasks Achieve This

- **Team Picker Shows a Phantom Member-less "Lead team"**: The root-cause bug, reproduced live on this machine rather than inferred. Threads `_teamLookupRoots` into `ptyListAgentGroups` and `ptyStartTeam` so both walk the same candidate roots the auto-start path already does, and skips a root whose entire team list is the untouched `SEEDED_AGENT_GROUP` so a phantom seed cannot out-rank a real team. Adds a read-only `peekAgentGroups` so a *read* verb stops writing to a database it was only asked to read — a contract fix rather than the symptom fix, since both hosts also seed the selected root at boot (`extension.ts:819-825`, `bootstrap.ts:2188-2192`). Both reported symptoms, wrong member counts and a lead spawning alone, fall out of the one root-divergence cause. This subtask also extracts `TaskViewerProvider.startTeamForWorkspace(...)`, the single host-side start entry point the other two backend-touching subtasks call.
- **Promote START TEAM Out of the Tiny `+` Picker Into the Terminals Sidebar Ops Block**: Moves the START action into `.sidebar-ops` as a full-width button beside `FILL GRID`, copying that control's inline-form pattern for the team and workspace parameters so no new visual language is introduced. Deletes the picker's team section in the same change so there is exactly one entry point, while keeping the role-chip annotation — a warning label on a different control, not a duplicate button.
- **TEAMS Tab — Pick a Team From Three Cards and See It Drawn**: Turns the tab into three portrait cards that, on click, draw the team's actual topology below — head, members, arrows typed by `relationship`, START on the flow panel. Everything needed is already in `headRole` and `members[]`; nothing new is stored or computed. Placeholder art behind a `<symbol>`/`<use>` indirection is the expected first state, so finished art is later a `<defs>` edit that cannot shift the layout.
- **Teams Start Themselves on Load**: Adds additive `startOnLoad` and optional `startWorktree` fields and calls `startTeamForWorkspace` at boot for each marked team — the same entry point the START button uses, made by the host instead of by a click. Both fields default to off, so teams saved on the ~4,000 existing installs read correctly with no migration pass. Two non-obvious guards carry the subtask: the TEAMS-tab save path rebuilds the group object and drops unknown keys, so both fields must be named explicitly or the toggle silently resets on the next edit; and the hook must sit outside the re-entrant `_startLocalApiServer`, behind a one-shot latch and a DB-backed cross-window debounce.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Team Picker Shows a Phantom Member-less "Lead team" — the Two Team Verbs Resolve One Root and Seed Into It](../plans/feature_plan_20260816212416_team-verbs-read-the-wrong-workspace-db.md) — **CODE REVIEWED**
- [ ] [Promote START TEAM Out of the Tiny `+` Picker Into the Terminals Sidebar Ops Block](../plans/feature_plan_20260816212500_start-team-is-a-first-class-sidebar-control.md) — **CODE REVIEWED**
- [ ] [Teams Start Themselves on Load](../plans/teams-start-themselves-on-load.md) — **CODE REVIEWED**
- [ ] [TEAMS Tab — Pick a Team From Three Cards and See It Drawn](../plans/teams-tab-pick-a-team-from-three-cards.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **The workspace-db fix lands first, and the dependency is now hard for two subtasks, not soft for one.** That subtask extracts `TaskViewerProvider.startTeamForWorkspace(...)` — the single host-side team-start entry point that owns the candidate-root walk, the spawn-cwd rule and the post-start broadcast. Both *Teams Start Themselves on Load* and *TEAMS Tab — Pick a Team From Three Cards* call it. Neither compiles before it, and neither may inline a resolution path of its own; that is precisely how the explicit-start verbs acquired this bug in the first place.

  > **Superseded (reconciliation audit):** "Shipping autostart first is possible in a single-root window… If it does ship first, that limit must be stated wherever the toggle is set and removed once the fix lands."
  > **Reason:** Correct when the two plans were independent; obsolete now that autostart calls the extracted entry point. There is no build in which autostart ships first, so the caveat copy would be a documented false statement in the UI with a deletion deadline attached.
  > **Replaced with:** Hard prerequisite. No caveat copy is written.

- **⚠ The TEAMS-tab redesign and autostart edit the same surface.** The redesign reshapes the team cards; autostart adds a `START ON LOAD` toggle and an optional worktree field to each team on those cards. Land the redesign first so the toggle is placed on the final card shape, or run the two as a single stream. Do not run them concurrently against `kanban.html`.
- **The sidebar START TEAM button runs in parallel with everything else here.** It touches only `src/webview/terminals.html` and `src/webview/terminals.js`, and no other subtask touches either file, so it is safe concurrently under the one-stream-per-file rule. It is also the only subtask with no dependency on the extracted entry point — it calls the `ptyStartTeam` verb over HTTP exactly as the code it replaces does.
- **`TaskViewerProvider.ts` is contended by three subtasks, but only one writes it.** The workspace-db fix authors `startTeamForWorkspace`; the redesign and autostart only *call* it (from `KanbanProvider.ts` and `extension.ts`/`bootstrap.ts` respectively). Serialise the authoring subtask ahead of both; the two callers then touch disjoint files and can run concurrently with each other apart from their shared `kanban.html` conflict above.
- **Both subtasks correct landed work rather than duplicating it.** The sidebar button is the unfinished placement half of `explicit-team-start-in-terminals-panel.md`, and the three-card tab is a follow-on to `teams-tab-three-presets-and-phone-a-friend.md` — both CODE REVIEWED subtasks of the *Teams: make the TEAMS tab actually useful* feature.

**Execution order:** (1) workspace-db fix → (2) TEAMS-tab three cards → (3) autostart. The sidebar START TEAM button runs alongside any of them.

## Reconciled end-state (cross-subtask audit)

The shared surfaces and the single agreed design for each, so a coder implements to one answer:

| Shared surface | Contending subtasks | Reconciled end-state |
| :--- | :--- | :--- |
| Host-side team start | workspace-db fix (author), autostart (call), three-card tab (call) | **One** entry point: `TaskViewerProvider.startTeamForWorkspace({teamId, pinnedRoot, payloadCwd?, parentRoot?, worktreePath?})`. Callers pass inputs, never a resolved definition root. The `ptyStartTeam` verb becomes a thin wrapper that keeps the wire-only `payload.group` rejection. |
| `terminals.agentGroups` shape | autostart (adds fields), three-card tab (reads for the diagram) | Additive `startOnLoad?: true` and `startWorktree?: string`; absent means off, never written as `false`. Storage preserves unknown keys; **`kanban.html`'s `teamsTabSaveAgentGroup` does not** and must name both fields explicitly. |
| The team card in `kanban.html` | three-card tab (reshapes), autostart (adds a toggle) | The card is the portrait/name/purpose/roster click target from the redesign; the `START ON LOAD` toggle lands on **adopted** teams' cards only. One stream, redesign first. |
| Who can be started | three-card tab | Shipped `SHIPPED_TEAM_TYPES` are templates with no id and no DB row. One button whose label resolves from state: `START` for an adopted team, `USE & START` for an un-adopted type, sequenced on `saveAgentGroupResult`. Never a dead click, never two peer buttons. |
| Entry points to START | sidebar button, three-card tab | Deliberately two, on two different panels: the terminals sidebar starts a team while you work the fleet; the TEAMS tab starts the team you are looking at. Not peers — the `+` role picker's team section is deleted so each panel has exactly one. |
| Seeding `SEEDED_AGENT_GROUP` | workspace-db fix | Boot seeds the selected root on both hosts and keeps doing so (`extension.ts:819-825`, `bootstrap.ts:2188-2192`). The read verb stops seeding, and the candidate walk skips seed-only roots. The seed is neutralised for resolution, never deleted. |

No subtask was merged, split or deleted — the four are genuinely disjoint units of work with one shared seam, and the audit's output was the seam's contract rather than a change of composition.

## Review Findings

All four subtasks reviewed in place against their plan files with cross-subtask regression tracing; the reconciled seam held — `startTeamForWorkspace` is the single extension-host entry point and both downstream subtasks call it rather than re-deriving a root, and the `terminals.agentGroups` additive-fields contract survives the webview save. One CRITICAL and three MAJOR were found and fixed, across `protocol-catalog.json`, `src/generated/verbAllowlist.ts`, `src/webview/kanban.html` and `src/test/team-autostart-workspace-scope.test.js`: the TEAMS-tab `startAgentGroup` arm was never catalogued so it dead-clicked over HTTP in the browser cockpit and broke the CI-wired `catalog:check`; `USE & START` left its button live during the save round-trip and never rolled back an optimistically-adopted card on save failure; and both new source-text contract tests used fixed character windows that ended before their assertion targets, so two gates named in the plans were red in CI no matter what the code did. Gate-wiring audit: `catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `verb-returns:check`, `lint` and `test:contract:team-autostart-scope` are all invoked by `.github/workflows/integration-tests.yml`; the one hole is that `eslint.config.js` scopes to `**/*.ts`, so the webview JS/HTML that carries most of this feature is not covered by the lint gate (pre-existing and documented at `integration-tests.yml:835`). Final state: `compile-tests` clean, `team-autostart-workspace-scope` 22/22 pass, `lint` 0 errors, and every ratchet/parity/catalog gate green.
