# Task Batch: Verify Plan Recovery Titles

## Context
The goal is to fix the bug where the "Recover Plans" sidebar displays plans as `(untitled)` or generic `Implementation Plan`. 

## Current State
The backend extraction logic in `src/services/TaskViewerProvider.ts` (`_getRecoverablePlans`) has been rewritten. It now explicitly reads the raw Markdown `H1` topic directly from the filesystem because previously completed/archived plans only had empty strings in the registry.

The new fallback chain for reading the plan file is:
1. `brainSourcePath` (Original location)
2. `[sessionDir]/completed/[filename]` (Where plans are moved on completion)
3. `.switchboard/plans/antigravity_plans/[mirror]` (The workspace mirror)

## Pending Execution
1. Compile the extension (`npm run compile`).
2. Reload the VS Code Extension Host window.
3. Open the Switchboard sidepanel, click the "Recover Plans" (trash can) icon.
4. Verify that the recovered plans list now displays full, descriptive H1 titles (e.g. `Implementation Plan: Improve Plan Recovery Titles`) instead of generic fallbacks.

If the titles are correct, the task is complete. No further code changes should be required.
