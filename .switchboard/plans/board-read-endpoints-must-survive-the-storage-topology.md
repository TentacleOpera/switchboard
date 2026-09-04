# The board read endpoints must survive the storage topology, or the SQL-to-endpoints migration lands on endpoints that lie

<!-- board-collapse-audit -->
> **REDIRECT 2026-09-04 (Board Collapse audit).** This plan names `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md` as editing the same files in the opposite direction. That plan has been **deleted** (decision 11): three of its four layers were already closed or void, and its warning lived inside `KanbanDatabase._reloadIfStale`, which the sidecar plan deletes outright.
> > 
> > The coordination it warned about is gone with it — nothing now pushes `sqlite3` guidance *into* the skills. Its one surviving idea, narrowing the Claude Code permission to `Bash(sqlite3 -readonly *)`, moved to `skills-posix-only-tooling.md`, which also removes this skill's SQL templates. That plan and this one still edit `query-kanban/SKILL.md`, so the sequencing note stands: the POSIX rewrite lands first.


<!-- board-collapse-01b -->
> **PATH CORRECTION 2026-09-04 (Board Collapse 01).** This file names `.agents/skills/_lib/sb_api_call.sh`, which was **deleted** in commit `96fb16df`. All eight `kanban_operations/*.js` scripts now share `.agents/skills/_lib/cli-call.js`, and `switchboard api` is the shell-side escape hatch. Read every `sb_api_call` reference below as `cli-call.js` / `switchboard api`, and do not restore the shell helper.


## Goal

Make the board's read endpoints correct under the storage programme: findable across the board window and Archive, honestly distinguishable between "no such card" and "store unreachable", and identical in every deployment mode. The migration off agent SQL is already decided elsewhere; this makes the destination trustworthy.

> **Correction — this plan's first draft proposed the wrong thing.** It recommended a read-only SQL endpoint to preserve `query-kanban`'s arbitrary queries. That is already settled against: `teams-reach-state-through-endpoints-not-host-files.md` states "**Settled: teams do not use SQL.** No labelled fallback, no escape hatch", and `skills-declare-preconditions-and-degrade.md` scopes the `query-kanban` rewrite with the argument in full — the read endpoints already cover the need, SQL bypasses column canonicalisation and the resolve-only project semantics, the label/ID trap the skill warns about is an artifact of SQL rather than a fact about the board, and `switchboard-manage-console-skill.md` already declined MCP on the identical "second surface, no capability gain" reasoning. A SQL passthrough is that anti-pattern a third time. The first draft's schema-version recommendation is also void: an agent calling a structured endpoint that returns records is not coupled to table columns at all.
>
> What survives is narrower and still needed: the endpoints those plans migrate agents *onto* do not yet behave correctly once the board has a window, an Archive, and a remote store.

### Problem Analysis

**The direct-file read is breaking anyway, in four ways, and one of them is already live.** `query-kanban/SKILL.md` instructs `sqlite3 -readonly "$DB_PATH"` defaulting to `$SB_ROOT/.switchboard/kanban.db`:

1. **Worktrees, today.** `.gitignore:52` ignores `.switchboard/*`, so neither the DB nor `api-server-port.txt` exists in a fresh per-feature worktree checkout. `teams-reach-state-through-endpoints-not-host-files.md` names this as the reason its contract is "a precondition for the per-feature-worktree queue design, not merely hygiene". This break needs no future plan to arrive.
2. **Consolidation** moves the file to `~/.switchboard/switchboard.db`.
3. **The ownership split** removes `dispatched_terminal`, `dispatched_at`, `last_liveness_at`, `blocked_at` from `plans` — the skill's documented example selects `plans` columns.
4. **Remote board** — thin-client mode has no local file; a libSQL replica has one, but it is WAL-mode and sidecar-owned, so `-readonly` needs the `-wal`/`-shm` sidecars readable.

So the migration is over-determined. The question this plan answers is whether the endpoints are ready to receive it.

**They are not, in three specific ways.**

- **Nothing spans the board window.** Once `storage-topology-one-choice-three-stores.md` puts dormant cards in Archive, `GET /kanban/plan` for an aged card queries Board and finds nothing. The endpoint returns a well-formed "not found" for a plan that exists. That is worse than the file path it replaces, because it is confidently wrong rather than broken.
- **"Empty" and "unreachable" are the same answer.** With a remote Board, an unreachable store and an empty result are indistinguishable to a caller. An orchestrator reading an empty board makes confident wrong decisions — and unlike the SQL path, where `sqlite3` at least errors on a missing file, a clean `200 []` looks like success.
- **Nothing asserts cross-mode parity.** The three deployment modes reach the store differently. Nothing today would catch an endpoint that works locally and returns partial data through a tunnel.

**And two planned changes edit the same files in opposite directions.** `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md` closes the write bypass by mandating `-readonly` across skill documentation; the endpoint migration removes `sqlite3` from those same documents. Its reasoning is correct for today's architecture and its remedy hardens the path being retired. Neither plan references the other, and whichever lands second silently reverts the first's edits.

