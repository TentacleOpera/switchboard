# Fix Plan-Card Save Rejecting Every Plan That Lives Under A Mapped Parent Root

## Goal

Make saving a manual edit to a plan card succeed for every plan the board is willing to
list, preview and open — instead of failing with a path error on the whole class of plans
whose files live under a mapped parent workspace root.

### The problem

Select a plan card, click **Edit**, change the markdown, click **Save** — the save fails and
a toast reports a path/plan-resolution error. The card is visibly on the board; its preview
renders; opening it in an editor works. Only the write is rejected.

### Root cause — the save path resolves a relative plan path against the wrong root

> **Superseded:** *"Root cause — one wrong helper, on the write path only."* The original
> analysis attributed the failure entirely to `saveFileContent` using `_getWorkspaceRoots()`
> (open VS Code folders only) at line 4627 where the three sibling read handlers use the wider
> `_getAllowedRoots()`, so a plan under a mapped parent failed `isAllowed` and produced
> `Save failed: Invalid file path`.
>
> **Reason:** The stored plan path is **relative**, not absolute — verified directly against
> the live DB:
> `sqlite3 .switchboard/kanban.db "select plan_file from plans limit 5;"` →
> `.switchboard/features/agent-activity-light-….md`. `_getKanbanPlans` (7235-7286) returns
> `planFile: r.planFile` verbatim, so the webview posts a **relative** `filePath`. That takes
> the `!path.isAbsolute(filePath)` branch at 4630 — the allow-check at 4641 is never what
> rejects it, because the (wrongly) resolved path still sits under an *open* folder and
> therefore passes even the narrow set. The narrow-vs-wide allow-list defect is **real but
> secondary**: it rejects *absolute* paths under a mapped parent (HTTP callers, and any caller
> that resolves the path before posting). It is not the reported failure.
>
> **Replaced with:** the relative-resolution analysis below. The allow-list widening is
> retained as a second, independently-necessary fix — not as the headline cause.

`saveFileContent` resolves a relative plan path against the **panel's ambient root**:

```ts
const allRoots = this._getWorkspaceRoots();                                        // 4627
…
if (!path.isAbsolute(filePath)) {
    const wsRoot = this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined);   // 4631
    resolved = path.resolve(wsRoot, filePath);
}
```

`_getWorkspaceRoot()` is the callback injected at `src/extension.ts:1297-1300`:

```ts
() => kanbanProvider!.getCurrentWorkspaceRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
```

`KanbanProvider.getCurrentWorkspaceRoot()` (`src/services/KanbanProvider.ts:1150`) returns the
stored **raw** root. The codebase treats that value as raw everywhere else — `KanbanProvider.ts:344-345`
does exactly `const rawRoot = … this.getCurrentWorkspaceRoot() …; const effectiveRoot = this.resolveEffectiveWorkspaceRoot(rawRoot);`
before using it. In a workspace-identity mapping the raw root is a **child repo**, while the
plan files live under the **mapped parent**.

So for a plan under a mapped parent:

1. `filePath` = `.switchboard/plans/feature_plan_….md` (relative, parent-relative).
2. `wsRoot` = `<parent>/viaapp` (a child folder — the raw ambient root).
3. `resolved` = `<parent>/viaapp/.switchboard/plans/feature_plan_….md` — **a file that does not exist**.
4. `isAllowed` at 4641 is **true** — the child *is* an open folder, so even the narrow set accepts it.
5. `fs.existsSync(resolved)` is false → `diskContent = ''` → `originalContent && diskContent !== originalContent`
   (4668) is true → the **conflict** branch fires → `conflict: true` with **no `error` string** →
   `src/webview/project.js:1073` renders `Save failed: Unknown error`.

The write is not blocked by a permission check. It is aimed at the wrong file, and the miss is
then reported as a concurrent-edit conflict. Defect C below is therefore not a side issue — it
is how the reported failure presents.

### The read path already solves this, in the same file

`_handleFetchKanbanPlanPreview` (1602-1619) receives the **identical** relative `planFile` and
resolves it correctly:

```ts
const allRoots = Array.from(this._getAllowedRoots());                      // 1603
let resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : '';
if (!resolved || !fs.existsSync(resolved)) {
    for (const root of allRoots) {                                          // probe EVERY allowed root
        const candidate = path.resolve(root, filePath);
        if (fs.existsSync(candidate)) { resolved = candidate; break; }
    }
    if (!resolved) { resolved = path.resolve(filePath); }                   // CWD fallback, fails isAllowed below
}
// SECURITY: isAllowed must run on the final resolved path, unconditionally
const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));  // 1619
```

That is why Preview works and Save does not, on the same string. The fix is to make the write
path resolve **the same way the read path does** — otherwise Save can write to a different file
than the one Preview just rendered to the user.

### The original allow-list finding — retained, downgraded to a second defect

`src/services/PlanningPanelProvider.ts` has two different notions of "a root we are allowed
to touch":

```ts
private _getWorkspaceRoots(): string[] {          // line 2115
    return this._seams().workspace.getWorkspaceRoots();     // open VS Code folders ONLY
}

private _getAllowedRoots(): Set<string> {         // line 2143
    const roots = this._getWorkspaceRoots();
    const allowedRoots = new Set<string>(roots);
    // …plus every workspace-identity mapping's parentFolder and workspaceFolders
    return allowedRoots;
}
```

`_getAllowedRoots()` is a strict superset: it adds the workspace-identity mapping's
**`parentFolder`** and its listed **`workspaceFolders`**. When child repos are mapped to a
shared parent, the board's plans live in the parent's `.switchboard/plans/` — and that parent
folder is typically **not itself an open VS Code folder**.

