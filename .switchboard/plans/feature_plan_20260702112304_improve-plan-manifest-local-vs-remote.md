# Fix /improve-plan Manifest Prompting for Local Agents

**Plan ID:** b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e

## Goal

### Problem

The `/improve-plan` workflow keeps prompting agents to write a plan-import manifest (`manifest.json`) even when they are running locally. The manifest is only meant for **remote agents** — agents that have no access to the Switchboard extension UI. For local agents, the manifest is unnecessary: the agent updates the plan file, and the user moves the card in the extension UI when they're ready to advance the pipeline. Nothing happens automatically when a plan file is written — card moves are user-initiated UI actions that trigger prompts for the next pipeline stage.

### Background Context

The plan-import manifest system was introduced in `feature_plan_20260630_plan-import-db-manifest.md`. Its purpose: let **remote** agents signal kanban column transitions when they can't interact with the extension UI. A remote agent writes a JSON sidecar (`.switchboard/plans/manifest.json`) that the `PlanManifestService` (src/services/PlanManifestService.ts) ingests on the next scan cycle, applying column/status/epic/project overrides, then deleting the file.

The manifest has two triggers:
- **Trigger A (column transition):** After `/improve-plan` adversarially reviews a plan, the card should move to "PLAN REVIEWED". For remote agents, the manifest carries this column override since they can't move the card themselves.
- **Trigger B (epic grouping):** When plans are grouped into an epic, the manifest carries `isEpic`/`epicId` links that span multiple `.md` files.

The `switchboard-chat.md` workflow already correctly scopes Trigger B to "ONLY when you group plans into an epic" — it does not prompt for manifests on pure consultation. But `improve-plan.md` says "**Always (Trigger A):**" with no local/remote conditional.

### Root Cause Analysis

The workflow file `.agents/workflows/improve-plan.md` (lines 89-128) and its mirror `.claude/skills/improve-plan/SKILL.md` (lines 90-129) contain the instruction:

> **Always (Trigger A):** you have adversarially reviewed a plan → set `kanbanColumn: "PLAN REVIEWED"`.

The word "Always" is the root cause. There is **no conditional logic** to distinguish:
- **Local agent**: the Switchboard extension is running. The agent writes the plan file and stops. The user moves the card in the UI when ready. The agent should NOT write a manifest.
- **Remote agent**: the extension is not accessible. The agent writes the plan file AND a manifest so the extension knows to move the card on next scan.

The `sb_api_call.sh` library (`.agents/skills/_lib/sb_api_call.sh`, line 62) already discovers the API server by walking up the directory tree looking for `.switchboard/api-server-port.txt`. If the file doesn't exist, the script fails — meaning the agent is remote. This same discovery mechanism can serve as the conditional: if the port file exists, the agent is local; if not, it's remote.

No separate `/improve-plan-remote` skill exists or is needed. The manifest section is the only part that differs between local and remote; the rest of the workflow (load, improve, adversarial review, update plan) is identical. A conditional within the existing workflow is simpler and avoids maintaining two near-identical copies.

## Metadata

- **Tags:** bugfix, docs
- **Complexity:** 2

## User Review Required

Yes — confirm the detection approach: should the agent check for `.switchboard/api-server-port.txt` to determine local vs remote? Or should the workflow simply say "if you are running inside VS Code with the Switchboard extension, do not write a manifest" and trust the agent to know its environment?

## Complexity Audit

### Routine
- Editing the manifest section text in `.agents/workflows/improve-plan.md` (lines 89-128) to add a local/remote conditional.
- Editing the identical manifest section in `.claude/skills/improve-plan/SKILL.md` (lines 90-129) to match.

### Complex / Risky
- None. This is a workflow-text-only change with no source code modifications.

## Edge-Case & Dependency Audit

1. **Trigger B (epic grouping) is unaffected**: the manifest for epic grouping is still needed regardless of local/remote, because epic relationships span multiple `.md` files and cannot be expressed in a single file's front-matter. The conditional only applies to Trigger A (column transition). The `switchboard-chat.md` workflow already correctly limits Trigger B to epic grouping only — no change needed there.

2. **Existing manifests in the wild**: any `manifest.json` files already written by previous local agent runs will still be ingested by `PlanManifestService` on the next scan. The change is prospective — it stops new manifests from being emitted locally. The ingestor deletes them after processing, so they'll naturally clear.

3. **Agent host variability**: different agent hosts (Claude Code, Antigravity, Devin CLI) all read the same workflow file. The conditional must be expressed in plain English instructions, not host-specific code. The instruction "if you are running locally with the Switchboard extension active, do not write a manifest" is universally understandable.