### Root Cause

The read endpoints were written when the board was one table set in one file, so "the board" and "what the endpoint can see" were the same thing. The topology work makes them different — a window, an archive, a possibly-remote store — and nothing has revisited what an endpoint should say when the card it was asked about is real but elsewhere.

### Non-goals

- Re-litigating SQL versus endpoints. Decided in `teams-reach-state-through-endpoints-not-host-files.md` and scoped in `skills-declare-preconditions-and-degrade.md`. This plan assumes that outcome.
- Rewriting `query-kanban`. That belongs to the preconditions plan; this makes its target correct.
- A SQL passthrough endpoint in any form.
- New endpoints where existing ones suffice. `/catalog` (87 endpoints, `catalog:check` in CI) is the inventory and the protocol owns payload shapes; this plan changes behaviour, not surface area, except where a genuine gap exists.
- Changing the write path. `/kanban/move` and the four `/kanban/feature/*` endpoints already go over HTTP via `sb_api_call.sh` and are unaffected by every split.

## Metadata

**Complexity:** 4
**Tags:** api, backend, reliability, database, docs

## User Review Required

Yes — three decisions.

1. **How does a read span Board and Archive?** Recommendation: **the endpoint spans both and labels each record's source.** The window is a storage implementation detail, not a fact about a plan, so an agent asking about a card must never be told it does not exist because it got old. The alternative — a separate archive endpoint agents must know to try — recreates the same wrong answer by omission.
2. **How is unreachable expressed?** Recommendation: **a distinct status, never an empty success.** An agent must be able to branch on rows / no-such-record / store-unavailable as three outcomes.
3. **Sequencing against the write guardrail.** Recommendation: **land them together**, or land the guardrail's allowlist narrowing (still valuable) while dropping its `-readonly` documentation edits (moot once SQL leaves the skills).

## Complexity Audit

### Routine

- Adding source labelling to the record-returning read endpoints.
- A distinct store-unavailable response, and callers that branch on it.
- The cross-mode parity test.

### Complex / Risky

- **Spanning two stores changes read cost.** A miss in Board becomes a second lookup in Archive, and under a remote or on-demand Archive that is a network round-trip on a path agents call often. Needs a negative cache or a Board-side tombstone so a genuinely absent card does not pay the Archive lookup every time. **The span is application-level, not SQL-level:** libSQL does not support `ATTACH DATABASE` in embedded replica mode, so when Board is a remote target the span is two separate connections merged in TypeScript, not a SQL join — the round-trip cost is per-connection, not per-query.
- **Board and Archive can disagree mid-sweep.** A card being archived can appear in both or neither. Read Archive first and dedupe by id, or read under one snapshot — either way, exactly one record must come back.
- **"Unreachable" has to propagate honestly through every layer.** A `try/catch` returning `[]` anywhere between the store and the response reintroduces the exact ambiguity this plan exists to remove. That pattern is common and easy to reintroduce, so it wants a test rather than a convention.
- **The panel and the agents want different answers to the same question.** A human looking at the board wants dormant cards hidden; an agent asking about a specific card wants it found. So spanning is per-endpoint, not global: collection reads stay windowed, record lookups span. Getting that backwards either floods the board or hides cards from agents.

## Edge-Case & Dependency Audit

**Race conditions**
- A lookup during archival, per above.
- A promotion (dormant card touched) concurrent with a read: the card may move Archive → Board mid-request. One record, either source label, never zero.

**Security**
- No new surface, so no new posture. The endpoints keep the loopback lockdown and existing auth; the route-auth enumeration test from the app plan should cover any endpoint touched here.

**Side effects**
- `switchboard-orchestration/SKILL.md` owns payload contracts and documents 31 of 87 endpoints; any response-shape change (source label, unavailable status) belongs there, and `/catalog` stays the inventory.
- The orchestrator, `teamWiring`'s standing orders, and `manage-features`' fallback all consume these reads. A new outcome they do not handle is a new failure mode — each needs to branch on unavailable rather than treat it as empty.
- `improve_kanban_db_workspace_project_epic_queryability.md` covers queryability from the DB side and should be checked for overlap.

**Migration**
- Additive response fields only, so existing callers keep working. The unavailable status is new: any caller treating non-200 as fatal needs checking before it ships.
- The endpoint behaviour must land **before** `query-kanban` stops documenting SQL, so agents are never migrated onto endpoints that cannot find archived cards.

## Dependencies

- **Must land before** the `query-kanban` rewrite in `skills-declare-preconditions-and-degrade.md`, so the destination is correct when agents arrive.
- **Must land with or after** the topology plan's window and Archive, which is what creates the spanning requirement.
- **Coordinate with** `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md` — same files, opposite direction.
- **Coordinate with** `storage-topology-one-choice-three-stores.md` — both edit `query-kanban` SKILL.md (topology changes the documented DB path via consolidation; this plan removes `sqlite3`). Three plans edit the same skill file — coordinate so none reverts the others.
- **Feeds** the app plan's mode matrix: this is what makes agent board reads identical in local/local, remote-board/local-agents and remote-board/remote-agents.

