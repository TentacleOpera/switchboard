# Every skill declares its preconditions and what to do when they are unmet

## Goal

Make capability discovery a property of each skill rather than a separate phase. Every discoverable skill states what it needs, how to check for it cheaply, and what to do when it is absent — so an agent in a session lacking that channel says so instead of improvising.

### Problem Analysis

Which channels to Switchboard state an agent can reach is not a property of "local" or "cloud" — it is a function of what the user has configured. A session may have a clone and nothing else, a clone plus Linear MCP, a reachable LocalApiServer, a tracker-synced context document, a separate git plans repo, or any combination. Nothing about the host determines the set.

The four discoverable skills handle this inconsistently:

| Skill | Needs | States it? | Degrades? |
| :--- | :--- | :--- | :--- |
| `manage-features` | filesystem, or LocalApiServer for the `create-feature.js` path | **Yes** | **Yes** — checks `.switchboard/api-server-port.txt`, health-checks it, falls back to a direct file write |
| `worktree-cleanup` | `switchboard.apiToken` setting, LocalApiServer | **Partly** — has a `## Prerequisites` section naming the setting | **No** — says nothing about an unreachable server |
| `kanban_operations` | LocalApiServer + scripts | No | No |
| `query-kanban` | a local `kanban.db` | **No** — 13 references to `sqlite3`/`kanban.db`, and its description promises "direct SQL access to kanban.db" unconditionally | **No** |

`manage-features` is the working pattern and the proof it is cheap: probe, health-check, fall back. `query-kanban` is the counterexample — a cloud or tracker-only agent loads it, finds no database, and has nothing telling it that is expected. The likely outcomes are inventing a path, reporting a broken system, or burning a turn discovering the absence.

### Scope correction: `query-kanban` needs its primary method inverted, not a precondition bolted on

An earlier revision of this plan proposed adding a `## Preconditions` section to `query-kanban`. That treats a DB-less session as the exception. It is the wrong fix, because **SQL should not be the skill's primary method for anyone**:

- **Read endpoints already exist and cover the need.** `LocalApiServer` serves `GET /kanban/board`, `/kanban/columns`, `/kanban/features`, `/kanban/plan` and `/kanban/plans`. Agents already use them — the team head's own standing order calls `GET /kanban/plans?featureId=<id>` (`teamWiring.ts:754-757`). So SQL buys no capability the API lacks.
- **The skill teaches only SQL.** Its body is `sqlite3` mechanics end to end: *"SQL CLI: Use `sqlite3` CLI"* at line 2, then `$SB_ROOT/.switchboard/kanban.db` path resolution, `-readonly`, and a guard against `sqlite3` fabricating an empty database on a wrong cwd. It never mentions an endpoint.
- **That guard is the tell.** The skill defends against a failure mode the endpoints do not have — a stray 0-byte `kanban.db` from a wrong working directory. Fronting the API removes the class rather than guarding it.
- **It is model-loadable.** `invocation: 'no-user'`, so a team member can pick it up unprompted and start reading the DB directly, bypassing every guard the API layer applies.
- **The project has already made this argument.** `switchboard-manage-console-skill.md` records the decision not to add MCP: over a localhost HTTP API with shell-capable hosts, a second surface "adds discoverability/ergonomics, not capability, and is a second surface to keep in sync." SQL is exactly that — a second access path with no capability advantage, and one that bypasses validation.

So the change for this skill is: **endpoints become the documented method; SQL is demoted to a clearly-labelled fallback for the no-API case, or removed entirely.** A precondition then describes when the *fallback* applies, which is the narrow thing preconditions are good at.

This is a rewrite of a shipped skill rather than an addition to it, and it raises this plan's complexity. The other three skills are unchanged — they keep the precondition-and-degrade treatment described below.

**Discovery-as-a-phase is the wrong shape.** An up-front "work out what you can reach" step costs tokens on every session, must enumerate channels it cannot know about, and produces a claim that is stale the moment auth expires. Discovery at point of use costs nothing until the capability is wanted and is always accurate. The pattern already exists in the codebase; it just is not applied uniformly.

**A configured channel is not a reachable one.** This is the specific trap: in the session that produced this plan, Linear MCP was configured and unavailable — it required an OAuth flow the session could not run. Any design that treats configuration as availability will send agents down dead paths.

### Root Cause

Skills were written against the environment their author had. `manage-features` was written for a path that might or might not have the extension running, so it grew a fallback. `query-kanban` was written where a local DB obviously existed, so it never needed one. Neither author was wrong; nothing required them to state the assumption.

### Non-goals

- Building a discovery phase, manifest, or capability-probing step.
- Changing what any skill does when its preconditions *are* met.
- Adding resident text to `CLAUDE.md` / `AGENTS.md`. The whole point is that this costs nothing until a skill is loaded.

## Metadata

**Complexity:** 4
**Tags:** docs, reliability, refactor, cli

## User Review Required

No. This adds a stated precondition and a fallback instruction to skills that lack them, modelled on a pattern already shipped in `manage-features`.

