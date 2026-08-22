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

### The endpoint contract already exists — this is a reachability fix, not new authoring

`.agents/protocols/switchboard-orchestration/SKILL.md` is titled **"Switchboard Orchestration HTTP Surface"**, documents **22** `GET`/`POST /kanban` calls, and opens with precisely the rule this plan wants enforced:

> "Switchboard's LocalApiServer runs inside the VS Code extension and is the **sole writer** of `kanban.db`. **You never touch the DB directly — you call these endpoints.** The board is the source of truth; the UI is just one view of it."

It also already separates concerns the right way: *"This skill is the invocation authority (endpoints, verbs, payload fields)"*, deferring behaviour contracts to `switchboard-contracts`.

**Two things keep it from reaching a team agent:**
1. **It is a protocol, not a skill** — `.agents/protocols/` is path-delivered and undiscoverable, so nothing finds it without a directive handing over the path. Its own scope line addresses *"a fleet coding/review agent working inside an orchestration worktree, or an external orchestrator"* — not a team member on the local board.
2. **The discoverable kanban skill is the SQL one.** `query-kanban` is `invocation: 'no-user'`, so it is what a model-driven team agent actually finds. The endpoint authority is invisible to it; the SQL skill is one hop away.

**Historical cause, and it was not a deletion.** Git history shows `query-kanban-plans/SKILL.md`, `query_kanban_plans.md`, `query_switchboard_kanban.md` and `query_archive/SKILL.md` removed from `.agents/skills/`, alongside `clickup-api`, `linear-api` and `notion-api`. No endpoint-based kanban skill was ever deleted — **both inputs to today's `query-kanban` were SQL skills**, and the merge preserved SQL as the method. What the reorganisation did was move *every* API reference (`clickup-api`, `linear-api`, `notion-api`, and the orchestration HTTP surface) into `protocols/`, making all of it undiscoverable in one move, while the SQL skill stayed discoverable. Nobody removed the endpoint guidance; the move made it unreachable and left the SQL guidance reachable.

**So the rewrite sources from `switchboard-orchestration/SKILL.md` rather than being written fresh.** That makes this cheaper than a from-scratch rewrite, which is why the complexity below is 3 rather than higher.

### But the protocol is itself a partial, hand-maintained list — point it at the generated one

An earlier revision of this plan recommended `query-kanban` point at the protocol and called that "one authority". That is one *hop*, not one authority: the protocol is a hand-written subset that can drift from what the server actually serves. Measured:

| | `switchboard-orchestration/SKILL.md` | `GET /catalog` |
|---|---|---|
| Endpoints | 22, hand-written prose | **87**, generated from source |
| Drift protection | none | `catalog:check` in CI (`integration-tests.yml:26`) |
| Payload shapes | **yes** — its own text claims "endpoints, verbs, payload fields" | **no** — entries are only `{path, method, prefix}` |

The protocol documents **22 of 87** endpoints and contains **zero** references to `/catalog`. Meanwhile `LocalApiServer.ts:547-548` describes the catalog as the layer that exists so "external clients discover every verb/endpoint/payload at runtime" — the discoverability job the protocol is currently doing by hand, worse.

**The gap that stops this being a straight swap:** the catalog has no request shapes. Its `apiEndpoints` entries carry `path`, `method` and `prefix` and nothing else; the 561 `verbPayloads` are *webview message* payloads, not HTTP bodies. So `POST /kanban/move` appears in the catalog with no indication that it takes `{planId or sessionId, targetColumn, workspaceRoot?}`, nor that column IDs must be canonical uppercase and it 400s on unknown ones (`switchboard-orchestration/SKILL.md:125`). That contract lives only in the protocol, and it is the half an agent needs to make a correct call.

