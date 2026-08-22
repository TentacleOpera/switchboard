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
- **How far does the rename reach?** Proposed: protocol filenames, UI labels and prose everywhere; config keys and on-disk paths **only with migration**. A prose-and-labels-only rename is a legitimate cheaper option.

## Complexity Audit

### Routine

- Prose and comments across 55 files.
- UI labels ("Start orchestrator").
- Protocol file renames and the path references that point at them.

### Complex / Risky

- **The word may already be taken by the human.** `SKILL.md:244` uses "the operator" to mean the person. Renaming the persona to *operator* would make the protocol's own sentences ambiguous. This is the first thing to settle and it may change the whole plan's target word.
- **On-disk paths are shipped state.** `.switchboard/orchestrator/reports/` and its `claimed/` subdirectory hold real files on user machines, written by `ScheduledJobsService` (`:227`) and read by the persona. Renaming the directory needs a migration that reads both locations, and per this project's rules the old path must keep working rather than being abandoned. A rename that orphans queued reports loses work.
- **Config keys are persisted.** `orchestratorArmed`, `orchestratorActive`, `orchestratorSeat`, `orchestrationConfig`, `orchestratorStartResult` are read from stored config. Renaming requires reading old keys and writing new, with the old kept for installs that have not activated on the new version.
- **Endpoint routes are a public-ish contract.** `/orchestration/*` is reachable by external clients, and the protocol catalog serves the endpoint list at `GET /catalog` for exactly that purpose. Renaming a route means either keeping the old path as an alias or breaking a client. Aliasing is the safe answer and should be stated rather than discovered.
- **Protocol filenames are referenced by path.** `TaskViewerProvider.ts:11230` resolves `switchboard-orchestrator/SKILL.md` plus a runsheet by name at dispatch time. Renaming the file without the reference is a silent missing-file failure at dispatch — the agent reports a missing file or proceeds without instructions.
- **`RETIRED_WORKFLOW_PATH_MAP` is the precedent** for persisted-path renames (`agentPromptBuilder.ts:1470`), already carrying three generations. Protocol path renames go there.
- **1,067 occurrences means a mechanical pass with judgement**, not a global replace: some are the human operator, some are the persona, some are the generic English word. A blind substitution will corrupt prose.

## Edge-Case & Dependency Audit

**Migration.** Required for the reports directory, the config keys, and any renamed protocol path. Each follows an existing precedent — dual-read for paths, dual-key read for config, `RETIRED_WORKFLOW_PATH_MAP` for protocol paths.

**Security.** None, provided route aliases do not widen what is reachable.

**Side effects.** Renaming the AUTOMATION control changes a shipped affordance users have learned. Worth a release note.

**Ordering.** Independent of the queue and orders work, and deliberately last — it touches many of the same files, and doing it first would churn every other plan's line references.

## Dependencies

- Independent, but **schedule after** the task-complete endpoint, the clause deletion and the orders library, all of which edit `teamWiring.ts` and the orchestrator protocol. Renaming first invalidates their line references for no benefit.

## Adversarial Synthesis

**"It's just a name — 1,067 occurrences of churn for nothing."** Names set expectations, and this one already misled a design discussion into treating the persona as the pipeline driver. It is also no longer only a correction: with missions as the unit of work, Mission Control is the term the rest of the product now implies, so the alternative is a persona named after a job the system no longer describes. That said, the argument for the *cheap* version is strong: prose, labels and protocol filenames carry nearly all of the expectation-setting, while config keys and on-disk paths carry almost none and hold all the migration risk.

**"Rename the concept and keep the identifiers."** Genuinely defensible, and the recommended v1: users and agents read prose and labels, not config keys. `orchestratorArmed` staying is a mild internal inconsistency; a botched reports-directory migration loses queued work.

**"The persona should just be given dispatch authority so the name is true."** That inverts a documented decision made to prevent unattended side effects — `:244` calls it out by name. If that decision is ever revisited it should be on its own merits, not to justify a name. Note this argument dissolves under the new name: Mission Control is *supposed* to watch, so there is no gap between the name and the contract to close.

## Proposed Changes

1. **Target word settled: Mission Control.** No collision with "the operator" as the human, which stays as-is throughout.
2. **v1 — prose, labels, protocol filenames:** rename the persona in all protocol text, comments and UI labels; rename the protocol directories and update the by-path references (`TaskViewerProvider.ts:11230`), adding `RETIRED_WORKFLOW_PATH_MAP` entries.
3. **v2 — identifiers, only if wanted:** config keys with dual-read, the reports directory with dual-read, and `/orchestration/*` route aliases.
4. **No global replace.** Distinguish the persona, the human, and the generic word case by case.

### Migration

v1: `RETIRED_WORKFLOW_PATH_MAP` entries for renamed protocol paths. v2 adds dual-read for config keys and the reports directory, and route aliases.

## Verification Plan

### Goal Invariants

- No user-visible text or protocol prose calls the persona an orchestrator.
- Every by-path protocol reference resolves.
- (v2) Old config keys, the old reports directory and old routes still work.

### Automated Tests

- **Every protocol path resolves:** assert each `.agents/protocols/...` string literal in `src/` names an existing file. This catches the silent dispatch-time failure that a filename rename causes, and it is the single most valuable test here.
- **No persona-as-orchestrator in user-facing text:** assert UI labels and protocol prose are clean, with an explicit allowlist for occurrences that mean the human or the generic word — the allowlist being the honest record of where the word legitimately survives.
- **Two agent-facing `OPERATOR` strings survive verbatim:** `terminals.js:11201` (`OPERATOR INSTRUCTION:`) and `:11670` (`[OPERATOR NOTICE] Standing orders updated for team.`). Both are prefixes telling an agent a message came from the human, they are correct as written, and they are the only non-comment uses of the word. A grep for `operator` surfaces all 296 occurrences, so these two are the ones a mechanical pass is likeliest to damage.
- **Retired paths map:** assert old protocol paths resolve through `RETIRED_WORKFLOW_PATH_MAP`, and that the three pre-existing generations still do.
- **(v2) Dual-read:** assert a stored `orchestratorArmed` and a populated `.switchboard/orchestrator/reports/` are both still honoured after the rename. Without this, a rename silently orphans queued reports.
- **(v2) Route aliases:** assert `/orchestration/*` still responds.

## Outstanding Questions

- **[user]** v1 only (prose, labels, protocol files), or v2 as well (config keys, paths, routes)?
- How many of the 1,067 `orchestrator`/`orchestration` occurrences mean the persona rather than the generic word? That count decides whether the mechanical pass is an afternoon or a week, and it is worth taking before committing to v2. (The parallel question for "operator" is settled: 296 occurrences, none a role or label, 8 agent-facing, 2 non-comment strings that stay.)
