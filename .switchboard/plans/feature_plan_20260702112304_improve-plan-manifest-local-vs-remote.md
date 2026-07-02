# Fix /improve-plan Manifest Prompting for Local Agents

**Plan ID:** b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e

## Goal

### Problem

The `/improve-plan` workflow keeps prompting agents to write a plan-import manifest (`manifest.json`) even when they are running locally — i.e., inside VS Code with the Switchboard extension active. The manifest system was designed for **remote agents** that write plan files to disk and need a sidecar to signal kanban column transitions, because they have no direct access to the extension's API server or database. For local agents, the manifest is unnecessary noise: the extension is running, the API server is reachable, and the agent can move the kanban card directly via the `kanban_operations` skill.

### Background Context

The plan-import manifest system was introduced in `feature_plan_20260630_plan-import-db-manifest.md`. Its purpose: let externally-authored plans land in the correct kanban column on import instead of defaulting to `CREATED`. The manifest is a JSON sidecar (`.switchboard/plans/manifest.json`) that the `PlanManifestService` (src/services/PlanManifestService.ts) ingests on the next scan cycle, applying column/status/epic/project overrides, then deleting the file.

The manifest has two triggers:
- **Trigger A (column transition):** After `/improve-plan` adversarially reviews a plan, it should move the card to "PLAN REVIEWED". The manifest carries this column override.
- **Trigger B (epic grouping):** When plans are grouped into an epic, the manifest carries `isEpic`/`epicId` links that span multiple `.md` files.

The `switchboard-chat.md` workflow already correctly scopes Trigger B to "ONLY when you group plans into an epic" — it does not prompt for manifests on pure consultation. But `improve-plan.md` says "**Always (Trigger A):**" with no local/remote conditional.

### Root Cause Analysis

The workflow file `.agents/workflows/improve-plan.md` (lines 89-128) and its mirror `.claude/skills/improve-plan/SKILL.md` (lines 90-129) contain the instruction:

> **Always (Trigger A):** you have adversarially reviewed a plan → set `kanbanColumn: "PLAN REVIEWED"`.

The word "Always" is the root cause. There is **no conditional logic** to distinguish:
- **Local agent**: the Switchboard extension is running, `.switchboard/api-server-port.txt` exists, the API server is reachable at `localhost:{port}`. The agent can use `kanban_operations` (move-card.js) or the `/kanban/move` API endpoint to move the card directly.
- **Remote agent**: the extension is not running (or the agent has no access to localhost). The agent can only write files to disk. The manifest is the sole mechanism to signal a column transition.

The `sb_api_call.sh` library (`.agents/skills/_lib/sb_api_call.sh`, line 62) already discovers the API server by walking up the directory tree looking for `.switchboard/api-server-port.txt`. If the file doesn't exist, the script fails with a clear error. This same discovery mechanism can be used as the conditional: if the port file exists, the agent is local; if not, it's remote.

No separate `/improve-plan-remote` skill exists or is needed. The manifest section is the only part that differs between local and remote; the rest of the workflow (load, improve, adversarial review, update plan) is identical. A conditional within the existing workflow is simpler and avoids maintaining two near-identical copies.

## Metadata

- **Tags:** bugfix, backend, docs
- **Complexity:** 3

## User Review Required

Yes — confirm the preferred approach: (a) conditional within the existing workflow (recommended — one file to maintain, agent auto-detects local vs remote), or (b) separate `/improve-plan-remote` skill (two files, explicit user choice). Also confirm that for local agents, using the `kanban_operations` skill to move the card to "PLAN REVIEWED" is the desired replacement for the manifest — vs. leaving the card in CREATED and letting the user move it manually.

## Complexity Audit

### Routine
- Editing the manifest section text in `.agents/workflows/improve-plan.md` (lines 89-128) to add a local/remote conditional.
- Editing the identical manifest section in `.claude/skills/improve-plan/SKILL.md` (lines 90-129) to match.
- The detection mechanism (check for `.switchboard/api-server-port.txt`) is already implemented in `sb_api_call.sh` — the workflow text just needs to instruct the agent to use it.

### Complex / Risky
- None. This is a documentation/workflow-text change with no source code modifications. The `PlanManifestService` ingestion logic remains unchanged — it still processes manifests when they appear. The change only affects when the workflow instructs the agent to emit one.

## Edge-Case & Dependency Audit

1. **Port file exists but API server is unreachable**: the port file may be stale (extension crashed without cleanup). The `sb_api_call.sh` script already handles this — it attempts a health check (`curl /health`) and retries. If the server is truly unreachable, the agent should fall back to emitting a manifest. The workflow text should instruct: "If the port file exists but the API server is unreachable, fall back to emitting a manifest."

2. **Multi-root workspaces**: the port file is written to all workspace roots (TaskViewerProvider.ts line 1023-1024). The agent's `sb_api_call.sh` walks up from `$PWD` to find it. No change needed — the discovery mechanism already handles this.

3. **Trigger B (epic grouping) is unaffected**: the manifest for epic grouping is still needed regardless of local/remote, because epic relationships span multiple `.md` files and cannot be expressed in a single file's front-matter. The conditional only applies to Trigger A (column transition). The `switchboard-chat.md` workflow already correctly limits Trigger B to epic grouping only — no change needed there.

4. **Existing manifests in the wild**: any `manifest.json` files already written by previous local agent runs will still be ingested by `PlanManifestService` on the next scan. The change is prospective — it stops new manifests from being emitted locally, but doesn't clean up existing ones. The ingestor deletes them after processing, so they'll naturally clear.

