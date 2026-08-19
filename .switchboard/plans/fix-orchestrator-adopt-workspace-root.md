# Orchestrator adopt call drops workspaceRoot — orchestrator scopes to the wrong workspace

## Goal

The `/switchboard` launcher workflow calls `POST /orchestration/adopt` with only `terminalName` in the body — it does not pass `workspaceRoot`. The server's adopt handler falls back to `this._options.workspaceRoot` (set at server construction time to whatever workspace root was effective then). In a multi-root window where `Documents/Gitlab` is the first folder or the Kanban provider's current selection, the orchestrator prompt gets `WORKSPACE_ROOT=/Users/patrickvuleta/Documents/Gitlab` instead of the workspace the user launched `/switchboard` from. The orchestrator then reads the wrong kanban database, reports wrong card counts (15 to code, 59 to plan from the wrong workspace), and proposes goals for plans that are not in this workspace.

Fix the propagation chain so the orchestrator always receives the workspace root the user intended: pass `workspaceRoot` explicitly in the adopt curl body, add a server-side diagnostic when the fallback fires, and add a pre-flight verification step so the orchestrator catches a mismatch before acting on it.

### Problem analysis and root cause

Observed 2026-08-19: user ran `/switchboard` from the `GitHub/switchboard` workspace. The orchestrator reported `WORKSPACE_ROOT=/Users/patrickvuleta/Documents/Gitlab` and card counts (15 to code, 59 to plan) that belong to the Gitlab workspace, not switchboard.

The machine has four workspace folders open (confirmed by `GET /health`):

```
roots": [
  "/Users/patrickvuleta/Documents/Gitlab",
  "/Users/patrickvuleta/Documents/GitHub/switchboard",
  "/Users/patrickvuleta/Documents/Gitlab/analytics-dashboard",
  "/Users/patrickvuleta/Documents/GitHub/pixel-spritesheet-studio"
]
```

`Documents/Gitlab` is listed first. The resolution chain:

1. **Workflow** (`.agents/workflows/switchboard.md:93-94`): The adopt curl sends `{"terminalName": "..."}` — no `workspaceRoot` field. The workflow already has `ROOT="$PWD"` from Step 1 but does not include it in the body.

2. **Server handler** (`LocalApiServer.ts:3156`): `const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;` — `body.workspaceRoot` is undefined, so it falls back to `this._options.workspaceRoot`.

3. **Server options** (`TaskViewerProvider.ts:3081`): `workspaceRoot: effectiveRoot` — set at construction time from `_resolveWorkspaceRoot()` which delegates to `this._kanbanProvider?.getCurrentWorkspaceRoot()`, falling back to `orderedRoots[0]` (the first workspace folder). If the Kanban provider's selection is the Gitlab root, or if no selection is set and Gitlab is first, that's what gets baked in.

4. **Adopt callback** (`TaskViewerProvider.ts:11010`): `const root = this._resolveWorkspaceRoot(workspaceRoot)` — re-resolves, but since the server passed its `this._options.workspaceRoot` (a valid root), it passes through unchanged.

5. **Prompt builder** (`TaskViewerProvider.ts:10773`): `WORKSPACE_ROOT=${root}` — the wrong root is injected into the orchestrator prompt.

The fix is at layer 1 (pass `workspaceRoot` explicitly) with defense-in-depth at layers 2 and 4 (log the fallback, verify in pre-flight).

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, api, reliability

## User Review Required

