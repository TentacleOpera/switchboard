# Make the Switchboard Manage Console Speak Human and Offer the Next Step

## Goal

Rewrite the persona/output guidance in the **`switchboard-manage`** skill so the management
console (a) stops leaking internal plumbing — UUIDs, plan filenames, PIDs, raw ISO
timestamps, raw API/DB field dumps — into user-facing text, and (b) becomes *proactive*:
every turn ends by offering the single most natural next step, and a single dispatch offers
to watch the plan to completion.

### The problem (from a real transcript)

The manage console produced these defects in one short session:

1. **Entry header too technical.** `Board: CREATED 5 · PLAN REVIEWED 3 · BACKLOG 30 ·
   terminal 1084. Updated 2026-07-11T11:34:49.977Z. (Whole workspace)` — a raw
   millisecond ISO timestamp, and a "terminal 1084" token the user (correctly) misread.
2. **UUIDs + raw filenames in a plan list.** Listing PLAN REVIEWED printed the
   `feature_plan_20260711131500_….md` filename and a `ID: 8a41b0ee-…` line per plan.
3. **No proactive follow-up.** After listing the column the agent went silent — no offer to
   dispatch, which is the obvious next move from a pre-code column.
4. **Dispatch confirmation dumped raw fields and omitted the terminal.** It printed
   `Role: Coder / Session ID / Plan ID: <uuid> / Moved: Yes / Dispatched: Yes (at <ISO>)`,
   never named the terminal the work landed on, and split one synchronous call across two
   messages with a "running in the background, waiting for the API server" narration.
5. **No completion watch.** After "advance this to a coder," nothing watched for or offered
   to watch for completion.

### Root cause

The persona was tuned hard for **terseness and non-eagerness** — but that discipline was
only ever *written for the entry snapshot*. Past entry, the skill gives **no guidance on
humanizing output** and **no guidance on offering a next step**, so the agent falls back to
dumping raw response fields and stopping dead. Several defects are things the skill
*actively prescribes*, not the agent freelancing:

- The bad header is literally the prescribed format (`SKILL.md:71`), and "terminal N" is the
  skill collapsing **all** post-code columns — coding, review, *and the forever-growing
  COMPLETED* — into one number (`SKILL.md:68–69`). That label collides with the "terminal
  agent" concept used everywhere else in the same skill, and because COMPLETED accumulates
  for the life of the repo, the number is effectively "plans ever made here" — useless.
- Hard Rule 8 forbids UUIDs *"in the entry report"* only (`SKILL.md:496–498`) — scoped so
  narrowly that lists slip straight through; nothing forbids raw filenames at all.
- Hard Rules 2 & 3 ("default is never automation", "no eager action on entry") get
  **over-applied** into "list it and go silent." The skill never distinguishes proactive
  *suggestion* from eager *action*.
- The dispatch response already carries everything issue 4 wants — `topic`, `routing`, and
  `dispatchedAgent` (verified in `LocalApiServer.ts:664–676`; `dispatchedAgent` is the
  terminal/tool name per `KanbanDatabase.ts:55`) — but the skill (`SKILL.md:176–188`) only
  documents the field *names*, never how to report them in human terms, so the agent dumps
  the raw shape.
- The mtime-based completion signal exists (`SKILL.md §6c`) but is **locked inside the
  automation modes** (§6/§7). A one-off dispatch reaches none of it.

### Success looks like

The five transcript defects cannot recur, because the skill now prescribes the *human*
form for each surface and an explicit "offer the next step" rule. No LocalApiServer change
is required — every field needed already ships in the responses.

## Confirmed design decisions

- **Completion watch:** *offer after every single dispatch; start only on "yes."* The
  single-dispatch watch is lightweight and **session-scoped** — it must NOT write
  `oversight-state.md` and must NOT trip the §1 "resume the interrupted pass" entry logic
  (that apparatus stays exclusive to the §6/§7 multi-card passes).
