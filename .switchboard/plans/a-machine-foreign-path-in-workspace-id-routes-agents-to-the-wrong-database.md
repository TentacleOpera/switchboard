# A Machine-Foreign Path in `workspace-id` Silently Routes Agents to the Wrong Database

## Goal

Control-plane database resolution never lets a path from another machine win, never answers from
a store that cannot hold the answer, and always records which rung of the lookup responded.

### Problem analysis

**Observed 2026-09-14 on the Pi.** `.switchboard/workspace-id` is a two-line file — workspace id,
then database path. Line 2 reads:

```
/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db
```

A **macOS path**, on a Linux ARM host, pointing at a file that does not exist here. The live board
is `~/.switchboard/boards/038bffef-9842-4574-96a1-69a43a280b3c.db` — 10 MB, written by the running
host minutes earlier.

**The documented lookup trusts it unconditionally.** The `query-kanban` skill — the path every
agent is instructed to follow for board reads — resolves in four rungs:

1. `DB_PATH` = line 2 of `workspace-id`
2. if `DB_PATH` is **empty** → `~/.switchboard/boards/<workspace-id>.db`
3. if repo `.switchboard/kanban.db` exists **and** `DB_PATH` is missing → that
4. if `DB_PATH` is missing **and** `~/.switchboard/switchboard.db` exists → that

Rung 2 is guarded on **empty**, not on **resolvable**. A non-empty-but-dead path therefore skips the
correct board entirely. Repo-local `kanban.db` does not exist here, so rung 3 declines, and
resolution lands on `~/.switchboard/switchboard.db` — which has **no `plans` table**:

```
Error: in prepare, no such table: plans
```

**It failed loudly only by luck.** `switchboard.db` is a legacy consolidated store; this one happens
not to carry a `plans` table. One that did would have returned a complete, plausible board from the
wrong database, and nothing in the chain records which store answered. The loud failure is an
accident of this machine's history, not a property of the design.

**Second hazard: the chain can fabricate its own evidence.** `sqlite3` silently **creates** an empty
database when handed a path that does not exist — the skill's own comments warn about this twice.
Any rung that passes a dead path to a non-`-readonly` invocation leaves a 0-byte database behind,
which then satisfies the next `[ -f ... ]` test for every later caller. There is already a 0-byte
`~/.switchboard/kanban.db` (dated Sep 10) consistent with exactly that having happened once.

**The product disagrees with the file.** `src/services/storageTopology.ts` documents the board's
home as `~/.switchboard/boards/<workspace-id>.db` (`:54`, `:63`), which is the database actually in
use. So line 2 is not merely stale — it contradicts the convention the running host follows.

**Provenance.** This host carries transfer artifacts: `integration-config.json.pre-transfer-20260828-095628`,
`boards/038bffef.pre-transfer.20260914-090002.bak`, and a `transfer/` directory. `src/extension.ts:297`
separately records that `workspace-id` "was mass-planted into" roots and is deliberately not treated
as a setup marker. An absolute, machine-specific path in a file that travels between machines will be
wrong on arrival every time.

> **Clarification (improve pass, 2026-09-14):** The four-rung snippet above is the lookup an agent
> executes **in the stale copy of the skill that lives outside the repo** — `~/.claude/skills/query-kanban/SKILL.md`.
> The two repo copies (`.claude/skills/query-kanban/SKILL.md` and `.agents/skills/query-kanban/SKILL.md`)
> have **already been rewritten** to use the LocalApiServer endpoints and now state "Direct SQL is a
> fallback that no longer exists for this skill." So the snippet is not the path a repo-resident agent
> is instructed to follow today; it is the path an agent following the **home** copy still takes. The
> observed incident is consistent with an agent having followed the home copy. A second in-repo
> consumer — `.agents/rules/how_to_plan.md` lines 16 and 66 — still instructs planners to "read
> `.switchboard/workspace-id` for ID and DB path, then query with sqlite3," which is the same hazard
> via a different document. See Proposed Changes.

### Root cause

Line 2 stores a **machine-specific absolute path in portable state**, and every consumer treats
*present* as *correct*. No rung asks whether the path resolves on this host; no rung asks whether the
store it names can answer the question; no rung records which one replied.

