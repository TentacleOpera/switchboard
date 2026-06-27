# Rename /Sw → /sw, Unignore kanban-board.md, and Add Claude.ai Usage Docs

## Goal

Three related improvements for the claude.ai / Claude Code on the web experience:

1. **`/Sw` → `/sw` rename** — The `/Sw` alias was created on the assumption that mobile autocorrect would capitalize `/sw`. In practice, `/sw` is not a dictionary word so mobile does not autocorrect it. The uppercase `/Sw` is therefore the worse UX. Swap them: delete the `Sw` skill dir, create `sw`.

2. **Unignore `kanban-board.md`** — The file `.switchboard/kanban-board.md` is auto-exported by the extension on every kanban change and already referenced in the `query_switchboard_kanban` skill as the fast-path board state read. It is currently caught by the blanket `.switchboard/*` gitignore rule. Unignoring it lets cloud agents (Claude Code on the web, Jules, etc.) read current board state from the repo without needing sqlite3 access. Two places need updating: `WorkspaceExcludeService.ts` (the source for the setup.html gitignore template) and the repo's own `.gitignore`.

3. **Claude.ai docs** — Users have no discoverable docs explaining that `/sw`, `/improve-plan`, and other Switchboard workflows are available on claude.ai. Add a "Using Switchboard with claude.ai" section to the README and a full top-level section to the user manual. The key insight to communicate: `/sw` surfaces kanban state so users can then chain other workflows across multiple plans in one session.

### Problem Analysis & Root Cause

- **`/Sw` UX problem**: The uppercase alias was a preemptive workaround for a mobile autocorrect behavior that does not actually occur for the token `sw`. This means every mobile user who types `/sw` (the natural lowercase form) gets no match, and must deliberately type `/Sw` — the opposite of the intended UX improvement. Root cause: an unverified assumption about mobile keyboard behavior.
- **`kanban-board.md` visibility problem**: The blanket `.switchboard/*` gitignore rule (managed by `WorkspaceExcludeService.TARGETED_RULES`) excludes all `.switchboard/` contents by default, then re-includes specific files via negation. `kanban-board.md` was never added to the negation list, so cloud agents that read the repo (without sqlite3 access) cannot see board state. Root cause: the auto-export feature was added after the gitignore rules were designed, and the negation list was never updated to include the new file.
- **Docs gap problem**: The README and user manual document IDE chat commands (`/switchboard-chat`, `/improve-plan`, etc.) but never mention that these workflows are available on claude.ai (web). Users on mobile or browser-only sessions have no way to discover this capability. Root cause: claude.ai support was never explicitly documented.

## Metadata
**Complexity:** 3
**Tags:** docs, cli, feature, mobile

---

## User Review Required

Yes — before implementation, confirm:
1. The `/sw` lowercase alias is the desired final form (no retention of `/Sw` as a secondary alias).
2. Committing `kanban-board.md` (280KB auto-generated file) to git is acceptable despite per-board-change diffs.

---

## Complexity Audit

### Routine
- Adding one negation line to `TARGETED_RULES` array in `WorkspaceExcludeService.ts` (line 17 area)
- Adding the same negation line to the repo's `.gitignore` managed block (after line 80)
- Adding a `## Kanban State` section to two near-identical markdown files (workflow + skill)
- Updating Workflow Registry table rows in `AGENTS.md` and `CLAUDE.md` (identical edits)
- Adding a Skills table row to `AGENTS.md` and `CLAUDE.md`
- Adding a README section with pre-written markdown content
- Adding a user manual section with pre-written markdown content + TOC entry

### Complex / Risky
- Case-only directory rename `Sw` → `sw` on case-insensitive filesystems (macOS APFS default, Windows NTFS default) — requires two-step rename procedure to avoid silent no-op
- `git add` of a previously-ignored file (requires explicit staging after `.gitignore` negation is added)

---

## Edge-Case & Dependency Audit

**Race Conditions:**
- None. All changes are to static files (markdown, TypeScript constants, `.gitignore`). No runtime state mutations.

