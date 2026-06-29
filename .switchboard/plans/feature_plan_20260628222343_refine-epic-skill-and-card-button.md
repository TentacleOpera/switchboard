# Refine Epic Skill & Epics-Tab Button

## Metadata
- **Tags:** frontend, backend, ui, feature, docs
- **Complexity:** 4/10

## Goal

Give the user a one-click way to turn a thin or empty epic into a well-described, decomposable epic. Add a **"Refine"** button to the **Epics tab meta bar** in the Project panel (`project.html` / `project.js`, served by `PlanningPanelProvider`) — beside the existing **Orchestrate** button — that copies a skill-file-driven prompt to the clipboard. The user pastes it into any agent; the agent reads the epic's existing markdown file, determines what's missing, and writes back a complete epic description — a clear Goal/problem statement, success criteria, scope, and a **proposed subtask breakdown** — preserving existing content. This mirrors the proven `refine_ticket` pattern, but targets epics and lives in the Epics tab rather than on the board cards.

### Problem Analysis

The memo question was: *"if I link an empty epic card on the kanban board to an agent, is there a skill that tells the agent how to improve the epic description? if not, how could this be implemented?"*

**Answer: No such skill exists today.** Investigation confirmed the gap:

1. **The only "refine" mechanism is `refine_ticket`, and it does NOT apply to epics.** `refine_ticket` is wired exclusively to the **tickets tab** (Linear/ClickUp issues): skill source `.agents/skills/refine_ticket.md`; "Refine" buttons in `planning.js` (`data-refine-ticket-id`); handler `copyRefinePrompt` in `PlanningPanelProvider.ts:5208`, which reads `refine_ticket.md` and resolves the local file via `_findTicketFilePath` (a `.switchboard/tickets/<provider>/` ticket-id pattern). There is no equivalent for epics, no `refine_epic.md`, and no epic refine handler.

2. **Linking an empty epic to an agent gives zero "improve the description" guidance.** Clicking **Orchestrate** (on a board card, `kanban.html:5281`, or in the Epics tab meta bar, `project.js:1803/1821`) calls `buildEpicOrchestrationPrompt` (`KanbanProvider.ts:3112`). For an empty epic, `db.getSubtasksByEpicId` returns 0 rows, and the prompt is prefixed with `EPIC_ORCHESTRATION_DIRECTIVE` → *"EPIC MODE: You are implementing the epic 'X' which consists of **0 subtask(s)**…"*. The agent is pointed at a near-empty file (`createEpicFromPlanIds` at `KanbanProvider.ts:8699` omits the `## Goal` section entirely when no description is supplied) and told to **execute it anyway** — never to flesh it out or decompose it first.

### Root Cause

The epic feature shipped an **execution** path (Orchestrate → orchestration prompt) but never a **specification** path (improve/decompose the epic before execution). `refine_ticket` solved the analogous problem for tickets but was scoped to a different webview (`planning.js` tickets tab) and a ticket-shaped file resolver, so it never generalized to epics.

### Placement decision

The board's epic **cards are already crowded** (`kanban.html:5408-5425` packs Pair / primary action / backlog / Orchestrate / review / complete into one card). The button therefore goes in the **Epics tab meta bar** (`renderEpicMetaBar`, `project.js:1794`), inside the existing manage group beside **Orchestrate**, **+ Subtask**, and **Delete Epic** (`project.js:1801-1807`). That bar renders for the currently-selected epic, so a single `Refine` button serves every epic with no per-card real-estate cost. **No change is made to `kanban.html`.**

### Composes with the standalone-epic removal plan

This plan assumes the world after `feature_plan_20260629083123_remove-standalone-epics.md`: **standalone epic documents no longer exist** — the Epics tab shows DB-backed epics only, and that plan collapses `isManageable = !plan.isEpicDocument` to a plain null-check (`isManageable = !!plan`). Every selected epic is therefore manageable, so placing Refine **inside the manage group** (gated by `isManageable`, exactly like Orchestrate) makes it render for every epic with no special-casing. The earlier "Refine must apply to standalone epics" requirement is moot — there are no standalone epics. Sequencing is forgiving: if this plan lands *before* the removal, Refine simply won't appear on the soon-to-be-removed standalone docs, which is harmless.

