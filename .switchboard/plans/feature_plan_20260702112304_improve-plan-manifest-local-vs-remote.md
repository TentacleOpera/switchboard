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
- Diffing the two files after editing to confirm the manifest sections are byte-identical.

### Complex / Risky
- None. This is a workflow-text-only change with no source code modifications.

## Edge-Case & Dependency Audit

### Race Conditions
- **Trigger B + local agent interaction**: a local agent that groups plans into an epic during `/improve-plan` MUST still write a manifest for Trigger B (epic links span multiple `.md` files and cannot be expressed via a single card move). However, it must NOT include a `kanbanColumn` override for Trigger A — the column transition stays user-initiated. The manifest should carry `kanbanColumn: "CREATED"` (or omit the field) so the stale-manifest guard in `PlanManifestService.ts` (lines 214-228) does not auto-move the card. This mirrors the `switchboard-chat.md` workflow's pattern for pure grouping manifests (line 42: `kanbanColumn: "CREATED"`).
- **Concurrent local + remote runs**: if two agents run `/improve-plan` on the same workspace — one local, one remote — the remote agent writes the manifest and the local agent does not. No conflict: the manifest is a single batch file written last, and the local agent simply doesn't contribute to it. The `PlanManifestService` ingestor (line 76) reads a single `manifest.json` per workspace; the remote agent's write is the only one.

### Security
- **Path traversal**: unchanged. The `PlanManifestService._applyEntry` method (lines 185-197) already rejects absolute paths and `..` traversal in `planFile`. No new attack surface is introduced by this workflow-text-only change.
- **Port file as trust signal**: the port file's presence indicates the extension was running, not that the agent is trusted. This is a detection heuristic, not a security boundary — a malicious agent could delete the port file to force manifest emission. This is not a new risk: the manifest is consumed by the existing ingestor which already validates all fields.

### Side Effects
- **Existing manifests in the wild**: any `manifest.json` files already written by previous local agent runs will still be ingested by `PlanManifestService` on the next scan. The change is prospective — it stops new manifests from being emitted locally. The ingestor deletes them after processing (`_safeDelete` at line 161), so they'll naturally clear.
- **Stale port file**: if the extension crashed without cleanup, the port file may be stale. This would cause a local agent to think it's local (correct — it is local, the extension just isn't running). The agent would skip the manifest, which is fine — the user can move the card when they restart the extension.
- **Agent host variability**: different agent hosts (Claude Code, Antigravity, Devin CLI) all read the same workflow file. The conditional must be expressed in plain English instructions, not host-specific code. The instruction "if you are running locally with the Switchboard extension active, do not write a manifest" is universally understandable.

### Dependencies & Conflicts
- **Port file as detection signal**: `.switchboard/api-server-port.txt` is written by the extension when the LocalApiServer starts (`TaskViewerProvider.ts` lines 1024-1035 — the write loop starting at line 1024, with `writeFile` at line 1029) and deleted on shutdown (lines 1108-1109, `unlink` at line 1109). Its presence is a reliable signal that the extension is running locally. The `sb_api_call.sh` script (line 62) already uses this for API discovery.
- **`switchboard-chat.md` Trigger B scoping**: the `switchboard-chat.md` workflow (line 30) already correctly limits Trigger B to "ONLY when you group plans into an epic." No change needed there. This plan only touches `improve-plan.md` and its mirror.
- **Scope boundary**: This plan owns the `improve-plan.md` Trigger A manifest conditional. The sibling plan "Pin Plan Project via .md Metadata" (`feature_plan_20260702130028_creator-manifest-project-pinning.md`) handles only creator-side project pinning via .md metadata (chat/memo prompts) and does NOT edit `improve-plan.md`. The two plans have zero file overlap.

## Dependencies

- `.agents/skills/_lib/sb_api_call.sh` — existing API server discovery mechanism (reads `.switchboard/api-server-port.txt` at line 62), referenced as the detection signal.
- `src/services/PlanManifestService.ts` — unchanged; still processes manifests when present. Confirmed: `_safeDelete` (line 161) deletes the manifest after all entries apply; staleness guard (lines 148-152) force-drops after ~3 min / 10 min cap. Stale-manifest guard for column override (lines 214-228) only applies `kanbanColumn` when the row is still at `CREATED`.
- `.agents/workflows/switchboard-chat.md` — already correctly scopes Trigger B (line 30); no change needed.
- `src/services/TaskViewerProvider.ts` — port file write at lines 1024-1035 (write loop, `writeFile` at line 1029), delete at lines 1108-1109 (`unlink` at line 1109). Unchanged by this plan.

## Adversarial Synthesis

Key risks: (1) the proposed "When to emit (remote only)" header contradicts the "Trigger B (all agents)" bullet — a local agent doing epic grouping may skip the manifest entirely or wrongly include a column override; (2) the port file is a liveness proxy, not a guaranteed "extension is running right now" signal (stale files possible after crashes). Mitigations: fix the header to "When to emit" with per-trigger scope labels; instruct local agents doing Trigger B to set `kanbanColumn: "CREATED"` (no column transition); the stale-port-file case is benign since the user can move the card manually on restart.

## Proposed Changes

### 1. `.agents/workflows/improve-plan.md` — Add local/remote conditional to manifest section

**Context:** Lines 89-128 contain the manifest section. Lines 89-96 (section header + intro + "When to emit" block) need replacement with a conditional. Lines 98-128 (schema, field rules, stale-manifest guard, Plan ID embedding) remain unchanged — they apply to the remote path and Trigger B.

**Logic:** Replace the unconditional "Always (Trigger A)" instruction with a local/remote split. Local agents skip the manifest for Trigger A (column transition) but still write one for Trigger B (epic grouping) if applicable. Remote agents write the manifest for both triggers.

