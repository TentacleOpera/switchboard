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

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the original "retain rejected manifest for retry" design would
have caused an infinite re-toast loop every 10s scan cycle because the staleness guard only
fires on `anyDeferred`, not `rejected` — rejected entries are permanent, so the fix is to
consume + warn once, not retain; (2) the plans-only auto-resolve silently misroutes bare
`epic-*.md` filenames to `.switchboard/plans/` and re-creates the silent-drop bug for the epic
case — mitigated by a defensive log warning and doc emphasis that epics must use the full
`.switchboard/epics/` prefix; (3) the path-traversal check must run on `resolvedPlanFile`
post-auto-resolve or the security ordering becomes ambiguous. Mitigations: consume-not-retain
model, epic-misroute warning, explicit ordering spec, and `showWarningMessage` confirmed as a
passive toast (not a CLAUDE.md-banned confirm dialog).

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
   Then use `resolvedPlanFile` in place of `entry.planFile` for **the rest of `_applyEntry`** —
   including the path-traversal/absolute check at line 185 (which must run on `resolvedPlanFile`
   AFTER auto-resolve, so a bare `..evil.md` becomes `.switchboard/plans/..evil.md` and is still
   caught by the `includes('..')` guard), the `path.resolve` at line 189, the
   `getPlanByPlanFile` lookup, the `movePlanByPlanFile` call, and every other downstream use.

   **Plans-only limitation (documented, not a defect):** auto-resolve prepends
   `.switchboard/plans/` unconditionally for bare filenames. Epics are stored under
   `.switchboard/epics/epic-<uuid>.md`. If an agent ever writes a bare epic filename
   (e.g. `epic-foo.md`), auto-resolve misroutes it to `.switchboard/plans/epic-foo.md` —
   it passes `insidePlans`, fails `getPlanByPlanFile` (no row), returns `deferred`, and is
   staleness-dropped after ~3 min. This recreates the silent-failure for the epic case. The
   workflow docs already mandate full `.switchboard/epics/` paths for epics, so this is
   defensive only, but add a cheap log warning when a bare filename matches `/^epic-/i` so
   the misroute is at least visible in the Output channel rather than silent:
   ```typescript
   if (/^epic-/i.test(resolvedPlanFile) && !resolvedPlanFile.startsWith('.switchboard/epics/')) {
       log?.(`[PlanManifest] ⚠️ Bare epic-looking filename '${entry.planFile}' auto-resolved to plans/ — epics must use the full .switchboard/epics/ prefix. This entry will likely defer-then-drop.`);
   }
   ```

2. **Add a `'rejected'` return type** — change the signature to
   `Promise<'applied' | 'deferred' | 'rejected'>`. Return `'rejected'` from the three
   currently-silent-skip paths (missing planFile, path traversal, outside plans/epics).

3. **Track rejected count in `ManifestApplyResult`** — add `rejected: number` to the interface.
   In `applyManifest`, count `'rejected'` returns separately from `'applied'` and `'deferred'`.

4. **Surface rejections, then CONSUME the manifest (do NOT retain for retry)** —
   rejected entries are **permanent** failures (invalid path / missing planFile never
   self-heals), unlike `deferred` which is transient (file not on disk yet). Retaining a
   rejected-only manifest for retry is incoherent AND dangerous: the staleness guard at
   `PlanManifestService.ts:141-157` only increments inside `if (anyDeferred)`, so a
   rejected-only manifest (rejected > 0, deferred == 0) sets `anyDeferred = false`, skips
   the staleness block, and — if not deleted — would be re-processed every 10s scan cycle,
   re-logging and re-toasting the same rejection **forever**. That trades a silent failure
   for an infinite noisy loop.

   Correct behavior: in `applyManifest`, after the entry loop, if `result.rejected > 0`:
   log the rejected summary (see #5), then **delete the manifest** (same `_safeDelete` path
   as the all-applied case). The toast + log ARE the visibility; the bad paths are captured
   in the log so the user can fix the source (workflow doc). Do NOT retain. The `rejected`
   count is still returned in the result so the caller can fire the notification.