## User Review Required
- [ ] Confirm that `_epicSelectedPlan` carries `topic` and `subtaskCount` properties. Code verification shows these are NOT accessed via `_epicSelectedPlan.topic` or `_epicSelectedPlan.subtaskCount` anywhere in the existing code. The plan object likely has `topic` (standard field), but `subtaskCount` may not be populated. If `subtaskCount` is unavailable, the handler should default to `0` (which it already does via `|| 0`).

## Decision (no open product questions)

- **Approach: a dedicated `refine_epic` skill + a "Refine" button in the Epics-tab meta bar** — the direct analog of `refine_ticket`. Preferred over auto-injecting refine guidance into the orchestration prompt (see Rejected Alternatives) because it keeps "specify the epic" and "execute the epic" as two distinct, user-controlled steps.
- **The skill writes back to the epic markdown file only. It creates no subtask cards and touches no DB rows.** Subtask creation stays a deliberate user / `+ Subtask` action. The refined epic *proposes* a breakdown in prose; the user decides what to materialize.
- **A dedicated `refineEpic` message + handler in `PlanningPanelProvider.ts`** — NOT a reuse of `copyRefinePrompt`. The handler resolves the epic's own `planFile` (which the webview already carries on `_epicSelectedPlan`), so it works without depending on `KanbanProvider`.
- **The button lives inside the manage group, gated by `isManageable`** — exactly like Orchestrate. Post-removal, `isManageable` is always true for a selected epic, so Refine shows for every (DB-backed) epic.
- **Old installs (skill file absent):** the handler embeds a fallback prompt, exactly as `copyRefinePrompt` does (`PlanningPanelProvider.ts:5223-5236`) — no migration needed; the feature is purely additive.

### Rejected Alternatives
- **Add the button to the kanban board epic cards.** Rejected per user feedback — the cards are already crowded.
- **Reuse the existing `copyRefinePrompt` handler with `provider: 'epic'`.** Rejected: `copyRefinePrompt` reads `refine_ticket.md` and resolves files via `_findTicketFilePath`, which searches `.switchboard/tickets/<provider>/` by ticket-id pattern. An epic's file lives at `.switchboard/epics/*.md` and would never be found (`localFilePath` would be empty), and the ticket-shaped skill is wrong for epics.
- **Inject refine guidance into `buildEpicOrchestrationPrompt` when subtask count is 0.** Rejected: conflates specification with execution and fires unpredictably (an epic can legitimately have a full description and 0 subtasks).

## Complexity Audit

### Routine
- New static markdown skill file (`.agents/skills/refine_epic.md`) — user-editable content, no logic.
- One `MIRROR_MANIFEST` entry in `ClaudeCodeMirrorService.ts` — single line, mirrors the existing `refine_ticket` entry.
- One `<button>` in the manage group of `renderEpicMetaBar` (`project.js`), beside Orchestrate — mirrors the adjacent Orchestrate `.strip-btn` markup.
- One click listener inside the existing `if (isManageable)` block — mirrors the existing `btnOrch` listener pattern.
- One `refineEpic` message handler in `PlanningPanelProvider.ts` — mirrors the `copyRefinePrompt` handler (read skill → resolve & read epic file → build prompt → clipboard → status), using `path.isAbsolute(planFile) ? planFile : path.resolve(wsRoot, planFile)` resolution already used elsewhere in the file (e.g. `3109`, `3124`, `3923`).
- One AGENTS.md skill-registry row — single documentation line.

### Complex / Risky
- **None.** No new architectural patterns, no DB writes, no migrations, no breaking changes, no `KanbanProvider` coupling. Every dependency used (`_resolveWorkspaceRoot`, `vscode.env.clipboard`, `vscode.window.showInformationMessage`, `require('fs')`, `path`, `_epicSelectedPlan.planFile`) already exists and is used by neighboring code in the same files.

## Edge-Case & Dependency Audit