**So the corrected chain is:**
1. **`GET /catalog` is the endpoint inventory.** The protocol points at it and stops being a partial list — killing drift on the 22 and exposing the other 65.
2. **The protocol owns the payload contracts** for the calls agents are meant to make, since nothing else has them.
3. **`query-kanban` points at the protocol.** One hop, and the authority underneath is now anchored to a generated list rather than a hand-maintained one.

### Noted for later: extend the catalog to capture request shapes

The end state is that payload contracts are generated too, and the protocol becomes narrative rather than reference. `scripts/generate-protocol-catalog.js` already parses provider `switch` blocks by brace-depth tracking to extract `case` arms; capturing HTTP request shapes means parsing the handler bodies for their destructured fields, which is a bigger change than the pointer above and should not be bundled into it. Two things to know if it is taken up:

- It flags any endpoint whose shape cannot be determined statically, the way the existing generator already flags non-literal `type` fields into `catalog.manualReview` (6 today). That mechanism is the precedent to reuse.
- It does **not** conflict with `protocols-as-db-rows-not-scaffolded-files.md`, which records the catalog as out of scope for the protocol-file move. That plan's point is that "protocol" in `protocol-catalog.json` means the webview message protocol, not protocol `SKILL.md` files. Extending the catalog's HTTP coverage is orthogonal to both.

**Discovery-as-a-phase is the wrong shape.** An up-front "work out what you can reach" step costs tokens on every session, must enumerate channels it cannot know about, and produces a claim that is stale the moment auth expires. Discovery at point of use costs nothing until the capability is wanted and is always accurate. The pattern already exists in the codebase; it just is not applied uniformly.

**A configured channel is not a reachable one.** This is the specific trap: in the session that produced this plan, Linear MCP was configured and unavailable — it required an OAuth flow the session could not run. Any design that treats configuration as availability will send agents down dead paths.

### Root Cause

Skills were written against the environment their author had. `manage-features` was written for a path that might or might not have the extension running, so it grew a fallback. `query-kanban` was written where a local DB obviously existed, so it never needed one. Neither author was wrong; nothing required them to state the assumption.

### Non-goals

- Building a discovery phase, manifest, or capability-probing step.
- Changing what any skill does when its preconditions *are* met.
- Adding resident text to `CLAUDE.md` / `AGENTS.md`. The whole point is that this costs nothing until a skill is loaded.

## Metadata

**Complexity:** 3
**Tags:** docs, reliability, refactor, cli

## User Review Required

No. This adds a stated precondition and a fallback instruction to skills that lack them, modelled on a pattern already shipped in `manage-features`.

## Complexity Audit

### Routine

- Adding a `## Preconditions` section to `kanban_operations`.
- Extending `worktree-cleanup`'s existing `## Prerequisites` with a reachability check and a what-if-absent clause.
- Adding a precondition clause to each skill's `description` in `MIRROR_MANIFEST`, since the description is what an agent sees before deciding to load.

### Complex / Risky

- **Rewriting `query-kanban` around the endpoints is the bulk of this plan.** Every query template in it is SQL and each needs an endpoint equivalent, or an honest statement that no endpoint covers it — which is itself a finding worth surfacing, since a query with no endpoint equivalent is either a gap in the API or a query teams should not be running. Do not translate mechanically: check each against the five read endpoints first, and against the 22 documented in `switchboard-orchestration/SKILL.md`.
- **`query-kanban` points at the protocol, and the protocol's scope line must be widened.** Its own text addresses *"a fleet coding/review agent working inside an orchestration worktree, or an external orchestrator"* — a team member is neither, so an unwidened pointer reads as out of scope. Lifting the reads into `query-kanban` instead was considered and rejected: it creates a second endpoint list that can drift, and this programme has already produced two contradictory copies of one instruction in the standing orders.
- **Pointing the protocol at `/catalog` is a small edit with a verification catch.** The protocol's 22 endpoints must each still exist in the catalog's 87 — if any does not, the protocol has already drifted and that is a finding, not a merge conflict to paper over. Assert the subset relation rather than assuming it.
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
