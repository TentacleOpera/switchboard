# Jules Runner Skill

This skill enables the agent to act as a "Jules Runner," managing asynchronous software development tasks using the Jules CLI.

## Capabilities

1.  **Create Tasks:** Start new coding sessions with `jules remote new`.
2.  **Check Status:** Monitor progress with `jules remote list`.
3.  **Apply Changes:** Pull completed work as patches and apply them to the codebase.

## Prerequisites

-   **Jules CLI:** Must be installed (`npm install -g @google/jules`).
-   **Authentication:** User must be logged in via `jules login`.
-   **Git:** Repository must be a git repo with a valid remote origin.

## Workflows

### 1. Creating a New Task

**Trigger:** User asks to "start a task," "fix this bug," or "implement feature X" using Jules.

**Steps:**
1.  **Identify Repository:**
    -   Get remote URL: `git config --get remote.origin.url`
    -   Extract `username/repo_name`.
    -   *Fallback:* Ask user for `username/repo_name` if detection fails.
2.  **Start Session:**
    -   Command: `jules remote new --repo <repo_name> --session "<task_description>"`
3.  **Report:**
    -   Output the **Session ID** and **Console URL**.
    -   Instruct user to check status with `/jules status`.

### 2. Checking Status

**Trigger:** User asks "status of task," "is it done?", or `/jules status`.

**Steps:**
1.  **List Sessions:** `jules remote list --session`
2.  **Report:** Display the table of active/completed sessions.
3.  **Actionable Advice:**
    -   If **Awaiting Feedback**: "Please provide feedback at [URL]."
    -   If **Completed**: "Task <ID> is done. Shall I apply the changes?"

### 3. Applying Changes (The "Pull & Patch" Flow)

**Trigger:** User says "apply session <ID>," "pull changes," or confirms a completed task.

**Steps:**
1.  **Pull Diff:**
    -   Create temp dir: `mkdir .jules` (ignore if exists).
    -   Download patch: `jules remote pull --session <session_id> > .jules/diff.patch`
2.  **Verify:**
    -   Read first 20 lines of `.jules/diff.patch`.
    -   Check if file paths match current project structure.
    -   *If mismatch:* Warn user and abort.
3.  **Apply:**
    -   **Option A (Current Branch):**
        -   `git apply .jules/diff.patch`
        -   *Handling Errors:* If `git apply` fails, try `patch -p1 < .jules/diff.patch`.
    -   **Option B (New Branch):**
        -   `git checkout -b <branch_name>`
        -   `git apply .jules/diff.patch`
        -   `git commit -am "Apply Jules changes for session <ID>"`
4.  **Cleanup:**
    -   `rm -rf .jules`
    -   Report success to user.

## Error Handling

-   **Command Not Found:** If `jules` fails, try `npx @google/jules` or check `%APPDATA%
pm\jules.cmd`.
-   **Auth Errors:** If 401/403, tell user to run `jules login`.
-   **Patch Failures:** If `git apply` fails, likely due to drift. Suggest manual merge or `patch` utility.