| Case | Handling |
| :--- | :--- |
| **Empty epic (no `## Goal`)** — the core scenario | Prompt instructs the agent to read the file, recognize it is sparse, and author a full description + proposed subtask breakdown. Primary purpose. |
| **Epic already well-described** | Skill says "enhance, don't rewrite; preserve existing well-written content" (copied from `refine_ticket`). |
| **Epic markdown file missing on disk** | Resolve `planFile` (abs-or-resolve), read in try/catch; if unreadable, include the resolved path anyway and instruct the agent to **create** it there. |
| **Skill file `refine_epic.md` missing (older install)** | try/catch around the skill read with `.agent/` legacy fallback then an embedded fallback string — identical to `copyRefinePrompt`. |
| **Standalone epic documents** | No longer exist after the removal plan (`feature_plan_20260629083123_remove-standalone-epics.md`). The Epics tab is DB-only; every selectable epic is DB-backed and manageable, so Refine (gated by `isManageable`) shows for all of them. No standalone-doc handling needed. |
| **`planId` vs `sessionId` for locally-created epics** | The handler resolves by `planFile` (carried on `_epicSelectedPlan`), so the id ambiguity is irrelevant; `planId` is still sent for logging/echo. |
| **No epic selected** | Listener guards `if (!_epicSelectedPlan) return;` — same as the Orchestrate/Delete listeners. |
| **Auto-generated subtasks block** | Skill instructs the agent NOT to edit inside `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->` / `<!-- END SUBTASKS -->` (regenerated by `_regenerateEpicFile`, `KanbanProvider.ts:8561`); proposed breakdown goes in a separate `## Proposed Subtasks` section. |
| **No confirmation dialog** | The button only copies to the clipboard; per project rule, no `confirm()` / modal is added. |
| **Distribution** | `.agents/**` ships in the VSIX (`!.agents/**` in `.vscodeignore` line 26); on next activation `generateClaudeMirror()` mirrors the skill into `.claude/skills/refine-epic/SKILL.md`. No extra packaging step. |
| **`_epicSelectedPlan.topic` / `.subtaskCount` availability** | Code verification shows these properties are NOT accessed via `_epicSelectedPlan` in existing code. The plan object likely has `topic` (standard field), but `subtaskCount` may not be populated. The handler uses `|| ''` and `|| 0` fallbacks, so missing properties default safely. |
| **`path.resolve` vs `path.join`** | The existing codebase pattern in `PlanningPanelProvider.ts` (lines 3109, 3124) uses `path.resolve()`, NOT `path.join()`. The handler must use `path.resolve` to match — `path.resolve` normalizes `..` segments and handles edge cases better. |

### Dependencies
- `PlanningPanelProvider._resolveWorkspaceRoot` (line 1737), `vscode.env.clipboard`, `path`, `require('fs')` — all already used in `PlanningPanelProvider.ts`.
- `_epicSelectedPlan` (carries `planId`, `sessionId`, `planFile`, `workspaceRoot`) — already populated in `project.js` (`selectEpic`, line 1777). **Note:** `topic` and `subtaskCount` are not confirmed on this object — see User Review Required.
- `ClaudeCodeMirrorService.MIRROR_MANIFEST` / `generateClaudeMirror` — existing mirror pipeline; one added entry suffices.
- No new npm dependencies.

## Adversarial Synthesis

Key risks: (1) The handler uses `path.join` but the existing codebase pattern is `path.resolve` — must use `path.resolve` to match and to handle `..` segments safely. (2) `_epicSelectedPlan.topic` and `.subtaskCount` are not confirmed to exist on the plan object — the `|| ''` and `|| 0` fallbacks handle this, but the user should verify. (3) The feature depends on the standalone-epics removal plan for full coverage, but sequencing is forgiving. Mitigations: Use `path.resolve` in the handler, keep the fallback defaults, and note the dependency in the User Review Required section.

## Proposed Changes

### 1. New file: `.agents/skills/refine_epic.md`

User-editable skill definition. Frontmatter `description` is consumed by `generateClaudeMirror`; the body is injected verbatim into the copied prompt.

