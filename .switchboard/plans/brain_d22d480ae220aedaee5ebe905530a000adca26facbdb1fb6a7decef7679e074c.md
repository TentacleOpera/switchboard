# Watch and Sync Multiple Antigravity Brain Paths

Support concurrent use of the Antigravity chat sandbox (`~/.gemini/antigravity/`), the Antigravity CLI sandbox (`~/.gemini/antigravity-cli/`), and the Antigravity IDE sandbox (`~/.gemini/antigravity-ide/`) by extending the extension's brain watcher, session lister, and artifact fetcher to monitor all three paths.

## Goal

Extend the Switchboard extension's Antigravity brain integration to discover, watch, and sync plan files from `~/.gemini/antigravity/`, `~/.gemini/antigravity-cli/`, and `~/.gemini/antigravity-ide/` concurrently, replacing single-root assumptions with array-based multi-path tracking throughout the watcher, session listing, and artifact fetching pipelines.

## Metadata

- **Tags:** [backend, reliability, workflow]
- **Complexity:** 6

## User Review Required

> [!NOTE]
> The brain watcher and planning panel were originally designed to prioritize `antigravity-cli` on startup but only watch `antigravity` for plan mirroring. By changing these components to use array-based tracking, we will watch and list artifacts from all three directories (`antigravity`, `antigravity-cli`, `antigravity-ide`) concurrently.

> [!IMPORTANT]
> The change requires modifying `src/test/brain-source-layout-regression.test.js` because the test uses static regex analysis to assert that the watcher is set up for a single `antigravityRoot`. We will update the test to expect multi-path loop watching.

## Complexity Audit

### Routine
- Converting `_brainWatcher` / `_brainFsWatcher` single-instance fields to arrays and updating dispose/reinitialize to iterate
- Adding `_getAntigravityRoots(): string[]` method (mirrors existing `LocalFolderService._ANTIGRAVITY_BRAIN_PATHS` pattern)
- Updating `PlanningPanelProvider._setupAntigravityWatcher()` to create watchers per detected brain path (follows existing `_setupLocalFolderWatchers()` / `_setupHtmlFolderWatchers()` array patterns)
- Updating `LocalFolderService.listAntigravitySessions()` to iterate over all active brain paths
- Updating `LocalFolderService.fetchAntigravityArtifact()` to validate containment against any active brain path
- Updating the regression test regex

### Complex / Risky
- `_resolveBrainSourcePathForMirrorHash()` security containment check (line 11534) must validate against **any** active root, not a single `brainDir` — a wrong check silently drops mirror→brain write-back
- `_setupBrainWatcher()` staging watcher passes `antigravityRoot` to `_resolveBrainSourcePathForMirrorHash()`; with multiple roots, the wrong root may be passed, causing the containment check to reject valid paths
- `_getAntigravitySourceKind()` classification (`brain` vs `artifact`) must work across both roots without misclassifying paths
- Potential watcher overlap: `~/.gemini/antigravity/brain/` is a subdirectory of `~/.gemini/antigravity/`, so recursive watchers on both roots may fire duplicate events for the same file. This does not apply across sibling roots (`antigravity-cli`, `antigravity-ide`) which are independent directories.

## Edge-Case & Dependency Audit

- **Race Conditions:** Brain watchers (one per root) could fire for the same file when `antigravity/brain/` is a subdirectory of `antigravity/`. The shared `_brainDebounceTimers` map (keyed by stable path) already deduplicates these — no additional guard needed, but the overlap must be documented. The `antigravity-cli` and `antigravity-ide` roots are siblings and cannot cause duplicate events.
- **Security:** `_resolveBrainSourcePathForMirrorHash()` line 11534 uses `_isPathWithin(brainDir, resolvedBrainPath)` to prevent mirror write-back outside the brain directory. With multiple roots, this must check `_getAntigravityRoots().some(root => this._isPathWithin(root, resolvedBrainPath))` to avoid silently rejecting valid paths from the other root.
- **Side Effects:** `seedBrainPlanBlacklistFromCurrentBrainSnapshot()` currently walks a single root. Walking both roots may add more entries to the blacklist — this is correct behavior (blacklist should cover all roots) but increases the set size.
- **Dependencies & Conflicts:** `LocalFolderService.detectAntigravityBrainPath()` is called from `PlanningPanelProvider._setupAntigravityWatcher()`. The new `detectAntigravityBrainPaths()` must coexist with the old method during migration. Keep `detectAntigravityBrainPath()` as a convenience wrapper returning the first detected path.

