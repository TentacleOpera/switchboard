# Fix `switchboard-manage` Entry: Local-Markdown-First, Workspace-Scoped, Low-Noise Console

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

> **Root-cause & evidence CONFIRMED against code (2026-07-09 improve pass).** An investigation
> of `src/services/LocalApiServer.ts` + `src/services/TaskViewerProvider.ts` verified every
> load-bearing claim above:
> - `GET /health` returns exactly `{ status: 'ok', port, roots: string[] }`
>   (`LocalApiServer.ts:2320-2322`; `roots` = `this._allRoots`, the registered workspace folders).
> - The server is **genuinely multi-root** — a per-root `KanbanDatabase` map keyed by resolved
>   root (`TaskViewerProvider._getKanbanDb`, `:6393-6399`) — with an explicit **primary/effective**
>   root (comment "defaulting to the primary root", `LocalApiServer.ts:1399`).
> - **Bare-call fallback confirmed:** `GET /kanban/board` with no `workspaceRoot` resolves via
>   `getKanbanDatabase(undefined)` → `getKanbanDatabase(wsRoot || effectiveRoot)`
>   (`TaskViewerProvider.ts:1217`) → the primary/effective root. This is bug #1's mechanism,
>   exactly as the plan states.
> - **`workspaceRoot` is accepted on every `/kanban/*` endpoint** — as a **query param** for
>   reads (`_resolveDbFromQuery`, `:1381-1387`; `/kanban/plan` at `:1423`) and a **body field**
>   for mutations (`/kanban/move` `:500`, `/kanban/plans/import` `:1639`,
>   `/kanban/features/reconcile` `:784`, and the feature verbs). So the fix — add
>   `workspaceRoot=$ROOT` everywhere — is directly supported by the API.
> - Local state-file format claims all hold: `api-server-port.txt`, `kanban-board.md`'s
>   `Updated:` timestamp, `<!-- planId:… -->` and `… feature -->` markers, and the 434 KB
>   `code-reviewed` file all verified present in this workspace.

## Metadata

**Tags:** bugfix, reliability, docs
**Complexity:** 3

## User Review Required

- **Explicit approval gate (unchanged):** this rewrites a control-plane / system skill file —
  do not implement until the user approves. Not a product ambiguity, a change-control rule.
- No open product decisions. The one *new* correction surfaced by the code investigation (the
  §2 `?project=` param does not exist — see Proposed Changes) is unambiguous and folded into
  the rewrite; it needs no user decision.

## Complexity Audit

### Routine
- Single-file rewrite of `.agents/skills/switchboard-manage/SKILL.md` (§1, §2, §6). No code,
  no schema, no endpoints.
- Appending `?workspaceRoot=$ROOT` / body field to each documented `/kanban/*` example.
- Replacing the fallback framing with local-markdown-primary framing.

