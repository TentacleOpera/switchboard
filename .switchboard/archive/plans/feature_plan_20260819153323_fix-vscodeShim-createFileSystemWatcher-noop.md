# Fix no-op vscodeShim.createFileSystemWatcher — Root Cause of All Standalone Watcher Failures

## Goal

`vscodeShim.createFileSystemWatcher` is a no-op stub that returns three `noop` event emitters that never fire. This is the root cause of every standalone-host file-watcher failure. It was documented as a known bug in `bootstrap.ts:835-839` and worked around for `watchFolder` only, by overriding the seam at the composition root. The shim itself was never fixed, and `watchPattern`/`watchFile` remain silent no-ops.

### Problem Analysis & Root Cause

`src/standalone/vscodeShim.ts:217-220`:

```ts
export function createFileSystemWatcher(_pattern: any, ...): { ... } {
    const noop = (): any => ({ dispose() {} });
    return { onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} };
}
```

The bootstrap comment at `bootstrap.ts:835-839` reads: *"vscodeShim.createFileSystemWatcher is a no-op, so VscodeHostFileWatcher.watchFolder attaches nothing under standalone — the Tickets display watcher arms cleanly and then never fires."* The workaround: override `watchFolder` with `createStandaloneFolderWatcher` (a real `fs.watch` impl in `hostServices.ts:32-57`). But `watchPattern` and `watchFile` — which `VscodeHostFileWatcher` also routes through `createFileSystemWatcher` (`hostSeams.ts:552-580`) — were left as no-ops.

**Critical missing piece — `RelativePattern`:** `VscodeHostFileWatcher` constructs `new vscode.RelativePattern(folderPath, '**/*')` before calling `createFileSystemWatcher` (`hostSeams.ts:554`, `563`, `574`). The shim does NOT export a `RelativePattern` class. Currently this doesn't crash because `watchFolder` is overridden (bypassing `VscodeHostFileWatcher.watchFolder`), and `watchPattern`/`watchFile` are never called in standalone (the watcher setups only run from `open()`, which standalone never calls). Removing the bootstrap override WITHOUT adding `RelativePattern` to the shim would make `VscodeHostFileWatcher.watchFolder` the active implementation — and `new vscode.RelativePattern(...)` would throw `TypeError: vscode.RelativePattern is not a constructor`, breaking ALL folder watchers including the Tickets auto-refresh that currently works.

**Consumers broken by this no-op:**
- `PlanningPanelProvider._setupConstitutionWatcher` — uses `watchFile` (no-op)
- `TaskViewerProvider._setupMemoWatcher` — uses `this._seams().watcher.watchFile` (no-op)
- `PlanningPanelProvider._setupKanbanPlansWatcher`, `_setupFeatureDocsWatcher`, `_setupInsightsWatcher` — use `watchFolder` (works only because of the bootstrap override, not because the shim is correct)
- `DesignPanelProvider` — all 5 watcher setups use `watchFolder` (same — works only via override)
- `GlobalPlanWatcherService` — uses `watchFolder` + `watchFile` (watchFile is no-op for `.git/HEAD` branch tracking)
- `TaskViewerProvider._setupPlanWatcher` (line 15246) and `_setupBrainWatcher` (line 15450) — call `new vscode.RelativePattern(...)` directly (not through the seams). These currently don't crash only because `_resolveWorkspaceRoot()` returns `null` at construction time (seams not yet injected, `workspaceFolders` is empty). Adding `RelativePattern` to the shim fixes these too — they would crash if `reinitializePlanWatcher` is called before the shim is fixed.

This plan fixes the shim at the source so ALL three watcher methods work without composition-root workarounds.

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

No user decision needed. The fix is a straightforward replacement of a no-op stub with a real `fs.watch` implementation following the exact pattern already proven in `createStandaloneFolderWatcher`. The `RelativePattern` class addition is a minimal constructor that stores `{ base, pattern }` — the shape `VscodeHostFileWatcher` already passes.

## Complexity Audit (Routine vs Complex/Risky)

**Moderate.** The implementation follows the exact pattern already proven in `createStandaloneFolderWatcher` (`hostServices.ts:32-57`) — `fs.watch` with recursive flag, flat-watch fallback for Linux, existence-check to distinguish create/delete. The difference is the API shape: `createFileSystemWatcher` returns an object with `onDidCreate`/`onDidChange`/`onDidDelete` event emitters rather than a callback, and receives a `vscode.RelativePattern` ({ base, pattern }) or glob string rather than a bare folder path.

**Risk:** Making `watchPattern`/`watchFile` real means subsystems that previously received zero events in standalone will now actually fire. This is strictly correct — they were silently broken — but could surface latent bugs in handlers that assumed no events. Mitigation: all handler paths push through `_broadcaster` which is null-safe in standalone (`webview: null`).

