# Grumpy Critique: Radical Airlock Simplification

**Target**: Airlock Simplification Implementation Plan

---

## CRITICAL

### C1 — Librarian Removal is Incomplete: `_computeDispatchReadiness` Will Throw at Runtime
**File**: `TaskViewerProvider.ts:353`

The plan says "remove librarian references from `_handleAgentAction`." That's barely half the job. `_computeDispatchReadiness` explicitly hard-codes `['lead', 'coder', 'reviewer', 'planner', 'analyst', 'librarian']` in its roles array. If `librarian` stays in that array after removal, the readiness object will contain a perpetually-unassigned key that pollutes every terminal-status message sent to the webview. If you remove it without updating the webview JS, the sidebar will silently break for users whose saved state still has a `librarian` role.

The plan does not mention `_computeDispatchReadiness` at all.

### C2 — `ContextBundler.ts` Exclusion Logic is Wrong for `.switchboard/airlock`
**File**: `ContextBundler.ts:11`

The current `EXCLUDED_DIRS` list works by checking **directory name components**, not full paths:
```ts
const EXCLUDED_DIRS = ['node_modules', 'dist', 'out', '.git', '.switchboard', '.web-ai'];
```
`.switchboard` is already in the exclusion list — so the entire `.switchboard/` subtree is **already excluded**. Adding `.switchboard/airlock` as a new entry is pointless. The real task is to **update the output path** in `bundleWorkspaceContext`. The plan conflates these two distinct actions and could easily result in a developer "fixing" the exclusion list without updating the output path — and then the bundle writes to the wrong location.

### C3 — No Migration for Users Who Already Have `.web-ai`
The plan deletes all code that creates or references `.web-ai`. Fine. But there is zero mention of what happens to users who **already have a `.web-ai` directory** in their workspace from a previous Airlock export. Their `.gitignore` will still have `.web-ai/` and their outbox files will be orphaned. The plan is silent on migration. This is a silent state corruption for existing users.

---

## MAJOR

### M1 — `bundleWorkspaceContext` Signature Break
**File**: `ContextBundler.ts:32`

The current signature is `bundleWorkspaceContext(workspaceRoot: string): Promise<string>`. The plan changes the output directory from `.web-ai/outbox` to `.switchboard/airlock/`. If this is done by hardcoding a new path inside the bundler, the function becomes untestable and has hidden coupling. If the caller passes the path in, the plan needs to specify the new call site in `_handleWebAiExport`. Neither option is discussed. **The plan does not address the function signature.**

### M2 — Timestamp Format Not Specified
The plan says "append a timestamp" to the bundle filename. What format? `YYYYMMDD_HHMMSS` is stated in one sentence but then immediately implied to be runtime-variable (`[timestamp]` in the prompt body). If the `how_to_plan.md` references a static filename pattern, it will be wrong the moment the format changes. It should use a glob pattern (`codebase-bundle-*.md`) and instruct the reader to use the **most recent** file, not a hardcoded name.

### M3 — `how_to_plan.md` Will Be Overwritten on Every Export
The plan says `how_to_plan.md` is written every time the Airlock Export runs. If a user customizes the file, it gets blown away silently. The old code had the same issue with prompts but they were numbered templates nobody was expected to edit. A file called `how_to_plan.md` implies it's a living document. If it's generated from code, it should either be namespaced (e.g. `.switchboard/airlock/how_to_plan.generated.md`) or the code should check for existence and skip.

### M4 — The Plan Mentions a Non-Existent Function: `_handleAirlockExport`
The plan says "Refactor `_handleWebAiExport` to `_handleAirlockExport`." There is no evidence the existing message handler in the webview (`webai_export` message type) is being updated. If the function is renamed but the webview still sends `webai_export` messages, the sidebar button silently does nothing. The plan must include renaming the message type in `implementation.html` as well.

### M5 — `extension.ts` Librarian References Are Not Fully Enumerated
**File**: `extension.ts:2129`

The plan mentions removing `Librarian` from the agent grid array at line 1224. But `extension.ts:2129` also has a separate `roles` array: `['lead', 'coder', 'analyst', 'reviewer', 'librarian']`. This is used in a different path. The plan does not enumerate this second reference. Removing only one of the two means `librarian` silently lingers in role processing code.

---

## NIT

### N1 — "Remove .web-ai" is Not a Deliverable, It's a Side Effect
The plan lists "Remove .web-ai" as a structural action item. In reality, the code change is "update all path references from `.web-ai` to `.switchboard/airlock`." You can't actually delete user directories from code at install time. The phrasing creates ambiguity about whether a file-system cleanup step is expected.

### N2 — 20MB Bundle Cap is Arbitrary and Not Justified
Why 20MB? 5MB was previously "arbitrary." The critique of "arbitrary small" is valid, but replacing with another round number without justification is the same error. The size cap should be configurable or at least documented in a constant with a comment explaining the reasoning.

### N3 — Plan Does Not Address `_serializeActivePlan` and `_writePromptTemplates` Dead Code
After removal, `_serializeActivePlan`, `_writePromptTemplates`, and `_deriveKanbanColumn` become dead code. The plan does not explicitly list these for deletion. Dead code that references removed fields (like `planRegistry`) will still compile but create confusion. They must be explicitly called out for deletion.
