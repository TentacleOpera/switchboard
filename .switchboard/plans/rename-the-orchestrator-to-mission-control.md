# Rename the orchestrator to Mission Control

## Goal

Rename the orchestrator persona to **Mission Control**, because its actual role — track progress, notice stalls, nudge, escalate — is watching a field, not orchestrating the work. The name promises a driver and the design deliberately built a monitor.

### Problem Analysis

The persona's own protocol is explicit that it does not orchestrate:

- `switchboard-orchestrator/SKILL.md:39` — **"Dispatch via the queue, never via `POST /kanban/dispatch`. You never call `POST /kanban/dispatch` to route work to a specific coder terminal — that is unconditional and holds in both pacing modes."**
- `:245` — the queue watch **"does *not* dispatch on the lead's behalf — when the lead goes idle with cards still staged it sends *one* nudge telling the lead to call `POST /kanban/queue/next` itself, then escalates to the user once and stops. The lead self-paces; the watch is a backstop against it forgetting, not a replacement for it."**
- `:244` — on seat-routed queues: **"a resident orchestrator over a one-at-a-time pipeline is a manager watching a manager"**, and it must *read* the team's pacing field, not set it: **"an orchestrator that flips other people's team configuration is exactly the unattended side effect this persona is scoped away from."**

So the design is a monitor with escalation rights and no dispatch authority. "Orchestrator" says the opposite, and the cost is not cosmetic: a misnamed persona invites both agents and users to expect it to drive the pipeline. Earlier in this programme the no-reviewer-seat completion path was reasoned about as though the orchestrator were the pipeline driver, precisely because the name says so.

**Scale, measured:** 1,067 occurrences of `orchestrator` / `orchestration` across 55 files in `src/` and `.agents/`. Distinct surfaces:

| Surface | Examples |
|---|---|
| Protocol files | `switchboard-orchestrator(-external/-internal)/SKILL.md`, `switchboard-orchestration/SKILL.md` |
| Config keys | `orchestratorArmed` (28), `orchestratorActive` (13), `orchestratorSeat` (9), `orchestrationConfig` (6), `orchestratorStartResult` (4) |
| On-disk paths | `.switchboard/orchestrator/reports/`, `.switchboard/orchestrator/reports/claimed/` |
| UI | the AUTOMATION tab's "Start orchestrator" control |
| Endpoints | routes under `/orchestration/*` (e.g. `orchestrationHandoff`) |

### Root Cause

The persona was named for the ambition — coordinate multiple teams — and then deliberately scoped down to monitoring to avoid unattended side effects. The scoping-down was the right call and is well documented; the name was never revisited.

## Metadata

**Complexity:** 5
**Tags:** refactor, docs, devops

## User Review Required

- **Decided: Mission Control**, on branding and contract fit. An earlier revision proposed *operator* and leaned on a supposed collision with "the operator" as the human. **That argument was overweighted and is withdrawn.** Measured: 296 occurrences of "operator" in `src/`, but "operator" is not a role (absent from `agentConfig.ts` and every role list), has no UI label, and appears just **8 times** in agent-facing `.agents/` text — three protocol files. The rest are comments meaning the human (*"waiting on the operator"*, *"the order the operator is working on them"*, *"no operator-created team"*). There was no real collision to avoid, so it should not have been a premise.

  The real case is the one that stands on its own: Mission Control names the **station** rather than a person, and it matches the contract the product already illustrates.

  It is also the branded fit. The product's second homepage illustration is `agent-fleet-air-combat-detailed.svg` — a radar scope with tagged interceptors (CLAUDE, DEVIN, GEMINI, OLLAMA) pinging around the central Switchboard saucer, amid range rings and distant contacts, under the heading *"Your terminals, on autopilot."* That is an air-traffic scope: you watch tagged aircraft on a field, you do not fly them. Which is the persona's contract exactly — and the protocol's own line, *"a resident orchestrator over a one-at-a-time pipeline is a manager watching a manager"* (`:244`), is a sentence about a radar operator.

  And it gives the cluster one naming spine: missions on the board, a `missions` panel, a Mission Control dock (`feature_plan_20260808220200_shell-right-agent-dock-terminal.md`), and Mission Control as the persona. Streams read as lanes on a scope, which is what the art already draws.