`CLAUDE.md` names this exact shape as a shipped example of its fallback rule — *"a four-level
startup-command lookup where a stale value from a retired store wins and nothing records which store
answered."* This is that lookup, for the database.

> **Clarification (improve pass, 2026-09-14):** "Every consumer" is narrower than it first appears.
> The TypeScript control-plane is **not** a consumer of line 2. `KanbanDatabase.forWorkspace` reads
> line 1 only (`resolveCanonicalWorkspaceIdSync` → `split('\n')[0]`), hands the id to
> `resolveBoardDbPath(wsId)`, and derives `~/.switchboard/boards/<wsId>.db` — which it validates and
> tags with `source: 'board_default'`. `WorkspaceIdentityService` writes `${workspaceId}\n` (one
> line). No TS code writes or reads line 2. The actual consumers of line 2 are agent-facing
> **documents**, not the host: the home skill snippet and `.agents/rules/how_to_plan.md`. The root
> cause stands — line 2 is a machine-foreign path in portable state — but the fix surface is the
> documents that tell agents to read it, not the TS resolver that already ignores it.

### Non-goals

- **Relocating boards.** `~/.switchboard/boards/<workspace-id>.db` stays where it is.
- **Deleting line 2.** It shipped; it is validated and migrated, not dropped.
- **Changing the kanban schema.**

## Metadata

**Tags:** bugfix, database, reliability, docs
**Feature:** 81a3c869-24ca-4e74-80a8-8e68f3a27192
**Complexity:** 4

## User Review Required

> [!NOTE]
> The stale four-rung snippet survives in **`~/.claude/skills/query-kanban/SKILL.md`** — a
> user-level (home-directory) file, outside this repo. The repo cannot migrate or delete it from
> here. The user must replace that home copy with the repo version (`.claude/skills/query-kanban/SKILL.md`
> or `.agents/skills/query-kanban/SKILL.md`), or delete it, so agents loading the home skill stop
> reading line 2. Until that is done, an agent that resolves the home skill before the repo skill
> still executes the four-rung snippet and can hit the wrong database.
>
> No breaking changes to the running host. The TS control-plane already ignores line 2; this plan
> changes agent-facing documents and migrates a shipped state file, not host code paths.

## Complexity Audit

### Routine
- Fix `.agents/rules/how_to_plan.md` lines 16 and 66 to stop instructing agents to read line 2 and
  query with sqlite3; redirect to the endpoint-based `query-kanban` skill.
- Migrate the two-line `workspace-id` file to a one-line file (line 1 only), archiving the original
  as `workspace-id.migrated.bak`.

### Complex / Risky
- The migration touches **shipped state** (the `workspace-id` file exists in released versions), so
  it must import-before-replace and archive rather than unlink, per `CLAUDE.md`.
- The home skill (`~/.claude/skills/query-kanban/SKILL.md`) is out of repo scope and cannot be fixed
  from here; it remains a live hazard until the user replaces it.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `workspace-id` file can be read by an agent mid-migration. The migration
  must be atomic: write the new one-line file to a temp path, then rename over the original. A reader
  that opens the file during the rename gets either the old two-line file or the new one-line file,
  never a partial write. Line 1 is identical in both, so a mid-migration reader of line 1 is
  unaffected.
- **Security:** Line 2 is an untrusted path read from a repository file. The stale snippet passes it
  to `sqlite3` without `-readonly` on some rungs, which can fabricate a 0-byte database. The
  migration removes line 2, eliminating the untrusted-path-to-sqlite path entirely for in-repo
  consumers. The home skill is out of scope here but the user should ensure it uses `-readonly` or is
  replaced.
- **Side Effects:** Migrating the file changes its byte content (two lines → one line). Any external
  tool that parses line 2 of `workspace-id` will break. No in-repo tool does; the TS host reads line
  1 only. The archive (`workspace-id.migrated.bak`) preserves the original for recovery.
- **Dependencies & Conflicts:** None. This plan does not depend on other active plans. The VS Code
  extension cutover (the board feature *"VS Code Becomes a Sidebar..."*) is in PLAN REVIEWED with no
  built stages; this plan touches shared docs and a state file, not extension-host wiring, so the
  cutover does not gate it.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) the plan's original fix targeted a TS resolver that never reads line 2 — it would pass