**Implementation:** Replace lines 89-96 with:

```markdown
## Plan-Import Manifest (Trigger A — column transition)

After updating the plan `.md` file(s), the reviewed plan should land in the "PLAN REVIEWED" kanban column.

**Local agents (Switchboard extension running):** Do NOT write a manifest for the column transition. Simply update the plan file and inform the user that the review is complete. The user will move the card to "PLAN REVIEWED" in the extension UI when ready — that card move is what triggers the next pipeline stage.

**Remote agents (no Switchboard extension access):** Emit a **plan-import manifest** so the extension ingests the column transition on its next scan. To determine if you are remote: check whether `.switchboard/api-server-port.txt` exists in the workspace root (walk up from your current directory). If it does not exist, you are remote.

**When to emit:**
- **Trigger A (remote only):** you have adversarially reviewed a plan → set `kanbanColumn: "PLAN REVIEWED"`.
- **Trigger B (all agents):** if you restructured plans into an epic during review → include `isEpic`/`epicId` links for the epic + subtask set. Trigger B applies regardless of local/remote — epic relationships span multiple files and cannot be expressed via a single card move. **Local agents writing a Trigger B-only manifest:** set `kanbanColumn: "CREATED"` (or omit the field) so the ingestor does not auto-move the card — the user moves it manually.
- Pure plan creation with no review and no grouping → no manifest.
```

**Edge Cases:**
- A local agent that both reviews AND groups into an epic writes a manifest for Trigger B only, with `kanbanColumn: "CREATED"`. The user moves the card to "PLAN REVIEWED" manually after the epic links are ingested.
- A remote agent that reviews but does NOT group writes a manifest with `kanbanColumn: "PLAN REVIEWED"` and no epic fields.
- The rest of the manifest section (schema at lines 100-116, field rules at lines 118-124, stale-manifest guard at line 126, Plan ID embedding at line 128) remains unchanged.

### 2. `.claude/skills/improve-plan/SKILL.md` — Mirror the same conditional

**Context:** Lines 90-129 contain the identical manifest section, offset by 1 line due to the YAML frontmatter. This file is the Claude Code mirror of the workflow and must stay in sync.

**Logic:** Apply the identical replacement to lines 90-97 (section header + intro + "When to emit" block).

**Implementation:** Replace lines 90-97 with the same conditional text from Proposed Change 1 (the `## Plan-Import Manifest` header through the "Pure plan creation" bullet). Lines 99-129 (schema, field rules, stale-manifest guard, Plan ID embedding) remain unchanged.

**Edge Cases:** After editing, diff the manifest sections of both files to confirm they are byte-identical. Any drift between the workflow and its skill mirror is a bug.

### 3. No source code changes required

**Context:** The `PlanManifestService.ts`, `LocalApiServer.ts`, `KanbanDatabase.ts`, `TaskViewerProvider.ts`, and all other source files remain unchanged.

**Logic:** The manifest ingestion logic already handles manifests when present — including the stale-manifest guard that only overrides `kanbanColumn` when the row is still at `CREATED` (lines 214-228), and the `_safeDelete` that removes the manifest after processing (line 161). This is purely a workflow documentation fix.

**Implementation:** No code edits. No compilation needed.

**Edge Cases:** None — the ingestor is trigger-agnostic; it processes whatever manifest appears on disk. Reducing manifest emission for local agents simply means fewer manifests to process, not a code change.

## Verification Plan

### Automated Tests

No automated tests are required or applicable. This is a workflow-text-only change with no source code modifications — there is no code path to unit-test. The `PlanManifestService` ingestion logic is already tested by existing tests and is unchanged by this plan. Verification is manual (see below).

### Manual Verification

1. **Local agent test**: run `/improve-plan` in a VS Code terminal with the Switchboard extension active. Verify:
   - The agent updates the plan file and informs the user the review is complete.
   - No `manifest.json` file is written to `.switchboard/plans/`.
   - The user moves the card to "PLAN REVIEWED" in the UI when ready.

2. **Remote agent test**: simulate a remote agent by running in an environment without `.switchboard/api-server-port.txt`. Run `/improve-plan`. Verify:
   - The agent does not find `.switchboard/api-server-port.txt`.
   - The agent writes a `manifest.json` with `kanbanColumn: "PLAN REVIEWED"`.
   - On the next extension scan, `PlanManifestService` ingests the manifest and moves the card.
   - The `manifest.json` is deleted after ingestion (`_safeDelete` at PlanManifestService.ts line 161).

3. **Trigger B (local agent) test**: run `/improve-plan` locally and group plans into an epic during review. Verify:
   - The local agent writes a `manifest.json` with `isEpic`/`epicId` links but `kanbanColumn: "CREATED"` (no column auto-transition).
   - The `PlanManifestService` ingests the epic links but does NOT move the card (stale-manifest guard at lines 214-228 leaves it at `CREATED`).
   - The user moves the card to "PLAN REVIEWED" manually.

4. **Trigger B (remote agent) test**: run `/improve-plan` remotely and group plans into an epic during review. Verify:
   - The remote agent writes a `manifest.json` with both `kanbanColumn: "PLAN REVIEWED"` AND `isEpic`/`epicId` links.
   - The `PlanManifestService` ingests both the column transition and epic links.

5. **File sync check**: after editing both `.agents/workflows/improve-plan.md` and `.claude/skills/improve-plan/SKILL.md`, diff the manifest sections to confirm they are identical.

---

**Routing Recommendation:** Complexity 2 → **Send to Intern**. This is a trivial workflow-text-only change (two `.md` files, no source code, no compilation, no tests). The edits are mechanical copy-paste with a clear before/after block. An intern can execute this with the diff-check as the quality gate.