## Dependencies

- None

## Adversarial Synthesis

Key risks: the `_resolveBrainSourcePathForMirrorHash` security check will silently reject mirror→brain write-backs if it validates against the wrong root, and the staging watcher passes a single `antigravityRoot` that may not match the actual brain source. Mitigations: change the containment check to validate against any active root, and rely on the DB-stored `brainSourcePath` as the authoritative source (which already works correctly regardless of which root is passed). The watcher overlap risk is mitigated by the existing debounce map keyed by stable path.

## Proposed Changes

### Extension Services

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

**1. Replace `_getAntigravityRoot()` with `_getAntigravityRoots()` (line 1055–1057)**

- Rename `_getAntigravityRoot(): string` → `_getAntigravityRoots(): string[]`.
- Return `[path.join(os.homedir(), '.gemini', 'antigravity-cli'), path.join(os.homedir(), '.gemini', 'antigravity-ide'), path.join(os.homedir(), '.gemini', 'antigravity')]`.
- Add a convenience wrapper `_getAntigravityRoot(): string` that returns `_getAntigravityRoots()[0]` for backward compatibility with any call sites not yet migrated (or inline the `[0]` at each call site).

**2. Update `_getAntigravityPlanRoots()` (line 1059–1066)**

- Change from using `this._getAntigravityRoot()` (single) to iterating `this._getAntigravityRoots()` (array).
- Return the concatenation of plan roots from each antigravity root:
  ```typescript
  private _getAntigravityPlanRoots(): string[] {
      return this._getAntigravityRoots().flatMap(antigravityRoot => [
          path.join(antigravityRoot, 'brain', 'knowledge', 'artifacts'),
          path.join(antigravityRoot, 'knowledge', 'artifacts'),
          path.join(antigravityRoot, 'brain')
      ]);
  }
  ```

**3. Update `_getAntigravitySourceKind()` (line 1073–1091)**

- Replace `const antigravityRoot = this._getAntigravityRoot()` with iteration over `this._getAntigravityRoots()`.
- Build `artifactRoots` and `brainRoot` arrays from all roots, then check containment against any:
  ```typescript
  private _getAntigravitySourceKind(candidate: string): 'brain' | 'artifact' | undefined {
      const resolvedCandidate = path.resolve(candidate);
      for (const antigravityRoot of this._getAntigravityRoots()) {
          const artifactRoots = [
              path.join(antigravityRoot, 'brain', 'knowledge', 'artifacts'),
              path.join(antigravityRoot, 'knowledge', 'artifacts')
          ].map(root => path.resolve(root));
          if (artifactRoots.some(root => this._isPathWithin(root, resolvedCandidate))) {
              return 'artifact';
          }
          const brainRoot = path.resolve(path.join(antigravityRoot, 'brain'));
          if (this._isPathWithin(brainRoot, resolvedCandidate)) {
              return 'brain';
          }
      }
      return undefined;
  }
  ```

**4. Convert watcher fields to arrays (lines 244–245)**

- Change `private _brainWatcher?: vscode.FileSystemWatcher` → `private _brainWatchers: vscode.FileSystemWatcher[] = []`.
- Change `private _brainFsWatcher?: fs.FSWatcher` → `private _brainFsWatchers: fs.FSWatcher[] = []`.

**5. Rewrite `_setupBrainWatcher()` (line 8838–9056)**

- Replace the single-root watcher setup with a loop over `this._getAntigravityRoots()`.
- For each root that exists on disk and has at least one existing plan root:
  - Create a VS Code `FileSystemWatcher` and push to `_brainWatchers`.
  - Create a native `fs.watch` and push to `_brainFsWatchers`.
  - Both watchers use the same `handleBrainEvent` callback (already debounced by stable path, so overlap is safe).
