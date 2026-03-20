# Add edit meta data and text into the review button webview function

## Notebook Plan

On each kanban card, the 'review' button currently opens up a webview where the user can select text and prompt an agent for a review. This is good, but it needs to be expanded to a full-blown jira-style ticket view, where user can:

1. enter metadata: complexity, column and dependencies (so they can fix the card state)
2. edit the text of the plan without having to open the markdown edit view
3. see the actions log for the plan

Once this is done, remove the 'open' button as well. 

## Goal
- Transform the existing "review" webview panel into a **Jira-style ticket detail view** for each kanban card.
- The view must support: (1) editing metadata (complexity, column, dependencies), (2) inline plan text editing, (3) viewing the session action log.
- Remove the separate "open" button from kanban cards since the ticket view now provides full access.

## Dependencies
- **Existing review webview**: Currently opened via `switchboard.reviewPlanFromKanban` command (KanbanProvider.ts line 611-614). The command opens a WebviewPanel that displays plan text for agent review.
- **Session action log**: The `SessionActionLog` service tracks events per session. The ticket view needs to read from this.
- **KanbanDatabase**: Column and complexity data can be read/written through the existing `KanbanDatabase.upsertPlans` method.
- **kanbanColumnDerivation**: Current column is derived from runsheet events. Manually setting a column requires writing a synthetic event or directly updating the DB.

## Proposed Changes

### Step 1 — Extend the review webview HTML to a ticket view (Complex)
- **File**: Create or extend the review webview HTML (locate the existing review panel HTML generation — likely inline in TaskViewerProvider.ts or a separate HTML file).
- The new ticket view layout should have 3 sections:

#### Section A — Metadata Panel (top)
- **Column**: Dropdown select showing all kanban columns (`CREATED`, `PLAN REVIEWED`, `CODED`, `CODE REVIEWED`). Current column pre-selected. On change, post `{ type: 'setColumn', sessionId, column }` to backend.
- **Complexity**: Dropdown with options `Unknown`, `Low`, `High`. Current value pre-selected. On change, post `{ type: 'setComplexity', sessionId, complexity }`.
- **Dependencies**: A text input or tag list where user can type session IDs or topic names of dependent plans. On blur/submit, post `{ type: 'setDependencies', sessionId, dependencies: [...] }`.
- **Topic**: Editable text field showing the card topic. On blur, post `{ type: 'setTopic', sessionId, topic }`.

#### Section B — Plan Text Editor (middle, largest section)
- Display the full markdown content of the plan file in an editable `<textarea>` or a simple code editor area.
- Load content from the plan file path on the card.
- On save (Ctrl+S or a Save button), post `{ type: 'savePlanText', sessionId, content }` to backend which writes to the plan file.
- Style: mono font, dark background, matching the kanban design system.

#### Section C — Action Log (bottom, collapsible)
- Display the session's event log as a reverse-chronological list.
- Each entry: `[timestamp] workflow: [name] — [details]`.
- Read from the runsheet's `events` array for the session.
- Read-only display.

### Step 2 — Backend message handlers for ticket view (Complex)
- **File**: `src/services/KanbanProvider.ts` (or TaskViewerProvider.ts, wherever the review panel is handled)
- Add handlers for the new message types:
  - `'setColumn'`: Update the card's kanban column. If using SQLite DB, call `db.run('UPDATE plans SET kanban_column = ?, updated_at = ? WHERE session_id = ?', [column, now, sessionId])`. If file-based, write a synthetic event to the runsheet: `{ workflow: 'manual-move', timestamp: now, targetColumn: column }`.
  - `'setComplexity'`: Update the complexity field in the DB or write it into the plan file's Complexity Audit section.
  - `'setDependencies'`: Store dependencies — either as a new field in the DB schema (requires migration) or as a metadata section appended to the plan file.
  - `'setTopic'`: Update the topic in the runsheet JSON and the DB.
  - `'savePlanText'`: Write the content string to the plan file path using `fs.promises.writeFile`.
- After each mutation, call `_refreshBoard()` to update the kanban view.

### Step 3 — Load ticket data on open (Moderate)
- When the review panel opens for a session ID, the backend must gather and push:
  - Current card metadata (column, complexity, topic) from the board data.
  - Plan file content (read from disk).
  - Action log events (from the runsheet JSON `events` array).
- Send all of this as an initial `{ type: 'ticketData', ... }` message to the webview.

### Step 4 — Remove the "open" button from kanban cards (Routine)
- **File**: `src/webview/kanban.html`
- In the card rendering function, remove the "open" / "view" button that currently opens the plan in the editor. The ticket view now serves this purpose.
- Keep the "review" button (now labelled "View" or show a ticket icon) and the "complete" / "copy" buttons.
- Remove the `case 'viewPlan'` message handler from KanbanProvider if it's no longer needed, or keep it as an alternative access path.

### Step 5 — Update card button in kanban.html (Routine)
- Rename the "review" button to a more descriptive icon/label like "📝" or "View" to indicate it opens the full ticket view.
- The click handler still posts `{ type: 'reviewPlan', sessionId }`.

## Verification Plan
1. `npm run compile` — no build errors.
2. Open kanban → click the ticket/view button on any card → ticket view opens in a webview panel.
3. **Metadata editing**: Change column via dropdown → card moves to new column on kanban board. Change complexity → complexity indicator updates on card.
4. **Plan text editing**: Edit the plan text → click Save → verify the `.md` file on disk is updated. Reopen → content persists.
5. **Action log**: Verify events are displayed in reverse chronological order with correct timestamps.
6. **"Open" button removed**: Confirm the old open/view button is no longer present on cards.
7. **Dependencies field**: Enter a dependency → verify it persists (check plan file or DB).
8. Close and reopen ticket view → all data loads correctly.

## Complexity Audit

### Band A — Routine
- Remove the "open" button from kanban cards
- Rename "review" button
- Load and display action log (read-only)

### Band B — Complex / Risky
- **Inline plan text editing with save** — must handle concurrent edits (what if an agent modifies the plan file while user is editing?). Mitigation: warn if file mtime changed since load.
- **Manual column override** — writing synthetic events or direct DB updates bypasses the normal event-driven derivation. Must ensure consistency: if DB is authoritative, update DB; if file-based, update runsheet. The current hybrid model (see "Make sqlite db actually useful" plan) makes this fragile.
- **Dependencies field** — no existing schema for plan dependencies. Requires either a DB migration (add `dependencies TEXT` column) or a convention for storing deps in the plan file markdown (e.g. a `## Dependencies` section). DB approach is cleaner but couples to the SQLite plan.
- **Webview panel lifecycle** — if multiple ticket views are opened for different cards, ensure they don't collide. Use a panel-per-session pattern or a single panel that swaps content.

**Recommendation**: Send it to the **Lead Coder** — this is a significant UI+backend feature with data consistency concerns and multiple interacting components.