- **Full rename, no migration.** The orchestrator feature has not shipped to users — no persisted state, no on-disk reports, no external clients. Everything renames in one pass: prose, labels, protocol filenames, config keys, on-disk paths, routes. No dual-read, no aliases.

## Complexity Audit

### Routine

- Prose and comments across 55 files.
- UI labels ("Start orchestrator").
- Protocol file renames and the path references that point at them.

### Complex / Risky

- **The word may already be taken by the human.** `SKILL.md:244` uses "the operator" to mean the person. Renaming the persona to *operator* would make the protocol's own sentences ambiguous. This is the first thing to settle and it may change the whole plan's target word. — **Settled: Mission Control, not operator. No collision.**
- **Protocol filenames are referenced by path.** `TaskViewerProvider.ts:11230` resolves `switchboard-orchestrator/SKILL.md` plus a runsheet by name at dispatch time. Renaming the file without the reference is a silent missing-file failure at dispatch — the agent reports a missing file or proceeds without instructions.
- **`RETIRED_WORKFLOW_PATH_MAP` is the precedent** for persisted-path renames (`agentPromptBuilder.ts:1470`), already carrying three generations. Protocol path renames go there.
- **1,067 occurrences means a mechanical pass with judgement**, not a global replace: some are the human operator, some are the persona, some are the generic English word. A blind substitution will corrupt prose.

## Edge-Case & Dependency Audit

**Migration.** None — the feature hasn't shipped. `RETIRED_WORKFLOW_PATH_MAP` entries for renamed protocol paths are still needed (dispatch-time resolution, not migration).

**Security.** None — no new surface, no route widening.

**Side effects.** The AUTOMATION tab is being deleted entirely (per `the-automation-model-four-things-not-a-mode-axis.md` and `mission-control-panel-ui-specification.md`), so the "Start orchestrator" control does not get renamed — it gets removed. The rail button's tooltip and identity change.

**Ordering.** Independent of the queue and orders work, and deliberately last — it touches many of the same files, and doing it first would churn every other plan's line references.

## Dependencies

- Independent, but **schedule after** the task-complete endpoint, the clause deletion and the orders library, all of which edit `teamWiring.ts` and the orchestrator protocol. Renaming first invalidates their line references for no benefit.

## Adversarial Synthesis

**"It's just a name — 1,067 occurrences of churn for nothing."** Names set expectations, and this one already misled a design discussion into treating the persona as the pipeline driver. It is also no longer only a correction: with missions as the unit of work, Mission Control is the term the rest of the product now implies, so the alternative is a persona named after a job the system no longer describes. And since the feature hasn't shipped, there is no migration cost to doing the full rename — the churn is the only cost, and it is a one-time mechanical pass with judgement.

**"Rename the concept and keep the identifiers."** Moot — the feature hasn't shipped, so there are no persisted identifiers to protect. Everything renames.

**"The persona should just be given dispatch authority so the name is true."** That inverts a documented decision made to prevent unattended side effects — `:244` calls it out by name. If that decision is ever revisited it should be on its own merits, not to justify a name. Note this argument dissolves under the new name: Mission Control is *supposed* to watch, so there is no gap between the name and the contract to close.

## Proposed Changes

