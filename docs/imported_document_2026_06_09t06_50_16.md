# Worktrees Tab — UX Concerns

### 1. Hidden Status
The worktree state only hydrates when you click the **WORKTREES** tab. There is no visual indicator on the Kanban board itself telling you *"you're currently working in a worktree"* while you scroll cards. You could easily forget and wonder why your agents' edits aren't showing up in the workspace root.

### 2. Jargon Mismatch
The tab is labelled **"WORKTREES"** but the entire backend uses **"safety session"** terminology (`active_safety_session_branch`, `startSafetySession`, `mergeSafetySession`). A user who knows git might get it; a PM or designer probably won't. There's no tooltip or inline explanation of what a worktree actually *is* beyond the small text block.

### 3. The "test" Tab
Right next to **WORKTREES** is a lowercase `test` tab (`:2284`). It looks like a dev artifact, which undermines confidence in the whole tab bar.

### 4. No Progress States
Buttons disable for 5 seconds via `setTimeout`, then re-enable regardless of whether the operation actually finished. If `git worktree add` is slow, the button becomes clickable again while the command is still running. No spinner, no "Creating..." state.

### 5. Merge Failure Handling is Weak
`mergeSafetySession` runs three git commands back-to-back. If `git merge` produces conflicts, it throws, shows a toast, and stops — but the DB record is still active. You're left with a half-merged repo and the UI still says **"ACTIVE WORKTREE."** There's no "resolve conflicts" guidance or retry path.

### 6. "Ask Agent to Merge" is Confusing
Next to the fully automatic **MERGE BACK** button sits **ASK AGENT TO MERGE**, which just copies a prompt to your clipboard. It's unclear when you'd choose this over the automatic option. Two buttons with similar names but wildly different behaviours.

### 7. Non-Descriptive Branch Names
Every worktree is `switchboard-safety-YYYY-MM-DD`. If you create two in one day, you get `-2`, `-3`. There's no way to name it `feature-login-refactor`, so your git history becomes opaque.

### 8. No Diff Preview Before Merge
You click **MERGE BACK** and it immediately runs `git merge --no-ff`. There's no review step — no file list, no change count, no confirmation beyond the generic button click.

### 9. Control Plane Banner is Contextually Odd
When no control plane is configured, the worktree tab shows an info banner saying agents will run in the workspace root. This is true, but it introduces an unrelated concept (control plane) into a tab about git worktrees.

### 10. "Remember Choice" is Invisible
The checkbox remembers your terminal behaviour, but there's no UI showing *what* is remembered or a way to clear it without clearing the whole session record.