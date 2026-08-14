# External Orchestration Surface — Honest Deletes, Dead Scaffolding Removed

**Complexity:** 3

## Goal

Make the surface external agents drive tell the truth about itself. `DELETE /kanban/plans` removes the DB row but leaves the markdown, so the plan re-imports and the delete silently reverses itself — and deleting a subtask corrupts its parent feature file. Separately, an entire instruction-inbox / standing-jobs / declared-board-moves subsystem is described in the Spark context, in a Connections sub-tab and in three database tables, while being **unreachable dead code** that has never executed on any install; it is removed outright so nothing is left to suggest Switchboard has an inbox system.

## How the Subtasks Achieve This

- **`DELETE /kanban/plans` Leaves the Markdown and the Feature File Behind**: flips `deleteFile` from opt-in to opt-out so the row and the `.md` go together (a kept file re-imports, which is why the opt-out exists), refuses feature rows outright (their `.md` lives under `.switchboard/features/`, outside the endpoint's traversal guard, so a "delete" there resurrects on the next scan), regenerates the parent feature's subtask block when the deleted plan was a subtask — reached through a new injected callback wired in **both** hosts — reports what actually happened in the response, and rewrites the documented contract across `switchboard-orchestration/SKILL.md` and `rearrange-feature/SKILL.md` plus their `.claude/` mirrors. Brings the API delete to parity with the board button.
- **Remove the Instruction-Inbox / Standing-Jobs / Declared-Moves Subsystem Entirely**: deletes `ScheduledJobsService.ts` and its two call sites, three write-only DB tables, the protocol section in the generated Spark context, the jobs cards in the Connections panel, and the test file that kept it all green. The acceptance criterion is that a set of greps returns nothing — because the residue, not the code, is the problem.

Both subtasks are the same principle applied twice: **what the system tells an agent must match what the system does.** One endpoint claims a delete it does not perform; one subsystem documents a capability it does not have.

**Why the second subtask is a deletion (decided 2026-08-14).** It was three times planned as governance — a default-OFF gate, then a provenance gate covering `POST /kanban/move` too, then a channel retirement. All three assumed the declared-move channel was live and dispatching agents. Investigation found `bootstrapInstructionsDirectory()` — the only code that creates the directories the whole subsystem watches — has **no production callers**, only eight in a test file. `.switchboard/instructions/` does not exist on the author's install and all three tables hold zero rows. There was never a channel to govern.

**Why total removal rather than deprecation.** The subsystem is described far more thoroughly than it is implemented: a full protocol in Spark's uploadable context (claim markers, 24-hour leases, job schedules, run-log cursors), a Connections sub-tab presenting it as a running feature with a hardcoded "Recent Job Activity" panel that has no JavaScript wiring at all, and three tables in the schema. Any surviving fragment — including a well-meant "this was removed" comment — is enough for a future agent to conclude Switchboard has an inbox system and build on it. The plan therefore forbids tombstones and makes the greps the definition of done.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [External Orchestration — Governance, Brakes and Controls in Connections](../plans/feature_plan_20260805140000_external-orchestration-governance-in-connections.md) — **PLAN REVIEWED**
- [ ] [`DELETE /kanban/plans` Leaves the Markdown and the Feature File Behind — Bring It to Parity With the Board's Delete](../plans/feature_plan_20260812120500_delete-plan-api-parity-with-board-delete.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Plan Review Status

**Replanned as one unit on 2026-08-14. Feature and both subtasks are uniformly PLAN REVIEWED and ready for a coder.**

> **Superseded:** "Uniformly CREATED. Replan the whole feature before dragging it to a coder column… Note for whoever reviews: the governance plan has already been through a full `improve-plan` pass… Re-reviewing it should be cheap — confirm and advance rather than re-deriving. In particular, the `noPipelineInHost` branch is a settled correction, not an open question."
> **Reason:** The replan asked for has now run across both subtasks together, so the CREATED framing is stale. More importantly, the instruction to treat the governance plan as cheap-to-confirm was itself the trap: the `noPipelineInHost` design rested on two claims about the code that are **false at HEAD** — `PipelineOrchestrator` *is* constructed in the standalone host (it is built in the `TaskViewerProvider` constructor at `TaskViewerProvider.ts:906`, and `bootstrap.ts:702` constructs one), and the declared-move channel is *not* wired in the standalone host at all (`setGlobalPlanWatcher` has exactly one caller, `extension.ts:845`). A "confirm, don't re-derive" pass would have shipped a brake that holds every declared move forever for any user who has never pressed Start. Settled-ness is a property of evidence, not of how many passes a plan has had.
> **Replaced with:** the brake, the gate and the whole governance design are gone. Investigation established that the subsystem they governed has **no production entry point** and has never executed. The second subtask is now a deletion.

**The lesson, recorded because it cost four rewrites:** this subtask was planned four times — default-OFF gate, provenance gate, channel retirement, and finally deletion — and the first three were all confidently wrong in the same way. Each inherited "the channel is live and ungated" from the version before it and reasoned forward instead of checking. One grep for callers of `bootstrapInstructionsDirectory` would have settled it at any point. Before planning against a described capability, confirm something actually calls it.

Both subtask plans carry full Superseded audit trails for every correction made in this pass.

## Dependencies & sequencing

- **The two subtasks are fully independent and can land in any order — no source file and no documentation file is in both.** Delete-parity touches `LocalApiServer.ts`, both hosts' option bags (`TaskViewerProvider.ts:2362`, `bootstrap.ts:1936`), and two files under `.agents/skills/`. The removal subtask touches `ScheduledJobsService.ts` (deleted), `KanbanProvider.ts`, `KanbanDatabase.ts`, `SparkContextExporter.ts`, `connections.html` and one test file. The intersection is empty.

  > **Superseded:** first "One shared file: `.agents/skills/switchboard-orchestration/SKILL.md` — the delete subtask rewrites the `DELETE /kanban/plans` contract line; the governance subtask documents the gate. Serialise that file"; then, after that was removed as an invented constraint, its re-instatement on the grounds that "governance had to document `origin`, `403 gated` and `409 held` on the `POST /kanban/move` contract in that same file."
  > **Reason:** the re-instatement was true only for the provenance-gate design, which no longer exists. The removal subtask touches no skill documentation at all — the control plane never described this subsystem in the first place (grepping `.agents/` and `.claude/` for `instructions/inbox`, `instructions/standing`, `instructions/moves`, `standing job`, `claim marker` and `run-log` returns nothing). The constraint has been true, then false, then true, then false across four framings of the same subtask; it is recorded this way so the next reader trusts the evidence rather than the history.
  > **Replaced with:** no shared file. Delete-parity alone owns the documentation work, across six sites in two skills (`switchboard-orchestration/SKILL.md` lines 84 / 102 / 105-106 and `rearrange-feature/SKILL.md` lines 43 / 57 / 65) plus their generated `.claude/` mirrors — regenerate those, never hand-edit, and verify with `npm run mirror:check`.

- **The removal subtask's acceptance criterion is a set of greps returning nothing, not compilation.** The subsystem never ran, so a green build proves nothing about whether the removal is complete. The plan lists the exact greps.
- **Two ways to get the removal wrong, both explicit in the plan:** deleting the **orchestrator's** inbox (`.switchboard/orchestrator/inbox/`, `POST /orchestrator/request`, `GET /orchestrator/inbox`, `last-wake-complete`) by mistake — it is a live, coherent upward-request channel that shares only the word "inbox" — and leaving a tombstone comment explaining what was removed, which reconstitutes the idea in the exact place the next agent will read it.
- **The delete subtask carries a both-host wiring step that fails silently if half-done.** The feature-regeneration callback must be injected at `TaskViewerProvider.ts:2362` *and* `bootstrap.ts:1936`; wired in only one, the response still reports `success: true` while the feature file quietly goes stale under the other host. Verify on disk, not from the response body.
- **No urgency asymmetry.** An earlier version of this section claimed the declared-move channel was dispatching coding agents in `src/` *now*. It was not, and never had been — the directory it watches is created by a function with no production callers. Neither subtask carries a live window; both are correctness work.

## Follow-up recorded, not planned here

**The orchestrator may be partly superseded by agent teams.** `_orchestrationDispatchFeature` (`TaskViewerProvider.ts:10068`) fans a feature out to **one shared worktree and one terminal** as a single batch, while the newer agent-teams mechanism (`teamWiring.ts`, `agentGroupInstantiation.ts`, `terminals.agentGroups`) spawns a **head with up to 8 delegate children**, auto-installs a callback standing order on each, registers them as one terminals group, works in both hosts, and has a structured result contract (`POST /delegates/result`). The orchestrator's still-unique jobs are grouping plans into features, worktree lifecycle and merge-back, and the unattended wake cadence. Moving fan-out onto teams — *"all the orchestrator needs to do is manage different agent teams"* — would retire its bespoke dispatch, its own file inbox and its `last-wake-complete` mtime handshake. That is an architecture change with its own design surface and belongs in a separate plan.
