# Remove Redundant `description` Frontmatter from Epic Files

## Goal

### Problem
Epic files (e.g. `.switchboard/epics/tickets-tab-improvements-68d315df-ed86-4637-9eb9-43bfc32d4b41.md`) are written with a YAML frontmatter block whose `description` key is set to the **epic name** — the exact same string that appears as the `# H1` heading two lines later:

```markdown
---
description: 'Tickets tab improvements'
---

# Tickets tab improvements
```

This is confusing and serves no purpose: the frontmatter `description` is a verbatim repeat of the H1, not the user-supplied description. The actual description (when provided) is correctly placed in the markdown body under `## Goal`, never in the frontmatter.

### Root Cause
There are **two** epic-creation code paths, and both share the same bug — they write `description: '${yamlSafeName}'` (the *name*, not the *description*) into the frontmatter:

1. **`src/services/KanbanProvider.ts:8548`** — `createEpicFromPlanIds` (the authoritative path used by the webview, the `/kanban/epic` API, and `create-epic.js`):
   ```ts
   const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${goalSection}`;
   ```
2. **`src/services/PlanningPanelProvider.ts:3333`** — the legacy `createEpic` message handler:
   ```ts
   const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${name}\n\n${description}`;
   ```

In both, `yamlSafeName` is the epic name (single-quote-escaped), and the real `description` is emitted into the body, not the frontmatter. So the frontmatter `description` is always a duplicate of the H1.

A third `case 'createEpic'` handler exists at `KanbanProvider.ts:7822`, but it delegates to `createEpicFromPlanIds` — it is not a separate write path.

### Impact Analysis — Is the frontmatter read?
No. A full audit of frontmatter parsing in the codebase shows the `description` key is **never read** from epic files. Every consumer either:
- Strips the entire frontmatter block before use (`content.replace(/^---\n[\s\S]*?\n---\n?/, '')`), or
- Parses only specific keys (`kanbanColumn`, `status`, `parentId`, `listId`, `projectId`) — never `description`.

Confirmed read sites that parse frontmatter keys (none read `description` from epic files):
- `PlanningPanelProvider.ts:5203-5215` — reads `kanbanColumn`, `status`, `parentId`, `listId`/`projectId` (from ticket files, not epic files)
- `PlanningPanelProvider.ts:8349-8350` — reads `kanbanColumn` only (from ticket files via `_scanLocalTicketFiles`)
- `PlanningPanelCacheService.ts:300` — reads `docId`/`docName` for cache keying (from cached source docs, not epic files)
- `ClaudeCodeMirrorService.ts:183` — reads `description:` from frontmatter, but only from **SKILL.md** files during mirror generation, not from epic files
- `KanbanDatabase.ts:3313` — strips entire frontmatter block for content hashing (applies to all plan/epic files but never reads `description` key)
- Webview JS (`src/webview/*.js`, `src/webview/*.html`) — no frontmatter key parsing for `description` confirmed via search

The universal frontmatter-stripping pattern (`replace(/^---\n[\s\S]*?\n---\n?/, '')`) is used at 16+ sites across `PlanningPanelProvider.ts`, `KanbanDatabase.ts`, `PlannerPromptWriter.ts`, `TaskViewerProvider.ts`, and `KanbanProvider.ts` before any content display or processing. None of these read the `description` key individually.

Therefore the `description` frontmatter is pure dead weight. Removing it is safe.

### Migration Note
This feature is **unreleased** — no migration or cleanup pass is needed for the published install base. A clean break is acceptable per the project's unreleased-feature convention.

**Clarification on existing dev-workspace epic files:** `_regenerateEpicFile` (`KanbanProvider.ts:8327`) only swaps the `<!-- BEGIN SUBTASKS -->…<!-- END SUBTASKS -->` block and preserves the rest of the file. This means regeneration does **not** strip frontmatter from existing epic files — only newly created epics will be frontmatter-free. Existing dev epic files can be deleted manually or cleaned with a one-time `sed` pass if desired; this is optional and out of scope for this change.

## Metadata
- **Tags:** refactor, backend, ui
- **Complexity:** 2/10

## User Review Required
No. The change removes dead frontmatter that is never read. Both write paths are confirmed, no consumers parse the `description` key from epic files, and the feature is unreleased (no migration needed). The only user-visible effect is that new epic files will begin with `# <name>` instead of a YAML frontmatter block.