**Security:**
- `kanban-board.md` contains plan titles and file paths but no secrets, tokens, or credentials. Committing it does not expose sensitive data. The kanban database (`kanban.db`) remains excluded and is never committed.

**Side Effects:**
- **Git repo bloat**: `kanban-board.md` is ~280KB (current size). Every board change rewrites the entire file, creating a new diff in git history. On active boards this adds up, but markdown compresses well and board changes are not high-frequency (manual drags, not automated polling). Acceptable trade-off for cloud agent readability.
- **Dual `.gitignore` blocks**: This repo's `.gitignore` has a MANUAL block (lines 41-64) and a MANAGED block (lines 72-90), both containing `.switchboard/*`. The plan only adds the `kanban-board.md` negation to the managed block. Git's "last matching pattern wins" rule means the managed block's negation (at the bottom) takes effect. However, if a user later switches to `localExclude` strategy (which removes the managed block), the manual block's `.switchboard/*` will re-ignore `kanban-board.md` with no negation. This is a pre-existing inconsistency in the repo's `.gitignore`, not introduced by this plan — but worth noting.
- **Previously-ignored file staging**: After adding `!.switchboard/kanban-board.md` to `.gitignore`, the file remains untracked until explicitly `git add`ed. Git caches ignore rules; a simple `git add .switchboard/kanban-board.md` should work once the negation is in place, but `git add -f` may be needed if git has cached the previous ignore state.

**Dependencies & Conflicts:**
- No dependencies on other plans or sessions.
- The `WorkspaceExcludeService.ts` change affects ALL users on the `targetedGitignore` strategy — their managed block will include the new negation on next `apply()` call. Users on `localExclude`, `custom`, or `none` strategies are unaffected (they manage their own rules).
- No migration needed — `kanban-board.md` is an auto-generated runtime file; adding it to git tracking just means cloud sessions can now see it.

---

## Dependencies

None — this plan is self-contained.

---

## Adversarial Synthesis

Key risks: (1) case-only directory rename `Sw` → `sw` silently no-ops on case-insensitive filesystems without a two-step procedure, (2) the plan omits the `git add` step needed to stage a previously-ignored file, (3) CLAUDE.md's Skills table is missing the `switchboard-chat` row that AGENTS.md gets, creating an inconsistency the plan itself claims doesn't exist. Mitigations: document the two-step rename (`Sw` → `sw_tmp` → `sw`), add `git add .switchboard/kanban-board.md` as an explicit step, and add the Skills table row to both files.

---

## Proposed Changes

### 1. Rename `/Sw` → `/sw`

**Delete** `.claude/skills/Sw/SKILL.md` (and the `Sw/` directory).

**Create** `.claude/skills/sw/SKILL.md`:
```
This is an alias for the `switchboard-chat` skill. Immediately invoke it now using the Skill tool with skill name `switchboard-chat`.
```

No other files reference `/Sw` in the codebase (confirmed by grep + git log of commit `3eca70f`).

**Case-insensitive filesystem rename procedure** (macOS APFS default, Windows NTFS default):
On case-insensitive filesystems, `Sw` and `sw` are the same directory. A direct `git mv .claude/skills/Sw .claude/skills/sw` will silently no-op or error. Use a two-step rename:
```bash
git mv .claude/skills/Sw .claude/skills/sw_tmp
git mv .claude/skills/sw_tmp .claude/skills/sw
```
This forces git to recognize the case change through an intermediate name. Alternatively, `git mv -f .claude/skills/Sw .claude/skills/sw` may work depending on `core.ignorecase` setting, but the two-step method is more reliable across platforms.

---

### 2. Unignore `kanban-board.md`

**`src/services/WorkspaceExcludeService.ts`** — add one line to `TARGETED_RULES` (line 17) immediately after `'!.switchboard/SWITCHBOARD_PROTOCOL.md'`:
```
'!.switchboard/kanban-board.md',
```

**`.gitignore`** — add the same exclusion in the Switchboard managed block (after line 80, `!.switchboard/SWITCHBOARD_PROTOCOL.md`), before the blank line:
```
!.switchboard/kanban-board.md
```

