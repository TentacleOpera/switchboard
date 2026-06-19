# Refine Ticket Skill & Card Button

## Metadata
**Complexity:** 4
**Tags:** frontend, backend, ui, feature, docs

## Goal

Add a "Refine" button to each ticket card in the planning.html tickets tab that copies a rich, skill-file-driven prompt to the user's clipboard. The user pastes it into any agent. The agent reads the existing ticket, determines what's missing, produces a complete best-practice ticket (acceptance criteria, user flow, flow diagrams, assumptions challenged, ambiguity eliminated), and writes the result back to the local markdown file. The existing file watcher auto-refreshes the preview.

### Problem Analysis

The Switchboard tickets tab has:
1. **No refine UI** — there is no "Refine" button on ticket cards. Users cannot trigger refinement.
2. **No skill file** — there is no `.agent/skills/refine_ticket.md` defining what a "refined ticket" means.
3. **Existing backend is over-engineered for this use case** — `refineTask()` in `TaskViewerProvider.ts:4731` dispatches directly to a planner agent via terminal, but the user wants a clipboard-copy pattern (like the existing "Diagram Prompt" button) so they can paste into any agent.
4. **File watcher already handles refresh** — `_setupTicketsViewWatcher` at `PlanningPanelProvider.ts:6920` watches ticket `.md` files and posts `ticketFileChanged` to the webview (handler at `planning.js:3493`), which updates the preview in place. No manual refresh needed.

### Root Cause

The refine flow was scaffolded with a direct-dispatch backend but never connected to UI. The user wants the simpler clipboard-copy pattern (matching "Diagram Prompt" and "Link to ticket" card buttons) rather than the direct-dispatch approach.

## User Review Required

Yes — before implementation, confirm:
- The "Refine" button label and placement (inside `.card-actions`, after "Link to ticket") match expectations.
- The fallback prompt template (used when `.agent/skills/refine_ticket.md` is missing) is acceptable.
- The decision to leave the existing `refineTask()` / `switchboard.refineTask` command untouched (clipboard approach supersedes it for this feature) is correct.

## Complexity Audit

### Routine
- New markdown skill file (`.agent/skills/refine_ticket.md`) — static content, user-editable
- New `copyRefinePrompt` message handler in `PlanningPanelProvider.ts` — follows the existing `copyDiagramPrompt` pattern (clipboard write + try/catch)
- Two card button additions (Linear + ClickUp templates) — single HTML `<button>` line each, inside existing `.card-actions` divs
- One click delegation block in `initTicketsTab()` — mirrors the existing `linkTicketBtn` and `importPlanBtn` delegation blocks
- AGENTS.md skill table row addition — single line in one file

### Complex / Risky
- None — no new architectural patterns, no data consistency risks, no breaking changes. All dependencies (`path`, `LocalFolderService`, `_findLocalTicketFile`, `flashCopyBtn`, `vscode.env.clipboard`) already exist and are used by neighboring code.

## Scope

### In Scope
- New `.agent/skills/refine_ticket.md` skill file — user-editable, defines the refined ticket template and agent instructions
- "Refine" button on each ticket card (next to "Add to kanban" and "Link to ticket")
- New `copyRefinePrompt` message handler in `PlanningPanelProvider.ts` — reads skill file, resolves local ticket file path, builds rich prompt, copies to clipboard
- Click delegation in `planning.js` for the card button
- Register `refine_ticket` in AGENTS.md skill registry (documentation-only — see note below)

### Out of Scope
- Auto-push to ClickUp/Linear after refinement (user pushes manually)
- Batch refine
- Modifying the existing `refineTask()` / `switchboard.refineTask` command (leave as-is; the clipboard approach supersedes it for this feature)
- Custom per-ticket-type templates (agent intelligence determines structure)

## Proposed Changes

### 1. New file: `.agent/skills/refine_ticket.md`

**Purpose:** User-editable skill file defining what a complete, agent-actionable ticket looks like.