### Complex / Risky
- **Multi-root correctness is the whole point** — the rewrite must make `workspaceRoot=$ROOT`
  non-optional and consistent across §1 and §2, or bug #1 recurs. This is a *documentation*
  change with *behavioral* stakes (it steers the agent's live API calls).
- Control-plane file feeding both hosts (`AGENTS.md` reader = Antigravity; generated
  `.claude/skills/…` = Claude Code); persona wording is load-bearing for how the agent argues.

## Edge-Case & Dependency Audit

- **Snapshot staleness.** Local md is a periodic export; a just-moved card may lag. Mitigated
  by (a) showing the `Updated:` timestamp and (b) the authoritative action-time API read
  before any mutation. Acceptable for a consultative glance.
- **Count correctness.** `grep -c 'planId:'` also matches the feature card row (verified: the
  `plan-reviewed` file's 12 `planId:` lines include 3 `… feature -->` rows). Count feature
  rows separately (`… feature -->`) so per-column plan counts are not inflated.
- **Launched outside a workspace** (no `.switchboard/`). The `health.roots` cross-check catches
  it; instruct the user to `cd` into the workspace rather than silently reporting the wrong
  root.
- **User explicitly names another project/workspace.** Honor the user's words over the cwd
  default (existing §6 rule 5 stays); the cwd default only applies when nothing is named.
- **Empty/near-empty state files** (a column file that is just its `## HEADER`). `grep -c`
  returns 0 gracefully — no special-casing needed.
- **Dependencies & Conflicts:** shares `.agents/skills/switchboard-manage/SKILL.md` with the
  sibling subtask *"Audit and Restructure Agent Skills"*, but that subtask only touches
  frontmatter/registry (and finds this skill already correct there); this subtask rewrites the
  body. Disjoint regions — no conflict. See `## Dependencies`.

## Dependencies

- `sess_local_agent_skills_improvements — feature "Agent skills improvements"` — sibling subtask
  *"Audit and Restructure Agent Skills to Prevent Discovery Failures"*. Non-blocking. That
  subtask documents the mirror-generation mechanism (`MIRROR_MANIFEST` in
  `ClaudeCodeMirrorService.ts` → `.claude/skills/`) that the "Files to change → Mirror" note
  below relies on. Order-independent.

## Adversarial Synthesis

**Risk Summary:** Low-risk, single-file, revertible doc rewrite whose stakes are behavioral —
if `workspaceRoot=$ROOT` is not made non-optional and consistent across §1/§2, the multi-root
wrong-workspace bug recurs. Mitigations: make workspace-root discipline a bolded top-of-§2 rule
(verified as API-supported on every endpoint), keep the authoritative action-time API read
before mutations, and rely on git single-file revert for rollback.

## Proposed Changes

### `.agents/skills/switchboard-manage/SKILL.md` (the only file with substantive edits)

#### §1 — Entry Protocol (rewrite)
- **Context:** Currently API-first with markdown demoted to an unreachable-fallback.
- **Logic (new flow):**
  1. **Resolve the workspace root once.** `ROOT` = the directory the skill was launched in
     (the folder containing `.switchboard/api-server-port.txt`). Define once, reuse everywhere —
     the single anchor that fixes workspace scoping.
  2. **Liveness only — the one network call.** Read the port, `curl -s "$BASE/health"`.
     Optionally cross-check that `ROOT` appears in `health.roots`; if not, warn the user they
     are outside a registered Switchboard workspace and stop. **No other API call at entry.**
  3. **Read board state from LOCAL markdown, scoped to `ROOT`:**
     - Counts via `grep -c 'planId:' "$ROOT/.switchboard/kanban-state-<col>.md"` per column —
       never load the files. Count feature rows (`… feature -->`) separately so column counts
       are not inflated.
     - Feature **names + column/status** from `$ROOT/.switchboard/features/*.md`. Never surface
       UUIDs.
     - Display the `Updated:` timestamp from `kanban-board.md` so staleness is explicit.
  4. **Report concisely, then stop:** lead with actionable pre-code columns (CREATED, PLAN
     REVIEWED, LEAD/CODER/INTERN CODED, BACKLOG) + features by name/status; collapse terminal
     columns (e.g. `CODE REVIEWED: 1083`) to a single count line; scope to the active project
     filter if set (say so) else the whole workspace (say so); then ask what the user wants.
     **No API board query, no `/catalog`, no automation, no eager action.**
- **Edge Cases:** as in the Edge-Case audit (staleness, feature-row count, outside-workspace).

#### §2 — User-Directed Actions (rewrite)
- **Context:** The action table's `/kanban/*` examples carry no `workspaceRoot`, and the board
  example shows a `?project=` param.
- **Logic:**
  - Add a bolded rule at the top of §2:
    > **Every API call carries `workspaceRoot=$ROOT`.** The server multiplexes workspace roots;
    > a bare call silently targets the *primary* root — the wrong workspace. This is not
    > optional.
  - Give **every** `/kanban/*` example `?workspaceRoot=$ROOT` (query for reads) or a
    `workspaceRoot` body field (POST) — confirmed accepted on all of them.
  - Move `GET /catalog` **out of entry** into a lazy, on-demand step: consult it only when the
    user requests an action not already in the §2 table.

  > **Superseded:** `**Browse the board / switch project view** | GET /kanban/board?project=<name>`
  > **Reason:** Code investigation (`LocalApiServer._handleGetBoard`, `:1272-1278`) confirmed the
  > board endpoint reads **only** `workspaceRoot`; there is no `project` parsing on
  > `/kanban/board` (an unknown `?project=` is silently ignored and returns the whole workspace
  > board). Documenting a param that does nothing invites exactly the false-confidence failure
  > this plan is fixing.
  > **Replaced with:** `**Browse the board** | GET /kanban/board?workspaceRoot=$ROOT` (returns the
  > whole workspace board). For project-scoped views, filter client-side, or use the real
  > board-adjacent filters on `GET /kanban/plans?workspaceRoot=$ROOT&column=…` /
  > `&featureId=…`. If per-plan project assignment is needed, that is `PUT /kanban/plans/project`,
  > not a board query.

- **Edge Cases:** the action-time API read (e.g. `GET /kanban/board?workspaceRoot=$ROOT` before
  a move) is where live, authoritative state is fetched — preserving accuracy where it matters
  (before a mutation) without paying for it on every entry.

#### §1 + §6 — Persona / framing fixes
- **Context:** The "markdown is a fallback only if the API is unreachable" framing is the
  premise the agent used to argue back at the user.
- **Logic:** New stance — **local markdown is the primary source for read-only status; the API
  is for verify-before-mutate and for mutations.** Add an explicit output rule: **never display
  raw UUIDs** in the entry report (resolve them internally when an action needs one).
- **Edge Cases:** §6 rule 5 (honor a user-named project over the cwd default) stays as-is.

### Mirror (generated — do not hand-edit)
- There is currently **no** `.claude/skills/switchboard-manage/` mirror on disk (verified),
  even though `switchboard-manage` **is** in `MIRROR_MANIFEST` (`ClaudeCodeMirrorService.ts:65`,
  `invocation: 'no-model'`) — the mirror only regenerates on version-change / Setup, so it is
  stale, not missing-by-design. After this SKILL.md edit, a regeneration (Setup) will emit the
  updated mirror. Do **not** hand-edit the generated mirror. (This mechanism is documented by
  the sibling audit subtask.)

### Sanity-check only (likely no edit)
- The `switchboard-manage` row in `AGENTS.md:113` / generated `CLAUDE.md` already reads
  _"Consultative persona: report state on entry, then wait for user direction."_ — confirmed
  still matches; no change expected.

## Non-goals / rejected options

- **A "single status.sh helper script"** (the user's own first idea) — **rejected.** It treats
  the symptom (curl noise) not the cause (too many calls). After this change, entry makes
  exactly one curl (`/health`); a wrapper would be dead weight.
- No changes to the orchestration engine, the `switchboard-orchestrator` persona, or the
  `switchboard-orchestration` HTTP contract.
- No code, DB-schema, or endpoint changes — this is a skill-document rewrite only.

## Verification Plan

> Per session directive, **no compilation and no automated test runs** in this session.
> Verification is behavioral/acceptance, driven by re-running the skill.

### Automated Tests
- None (directive). The acceptance criteria below are the verification.

### Acceptance criteria
1. **Workspace scoping:** launch the skill in `/…/GitHub/switchboard` → the entry report shows
   *switchboard* features (CRT Animation, Tracker-Structure Round-Trip, ClickUp API
   Modernization…) and switchboard counts (created ~11, backlog ~31), and **never** Gitlab's
   App-snappyness / Sprint-116 / PII-Data / Meta-Conversions.
2. **Minimal checks:** entry issues **exactly one** curl (`/health`) and **zero** `/kanban/*`
   or `/catalog` calls. (Grep the session transcript / API access log.)
3. **No UUIDs** appear anywhere in the entry report.
4. **Big files never loaded:** the `code-reviewed` column is reported as a single count line;
   the 434 KB file is never read into context (counts come from `grep -c`).
5. **Action-time scoping:** ask to examine or move a plan → the resulting API call includes
   `workspaceRoot=$ROOT`.
6. **Framing:** re-running the user's original pushback ("isn't the health check enough?") no
   longer produces an API-first defense — the skill now agrees by design.

## Rollback

Single-file revert of `.agents/skills/switchboard-manage/SKILL.md` (git). No data or schema
touched, so rollback is a `git checkout` of that one file.

## Recommendation

**Complexity 3 → Send to Intern**, with the caveat that this is a control-plane file behind an
explicit user-approval gate: an intern-level executor should apply the rewrite verbatim to the
approved design, not improvise persona wording. Ready to execute on approval.

---

## Code Review — In-Place Reviewer Pass (2026-07-09)

Reviewed the committed `.agents/skills/switchboard-manage/SKILL.md` (`a4ad186`) against this plan.
**Result: implementation fully satisfies the plan; no CRITICAL/MAJOR findings; no code fixes
required.** The rewrite is behaviorally correct against every acceptance criterion.

### Acceptance criteria — verified against the file
1. **Workspace scoping (the data-integrity bug):** FIXED by construction. §1 resolves `ROOT` once
   (dir containing `.switchboard/api-server-port.txt`), reads local markdown under `$ROOT`, and §2
   makes `workspaceRoot=$ROOT` a bolded non-optional rule on every `/kanban/*` example. Reading the
   current workspace's own `.switchboard/` structurally eliminates the Gitlab-vs-switchboard cross-talk.
2. **Minimal checks:** entry now issues exactly one network call (`curl /health`); counts come from
   `grep -c 'planId:'` on local state files — verified all 7 referenced `kanban-state-*.md` filenames
   exist in this workspace, so the greps resolve.
3. **No UUIDs:** §1 step 4 + Hard Rule 7 forbid raw UUIDs in the entry report.
4. **Big files never loaded:** `code-reviewed` collapsed to a single count line; counts via `grep -c`.
5. **Action-time scoping:** §2 rule + per-row `workspaceRoot` (query for reads, body for writes).
6. **Framing:** §1 lead sentence + Hard Rule 3 make local markdown the primary read path — the
   API-first defense the agent used to argue with is gone. The stale `?project=` param is removed
   (board browse is `?workspaceRoot=$ROOT`), matching the plan's superseded-param correction.

Cross-integration bonus: the rewrite also documents the sibling ergonomics subtask's new
`POST /kanban/features/assign` single-add primitive (§2 row + §3), so the two subtasks compose.

### Findings
- **NIT (defer):** §1 step 3's shown `grep -c 'planId:'` commands count feature-card rows too; the
  "count feature rows separately (`… feature -->`)" caveat is stated in prose but no subtract command
  is shown. Per-column plan counts can be inflated by the handful of feature rows in pre-coding
  columns. Cosmetic — the caveat is present and an agent following it will `grep -c 'feature -->'`
  and subtract. Not worth a change.

### Files changed by this review
- None (no CRITICAL/MAJOR findings).

### Validation (per directive: no compile, no tests)
- Verified all 7 `kanban-state-*.md` filenames in §1 exist under `.switchboard/`.
- Confirmed `?project=` is absent from the board row and `workspaceRoot` is present on every §2 example.
- SKILL.md frontmatter carries `name` + `description` (Antigravity-registerable); manifest entry
  present (`ClaudeCodeMirrorService.ts:65`, `no-model`).

### Remaining risks
- Behavioral acceptance (does a live re-run issue exactly one curl?) can only be confirmed by
  running the skill; static review confirms the document now steers that behavior.
- Mirror regen deferred to the version bump (as the plan notes).