- **Header:** break out every non-empty column positioned **before CODE REVIEWED**
  individually (this surfaces the coding columns = in-flight work); **omit CODE REVIEWED and
  every column after it** (the terminal side) from the headline. No collapsed lifetime
  number.
- **Scope:** `switchboard-manage` only. `switchboard-orchestrator` / `switchboard-chat` are
  out of scope for this plan.

All edits are to the source of truth `.agents/skills/switchboard-manage/SKILL.md`. The
`.claude/skills/…` mirror and `.claude/.switchboard-generated.json` regenerate through the
normal path (VSIX rebuild / Setup); `switchboard-manage` is already in `MIRROR_MANIFEST`, so
no manifest change is needed.

- **Sequencing (feature-internal, binding):** this plan lands **before** its sibling
  *"Refactor Switchboard Entry Points to Four `switchboard-`Tagged Front Doors"*. That
  refactor deletes `.agents/skills/switchboard-manage/` and moves the console body verbatim
  into `.agents/workflows/switchboard.md` — it will absorb this plan's humanized text.
  **Contingency:** if the refactor has somehow landed first, apply these same edits to
  `.agents/workflows/switchboard.md` instead — the body is a verbatim move, so every
  section/line reference here maps 1:1 (offset only by the door's added frontmatter lines) —
  and the "already in `MIRROR_MANIFEST`" note above becomes moot (the console then mirrors
  via the `switchboard` door entry).

## Proposed Changes

### Change 1 — Humanize the entry header, redefine the column split (issue 1)

**Where:** `SKILL.md §1` step 3 (lines 53–88), including the example on line 71 and the
collapse rule on lines 67–69.

**New counting/presentation rule:**
- The single awk pass over `kanban-state-*.md` is unchanged — it still yields per-column
  counts.
- **Headline = every non-empty column *before* CODE REVIEWED, named individually**, in board
  order. For the default board that is: `BACKLOG`, `CREATED`, `PLAN REVIEWED`, and the coding
  columns (`CODED`, `LEAD CODED`, `CODER CODED`, `INTERN CODED`). The coding columns appearing
  here IS the in-flight-work signal — no separate token needed.
- **Omit CODE REVIEWED and every column after it** (`CODE REVIEWED`, `ACCEPTANCE TESTED`,
  `COMPLETED`, and any custom column positioned at/after CODE REVIEWED) from the headline.
  Remove the "terminal N" collapse entirely.
- **Custom / unrecognized columns:** if a custom column's position relative to CODE REVIEWED
  is unknown, **show it by name** (safe default — surface, don't hide).
- **Timestamp:** humanize `kanban-board.md`'s `Updated:` to a short local time or relative
  form (`Updated 11:34` or `Updated 3 min ago`). **Never** print the raw
  `2026-07-11T11:34:49.977Z` ISO/millisecond form.
- Keep the scope note (whole workspace vs active project filter).

**Before:**
`Board: CREATED 5 · PLAN REVIEWED 3 · BACKLOG 30 · terminal 1084. Updated 2026-07-11T11:34:49.977Z. (Whole workspace)`

**After:**
`Board (whole workspace): BACKLOG 30 · CREATED 5 · PLAN REVIEWED 3 · CODER CODED 1. Updated 3 min ago.`

Update the prescribed example on line 71 and the prose on lines 67–72 to match. Delete the
"collapse post-code columns … into a single `terminal N` total" instruction.

### Change 2 — Never leak UUIDs or plan filenames anywhere; add a list template (issues 2 & 3)

**Where:** Hard Rule 8 (`SKILL.md:496–498`) and the "Local-first for lists" note
(`SKILL.md:154–158`).

- **Broaden Hard Rule 8** from "in the entry report" to: *"Never display raw UUIDs **or raw
  plan filenames** anywhere in conversation. Reference plans by a stable list number + their
  human title; resolve the number back to the planId/path internally when an action needs
  one."*
- **Add a list-output template** to the lists note. Every column list is numbered titles
  only, and — because a pre-code column's obvious next move is to dispatch — **ends with a
  proactive one-line offer** (this is also the concrete anchor for Change 3):

  **Before:**
  ```
  feature_plan_20260711131500_fix-intern-column-hide-and-created-bucket-fallback.md
  Title: Fix: Kanban Columns Must Follow Ticked Agents…
  ID: 8a41b0ee-2901-42b5-8a07-47aea7f6361e
  ```
  **After:**
  ```
  PLAN REVIEWED (3):
  1. Fix: Kanban Columns Must Follow Ticked Agents — One Visibility Rule
  2. Fix Sidebar Scroll-to-Top on Plan Creation
  3. Add Edit Button to Kanban Meta Bar

  Want me to dispatch any of these to a coder? (say the number)
  ```

### Change 3 — Add a "Proactive, not eager" principle (issues 3 & 5)

**Where:** new short principle block near the top of `SKILL.md §2`, cross-referenced from a
lightly reworded Hard Rule 2.

State the distinction the skill currently lacks:
- **Proactive (DO):** end every turn by offering the single most natural next action as a
  one-line question. Listed a pre-code column → offer to dispatch. Dispatched a plan → offer
  to watch it to completion. Finished a watch → offer to send it to review. One offer, not a
  menu.
- **Eager (DON'T):** never *perform* the next step without an explicit yes; never chain
  multiple actions from one instruction; never auto-arm automation. "Default is never
  automation" (Hard Rule 2) governs *acting*, not *suggesting*.

This resolves the "went silent" defect without weakening the non-eager guarantee.

### Change 4 — Human dispatch confirmation; kill the async narration (issue 4)

**Where:** `SKILL.md §2` "Code → Dispatch a plan" bullet (lines 176–188).

- Add a **result-reporting template** that consumes the fields the response already
  returns — `topic` (title), `column` (where it landed), `dispatchedAgent` (the terminal),
  `routing` (why it landed there) — and never prints `moved`/`dispatched` booleans, the
  planId/sessionId, or a raw ISO timestamp:

  **Before:** (two messages)
  > I have triggered the dispatch request… running in the background… waiting for the API
  > server's response.
  > …Role: Coder / Session ID / Plan ID: 8a41b0ee-… / Moved: Yes / Dispatched: Yes (at
  > 2026-07-11T12:18:20Z)

  **After:** (one message)
  ```
  ✓ Dispatched "Fix: Kanban Columns Must Follow Ticked Agents" to CODER CODED —
    picked up by <dispatchedAgent> (routed there by complexity: 5–6 → coder).

  Want me to watch until it finishes? I'll tell you the moment it lands.
  ```
  If `dispatchedAgent` is null, say "no terminal picked it up yet" rather than inventing one.
- Add an explicit rule: **`POST /kanban/dispatch` (and every command verb) is a synchronous,
  fast curl — it returns when the work is recorded.** Do NOT narrate it as a background job,
  do NOT emit a "waiting for the API" pre-message, do NOT split it across two turns. Run it,
  then report the result once.

### Change 5 — Single-dispatch completion watch (issue 5)

**Where:** new subsection `§6b Single-Dispatch Watch (lightweight, session-scoped)`, invoked
by the Change-4 offer.

On "yes" after a single dispatch:
1. **Baseline:** capture the plan file's mtime at dispatch (`stat -f %m "$PLAN"`) — comparing
   epoch mtimes avoids parsing the ISO `dispatchedAt`.
2. **Poll** with the §6c signal and shell discipline: blocking sleep-loop chunks
   (`until [ "$(stat -f %m "$PLAN")" -gt "$BASE_MTIME" ]; do sleep 60; done`), ≤10 min per
   invocation, re-invoked until the mtime advances or the stuck threshold
   (`switchboard.activityLight.timeoutMs`, default 10 min) is hit.
3. **On completion (first mtime advance):**
   `✓ Done — "<title>" finished coding in <duration>, now in <column>. Send it to review?`
   (proactive next step per Change 3).
4. **On timeout:** report the stuck card; never re-dispatch, never move it backward.
5. **Boundary (hard):** this watch is session-scoped. It does **not** create/update
   `oversight-state.md`, does **not** append to `oversight-log.md`, and does **not** trip the
   §1 "resume the interrupted pass" prompt. Those belong to the §6/§7 multi-card passes and
   must stay separate so a single watch never looks like an interrupted pass.

## Non-goals

- **No LocalApiServer / code changes.** Every field is already in the responses. This is a
  prose-only edit to one skill.
- **No changes to the §6/§7 automation passes**, their state files, or their audit log.
- **No changes to sibling personas** (`switchboard-orchestrator`, `switchboard-chat`) — they
  share some habits but are explicitly out of scope this pass.
- **No confirm gates** anywhere (project rule).

## Verification Plan

### Automated Tests
- None — this is a prose-only edit to one skill file; no compiled code changes, nothing for
  the jest/harness suites to assert (session directive also skips test runs). Verification
  is by transcript replay below.

### Transcript replay (manual)
Re-run the transcript's three interactions against the edited skill and confirm:
1. Entry header shows only pre-CODE-REVIEWED columns by name + a humanized timestamp; no
   "terminal N", no ISO/ms.
2. `show me the plan reviewed plans` → numbered titles only (no UUIDs, no filenames) + a
   dispatch offer.
3. `advance the first plan to a coder` → one message naming the title, landing column, the
   terminal (`dispatchedAgent`), and the routing reason; no booleans/UUID/ISO; no
   "background/waiting" narration; ends with a watch offer. On "yes", the lightweight watch
   runs and reports completion + a review offer, writing no oversight state files.

## Metadata

**Complexity:** 3
**Tags:** docs, ux, refactor

## User Review Required
- None open — the two previously open calls (completion-watch trigger model; header column
  split) are already resolved under "Confirmed design decisions". The example wordings in
  Changes 1–4 are illustrative; the coder may adjust phrasing as long as each template's
  hard constraints (no UUIDs/filenames/ISO/booleans; one message; one offer) hold.

## Complexity Audit

### Routine
- Prose-only edits to a single file (`SKILL.md`); no compiled code, no API, no DB changes.
- Every field the new templates consume is already in the shipped responses (verified:
  `dispatchedAgent` in `LocalApiServer.ts:675` and `KanbanDatabase.ts:55`).
- All targeted line references verified against the current 524-line SKILL.md (2026-07-11).

### Complex / Risky
- Boundary discipline of the new §6b single-dispatch watch: it must NOT touch
  `oversight-state.md`/`oversight-log.md` or trip the §1 resume prompt — a leak here makes a
  one-off watch masquerade as an interrupted §6 pass.
- Rule-scope interactions: broadening Hard Rule 8 and adding "proactive, not eager" must not
  weaken Hard Rules 2/3 (never auto-act); the distinction lives entirely in prose.

## Edge-Case & Dependency Audit
- **Race Conditions:** none — no concurrent machinery added; the §6b watch is a single
  session-scoped sleep-loop over one plan file's mtime.
- **Security:** none — no new endpoints, no new data exposure; strictly less raw data
  (UUIDs/paths) shown to the user.
- **Side Effects:** entry-header format changes for every manage-console session (users used
  to the "terminal N" number lose it — intended); numbered plan lists become the only
  reference form, so the agent must keep an internal number→planId map per list it prints.
- **Dependencies & Conflicts:** feature-internal ordering with the four-front-doors refactor
  (this plan FIRST — see the sequencing note under Confirmed design decisions). No other
  plan touches this file.

## Dependencies
- Feature-internal: must land before `refactor-switchboard-four-front-doors.md` (that plan
  deletes this plan's target file after absorbing its body).

## Adversarial Synthesis
Key risks: (1) the §6b watch leaking into the §6/§7 oversight apparatus (state-file writes or
resume-prompt trips) — mitigated by the explicit hard boundary in Change 5; (2) "proactive"
drifting into "eager" over time — mitigated by anchoring the offer as a one-line question and
keeping Hard Rule 2 authority over *acting*; (3) stale line references if the sibling refactor
lands first — mitigated by the binding sequencing note and the 1:1 contingency mapping.
