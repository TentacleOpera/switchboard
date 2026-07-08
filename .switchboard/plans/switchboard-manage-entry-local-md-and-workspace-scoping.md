# Fix `switchboard-manage` Entry: Local-Markdown-First, Workspace-Scoped, Low-Noise Console

## Metadata

**Complexity:** 3
**Tags:** bugfix, reliability, docs

## Goal

Rewrite the entry protocol and persona of the `switchboard-manage` skill so a consultative
"just report the board" entry is **fast, offline, workspace-correct, and quiet** — one
liveness check, then the current workspace's local markdown, then stop. The live HTTP API is
touched **only** when the user requests a mutation/inspection, and every such call is
explicitly scoped to the current workspace.

Single source of truth for this change is the control-plane file
`.agents/skills/switchboard-manage/SKILL.md`. **This is a control-plane / system file — do
not implement until the user has explicitly approved this plan.**

### Core problems (observed on the first real run)

1. **Wrong workspace reported (data-integrity bug — most serious).** The skill was launched
   in `/Users/.../GitHub/switchboard` but the entry report listed projects and features from
   `/Users/.../Gitlab` (App snappyness, Sprint 116, PII Data, Meta Conversions API…). The
   user had to catch it and ask for a correction.

2. **API-first when local files are faster _and_ correct.** For a "I just want to chat"
   entry there is no reason to hit the network for board state; the local export is instant,
   offline, and — critically — already scoped to the right workspace.

3. **Too many checks at entry.** The run fired a barrage: port read → `/health` →
   `/kanban/board` → `jq` counting → `/kanban/features` → per-feature subtask fetches. The
   user found the curl noise alarming and redundant.

4. **Irrelevant / noisy output.** The report surfaced raw feature UUIDs, an undifferentiated
   1,080-card `CODE REVIEWED` count, and a large action menu — for someone who only wanted a
   status glance.