```markdown
---
description: Refine an epic into a complete, decomposable specification — clear goal, success criteria, scope, and a proposed subtask breakdown
---

# Skill: Refine Epic

This skill transforms a thin or empty epic into a complete, unambiguous epic that is ready to decompose into subtasks and orchestrate.

## When to Use
Triggered by clicking "Refine" on a selected epic in the Switchboard Epics tab.

## What it does
Produces a complete epic description (goal/problem, success criteria, scope, risks, and a proposed subtask breakdown) and writes the result back to the epic's local markdown file.

## Template Sections (Flexible — agent decides which apply)
- `## Goal` — the outcome this epic delivers and the problem it solves (root-cause framed, self-contained).
- `## Background / Why` — context, motivation, business reason.
- `## Success Criteria` — checkboxed, testable conditions that mean "this epic is done".
- `## Scope` — In Scope / Out of Scope bullets.
- `## Proposed Subtasks` — an ordered, checkboxed breakdown into independently-shippable units of work. Each item: a one-line title plus a sentence of intent. Aim for 3–12 subtasks.
- `## Dependencies & Sequencing` — ordering constraints between subtasks, external blockers.
- `## Risks / Open Questions` — what could go wrong; unresolved decisions.

## Agent Instructions
- Read the existing epic markdown from the local file path provided in the prompt. Preserve the YAML frontmatter exactly.
- Determine what's missing. If the file is empty or has no `## Goal`, author one from the epic title and any context in the prompt.
- Enhance, don't rewrite: keep existing well-written content; fill gaps.
- The most valuable output for a sparse epic is the `## Proposed Subtasks` breakdown — make it concrete and decomposable.
- Do NOT create kanban cards or modify any database. Only write markdown back to the file. Subtask cards are created separately by the user.
- Eliminate ambiguity: replace vague language with specific, testable criteria.
- Write the refined markdown back to the local file path provided. If the file does not exist, create it at that path.
- Report back with a summary of what you added or changed, and list the proposed subtasks so the user can decide which to create.

