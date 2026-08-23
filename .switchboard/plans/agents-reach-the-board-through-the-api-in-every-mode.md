# Agents read the board by opening a file path, and every part of the storage programme breaks that

## Goal

Make the API the only way an agent reaches board state, for reads as well as writes, so agent skills keep working when the database moves to the home store, splits by ownership, grows a board window, or lives on a remote. Preserve the capability that makes `query-kanban` useful — arbitrary read-only SQL — rather than replacing it with fixed endpoints agents will route around.

### Problem Analysis

**Writes already go through the API; reads do not.** Agents mutate the board over HTTP — `POST /kanban/move`, `/kanban/feature/assign`, `/kanban/feature/remove`, `/kanban/feature/delete`, `/kanban/feature/split` — reached through `.agents/skills/_lib/sb_api_call.sh` with health verification. That path is architecturally correct and survives every change in the storage programme. Reads take a different route: `query-kanban/SKILL.md` instructs `sqlite3 -readonly "$DB_PATH"` with `DB_PATH` falling back to `$SB_ROOT/.switchboard/kanban.db`, and its documented example selects `plan_id, session_id, topic, kanban_column FROM plans`.

**Four separate changes each break that read, and all four are planned:**

1. **Consolidation.** `single-global-database-in-home-store.md` moves the database to `~/.switchboard/switchboard.db`. The skill's path default is wrong, and it already names updating the skill as a task — correctly, but that fixes only this one break.
2. **Ownership split.** `split-shared-board-state-from-machine-local-runtime.md` moves `dispatched_terminal`, `dispatched_at`, `last_liveness_at`, `blocked_at` and `worktrees` out of `plans`. Any documented query selecting them fails with `no such column`.
3. **Board window.** `storage-topology-one-choice-three-stores.md` puts dormant cards in Archive. A query against Board for an old completed plan returns zero rows — which an agent reads as "no such plan", not "look elsewhere". A silent wrong answer, which is worse than an error.
4. **Remote board.** In the thin-client mode there is no local file to open. With a libSQL embedded replica there is one, but it is WAL-mode and owned by the sidecar; `sqlite3 -readonly` against a WAL database requires the `-wal`/`-shm` sidecars to be present and readable, so it is fragile rather than supported.

**And two planned changes are pointed at each other.** `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md` closes the write bypass by mandating `-readonly` across skill documentation — entrenching the direct-file read path that the four changes above break. Its reasoning is sound in today's architecture and its remedy hardens exactly the thing that is about to stop working. Neither plan references the other.

**The failure mode is quiet, which is what makes it worth its own plan.** A wrong path, a dropped column and an out-of-window card produce, respectively, a fabricated empty database (the risk the skill already warns about), a hard error, and an empty result set. Only the middle one is loud. An orchestrator that silently sees an empty board makes confident wrong decisions.

### Root Cause

The board was a file, so reading it was opening a file. Writes moved to an API because writes needed serialising against the extension's in-memory image; reads never had a forcing function, so they kept the cheapest possible implementation. The storage programme supplies the forcing function four times over.

### Non-goals

- Removing `sqlite3` from agent hands generally. Reading *other* databases is not this plan's business.
- Replacing arbitrary SQL with fixed endpoints only. That is the change that would push agents back to the file, and `query-kanban`'s flexibility is load-bearing for the orchestrator.
- Changing the write path. It is already correct.
- Weakening the write guardrail. This plan makes its `-readonly` mandate unnecessary rather than wrong.

## Metadata

**Complexity:** 5
**Tags:** api, backend, cli, reliability, security, refactor

## User Review Required

Yes — three decisions.

1. **Read-only SQL over HTTP, or structured endpoints only?** Recommendation: **a read-only query endpoint**, because the alternative loses the capability and agents will route around fixed endpoints back to the file. Guarded: `SELECT`-only with a parser check rather than a string match, parameter binding, a row cap, a statement timeout, and the same auth as every other route.
2. **Does the query endpoint span Board and Archive?** Recommendation: **yes, with the source labelled per row.** The window is an implementation detail of storage, not a fact about a plan, and an agent asking "where is this card" must not get a wrong answer because the card got old.
3. **What happens to direct-file reads?** Recommendation: **keep them working wherever they still can, but stop documenting them.** Skills move to the API; the file path stops being the instructed route. A hard block would break third-party skills for no safety gain, since read-only access is not the hazard.

## Complexity Audit

### Routine

- A read-only query endpoint on `LocalApiServer` beside the existing `/kanban/*` reads.
- Rewriting `query-kanban/SKILL.md` to call it, including the documented examples.
- A helper in `sb_api_call.sh` so skills call it the way they already call the write endpoints.

### Complex / Risky

- **`SELECT`-only enforcement must be a parse, not a prefix check.** `WITH … INSERT`, a trailing statement after a semicolon, `PRAGMA`, and `ATTACH` all defeat string matching. `ATTACH` is the sharpest: it turns a read endpoint into a way to open any file the host can reach.
- **A SQL read endpoint reads everything the store holds.** Once `plan_tickets` lands, that includes ticket bodies and assignee emails. Over a tunnel that is the operator's own data reaching the operator's own agent, which is fine — but it must be a stated consequence, and it is an argument for the body-exclusion setting in the ticket plan.
- **Arbitrary SQL against a remote replica has a cost.** Under a metered store, an unbounded agent query is billable row reads. The row cap and timeout are quota controls as much as safety ones.
- **Schema coupling moves, it does not disappear.** Agents writing SQL against the board's tables are coupled to the schema whether they reach it by file or by HTTP. The tier split will break their queries either way. So the endpoint needs a schema version in its response, and the skill needs to state which version its examples target — otherwise this plan fixes reachability and leaves the `no such column` break untouched.
- **The empty-result ambiguity is the actual bug to kill.** "No rows" must be distinguishable from "not in this store" and from "store unreachable". Three different answers, one of which is currently indistinguishable from success.