5. **The agent rationalized instead of correcting.** When challenged ("isn't the health
   check the point? isn't the rest redundant?"), it defended API-first repeatedly. That is
   not a persona defect — it faithfully followed a skill that frames markdown as a degraded
   fallback.

### Root cause

`SKILL.md` §1 (Entry Protocol) and the §2 action table were authored **API-first with no
workspace-root discipline**:

- **§1 step 2 (`SKILL.md:31`)** — `GET /kanban/board` with markdown demoted to
  _"(or read `.switchboard/kanban-board.md` if the API is unreachable)"_. The API server
  multiplexes multiple roots (`/health` returns `roots: [...]`), and a call with **no
  `workspaceRoot` param resolves to the server's _primary_ root** → the Gitlab workspace.
  The skill never instructs the agent to pass `workspaceRoot`, so bug #1 is guaranteed on any
  multi-root machine.
- **§1 step 3 (`SKILL.md:35`)** — `GET /catalog` pulls the entire protocol surface on every
  entry. Pure overhead for a status glance.
- **§1 step 2's report spec (`SKILL.md:33`)** — _"columns, card counts… features and their
  subtask status"_ with no instruction to hide UUIDs, scope to the active project, or
  collapse terminal columns → the noisy output.

### Evidence that local-markdown-first is the correct primary path

Verified against this workspace's `.switchboard/`:

- The state files **live inside the current workspace's `.switchboard/`**, so reading them is
  workspace-correct **by construction** — it structurally eliminates bug #1.
- Each card line carries a `<!-- planId:… -->` marker, so **exact per-column counts come from
  `grep -c 'planId:' kanban-state-<col>.md` without loading the file into context** (the
  `code-reviewed` file is 434 KB / 1,083 cards — never ingest it). Live run:
  created 11 · plan-reviewed 6 · lead/coder/intern 3/13/8 · backlog 31 · code-reviewed 1083.
- `kanban-board.md` carries an `Updated:` timestamp, so snapshot staleness is visible to the
  user.
- Feature cards are distinguishable (`<!-- planId:… feature -->`) and feature files live in
  `.switchboard/features/*.md` — names available without any UUID exposure.

The stale-vs-live delta is small and acceptable for a consultative report; the moment the
user *acts*, the action-time API call is authoritative.

## Non-goals / rejected options

- **A "single status.sh helper script"** (the user's own first idea) — **rejected.** It
  treats the symptom (curl noise) not the cause (too many calls). After this change, entry
  makes exactly one curl (`/health`); a wrapper would be dead weight.
- No changes to the orchestration engine, the `switchboard-orchestrator` persona, or the
  `switchboard-orchestration` HTTP contract.
- No code, DB-schema, or endpoint changes — this is a skill-document rewrite only.

## Design — the new behavior

### New Entry Protocol (§1 rewrite)

1. **Resolve the workspace root once.** `ROOT` = the directory the skill was launched in
   (the folder containing `.switchboard/api-server-port.txt`). Define it once and reuse
   everywhere. This is the single anchor that fixes workspace scoping.
2. **Liveness only — the one network call.** Read the port, `curl -s "$BASE/health"`.
   Optionally cross-check that `ROOT` appears in `health.roots`; if it does not, warn the
   user they are outside a registered Switchboard workspace and stop. **No other API call at
   entry.**
3. **Read board state from LOCAL markdown, scoped to `ROOT`:**
   - Counts via `grep -c 'planId:' "$ROOT/.switchboard/kanban-state-<col>.md"` per column —
     never load the files. Count feature rows (`… feature -->`) separately so column card
     counts are not inflated by feature cards.
   - Read feature **names + column/status** from `$ROOT/.switchboard/features/*.md`. Never
     surface UUIDs.
   - Read and display the `Updated:` timestamp from `kanban-board.md` so staleness is
     explicit.
4. **Report concisely, then stop:**
   - Lead with the **actionable pre-code columns** (CREATED, PLAN REVIEWED, LEAD/CODER/INTERN
     CODED, BACKLOG) and features by name + status.
   - Collapse terminal/archive columns (e.g. `CODE REVIEWED: 1083`) to a **single count
     line** — do not enumerate.
   - If an active project filter is set, scope the report to it and say so; if none, report
     the whole workspace and say so.
   - Then ask what the user wants. **No API board query, no `/catalog`, no automation, no
     eager action.**

### Defer the API to action-time (§2 rewrite)

- **Every** `/kanban/*` example in the §2 table gains `?workspaceRoot=$ROOT` (or the body
  field where POST). Add a bolded rule at the top of §2:
  > **Every API call carries `workspaceRoot=$ROOT`.** The server multiplexes workspace roots;
  > a bare call silently targets the *primary* root — the wrong workspace. This is not
  > optional.
- **`GET /catalog` moves out of entry** and becomes a **lazy, on-demand** step: consult it
  only when the user requests an action that is not already in the §2 table.
- The action-time API read (e.g. `GET /kanban/board?workspaceRoot=$ROOT` before a move) is
  where "live, authoritative state" is fetched — this preserves accuracy exactly where it
  matters (before a mutation) without paying for it on every entry.

### Persona / framing fixes (§1 + §6)

- Kill the "markdown is a fallback only if the API is unreachable" framing. New stance:
  **local markdown is the primary source for read-only status; the API is for
  verify-before-mutate and for mutations.** This removes the premise the agent used to argue
  back at the user.
- Add an explicit output rule: **never display raw UUIDs** in the entry report (resolve them
  internally when an action needs one).

## Files to change

- **`.agents/skills/switchboard-manage/SKILL.md`** — the source of truth. Rewrite §1 (Entry
  Protocol), §2 (add `workspaceRoot` everywhere + move `/catalog` to lazy), and tighten §6
  (persona/output rules). This is the only file with substantive edits.
- **Mirror:** there is currently **no** `.claude/skills/switchboard-manage/` mirror (verified).
  If the build/sync step later generates skill mirrors, regenerate so `.claude` stays in
  sync — do not hand-edit a generated mirror.
- **Sanity-check only (likely no edit):** the `switchboard-manage` row in `AGENTS.md` /
  generated `CLAUDE.md` already reads _"Consultative persona: report state on entry, then
  wait"_ — confirm it still matches; no change expected.

## Edge cases & risks

- **Snapshot staleness.** Local md is a periodic export; a just-moved card may lag. Mitigated
  by (a) showing the `Updated:` timestamp and (b) the authoritative action-time API read
  before any mutation. Acceptable for a consultative glance.
- **Count correctness.** `grep -c 'planId:'` also matches the feature card row. Count feature
  rows separately (`… feature -->`) so per-column plan counts are not inflated.
- **Launched outside a workspace** (no `.switchboard/`). The `health.roots` cross-check catches
  it; instruct the user to `cd` into the workspace rather than silently reporting the wrong
  root.
- **User explicitly names another project/workspace.** Honor the user's words over the cwd
  default (existing §6 rule 5 stays); the cwd default only applies when nothing is named.
- **Empty/near-empty state files** (a column file that is just its `## HEADER`). `grep -c`
  returns 0 gracefully — no special-casing needed.

## Verification / acceptance criteria

1. **Workspace scoping:** launch the skill in `/…/GitHub/switchboard` → the entry report
   shows *switchboard* features (CRT Animation, Tracker-Structure Round-Trip, ClickUp API
   Modernization…) and switchboard counts (created ~11, backlog ~31), and **never** Gitlab's
   App-snappyness / Sprint-116 / PII-Data / Meta-Conversions.
2. **Minimal checks:** entry issues **exactly one** curl (`/health`) and **zero** `/kanban/*`
   or `/catalog` calls. (Grep the session transcript / API access log.)
3. **No UUIDs** appear anywhere in the entry report.
4. **Big files never loaded:** the `code-reviewed` column is reported as a single count line;
   the 434 KB file is never read into context (counts come from `grep -c`).
5. **Action-time scoping:** ask to examine or move a plan → the resulting API call includes
   `workspaceRoot=$ROOT`.
6. **Framing:** re-running the user's original pushback ("isn't the health check enough?")
   no longer produces an API-first defense — the skill now agrees by design.

## Rollback

Single-file revert of `.agents/skills/switchboard-manage/SKILL.md` (git). No data or schema
touched, so rollback is a `git checkout` of that one file.
