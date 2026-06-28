# Add `/create-epic` Skill for Remote Agent Epic Creation

## Goal

Create a `.claude/skills/create-epic/SKILL.md` skill that teaches agents how to create epics from a remote session (where the Switchboard VS Code extension is not running and `create-epic.js` cannot be used). The skill should tell the agent how to write an epic file directly to `.switchboard/epics/`, in the correct format, so the extension picks it up via the GlobalPlanWatcherService when VS Code reconnects.

**Background:** `create-epic.js` routes through the running extension's LocalApiServer (`POST /kanban/epic`) and explicitly has no direct-DB fallback — it fails with a clear error if the extension is unreachable. This is by design for the local-VS Code case, but it means remote agents have no way to create epics today. The skill bridges this gap by teaching agents to write the file directly in the correct format.

**Key constraint:** The epic file embeds the `planId` UUID in the filename (e.g. `my-epic-{uuid}.md`) so the watcher can derive the plan_id on re-import and preserve subtask→epic links. A bare slug would mint a fresh random ID on re-import and orphan every subtask. The skill must enforce this.

## Metadata

**Complexity:** 3
**Tags:** cli, docs, infrastructure, reliability

## User Review Required

No — the change creates a single new skill file (`.claude/skills/create-epic/SKILL.md`) and registers it in `CLAUDE.md`. No source code, no data migration, no destructive operations. The only judgment call is whether the `## Metadata` section in the epic file template should be kept (it is optional — the extension writes complexity/tags to the DB directly, not via file metadata; see format correction below).

## Complexity Audit

### Routine
- Creating a single new `.claude/skills/create-epic/SKILL.md` file (documentation/instruction text).
- Adding one row to the skills table in `CLAUDE.md`.
- The `GlobalPlanWatcherService.ts` watcher **already watches `.switchboard/epics/`** — confirmed at line 369 (`'.switchboard/{plans,epics}/**/*.md'`), lines 193–215 (scan), lines 406–415 (native fs.watch), and lines 556–601 (UUID derivation + isEpic assertion). No extension code change needed.

### Complex / Risky
- **Epic file format correctness is critical.** The skill's entire purpose is to teach agents to write files the extension will import correctly. The original plan's format template was **wrong** (missing YAML frontmatter, wrong SUBTASKS marker string, non-canonical Metadata section) — corrected below. An agent following the original template would produce files that import but are inconsistent with extension-generated epics.
- **Subtask linking in remote sessions is a known dead end.** `assign-to-epic.js` routes through the extension (same architecture as `create-epic.js`). In a remote session, subtask linking cannot be done until VS Code reconnects. The skill must set this expectation clearly.

## Edge-Case & Dependency Audit

- **Race Conditions:** None for the skill file itself. For the direct-file-write epic: the watcher imports on next VS Code activation — no concurrent write risk (the file is written once by the agent, then read by the watcher later).
- **Security:** The skill teaches agents to generate a UUID via `node -e "..."`. This is safe — no credentials, no API calls. The epic file contains no secrets.
- **Side Effects:** A directly-written epic file with a UUID in the filename will be imported by the watcher with that UUID as the `plan_id` (line 556–564 of `GlobalPlanWatcherService.ts`). If the agent generates a non-UUID filename (e.g., bare slug), the watcher mints a fresh random ID — which is fine for a standalone epic but would orphan subtasks if subtask→epic links were later established by ID. The skill must enforce the UUID-in-filename convention.
- **Dependencies & Conflicts:** Depends on `expose-epics-folder-in-gitignore.md` being deployed so the `epics/` folder is git-tracked (otherwise the directly-written file is invisible to remote clones). No conflict with released features — the skill is purely additive.

## Dependencies

- `expose-epics-folder-in-gitignore.md` — adds `!.switchboard/epics/` to gitignore so epic files are committed. Without this, remote agents who write epic files have them ignored by git. Implement before or alongside this plan.
- No session-based (`sess_*`) dependencies.

## Adversarial Synthesis