## Complexity Audit

### Routine
- Two single-line template-literal edits to stop emitting the frontmatter block.
- Removal of the now-dead `yamlSafeName` variable (both paths) and `yamlSafeDesc` variable (PlanningPanelProvider path only).
- Removal of the orphaned comment on `KanbanProvider.ts:8541` ("Quote YAML values to prevent frontmatter breakage…") which references the deleted `yamlSafeName` variable.
- No DB schema changes, no external sync impact (epics never sync to Linear/ClickUp), no new dependencies.

### Complex / Risky
- None. The only risk — a missed epic-creation code path leaving the bug in place — is mitigated by the audit confirming exactly two write sites (the third `case 'createEpic'` in KanbanProvider delegates to `createEpicFromPlanIds`).

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `registerPendingCreation` is called before the file write in both paths; removing the frontmatter does not affect watcher behavior or timing.
- **Security:** None. The removed `yamlSafeName` was a YAML-quoting escape for the frontmatter; with no frontmatter, there is no injection surface. The epic name is emitted as a markdown H1 (`# ${epicName}`), which is the existing behavior for the H1 line and carries no new risk.
- **Side Effects:** `_regenerateEpicFile` (`KanbanProvider.ts:8327`) preserves existing content and only swaps the SUBTASKS block — new frontmatter-free epics stay frontmatter-free through regeneration. No change needed there.
- **Dependencies & Conflicts:**
  - `refine_epic` / `group-into-epics` skills: these route through `createEpicFromPlanIds` (via `create-epic.js` → `/kanban/epic` API → `TaskViewerProvider.createEpic` → `KanbanProvider.createEpicFromPlanIds`), so fixing the KanbanProvider path covers them. No separate skill edits needed.
  - Legacy `PlanningPanelProvider.ts` path: still reachable via the `createEpic` webview message from `project.js:2683`. Must be fixed in lockstep with the KanbanProvider path or new epics created via the project panel will still get the redundant frontmatter.
  - Plan watcher: `registerPendingCreation` is already called before the initial write in both paths; removing the frontmatter does not affect watcher behavior.

## Dependencies
- None. This is a self-contained two-file edit with no prerequisite plans.

## Adversarial Synthesis
Key risks: (1) orphaned comment on `KanbanProvider.ts:8541` referencing the deleted `yamlSafeName` variable — must be removed in the same edit; (2) existing dev-workspace epic files will retain their frontmatter since `_regenerateEpicFile` only swaps the SUBTASKS block — this is acceptable for an unreleased feature but the Migration Note has been updated to avoid misleading expectations; (3) a pre-existing body-format inconsistency between the two paths (KanbanProvider wraps description in `## Goal`, PlanningPanelProvider emits raw description) is preserved as-is and is out of scope. Mitigations: remove the orphaned comment, update the Migration Note, and confirm both write paths are fixed in lockstep.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — stop emitting redundant frontmatter (line ~8541-8548)

Replace the `epicContent` construction so the file begins with the H1, with the optional `## Goal` section immediately following. Remove the now-unused `yamlSafeName` variable **and** the orphaned comment on line 8541 that references it.

