# Fix Manifest Silent-Failure: Bare Filenames Rejected + Rejections Invisible

**Plan ID:** a3f2c1d8-7e4b-4f9a-8c2d-1e6b5a4f3d07

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, refactor, docs

---

## Goal

Fix the plan-import manifest's silent-failure mode: bare filenames in `planFile` are silently
rejected (manifest consumed + deleted, entry vanishes, no visible signal), and the workflow
instructions that tell agents to write manifests show misleading path examples that cause the
bug.

### Core problems & root-cause analysis

1. **Bare filenames silently rejected by the path security check.**
   `PlanManifestService._applyEntry` (line 189-197) resolves `path.resolve(workspaceRoot,
   entry.planFile)`. A bare filename like `part0-directive-scope-bugfix.md` resolves to
   `<workspaceRoot>/part0-directive-scope-bugfix.md` — the workspace root, NOT inside
   `.switchboard/plans/`. The `insidePlans` check fails, the entry returns `'applied'` (meaning
   "skip, treat as handled"), and the manifest is consumed and deleted. No error, no deferred
   retry — the entry silently vanishes.

2. **Even if the path check passed, the DB lookup would fail.**
   `getPlanByPlanFile("part0-directive-scope-bugfix.md", workspaceId)` calls
   `_ensureRelativePlanFile()` which returns bare relative paths unchanged. The DB stores
   `.switchboard/plans/part0-directive-scope-bugfix.md` (full relative path). The SQL
   `WHERE plan_file = 'part0-directive-scope-bugfix.md'` returns no rows → the entry defers
   forever until the staleness guard drops it (~3 minutes).

3. **All rejection paths return `'applied'`, not `'deferred'` or an error.**
   Missing `planFile` (line 180), path traversal (line 187), outside plans/epics (line 196) — all
   return `'applied'`. The manifest consume logic counts these as "handled", deletes the manifest,
   and moves on. There is no `'rejected'` state, no rejected count, and no visible signal to the
   user that entries were skipped.

4. **Rejection logs go to the VS Code Output Channel only.**
   `GlobalPlanWatcherService._processManifest` (line 845) passes `(msg) =>
   this._outputChannel?.appendLine(msg)` as the log callback. The Output Channel is invisible
   unless the user opens the Output panel and selects the Switchboard channel. No toast, no board
   signal, no visible warning.

5. **Workflow instructions show misleading path examples.**
   `improve-plan.md` line 106 and `switchboard-chat.md` line 31 show:
   ```
   "planFile": "feature_plan_20260630_foo.md"
   ```
   — a bare filename. But the DB stores `.switchboard/plans/feature_plan_20260630_foo.md`. The
   epic example on the same line shows `.switchboard/epics/epic-<uuid>.md` (full path). An agent
   following the examples uses bare filenames for plans and full paths for epics — exactly the
   pattern that triggers the silent rejection.

---

## User Review Required

No — this is a pure bugfix + doc correction with no product-scope decisions.

## Complexity Audit

### Routine
- Workflow/doc fixes: update path examples in 4 files (2 workflows + 2 skill mirrors).
- Adding a `'rejected'` return type + rejected count to `ManifestApplyResult`.

### Complex / Risky
- Auto-resolve logic in `_applyEntry`: must not break the existing path-traversal security check
  or the epics path handling. The auto-resolve must only prepend `.switchboard/plans/` when the
  path is a bare filename (no directory separator, no `.switchboard/` prefix).

## Edge-Case & Dependency Audit

- **Race Conditions:** none — manifest processing is synchronous per cycle.
- **Security:** the auto-resolve must NOT weaken the path-traversal guard. A bare filename like
  `../evil.md` still contains `..` and is rejected before auto-resolve runs. A bare filename like
  `part0.md` becomes `.switchboard/plans/part0.md` — safe, inside the plans dir.
- **Side Effects:** existing manifests with full paths (`.switchboard/plans/foo.md`) continue to
  work unchanged — the auto-resolve only fires when the path doesn't already contain
  `.switchboard/`.
- **Dependencies & Conflicts:** none — isolated to `PlanManifestService.ts` + 4 doc files.

## Dependencies

- None. Independent bugfix.

## Proposed Changes

### `src/services/PlanManifestService.ts`

**Context:** `_applyEntry` (line 168-281) validates + applies each manifest entry. The path
security check at line 189-197 rejects bare filenames silently. The return type is
`'applied' | 'deferred'` — no `'rejected'` state.

**Logic:**

1. **Auto-resolve bare filenames to `.switchboard/plans/<filename>`** — add BEFORE the path
   security check (after the missing-planFile guard at line 178-181):
   ```typescript
   // Auto-resolve bare filenames: the manifest lives in .switchboard/plans/, so a
   // bare planFile like "foo.md" refers to .switchboard/plans/foo.md. Without this,
   // path.resolve(workspaceRoot, "foo.md") lands in the workspace root and the
   // insidePlans check silently rejects it.
   let resolvedPlanFile = entry.planFile;
   if (!path.isAbsolute(resolvedPlanFile)
       && !resolvedPlanFile.includes('/')
       && !resolvedPlanFile.includes('\\')
       && !resolvedPlanFile.startsWith('.switchboard/')) {
       resolvedPlanFile = `.switchboard/plans/${resolvedPlanFile}`;
   }
   ```
   Then use `resolvedPlanFile` in place of `entry.planFile` for the rest of `_applyEntry`
   (the path resolve, the `getPlanByPlanFile` lookup, the `movePlanByPlanFile` call, etc.).