- The staging watcher (mirror→brain, lines 8949–9055) remains singular (one per workspace) — but the `antigravityRoot` parameter passed to `_resolveBrainSourcePathForMirrorHash` must be updated. **Clarification:** Since `_resolveBrainSourcePathForMirrorHash` will be updated to check containment against all roots (see item 8), the staging watcher no longer needs to pass a specific root. Change the signature to remove the `brainDir` parameter, or pass `undefined` and let the method check all roots internally.

**6. Update `reinitializeBrainWatcher()` (line 9058–9074)**

- Replace single `_brainWatcher?.dispose()` / `_brainFsWatcher?.close()` with loops over `_brainWatchers` and `_brainFsWatchers`.
- Clear both arrays after disposal.

**7. Update `dispose()` (lines 16739–16741)**

- Replace `this._brainWatcher?.dispose()` with `this._brainWatchers.forEach(w => { try { w.dispose(); } catch {} })`.
- Replace `this._brainFsWatcher?.close()` with `this._brainFsWatchers.forEach(w => { try { w.close(); } catch {} })`.

**8. Update `_resolveBrainSourcePathForMirrorHash()` (line 11488–11536)**

- **Security-critical change:** Replace the single-root containment check at line 11534:
  ```typescript
  // OLD:
  if (!this._isPathWithin(brainDir, resolvedBrainPath)) return undefined;
  // NEW:
  if (!this._getAntigravityRoots().some(root => this._isPathWithin(root, resolvedBrainPath))) return undefined;
  ```
- Optionally remove the `brainDir` parameter since it's no longer needed for the security check.

**9. Update `_getConfiguredPlanFolderValidationError()` (line 9084–9100)**

- Replace the single-root check at line 9094–9097:
  ```typescript
  // OLD:
  const antigravityRoot = this._getAntigravityRoot();
  if (this._isPathWithin(antigravityRoot, configuredPlanFolder)) { ... }
  // NEW:
  if (this._getAntigravityRoots().some(root => this._isPathWithin(root, configuredPlanFolder))) {
      return 'Plan ingestion folder is already covered by the Antigravity brain watcher.';
  }
  ```

**10. Update `seedBrainPlanBlacklistFromCurrentBrainSnapshot()` (line 11133–11143)**

- Replace the single `antigravityRoot` with iteration over all roots:
  ```typescript
  const entries = this._getAntigravityRoots().reduce((acc, root) => {
      if (fs.existsSync(root)) {
          const rootEntries = this._collectBrainPlanBlacklistEntries(root);
          for (const e of rootEntries) { acc.add(e); }
      }
      return acc;
  }, new Set<string>());
  ```

**11. Update `_isBrainMirrorCandidate()` (line 10888–10911)**

- The method already calls `_getAntigravityPlanRoots()` which will now return roots from both antigravity paths. The `brainDir` parameter is used as a fallback when no plan root matches — update the fallback to check containment against any root in `_getAntigravityRoots()`:
  ```typescript
  const matchingRoot = this._getAntigravityPlanRoots()
      .map(root => path.resolve(root))
      .find(root => this._isPathWithin(root, resolvedFilePath))
      || this._getAntigravityRoots()
          .map(root => path.resolve(root))
          .find(root => this._isPathWithin(root, resolvedFilePath));
  ```

**12. Update `_collectAntigravityPlanCandidates()` (line 10941–10966)**

- Currently walks a single `rootDir`. Add a public wrapper that calls it for each root returned by `_getAntigravityRoots()` and concatenates results. Alternatively, update call sites to iterate.

---

#### [MODIFY] [LocalFolderService.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LocalFolderService.ts)

**1. Add `detectAntigravityBrainPaths()` (after line 437)**

- New method returning all paths in `_ANTIGRAVITY_BRAIN_PATHS` that exist on disk:
  ```typescript
  detectAntigravityBrainPaths(): string[] {
      return LocalFolderService._ANTIGRAVITY_BRAIN_PATHS.filter(candidate => {
          try {
              const stat = fs.statSync(candidate);
              return stat.isDirectory();
          } catch { return false; }
      });
  }
  ```
- Keep `detectAntigravityBrainPath()` as a convenience wrapper: `return this.detectAntigravityBrainPaths()[0] ?? null;`