## Complexity Audit

### Routine

- Adding a `## Preconditions` section to `kanban_operations`.
- Extending `worktree-cleanup`'s existing `## Prerequisites` with a reachability check and a what-if-absent clause.
- Adding a precondition clause to each skill's `description` in `MIRROR_MANIFEST`, since the description is what an agent sees before deciding to load.

### Complex / Risky

- **Rewriting `query-kanban` around the endpoints is the bulk of this plan.** Every query template in it is SQL and each needs an endpoint equivalent, or an honest statement that no endpoint covers it — which is itself a finding worth surfacing, since a query with no endpoint equivalent is either a gap in the API or a query teams should not be running. Do not translate mechanically: check each against the five read endpoints first.
- **The description matters more than the body.** An agent decides whether to load a skill from its one-line description. `query-kanban`'s currently promises "direct SQL access to kanban.db" with no qualifier, so an agent in a DB-less session loads it on the strength of that. The description must lead with the endpoint method, not merely gain a precondition clause.
- **"Say so" must be specific about what to say.** A fallback that reads "otherwise explain you cannot" invites an agent to declare the system broken. The instruction should name the likely reason — no local database in a cloud or tracker-only session — so the agent reports a configuration fact rather than a fault.
- **Do not encourage improvisation as the fallback.** `query-kanban` exists partly because hand-written SQL silently returns nothing (column labels differ from stored IDs). Its no-API path must not read "query the DB another way" — and note the label/ID trap is an argument *for* the endpoints, which return records rather than requiring the caller to know the mapping.
- **`kanban_operations` and `worktree-cleanup` are `no-model`.** They are invisible to the model, so their preconditions matter only for a human reading them or a future visibility change. Worth doing for consistency, but the value is in the two model-visible skills.

## Edge-Case & Dependency Audit

**Race conditions**
- A LocalApiServer that dies between probe and use. `manage-features` already tolerates this by health-checking rather than trusting the port file's existence; the same check should be copied rather than reinvented.

**Security**
- None.

**Side effects**
- Slightly longer skill files and descriptions. Descriptions are injected by host discovery, so a longer one has a small per-session cost — keep each addition to a clause.

**Migration**
- None. Skill content ships with the extension and is re-seeded on update.

## Dependencies

- Independent.
- **Pairs with** `user-declared-state-channels-as-a-skill.md`, which covers the channels no shipped skill can know about. This plan handles shipped capabilities; that one handles user-specific ones.

## Adversarial Synthesis

**"An agent will work it out when the command fails."** Sometimes, and expensively. The failure of a `sqlite3` call against a missing file is a shell error an agent may interpret as a broken install, a wrong path, or a permissions problem — and it may retry, or tell the user something alarming. A stated precondition converts a confusing failure into an expected one.

**"This is documentation, not engineering."** It is documentation that changes behaviour at the point of decision, which is the only kind that reliably does. And the alternative proposals — a manifest, a probing phase, resident instructions — are all more code for a worse result.

**"Just make `query-kanban` work everywhere."** It cannot: there is no database in a cloud session. The honest fix is for it to say so.

## Proposed Changes

1. **`query-kanban`**: add `## Preconditions` — requires a local `kanban.db`; unavailable in cloud, standalone-without-board, or tracker-only sessions. State what to do instead: say the board database is not reachable from this session, and do not hand-write SQL.
2. **`worktree-cleanup`**: extend `## Prerequisites` with the reachability check and an absent-server instruction.
3. **`kanban_operations`**: add `## Preconditions` naming the LocalApiServer dependency.
4. **`MIRROR_MANIFEST` descriptions**: add a precondition clause to each, so the constraint is visible before load. `query-kanban`'s is the important one.
5. **Reuse `manage-features`' probe verbatim** where a LocalApiServer check is needed — one health-check implementation, not four.

### Migration

None.

## Verification Plan

### Goal Invariants

- Every discoverable skill's `SKILL.md` contains a preconditions section naming what it requires and what to do when it is absent.
- Every `MIRROR_MANIFEST` description for a skill with an environmental dependency names that dependency.
- No skill's absent-capability instruction suggests working around the absence.

### Automated Tests

- **Precondition presence:** assert each of the four skill files contains a preconditions heading and a non-empty what-if-absent clause.
- **Description coverage:** assert `query-kanban`'s manifest description names the local-database requirement.
- **No-improvisation check:** grep each absent-capability clause for language suggesting an alternative query route; assert none.
- **Probe reuse:** assert only one LocalApiServer health-check implementation exists across the skills.
- **Behavioural, cloud session:** in a clone with no `api-server-port.txt` and no `kanban.db`, load `query-kanban` and assert the correct outcome is to report the database as unreachable rather than to attempt a query.
- **Behavioural, local session:** with the board running, assert every skill still works exactly as before — the preconditions are additive.

## Outstanding Questions

- None. The pattern exists in `manage-features`; this applies it to the three skills that lack it.