2. **Add a `'rejected'` return type** — change the signature to
   `Promise<'applied' | 'deferred' | 'rejected'>`. Return `'rejected'` from the three
   currently-silent-skip paths (missing planFile, path traversal, outside plans/epics).

3. **Track rejected count in `ManifestApplyResult`** — add `rejected: number` to the interface.
   In `applyManifest`, count `'rejected'` returns separately from `'applied'` and `'deferred'`.

4. **Don't consume the manifest if entries were rejected** — in `applyManifest`, if
   `result.rejected > 0`, do NOT delete the manifest (treat like `anyDeferred`: retain for retry).
   This gives the user a chance to notice the problem. The staleness guard will eventually drop
   it, but the rejected count will be visible in the log + notification (see next change).

5. **Surface rejections via the log callback as a visible summary** — at the end of
   `applyManifest`, if `result.rejected > 0`, log a prominent summary:
   ```typescript
   log?.(`[PlanManifest] ⚠️ ${result.rejected} entr${result.rejected === 1 ? 'y' : 'ies'} REJECTED (invalid path/planFile). Manifest retained. Check planFile paths — must be bare filename or .switchboard/plans/<name>.md or .switchboard/epics/<name>.md.`);
   ```

**Edge Cases:** epics with `.switchboard/epics/` prefix are unaffected (the auto-resolve only
fires for paths without `.switchboard/`). Full-path plan entries
(`.switchboard/plans/foo.md`) are unaffected (already contain `/`).

### `src/services/GlobalPlanWatcherService.ts`

**Context:** `_processManifest` (line 835-850) calls `applyManifest` with an output-channel log
callback. Rejections are invisible to the user.

**Logic:** after `applyManifest` returns, if `result.rejected > 0`, show a VS Code warning
notification:
```typescript
const result = await this._manifestService.applyManifest(
    workspaceRoot, workspaceId, db,
    (msg) => this._outputChannel?.appendLine(msg)
);
if (result.rejected > 0) {
    vscode.window.showWarningMessage(
        `Switchboard: ${result.rejected} manifest entr${result.rejected === 1 ? 'y' : 'ies'} rejected (invalid planFile path). Check the Output panel for details.`
    );
}
```

**Edge Cases:** `vscode` is already imported in this file (line 16 uses `vscode.OutputChannel`).
No new import needed.

### `.agents/workflows/improve-plan.md` + `.claude/skills/improve-plan/SKILL.md`

**Context:** Line 106 shows `"planFile": "feature_plan_20260630_foo.md"` (bare filename).

**Logic:** change the example to use the full relative path:
```json
"planFile": ".switchboard/plans/feature_plan_20260630_foo.md"
```

Also update the field rules (line 119) to be explicit:
```
- `planFile` (**required**): path relative to workspace root, as stored in the DB.
  Must be `.switchboard/plans/<name>.md` for plans or `.switchboard/epics/<name>.md` for epics.
  Bare filenames (e.g. `foo.md`) are auto-resolved to `.switchboard/plans/foo.md` but the
  full path is preferred. No `..` or absolute paths.
```

### `.agents/workflows/switchboard-chat.md` + `.claude/skills/switchboard-chat/SKILL.md`

**Context:** Line 31 references the manifest schema with the same bare-filename example.

**Logic:** same fix as improve-plan.md — update the example and field rules to use full
`.switchboard/plans/` paths.

## Verification Plan

### Automated Tests
- **SKIP for this session** per session directives. Tests to author for the separate run:
  - Manifest with bare filename `part0.md` → auto-resolved to `.switchboard/plans/part0.md`,
    column override applied, not rejected.
  - Manifest with full path `.switchboard/plans/part0.md` → works as before (no regression).
  - Manifest with `.switchboard/epics/epic-foo.md` → works as before (no auto-resolve, no
    regression).
  - Manifest with `../evil.md` → rejected (path traversal), `rejected` count = 1, manifest NOT
    deleted.
  - Manifest with missing `planFile` → rejected, `rejected` count = 1.

### Manual / Static Verification (this session)
- **Compilation SKIP** per session directives.
- Static cross-check (done during review): confirmed `_applyEntry` path check (line 189-197),
  `_ensureRelativePlanFile` (line 6250-6286), `getPlanByPlanFile` (line 2932-2951), and the
  workflow example paths against current source.
- Pre-merge checklist: grep for any new `confirm(`/`window.confirm` — forbidden per CLAUDE.md.

## Acceptance
- A manifest with bare filenames in `planFile` auto-resolves to `.switchboard/plans/<name>.md`
  and applies successfully (column override, epic links, project, status).
- A manifest with rejected entries (invalid path, missing planFile) does NOT get silently
  consumed — the manifest is retained, a warning notification is shown, and the rejected count
  appears in the output channel log.
- Full-path entries (`.switchboard/plans/foo.md`, `.switchboard/epics/epic-foo.md`) continue to
  work unchanged.
- Workflow instructions show full `.switchboard/plans/` paths in examples and field rules.

## Recommendation

Complexity 5 → **Send to Coder.** Isolated to one service file + one watcher file + four doc
files. The auto-resolve logic is the only non-trivial part; the rest is mechanical.