its own tests while the real hazard (agents following stale docs) persisted; (2) rewriting line 2 to
a fresh machine-specific absolute path recreates the exact bug; (3) the home skill is out of repo
scope and remains a live hazard. Mitigations: fix the in-repo doc consumer (`.agents/rules/how_to_plan.md`),
migrate line 2 to **empty/absent** (not a new path), and flag the home skill for the user to replace.

## Proposed Changes

### 1. Validate before trusting

A non-empty line 2 that does not resolve on this host must **fall through**, not win. Change every
rung's guard from "is the variable empty?" to "does this path exist on this machine?".

> **Superseded:** Build a shared TS resolver (`resolveBoardDbPath` extension) that validates line 2's
> path exists on this machine.
> **Reason:** The TS control-plane does not read line 2. `KanbanDatabase.forWorkspace` reads line 1
> only and derives the board path via `resolveBoardDbPath(wsId)` → `~/.switchboard/boards/<wsId>.db`,
> which already validates the path and tags `source: 'board_default'`. Adding a line-2 validator to
> the TS resolver is speculative code for a value nothing in TS reads — a positive line of code that
> passes review while doing nothing. The actual consumers of line 2 are agent-facing documents.
> **Replaced with:** Fix the in-repo document consumer (`.agents/rules/how_to_plan.md`) so it stops
> directing agents to read line 2 and use sqlite3; redirect to the endpoint-based `query-kanban`
> skill. The TS resolver is already correct and needs no change.

### 2. Refuse a store that cannot answer

A database with no `plans` table is not a lower-priority answer — it is a wrong one. Resolution
rejects it and continues rather than returning it.

> **Superseded:** Enforce a `plans`-table check inside the shared TS resolver.
> **Reason:** The TS resolver (`resolveBoardDbPath`) never returns a store lacking a `plans` table —
> it derives the path from line 1 and the boards directory, which is the live board. The
> `plans`-table hazard only arises in the bash snippet, which opens whatever file the rung hands it.
> The fix is to remove the snippet from the in-repo consumer, not to add a schema check to a resolver
> that does not consume line 2.
> **Replaced with:** Remove the sqlite3/line-2 instruction from `.agents/rules/how_to_plan.md`. With
> no in-repo consumer reading line 2, the `plans`-table-via-wrong-store path is closed for repo-resident
> agents. The home skill remains a risk until the user replaces it (see User Review Required).

### 3. Tag the source

Resolution returns `{ path, source }`, where `source` names the rung (`'workspace-id-line2'`,
`'boards-dir'`, `'repo-kanban'`, `'legacy-consolidated'`). Log it wherever it is used. "Which store
answered?" must be answerable after the fact.

> **Superseded:** Add source-tagging to the shared TS resolver for line-2 resolution.
> **Reason:** The TS resolver already tags its source — `resolveBoardDbPath` returns
> `{ path, source: 'board_default' | 'explicit' | 'env' }` and logs it once per distinct path via
> `_logPathResolution`. The fallback rule is already satisfied in the TS path. The untagged resolution
> is the bash snippet, which returns a bare path with no source.
> **Replaced with:** No TS change. The endpoint-based `query-kanban` skill (already in the repo)
> returns `.data.source` (`'board'` | `'archive'`) on `GET /kanban/plan`, which is the tagged answer
> agents should use. Redirecting `.agents/rules/how_to_plan.md` to that skill delivers source-tagging
> without new code.

### 4. Migrate the stale file

When line 2 does not resolve and a later rung does, rewrite line 2 to the resolved path and archive
the original as `workspace-id.migrated.bak` — per `CLAUDE.md`, shipped state is imported before it is
replaced and legacy files are archived rather than unlinked. A no-op on a correct file.

> **Superseded:** Rewrite line 2 to the resolved path (`~/.switchboard/boards/<wsId>.db`).
> **Reason:** Writing a fresh machine-specific absolute path back into line 2 **recreates the exact
> hazard**: a portable file carrying a path that is wrong on every other machine it travels to. The
> resolved path is correct on THIS host and wrong on every other. Line 2 is dead in the TS path — no
> code reads or writes it — so the correct migration is to **remove** line 2, not refresh it.
> **Replaced with:** Migrate the two-line `workspace-id` file to a **one-line** file (line 1 only).
> Archive the original as `workspace-id.migrated.bak`. The migration is atomic (temp-write + rename).
> Line 1 is preserved verbatim, so the TS host and any line-1 reader are unaffected. This removes the
> portable hazard at the source instead of relocating it to a new machine-specific value.