Key risks: (1) the original plan's epic file format template was wrong — missing YAML frontmatter (`--- description: '...' ---`), wrong SUBTASKS marker (`<!-- BEGIN SUBTASKS -->` vs the extension's `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->`), and a non-canonical `## Metadata` section; (2) the plan's [VERIFY] section left the GlobalPlanWatcherService watcher as an open question, but code inspection confirms it already watches `epics/`; (3) subtask linking is impossible in remote sessions but the original plan's wording was ambiguous about this. Mitigations: corrected the format template to match `createEpicFromPlanIds` (line 8771) and `_regenerateEpicFile` (line 8648); marked the watcher verification as confirmed; clarified the subtask-linking dead end.

## Proposed Changes

### [CREATE] `.claude/skills/create-epic/SKILL.md`

The skill should cover the following, in order:

**1. When to use this skill**
- Agent is working in a remote session (no VS Code extension running)
- User asks to create a new epic (grouping plans together, or creating a standalone epic)
- Do NOT use this skill if the extension IS running — call `create-epic.js` instead (it's authoritative: does DB upsert, subtask linking, file write, and board refresh atomically)

**2. How to detect whether the extension is running**
- Check for `.switchboard/api-server-port.txt` in the workspace root
- If present and the health endpoint responds (`GET http://127.0.0.1:{port}/health`), the extension is live — use `create-epic.js`
- If absent or health check fails, proceed with direct file write

**3. Epic file format**

Epic files live in `.switchboard/epics/` and follow this structure:

```markdown
---
description: '{Epic Name}'
---

# {Epic Name}

## Goal

{Description of what this epic achieves and why it matters.}

## How the Subtasks Achieve This

{Narrative connecting the subtasks to the goal. Written once by the agent;
preserved by _regenerateEpicFile on subsequent subtask changes.}

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->
```

**⚠️ Format corrections (verified against source):** The original plan's template was wrong in three ways, now fixed:
1. **Missing YAML frontmatter** — the extension writes `---\ndescription: '{name}'\n---\n\n# {name}\n\n...` (see `createEpicFromPlanIds` at `KanbanProvider.ts` line 8771). The `description` field is quoted to prevent YAML breakage from names containing `:`, `---`, etc. The watcher extracts the topic from the H1 title (`planMetadataUtils.ts` line 76), so frontmatter is not strictly required for import — but it IS the canonical format and should be included for consistency.
2. **Wrong SUBTASKS marker** — the extension writes `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->` (see `_regenerateEpicFile` at `KanbanProvider.ts` line 8648), not `<!-- BEGIN SUBTASKS -->`. The regeneration search uses the prefix `<!-- BEGIN SUBTASKS` (line 8650), so the shorter marker would technically work — but use the full marker to match extension-generated files.
3. **`## Metadata` section removed from template** — the extension writes `complexity: 'Unknown'` and `tags: ''` directly to the DB (`createEpicFromPlanIds` lines 8741–8742), NOT via a `## Metadata` section in the file. Real epic files (verified: `memo-feature-reliability-*.md`, `linear-sync-channel-features-*.md`, `crt-animation-visual-theme-polish-*.md`) do NOT contain a Metadata section. The original plan's template included one — it is non-canonical. An optional `## Metadata` section MAY be added (the watcher will parse it if present), but it is not part of the extension-generated format.

The `<!-- BEGIN SUBTASKS ... -->` / `<!-- END SUBTASKS -->` block is managed by the extension. Write it with the `## Subtasks` heading and `- [ ] (no subtasks)` placeholder — the extension replaces this when subtasks are linked via `_regenerateEpicFile`.

**4. Filename convention**

```
{slug}-{planId}.md
```

- `slug`: lowercase, hyphens only, max 60 chars (e.g. `auth-refactor`)
- `planId`: a fresh UUID v4 (generate with `node -e "const {randomUUID}=require('crypto');console.log(randomUUID())"`)
- Full path: `.switchboard/epics/{slug}-{planId}.md`
- **Never omit the planId from the filename** — the watcher derives the plan_id from this trailing UUID on re-import.

**5. Linking existing plans as subtasks**

After writing the epic file, to link existing plans (identified by their `planId` from `kanban-board.md`):

```bash
node .agents/skills/kanban_operations/assign-to-epic.js "{epicPlanId}" '["subtaskPlanId1","subtaskPlanId2"]' "{workspaceRoot}"
```

This also routes through the extension; in a remote session it will fail and the agent should note that subtask linking will need to be done when VS Code is next opened, OR the user can drag-and-drop in the kanban UI.

**6. Sourcing existing suggest-epic content**

The kanban UI's "Suggest Epics" button generates a detailed prompt (see `_buildSuggestEpicsPrompt` in `KanbanProvider.ts`) that:
- Scans `kanban-board.md` for ungrouped plans in pre-coding columns
- Groups them by theme
- Proposes epic names and goals for user approval
- Then calls `create-epic.js`

The skill should reference this flow: if the user has not specified which plans to group, tell the agent to read `kanban-board.md`, propose groupings, get approval, then create the epic files.

**7. After writing**

- Commit the new file to git (the epics folder will be tracked once Plan `expose-epics-folder-in-gitignore.md` is deployed)
- Note to the user that the extension will automatically import the epic into the kanban DB on next activation via the GlobalPlanWatcherService

### [VERIFY] GlobalPlanWatcherService watches epics/ — ✅ CONFIRMED

**Verified against source (2026-06-28):** `GlobalPlanWatcherService.ts` **already watches `.switchboard/epics/`**. No additional task needed. Evidence:
- **Line 369:** VS Code watcher pattern: `'.switchboard/{plans,epics}/**/*.md'` — includes both `plans` and `epics` in a single glob.
- **Lines 193–215:** `_scanForNewFiles` scans both `plansDir` and `epicsDir`.
- **Lines 406–415:** Native `fs.watch` fallback checks both `plansDir` and `epicsDir`.
- **Lines 556–564:** UUID-from-filename derivation specifically for `relativePath.startsWith('.switchboard/epics/')` — matches both legacy `epic-<uuid>.md` and current `<slug>-<uuid>.md` schemes.
- **Lines 592–601, 638–647:** `isEpic=1` assertion and column re-derivation for epic files.
- **Lines 732, 757–758:** `triggerScan` also scans `epicsDir`.

The original plan's conditional wording ("If it doesn't, the plan needs an additional task") is resolved — no watcher change required.

## Verification Plan

> **Session directives:** Compilation and automated tests are skipped — the test suite will be run separately by the user.

### Automated Tests
- (Skipped per session directive.) No unit tests exist for skill file content; verification is manual.

### Manual Checks
1. ~~Read `GlobalPlanWatcherService.ts` to confirm `epics/` is watched~~ — **✅ Done (see [VERIFY] above).** No escalation needed.
2. In a remote session (or with extension stopped), run the skill manually: generate a UUID, write an epic file following the corrected format (with frontmatter, full SUBTASKS marker), confirm the file is valid markdown.
3. Open VS Code → confirm the epic appears in the kanban board (GlobalPlanWatcherService import). Verify the topic matches the H1 title and the `is_epic` flag is set.
4. Run the suggest-epics flow in the kanban UI → confirm it still works independently (this skill doesn't change the extension code).
5. Confirm the epic file format matches extension-generated epics (compare with an existing file in `.switchboard/epics/`).

## Success Criteria

1. `.claude/skills/create-epic/SKILL.md` exists with the corrected format (frontmatter + full SUBTASKS marker), filename convention, detection logic, and subtask-linking notes.
2. An agent following the skill can produce a valid epic file that the extension imports on activation with the correct topic and `is_epic=1`.
3. Skill is registered in the skills table in `CLAUDE.md`.

## Recommendation

**Complexity: 3 → Send to Intern.** The implementation is a single new skill file plus a CLAUDE.md table row. No code changes (the watcher already supports epics). The only risk is format accuracy — mitigated by the corrected template with explicit source-line citations. An intern can execute this by writing the skill file following the numbered sections in the plan.
