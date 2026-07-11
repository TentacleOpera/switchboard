---
description: "Speed up switchboard-manage startup: extend the board-action-driven kanban-board.md mirror with a pre-digested Manager Snapshot section (per-column plan/feature counts, ready-made board line, active project filter) so entry is one file read + /health instead of a multi-file awk pass."
---

# Faster Manage-Skill Startup: Manager Snapshot Section in kanban-board.md

## Goal

Make switchboard-manage entry near-instant by having the extension pre-digest the board
state the manager needs at startup into the **existing, already-kept-updated**
`.switchboard/kanban-board.md` mirror — a new `## Manager Snapshot` section written by the
same code path that writes the `kanban-state-*.md` files on every board action. The skill's
entry protocol then reads ONE small file (plus the unavoidable `/health` liveness call)
instead of running a multi-file awk counting pass and composing the summary itself.

This answers the memo's either/or directly: **no new `manager.md` file** — the info goes
into `kanban-board.md`, which is already (a) rewritten by every board action, (b) atomic
(temp-file + rename), (c) content-hash-gated against redundant writes, and (d) already read
at entry for its `Updated:` timestamp. A second manager file would duplicate the write
plumbing and add one more thing to keep consistent.

### Problem / root cause

The manage skill's entry protocol (`.agents/skills/switchboard-manage/SKILL.md` §1) does
real work on every invocation: walk to `$ROOT`, curl `/health`, then run an awk pass over
all ~15 `kanban-state-*.md` files to count plans vs features per column (feature rows carry
`planId:` too, so counting needs the ` feature -->` marker logic), then hand-format the
one-line board snapshot with pre-code/terminal grouping. The counting + formatting is
derivable at write time for free: `_writeLocalBoardMirror()` (`src/services/KanbanDatabase.ts:8052`)
already holds the full `allPlans` array (with `isFeature`, `featureId`, `kanbanColumn`,
`project`) when it writes the per-column files — it just throws the aggregate away. The
mirror is scheduled after **every DB persist** (`KanbanDatabase.ts:8280`), so a snapshot
written there is exactly as fresh as the state files themselves.

What can NOT go in the file: **live terminal registration**. It is in-memory extension
state with no disk representation (the skill explicitly forbids reading the dead
`state.json`); `/health`'s `terminals` field remains the only source, so the one network
call stays.

### Current state (verified in source, 2026-07-11)

- `_writeLocalBoardMirror()` (`KanbanDatabase.ts:8052-8170`): debounced
  (`_scheduleLocalMirror`, `:8043`), content-hash skip over serialized plan fields
  (`:8065-8079`), writes `kanban-state-<slug>.md` per column and a `kanban-board.md` index
  containing only `*Workspace / Updated*` + a column→file table (`:8147-8160`). Atomic
  temp+rename writes.
- Active project filter is DB-resident: `config` table key `kanban.activeProjectFilter`,
  read via `getConfigSync` (`KanbanDatabase.ts:1961`, `:3369`); filter changes are DB
  writes, so they trigger a persist → mirror schedule.
- Skill entry §1 step 3 (`SKILL.md:59-90`): the awk pass + formatting rules (pre-code
  columns named, post-code collapsed to `terminal N`, project-filter scope line).

## Metadata
- **Tags:** feature, performance, skill, backend, manager
- **Complexity:** 4

## Scope

### ✅ IN SCOPE
1. **`_writeLocalBoardMirror()`**: after the per-column loop, compute per-column
   `{plans, features}` counts from `allPlans` and read
   `getConfigSync('kanban.activeProjectFilter')`; append to `kanban-board.md`:
   - a `## Manager Snapshot` section with a machine-parseable counts table
     (`| Column | Plans | Features |`, canonical uppercase column IDs),
   - a ready-made one-line board summary in the skill's format
     (`Board: CREATED 6 · PLAN REVIEWED 3 · BACKLOG 31 · terminal 1143.`) using the same
     pre-code/terminal grouping the skill defines today (post-code set: CODED, LEAD CODED,
     CODER CODED, INTERN CODED, CODE REVIEWED, ACCEPTANCE TESTED, COMPLETED; unrecognized
     custom columns named explicitly),
   - `Active project filter: <name>` or `Active project filter: (none)`,
   - a one-line provenance note: `Terminals are NOT in this file — check GET /health.`
2. **Content-hash input**: fold the active project filter value into the `serialized` hash
   payload (`:8065`) — otherwise a filter-only change skips the rewrite and the snapshot
   goes stale.
3. **Skill entry §1 step 3 (both copies + mirror)**: replace the awk pass with — read
   `## Manager Snapshot` from `$ROOT/.switchboard/kanban-board.md` (one command); use its
   pre-formatted board line and filter scope verbatim. **Fallback:** if the section is
   missing (older extension build), run the existing awk pass unchanged — keep the full
   awk block in the skill under a "fallback" heading. Steps 2 (/health) and 4 (setup-gap
   `ls plans` + constitution check) are unchanged — they are single cheap commands and
   terminals are /health-only by design.

### ⚙️ OUT OF SCOPE
- A separate `manager.md` file (rejected — duplicates write plumbing; see Goal).
- Putting terminal-registration state on disk (in-memory only; /health is authoritative).
- Feature name lists or plan titles in the snapshot (entry protocol forbids listing them;
  the per-column state files already carry titles for when the user asks).
- Changing the debounce, hash-skip, or atomic-write mechanics of the mirror.
- The backup JSON / board-snapshot-publisher paths (`:8281-8285`) — untouched.