**Content:**
- **Frontmatter:** `---\ndescription: Refine a ticket into a complete, agent-actionable specification with acceptance criteria, flow diagrams, and challenged assumptions\n---`
- **When to Use:** Triggered by clicking "Refine" on a ticket card in the Switchboard tickets tab
- **What it does:** Transforms any ticket (sparse or partial) into a complete, unambiguous, agent-actionable ticket
- **Template sections (flexible — agent decides which apply):**
  - `## Summary` — one-paragraph plain-English description
  - `## Background / Why` — context, motivation, business reason
  - `## User Flow` — numbered steps (for features)
  - `## Acceptance Criteria` — grouped, checkboxed, testable ("given X, when Y, then Z")
  - `## Assumptions` — each assumption explicitly challenged or validated
  - `## Open Questions` — unresolved ambiguities
  - `## Dependencies` — upstream/downstream, blocking issues
  - `## Designs / References` — mockups, screenshots, related tickets
  - `## Flow Diagram` — Mermaid flowchart rendered to inline PNG (for non-trivial flows)
- **Agent instructions:**
  - Read the existing ticket content; determine ticket type (feature, bugfix, epic, refactor)
  - Identify what's missing or incomplete
  - Fill gaps intelligently — don't blindly apply all sections
  - Challenge assumptions: for each, ask "is this actually true?" and document
  - Eliminate ambiguity: replace vague language with specific, testable criteria
  - For non-trivial flows: generate Mermaid, render to PNG via `npx @mermaid-js/mermaid-cli -i input.mmd -o output.png`, save alongside ticket file, embed as `![Flow Diagram](./{filename}.png)`
  - Preserve YAML frontmatter
  - Preserve existing well-written content — enhance, don't rewrite
  - Write refined content back to the local file path provided in the prompt
  - Report back with summary of changes
- **Gold standard reference:** Parent checkin ticket structure (Summary, Background/Why, User Flow, grouped Acceptance Criteria, Open Questions, Designs with screenshots)

**Clarification (adversarial review):** This skill file is **backend-consumed**, not agent-invocable. The `copyRefinePrompt` handler reads its content and injects it into the clipboard prompt. It is NOT invocable via `skill: "refine_ticket"` in the traditional skill system. The AGENTS.md registration (step 4) is for discoverability/documentation only.

### 2. `src/services/PlanningPanelProvider.ts` — New `copyRefinePrompt` handler

**Context:** The `copyDiagramPrompt` handler at line 4231 copies a prompt string to clipboard. The new handler follows the same pattern but also reads the skill file and resolves the local ticket file path.

**Logic — New case in message switch (insert after `copyDiagramPrompt` case ends at line 4244, before `changeTicketStatus` at line 4245):**

```typescript
case 'copyRefinePrompt': {
    try {
        const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
        const { provider, id, title, description } = msg;
        if (!workspaceRoot || !id) {
            vscode.window.showErrorMessage('Missing workspace or ticket ID for refine prompt');
            break;
        }

        // Read user-editable skill file
        const skillPath = path.join(workspaceRoot, '.agent', 'skills', 'refine_ticket.md');
        let skillContent = '';
        try {
            const nfs = require('fs') as typeof import('fs');
            skillContent = nfs.readFileSync(skillPath, 'utf8');
        } catch {
            skillContent = `Refine this ticket into a complete specification with:
- Summary, Background/Why, User Flow, Acceptance Criteria (checkboxed, testable)
- Assumptions challenged, Open Questions, Dependencies
- Mermaid flow diagram rendered to PNG if the flow is non-trivial
- Write result back to the local file path provided.`;
        }

        // Resolve local ticket file path
        let localFilePath = '';
        try {
            let baseDir = path.join(workspaceRoot, '.switchboard', 'tickets');
            const lfs = new LocalFolderService(workspaceRoot);
            const folders = lfs.getTicketsFolderPaths();
            if (folders.length > 0 && folders[0]) { baseDir = folders[0]; }
            localFilePath = this._findLocalTicketFile(path.join(baseDir, provider), provider, id) || '';
        } catch { }

        const prompt = `You are refining a ${provider} ticket into a complete, agent-actionable specification.

## Skill Instructions
${skillContent}

## Ticket to Refine
- **Title:** ${title || ''}
- **Description:** ${description || ''}
- **Ticket ID:** ${id}
- **Provider:** ${provider}
${localFilePath ? `- **Local file path (write the refined content here):** ${localFilePath}` : ''}

Read the existing ticket content from the local file if it exists. Determine what's missing. Produce a complete ticket following the skill instructions above. Write the refined markdown directly to the local file path, preserving any YAML frontmatter. Report back with a summary of what you added or changed.`;

        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage('Refine prompt copied to clipboard');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to copy refine prompt: ${String(err)}`);
    }
    break;
}
```