**Stage the previously-ignored file** — after editing `.gitignore`, explicitly stage the file:
```bash
git add .switchboard/kanban-board.md
```
If git has cached the previous ignore state and refuses to add, use `git add -f .switchboard/kanban-board.md`.

---

### 3. Add kanban state section to both switchboard-chat skill files

Both files get an identical new `## Kanban State` section inserted after the `## Hard Rules` block (after line 17, before `## Process` on line 19).

**Files:**
- `.agents/workflows/switchboard-chat.md`
- `.claude/skills/switchboard-chat/SKILL.md`

**Content to add:**
```markdown
## Kanban State

When the user references plans, columns, or board state (e.g. "plans in the Created column", "what's in review", "show me the board"), read `.switchboard/kanban-board.md` before responding. This file is the auto-exported markdown snapshot of the full board, updated by the extension on every change. It is the fastest way to answer column-state questions without SQL.
```

---

### 4. AGENTS.md — two edits

**Workflow Registry table** (line 21) — extend the `/switchboard-chat` description to note `/sw`:
```
| `/switchboard-chat`, `/sw` | **`switchboard-chat.md`** | Activate chat consultation workflow. `/sw` is the short alias for claude.ai. (Avoid `/chat` — clashes with the native CLI reset command.) |
```

**Skills table** (after line 94, the `memo` row) — add a new row:
```
| `switchboard-chat` | Enter consultative planning mode on claude.ai — type `/sw` to activate. Reads kanban state so you can reference columns and chain workflows. |
```

---

### 5. CLAUDE.md — two edits

Same edits as AGENTS.md (the two files maintain identical tables):

**Workflow Registry table** (line 53) — same row update:
```
| `/switchboard-chat`, `/sw` | **`switchboard-chat.md`** | Activate chat consultation workflow. `/sw` is the short alias for claude.ai. (Avoid `/chat` — clashes with the native CLI reset command.) |
```

**Skills table** (after line 124, the `memo` row) — add the same new row:
```
| `switchboard-chat` | Enter consultative planning mode on claude.ai — type `/sw` to activate. Reads kanban state so you can reference columns and chain workflows. |
```

---

### 6. `README.md` — new section after "Getting Started"

Insert a new `## Using Switchboard with claude.ai` section after the Getting Started section (after the `---` separator on line 95, before `## The AUTOBAN` on line 97):

```markdown
## Using Switchboard with claude.ai

All Switchboard planning workflows are available directly in [claude.ai](https://claude.ai) — no VS Code required for the planning phase.

### Quick start

Type `/sw` in any claude.ai chat to enter Switchboard's consultative planning mode. The skill reads your committed `kanban-board.md` snapshot so you can reference your board by column name:

> "What's in the Created column?"
> "Review all plans in Backlog and tell me which ones have missing dependencies."

### Chaining workflows

Once you've identified plans with `/sw`, you can run other Switchboard workflows across them in the same session:

- **`/improve-plan`** — deep-plan with adversarial review. Ask Claude to run it on every plan in a given column at once, rather than one at a time.
- **`/memo`** — capture a burst of new ideas as plan stubs without interrupting your flow.

**Example:** Open claude.ai, type `/sw`, ask "show me everything in Created", then say "run `/improve-plan` on each of those" — Claude will work through all of them in one session.
```

---

### 7. `docs/switchboard_user_manual.md` — new top-level section + TOC entry

**Table of Contents** (after line 39, the entry for section 31) — add:
```
32. [Using Switchboard with claude.ai](#32-using-switchboard-with-claudeai)
```

**New section** — add at the end of the file (after line 1584, the last FAQ entry), titled `## 32. Using Switchboard with claude.ai`:

```markdown
## 32. Using Switchboard with claude.ai

Switchboard's planning workflows are not limited to VS Code. You can drive the planning phase — kanban triage, plan authoring, improvement runs — entirely from [claude.ai](https://claude.ai), with the extension running locally to execute the resulting plans.

### Prerequisites

- The Switchboard extension must be open in VS Code so that `kanban-board.md` stays up to date (it is written on every board change).
- `kanban-board.md` must not be gitignored (Switchboard manages this automatically from Setup → Git Ignore Strategy → `targetedGitignore`).

### Entering planning mode: `/sw`

Type `/sw` in any claude.ai chat. This loads the Switchboard Operator persona: a consultative planner that gathers requirements, challenges assumptions, and produces implementation plans — but does not write code until you approve a plan.

Once active, the skill reads `.switchboard/kanban-board.md` so you can address your board by column:

> "What's in the Created column?"
> "Which plans in Backlog have no complexity score?"
> "Summarise everything currently in Code Reviewed."

### Available workflows on claude.ai

All slash-command workflows work on claude.ai:

| Command | What it does |
|---------|--------------|
| `/sw` | Enter consultative planning mode (Switchboard Operator) |
| `/improve-plan` | Deep-plan a draft with dependency checks and adversarial review |
| `/memo` | Capture a burst of ideas as plan stubs — exits with `process memo` |
| `/accuracy` | High-accuracy mode with self-review for precision tasks |

### Chaining: triage then bulk-improve

The most powerful pattern is to chain `/sw` with `/improve-plan` across a whole column:

1. Type `/sw` and ask Claude to list everything in a column (e.g. "show me all Created plans").
2. Claude reads `kanban-board.md` and lists the plans with titles and file paths.
3. Say "run `/improve-plan` on each of those" — Claude works through all of them in the same session, one after another, producing improved plan files it commits back to `.switchboard/plans/`.

This lets you queue up a full planning sprint from your phone or a browser tab while the local extension handles execution.
```

---

## Implementation notes

- The `kanban-board.md` gitignore exclusion only matters for the `targetedGitignore` strategy. Users on `localExclude` or `custom` manage their own rules and are unaffected.
- No migration needed — `kanban-board.md` is an auto-generated runtime file; adding it to git tracking just means cloud sessions can now see it.
- The `/sw` rename is a case-only directory rename (`Sw` → `sw`). On case-insensitive filesystems (macOS APFS default, Windows NTFS default), use the two-step rename procedure described in section 1 above. The plan's original note about `sw` vs `switchboard-chat` being distinct directory names is correct but addresses the wrong collision — the real risk is `Sw` vs `sw` on case-insensitive filesystems.
- After adding the `.gitignore` negation, the file must be explicitly `git add`ed — git does not auto-track previously-ignored files when a negation rule is added.
- This repo's `.gitignore` has both a manual block (lines 41-64) and a managed block (lines 72-90) with `.switchboard/*`. Only the managed block is updated by this plan. Git's "last pattern wins" ensures the managed block's negation takes effect. If the managed block is later removed (strategy switch), the manual block will re-ignore `kanban-board.md` — this is a pre-existing inconsistency, not introduced by this plan.

---

## Verification Plan

### Automated Tests
- **SKIP**: Per session directive, automated tests (unit, integration, e2e) are not run as part of this plan. The test suite will be run separately by the user.
- **SKIP**: Per session directive, compilation (tsc, webpack) is not run. The project is assumed to be in a pre-compiled state.

### Manual Verification
1. **`/sw` rename**: Confirm `.claude/skills/sw/SKILL.md` exists with the alias content and `.claude/skills/Sw/` no longer exists. On macOS, verify `ls .claude/skills/ | grep -i sw` shows `sw` (not `Sw`).
2. **Gitignore exclusion**: Confirm `git check-ignore .switchboard/kanban-board.md` returns nothing (file is no longer ignored). Confirm `git status` shows `.switchboard/kanban-board.md` as a new tracked file after `git add`.
3. **WorkspaceExcludeService**: Confirm `TARGETED_RULES` array includes `'!.switchboard/kanban-board.md'` after the `SWITCHBOARD_PROTOCOL.md` line.
4. **Kanban State section**: Confirm both `.agents/workflows/switchboard-chat.md` and `.claude/skills/switchboard-chat/SKILL.md` have the `## Kanban State` section between `## Hard Rules` and `## Process`.
5. **AGENTS.md + CLAUDE.md**: Confirm both files have the updated Workflow Registry row (with `/sw`) and the new `switchboard-chat` Skills table row.
6. **README**: Confirm the "Using Switchboard with claude.ai" section appears between Getting Started and The AUTOBAN.
7. **User manual**: Confirm the new section 32 appears at the end and the TOC has a corresponding entry on line 40.