Every read on the plan-card path uses the wide set:

| Handler | Line | Roots used |
|---|---|---|
| `fetchKanbanPlans` | 3506 | `this._getAllowedRoots()` |
| `openKanbanPlan` | 3612 | `this._getAllowedRoots()` |
| `_handleFetchKanbanPlanPreview` | 1603 | `Array.from(this._getAllowedRoots())` |
| **`saveFileContent`** | **4627** | **`this._getWorkspaceRoots()`** |

`saveFileContent` is the only one on the narrow set. Its allow-check is:

```ts
const allRoots = this._getWorkspaceRoots();                                   // 4627
…
let isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));     // 4641
…
if (!filePath || !isAllowed) {
    this._pushTo(saveDestPanel, 'planning', { type: 'saveFileContentResult', success: false, error: 'Invalid file path', tab });
    break;                                                                    // 4658-4661
}
```

The fallback loop at 4642-4657 does not rescue it: it only widens to `LocalFolderService`
folder paths (docs / design / HTML folders), never to mapped workspace roots. So an
**absolute** path under a mapped parent fails `isAllowed` and the webview shows
`Save failed: Invalid file path` (`src/webview/project.js:1073`). That is a genuine second
failure mode on the same handler — it fires for HTTP/browser-cockpit callers and for any
caller that supplies an absolute path — and it is fixed here alongside the primary one.

This is confirmable against the running instance: `GET /kanban/plans` returns plan files under
`…/Documents/Gitlab/.switchboard/plans/…` — the mapped **parent** of the child repos that are
actually open as folders.

### Three further defects in the same handler, same cause

**A. `msg.workspaceRoot` is declared but never read.** The verb schema for `saveFileContent`
(`src/services/verbSchemas.ts:655`, the P2 set) declares a `workspaceRoot` field. The handler
never touches it — it resolves relatives against `this._getWorkspaceRoot() || allRoots[0]`
(4631). In a multi-root window that is a coin flip, and for an HTTP/browser-cockpit caller
there is no ambient panel state to fall back on at all. The webview already holds the right
answer: `_getKanbanPlans` stamps `workspaceRoot: effectiveRoot` onto every plan summary
(7261, 7269), so `_kanbanSelectedPlan.workspaceRoot` is exactly the owning root — it is simply
never sent.

**B. The rename-on-save DB update targets the wrong workspace.**

> **Superseded:** *"For a plan under a mapped parent that opens the wrong `kanban.db`,
> `getPlanByPlanFile` misses."*
> **Reason:** `KanbanDatabase.forWorkspace()` already redirects — `src/services/KanbanDatabase.ts:1080`
> runs `KanbanDatabase._redirectToParentIfMapped(validation.resolved!)` before resolving a DB
> path. Passing a child root therefore opens the **parent's** DB, not the wrong one. The stated
> mechanism does not exist.
> **Replaced with:** the DB is right; the **key** is wrong. `oldRelative` is computed as
> `path.relative(wsRoot, resolved)` (4739) against the raw/ambient `wsRoot`, while the DB stores
> `plan_file` **relative to the effective (parent) root** (`PlanFileImporter.ts:92-114`,
> `planFileNormalized`). A child `wsRoot` yields `../.switchboard/plans/…` where the DB holds
> `.switchboard/plans/…`, so `getPlanByPlanFile` misses on the key.

The symptom is unchanged from the original finding: the rename lands on disk while the DB keeps
pointing at a path that no longer exists. `renamedFilePath` is then computed relative to that
same wrong root (4763-4765) and the webview writes a broken `planFile` back onto the selected
card (`project.js:1037`, `project.js:1053`). The fix must use the **effective** root — the one
`_getKanbanPlans` stamps and the one the importer keys against — not merely "the owning root".

**C. A missing file reports "Unknown error".** When the resolved path does not exist,
`diskContent` is `''`, so `originalContent && diskContent !== originalContent` (4668) takes the
**conflict** branch, which sends `conflict: true` with **no `error` string**. `project.js`
renders `'Save failed: ' + (msg.error || 'Unknown error')`. A wrong-root resolution therefore
surfaces as a bare "Unknown error" instead of naming the real problem — which is why the
failure has been hard to pin down from the UI alone. Per the root-cause analysis above, this
is the branch the reported failure actually lands in.