5. **Surface rejections via the log callback as a visible summary** — at the end of
   `applyManifest`, if `result.rejected > 0`, log a prominent summary:
   ```typescript
   log?.(`[PlanManifest] ⚠️ ${result.rejected} entr${result.rejected === 1 ? 'y' : 'ies'} REJECTED (invalid path/planFile). Manifest consumed (deleted) — rejected entries are permanent; fix the source planFile path. Valid forms: bare filename, .switchboard/plans/<name>.md, or .switchboard/epics/<name>.md.`);
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
No new import needed. `vscode.window.showWarningMessage(...)` with **no callback arguments** is a
passive toast notification, NOT a confirm dialog — it does not violate CLAUDE.md's
confirm-dialog ban (which targets `window.confirm` / modal yes-no gates that block action).
This call has no modal, no blocking, no yes/no; it only informs.

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
  - Manifest with `../evil.md` → rejected (path traversal), `rejected` count = 1, warning
    toast fired, manifest **deleted (consumed)** — not retained, not retried.
  - Manifest with missing `planFile` → rejected, `rejected` count = 1, manifest consumed.
  - Manifest with bare epic-looking filename `epic-foo.md` → auto-resolved to
    `.switchboard/plans/epic-foo.md`, epic-misroute warning logged, defers (no row) then
    staleness-drops — confirms the defensive warning fires.
  - Manifest mixing one valid + one rejected entry → valid entry applied, rejected counted,
    warning fired, manifest consumed (valid part is not lost).

### Manual / Static Verification (this session)
- **Compilation SKIP** per session directives.
- Static cross-check (done during review): confirmed `_applyEntry` path check (line 189-197),
  `_ensureRelativePlanFile` (line 6384-6420), `getPlanByPlanFile` (line 2979-2998),
  `applyManifest` consume/delete flow (line 141-165), and the workflow example paths against
  current source.
- Pre-merge checklist: grep for any new `confirm(`/`window.confirm` — forbidden per CLAUDE.md.

## Acceptance
- A manifest with bare filenames in `planFile` auto-resolves to `.switchboard/plans/<name>.md`
  and applies successfully (column override, epic links, project, status).
- A manifest with rejected entries (invalid path, missing planFile) is **consumed (deleted)
  after surfacing a single warning toast + output-channel log** — it is NOT silently dropped,
  and it is NOT retained for retry (rejected entries are permanent; retrying would spam every
  10s scan cycle). The rejected count appears in the log.
- A bare epic-looking filename (`epic-*.md` without `.switchboard/epics/` prefix) logs the
  misroute warning (defensive visibility for the plans-only auto-resolve limitation).
- Full-path entries (`.switchboard/plans/foo.md`, `.switchboard/epics/epic-foo.md`) continue to
  work unchanged.
- Workflow instructions show full `.switchboard/plans/` paths in examples and field rules.

## Recommendation

Complexity 5 → **Send to Coder.** Isolated to one service file + one watcher file + four doc
files. The auto-resolve logic is the only non-trivial part; the rest is mechanical.

## Review Findings

**Files changed:** `src/services/GlobalPlanWatcherService.ts` (review fix only — toast gating). The original implementation in `PlanManifestService.ts` and 4 workflow/skill doc files was verified correct against the plan. **Fix applied:** the rejection toast in `_processManifest` now fires only when `result.consumed` is true, preventing an infinite re-toast loop every 10s scan cycle when a manifest has mixed rejected+deferred entries (the manifest is retained for the deferred entries, but rejected entries are permanent and would re-toast on every cycle until the staleness guard drops the manifest ~3 min later). **Validation:** static verification — no confirm dialogs introduced, auto-resolve logic verified against path-traversal guard ordering, all 4 doc files confirmed showing full `.switchboard/plans/` paths. TypeScript compilation skipped per session directive (typescript not installed in worktree). **Remaining risk:** the mixed rejected+deferred case now silently suppresses the rejection toast until the manifest is consumed — the rejection is still logged to the Output channel on every cycle, but the user-facing toast is deferred. This is the correct trade-off (silent log vs. toast spam).
