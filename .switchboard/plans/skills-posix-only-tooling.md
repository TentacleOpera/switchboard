# Three skills instruct agents to use POSIX-only tooling — point them at the existing Node equivalents

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** `.agents/skills/_lib/sb_api_call.sh` no longer exists (deleted in `96fb16df`); drop the step that marks it POSIX-only. The `sqlite3` and `curl` rewrites in `query-kanban`, `manage-features` and `kanban_operations` still stand — three bare `sqlite3` calls remain in `manage-features/SKILL.md` around lines 172, 212 and 218.


## Goal

Make the control-plane skills executable by an agent on Windows. Three SKILL.md files and one shell library reach for `sqlite3`, `curl` and `jq`; an agent following them verbatim on Windows fails. The Node equivalents already exist for some operations — the instructions simply do not point at them. For operations with no existing Node equivalent, the skill text must be rewritten to use `node -e` one-liners or the HTTP API so no POSIX CLI tool is required.

### Problem Analysis

Four files assume POSIX command-line tooling, but the distribution of POSIX tools across them is uneven:

- `.agents/skills/query-kanban/SKILL.md` — **heavily** `sqlite3`-based. The skill IS the SQL interface: 15+ SQL templates for filtering by column, workspace name, project, feature/subtask relationships, and counts. No `.js` sibling exists in this directory.
- `.agents/skills/manage-features/SKILL.md` — `sqlite3` in three prerequisite-check blocks (lines 175-177, 215-217, 221-223) for verifying plans are imported. No `.js` sibling exists in this directory. The rest of the skill already uses `node` scripts and `cat`.
- `.agents/skills/kanban_operations/SKILL.md` — **already mostly Node**. The only POSIX tools are `jq` (one pipe example, line 195: `node ... | jq '.columns["CREATED"] | length'`) and `grep` (one offline lookup, line 13). No `sqlite3` or `curl` in this file. Seven `.js` siblings exist in this directory and are already the primary path.
- `.agents/skills/_lib/sb_api_call.sh` — `curl` and `jq` throughout. A general-purpose HTTP client library with health verification, retry, and backoff. No Node equivalent exists — the `.js` helpers each embed their own `http.request` calls internally.

> **Superseded:** the control plane is 17 `.js` helper scripts to 1 `.sh` file, and three of the four have `.js` siblings in their own directory doing the same job — `kanban_operations/get-state.js`, `kanban_operations/assign-to-feature.js`, and friends.
> **Reason:** Verified by directory listing: `query-kanban/` contains only `SKILL.md` (no `.js` files). `manage-features/` contains only `SKILL.md` (no `.js` files). Only `kanban_operations/` has `.js` siblings (7 scripts), and it already uses them as its primary path. The "three of the four" claim is wrong for two of three skills.
> **Replaced with:** Only `kanban_operations/` has `.js` siblings, and it already points at them — the remaining POSIX surface is one `jq` pipe example and one `grep` lookup. `query-kanban` and `manage-features` have no `.js` siblings; their Node path is `kanban_operations/get-state.js` (full board dump), the HTTP API (`GET /kanban/board`, `GET /kanban/columns`), or `node -e` one-liners. `_lib/sb_api_call.sh` has no Node equivalent at all.

The failure is not a crash in Switchboard; it is an agent that reads an authoritative instruction, runs a command that does not exist, and improvises. That is worse than a missing skill, because the improvisation is unbounded — an agent told to query state with `sqlite3` and unable to may reach for direct DB writes, which the protocol forbids.

### Root Cause

A skill instruction reads as a command and is in fact a bash command. Nothing in the authoring path distinguishes the two, and the skills were written and tested on macOS.

### Non-goals

- Not rewriting `_lib/sb_api_call.sh` in Node. Marking it POSIX-only and naming the specific `.js` helpers that cover each operation is enough; it has one caller class.
- Not auditing every skill for platform assumptions — this plan covers the four files identified by a `sqlite3|curl|jq` sweep of `.agents/skills` and `.switchboard/protocols`.
- Not writing a new `query-kanban.js` helper with filter parameters. The SQL templates will be rewritten as `get-state.js` output filtered through `node -e` one-liners, preserving capability without new scripts.

## Metadata

**Complexity:** 3
**Tags:** windows, skills, control-plane, cross-platform

## User Review Required

None. Repointing instructions at existing scripts and rewriting SQL templates as Node one-liners changes no behaviour on macOS or Linux.

## Complexity Audit

### Routine
- `kanban_operations/SKILL.md`: replace one `jq` pipe example with `node -e` and one `grep` lookup with a `node -e` scan of `get-state.js` output.
- `manage-features/SKILL.md`: replace three `sqlite3` prerequisite-check blocks with `get-state.js` or HTTP API equivalents.
- `_lib/sb_api_call.sh`: add a POSIX-only header comment naming the specific `.js` helpers per operation.