## Edge-Case & Dependency Audit

- **`RelativePattern` vs glob string:** `VscodeHostFileWatcher` always passes `vscode.RelativePattern` (constructed at `hostSeams.ts:554`, `563`, `574`). The shim's `vscode.RelativePattern` is a simple class that stores `{ base, pattern }`. The implementation must extract `base` as the folder to watch and `pattern` as the glob to filter by.
- **Glob filtering:** The standalone host only uses `**/*` (watchFolder), bare filenames (watchFile), and `.switchboard/plans/**/*.md` (TaskViewerProvider's direct `vscode.workspace.createFileSystemWatcher` call at line 15245). The glob matcher must handle `**/*` (match everything), bare filenames (match basename), and `**/*.md` patterns (match extension). A simple regex-based matcher suffices — no need for a full glob library.
- **Recursive `fs.watch` on Linux:** `{ recursive: true }` is macOS/Windows only. Fall back to flat watch (same as `createStandaloneFolderWatcher` at `hostServices.ts:46-53`).
- **Event dedup:** `fs.watch` fires `rename` for both create and delete. Existence check at delivery time distinguishes them (same as `hostServices.ts:39`).
- **TaskViewerProvider direct `vscode.workspace.createFileSystemWatcher` calls:** `_setupPlanWatcher` (line 15245) and `_setupBrainWatcher` (line 15451) call `vscode.workspace.createFileSystemWatcher` directly (not through the seams). These already have native `fs.watch` fallbacks (lines 15316-15331 and 15500), so the shim fix is additive — it makes the primary watcher work too, reducing reliance on the fallback's dedup logic. Adding `RelativePattern` to the shim also prevents a `TypeError` crash if `reinitializePlanWatcher` is called (which it is, from `KanbanProvider.selectWorkspace`).
- **Removing the bootstrap override:** After the shim is real, the `headlessSeams.watcher = { ...headlessSeams.watcher, watchFolder: createStandaloneFolderWatcher }` override at `bootstrap.ts:840-843` becomes redundant. Removing it is safe — `VscodeHostFileWatcher.watchFolder` will use the now-real shim. `createStandaloneFolderWatcher` stays in `hostServices.ts` (exported, tested by `tickets-auto-refresh-on-file-change.test.js`).
- **Test update:** `src/test/tickets-auto-refresh-on-file-change.test.js:156-164` asserts the bootstrap override exists, and lines 166-168 assert the override does NOT include `watchPattern`. Both assertions must be removed (the override is gone). New assertions must verify the shim is real and `RelativePattern` exists. The test does NOT currently read `vscodeShim.ts` — a new `fs.readFileSync` call must be added.

## Dependencies

- None — this is the root-cause fix. Plans 2 and 3 depend on THIS plan.

## Adversarial Synthesis

Key risks: (1) Missing `RelativePattern` class would crash all watchers after override removal — mitigated by adding it as step 0. (2) `fs` not imported in shim — mitigated by explicit import addition. (3) Latent handler bugs surfacing when no-op watchers start firing — mitigated by null-safe `_broadcaster` in standalone. (4) `noop` temporal dead zone in proposed code — mitigated by moving definition before first use.

## Proposed Changes

### 0. Add `RelativePattern` class to the shim

**File:** `src/standalone/vscodeShim.ts` (add after the `Uri` class, around line 95)

This is the critical prerequisite. Without it, `VscodeHostFileWatcher.watchFolder/watchPattern/watchFile` all crash on `new vscode.RelativePattern(...)` because the constructor is `undefined` in the shim.

```ts
// AFTER (add after the Uri class):
export class RelativePattern {
    readonly base: string;
    readonly pattern: string;
    constructor(base: string, pattern: string) {
        this.base = base;
        this.pattern = pattern;
    }
}
```

Also add `RelativePattern` to the default export object at the bottom of the file (line 320-331):

```ts
export default {
    EventEmitter,
    Uri,
    RelativePattern,   // <-- add
    window,
    workspace,
    commands,
    Disposable,
    ConfigurationTarget,
    extensions,
    env,
    SecretStorage: SecretStorage as any,
};
```

### 1. Add `fs` import to the shim

**File:** `src/standalone/vscodeShim.ts` (line 29-30)

The file currently imports `path` but NOT `fs`. The plan's original text claimed both were already imported — this is incorrect.

```ts
// AFTER:
import * as fs from 'fs';
import * as path from 'path';
import { StandaloneHostSecrets } from './hostServices';
```

### 2. Replace the no-op `createFileSystemWatcher` with a real `fs.watch`-backed implementation

**File:** `src/standalone/vscodeShim.ts` (lines 217-220)

> **Superseded:** The original plan's code snippet placed `const noop = ...` after its first use in the early-return `else` branch, causing a temporal dead zone `ReferenceError`.
> **Reason:** `const` declarations are not hoisted; using `noop` before its definition line throws at runtime.
> **Replaced with:** The corrected version below, which defines `noop` before the if/else block.

```ts
// AFTER:
export function createFileSystemWatcher(pattern: any, _ignoreCreate?: boolean, _ignoreChange?: boolean, _ignoreDelete?: boolean): { onDidCreate: Event<Uri>; onDidChange: Event<Uri>; onDidDelete: Event<Uri>; dispose(): void } {
    const noop = (): any => ({ dispose() {} });

    // Resolve folder + glob from RelativePattern or glob string.
    let folderPath: string;
    let globPattern: string;
    if (pattern && typeof pattern === 'object' && 'base' in pattern) {
        folderPath = pattern.base;
        globPattern = pattern.pattern || '**/*';
    } else if (typeof pattern === 'string') {
        folderPath = process.cwd();
        globPattern = pattern;
    } else {
        return { onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} };
    }

    const createHandlers: ((uri: Uri) => void)[] = [];
    const changeHandlers: ((uri: Uri) => void)[] = [];
    const deleteHandlers: ((uri: Uri) => void)[] = [];

    // Simple glob → regex matcher. Handles **/*, **/*.md, bare filenames.
    const globToRegex = (glob: string): RegExp => {
        if (glob === '**/*') return /.*/;
        const re = glob
            .replace(/\*\*/g, '<<GLOBSTAR>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<GLOBSTAR>>/g, '.*')
            .replace(/\?/g, '.');
        return new RegExp(re + '$');
    };
    const matcher = globToRegex(globPattern);

    const emit = (eventType: string, filename: string | Buffer | null) => {
        if (!filename) return;
        const fullPath = path.resolve(folderPath, filename.toString());
        const relativePath = path.relative(folderPath, fullPath);
        if (!matcher.test(relativePath) && !matcher.test(path.basename(fullPath))) return;

        const uri = { fsPath: fullPath } as Uri;
        if (!fs.existsSync(fullPath)) {
            deleteHandlers.forEach(h => h(uri));
        } else if (eventType === 'rename') {
            createHandlers.forEach(h => h(uri));
        } else {
            changeHandlers.forEach(h => h(uri));
        }
    };

    let watcher: fs.FSWatcher;
    try {
        watcher = fs.watch(folderPath, { persistent: false, recursive: true }, emit);
    } catch {
        try {
            watcher = fs.watch(folderPath, { persistent: false }, emit);
        } catch {
            return { onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} };
        }
    }
    watcher.on('error', err => console.warn(`[vscodeShim watcher] ${folderPath}:`, err));

    return {
        onDidCreate: (handler: (uri: Uri) => void) => { createHandlers.push(handler); return { dispose: () => {} }; },
        onDidChange: (handler: (uri: Uri) => void) => { changeHandlers.push(handler); return { dispose: () => {} }; },
        onDidDelete: (handler: (uri: Uri) => void) => { deleteHandlers.push(handler); return { dispose: () => {} }; },
        dispose: () => { try { watcher.close(); } catch {} }
    };
}
```

### 3. Remove the redundant bootstrap override

**File:** `src/standalone/bootstrap.ts` (lines 834-843)

```ts
// AFTER:
const headlessSeams: HostSeams = createVscodeHostSeams(workspaceRoot, secretStorage as any);
// vscodeShim.createFileSystemWatcher is now backed by real fs.watch, so
// VscodeHostFileWatcher's watchFolder/watchPattern/watchFile all work in
// standalone without a composition-root override.
```

### 4. Update the test to assert the shim fix

**File:** `src/test/tickets-auto-refresh-on-file-change.test.js` (lines 13-17, 156-169)

The test currently reads `standaloneTs` (hostServices.ts) and `bootstrapTs` but NOT `vscodeShim.ts`. A new file read must be added, and the override assertions must be replaced with shim assertions.

```js
// AFTER (add after line 17):
const vscodeShimTs = fs.readFileSync(path.join(__dirname, '../standalone/vscodeShim.ts'), 'utf8');
```

Replace lines 156-169 (the override assertions) with:

```js
// ── Standalone: the shim's createFileSystemWatcher must be real ──
// The bootstrap override was removed — VscodeHostFileWatcher now routes
// through the shim directly. The shim must be backed by real fs.watch.
assert.match(
    vscodeShimTs,
    /export function createFileSystemWatcher[\s\S]*?fs\.watch\(/,
    'vscodeShim.createFileSystemWatcher must be backed by real fs.watch — a no-op silently disables every folder watcher in the standalone host'
);
assert.match(
    vscodeShimTs,
    /export class RelativePattern/,
    'vscodeShim must export a RelativePattern class — VscodeHostFileWatcher constructs new vscode.RelativePattern(...) before calling createFileSystemWatcher, and without this the constructor is undefined and throws'
);
// createStandaloneFolderWatcher assertions (lines 140-149) stay — the function
// still exists in hostServices.ts, exported and tested.
assert.match(
    standaloneTs,
    /export function createStandaloneFolderWatcher\(/,
    'createStandaloneFolderWatcher must remain exported — it is the proven fs.watch implementation the shim mirrors'
);
// The bootstrap override must be GONE.
assert.ok(
    !/headlessSeams\.watcher\s*=\s*\{/.test(bootstrapTs),
    'bootstrap must NOT override headlessSeams.watcher — the shim is now real, so the override is redundant and its presence would mask a shim regression'
);
```

## Verification Plan

1. **Unit test:** Run `node src/test/tickets-auto-refresh-on-file-change.test.js`. Confirm updated assertions pass (shim is real, RelativePattern exists, override is gone).

2. **Standalone — watchFolder (Docs tab):** Start standalone host. Add a `.md` file to a managed folder. Confirm it appears in the Docs sidebar without manual refresh. (Requires plan 2's arming fix to actually arm the watcher — this plan makes the shim real, plan 2 calls the arming code.)

3. **Standalone — watchFile (Constitution):** Edit a constitution file on disk. Confirm the Constitution tab live-updates. (Requires plan 2's arming fix.)

4. **Standalone — watchFile (Memo):** Edit `.switchboard/memo.md` on disk. Confirm the memo content updates. (TaskViewerProvider arms memo watcher from constructor — this plan's shim fix is sufficient.)

5. **VS Code regression:** Open planning panel in VS Code. Confirm all watchers still fire correctly (the shim is not used in VS Code — `createVscodeHostSeams` uses the real `vscode.workspace.createFileSystemWatcher`).

6. **Tickets regression:** Confirm Tickets auto-refresh still works in standalone (was using the override, now uses the shim — both are `fs.watch`-backed).

7. **TaskViewerProvider plan watcher:** Confirm `reinitializePlanWatcher` (triggered by workspace switch in Kanban) does not crash — `new vscode.RelativePattern(...)` now resolves to the shim's class.

---

## Completion Report

Implemented the root-cause fix replacing the no-op `vscodeShim.createFileSystemWatcher` stub with a real `fs.watch`-backed implementation mirroring the proven `createStandaloneFolderWatcher` pattern, plus the critical `RelativePattern` class prerequisite. Files changed: `src/standalone/vscodeShim.ts` (added `fs` import, `RelativePattern` class + default-export entry, real `createFileSystemWatcher` with glob matcher, recursive/flat-watch fallback, create/change/delete dispatch via existence check), `src/standalone/bootstrap.ts` (removed the redundant `headlessSeams.watcher` override and the now-unused `createStandaloneFolderWatcher` import), and `src/test/tickets-auto-refresh-on-file-change.test.js` (added `vscodeShimTs` read and replaced the override-presence assertions with shim-real/RelativePattern-exists/override-gone assertions). No issues encountered; per standing orders compilation and tests were skipped, and no commit was made — changes left in the working tree for review.

## Review Findings

Reviewed as implemented in commit `6582f85a`; the shim was real but its glob matcher was wrong in three ways, so I fixed `src/standalone/vscodeShim.ts`: `**/` now expands to a zero-or-more-segment group (the old `.*` demanded an intervening directory, so `.switchboard/plans/**/*.md` never matched a flat plan file), the regex is anchored and metacharacter-escaped (`HEAD` matched `ORIG_HEAD`, `constitution.md` matched `my-constitution.md`), and a `RelativePattern` `base` arriving as a `Uri`/`WorkspaceFolder` is normalised to a path (TaskViewerProvider passes `vscode.Uri.file(...)`, which made `fs.watch` throw and the watcher degrade to the no-op this plan set out to kill). Also: recursion is now conditional on the glob spanning directories (a bare-filename `watchFile` was recursively watching all of `.switchboard/` to observe one file), create-vs-change is discriminated by a seen-set (macOS reports `rename` for plain writes, so every save looked like a create and starved the one consumer keyed on `change`), Windows path separators are normalised, and a total watch failure now warns instead of silently returning a stub. Verification: `tsc --noEmit` clean (5 pre-existing TS2835 dynamic-import errors in untouched files), eslint 0 errors, `npm run test:contract:tickets-auto-refresh` passes with six new ratchet assertions (all verified red against the pre-fix source), and a transpiled runtime harness confirmed 14 matcher cases plus end-to-end create/change/delete on real temp directories. The full 119-step CI gate set was run against the working tree and against an isolated control with only my edits reverted — identical 65-failure sets, so zero new failures. Remaining risk: brace expansion (`**/*.md{,.*}`, used by TaskViewerProvider's brain watcher) is still unsupported and stays a standalone no-op behind its native `fs.watch` fallback — out of this plan's declared matcher scope.