**D. Every failure branch reports SUCCESS to an HTTP caller.** Each exit in this arm is a
`this._pushTo(...)` followed by `break`. `_handleMessage` therefore returns `undefined`, and
`handleServiceVerb` (106-153) hands that to the route layer, which applies its
`{success: true}` ack — the comment at 148-150 states this contract explicitly. The `error`
string only ever reaches a **panel**, which an HTTP caller does not have. So
`POST /verb/saveFileContent` returns `{success:true}` for `Invalid file path`, for a JSON parse
failure, for a conflict, and for the aggregate `catch`. This violates PRD contract #4
("Failure branches — including the aggregate `catch` — return `{success:false, error}` so an
HTTP caller sees the failure, never a false success") and it silently defeats the HTTP
verification case for this very plan.

## Metadata

- **Complexity:** 6
- **Tags:** bugfix, backend, reliability
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 4
> **Reason:** The scope grew on evidence: the fix now touches a shared resolver, five webview
> call sites across two files (not three across one), a return-in-body conversion of the arm,
> and the CI ratchet baseline. Still no new architecture — it mirrors a reference implementation
> 3,000 lines up in the same file — so it is Medium, not High.
> **Replaced with:** **Complexity:** 6

## User Review Required

None. Two scope decisions were made during review rather than deferred:

1. **The return-in-body conversion of this arm is included, not optional.** `npm run verb-returns:check`
   reports Planning at **exactly 152 breaks against a ceiling of 152**. Adding any `break` turns
   CI red (`.github/workflows/integration-tests.yml`). Converting this arm's six exits to `return`
   is both the way to add the new error branch and the fix for defect D. See Proposed Change 5.
2. **The `openKanbanPlan` sibling defect is explicitly out of scope** and flagged under
   "Not in scope" below rather than silently folded in.

## Complexity Audit

### Routine

- Swapping `_getWorkspaceRoots()` for `_getAllowedRoots()` at 4627. The three sibling handlers
  on the same path already do exactly this, so there is a working reference for both the call
  and the `Array.from` shape.
- The relative-path resolver is a near-verbatim lift of `_handleFetchKanbanPlanPreview`
  (1602-1619), which has shipped and works on the identical input.
- Threading `workspaceRoot` from the webview — the field is already on the plan summary
  (`_getKanbanPlans`, 7261/7269) and already declared in the verb schema
  (`verbSchemas.ts:655`); both ends exist, only the wiring is missing.
- Converting `push + break` to `push + return {success:false, error}` — 152 arms in this file
  already use the return form; it is a mechanical, precedented edit.

### Complex / Risky

- **This is a write-path allow-list.** Widening it is a security-relevant change, not a
  refactor. It must widen to exactly the set the read path already trusts and no further:
  `_getAllowedRoots()`, resolved, with a `startsWith` on the resolved root. Any incoming
  `workspaceRoot` must be tested for **exact membership** in `_getAllowedRoots()` rather than
  being trusted as given — see the `_resolveWorkspaceRoot` trap in the next bullet.
- **`_resolveWorkspaceRoot` (2171) is the wrong validator here.** It never returns `undefined`
  for a bad input: 2177-2181 fall back to `_getWorkspaceRoot()` or the first allowed root. Used
  as a gate it converts "hostile or stale root" into "some other real root", which then wins
  over the ambient fallback and reintroduces defect B. The save path must use the strict
  membership test (`allowedSet.has(path.resolve(explicitRoot))`) and leave `undefined` as
  `undefined`.
- **Probing roots by existence can hit the wrong file.** Two roots can both hold
  `.switchboard/plans/<same-name>.md`. First-hit wins is a silent overwrite of a file the user
  never looked at — *unless* the save resolver is byte-identical to the preview resolver, in
  which case you always write the file you were just shown. That equivalence is a hard
  requirement of this fix, not a nicety.
- **The handler is shared by four tabs and two panels.** `tab` is one of `kanban`, `features`,
  `constitution`, or a docs/design tab, and `saveDestPanel` routing (4628) already forks on it.
  The rename branch is gated to `kanban`/`features` (4707). A change here touches feature files,
  constitution saves and the Planning panel's own docs tab, so each needs its own verification
  pass.
- **The rename branch is a two-step write.** Content is written first (4702), then the file is
  renamed (4731), then the DB is updated (4743). A wrong root today means step 3 silently
  no-ops. After the fix it will start actually writing — so the DB update must be correct
  before it is made reachable, or a previously-inert bug becomes an active one.
- **The return-contract ratchet is at its floor for this provider.** Planning is at 152/152. The
  conversion must be paired with a baseline update produced by
  `node scripts/check-verb-return-contract.js --write` (which refuses to *raise* a ceiling), in
  the same change. Hand-editing the number is the documented way this has gone red before.
- **Published extension, ~4,000 installs.** No on-disk format changes here, so no migration is
  owed; but the `renamedFilePath` a client receives changes from "relative to an arbitrary root"
  to "relative to the effective root", and the webview consumer at `src/webview/project.js:1037`
  writes it straight back onto `_kanbanSelectedPlan.planFile`. Both ends must land together.

## Edge-Case & Dependency Audit

| # | Case | Required behaviour |
|---|---|---|
| 1 | **Relative** plan path whose file lives under a mapped **parent** that is not an open folder | Saves. This is the reported failure. Resolver probes allowed roots and finds it under the parent. |
| 2 | **Absolute** plan path under a mapped parent | Saves. This is what the `_getAllowedRoots()` swap fixes (previously `Invalid file path`). |
| 3 | Plan under an ordinary open workspace folder | Unchanged — `_getAllowedRoots()` is a superset and the file exists under the ambient root, so the probe's first hit is today's answer. |
| 4 | `msg.workspaceRoot` absent (every current webview caller until change 6 lands) | Works via the existence probe. **The fix must not require the new field** — three of the five callers live in `planning.js` and one is a conflict-resolution resend. |
| 5 | `msg.workspaceRoot` present but not an allowed root (hostile or stale HTTP caller) | Ignored — strict `Set.has` membership, not `_resolveWorkspaceRoot`. Falls through to the probe; the final path is still allow-checked. |
| 6 | Absolute `filePath` outside every allowed root | Still rejected with `Invalid file path`. The allow-check is widened, not removed. |
| 7 | Path traversal (`../../etc/passwd`, or a relative path escaping its root) | `path.resolve` runs before the check and the `startsWith` is on the resolved value — order preserved. Hardened with a `path.sep` boundary so `/x/Gitlab` no longer authorises `/x/Gitlab-private/…`. |
| 8 | Two allowed roots both contain the same relative plan path | The save resolver returns the **same** path the preview resolver returned, so the user saves the file they were shown. Residual ambiguity is inherited from the read path, not introduced here; supplying `workspaceRoot` (change 6) removes it for the board's own callers. |
| 9 | Resolved path does not exist and `originalContent` is non-empty | Report a real error naming the resolved path, not `conflict: true`. Reserve the conflict branch for a file that exists with different content. |
| 10 | Genuine concurrent-edit conflict (file exists, disk differs from `originalContent`) | Unchanged: `conflict: true` + `diskContent`, so the webview can still offer its resolution UI. |
| 11 | Conflict → user chooses overwrite (`planning.js:5119` resend) | Resends with `originalContent: diskContent` and the same relative `filePath`. Must resolve to the same file as the failed attempt — guaranteed by the shared resolver. |
| 12 | New file that exists under no root (`originalContent` empty) | Falls back to `msg.workspaceRoot || _getWorkspaceRoot() || allRoots[0]` and creates it — today's behaviour, preserved. |
| 13 | H1 rename where the plan lives in a mapped parent | The DB key is computed against the **effective** root (`_resolveEffectiveWorkspaceRoot` of the root that actually contains the file), matching what `PlanFileImporter` stored; `renamedFilePath` is relative to that same root. |
| 14 | H1 rename where the target filename already exists | Unchanged: `fs.rename` throws, the catch at 4749 clears `renamedTo`, and the content save still stands. Never pre-check with `existsSync` — matches `extension.ts:3068`. |
| 15 | Legacy hand-named plan (not `feature_plan_<8>_<6>_`) | Unchanged: `isTimestampedPlan` (4714) already excludes it from rename. |
| 16 | `tab: 'features'` — a feature file or a feature **subtask** under a mapped parent | Same fix, same code path. Verify separately: features are the other consumer of the rename branch, and the subtask save posts `_featurePreviewFilePath`, a different variable. |
| 17 | `tab: 'docs'` / `constitution` / design-folder saves (`planning.js:6567`, absolute paths under `LocalFolderService` folders) | Unchanged. Absolute paths skip the probe entirely; the `LocalFolderService` fallback loop at 4642-4657 is untouched. |
| 18 | Save issued over HTTP by an external agent (`POST /verb/saveFileContent`) | Returns `{success:true, …}` on success and `{success:false, error}` on **every** failure branch — not the route layer's blanket ack (defect D). |

**Code dependencies**

- `PlanningPanelProvider._handleFetchKanbanPlanPreview` (1602-1619) — the reference resolver this
  fix mirrors.
- `PlanningPanelProvider._getAllowedRoots` (2143) — the correct root set.
- `PlanningPanelProvider._resolveEffectiveWorkspaceRoot` (2473) — maps a raw root to the mapped
  parent; the root the importer and `_getKanbanPlans` both key against.
- `PlanningPanelProvider._resolveWorkspaceRoot` (2171) — **deliberately not used** on this path
  (it never returns `undefined`); documented in the Complexity Audit.
- `PlanningPanelProvider._getKanbanPlans` (7235) — stamps `workspaceRoot: effectiveRoot` on each
  plan summary; the value the webview will now send.
- `PlanningPanelProvider.handleServiceVerb` (106-153) — the HTTP entry point whose blanket ack
  defect D is about.
- `KanbanDatabase.forWorkspace` (`KanbanDatabase.ts:1075-1080`) — already redirects to the mapped
  parent; `getPlanByPlanFile` / `updatePlanFile` are the rename branch's DB writes.
- `PlanFileImporter` (92-114) — establishes that `plan_file` is stored **relative** to the scanned
  (effective) root.
- `src/webview/project.js:1961-1976` — the **kanban** Save click handler (inside `renderKanbanMetaBar(plan)`, 1897).
- `src/webview/project.js:2508-2523` — the **feature** Save click handler.
- `src/webview/project.js:2582-2597` — the **feature subtask** Save handler (inside `renderFeatureSubtaskMetaBar(plan)`, 2526).
- `src/webview/planning.js:6608` — the Planning panel's own kanban Save handler.
- `src/webview/planning.js:5119` — the conflict-resolution overwrite resend.
- `src/webview/project.js:1032-1075` — the `saveFileContentResult` consumer.
- `src/services/verbSchemas.ts:655` — already declares `workspaceRoot`; no schema change owed.
- `scripts/check-verb-return-contract.js` + `scripts/verb-return-contract-baseline.json` — the CI
  ratchet, currently `"Planning": 152` and measured at 152.

**Not in scope**

- `DesignPanelProvider`'s separate `saveFileContent` arm (2679) — a different panel with its own
  root handling; untouched. Its webview callers (`design.js:1978`, `design.js:3785`) route there,
  not here.
- **`openKanbanPlan` (3609-3623) has the same class of defect and is deliberately left alone.**
  It does `path.resolve(filePath)` with no root join, so a *relative* `planFile` resolves against
  the extension host's CWD and then fails `isAllowed`. The one-line fix is the same shared
  resolver. It is flagged here rather than folded in because the plan's problem statement records
  that opening works, and that observation has not been reconciled with this reading of the code —
  resolve that first, in its own card. Verification step M9 below probes it without depending on it.
- Tightening the loose `startsWith` on the **read** paths (1619, 3612). The write path is hardened
  here because that is the path under change; sweeping the read paths is a separate, mechanical card.
- The plan-file watcher and importer. No on-disk format changes, so nothing to migrate.

## Dependencies

- None. No prior-session work gates this plan.

## Adversarial Synthesis

**Risk Summary.** The headline risk is a fix that passes its own tests while the reported bug
survives: swapping the allow-list alone does not touch the relative-path branch the board
actually uses, so the load-bearing change is making the write path resolve identically to the
read path (`_handleFetchKanbanPlanPreview`, 1602-1619) rather than threading a new field the
board's five callers do not all send. Secondary risks are a write-path allow-list widened
without a `path.sep` boundary, a rename branch keyed against the raw rather than the effective
root (the DB is already redirected — the *key* was wrong, not the database), and the CI
return-contract ratchet, which sits at exactly 152/152 for this provider and turns red on any
added `break`. Mitigations: mirror the proven resolver instead of inventing one, validate any
caller-supplied root by strict `Set` membership (never via `_resolveWorkspaceRoot`, which falls
back instead of rejecting), derive the rename root from the resolved path and pass it through
`_resolveEffectiveWorkspaceRoot`, and convert the arm's six exits to `return` so the new error
branch costs zero breaks and HTTP callers stop seeing a false success.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — a shared save-target resolver

Add next to `_resolveWorkspaceRoot` (~2183). It is `_handleFetchKanbanPlanPreview`'s resolver
with one addition: a validated caller-supplied root is tried first.

```ts
/**
 * Resolve a save target the SAME way the read path resolves a preview
 * (_handleFetchKanbanPlanPreview, 1602-1619). Save and Preview MUST agree: two
 * allowed roots can both hold `.switchboard/plans/<same-name>.md`, and a resolver
 * that disagrees with the preview overwrites a file the user never looked at.
 *
 * Order: caller-supplied root (strict membership) → every allowed root, first that
 * EXISTS → ambient fallback for a file that exists nowhere yet (new-file case).
 *
 * Strict membership, NOT _resolveWorkspaceRoot(): that helper never returns
 * undefined (2177-2181 fall back to the default/first allowed root), so using it
 * as a gate silently converts a hostile or stale root into some *other* real root,
 * which then wins over the ambient fallback. Here, unvalidated means undefined.
 *
 * SECURITY: this returns a candidate only. The caller MUST still run the allow-check
 * on the returned path, unconditionally — same contract as the read path (1618-1619).
 */
private _resolveSaveTarget(filePath: string, explicitRoot?: string): string | undefined {
    if (!filePath) { return undefined; }
    if (path.isAbsolute(filePath)) { return path.resolve(filePath); }

    const allowedSet = this._getAllowedRoots();
    const allowed = Array.from(allowedSet);
    const validated = explicitRoot && allowedSet.has(path.resolve(explicitRoot))
        ? path.resolve(explicitRoot)
        : undefined;

    for (const root of (validated ? [validated, ...allowed] : allowed)) {
        const candidate = path.resolve(root, filePath);
        if (fs.existsSync(candidate)) { return candidate; }
    }

    // Nothing on disk yet — preserve today's behaviour so a genuinely new file
    // still gets created (edge case 12).
    const fallback = validated || this._getWorkspaceRoot() || (allowed.length > 0 ? allowed[0] : undefined);
    return fallback ? path.resolve(fallback, filePath) : undefined;
}
```

### 2. `src/services/PlanningPanelProvider.ts` — use it, and widen the allow-check

```diff
             case 'saveFileContent': {
                 const filePath = String(msg.filePath || '');
                 const content = String(msg.content || '');
                 const originalContent = String(msg.originalContent || '');
                 const tab = String(msg.tab || '');
-                const allRoots = this._getWorkspaceRoots();
+                // _getAllowedRoots(), NOT _getWorkspaceRoots(). The board LISTS
+                // (fetchKanbanPlans, 3506), PREVIEWS (_handleFetchKanbanPlanPreview, 1603)
+                // and OPENS (openKanbanPlan, 3612) plans from the allowed set, which
+                // includes the workspace-identity mapping's parentFolder and
+                // workspaceFolders. The narrow set is open VS Code folders only, so an
+                // ABSOLUTE path to a plan under a mapped parent was listed, previewed,
+                // opened, and then refused on save with 'Invalid file path'. Read and
+                // write must agree on what is in scope.
+                const allRoots = Array.from(this._getAllowedRoots());
                 const saveDestPanel = (tab === 'kanban' || tab === 'constitution' || tab === 'features') ? this._projectPanel : this._panel;
-                let resolved: string;
-                if (!path.isAbsolute(filePath)) {
-                    const wsRoot = this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined);
-                    if (wsRoot) {
-                        resolved = path.resolve(wsRoot, filePath);
-                    } else {
-                        this._pushTo(saveDestPanel, 'planning', { type: 'saveFileContentResult', success: false, error: 'No workspace root to resolve relative path', tab });
-                        break;
-                    }
-                } else {
-                    resolved = path.resolve(filePath);
-                }
-                let isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
+                // plan_file is stored RELATIVE to the EFFECTIVE (mapped-parent) root
+                // (PlanFileImporter:92-114), and _getKanbanPlans hands that string to the
+                // webview verbatim — so this arm's normal input is a relative path.
+                // Resolving it against the panel's ambient root (which is RAW, see
+                // extension.ts:1297 → KanbanProvider.getCurrentWorkspaceRoot) aimed the
+                // write at <child>/.switchboard/plans/… — a path that does not exist but
+                // DOES sit under an open folder, so it passed the allow-check and then
+                // fell into the conflict branch as 'Unknown error'.
+                const resolvedTarget = this._resolveSaveTarget(filePath, msg.workspaceRoot ? String(msg.workspaceRoot) : undefined);
+                if (!resolvedTarget) {
+                    const payload = { type: 'saveFileContentResult', success: false, error: 'No workspace root to resolve relative path', tab };
+                    this._pushTo(saveDestPanel, 'planning', payload);
+                    return { success: false, error: payload.error };
+                }
+                const resolved = resolvedTarget;
+                // path.sep boundary: without it an allowed root of `…/Documents/Gitlab`
+                // also authorises `…/Documents/Gitlab-private/…`. Now that the allowed set
+                // includes broad mapped PARENT folders, that prefix escape is worth closing
+                // on the write path.
+                let isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r) + path.sep));
                 if (!isAllowed) {
                     for (const r of allRoots) {
```

The `LocalFolderService` fallback loop (4642-4657) is unchanged.

### 3. `src/services/PlanningPanelProvider.ts` — stop reporting a missing file as a conflict

```diff
                 try {
                     // Conflict detection: compare disk content with original
                     let diskContent = '';
-                    if (fs.existsSync(resolved)) {
-                        diskContent = await fs.promises.readFile(resolved, 'utf8');
-                    }
-                    if (originalContent && diskContent !== originalContent) {
-                        this._pushTo(saveDestPanel, 'planning', { type: 'saveFileContentResult', success: false, conflict: true, diskContent, tab });
-                        break;
-                    }
+                    const exists = fs.existsSync(resolved);
+                    if (exists) {
+                        diskContent = await fs.promises.readFile(resolved, 'utf8');
+                    }
+                    if (originalContent && diskContent !== originalContent) {
+                        // A path that does not exist is a RESOLUTION failure, not a
+                        // concurrent edit. The old code funnelled it into the conflict
+                        // branch, which sends no `error` string — so project.js:1073
+                        // rendered 'Save failed: Unknown error' and the real cause (wrong
+                        // root) was invisible from the UI. Folded into the SAME branch, so
+                        // this costs zero extra exits against the return-contract ratchet.
+                        const payload = exists
+                            ? { type: 'saveFileContentResult', success: false, conflict: true, diskContent, tab }
+                            : { type: 'saveFileContentResult', success: false, tab,
+                                error: `Plan file not found at ${resolved}. It may have been moved, or the wrong workspace root was used to resolve it.` };
+                        this._pushTo(saveDestPanel, 'planning', payload);
+                        return { success: false, conflict: exists || undefined, error: (payload as any).error };
+                    }
```

### 4. `src/services/PlanningPanelProvider.ts` — rename against the effective root

```diff
                                     const newPath = path.join(path.dirname(resolved), newBasename);
                                     await fs.promises.rename(resolved, newPath);
                                     renamedTo = newPath;
-                                    // Update kanban DB if available
-                                    const wsRoot = this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined);
+                                    // Key the DB lookup against the EFFECTIVE root of the root
+                                    // that actually contains the file — derived from `resolved`
+                                    // (ground truth) rather than from caller input or ambient
+                                    // panel state. KanbanDatabase.forWorkspace already redirects
+                                    // to the mapped parent (KanbanDatabase.ts:1080), so the DB was
+                                    // never wrong; the KEY was. PlanFileImporter stores plan_file
+                                    // relative to the effective root, so a raw child root produced
+                                    // '../.switchboard/plans/…' and getPlanByPlanFile missed —
+                                    // the file was renamed on disk while the DB kept pointing at a
+                                    // path that no longer exists.
+                                    // Longest match wins: a child repo and its mapped parent are
+                                    // BOTH allowed roots and both prefix a plan inside the child.
+                                    const containingRoot = allRoots
+                                        .filter(r => resolved.startsWith(path.resolve(r) + path.sep))
+                                        .sort((a, b) => path.resolve(b).length - path.resolve(a).length)[0];
+                                    const wsRoot = containingRoot
+                                        ? this._resolveEffectiveWorkspaceRoot(containingRoot)
+                                        : (this._getWorkspaceRoot() || (allRoots.length > 0 ? allRoots[0] : undefined));
                                     renameWsRoot = wsRoot;
```

`renamedFilePath` (4763-4765) already derives from `renameWsRoot`, so it becomes correct for
free once `wsRoot` is — and it now matches the `workspaceRoot` the webview holds on the plan
summary, so the next Save on the renamed card resolves against the same root.

### 5. `src/services/PlanningPanelProvider.ts` — return in body (PRD contract #4)

Convert this arm's six exits from `push + break` to `push + return`:

| Line (pre-change) | Branch | Returns |
|---|---|---|
| 4636 | no workspace root | `{ success: false, error }` |
| 4660 | `Invalid file path` | `{ success: false, error: 'Invalid file path' }` |
| 4670 | conflict / not-found (change 3) | `{ success: false, conflict?, error? }` |
| 4684 | invalid JSON | `{ success: false, error }` |
| 4698 | invalid YAML | `{ success: false, error }` |
| 4757 | success | `{ success: true, tab, filePath: resolved, renamedFilePath }` |
| 4768 | aggregate `catch` | `{ success: false, error: String(err) }` |

The webview push at each site is **kept as-is** — the return is additive, exactly as the
migration contract requires. Before converting, confirm there is no post-`switch` code in
`_handleMessage` that a `break` was falling through to (152 arms already `return`, so this is a
confirmation, not an expectation).

Then, in the same change:

```bash
node scripts/check-verb-return-contract.js --write   # re-derives the true count; refuses to RAISE
git diff scripts/verb-return-contract-baseline.json  # expect "Planning": 152 → 146
node scripts/check-verb-return-contract.js           # must be green
```

Do **not** hand-edit the ceiling. `--write` exists precisely because hand-setting it has turned
CI red before (see the script's header comment).

### 6. `src/webview/project.js` + `src/webview/planning.js` — send the owning root

Five call sites reach this arm. Change 1 makes the fix work **without** any of them, by design
(edge case 4); these make it deterministic and remove the two-roots-same-path ambiguity for the
board's own callers.

`project.js` — **kanban** Save, inside `renderKanbanMetaBar(plan)` (1961-1976):

```diff
             dynamicSaveBtn.addEventListener('click', () => {
                 const filePath = _kanbanSelectedPlan ? _kanbanSelectedPlan.planFile : null;
                 const content = kanbanEditor ? kanbanEditor.value : '';
                 const originalContent = state.editOriginalContent.kanban;
                 if (filePath) {
                     vscode.postMessage({
                         type: 'saveFileContent',
                         filePath,
                         content,
                         originalContent,
+                        // The root that owns this plan. _getKanbanPlans stamps it onto every
+                        // summary (workspaceRoot: effectiveRoot, PlanningPanelProvider:7261),
+                        // and it is the mapped PARENT when the plan lives under one — which no
+                        // ambient panel state on the host side can reproduce (the host's
+                        // ambient root is RAW; see extension.ts:1297).
+                        workspaceRoot: _kanbanSelectedPlan.workspaceRoot || undefined,
                         tab: 'kanban'
                     });
                 }
             });
```

The remaining four, same one-line addition, each taking the root from its own live selection —
do **not** reach for `_kanbanSelectedPlan` in a features handler:

| File | Lines | Handler | Root source |
|---|---|---|---|
| `project.js` | 2508-2523 | feature Save (`btnSaveFeatures`) | `_featureSelectedPlan.workspaceRoot` |
| `project.js` | 2582-2597 | feature **subtask** Save, inside `renderFeatureSubtaskMetaBar(plan)` | `plan.workspaceRoot` (the render argument — it is the subtask's own summary; `_featureSubtaskPreview` is the same object) |
| `planning.js` | 6608 | Planning panel's kanban Save (`btnSaveKanban`) | `_kanbanSelectedPlan.workspaceRoot` |
| `planning.js` | 5119 | conflict-resolution overwrite resend | `_kanbanSelectedPlan.workspaceRoot` for `tab === 'kanban'`; omit for `local`/`design` (those use `state.activeDocFilePath`, an absolute path) |

> **Superseded:** *"Apply the same addition to both feature Save handlers — `_featureSelectedPlan.workspaceRoot` at 2585-2599, and the subtask meta-bar handler at 1958-1972 (which saves `_featurePreviewFilePath`)."*
> **Reason:** The three `project.js` sites were mislabelled and misnumbered. Verified against the
> file: **1961-1976** is the **kanban** handler (`_kanbanSelectedPlan.planFile`, `tab:'kanban'`),
> **2508-2523** is the **feature** handler, and **2582-2597** is the **subtask** handler (it is the
> one that saves `_featurePreviewFilePath`). Following the original text would have written
> `_kanbanSelectedPlan.workspaceRoot` into a features handler. The original also missed the two
> `planning.js` callers entirely, one of which is the conflict-overwrite resend.
> **Replaced with:** the table above.

## Verification Plan

### Automated Tests

Add to `src/test/verb-engine-planning-headless.test.js` — it already drives
`PlanningPanelProvider` arms through `handleServiceVerb` under a booby-trapped `vscode` module
and in-memory seams, which is exactly the harness this arm needs (it asserts both the returned
body and the push). Stub `workspace.getWorkspaceRoots()` to return **only** the child root and
seed the mapping index with the parent, so the two root sets genuinely differ.

1. **Relative** plan path whose file exists only under the mapped parent → save succeeds and
   `fs.writeFile` is called with `<parent>/.switchboard/plans/…`. **Fails on today's code; this
   is the regression guard for the reported bug** (edge case 1).
2. **Absolute** path under the mapped parent → succeeds (edge case 2). Fails on today's code with
   `Invalid file path`.
3. Absolute path under an ordinary open folder → unchanged success (edge case 3).
4. Absolute path outside every allowed root → `{success:false, error:'Invalid file path'}`, no
   write (edge case 6).
5. Prefix-escape: allowed root `<tmp>/Gitlab`, target `<tmp>/Gitlab-private/x.md` → rejected
   (edge case 7).
6. Traversal (`../../../etc/passwd`) → rejected after `path.resolve` (edge case 7).
7. Relative path with a valid `workspaceRoot` → resolved against that root even when the same
   relative path also exists under another allowed root (edge case 8).
8. Relative path with a `workspaceRoot` outside the allowed set → ignored, probe wins, and the
   result is still allow-checked (edge case 5).
9. Relative path that exists under **no** root, `originalContent` empty → created under
   `_getWorkspaceRoot() || allRoots[0]`, exactly as today (edge case 12).
10. Non-existent resolved path with non-empty `originalContent` → returned body carries a
    populated `error` naming the path and `conflict` is **not** set (edge case 9).
11. Existing file whose disk content differs → still `conflict: true` with `diskContent`
    (edge case 10).
12. H1 rename with the plan under the mapped parent → `getPlanByPlanFile` / `updatePlanFile` are
    called with a key relative to the **effective** root (`.switchboard/plans/…`, no `../`), and
    the returned `renamedFilePath` is relative to that same root (edge case 13).
13. H1 rename where the target exists → `fs.rename` throws, `renamedFilePath` is `undefined`, and
    the content write still stands (edge case 14).
14. **Return contract:** every failure branch returns `{success:false}` with a populated `error`
    (or `conflict`) — never `undefined` (edge case 18, PRD contract #4). Assert the returned
    **body**, not just the push.
15. **Resolver equivalence:** for the same relative `filePath`, `_resolveSaveTarget` and
    `_handleFetchKanbanPlanPreview` select the same path when two allowed roots both contain it
    (edge case 8).

### Gates

- `node scripts/check-verb-return-contract.js` → green, with `"Planning"` ratcheted **down** to
  its true post-conversion count (expected 146). A red run here means the conversion is
  incomplete or a `break` was added.
- `npm run parity:check`, `npm run push-routing:check` → unchanged (no new raw `postMessage`, no
  allowlist/catalog change; `verbSchemas.ts:655` already declares `workspaceRoot`).

### Manual (VSIX)

The shipped build, not `dist/`, in a window with a workspace-identity mapping active (child repos
mapped to a parent whose folder is **not** open).

1. Confirm the board lists plans whose files live under the mapped parent
   (`GET /kanban/plans` shows `<parent>/.switchboard/plans/…`).
2. Select one. Preview renders. Click **Edit**, change a line of body text, click **Save** →
   succeeds, no toast error; re-select the card and confirm the edit is in the preview and on disk.
3. Repeat for a plan under an ordinary open folder — still saves (no regression).
4. Force a conflict: open a plan for edit, change the file on disk underneath, then Save → the
   conflict UI still appears; choose overwrite and confirm the resend
   (`planning.js:5119`) writes the **same** file (edge case 11).
5. Edit a plan's **H1** to a new title and save: the file is renamed on disk to the new slug, the
   card's title updates, the card does not vanish from the board on the next refresh, and a
   subsequent Save on the same card still succeeds (proves the DB row followed the rename).
6. Repeat steps 2 and 5 on the **Features** tab for a feature file and for a feature subtask
   (edge case 16).
7. Repeat step 2 from the **Planning** panel's kanban tab (`planning.js:6608`) — the second,
   previously-unlisted caller.
8. Constitution / system doc / docs-folder save — unchanged (edge case 17).
9. Negative check: with a plan open for edit, delete the file on disk, then Save. The toast must
   name the missing path, not say "Unknown error" (edge case 9). While here, note whether
   **Open** on a mapped-parent plan actually works — the `openKanbanPlan` finding under "Not in
   scope" predicts it does not, and this is the cheapest place to settle it.
10. Browser cockpit: perform the same plan-card edit and save from the project panel served by the
    local API server, verified against the running server rather than a local `src/` edit. Then
    `POST /verb/saveFileContent` with a deliberately bad `filePath` and confirm the response body
    is `{success:false, error:…}` — not the old blanket `{success:true}` (edge case 18).

---

**Recommendation:** Send to Coder (complexity 6).

## Review Findings

All six proposed changes landed and are correct. `_resolveSaveTarget` (`PlanningPanelProvider.ts:2311`) is a faithful mirror of `_handleFetchKanbanPlanPreview`'s resolver — same allowed set, same probe order, same fallback — with strict `Set.has` membership for the caller-supplied root rather than `_resolveWorkspaceRoot`, so an unvalidated root becomes `undefined` instead of some other real root; the allow-check now uses `_getAllowedRoots()` with a `path.sep` boundary, the rename branch keys the DB against the longest containing root passed through `_resolveEffectiveWorkspaceRoot`, a missing file no longer takes the conflict branch, and all six exits return typed bodies (the arm has no path that falls out of the switch). The `verb-returns` baseline was re-derived with `--write` (149→143) and the ratchet is green. No code fix was needed here; the plan named fifteen automated cases and zero were written, so six were added to the CI-wired `src/test/verb-engine-planning-headless.test.js` — relative resolution against the owning root, missing-file error text, genuine conflict preserved, outside-every-root refusal in the *body*, the `Gitlab`/`Gitlab-private` prefix escape, and a hostile `workspaceRoot` being dropped rather than trusted — and the suite passes 32/32. `parity:check` and `push-routing:check` are unchanged as predicted.

## Deferred Findings

- MAJOR — Threading `workspaceRoot` into Save (change 6) without threading it into Preview breaks the plan's own "Save and Preview MUST agree" invariant: when two allowed roots hold the same relative plan path, Preview picks the first existing root while Save picks the stamped one. Save is the more correct of the two, so this is a read-path defect the plan explicitly scoped out, not a regression — but the invariant is no longer enforced by construction. `src/services/PlanningPanelProvider.ts:4923`
- NIT — The `LocalFolderService` fallback allow-check keeps its bare `startsWith`, so a docs folder `…/notes` also authorises `…/notes-private/…`. The plan left this loop unchanged; it is now reached through a wider root set. `src/services/PlanningPanelProvider.ts:4944`
- NIT — The `!isAllowed` fallback loop now constructs a `LocalFolderService` for every allowed root, including mapped parents, each of which does a `KanbanDatabase.forWorkspace` config read. It fires only on the refusal path and all mapped roots collapse to one effective root, so the cost is bounded — but it is strictly more work than the open-folder set it replaced. `src/services/PlanningPanelProvider.ts:4936`
- NIT — `openKanbanPlan` still resolves a relative `planFile` against the extension host's CWD, the sibling defect the plan flagged under "Not in scope". Unchanged and still open. `src/services/PlanningPanelProvider.ts:3887`