### Complex / Risky
- **`query-kanban/SKILL.md` is the hard one.** Its entire value is 15+ filtered SQL templates (by column, workspace name, project, feature/subtask, counts). `get-state.js` dumps the full board as JSON — it does not filter. Each SQL template must be rewritten as a `node -e` one-liner that pipes `get-state.js` output through a JSON filter, or as an HTTP API call (`GET /kanban/board`). A template too complex for a one-liner must use the HTTP API. This is the bulk of the work and the highest regression risk: an agent must still be able to query "plans in project X" or "subtask counts per feature" without loading the entire board and parsing it manually.
- **The Node path must actually cover the documented use.** A skill repointed at a script that does less than the shell command it replaced is a silent capability regression, and the affected skills include the read path the orchestrator depends on. Each replacement needs checking against what the skill actually asks for, not just that a script with a plausible name exists.

## Edge-Case & Dependency Audit

- `query-kanban` is explicitly read-only by design and is the skill agents use instead of direct SQL. If a rewritten `node -e` filter cannot express a query the skill documents, the gap must be closed with an HTTP API call, not by leaving the `sqlite3` instruction in place.
- `kanban_operations` is the sanctioned manual card-move path. A regression there is user-visible immediately.
- The protocol forbids execution agents from touching kanban columns via SQL. Any replacement must not widen what these skills can write.
- Skills hot-reload mid-session in Claude Code, and skill discovery is host-split — Claude Code reads a mirror manifest while Antigravity walks the filesystem. Renaming or moving a skill file requires a lockstep manifest edit; repointing text inside an existing file does not.
- `get-state.js` requires the compiled `out/services/KanbanDatabase` module (it does `require('../../../out/services/KanbanDatabase')`). On a dev machine without a build, this path may not exist. The HTTP API (`GET /kanban/board`) is the fallback when the extension is running but `out/` is absent. The skill text should document both paths.
- `sb_api_call.sh` has no Node equivalent. The `.js` helpers (`move-card.js`, `create-feature.js`, etc.) each make their own HTTP calls. A Windows agent needing a general HTTP client should use `node -e` with `http.request`. The header comment must name the specific `.js` helpers per operation, not claim a drop-in replacement.

## Dependencies

- Independent of both Windows code plans. No shared files, no ordering constraint.

## Adversarial Synthesis

Key risks: (1) `query-kanban`'s 15+ SQL templates must each be rewritten as a `node -e` filter or HTTP API call — an underspecified rewrite loses filtered-query capability, the exact regression the plan warns against. (2) `get-state.js` requires compiled `out/` output, which may not exist on a dev machine — the HTTP API is the fallback. (3) `sb_api_call.sh` has no Node equivalent; claiming one would mislead Windows agents. Mitigations: rewrite every SQL template concretely, document both `get-state.js` and HTTP API paths, and name specific `.js` helpers per `sb_api_call.sh` operation.

## Proposed Changes

1. **Rewrite `query-kanban/SKILL.md`** to replace all `sqlite3` SQL templates with cross-platform equivalents. Each template becomes one of:
   - A `node .agents/skills/kanban_operations/get-state.js <root> | node -e '<filter>'` one-liner (for filtered queries), OR
   - An HTTP API call (`GET http://127.0.0.1:$(cat .switchboard/api-server-port.txt)/kanban/board` piped through `node -e`) when the extension is running.
   The skill must document both paths and state when each applies (extension running vs. offline). The schema reference and column-label mapping tables stay — they are reference material, not commands. The `sqlite3 -readonly` guard becomes a note that `get-state.js` is read-only by design.

2. **Repoint `manage-features/SKILL.md`** prerequisite checks: replace the three `sqlite3` blocks (lines 175-177, 215-217, 221-223) with `get-state.js` checks (verify the plan appears in board state JSON) or HTTP API checks (`GET /kanban/board`). The rest of the skill already uses `node` scripts.

3. **Fix `kanban_operations/SKILL.md`** POSIX remnants: replace the `jq` pipe example (line 195) with `node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.columns["CREATED"].length)'`, and replace the `grep` lookup (line 13) with a `node -e` scan of `get-state.js` output. These are the only POSIX tools in this file.

4. **Mark `_lib/sb_api_call.sh` POSIX-only** in a header comment. Name the specific `.js` helpers that cover each operation (e.g., "card moves: `move-card.js`; feature creation: `create-feature.js`; board state: `get-state.js`"). State that there is no general-purpose Node HTTP client equivalent — a Windows agent needing one should use `node -e` with `http.request`.

### Migration

None. Instruction text only.

## Verification Plan

1. **Each skill runs on Windows.** Execute all three from a Windows agent and confirm no `sqlite3`/`curl`/`jq` invocation remains on the happy path.
2. **No capability regression in `query-kanban`.** For each of the 15+ SQL templates, exercise the rewritten `node -e` or HTTP API equivalent and confirm it returns the same filtered result set. This is the assertion that catches an underspecified rewrite.
3. **The sweep is clean.** Re-run `grep -rlE "sqlite3 |curl -|\| *jq" .agents/skills .switchboard/protocols` and confirm only the marked shell library remains (with its POSIX-only header).
4. **macOS regression fence.** Run all three on macOS and confirm unchanged results — the `node -e` one-liners produce the same output as the `sqlite3` templates.

## Outstanding Questions

None.