## Note on the auto-generated subtasks block
The epic file may contain an auto-generated block wrapped in
`<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->` / `<!-- END SUBTASKS -->`.
Do NOT edit inside that block — Switchboard regenerates it. Put your proposed
breakdown in a separate `## Proposed Subtasks` section above it.
```

### 2. `src/services/ClaudeCodeMirrorService.ts` — register the skill

Add one entry to `MIRROR_MANIFEST`, immediately after the `refine_ticket` line (currently line 67):

```typescript
{ source: 'skills/refine_ticket.md', name: 'refine-ticket', invocation: 'no-model' },
{ source: 'skills/refine_epic.md', name: 'refine-epic', invocation: 'no-model' },   // NEW
```

`invocation: 'no-model'` matches `refine_ticket`: button-triggered, not auto-invoked. On next activation, `generateClaudeMirror` writes `.claude/skills/refine-epic/SKILL.md` with `disable-model-invocation: true`.

### 3. `src/webview/project.js` — add the "Refine" button to the Epics-tab meta bar

**3a. Markup** — add the Refine button inside the existing `manageGroup` template in `renderEpicMetaBar` (lines ~1801-1807), right after Orchestrate:

```javascript
const manageGroup = isManageable ? `
    <div class="kanban-meta-group" style="display:flex; gap:6px;">
        <button class="strip-btn" id="btn-epic-orchestrate" style="${_orchestratorAvailable ? 'border-color: var(--accent-teal);' : 'opacity: 0.6; border-color: var(--border-color);'}" title="...">Orchestrate</button>
        <button class="strip-btn" id="btn-epic-refine" title="Refine this epic's description and propose a subtask breakdown — copies a prompt to the clipboard">Refine</button>   <!-- NEW -->
        <button class="strip-btn" id="btn-epic-add-subtask" title="Add an existing plan to this epic as a subtask">+ Subtask</button>
        <button class="strip-btn" id="btn-epic-delete" style="color:#ff6b6b;" title="Delete this epic (subtasks are detached)">Delete Epic</button>
    </div>
` : '';
```

(Keep the existing Orchestrate `title` text verbatim — elided above for brevity. Note: the removal plan collapses `isManageable` to `!!plan`; this markup is unchanged either way — Refine simply renders whenever the manage group does.)

**3b. Listener** — wire the Refine listener inside the existing `if (isManageable) { ... }` block, after `btnOrch` (~line 1821):

```javascript
const btnRefine = document.getElementById('btn-epic-refine');
if (btnRefine) btnRefine.addEventListener('click', () => {
    if (!_epicSelectedPlan) return;
    const original = btnRefine.textContent;
    btnRefine.textContent = 'Copied ✓';
    setTimeout(() => { btnRefine.textContent = original; }, 1200);
    vscode.postMessage({
        type: 'refineEpic',
        planId: _epicSelectedPlan.planId || '',
        planFile: _epicSelectedPlan.planFile || '',
        title: _epicSelectedPlan.topic || _epicSelectedPlan.name || '',
        subtaskCount: _epicSelectedPlan.subtaskCount || 0,
        workspaceRoot: _epicSelectedPlan.workspaceRoot
    });
});
```

The existing Orchestrate / + Subtask / Delete listeners stay unchanged.

### 4. `src/services/PlanningPanelProvider.ts` — add the `refineEpic` handler

Add a new `case` in the webview message switch, next to `copyRefinePrompt` (after line 5264). It mirrors `copyRefinePrompt`'s skill-read + clipboard pattern but resolves the epic's own `planFile`. **Uses `path.resolve` (not `path.join`) to match the existing codebase pattern** at lines 3109, 3124:

```typescript
case 'refineEpic': {
    try {
        const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
        const { planId, planFile, title, subtaskCount } = msg;
        if (!workspaceRoot || !planFile) {
            vscode.window.showErrorMessage('Missing workspace or epic file for refine prompt');
            break;
        }

        // Read user-editable skill file (.agents → legacy .agent → embedded fallback).
        const nfs = require('fs') as typeof import('fs');
        let skillContent = '';
        try {
            skillContent = nfs.readFileSync(path.join(workspaceRoot, '.agents', 'skills', 'refine_epic.md'), 'utf8');
        } catch {
            try {
                skillContent = nfs.readFileSync(path.join(workspaceRoot, '.agent', 'skills', 'refine_epic.md'), 'utf8');
            } catch {
                skillContent = `Refine this epic into a complete specification with:
- A clear ## Goal (outcome + problem it solves)
- ## Success Criteria (checkboxed, testable)
- ## Scope (in/out)
- ## Proposed Subtasks (ordered, checkboxed breakdown into shippable units)
- ## Risks / Open Questions
Preserve YAML frontmatter and the auto-generated <!-- BEGIN SUBTASKS --> block. Do not create kanban cards. Write the result back to the local file path provided.`;
            }
        }

        // Resolve the epic markdown file — use path.resolve to match existing codebase pattern.
        const epicFilePath = path.isAbsolute(planFile) ? planFile : path.resolve(workspaceRoot, planFile);
        let existingContent = '';
        try { existingContent = nfs.readFileSync(epicFilePath, 'utf8'); } catch { /* file may not exist yet */ }

        const prompt = `You are refining a Switchboard epic into a complete, decomposable specification.

## Skill Instructions
${skillContent}

## Epic to Refine
- **Title:** ${title || ''}
- **Existing subtask cards:** ${subtaskCount || 0}
- **Local file path (write the refined content here):** ${epicFilePath}

## Current epic file content
${existingContent ? existingContent : '(file is empty or does not exist yet — author a complete epic at the path above)'}

Read the current content above. Determine what's missing. Produce a complete epic following the skill instructions — pay special attention to a concrete ## Proposed Subtasks breakdown. Write the refined markdown directly to the local file path, preserving any YAML frontmatter and the auto-generated <!-- BEGIN SUBTASKS --> block. Do NOT create kanban cards or modify any database. Report back with a summary and the proposed subtask list.`;

        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage('Refine-epic prompt copied to clipboard. Paste it into your agent.');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to copy refine-epic prompt: ${String(err)}`);
    }
    break;
}
```

### 5. `AGENTS.md` — register in the skill table (source of truth, not generated `CLAUDE.md`)

Add one row beneath the `refine_ticket` row (currently line 96):

```markdown
| `refine_epic` | User clicks "Refine" on a selected epic in the Epics tab to copy a prompt that fleshes out the epic description and proposes a subtask breakdown (backend-consumed skill — not invocable via `skill: "refine_epic"`) |
```

(Edit `AGENTS.md` — the control-plane source. `CLAUDE.md`'s table is the generated mirror; do not hand-edit it.)

## Verification Plan

### Automated Tests
- No automated tests required (skip per session directive). The test suite will be run separately by the user.

### Manual Verification
1. **Skill mirror generation:** After activation, `.claude/skills/refine-epic/SKILL.md` exists with `name: refine-epic`, the skill's `description`, and `disable-model-invocation: true`; `.claude/.switchboard-generated.json` lists `skills/refine_epic.md`.
2. **Button placement:** Build/install the VSIX, open the Project panel → Epics tab, select an epic. A **Refine** button appears in the meta bar beside **Orchestrate**, **+ Subtask**, **Delete Epic** — and **nothing changes on the kanban board cards**.
3. **Empty-epic happy path:** Create an epic with no description and 0 subtasks; select it; click **Refine** → "Refine-epic prompt copied to clipboard" toast and the button flashes "Copied ✓". Paste the clipboard and confirm it contains: the `refine_epic` skill body, the epic title, `Existing subtask cards: 0`, the resolved `.switchboard/epics/...md` path, and the "(file is empty…)" placeholder.
4. **Populated-epic path:** On an epic with a `## Goal` and subtasks, Refine embeds the current file content verbatim and reports the correct subtask count.
5. **End-to-end with an agent:** Paste the prompt into an agent. Confirm it writes a complete epic (Goal, Success Criteria, Scope, **Proposed Subtasks**) back to the epic file, preserves frontmatter and the `<!-- BEGIN SUBTASKS -->` block, and creates **no** new kanban cards / DB rows.
6. **Fallback paths:** Temporarily rename `.agents/skills/refine_epic.md` and click Refine — the embedded fallback prompt is used (no crash). Restore the file.
7. **All epics covered:** Confirm Refine appears for every epic in the Epics tab (all DB-backed, post-removal). No epic shows Orchestrate/+ Subtask/Delete without also showing Refine.
8. **No regressions:** Orchestrate, + Subtask, Delete Epic, Edit/Save/Cancel in the meta bar still work unchanged; no epic-selected → Refine listener no-ops via its guard.

---

**Recommendation:** Complexity 4/10 → Send to Coder.

## Code Review Results (2026-06-29)

### Files Changed
- `.agents/skills/refine_epic.md` — new skill file with frontmatter, template sections, agent instructions, and auto-generated subtasks block note.
- `src/services/ClaudeCodeMirrorService.ts` (line 68) — added `{ source: 'skills/refine_epic.md', name: 'refine-epic', invocation: 'no-model' }` to MIRROR_MANIFEST.
- `src/webview/project.js` (lines 1802-1808, 1821-1835) — added Refine button in `manageGroup` template and click listener inside `if (isManageable)` block.
- `src/services/PlanningPanelProvider.ts` (lines 5408-5462) — added `case 'refineEpic'` handler with 3-tier skill read fallback, `path.resolve` for epic file, clipboard copy.
- `AGENTS.md` (line 98) — added `refine_epic` skill table row.

### Findings
| Severity | Finding | File:Line | Status |
|:---|:---|:---|:---|
| NIT | Plan says "beside Orchestrate button" but Orchestrate was removed by the standalone-epics removal plan — Refine is correctly in manage group | project.js:1802-1808 | Documentation discrepancy only — code correct |
| NIT | Mirror-generated `.claude/skills/refine-epic/SKILL.md` not yet present — appears on next version bump | ClaudeCodeMirrorService.ts:68 | By design (version-gated mirror regen) |

### Fixes Applied
None — implementation is correct and complete. All 5 deliverables verified against plan requirements.

### Validation
- No compilation step run (per session directive).
- No tests run (per session directive).
- Code verification: skill file content matches plan. Manifest entry uses `no-model` invocation. Button placed in manage group with correct title/tooltip. Listener guards `_epicSelectedPlan`, sends `planId`/`planFile`/`title`/`subtaskCount`/`workspaceRoot`. Handler uses `path.resolve` (not `path.join`), has `.agents` → `.agent` → embedded fallback, handles missing epic file. AGENTS.md row added after `refine_ticket`.

### Remaining Risks
- Mirror-generated skill file appears only on version bump — for dev testing, bump the dev extension version to trigger regen.
- The plan's "beside Orchestrate" description is stale (Orchestrate removed by dependency plan) — code placement is correct regardless.