## Complexity Audit
### Routine
- Aggregation loop over `allPlans` (the per-column map already exists in the function).
- Markdown section append; skill prose edit + copy sync.
### Complex / Risky
- **Hash-input change:** adding the filter to `serialized` changes `_localMirrorLastHash`
  semantics; first write after upgrade always fires (hash mismatch) — harmless, but verify
  no write loop (hash must be computed from the same inputs each pass).
- **Grouping drift:** the pre-code/terminal grouping now lives in TWO places (writer +
  skill fallback). Mitigate: the skill's primary path consumes the writer's line verbatim
  (no re-derivation), and the fallback block is explicitly labeled as the legacy path for
  older builds — drift only matters when the fallback runs.
- **Column-ID casing:** the snapshot table must use canonical uppercase IDs (`LEAD CODED`),
  never slugs — API calls built from it would otherwise strand cards (known slug hazard).
- **Custom columns:** must appear in the counts table and be named in the board line, not
  silently folded into `terminal`.

## Edge-Case & Dependency Audit
- **Staleness window:** the mirror is debounced (~`LOCAL_MIRROR_DEBOUNCE_MS`) after a
  persist; the snapshot can lag a just-made move by the debounce interval — same freshness
  contract as the state files the skill reads today, and the `Updated:` timestamp already
  makes staleness explicit. No new race.
- **Concurrent writers:** `_localMirrorInFlight`/`_localMirrorPending` serialization is
  reused as-is; the snapshot is part of the same single `kanban-board.md` write, so it can
  never be torn relative to the column table (one temp+rename).
- **Multi-workspace:** `_resolveExportRoot()` scopes the file per export root exactly like
  the state files; sub-workspace boards get their own snapshot.
- **Empty board / fresh install:** counts table renders with zeros; board line reads
  `Board: (empty)` — the skill's setup-gap nudge (step 4) still comes from its own checks.
- **Filter set to a project with zero plans:** snapshot shows the filter name and zeroed
  counts — correct, and the scope line tells the manager why.
- **Older extension + new skill:** fallback awk path covers it (Scope #3). New extension +
  older skill: extra section is ignored — additive, non-breaking.
- **Dependencies:** none on other plans. No verb/endpoint changes → no catalog regen. The
  `switchboard-orchestration` skill and orchestrator persona read the state files, not the
  index sections — unaffected.

## Proposed Changes
### src/services/KanbanDatabase.ts
In `_writeLocalBoardMirror()`:

```ts
// (1) fold the filter into the content hash (near :8065)
const activeFilter = String(this.getConfigSync('kanban.activeProjectFilter') || '');
const serialized = JSON.stringify({
    activeFilter,
    allPlans: allPlans.map(p => ({ /* existing fields unchanged */ }))
});

// (2) after the column→file table loop (near :8152), append the snapshot
md += `\n## Manager Snapshot\n\n`;
md += `| Column | Plans | Features |\n|---|---|---|\n`;
const POST_CODE = new Set(['CODED', 'LEAD CODED', 'CODER CODED', 'INTERN CODED',
    'CODE REVIEWED', 'ACCEPTANCE TESTED', 'COMPLETED']);
let terminalTotal = 0;
const preCodeParts: string[] = [];
for (const [col, plans] of allColumns) {
    const feats = plans.filter(p => p.isFeature).length;
    const plain = plans.length - feats;
    md += `| ${col} | ${plain} | ${feats} |\n`;
    if (POST_CODE.has(col)) { terminalTotal += plain; }
    else if (plain > 0 || feats > 0) { preCodeParts.push(`${col} ${plain}`); }
}
const boardLine = preCodeParts.length === 0 && terminalTotal === 0
    ? 'Board: (empty)'
    : `Board: ${[...preCodeParts, `terminal ${terminalTotal}`].join(' · ')}.`;
md += `\n${boardLine}\n`;
md += `\nActive project filter: ${activeFilter || '(none)'}\n`;
md += `\n_Terminals are NOT in this file — check GET /health._\n`;
```

(Exact placement: build the snapshot before the existing temp+rename write of
`kanban-board.md` so it ships in the same atomic write.)

### .agents/skills/switchboard-manage/SKILL.md (+ .claude copy)
§1 step 3 becomes: primary path = one read of the `## Manager Snapshot` section
(`sed -n '/## Manager Snapshot/,$p' "$ROOT/.switchboard/kanban-board.md"`), report its
board line + filter scope + the file's `Updated:` timestamp verbatim; fallback = the
existing awk pass, kept under a **"Fallback (no Manager Snapshot section — older
extension)"** label. Step 3's shell-discipline callout stays with the fallback.

## Verification Plan
### Automated
- `npm run mirror:check` green (skill copies in sync); `catalog:check` / `parity:check`
  unchanged (no verbs).
### Manual / behavioral
- Move any card → within the debounce window `kanban-board.md` gains/refreshes
  `## Manager Snapshot`; table counts match an independent awk pass over the state files.
- Change the active project filter (no card moves) → snapshot rewrites with the new filter
  (hash-input regression check).
- Create a custom column with one plan → it appears in the table and by name in the board
  line, not inside `terminal N`.
- Fresh manage-skill invocation → entry report comes from the snapshot (one file read +
  /health), matches the board, and is visibly faster; delete the section manually →
  fallback awk path produces the same numbers.
- Feature rows counted under Features, never Plans (compare against a column containing a
  feature card).

---
**Recommendation:** Complexity 4 → Send to Coder.