### 5. Fix the skill, which is the path agents actually take

`.claude/skills/query-kanban/SKILL.md` carries the four-rung snippet inline, and that snippet — not
the TypeScript — is what an agent executes. It must be corrected in lockstep, and must keep
`sqlite3 -readonly` on every call so a wrong path can never fabricate a database.

> **Superseded:** Correct the four-rung snippet in `.claude/skills/query-kanban/SKILL.md`.
> **Reason:** The repo copy (`.claude/skills/query-kanban/SKILL.md`) has **already been rewritten** to
> use the LocalApiServer endpoints and states "Direct SQL is a fallback that no longer exists for this
> skill." The same is true of `.agents/skills/query-kanban/SKILL.md`. The stale four-rung snippet
> survives only in the **home** copy, `~/.claude/skills/query-kanban/SKILL.md`, which is outside the
> repo and cannot be modified from here. Correcting a repo file that is already correct is a no-op
> disguised as a fix.
> **Replaced with:** (a) No change to the repo skill copies — they are already correct. (b) Flag the
> home copy in User Review Required for the user to replace or delete. (c) Fix the **actual** in-repo
> consumer that still directs agents to read line 2: `.agents/rules/how_to_plan.md` (see item 7).

### 6. One shared resolver — which reaches both hosts without touching the legacy one

`CLAUDE.md` (2026-09-14): the extension host is being removed in a **hard cutover** — it ships
once alongside everything else and never has to interoperate with the new host. A feature is
never blocked, narrowed or deferred to preserve extension-host behaviour, and **new code must
not be written into the legacy host to keep it compatible.** The staged removal is the board
feature *VS Code Becomes a Sidebar, and Stops Being a Second Host* — Stages 1, 2, 2b and 3 are
all in **PLAN REVIEWED**, none built, so the extension is still a live host today.

**The distinction that matters here:** shared code is not legacy-host code. A fix that lands in a
module both roots already consume reaches the extension for free and is not throwaway. What is
forbidden is *new extension-specific wiring* added so the legacy host keeps pace.

This plan needs no extension-specific work, because the readers are already shared modules: `src/services/LocalFolderService.ts:55` and `src/services/dbMerge.ts:102-105` read `workspace-id`, and `dbMerge.ts:249-257` writes it. Putting validation, source-tagging and the migration **in that shared resolver** fixes both roots at once and adds nothing to `src/extension.ts`.

Do **not** hand-patch a second validating reader into the extension. One resolver, consumed by `src/standalone/bootstrap.ts` and by the shared services the extension already calls.

This is also the one item here that would have been worth doing even under a stricter reading of the rule: a resolver that picks another machine's database is a **correctness** fault, not compatibility work, and an agent following the documented lookup on this machine today reads an empty database or none.

> **Superseded:** Put validation, source-tagging and the migration in the shared resolver consumed
> by `LocalFolderService.ts:55` and `dbMerge.ts:102-105`, which "read `workspace-id`."
> **Reason:** Those readers read **line 1** (the workspace id), not line 2 (the db path).
> `LocalFolderService.ts:57` does `fs.readFileSync(wsIdFile, 'utf8').split('\n')[0].trim()` — line 1.
> `dbMerge.ts:107-109` does `lines[0]?.trim()` — line 1. `dbMerge.ts:254` writes
> `${targetWorkspaceId}\n` — one line. `WorkspaceIdentityService.ts:267,302` writes
> `${workspaceId}\n` — one line. No TS code reads or writes line 2. The "shared resolver" these
> readers feed does not consume line 2, so putting line-2 validation there fixes nothing about line 2.
> The premise that the TS host is a line-2 consumer is false; the TS control-plane already derives the
> board path from line 1 and validates it.
> **Replaced with:** No shared TS resolver change. The fix is in the agent-facing documents
> (`.agents/rules/how_to_plan.md`) and the state-file migration (item 4, revised). The standalone
> host and the extension host are both unaffected because neither reads line 2. This satisfies the
> divergence rule trivially: there is no composition-root wiring to drift, because no host code
> changes.