4. **Port file as detection signal**: `.switchboard/api-server-port.txt` is written by the extension when the LocalApiServer starts (TaskViewerProvider.ts line 1024) and deleted on shutdown (line 1108). Its presence is a reliable signal that the extension is running locally. The `sb_api_call.sh` script already uses this for API discovery.

5. **Stale port file**: if the extension crashed without cleanup, the port file may be stale. This would cause a local agent to think it's local (correct — it is local, the extension just isn't running). The agent would skip the manifest, which is fine — the user can move the card when they restart the extension.

## Dependencies

- `.agents/skills/_lib/sb_api_call.sh` — existing API server discovery mechanism (reads `.switchboard/api-server-port.txt`), referenced as the detection signal.
- `src/services/PlanManifestService.ts` — unchanged; still processes manifests when present.
- `.agents/workflows/switchboard-chat.md` — already correctly scopes Trigger B; no change needed.
- **Scope boundary**: This plan owns the `improve-plan.md` Trigger A manifest conditional. The sibling plan "Pin Plan Project via .md Metadata" (`feature_plan_20260702130028_creator-manifest-project-pinning.md`) handles only creator-side project pinning via .md metadata (chat/memo prompts) and does NOT edit `improve-plan.md`. The two plans have zero file overlap.

## Proposed Changes

### 1. `.agents/workflows/improve-plan.md` — Add local/remote conditional to manifest section

Replace lines 89-96 (the "When to emit" block) with a conditional:

```markdown
## Plan-Import Manifest (Trigger A — column transition)

After updating the plan `.md` file(s), the reviewed plan should land in the "PLAN REVIEWED" kanban column.

**Local agents (Switchboard extension running):** Do NOT write a manifest. Simply update the plan file and inform the user that the review is complete. The user will move the card to "PLAN REVIEWED" in the extension UI when ready — that card move is what triggers the next pipeline stage.

**Remote agents (no Switchboard extension access):** Emit a **plan-import manifest** so the extension ingests the column transition on its next scan. To determine if you are remote: check whether `.switchboard/api-server-port.txt` exists in the workspace root (walk up from your current directory). If it does not exist, you are remote.

**When to emit (remote only):**
- **Trigger A:** you have adversarially reviewed a plan → set `kanbanColumn: "PLAN REVIEWED"`.
- **Trigger B (all agents):** if you restructured plans into an epic during review → include `isEpic`/`epicId` links for the epic + subtask set. Trigger B applies regardless of local/remote — epic relationships span multiple files and cannot be expressed via a single card move.
- Pure plan creation with no review and no grouping → no manifest.
```

The rest of the manifest section (schema, field rules, stale-manifest guard, Plan ID embedding — lines 98-128) remains unchanged. It only applies to the remote path and Trigger B.

### 2. `.claude/skills/improve-plan/SKILL.md` — Mirror the same conditional

Apply the identical change to lines 90-129 of `.claude/skills/improve-plan/SKILL.md`. This file is the Claude Code mirror of the workflow and must stay in sync.

### 3. No source code changes required

The `PlanManifestService.ts`, `LocalApiServer.ts`, `KanbanDatabase.ts`, and all other source files remain unchanged. The manifest ingestion logic already handles manifests when present. This is purely a workflow documentation fix.

## Verification Plan

1. **Local agent test**: run `/improve-plan` in a VS Code terminal with the Switchboard extension active. Verify:
   - The agent updates the plan file and informs the user the review is complete.
   - No `manifest.json` file is written to `.switchboard/plans/`.
   - The user moves the card to "PLAN REVIEWED" in the UI when ready.

2. **Remote agent test**: simulate a remote agent by running in an environment without `.switchboard/api-server-port.txt`. Run `/improve-plan`. Verify:
   - The agent does not find `.switchboard/api-server-port.txt`.
   - The agent writes a `manifest.json` with `kanbanColumn: "PLAN REVIEWED"`.
   - On the next extension scan, `PlanManifestService` ingests the manifest and moves the card.
   - The `manifest.json` is deleted after ingestion.

3. **Trigger B unaffected**: run `/improve-plan` and group plans into an epic during review. Verify:
   - Both local and remote agents emit a manifest with `isEpic`/`epicId` links (Trigger B applies regardless of environment).

4. **File sync check**: after editing both `.agents/workflows/improve-plan.md` and `.claude/skills/improve-plan/SKILL.md`, diff the manifest sections to confirm they are identical.