---

## Recommendation

Complexity is 3 → **Send to Intern**.

---

## Reviewer Pass (2026-06-28)

### Stage 1 — Adversarial Findings

| # | Finding | Severity | File:Line |
|---|---------|----------|-----------|
| 1 | ~~`sw/SKILL.md` has no YAML frontmatter — skill appears in registry with blank description~~ **FIXED** | NIT | `.claude/skills/sw/SKILL.md:1` |
| 2 | CLAUDE.md Skills table missing `notion_api` + `switchboard_remote_notion` rows that AGENTS.md has (pre-existing, out of scope) | NIT | `CLAUDE.md:122` (gap after `linear_api`) |

No CRITICAL or MAJOR findings.

### Stage 2 — Balanced Synthesis

All 7 proposed changes implemented correctly. No code fixes required. Both NITs are cosmetic/pre-existing and deferred.

- **Keep as-is:** All 7 changes (rename, gitignore exclusion, WorkspaceExcludeService, Kanban State section x2, AGENTS.md tables, CLAUDE.md tables, README section, user manual section+TOC).
- **Fix now:** Added YAML frontmatter to `sw/SKILL.md` (name + description) so the alias shows up in the skill registry with a proper description.
- **Defer:** Sync CLAUDE.md Skills table with AGENTS.md (`notion_api`, `switchboard_remote_notion` rows) — pre-existing gap, separate plan.

### Files Changed (Verified)

- `.claude/skills/sw/SKILL.md` — created (alias content + YAML frontmatter, renamed from `Sw/`)
- `.claude/skills/Sw/` — deleted (renamed to `sw/`)
- `src/services/WorkspaceExcludeService.ts:18` — added `'!.switchboard/kanban-board.md'` to TARGETED_RULES
- `.gitignore:81` — added `!.switchboard/kanban-board.md` to managed block
- `.switchboard/kanban-board.md` — now git-tracked (previously ignored)
- `.agents/workflows/switchboard-chat.md:18-20` — added `## Kanban State` section
- `.claude/skills/switchboard-chat/SKILL.md:19-21` — added `## Kanban State` section
- `AGENTS.md:21` — Workflow Registry row updated with `/sw`; `AGENTS.md:95` — new `switchboard-chat` Skills row
- `CLAUDE.md:53` — Workflow Registry row updated with `/sw`; `CLAUDE.md:125` — new `switchboard-chat` Skills row
- `README.md:96-114` — new "Using Switchboard with claude.ai" section
- `docs/switchboard_user_manual.md:40` — TOC entry 32; `docs/switchboard_user_manual.md:1587-1625` — section 32

### Validation Results

- `git check-ignore .switchboard/kanban-board.md` → exit 1 (not ignored) ✓
- `git ls-files .switchboard/kanban-board.md` → tracked ✓
- `git ls-files .claude/skills/sw/SKILL.md` → tracked as lowercase `sw` ✓
- No stale `/Sw` references in source files (only in this plan file + kanban-board.md plan title listing) ✓
- All markdown sections in correct locations ✓
- Compilation: SKIP (per session directive)
- Tests: SKIP (per session directive)

### Remaining Risks

1. **Git repo bloat** — `kanban-board.md` (~280KB, rewritten per board change) now commits diffs. Accepted trade-off per plan.
2. **Dual `.gitignore` blocks** — manual block (lines 41-64) lacks `kanban-board.md` negation; if managed block is removed via strategy switch, file re-ignores. Pre-existing, documented.
3. **`sw` skill discoverability** — ~~no frontmatter means blank description in skill registry~~ **FIXED** — frontmatter added with name + description.