**Note:** All dependencies already imported — `path`, `LocalFolderService` (line 3878), `_findLocalTicketFile` (line 6903), `require('fs')` pattern used throughout. The `new LocalFolderService(workspaceRoot)` + `getTicketsFolderPaths()` + `_findLocalTicketFile()` chain mirrors the `saveLocalTicketFile` handler at lines 3876-3882 exactly.

**Clarification (adversarial review — description format):** The `description` field from the in-memory issue cache may be raw HTML for Linear (Linear API returns HTML) vs markdown for ClickUp (`markdownDescription`). This matches the existing `handleTicketsAskAgent` pattern in `planning.js` (lines 7569-7585) — a pre-existing inconsistency that is inherited, not introduced, by this plan. The external agent can handle mixed formats.

### 3. `src/webview/planning.js` — Card button + click delegation

**Context:** Ticket cards are rendered in `renderTicketsLinearList()` (card template at lines 6803-6816) and `renderTicketsClickUpList()` (card template at lines 7270-7282). Each card has a `.card-actions` div with "Add to kanban" and "Link to ticket" buttons. Click delegation is at line 6152 in `initTicketsTab()`.

**Logic — Step 3a: Add "Refine" button to Linear card template (insert after the "Link to ticket" button at line 6813, inside `.card-actions`):**

```html
<button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Refine</button>
```

**Logic — Step 3b: Add "Refine" button to ClickUp card template (insert after the "Link to ticket" button at line 7279, inside `.card-actions`):**

```html
<button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Refine</button>
```

**Logic — Step 3c: Add click delegation in `initTicketsTab()` (insert after the `linkTicketBtn` if-block closes at line 6166, before the generic card-click handler at line 6167):**

```javascript
const refineBtn = e.target.closest('[data-refine-ticket-id]');
if (refineBtn) {
    const id = refineBtn.dataset.refineTicketId;
    const provider = refineBtn.dataset.provider;
    // Get title/description from in-memory issue data
    let title = '';
    let description = '';
    if (provider === 'linear') {
        const issue = linearProjectIssues.find(i => i.id === id);
        title = issue?.title || issue?.identifier || '';
        description = issue?.description || '';
    } else {
        const task = clickUpProjectIssues.find(t => t.id === id);
        title = task?.title || task?.identifier || '';
        description = task?.markdownDescription || task?.description || '';
    }
    vscode.postMessage({
        type: 'copyRefinePrompt',
        provider,
        id,
        title,
        description,
        workspaceRoot: ticketsWorkspaceRoot
    });
    flashCopyBtn(refineBtn);
    return;
}
```

**Note:** `flashCopyBtn` already exists (line 7537) and is used by the "Link to ticket" button via `handleLinkToTicket` (line 7566) — shows "Copied!" feedback. The title/description lookup mirrors `handleTicketsAskAgent` (lines 7569-7585) exactly. The `linearProjectIssues` (line 155) and `clickUpProjectIssues` (line 169) in-memory arrays are the same data sources used by the existing card buttons. The file watcher (`_setupTicketsViewWatcher` at `PlanningPanelProvider.ts:6920`) will auto-refresh the preview when the agent writes to the local file — no additional refresh logic needed.

**Line anchor correction (adversarial review):** The insertion point is after line 6166 (where the `linkTicketBtn` if-block closes with `return;`), NOT line 6154 (which is merely where `linkTicketBtn` is declared). The refine check must come before the generic card-click handler at line 6167 so that clicking "Refine" does not also trigger card selection. The `return;` at the end of the refine block ensures this.

### 4. `AGENTS.md` — Register skill

Add to the skill table in AGENTS.md (there is exactly one copy in this repo):

| `refine_ticket` | User clicks "Refine" on a ticket card to copy a prompt that produces a complete, agent-actionable specification (backend-consumed skill — not invocable via `skill: "refine_ticket"`) |

## Edge-Case & Dependency Audit

### Race Conditions
- **File watcher debounce:** The `_setupTicketsViewWatcher` (line 6920) already debounces file events (`_ticketsViewWatcherDebounces` map, line 6946). If the external agent writes the file multiple times in rapid succession (e.g., save-then-edit), the debounce coalesces events. No new race condition introduced — the refine flow does not touch the watcher.
- **Concurrent refine clicks:** If a user clicks "Refine" on multiple cards rapidly, each click copies a new prompt to clipboard (overwriting the previous). This is expected clipboard behavior — only the last copied prompt remains. No corruption risk.