1. **Target word settled: Mission Control.** No collision with "the operator" as the human, which stays as-is throughout.
2. **Full rename in one pass — prose, labels, protocol filenames, config keys, on-disk paths, routes.** No dual-read, no aliases, no migration shims — the orchestrator feature has not shipped to users, so there is no persisted state to migrate. Rename everything: protocol text, comments, UI labels, config keys, the reports directory, endpoint routes, and protocol directories with `RETIRED_WORKFLOW_PATH_MAP` entries for the by-path references (`TaskViewerProvider.ts:11230`). **Explicit UI labels to reach:** the `#strip-orchestrator` button's tooltip and identity (`shell.js:271`), the AUTOMATION tab's "Start orchestrator" control, and any `aria-label` / `title` attribute that names the persona.
3. **No global replace.** Distinguish the persona, the human, and the generic word case by case.

### Migration

None — the orchestrator feature has not shipped to users, so there is no persisted state, no config keys on disk, no reports directory with queued work, and no external clients hitting the routes. `RETIRED_WORKFLOW_PATH_MAP` entries for renamed protocol paths are still needed (the map is read at dispatch time, not migration time).

## Verification Plan

### Goal Invariants

- No user-visible text or protocol prose calls the persona an orchestrator.
- Every by-path protocol reference resolves.
- No config key, on-disk path, or route uses the old name.

### Automated Tests

- **Every protocol path resolves:** assert each `.agents/protocols/...` string literal in `src/` names an existing file. This catches the silent dispatch-time failure that a filename rename causes, and it is the single most valuable test here.
- **No persona-as-orchestrator in user-facing text:** assert UI labels and protocol prose are clean, with an explicit allowlist for occurrences that mean the human or the generic word — the allowlist being the honest record of where the word legitimately survives.
- **Two agent-facing `OPERATOR` strings survive verbatim:** `terminals.js:11201` (`OPERATOR INSTRUCTION:`) and `:11670` (`[OPERATOR NOTICE] Standing orders updated for team.`). Both are prefixes telling an agent a message came from the human, they are correct as written, and they are the only non-comment uses of the word. A grep for `operator` surfaces all 296 occurrences, so these two are the ones a mechanical pass is likeliest to damage.
- **Retired paths map:** assert old protocol paths resolve through `RETIRED_WORKFLOW_PATH_MAP`, and that the three pre-existing generations still do.
- **No old identifiers remain:** assert no config key, on-disk path, or route in `src/` uses `orchestrator` or `orchestration` (with an explicit allowlist for occurrences that mean the human or the generic word).

## Completion Report

Renamed the orchestrator persona to Mission Control across the entire codebase: protocol directories (`switchboard-orchestrator` → `switchboard-mission-control`, `switchboard-orchestration` → `switchboard-mission-control-http`), config keys (`orchestratorArmed` → `missionControlArmed`, `orchestratorSeat` → `missionControlSeat`, `orchestratorActive` → `missionControlActive`, `orchestrationConfig` → `missionControlConfig`, `orchestratorStartResult` → `missionControlStartResult`), endpoint routes (`/orchestration/*` → `/mission-control/*`), on-disk paths (`.switchboard/orchestrator/` → `.switchboard/mission-control/`), UI labels (shell.js, shell.html, kanban.html, terminals.html, implementation.html), function names, constants, postMessage types, CSS class names, and all protocol SKILL.md prose. Updated `RETIRED_WORKFLOW_PATH_MAP` with entries for the renamed protocol paths. ~60 files changed across `src/`, `.agents/`, `.claude/`, `AGENTS.md`, and `CLAUDE.md`. Remaining `orchestrat*` occurrences in `src/` are all legitimate: the `PipelineOrchestrator` class name, the retired `'orchestration'` automation mode value, generic "orchestration" as an English word (e.g. "feature orchestration directive", "subagent orchestration capabilities"), and blocklist entries for old workflow paths. Webpack compiles clean; all rename-related test failures were fixed (one test file was renamed: `orchestrator-tick-and-reports-contract.test.js` → `mission-control-tick-and-reports-contract.test.js`). Two pre-existing test failures unrelated to the rename remain in `seat-safeguards-fleet-prompt-path.test.js` and `browser-stray-dispatch-surface.test.js`.