## Adversarial Synthesis

Key risks: an endpoint that returns a well-formed "not found" for an archived card is confidently wrong, which is worse than the broken file path it replaces; an empty success indistinguishable from an unreachable store makes an orchestrator act on a board it cannot see; spanning two stores adds a network round-trip to a hot path; and a stray `catch` returning `[]` anywhere in the chain silently restores the ambiguity. Mitigations: record lookups span with per-record source labels while collection reads stay windowed; three distinct outcomes with a test rather than a convention; a negative cache or Board-side tombstone for genuine absences; and archive-first-then-dedupe so a card mid-sweep returns exactly once.

## Proposed Changes

1. **Record lookups span Board and Archive**, with each record labelled by source. Collection reads stay windowed, so the human board is unaffected. **Research constraint (ATTACH):** libSQL does not support `ATTACH DATABASE` in embedded replica mode, so when Board is a remote target, the span cannot be a SQL-level `ATTACH` join across Board and Archive — it must be an application-level merge (separate connections, fetch by id, dedupe in TypeScript). When Board is a local file (default target), `ATTACH` may work, but the code path must not depend on it.
2. **A distinct store-unavailable outcome**, never an empty success, propagated honestly from the store to the response.
3. **A negative path that does not pay for Archive every time** — Board-side tombstone or negative cache.
4. **Archive-first dedupe by id** so a card being archived returns exactly once.
5. **Document the new response fields** in `switchboard-orchestration/SKILL.md`, leaving `/catalog` as the inventory.
6. **Update the consumers** — orchestrator, standing orders, `manage-features` fallback — to branch on unavailable rather than treating it as empty.
7. **Coordinate the skill-file edits** with the write guardrail so neither reverts the other.

### Migration

Additive response fields; existing callers unaffected. Ships before the `query-kanban` rewrite so no agent is migrated onto an endpoint that cannot find an archived card.

## Verification Plan

- **Archived card lookup:** archive a completed plan, then look it up by id. Assert it is found, labelled archived, and returned exactly once.
- **Genuine absence:** look up an id that never existed. Assert no-such-record, distinct from unavailable, and that the Archive lookup is not repeated on every subsequent call for it.
- **Unreachable store:** stop the store mid-session. Assert every read returns store-unavailable — and specifically assert no layer converts it to `200 []`. This is the test that must fail loudly if a `catch` is reintroduced.
- **Mid-sweep race:** look up a card while the archive sweep moves it. Assert exactly one record, either source, never zero and never two.
- **Windowed collections unaffected:** assert the human board's collection reads still exclude dormant cards and their payloads are unchanged.
- **Cross-mode parity:** the same lookup and the same card move in local/local, remote-board/local-agents, and remote-board/remote-agents. Assert identical results in all three.
- **Worktree parity:** run an agent read from inside a per-feature worktree with no `.switchboard/` present. Assert it succeeds — the break that exists today.
- **Consumer handling:** inject unavailable into the orchestrator, the standing orders' reads, and `manage-features`' fallback. Assert none proceeds as though the board were empty.
- **Guardrail coexistence:** apply both this plan's and the write guardrail's edits. Assert neither reverts the other and no non-readonly `sqlite3` remains in any skill.

### Goal Invariants

- **Three distinct outcomes:** assert a record-lookup read endpoint returns three distinguishable outcomes — found (with per-record source label), no-such-record, and store-unavailable — and that store-unavailable is a distinct type no layer coerces to `200 []`.
- **Record lookups span, collections stay windowed:** assert a record lookup for a dormant card spans Archive and returns it, while a collection read for the same board excludes that dormant card. Getting this backwards floods the board or hides cards from agents.
- **Genuine absence does not pay for Archive every time:** assert a lookup for an id that never existed does not trigger an Archive round-trip on every subsequent call (negative cache or Board-side tombstone).
- **Consumers branch and degrade:** assert the orchestrator, standing orders, and `manage-features` fallback branch on store-unavailable rather than treating it as empty, and degrade (retry-with-backoff or fail-fast) rather than loop on a permanently-down store.
- **No `catch` swallows unavailable into `[]`:** assert no layer between the store and the response converts a store-unavailable error into an empty success — the pattern this plan exists to kill.

## Outstanding Questions

- Should `/catalog` carry the new response fields, or does that stay with the protocol given the catalog has no payload shapes today?
- Does the orchestrator ever legitimately need a *collection* read spanning Archive (for example, a retrospective over shipped work), and if so is that a separate explicitly-archival endpoint rather than a flag?
- Is a Board-side tombstone acceptable given the retention plan will eventually prune, or does the negative cache have to be purely in-memory?