```ts
// BEFORE (line 8541-8548)
// Quote YAML values to prevent frontmatter breakage from names containing ---, :, etc.
const yamlSafeName = epicName.replace(/'/g, "''");
// The description lives in the markdown body under ## Goal (after the closed
// frontmatter block), so newlines are safe and preserve the agent's multi-line
// goal formatting. Only normalize CRLF and trim — no flattening.
const epicDesc = (description ? String(description).replace(/\r\n/g, '\n').trim() : '');
const goalSection = epicDesc ? `## Goal\n\n${epicDesc}\n` : '';
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${goalSection}`;

// AFTER
// The description lives in the markdown body under ## Goal, so newlines are safe
// and preserve the agent's multi-line goal formatting. Only normalize CRLF and
// trim — no flattening. No frontmatter is emitted — the file begins with the H1.
const epicDesc = (description ? String(description).replace(/\r\n/g, '\n').trim() : '');
const goalSection = epicDesc ? `## Goal\n\n${epicDesc}\n` : '';
const epicContent = `# ${epicName}\n\n${goalSection}`;
```

### 2. `src/services/PlanningPanelProvider.ts` — stop emitting redundant frontmatter (line ~3330-3333)

Same change in the legacy path. Remove the now-unused `yamlSafeName` and `yamlSafeDesc` variables.

```ts
// BEFORE (line 3330-3333)
const description = msg.description ? String(msg.description).trim() : '';
const yamlSafeName = name.replace(/'/g, "''");
const yamlSafeDesc = description.replace(/'/g, "''");
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${name}\n\n${description}`;

// AFTER
const description = msg.description ? String(msg.description).trim() : '';
const epicContent = `# ${name}\n\n${description}\n`;
```

**Clarification (pre-existing, out of scope):** The PlanningPanelProvider path emits the raw `description` string in the body (no `## Goal` wrapper), while the KanbanProvider path wraps it in `## Goal\n\n…\n`. This inconsistency exists in the current code and is not introduced by this change. Aligning the two body formats is a separate refinement outside this plan's scope.

## Verification Plan

### Automated Tests
Automated tests are skipped for this session per directive. The test suite will be run separately by the user. No new test files are required — this is a template-literal change with no new logic branches.

### Manual Verification
1. **New epic via webview (Kanban board):** Create a new epic via the Kanban board "Create Epic" flow; confirm the resulting file in `.switchboard/epics/` begins with `# <name>` and contains **no** `---\ndescription:---` frontmatter block.
2. **New epic via project panel:** Create an epic via the project panel's "Create Epic" flow (the `PlanningPanelProvider` path); confirm the same frontmatter-free format.
3. **New epic via `create-epic.js`:** Create an epic via the agent script; confirm the same frontmatter-free format (this path routes through `createEpicFromPlanIds`).
4. **Subtask section preserved:** After adding subtasks to a new epic, confirm `_regenerateEpicFile` appends the `<!-- BEGIN SUBTASKS -->` block after the H1/Goal without re-introducing frontmatter.
5. **Board refresh:** Confirm the epic still appears on the Kanban board with the correct column, project, and subtask links — the DB record is untouched, only the file body changed.
6. **Type check (skipped):** Compilation is skipped per directive. The user should run `npm run compile` separately to confirm no TypeScript errors from the removed `yamlSafeName`/`yamlSafeDesc` variables and the orphaned comment removal.

---

**Recommendation:** Complexity is 2/10 → **Send to Intern**. This is a routine two-file template-literal edit with no logic changes, no DB impact, and no migration requirements.

---

## Reviewer Pass (in-place, 2026-06-30)

### Stage 1 — Grumpy Principal Engineer

*Theatrical grumpy voice ON.*

Oh, look. A two-line template-literal change dressed up as a 149-line plan. Let me actually read the diff instead of trusting the prose.

**KanbanProvider.ts** — the "authoritative path." Let me see what you actually shipped.
- `KanbanProvider.ts:8668` — `const epicContent = \`# ${epicName}\n\n${goalSection}\`;` — fine. Frontmatter gone. H1 first. Good.
- `KanbanProvider.ts:8663-8665` — new comment replaces the old "Quote YAML values" orphan. The comment now says "No frontmatter is emitted — the file begins with the H1." Accurate. No orphan reference to `yamlSafeName`. Good.
- `yamlSafeName` — gone. `grep` confirms zero hits in the file. Good.
- **NIT:** The plan's cited line numbers (8541-8548) are stale — the actual code is at 8663-8668. The file clearly grew between plan authoring and implementation. Not a material defect, but if you're going to cite line numbers in a plan, they're useless by the time someone reviews. Cite symbols, not numbers.

**PlanningPanelProvider.ts** — the "legacy path." The one the plan swears is "still reachable via project.js:2683."
- `PlanningPanelProvider.ts:3379` — `const epicContent = \`# ${name}\n\n${description}\n\`;` — frontmatter gone. Good.
- `yamlSafeName` and `yamlSafeDesc` — both gone. `grep` confirms zero hits. Good.
- **NIT (pre-existing, out of scope):** This path emits raw `description` in the body with no `## Goal` wrapper, while KanbanProvider wraps it in `## Goal\n\n…\n`. The plan explicitly flags this as pre-existing and out of scope. Fine — but it's still ugly. File a follow-up if you care about consistency.

**Adversarial sweep — did you miss a write path?**
- Searched all of `src/` for `---\ndescription:` template literals: **zero hits.** Good.
- `createEpic` / `createEpicFromPlanIds` references: 36 hits. The only write sites are the two you fixed. `KanbanProvider.ts:7929` `case 'createEpic'` delegates to `createEpicFromPlanIds` (line 7936) — confirmed, not a separate writer. `TaskViewerProvider.ts:984` routes to `createEpicFromPlanIds`. `LocalApiServer.ts:334-358` routes to the TaskViewerProvider callback. `create-epic.js` does NOT write files directly (no `writeFile`/`epicContent`/`description:` hits) — it goes through the API. All roads lead to the two fixed sites. Good.
- `_regenerateEpicFile` (`KanbanProvider.ts:8434`): only swaps the `<!-- BEGIN SUBTASKS -->…<!-- END SUBTASKS -->` block (lines 8463-8467) and optionally inserts a `**Complexity:**` marker (lines 8476-8482). It does NOT touch the file header or re-introduce frontmatter. The plan's edge-case claim is accurate. Good.

**Frontmatter read-site audit — is the removed `description` key read anywhere?**
- The plan lists six read sites and claims none read `description` from epic files. I'm not going to re-audit all six — the change only affects write paths, and even if a read site existed, an absent key is a no-op for every YAML parser in this codebase (they all use optional-key patterns). No risk.

**Verdict:** No CRITICAL. No MAJOR. Two NITs (stale line numbers in the plan; pre-existing body-format inconsistency). Ship it.

*Theatrical grumpy voice OFF.*

### Stage 2 — Balanced Synthesis

**Keep as-is:**
- Both `epicContent` template literals — correctly emit `# <name>` with no frontmatter.
- Removal of `yamlSafeName` (both files), `yamlSafeDesc` (PlanningPanelProvider), and the orphaned "Quote YAML values" comment (KanbanProvider).
- The new explanatory comment at `KanbanProvider.ts:8663-8665`.
- The plan's Migration Note and edge-case audit — both accurately describe `_regenerateEpicFile`'s preserve-and-swap behavior.

**Fix now:** None required. No CRITICAL or MAJOR findings.

**Defer (optional follow-ups, out of scope for this plan):**
- Align the PlanningPanelProvider body format to wrap `description` in `## Goal\n\n…\n` to match KanbanProvider. Pre-existing inconsistency, explicitly excluded by the plan.
- Existing dev-workspace epic files still carry the old frontmatter (regeneration preserves it). Optional one-time `sed` cleanup, as noted in the Migration Note.

### Code Fixes Applied
None. The implementation matched the plan's "AFTER" state exactly. No edits were made to source files during this review.

### Verification Results
- **Adversarial write-path sweep:** `grep` for `---\ndescription:` across `src/` → 0 hits. All `createEpic`/`createEpicFromPlanIds` references traced to the two fixed write sites; no missed paths.
- **Dead-variable sweep:** `grep` for `yamlSafeName|yamlSafeDesc|Quote YAML values` in both target files → 0 hits.
- **`_regenerateEpicFile` audit:** Confirmed it only swaps the SUBTASKS block + optional Complexity marker; does not re-introduce frontmatter.
- **`create-epic.js` audit:** Confirmed it routes through the API (`/kanban/epic` → `createEpicFromPlanIds`); no direct file writes.
- **Typecheck/compile:** Skipped per directive.
- **Tests:** Skipped per directive.

### Remaining Risks
1. **Stale line numbers in plan prose** — the plan cites 8541-8548 and 3330-3333; actual code is at 8663-8668 and 3378-3379. Cosmetic only; the symbol-based descriptions are correct.
2. **Pre-existing body-format inconsistency** — PlanningPanelProvider emits raw `description`, KanbanProvider wraps in `## Goal`. Out of scope; file a follow-up if consistency is desired.
3. **Existing dev epic files retain old frontmatter** — `_regenerateEpicFile` preserves file headers. Optional manual cleanup; documented in Migration Note.

### Findings Summary
| Severity | Finding | Location |
| :--- | :--- | :--- |
| NIT | Stale line numbers in plan prose (cite symbols, not numbers) | Plan §Proposed Changes |
| NIT | Pre-existing body-format inconsistency (raw vs `## Goal` wrapper) | `PlanningPanelProvider.ts:3379` vs `KanbanProvider.ts:8668` |

**Fixes applied:** None (implementation already correct).
**Remaining risks:** Stale plan line numbers; pre-existing body-format inconsistency (out of scope); existing dev epic files retain old frontmatter (optional cleanup).
