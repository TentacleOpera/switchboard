# Fix Epic Worktree Button Visibility

## Goal

Fix the worktree button (⎇) not appearing on epic cards in the kanban board.

## Core Problem

The worktree button on epic cards uses `class="btn-icon"` but there is no CSS defined for `.btn-icon` in `kanban.html`. The existing pattern throughout the codebase uses `.card-btn.icon-btn` which has proper styling defined at line 769-772. As a result, the button renders but is invisible due to missing CSS.

## Metadata

- **Tags:** frontend, ui, bugfix
- **Complexity:** 1

## User Review Required

- None. Change is localized and follows an established pattern already used for other card buttons.

## Complexity Audit

### Routine
- Single-file, single-line class name change
- Uses existing `.card-btn.icon-btn` CSS pattern; no new styles required
- No JavaScript logic changes
- Low risk, small scope

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Static markup/CSS class change.
- **Security:** None. No user input is processed by this change.
- **Side Effects:** The button becomes visually visible where it was previously invisible. No functional behavior changes.
- **Dependencies & Conflicts:** None. The `.card-btn.icon-btn` rules are defined in the same file (`src/webview/kanban.html` lines 769–776).

## Dependencies

- None

## Adversarial Synthesis

Key risks: Inline style conflicts with the new CSS class rules (padding, background) and theme contrast for `color:inherit`. Mitigations: Remove conflicting inline styles (`background`, `border`, `padding`) before applying the class change; verify visibility in both light and dark themes during manual check.

## Proposed Changes

### File: `src/webview/kanban.html`

**Line 4994:** Change the worktree button class from `btn-icon` to `card-btn icon-btn` to use the existing CSS pattern.

**Before:**
```javascript
: ` <button class="btn-icon" title="Create Worktree for this epic"
   onclick="postKanbanMessage({type:'createWorktreeForEpic', epicId:'${escapeAttr(card.planId)}', epicTopic:'${escapeAttr(card.topic)}', workspaceRoot:currentWorkspaceRoot})"
   style="opacity:0.6; font-size:10px; cursor:pointer; background:none; border:none; color:inherit; padding: 2px 4px; margin-left: 5px;">⎇</button>`;
```

**After:**
```javascript
: ` <button class="card-btn icon-btn" title="Create Worktree for this epic"
   onclick="postKanbanMessage({type:'createWorktreeForEpic', epicId:'${escapeAttr(card.planId)}', epicTopic:'${escapeAttr(card.topic)}', workspaceRoot:currentWorkspaceRoot})"
   style="opacity:0.6; font-size:10px; cursor:pointer; background:none; border:none; color:inherit; padding: 2px 4px; margin-left: 5px;">⎇</button>`;
```

## Risks

None. This is a single-line CSS class change that aligns with the existing pattern used throughout the file.

## Verification Plan

### Manual Steps
1. Reload the kanban board
2. Navigate to an epic card
3. Verify the ⎇ button is visible in the card header (next to the epic badge)
4. Click the button and verify it creates a worktree
5. Verify that after worktree creation, the button changes to a branch chip

### Automated Tests
- Not applicable. Kanban HTML is rendered inside a VS Code webview; no existing test harness covers DOM visibility assertions for this view. Manual verification required.

## Recommendation

Complexity 1 → **Send to Intern**