## Edge-Case & Dependency Audit

**Race conditions**
- A query spanning Board and Archive while the archive sweep moves a card between them: the card must appear once, not zero times. Read both under one snapshot, or read Archive first and dedupe by id.

**Security**
- `ATTACH`, `PRAGMA` and multi-statement input rejected by parse.
- The endpoint inherits the loopback lockdown and the existing auth; it must not become the one route with a bespoke posture. The route-auth enumeration test from the app plan should cover it.
- A read cap and timeout so a malformed agent query cannot pin the sidecar that owns the board.

**Side effects**
- `scripts/move-card.js` and `create-feature.js` already use the API and are unaffected.
- The orchestrator protocol, `switchboard-orchestration`, and any protocol documenting a DB path need updating — the path is user-facing in the skill and agent-facing in the protocols.
- `sql-write-guardrail`'s skill-documentation changes overlap this plan's rewrite of the same files. Sequence them or land them together, or one will revert the other's edits.

**Migration**
- Skills ship inside the extension and are regenerated, so there is no user data to migrate. But agents in flight may hold the old instructions in context: the endpoint should exist before the skill stops documenting the file, so both work during the overlap.
- A third-party skill doing direct reads keeps working where a local file still exists. It breaks in thin-client mode, and that should be documented rather than discovered.

## Dependencies

- **Must land before or with** the tier split, the topology plan and any store target — each of them breaks the current read path on its own.
- **Coordinate with** `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md`: same files, opposite direction of travel. That plan's `-readonly` mandate becomes moot once reads are API-only; its allowlist narrowing is still worth having.
- **Feeds** the app plan's mode matrix — this is what makes agent board access identical in all three modes.

## Adversarial Synthesis

Key risks: `SELECT`-only by string match is defeated by `WITH … INSERT`, trailing statements, `PRAGMA` and especially `ATTACH`, which would turn a read endpoint into arbitrary file access; a SQL read endpoint exposes everything the store holds, including ticket bodies and assignee emails; unbounded queries against a metered remote are billable and can pin the sidecar; and schema coupling follows agents across the transport, so reachability alone does not fix `no such column`. Mitigations: parse-based enforcement rejecting `ATTACH`/`PRAGMA`/multi-statement; row cap plus statement timeout as both safety and quota control; a schema version in the response with skill examples pinned to it; and three distinguishable outcomes so "no rows" can never be confused with "unreachable".

## Proposed Changes

1. **A read-only query endpoint** — parse-enforced `SELECT`-only, parameter binding, row cap, statement timeout, schema version in the response, existing auth and loopback posture.
2. **Board+Archive spanning** with the source labelled per row, so an aged card is found rather than silently absent.
3. **Three distinguishable outcomes** — rows, no-such-rows, and store-unreachable — as distinct responses an agent can branch on.
4. **`sb_api_call.sh` helper** so skills query the way they already write.
5. **Rewrite `query-kanban/SKILL.md`** onto the endpoint, with examples pinned to a schema version, coordinated with the write-guardrail plan's edits to the same files.
6. **Update the protocols** that document a database path — the orchestrator and orchestration protocols especially.
7. **Leave direct-file reads functional** where a file exists, and stop instructing them.

### Migration

The endpoint ships before the skill stops documenting the file, so in-flight agents holding old instructions keep working through the overlap. No user data involved.

## Verification Plan

- **Every mode:** run the same agent query in local/local, remote-board/local-agents, and remote-board/remote-agents. Assert identical results.
- **Survives each split:** run the skill's documented example queries against a store that has been consolidated, tier-split, and windowed. Assert each returns correct results or an actionable error — never a silent empty set.
- **Aged card:** query a completed plan that has moved to Archive. Assert it is found and labelled as archived, not reported absent.
- **Injection:** attempt `ATTACH`, `PRAGMA`, `WITH … INSERT`, a trailing `; DELETE`, and a multi-statement body. Assert every one is rejected by parse, and that a legitimate CTE `SELECT` still works.
- **Caps:** a query returning more than the row cap, and one that would run past the timeout. Assert both are bounded with a clear response rather than pinning the sidecar.
- **Unreachable store:** stop the store. Assert the endpoint returns store-unreachable, distinguishable from an empty result.
- **Write path unchanged:** assert `/kanban/move` and the four feature endpoints behave identically before and after.
- **Guardrail coexistence:** apply both this plan's and the write-guardrail's skill edits. Assert neither reverts the other and the resulting skill documents API reads with no non-readonly `sqlite3` anywhere.
- **Overlap window:** an agent using the old file-based instructions against a local store, concurrently with an agent using the endpoint. Assert both succeed.

## Outstanding Questions

- Should the endpoint expose a schema-description call so an agent can discover columns rather than hardcoding them, which would blunt the next schema change?
- Is a row cap acceptable for the orchestrator's real queries, or does it need a paging cursor?
- Do third-party skills doing direct reads warrant a deprecation notice in a release, or is documenting the thin-client limitation enough?