### Security
- Skill file read from workspace filesystem — trusted local file, content passed as string, not executed
- Local file path resolved by backend (not user-supplied) — no path traversal risk
- The `_findLocalTicketFile` method (line 6903) validates file names against the `${provider}_${id}_` prefix pattern — a maliciously named file would not match

### Side Effects
- Agent overwrites local ticket markdown — intended behavior, user reviews and pushes
- Skill instructions tell agent to preserve frontmatter (polite request to autonomous agent; the `saveLocalTicketFile` handler at line 3887 strips/re-prepends frontmatter programmatically, but the refine flow bypasses that handler — the external agent writes directly)
- File watcher fires on write → `ticketFileChanged` → preview auto-refreshes
- No backend state mutation — the handler only reads files and writes to clipboard

### Dependencies & Conflicts
- Optional: `mermaid-cli` installed for PNG rendering (without it, agent produces Mermaid syntax inline — same graceful degradation as `generate_diagram` skill)
- No conflicts with existing `refineTask()` command — the clipboard approach is additive, the direct-dispatch command is left untouched

## Dependencies

None — this plan has no upstream session dependencies. All referenced code (`copyDiagramPrompt`, `_findLocalTicketFile`, `LocalFolderService`, `flashCopyBtn`, `handleLinkToTicket`, `handleTicketsAskAgent`, `_setupTicketsViewWatcher`) already exists in the codebase and is verified at the cited line numbers.

## Adversarial Synthesis

**Key risks:** (1) The AGENTS.md skill registration could mislead agents into trying `skill: "refine_ticket"` invocation — mitigated by annotating the registration as backend-consumed. (2) The external agent writes directly to the filesystem, bypassing the `saveLocalTicketFile` frontmatter-stripping logic — mitigated by skill instructions and user review before push. (3) The description field may be raw HTML for Linear — a pre-existing inherited inconsistency, not a new risk. **Overall:** Low-risk plan that cleanly extends two proven patterns (`copyDiagramPrompt` + `handleLinkToTicket`). The only required fix is the line anchor correction (6154→6166) for the click delegation insertion point.

## Files Changed

| File | Change |
|------|--------|
| `.agent/skills/refine_ticket.md` | **New file** — user-editable skill defining refined ticket template |
| `src/services/PlanningPanelProvider.ts` | New `copyRefinePrompt` handler (insert after line 4244, before line 4245) — reads skill file, resolves local file path, builds prompt, copies to clipboard |
| `src/webview/planning.js` | "Refine" button in Linear card template (after line 6813) and ClickUp card template (after line 7279); click delegation in `initTicketsTab()` (after line 6166, before line 6167) |
| `AGENTS.md` | Register `refine_ticket` in skill table (single file, annotated as backend-consumed) |

## Verification Plan

### Automated Tests
Skipped per session directive — the test suite will be run separately by the user. No compilation step required for this session.

### Manual Verification
1. **Refine a sparse ClickUp ticket:** Click "Refine" on a card → "Copied!" feedback → paste into agent → agent writes refined content to local file → preview auto-refreshes (file watcher)
2. **Refine a sparse Linear ticket:** Same flow
3. **Refine a complete ticket:** Click "Refine" on parent checkin ticket → agent recognizes existing structure, enhances gaps, preserves content
4. **Skill file missing:** Delete skill file → click "Refine" → fallback template in prompt → refinement still works
5. **No local file:** Ticket not imported locally → prompt omits file path → agent refines in chat only
6. **Mermaid diagram:** Refine ticket with non-trivial flow → agent generates Mermaid, renders PNG, embeds inline → preview shows diagram
7. **Frontmatter preservation:** Refine ticket with YAML frontmatter → frontmatter preserved
8. **File watcher refresh:** After agent writes to file → preview updates without manual re-selection
9. **Refine button does not trigger card selection:** Click "Refine" → only the clipboard copy fires, the card detail panel does not open (verify the `return;` in the delegation block prevents fall-through to the generic card-click handler at line 6167)

## Recommendation

**Complexity: 4** — One new skill file (markdown), one new backend handler (clipboard copy + file read, following existing `copyDiagramPrompt` pattern), two card button additions, one click delegation block. No new architectural patterns. File watcher already handles preview refresh.

**Send to Coder.**
