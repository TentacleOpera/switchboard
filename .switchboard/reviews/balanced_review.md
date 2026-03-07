# Balanced Review: Radical Airlock Simplification

## Summary of Review

The plan is directionally correct and solves a real complexity problem. The simplification goals are well-defined. However, several technical execution gaps were identified. The main risks are: incomplete Librarian removal creating residual dead references, the `ContextBundler.ts` exclusion logic misunderstanding, and the webview message type not being updated for the renamed export handler. None of these are showstoppers for the overall direction, but all will cause runtime bugs if unaddressed.

---

## Valid Concerns

### [HIGH] C1 — `_computeDispatchReadiness` Librarian Leak
`TaskViewerProvider.ts:353` hard-codes `librarian` in its roles array. This must be updated. Leaving it will pollute every terminal-status message. **Accept and fix.**

### [HIGH] C2 — `ContextBundler.ts` Exclusion Logic Misunderstood
`.switchboard` is already excluded from the bundle. The plan should NOT add a new exclusion entry for `.switchboard/airlock` — it's already covered. The only change needed in `ContextBundler.ts` is the **output path constant** and the **filename timestamp format**. **Accept and clarify the plan.**

### [HIGH] M4 — Webview Message Type Not Updated
If `_handleWebAiExport` is renamed, the webview message handler type (`webai_export`) in `implementation.html` must also be updated, or the export button will silently break. **Accept and add to scope.**

### [MEDIUM] M5 — Second `librarian` Array in `extension.ts:2129`
There is a separate `roles` array on line 2129 in `extension.ts` that also includes `librarian`. The plan only addresses line 1224. Both must be removed. **Accept and add to scope.**

### [MEDIUM] M3 — `how_to_plan.md` Overwrite Risk
The file should be written with an existence check (`if (!fs.existsSync(howToPlanPath))`). This preserves user customizations. **Accept.**

### [MEDIUM] N3 — Dead Code: `_serializeActivePlan`, `_writePromptTemplates`, `_deriveKanbanColumn`
These functions become dead code after the removal. They should be explicitly deleted. **Accept and add to scope.**

---

## Action Plan

**Priority 1 — Correctness (must fix before execution):**
1. Add `_computeDispatchReadiness` to the list of Librarian references **to remove `librarian` from the roles array**.
2. Clarify `ContextBundler.ts` change: do NOT add a new `EXCLUDED_DIRS` entry. Only update the output path and filename format.
3. Add the webview message type rename to the scope (`webai_export` → e.g. `airlock_export` or keep as-is and only rename the handler).
4. Add `extension.ts:2129` `librarian` reference to the removal list.

**Priority 2 — Quality (implement as part of execution):**
5. Add an existence check when writing `how_to_plan.md` to avoid overwriting customizations.
6. Explicitly call out `_serializeActivePlan`, `_writePromptTemplates`, and `_deriveKanbanColumn` for deletion.

**Priority 3 — Nice-to-have (not blocking):**
7. Document the 20MB cap reasoning in a code comment.
8. In `how_to_plan.md`, reference the bundle using a glob pattern (`codebase-bundle-*.md`, use the most recent) rather than a static filename.

---

## Dismissed Points

- **M1 (Function Signature Break)**: Valid concern but implementation detail. The caller in `_handleWebAiExport` controls the path; no signature change is needed since the path can be passed or internally derived. Not a plan flaw.
- **N1 (Remove .web-ai phrasing)**: Pedantic. Developers understand this means "update all references." Fine to keep the current phrasing.
- **N2 (Arbitrary 20MB cap)**: Worth a comment in code, but not a blocker. Dismissed from plan-level scope.
- **C3 (Migration for existing .web-ai users)**: Out-of-scope for this simplification task. Existing `.web-ai` directories are no-ops once the code stops creating them. A follow-up `.gitignore` cleanup note added to the prompt is sufficient.