### 7. Fix `.agents/rules/how_to_plan.md` — the in-repo consumer the original plan missed

`.agents/rules/how_to_plan.md` lines 16 and 66 instruct every planner to "read
`.switchboard/workspace-id` for ID and DB path, then query with sqlite3." This is a repo-resident
document that still directs agents to consume line 2 and bypass the endpoint-based skill. It is the
actual in-repo consumer of line 2, and the original plan did not audit it.

- **Context:** The `query-kanban` skill (repo copies) has moved to LocalApiServer endpoints and
  explicitly retired direct SQL. `how_to_plan.md` still references the retired `query_switchboard_kanban`
  skill name and the line-2/sqlite3 path. An agent following `how_to_plan.md` reads line 2, gets a
  machine-foreign path, and hits the wrong store or a fabricated 0-byte database.
- **Logic:** Replace the two instructions (lines 16 and 66) so they reference the `query-kanban` skill
  and its endpoint-based reads (`switchboard api GET /kanban/board`), not line 2 and sqlite3. Remove
  the "read `.switchboard/workspace-id` for ID and DB path" phrasing entirely — agents no longer
  resolve the database path themselves; the host does.
- **Implementation:** In `.agents/rules/how_to_plan.md`:
  - Line 16: change `Query the Kanban database via the \`query_switchboard_kanban\` skill (read \`.switchboard/workspace-id\` for ID and DB path, then query with sqlite3) to retrieve all active plans.` to `Query the Kanban board via the \`query-kanban\` skill (\`switchboard api GET /kanban/board\`) to retrieve all active plans.`
  - Line 66: change the parenthetical `(read \`.switchboard/workspace-id\` for ID and DB path, then query with sqlite3)` to `(\`switchboard api GET /kanban/board\`)`.
- **Edge Cases Handled:** An agent that cannot reach the host gets `STORE_UNAVAILABLE` (503), which the
  `query-kanban` skill already instructs the agent to report and stop — not to fall back to sqlite3.
  This closes the fabrication hazard: there is no sqlite3 invocation to pass a dead path to.

## Verification Plan

### Automated Tests

- **Contract** — seed `workspace-id` line 2 with a foreign absolute path (`/Users/...`) that does not
  exist; assert resolution returns the `boards/<workspace-id>.db` path with `source: 'boards-dir'`.
  This fails today.
- **Contract** — point every rung at non-existent paths; assert resolution **errors** and that no new
  database file appears anywhere on disk afterwards.
- **Contract** — point a rung at a SQLite file with no `plans` table; assert it is refused rather than
  returned.
- **Unit (migration)** — a stale line 2 is rewritten and `workspace-id.migrated.bak` holds the original;
  a correct line 2 is left byte-identical.
- **Parity** — both composition roots resolve the same path and the same `source` for the same inputs.

Run `npm run compile-tests` before any `test:contract:*` script.

> **Note (improve pass):** The contract tests above were written for the original shared-resolver
> approach. Under the revised plan, the TS resolver is unchanged (it already passes these), so the
> meaningful tests are: (a) the migration unit test — a two-line file becomes one-line, original
  archived, line 1 preserved verbatim; (b) a grep/doc test asserting `.agents/rules/how_to_plan.md`
> contains no `sqlite3` or `workspace-id` DB-path instruction. The contract tests for the TS resolver
> are redundant with existing `storage-topology-contract.test.js` assertions
> (`topology.board.source === 'board_default'`), which already pass.

### Goal Invariants

1. A path from another machine never wins over a store that exists here.
2. No resolution path can create a database.
3. Every resolution records which rung answered.
4. The skill's snippet and the TypeScript resolve identically.

> **Note (improve pass):** Invariant 4 is vacuously true under the revised plan — the repo skill has
> no snippet, and the TS resolver ignores line 2. The meaningful invariant is: **no in-repo document
> instructs an agent to read line 2 of `workspace-id` or invoke `sqlite3` directly.** A grep for
> `sqlite3` and `workspace-id` DB-path phrasing in `.agents/rules/how_to_plan.md` returns nothing.
> The home skill (`~/.claude/skills/query-kanban/SKILL.md`) is out of repo scope and is not covered by
> this invariant — it is flagged in User Review Required.
