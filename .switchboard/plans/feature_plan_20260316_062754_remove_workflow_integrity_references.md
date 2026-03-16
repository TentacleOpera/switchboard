# Remove workflow integrity references

## Notebook Plan

I jsut saw an agent try to access the workflow_integrity.md file. does that exist? if it does not, remove references to it. If it exists, leave them in place.

## Goal
- The file `.agent/rules/WORKFLOW_INTEGRITY.md` **does exist** (49 lines). It contains strict execution rules for agent workflows (atomic execution, anti-simulation, proof of work, etc.).
- However, the only source-code reference is in `src/mcp-server/workflows.js` line 13, inside the `accuracy` workflow's `init` step: `"Initialize task.md and read WORKFLOW_INTEGRITY.md"`. This instruction tells agents to read the file but does **not** specify a path — agents may look for it at the workspace root or in `.agent/workflows/` instead of the actual location `.agent/rules/WORKFLOW_INTEGRITY.md`.
- **Decision**: Since the file exists, references should be **kept** but **corrected** to use the full path so agents can actually find it.

## Proposed Changes

### Step 1 — Fix the path reference in workflows.js (Routine)
- **File**: `src/mcp-server/workflows.js`
- **Line 13**: Change `"Initialize task.md and read WORKFLOW_INTEGRITY.md"` → `"Initialize task.md and read .agent/rules/WORKFLOW_INTEGRITY.md"`
- This is the **only** source-code reference to WORKFLOW_INTEGRITY; no other files need changing.

### Step 2 — Verify no other dangling references (Routine)
- Run a project-wide search for `WORKFLOW_INTEGRITY` (case-insensitive) across all files excluding `node_modules/` and `.git/`.
- Confirm the only hits are:
  1. `.agent/rules/WORKFLOW_INTEGRITY.md` (the file itself)
  2. `src/mcp-server/workflows.js` (the fixed reference)
- If any additional references are found, update them to use the correct `.agent/rules/WORKFLOW_INTEGRITY.md` path.

## Verification Plan
1. `grep -ri "WORKFLOW_INTEGRITY" --include="*.ts" --include="*.js" --include="*.md" .` — confirm only the two expected hits remain.
2. Compile/build the extension (`npm run compile`) — confirm no regressions.
3. Open a Switchboard session, trigger the `accuracy` workflow, and verify the agent can locate and read the file at the corrected path.

## Complexity Audit

### Band A — Routine
- Fix one string literal in `workflows.js` (single-line change)
- Grep verification

### Band B — Complex / Risky
- None

**Recommendation**: Send it to the **Coder agent** — this is a single-line string fix with a grep verification.
