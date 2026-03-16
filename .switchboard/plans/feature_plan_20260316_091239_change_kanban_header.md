# change kanban header

## Notebook Plan

change: 'Copy prompts to send to external IDE agents'

to:

'Copy prompts to send to IDE chat agents'

As the agents won't always be external

## Goal
- Change the kanban board subtitle text from `"Copy prompts to send to external IDE agents"` to `"Copy prompts to send to IDE chat agents"`.
- This is a single string replacement in the kanban HTML.

## Dependencies
- **No blocking dependencies.**
- **Potential overlap with "Add main controls strip"** (sess_1773604319807) — that plan may restructure the header area. If implemented first, the header text location may change. However, the text itself still needs updating regardless of layout.

## Proposed Changes

### Step 1 — Update the kanban header title string (Routine)
- **File**: `src/webview/kanban.html`
- **Line 385**: The current `.kanban-title` div contains:
  ```html
  <div class="kanban-title">⚡ CLI-BAN - Drag plan cards to trigger CLI Agent actions | Copy prompts to send to external IDE agents</div>
  ```
- Change to:
  ```html
  <div class="kanban-title">⚡ CLI-BAN - Drag plan cards to trigger CLI Agent actions | Copy prompts to send to IDE chat agents</div>
  ```
- This is the **only** location where this string appears.

### Step 2 — Verify no other occurrences (Routine)
- Search the codebase for `"external IDE agents"` to confirm no other files reference this text.

## Verification Plan
1. `npm run compile` — no build errors.
2. Open kanban board → verify the header reads `"...Copy prompts to send to IDE chat agents"`.
3. `grep -r "external IDE agents" src/` — confirm zero hits.

## Complexity Audit

### Band A — Routine
- Single string replacement in kanban.html line 385

### Band B — Complex / Risky
- None

**Recommendation**: Send it to the **Coder agent** — one-line string change.