5. **Agent host variability**: different agent hosts (Claude Code, Antigravity, Devin CLI) all read the same workflow file. The conditional must be expressed in plain English instructions, not host-specific code. The instruction "check if `.switchboard/api-server-port.txt` exists" is universally executable.

6. **`kanban_operations` skill availability**: the skill is listed in AGENTS.md and the skill files exist at `.agents/skills/kanban_operations/`. The move-card.js script uses the same `sb_api_call.sh` discovery mechanism. For local agents, the workflow should instruct using this skill to move the card to "PLAN REVIEWED" instead of writing a manifest.

7. **Stale-manifest guard interaction**: the `PlanManifestService` stale-manifest guard (line 126 of improve-plan.md) only overrides the column when the row is still at `CREATED`. If the local agent already moved the card via `kanban_operations`, and then a stale manifest is somehow present, the guard prevents a double-move. No conflict.

## Dependencies

- `.agents/skills/_lib/sb_api_call.sh` — existing API server discovery mechanism (reads `.switchboard/api-server-port.txt`).
- `.agents/skills/kanban_operations/move-card.js` — existing card-move script for local agents.
- `src/services/PlanManifestService.ts` — unchanged; still processes manifests when present.
- `.agents/workflows/switchboard-chat.md` — already correctly scopes Trigger B; no change needed.

## Proposed Changes

### 1. `.agents/workflows/improve-plan.md` — Add local/remote conditional to manifest section

Replace lines 89-96 (the "When to emit" block) with a conditional that distinguishes local from remote:

```markdown
## Plan-Import Manifest (Trigger A — column transition)

After updating the plan `.md` file(s), move the reviewed plan to the "PLAN REVIEWED" kanban column. This is the completion gate: the column move signals "agent done, pipeline may advance."

**How to move the card — detect your environment first:**

### Local agent (Switchboard extension running)
Check whether `.switchboard/api-server-port.txt` exists in the workspace root (walk up from your current directory). If it exists, the extension's LocalApiServer is running and you can move the card directly:

Use the `kanban_operations` skill (move-card.js) to move the card to "PLAN REVIEWED":
```bash
node .agents/skills/kanban_operations/move-card.js <plan-file-name> "PLAN REVIEWED"
```
**Do NOT emit a manifest.** The direct card move is immediate and authoritative.

### Remote agent (no Switchboard extension)
If `.switchboard/api-server-port.txt` does NOT exist (or the API server is unreachable after retry), you are running remotely. Emit a **plan-import manifest** so the extension ingests the column transition on its next scan:

**When to emit:**
- **Always (Trigger A):** you have adversarially reviewed a plan → set `kanbanColumn: "PLAN REVIEWED"`.
- **Also (Trigger B):** if you restructured plans into an epic during review → include `isEpic`/`epicId` links for the epic + subtask set. (Trigger B applies regardless of local/remote — epic relationships span multiple files and cannot be expressed via a single card move.)
- Pure plan creation with no review and no grouping → no manifest.
```

The rest of the manifest section (schema, field rules, stale-manifest guard, Plan ID embedding — lines 98-128) remains unchanged. It only applies to the remote path.

### 2. `.claude/skills/improve-plan/SKILL.md` — Mirror the same conditional

Apply the identical change to lines 90-129 of `.claude/skills/improve-plan/SKILL.md`. This file is the Claude Code mirror of the workflow and must stay in sync.

### 3. `.agents/workflows/improve-plan.md` — Add fallback instruction

After the remote agent section, add a fallback note:

```markdown
**Fallback:** If `.switchboard/api-server-port.txt` exists but the API server is unreachable (health check fails after 3 retries), fall back to emitting a manifest as described in the Remote agent section above. Do not leave the card in CREATED if you have completed the review.
```

### 4. No source code changes required

The `PlanManifestService.ts`, `LocalApiServer.ts`, `KanbanDatabase.ts`, and all other source files remain unchanged. The manifest ingestion logic already handles manifests when present, and the `kanban_operations` skill already handles direct card moves. This is purely a workflow documentation fix.

## Verification Plan

1. **Local agent test**: run `/improve-plan` in a VS Code terminal with the Switchboard extension active. Verify:
   - The agent checks for `.switchboard/api-server-port.txt` and finds it.
   - The agent uses `kanban_operations` (move-card.js) to move the card to "PLAN REVIEWED".
   - No `manifest.json` file is written to `.switchboard/plans/`.
   - The kanban board shows the card in "PLAN REVIEWED" immediately.

2. **Remote agent test**: simulate a remote agent by temporarily renaming `.switchboard/api-server-port.txt` (or running in an environment without the extension). Run `/improve-plan`. Verify:
   - The agent does not find `.switchboard/api-server-port.txt`.
   - The agent writes a `manifest.json` with `kanbanColumn: "PLAN REVIEWED"`.
   - On the next extension scan, `PlanManifestService` ingests the manifest and moves the card.
   - The `manifest.json` is deleted after ingestion.

3. **Trigger B unaffected**: run `/improve-plan` and group plans into an epic during review. Verify:
   - Both local and remote agents emit a manifest with `isEpic`/`epicId` links (Trigger B applies regardless of environment).

4. **Fallback test**: with the extension running but the API server stopped (kill the server process, leave the port file), run `/improve-plan`. Verify:
   - The agent detects the port file, attempts to use `kanban_operations`, fails to reach the API server.
   - The agent falls back to emitting a manifest.

5. **Stale manifest cleanup**: verify that any existing `manifest.json` files from previous local runs are still ingested and deleted by `PlanManifestService` on the next scan — no manual cleanup needed.

6. **File sync check**: after editing both `.agents/workflows/improve-plan.md` and `.claude/skills/improve-plan/SKILL.md`, diff the manifest sections to confirm they are identical.