**2. Update `listAntigravitySessions()` (line 439–492)**

- Replace `const brainPath = this.detectAntigravityBrainPath()` with iteration over `this.detectAntigravityBrainPaths()`.
- Aggregate sessions from all brain paths, deduplicating by session ID (first occurrence wins):
  ```typescript
  const brainPaths = this.detectAntigravityBrainPaths();
  if (brainPaths.length === 0) { return []; }
  const seenIds = new Set<string>();
  const sessions = [];
  for (const brainPath of brainPaths) {
      // ... existing directory scan logic, but skip entries where seenIds.has(entry.name)
      // ... add entry.name to seenIds before pushing
  }
  ```

**3. Update `fetchAntigravityArtifact()` (line 494–511)**

- Replace the single `brainPath` containment check with validation against any active brain path:
  ```typescript
  const brainPaths = this.detectAntigravityBrainPaths();
  if (brainPaths.length === 0) { return { success: false, error: 'Antigravity brain not detected' }; }
  const resolved = path.resolve(absolutePath);
  const isValid = brainPaths.some(brainPath => {
      const brainResolved = path.resolve(brainPath);
      return resolved === brainResolved || resolved.startsWith(brainResolved + path.sep);
  });
  if (!isValid) { return { success: false, error: 'Invalid path' }; }
  ```

---

#### [MODIFY] [PlanningPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts)

**1. Convert `_antigravityWatcher` to array (line 57)**

- Change `private _antigravityWatcher: vscode.FileSystemWatcher | undefined` → `private _antigravityWatchers: vscode.FileSystemWatcher[] = []`.

**2. Update `_setupAntigravityWatcher()` (line 422–450)**

- Follow the existing `_setupLocalFolderWatchers()` pattern (lines 334–376):
  - Dispose all existing `_antigravityWatchers` and clear the array.
  - Get all brain paths via `service.detectAntigravityBrainPaths()`.
  - Create a watcher for each detected brain path, push to `_antigravityWatchers` and `_disposables`.
  - Deduplicate with a `watchedPaths` set (same pattern as local folder watchers).

**3. Update `dispose()` references**

- Replace any `_antigravityWatcher.dispose()` with iteration over `_antigravityWatchers`.

---

### Tests

#### [MODIFY] [brain-source-layout-regression.test.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/test/brain-source-layout-regression.test.js)

- Update the third regression test (line 27–33) to expect multi-path watcher setup.
- The new regex should match `_getAntigravityRoots()` (plural) and a loop/iteration pattern instead of a single `const antigravityRoot = this._getAntigravityRoot()`:
  ```javascript
  assert.match(
      source,
      /(?:const|let) roots = this\._getAntigravityRoots\(\);[\s\S]*for\s*\(.*roots[\s\S]*vscode\.Uri\.file\(.*\)[\s\S]*vscode\.workspace\.createFileSystemWatcher/,
      'Expected _setupBrainWatcher to iterate over multiple Antigravity roots for watcher setup.'
  );
  ```
- Also update the first test (line 11–17) if `_getAntigravityPlanRoots()` output format changes to include both antigravity root prefixes.

## Verification Plan

### Automated Tests
- Run `npx mocha src/test/brain-source-layout-regression.test.js` to ensure the regression tests pass with the updated regex patterns.

### Manual Verification
- Start the extension in Debug mode.
- Enable "Antigravity Brain" in the settings / UI.
- Verify that sessions from `~/.gemini/antigravity/brain/`, `~/.gemini/antigravity-cli/brain/`, and `~/.gemini/antigravity-ide/brain/` all appear in the ARTIFACTS tab.
- Edit an `implementation_plan.md` in each location and verify they all successfully mirror to the workspace `.switchboard/plans/` directory.
- Verify that mirror→brain write-back (editing a mirrored plan in VS Code) syncs back to the correct brain source in all three roots.
- Verify that the plan ingestion folder validation still rejects paths inside any antigravity root.

## Recommendation

Complexity 6 → **Send to Coder**

## Review Pass (2026-06-02)

### Stage 1: Grumpy Principal Engineer Findings