The pre-flight workspace-root check (change #2) adds a new behavior to the orchestrator skill: the orchestrator will stop and report a mismatch if `WORKSPACE_ROOT` does not match `$PWD`. This affects all orchestrator sessions (adopt, start, and resume doors), not just the adopt path being fixed. Review whether stopping on mismatch is the desired behavior for the AUTOMATION tab's start door, where the orchestrator terminal's cwd is set by `startOrchestratorFromKanban` rather than by the user's shell.

## Complexity Audit

### Routine
- Adding a `workspaceRoot` field to an existing curl body in a workflow markdown file.
- Adding a `console.warn` diagnostic to an existing handler in `LocalApiServer.ts`.
- Adding a pre-flight check section to the orchestrator skill markdown.
- Updating the endpoint documentation table in the orchestration skill markdown.

### Complex / Risky
- The pre-flight check runs on all orchestrator doors (adopt, start, resume), not just the adopt path being fixed. A false-positive on the start door (where the terminal cwd is set by the system, not the user) would block legitimate orchestrator sessions. Mitigated by using `pwd -P` for symlink-safe comparison and by the check being a report-and-stop, not a silent failure.

## Edge-Case & Dependency Audit

**Race Conditions** — none. The adopt call is a single synchronous HTTP request. The workspace root is resolved at request time and injected into the prompt response. No concurrent state mutation is involved.

**Security** — the `workspaceRoot` field is passed through `_resolveWorkspaceRoot`, which validates it against the allowed-roots set (`TaskViewerProvider.ts:3913-3920`). A caller cannot inject an arbitrary path — only roots already in the workspace's allowed list are accepted. Unrecognized roots fall through to the Kanban provider's selection.

**Side Effects** — the server-side `console.warn` (change #3) writes to the diagnostics channel on every adopt call that omits `workspaceRoot`. In single-root windows this fires on every `/switchboard` launch. The warning is benign but noisy if the workflow is not updated. After change #1, the workflow always passes `workspaceRoot`, so the warning is silent in the normal path.

**Dependencies & Conflicts** —
- **Single-root windows** — the fallback to `this._options.workspaceRoot` is correct when there is only one root. The warning (change #3) fires but is benign. No behaviour change.
- **Multi-root windows** — the fix ensures the caller's `$PWD` is passed explicitly. If `$PWD` is a subdirectory of a workspace root (not the root itself), `_resolveWorkspaceRoot` at `TaskViewerProvider.ts:3913-3920` checks whether the resolved path is in the allowed roots list — if it is not, it falls through to the Kanban provider's selection. This is the existing behaviour and is correct: a subdirectory resolves to its parent workspace root through the allowed-roots check.
- **Standalone mode** — `bootstrap.ts:2480` constructs the server with `workspaceRoot` from the CLI `--workspace` flag (resolved at `bootstrap.ts:188`). The adopt handler's fallback to `this._options.workspaceRoot` is correct here (single root). The warning fires but is benign.
- **`POST /orchestration/start`** — the start endpoint (`LocalApiServer.ts:3199`) has the same fallback pattern. It is called by the AUTOMATION tab button, which routes through `KanbanProvider.ts:9000-9003` where `msg.workspaceRoot` is resolved via `_resolveWorkspaceRoot`. The resolution falls back to the Kanban provider's current selection (the board's active workspace), which is the correct root for a UI-launched session. No change needed — the start path already resolves to the board's current selection.
- **`POST /orchestration/confirm`** — same fallback pattern. The confirm call is made by the orchestrator agent after the pre-flight, using the `WORKSPACE_ROOT` from its prompt. If the prompt carries the wrong root (the bug this plan fixes), confirm also operates on the wrong root. Fixing the adopt call fixes confirm transitively, since the agent reads `WORKSPACE_ROOT` from the adopt response prompt.
- **Claude mirror** — `.claude/skills/switchboard/SKILL.md` is auto-generated from `.agents/workflows/switchboard.md` by `ClaudeCodeMirrorService.ts` (regenerated on version change). The source-of-truth fix in `.agents/workflows/switchboard.md` is sufficient; the mirror will pick it up on the next regeneration. A manual mirror edit is a temporary patch that will be overwritten on the next sync — it is optional, not required.

## Dependencies

- None. The workflow file change is self-contained. The server-side warning is a console.warn addition. The pre-flight check is a new section in the orchestrator skill.

## Adversarial Synthesis

Key risks: (1) the pre-flight check's `pwd` comparison can false-positive on symlinked paths (common on macOS iCloud/CloudStorage mounts) — mitigated by using `pwd -P` on both sides; (2) the check runs on all orchestrator doors, not just adopt — a false-positive on the start door would block legitimate sessions, but the check is report-and-stop (not silent), and the start door's terminal cwd is set to the workspace root by `startOrchestratorFromKanban`; (3) the server warning is noisy in single-root windows if the workflow is not updated — mitigated by change #1 which always passes `workspaceRoot`. Mitigations: symlink-safe `pwd -P` comparison, correct placement as a gating pre-check before the six checks, and the warning being silent in the normal post-fix path.

## Proposed Changes

### 1. `.agents/workflows/switchboard.md` — pass workspaceRoot in the adopt body

**Context:** Step 2 of the launcher workflow (lines 93-94) sends the adopt curl with only `terminalName`. The workflow already captures `ROOT="$PWD"` in Step 1 (line 26) but does not include it in the request body.

**Logic:** Add `"workspaceRoot": "$ROOT"` to the curl body so the server receives the caller's actual workspace root instead of falling back to its construction-time default.

**Implementation:**

Line 93-94, add `workspaceRoot` to the curl body:

```bash
curl -s -X POST "$BASE/orchestration/adopt" -H "Content-Type: application/json" \
  -d "{\"terminalName\": \"${SWITCHBOARD_TERMINAL:-}\", \"workspaceRoot\": \"$ROOT\"}"
```

**Edge Cases:** `$ROOT` is set to `$PWD` at the start of Step 1. If the user runs `/switchboard` from a subdirectory of a workspace root, `$ROOT` will be the subdirectory. The server's `_resolveWorkspaceRoot` handles this: it checks the allowed-roots set and falls through to the Kanban provider's selection if the subdirectory is not a root itself (see Edge-Case & Dependency Audit). No additional handling needed.

### 2. `.agents/skills/switchboard-orchestrator/SKILL.md` — add workspace root verification to pre-flight

**Context:** The orchestrator skill's Pre-flight section (line 134) has six checks that run against the workspace's kanban database. If `WORKSPACE_ROOT` is wrong, all six checks evaluate against the wrong workspace. A workspace-root verification must run BEFORE the six checks as a gating pre-check — if the workspace is wrong, the subsequent checks are meaningless.

**Logic:** Add a workspace-root pre-check before "### The six checks" (before line 167). The check compares `WORKSPACE_ROOT` from the prompt to the orchestrator's actual `$PWD` using symlink-safe `pwd -P` on both sides. If they don't match, report the mismatch and stop — do not run the six checks against the wrong workspace.

> **Superseded:** Place the check "after the port discovery check."
> **Reason:** There is no port discovery check in the pre-flight section. The six checks are about teams, planners, researchers, worktree strategy, work availability, and loose plans. Port discovery happens before the pre-flight, in the launching workflow. The check must run BEFORE the six checks as a gating pre-check.
> **Replaced with:** Place the check before "### The six checks" as a gating pre-check.

**Implementation:**

Insert before "### The six checks" (line 167):

```markdown
### Workspace root check

Your prompt carries `WORKSPACE_ROOT=<path>`. Before running the six checks below,
verify it matches the directory you are running in. Use symlink-safe comparison
(`pwd -P` on both sides) to avoid false positives on macOS iCloud/CloudStorage
symlinked paths:

```bash
if [ "$(cd "$WORKSPACE_ROOT" && pwd -P)" != "$(pwd -P)" ]; then
  echo "WORKSPACE_ROOT ($WORKSPACE_ROOT) does not match the current directory ($PWD)."
  echo "The orchestrator may be scoping to the wrong workspace."
  echo "Call POST /orchestration/adopt with the correct workspaceRoot before proceeding."
  echo "Do not run the pre-flight checks against the wrong workspace."
  exit 1
fi
```

If the check fails, report the mismatch to the user and stop — do not proceed
with the six checks or propose a goal. The user must re-launch with the correct
workspace root.
```

> **Superseded:** Use `$(cd "$WORKSPACE_ROOT" && pwd)` vs `$(pwd)` for the comparison.
> **Reason:** `pwd` without `-P` compares logical paths, which can differ when the workspace root path contains a symlink (common on macOS where `~/Documents` may be a symlink to `~/Library/CloudStorage/...`). This would false-positive on the very machines this bug was observed on.
> **Replaced with:** Use `pwd -P` on both sides of the comparison to resolve symlinks before comparing.

**Edge Cases:** This check runs on all three doors (adopt, start, resume). In the start door, the orchestrator terminal's cwd is set by `startOrchestratorFromKanban` — if it sets the cwd to the workspace root (the expected behavior), the check passes. If it doesn't, the check catches a real misconfiguration. In resume mode, the check still runs — a resumed session should be in the same workspace it was started in. The `exit 1` is a hard stop; the orchestrator reports the mismatch and does not proceed. This is intentional: running checks against the wrong workspace produces misleading results that are worse than stopping.

### 3. `src/services/LocalApiServer.ts` — log when workspaceRoot falls back to the server default

**Context:** The adopt handler at line 3156 resolves `workspaceRoot` from the request body, falling back to `this._options.workspaceRoot`. When the body omits `workspaceRoot`, the fallback is silent — there is no diagnostic indicating the server default was used instead of an explicit caller-provided root.

**Logic:** Split the resolution into an explicit check and a fallback, and emit a `console.warn` when the fallback fires. The warning is non-breaking — the fallback is legitimate in single-root mode. In multi-root windows, it surfaces the misconfiguration in the diagnostics channel.

**Implementation:**

In `_handleOrchestrationAdopt` (line 3156), replace the single-line resolution with:

```ts
const explicitRoot = String(body?.workspaceRoot || '').trim();
const workspaceRoot = (explicitRoot || String(this._options.workspaceRoot || '').trim()) || undefined;
if (!explicitRoot && workspaceRoot) {
    console.warn(
        `[LocalApiServer] orchestration/adopt: no workspaceRoot in body, ` +
        `falling back to server default "${workspaceRoot}". ` +
        `The caller should pass workspaceRoot explicitly to avoid multi-root mismatches.`
    );
}
```

**Edge Cases:** In single-root windows, the warning fires on every adopt call that omits `workspaceRoot`. After change #1, the workflow always passes `workspaceRoot`, so the warning is silent in the normal `/switchboard` path. The warning is benign — it does not change the response or the behavior, only the diagnostics output.

### 4. `.agents/skills/switchboard-orchestration/SKILL.md` — document workspaceRoot as required in the adopt endpoint

**Context:** The endpoint table entry for `POST /orchestration/adopt` (line 132) documents `workspaceRoot?` as optional but does not explain the multi-root risk of omitting it.

**Logic:** Update the table entry to note that `workspaceRoot` should be passed explicitly in multi-root windows, and that omitting it falls back to the server's default root (which may not match the caller's workspace).

**Implementation:**

Update the endpoint table entry for `POST /orchestration/adopt` to add a note after the existing description:

> Pass `workspaceRoot` explicitly in multi-root windows. Omitting it falls back to the server's construction-time default root, which may not match the caller's workspace — the orchestrator would then scope to the wrong kanban database.

**Edge Cases:** None — this is a documentation-only change.

## Verification Plan

### Manual
1. Open a multi-root window with `Documents/Gitlab` as the first folder and `Documents/GitHub/switchboard` as the second.
2. `cd` to the switchboard workspace and run `/switchboard`.
3. Verify the adopt curl body includes `"workspaceRoot": "/Users/patrickvuleta/Documents/GitHub/switchboard"`.
4. Verify the orchestrator prompt carries `WORKSPACE_ROOT=/Users/patrickvuleta/Documents/GitHub/switchboard`.
5. Verify the card counts match the switchboard workspace, not Gitlab.
6. Check the diagnostics channel for the fallback warning — it should NOT fire when `workspaceRoot` is passed explicitly.
7. Run `/switchboard` from the Gitlab workspace. Verify the orchestrator scopes to Gitlab correctly (the fix is symmetric).
8. Verify the pre-flight workspace-root check passes silently when `WORKSPACE_ROOT` matches `$PWD`.
9. Simulate a mismatch (e.g. manually set `WORKSPACE_ROOT` to a different workspace) and verify the check reports the mismatch and stops.

### Automated Tests
- `npm run compile-tests` must be clean for `LocalApiServer.ts`.
- `npm run test:contract:orchestrator-tick` — exercises the adopt/dispatch paths. The contract test at `orchestrator-tick-and-reports-contract.test.js:324-338` verifies step 2 calls `POST /orchestration/adopt` and does NOT call `POST /orchestration/start`. Adding `workspaceRoot` to the body does not break these assertions — the test checks for the URL pattern, not the body fields. Establish pre-existing pass/fail counts before starting.

**Recommendation:** Complexity 3 → **Send to Intern.**
