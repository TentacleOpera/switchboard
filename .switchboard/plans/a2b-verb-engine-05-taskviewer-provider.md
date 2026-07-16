---
description: "Verb Engine subtask 5: TaskViewerProvider burndown — migrate its 110 arms in place onto seams with returned results, collapse dispatch, delete shims. The sidebar/terminal surface: plan selection, per-role dispatch, memo, onboarding — heaviest TerminalBackend coupling of the five."
---

# Verb Engine · 5 — TaskViewerProvider Burndown (110 arms)

## Goal

Make every `TaskViewerProvider` verb host-agnostic: all 110 arms run on injected seams, return their results in the HTTP body (push kept additive), and dispatch through the generic allowlist+schema registry; the provider's shims are deleted.

**Problem / context:** TaskViewer is the Implementation Sidebar's backend — plan selection and creation, clipboard plan import, per-role terminal dispatch, memo capture, onboarding, agent status. It has the heaviest `TerminalBackend` coupling of the five providers (dispatch routing, terminal registry, heartbeat/status semantics), so its arms are where the terminal seam earns its keep. Terminal *output* readability is explicitly not expected here — that arrives only with B3's node-pty backend; the seam contract is fire-and-track. See `a2b-verb-engine-01-foundations.md` for the pattern and `a2b-genuine-verb-extraction-burndown.md` for the design record.

## Metadata
- **Tags:** backend, refactor, api, cli
- **Complexity:** 7
- **Release phase:** After Verb Engine 1. Parallelizable with other provider subtasks (one agent stream per provider file).

## User Review Required
- None — contract and pattern fixed in subtask 1.

## Scope

### ✅ IN SCOPE
- Migrate all 110 arms in place: `vscode.*` / `executeCommand` / raw `postMessage` → seam / domain-service / broadcaster calls; add `return` of each arm's result without reordering side effects.
- Dispatch arms (`triggerAgentAction`, terminal sends, `/clear` pacing) route exclusively through `TerminalBackend` and the subtask-1 dispatch service — no direct `vscode.window.createTerminal` / `sendText` in any arm.
- Clipboard plan import arms (`importPlanFromClipboard`, multi-plan split, NotebookLM import) migrate intact — the `--- PLAN ---` splitter and HTML→markdown conversion are pure logic; only the clipboard *read* goes behind a seam.
- Memo arms (save/clear/generate-prompt) migrate with their guaranteed-capture semantics unchanged.
- Collapse the per-verb switch onto the generic registry; per-verb input schemas.
- Delete `taskViewerService`'s string-keyed shims; keep genuinely shared domain logic only.

### ⚙️ OUT OF SCOPE
- Other providers. node-pty terminal backend / readable terminal output (B3). Onboarding UI changes. New verbs or behavior changes.

## Implementation Steps
1. Batch ~20–30 arms; migrate in place per the subtask-1 recipe; `compile-tests` gate between batches; merge incrementally.
2. Migrate the dispatch/terminal arm cluster as one coherent batch (registry, pending-dispatch state, recoverable routes) so status semantics stay reviewable.
3. Delete shims; confirm parity gate reports TaskViewer at 110/110, 0 shims.

## Complexity Audit
### Routine
- Plan CRUD and memo arms — swap + return.
### Complex / Risky
- **Dispatch semantics:** pending-dispatch marking, recoverable routes, worktree-terminal routing, `/clear` pacing delays — sidebar status dots and dispatch buttons depend on exact state transitions; provider tests must pass unchanged.
- **Clipboard seam:** the import path must behave identically when the clipboard read comes through the seam (200 KB cap, HTML fallback ordering).

## Dependencies
- Verb Engine 1 (TerminalBackend usage pattern, dispatch domain service, seams, dispatcher, test harness).

## Verification Plan
### Automated
- Provider tests pass unchanged. All 110 arms pass under the test-seam bundle. Ratchet: 110/110, 0 shims.
### Manual / behavioral
- From the sidebar: select a plan, dispatch to Planner and Coder, clear a terminal, import a multi-plan clipboard, save/process a memo — identical behavior; dispatch verbs invoked via `POST /taskViewer/verb/<name>` return readable results.