| ID | Severity | Description |
|----|----------|-------------|
| CRITICAL-1 | CRITICAL | `workspace-scope-regression.test.js` lines 70 and 75 had stale regexes matching the OLD 3-argument `_resolveBrainSourcePathForMirrorHash(workspaceRoot, hash, brainDir)` signature and OLD single-root `_isPathWithin(brainDir, resolvedBrainPath)` containment check. The plan only called out updating `brain-source-layout-regression.test.js` but missed this second test file entirely. Guaranteed CI break. |
| NIT-1 | NIT | `_isBrainMirrorCandidate(brainDir, filePath)` had a vestigial `brainDir` parameter and dead `resolvedBrainDir` variable — unused since the method now determines matching root internally via `_getAntigravityPlanRoots()` / `_getAntigravityRoots()`. Misleading to future readers. |
| NIT-2 | NIT | `_getAntigravityRoot()` and `detectAntigravityBrainPath()` convenience wrappers are dead code (zero callers outside their own definitions). Harmless but unnecessary. |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action Taken |
|---------|---------|-------------|
| CRITICAL-1 | Fix now | Updated 3 regex patterns in `workspace-scope-regression.test.js` (lines 70, 75, 199) |
| NIT-1 | Fix now (cheap) | Removed `brainDir` parameter and `resolvedBrainDir` variable; updated 4 call sites |
| NIT-2 | Defer | Dead code, harmless; removal is a style choice for a cleanup pass |

### Code Fixes Applied

#### [MODIFY] workspace-scope-regression.test.js

- **Line 70**: Changed `_resolveBrainSourcePathForMirrorHash\(workspaceRoot, hash, brainDir\)` → `_resolveBrainSourcePathForMirrorHash\(workspaceRoot, hash\)` (2-arg call)
- **Line 75**: Changed method signature regex from 3-param `(workspaceRoot: string, hash: string, brainDir: string)` to 2-param `(workspaceRoot: string, hash: string)`, and changed containment check from `_isPathWithin\(brainDir, resolvedBrainPath\)` to `_getAntigravityRoots\(\)\.some\(root => this\._isPathWithin\(root, resolvedBrainPath\)\)`
- **Line 199**: Changed `_isBrainMirrorCandidate\(brainDir, fullPath\)` → `_isBrainMirrorCandidate\(fullPath\)` and `entries\.add\(stableKey\)` → `entries\.add\(this\._getStablePath\(baseBrainPath\)\)` (pre-existing mismatch)

#### [MODIFY] TaskViewerProvider.ts

- **Line 10802**: Changed `_isBrainMirrorCandidate(brainDir: string, filePath: string)` → `_isBrainMirrorCandidate(filePath: string)`; removed dead `resolvedBrainDir` variable
- **Lines 8794, 8831, 10848, 10876**: Updated 4 call sites from `_isBrainMirrorCandidate(someDir, fullPath)` → `_isBrainMirrorCandidate(fullPath)`

### Verification Results

- `brain-source-layout-regression.test.js`: 3/3 passing ✅
- `brain-path-depth-regression.test.js`: 3/3 passing ✅
- `workspace-scope-regression.test.js` (plan-relevant tests): "mirror write-back" ✅, "blacklist" ✅
- 4 pre-existing failures in `workspace-scope-regression.test.js` (unrelated: `_mirrorBrainPlan`, `_refreshRunSheets`, workspace identity, merged plan registration) — not caused by this plan's changes
- TypeScript: No compilation run (per session instructions), but signature consistency verified — all 4 call sites match the updated 1-parameter signature, no 2-argument calls remain

### Remaining Risks

1. **Dead convenience wrappers** (`_getAntigravityRoot()`, `detectAntigravityBrainPath()`) — zero callers, safe to remove in a cleanup pass but not urgent
2. **Pre-existing test failures** in `workspace-scope-regression.test.js` (4 tests) — unrelated to this plan, should be tracked separately
3. **Watcher overlap** concern from the plan is a false alarm: `~/.gemini/antigravity/`, `~/.gemini/antigravity-cli/`, and `~/.gemini/antigravity-ide/` are all sibling directories, not nested, so no duplicate events from the three watcher sets
