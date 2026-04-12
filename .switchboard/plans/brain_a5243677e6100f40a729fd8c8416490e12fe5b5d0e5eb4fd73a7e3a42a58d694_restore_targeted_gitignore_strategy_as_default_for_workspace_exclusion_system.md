# Restore Targeted Gitignore Strategy as Default for Workspace Exclusion System

The `WorkspaceExcludeService` was implemented with blanket exclusion rules
(`.switchboard/*` and `.agent/*`) as defaults, replacing the targeted `.gitignore`
approach that was used by the original `_runGitignoreMigrationV1`. The targeted
approach selectively ignored only machine-local files (the kanban database and
integration configs) while preserving `.switchboard/plans/`, `.switchboard/reviews/`,
`.agent/` and shared protocol documents so they remain tracked by git and visible
to agents. This change restores that behavior as the default strategy, removes the
unneeded blanket-gitignore preset (reachable via `custom` instead), and redesigns
the Setup UI's ignore rules display to be read-only for preset strategies and
editable only when the user selects `custom`.

## Goal

Restore the original targeted `.gitignore` behavior as the default workspace exclusion strategy so machine-local Switchboard artifacts stay ignored without hiding shared plans, reviews, sessions, or `.agent/` workflow assets from git and agent discovery. Tighten the backend and setup-panel state contract so preset previews are read-only, custom drafts survive strategy toggles, and Switchboard mutates only its own fenced ignore block.

1. **Replace** the existing strategy enum (`localExclude`, `gitignore`, `none`) with
   a new set: `targetedGitignore`, `localExclude`, `custom`, `none`.
2. Make `targetedGitignore` the new default, writing a hardcoded targeted rule set
   — matching the actual `.gitignore` used by this repo — to `.gitignore`.
3. Remove `gitignore` as a standalone preset. Blanket-ignoring `.switchboard/*` and
   `.agent/*` is harmful to agent context gathering; anyone who truly needs it can
   use `custom` and type the rules themselves.
4. The ignore rules textarea in the Setup panel becomes **read-only** for all preset
   strategies (`targetedGitignore`, `localExclude`). It displays what will be
   written. Only `custom` allows editing.
5. `localExclude` remains a first-class preset (writes to `.git/info/exclude`) so
   users on shared repos who want zero `.gitignore` pollution have a named option.
6. No migration is required: the blanket configuration has not been shipped.

## Metadata
**Tags:** frontend, backend, UI, infrastructure
**Complexity:** 7

## User Review Required
> [!NOTE]
> - targetedGitignore becomes the default for fresh workspaces, and Switchboard should manage its own fenced block in `.gitignore` / `.git/info/exclude` rather than blindly appending lines forever.
> - localExclude remains a first-class preset and continues to use the stored switchboard.workspace.ignoreRules value as workspace-local storage.
> - Clarification: custom is the editable escape hatch and stays scoped to writing user-entered rules to .gitignore. This plan does not add a second custom target selector.
> - Clarification: the implementation must preserve unrelated user-owned ignore rules verbatim. Only the Switchboard-managed block may be added, replaced, or removed.
> - Clarification: legacy unmanaged Switchboard lines from older append-only experiments should not be auto-deleted in this change; only the new fenced block is managed.

## Complexity Audit

### Routine
- package.json (lines 300-326): replace the old localExclude | gitignore | none schema with targetedGitignore | localExclude | custom | none, make targetedGitignore the default, update the enumDescriptions, and keep the ignoreRules default array for backward compatibility with existing saved workspaces.
- .gitignore (lines 35-59): treat the existing targeted Switchboard block as the canonical rule ordering, comment wording, and blank-line spacing that the new preset must preview and write.
- src/services/TaskViewerProvider.ts (lines 1829-1857 and 1951-1952): widen _normalizeGitIgnoreConfig() to the new strategy union, update the fallback default to targetedGitignore, extend handleGetGitIgnoreConfig() so the webview receives both the persisted editable rules and a backend-supplied targeted preview, and rebroadcast that same full payload shape after saves.
- src/services/SetupPanelProvider.ts (lines 181-183): no direct code change is required because this._panel.webview.postMessage({ type: 'gitIgnoreConfig', ...config }) already forwards any extra fields returned by handleGetGitIgnoreConfig(). Clarification: rely on this existing pass-through instead of adding redundant plumbing.
- src/webview/setup.html (lines 390-399, 799-802, 1075-1140, 1287-1291, 1563-1570): rename the preset options, update read-only affordances, preserve the cached custom draft while preset previews are shown, and keep the displayed target label in sync with the selected strategy.

### Complex / Risky
- src/services/WorkspaceExcludeService.ts (lines 5-64): the service becomes responsible for a hardcoded targeted preset, fenced managed-block upsert/removal logic, and safe full-file rewrites that preserve unrelated user-owned `.gitignore` and `.git/info/exclude` lines verbatim, including blank separators inside the managed block.
- The setup panel must distinguish displayed preset rules from persisted editable rules. If the implementation serializes the read-only targeted preview back into switchboard.workspace.ignoreRules, it will silently overwrite the user's custom rule draft when they toggle away from custom.
- The targeted rule preview must have a single source of truth. Duplicating the canonical rule list in WorkspaceExcludeService, TaskViewerProvider, and setup.html will drift over time as new integration-local artifacts are added, and drifting on blank separators/comment text will make the readonly preview stop matching the actual `.gitignore` block it claims to represent.
- Existing workspaces may already have ignoreStrategy: localExclude or a saved blanket rule array. The new default and fallback logic must not erase those stored values; it should only change the default for fresh or invalid configurations.
- Strategy switching now has cross-file consequences: moving between `targetedGitignore`, `custom`, `localExclude`, and `none` must update or remove the Switchboard-managed block in the correct target without touching user-authored rules outside that block.
- src/services/TaskViewerProvider.ts currently posts partial `{ strategy, rules }` messages after ignore-setting saves. If that payload is not upgraded to include targetedRulesDisplay, the webview can hydrate once with the full preview and then regress to stale preset rendering after autosave.
- Active-plan coordination is not hypothetical: the active Planned file `.switchboard/plans/brain_d0af6b8e9d4ebeb25e1a1e589f9466909476ce67f72b582d06a5fefbfefcce85.md` also targets `src/webview/setup.html` and `src/services/TaskViewerProvider.ts`, so this work has a direct merge hotspot even though the product scope is separate.

## Edge-Case & Dependency Audit
- **Race Conditions:** src/extension.ts already debounces re-application of workspace exclusion rules via scheduleWorkspaceExcludeApply() with a 75 ms timer. The implementation should keep config writes deterministic so a hydration message, an autosave tick, and the debounced excludeService.apply() call all observe the same normalized strategy/rules pair.
- **Security:** The targeted preset must keep .agent/, .switchboard/plans/, .switchboard/reviews/, and .switchboard/sessions/ discoverable. Reintroducing the blanket .agent/* ignore would directly reduce agent context visibility and hide shared workflow artifacts from code search.
- **Side Effects:** The service should stop being raw append-only and instead upsert a Switchboard-owned fenced block. Choosing `targetedGitignore`, `custom`, `localExclude`, or `none` should update or remove only that managed block, leaving unrelated user rules untouched. Clarification: legacy unmanaged Switchboard lines from old append-only runs may still require manual cleanup, because this change should not heuristically delete lines it does not own.
- **Dependencies & Conflicts:** switchboard-get_kanban_state succeeded. New is empty. Planned contains this plan plus Persona Protocol Hardening and Visual Kanban Structure Reordering Plan. There is no hard implementation dependency on either active plan, but the conflict picture is now concrete rather than speculative: Persona Protocol Hardening targets `.agent/personas/switchboard_operator.md` and is orthogonal, while Visual Kanban Structure Reordering explicitly edits `src/webview/setup.html` and `src/services/TaskViewerProvider.ts`, making those two files a direct merge hotspot that should be sequenced, not merged blindly. A non-active but relevant prerequisite context is `.switchboard/plans/add_git_ignore_ui_to_setup_menu.md`, which introduced the setup UI surface this plan refines.

### Concrete Edge Cases to Cover
- **Managed-block replacement with negation rules:** The targeted rule set includes negation patterns such as !.switchboard/plans/. The upsert logic must treat the entire fenced block as owned content so negated lines are replaced exactly, not partially deduplicated against user-authored sections.
- **Exact preset formatting:** Because the setup textarea becomes a readonly preview for presets, the targeted rule list must preserve the root `.gitignore` block's current blank-line separators and comment wording so the display and the written block stay visually identical.
- **Preserving custom drafts across preset toggles:** Switching from custom to targetedGitignore or none should not replace the stored ignoreRules array with the preset preview. Returning to custom should restore the user's last editable draft.
- **Hydration-first rendering:** renderGitIgnoreConfig() must be able to render a valid targeted preview before or immediately after the first gitIgnoreConfig message so the autosave signature does not thrash on first paint.
- **Post-save payload parity:** The first hydration message and every subsequent save/update message must carry the same gitIgnoreConfig shape (`strategy`, `rules`, `targetedRulesDisplay`) or the webview will render one state on load and a different state after autosave.
- **Target-file clarity:** targetedGitignore always writes to <workspaceRoot>/.gitignore; localExclude always writes to <workspaceRoot>/.git/info/exclude; custom remains .gitignore-backed in this plan. The setup status label should reflect those exact paths.
- **Backward compatibility with stale settings:** Unknown or legacy strategies such as gitignore must normalize to targetedGitignore for fresh or invalid state, but existing saved ignoreRules values should still be preserved in configuration for use when the user explicitly selects custom or localExclude.
- **Strategy switching between files:** Switching from `.gitignore`-backed strategies to `localExclude` must remove the old Switchboard-managed block from `.gitignore` and write the new managed block to `.git/info/exclude`; switching back must perform the inverse.
- **`none` cleanup semantics:** Selecting `none` should remove only the fenced Switchboard-managed block from both candidate target files and must not delete any unrelated user-owned lines before or after the markers.
- **Legacy append-only residue:** If old unmanaged Switchboard lines already exist outside the fenced block, the new code should leave them untouched and optionally log that only managed-block cleanup is guaranteed.

## Adversarial Synthesis

### Grumpy Critique
> This only looks like a tiny settings tweak if you politely ignore every boundary it crosses. You are changing contribution schema, runtime file mutation, setup hydration, autosave serialization, and the user-facing affordance in one shot. If the readonly targeted preview gets serialized back into switchboard.workspace.ignoreRules, congratulations: you just vaporized the user's custom draft the moment they clicked a preset. If the targeted rule list is duplicated in the service, the provider, and the webview, it will drift the first time someone adds another machine-local artifact and updates only one copy. And if you keep the old append-only model while users experiment with presets, `.gitignore` turns into a landfill: stale Switchboard rules pile up forever, switching to `none` does nothing meaningful, and moving from `.gitignore` to `.git/info/exclude` leaves ghost entries behind in the wrong file. The backend must be the source of truth, preset display state must stay separate from persisted editable rules, and the write contract must be a fenced managed block that updates only its own region or this feature will work once and then start lying to users.

### Balanced Response
> The critique is fair, so the plan is tightened in four concrete ways. First, WorkspaceExcludeService owns the canonical targeted preset via TARGETED_RULES and getTargetedRules(), and that array now preserves the root `.gitignore` block's current order, comment text, and blank separators so the readonly preview matches what the writer emits. Second, TaskViewerProvider must use one backend contract everywhere: handleGetGitIgnoreConfig(), _persistGitIgnoreConfig(), and postSetupPanelState() should all emit the same `{ strategy, rules, targetedRulesDisplay }` shape so autosave does not regress the UI into a stale partial state. Third, the setup state now distinguishes persisted editable rules from readonly preset display: lastGitIgnoreConfig.rules continues to represent the stored ignoreRules array, and collectSetupSavePayload() only re-sanitizes the textarea when strategy === custom; preset strategies serialize the cached stored rules so custom drafts survive toggling. Fourth, the file-mutation model is upgraded from blind append-only writes to a fenced managed-block upsert/remove flow: Switchboard may rewrite its own marked section inside `.gitignore` or `.git/info/exclude`, but it must preserve unrelated user-owned lines verbatim and cleanly remove its block when the strategy changes or becomes `none`. The kanban scan shows no hard dependency in New or Planned, but it now documents the direct `src/webview/setup.html` / `src/services/TaskViewerProvider.ts` overlap with the visual reordering plan so implementation can be sequenced instead of merged blindly.

## Proposed Changes
> [!IMPORTANT]
> MAXIMUM DETAIL REQUIRED: Preserve the original implementation snippets below, but treat each Clarification block as the authoritative final behavior where a retained snippet was intentionally minimal. The critical safety invariant is that Switchboard may only add, replace, or remove its own fenced managed block and must preserve unrelated ignore-file content verbatim.

### Strategy Matrix

| Strategy | Target | Rules | Who it's for |
|---|---|---|---|
| targetedGitignore (default) | .gitignore | Hardcoded targeted set from WorkspaceExcludeService.TARGETED_RULES | Most users — team-friendly and preserves shared agent artifacts |
| localExclude | .git/info/exclude | Stored switchboard.workspace.ignoreRules value (read-only in Setup UI) | Solo developers on shared repos who want no committed ignore-file changes |
| custom | .gitignore | Editable textarea persisted to switchboard.workspace.ignoreRules | Power users who intentionally want to author their own committed rule set |
| none | — | — | Fully manual |

### The Targeted Rule Set

The following is the exact targeted block that `targetedGitignore` should preview and write to `<workspaceRoot>/.gitignore`. It is sourced from the repo's current `.gitignore` block at lines 35-59, including the current comment wording, blank-line separators, explicit database entries, and the preserved tracked subpaths:

```
# Switchboard runtime state (per-session, not shareable)
.switchboard/*
!.switchboard/reviews/
!.switchboard/plans/
!.switchboard/sessions/
!.switchboard/CLIENT_CONFIG.md
!.switchboard/README.md
!.switchboard/SWITCHBOARD_PROTOCOL.md
!.switchboard/workspace-id

# ClickUp integration config (workspace-specific IDs)
.switchboard/clickup-config.json

# Linear integration config (workspace-specific IDs and sync map)
.switchboard/linear-config.json
.switchboard/linear-sync.json

# Notion integration config and page content cache
.switchboard/notion-config.json
.switchboard/notion-cache.md

# kanban.db is already excluded by .switchboard/* above — explicit entry for documentation clarity.
# Never commit the kanban database: it contains machine-local state that differs per developer.
.switchboard/kanban.db
.switchboard/*.db-shm
.switchboard/*.db-wal
```

> [!IMPORTANT]
> .agent/ is intentionally NOT excluded by this targeted strategy. Workflows, personas, and skills in .agent/ are shared team artifacts that agents must still discover through normal search.

> [!NOTE]
> Clarification: localExclude and custom continue to use the stored switchboard.workspace.ignoreRules array for preview and persistence. Only custom makes the textarea editable.

### Low-Complexity / Routine Implementation Steps
1. Update the contribution schema in `package.json` so fresh workspaces default to `targetedGitignore`, the old `gitignore` preset disappears in favor of `custom`, and the existing `ignoreRules` array remains untouched for backward compatibility.
2. Treat `<workspaceRoot>/.gitignore` lines 35-59 as the canonical targeted preset, including blank separators and comment text, then expose that canonical list via `WorkspaceExcludeService.getTargetedRules()` for both write-time and UI preview use.
3. Normalize the new strategy union in `src/services/TaskViewerProvider.ts`, keep persisted editable rules separate from preset display rules, and ensure save-time rebroadcasts include the same enriched payload as initial hydration.
4. Keep `src/services/SetupPanelProvider.ts` as a simple pass-through for the enriched `gitIgnoreConfig` payload instead of adding duplicate transport logic.
5. Update the setup-panel dropdown labels, default selection, readonly affordance, and target-path status text in `src/webview/setup.html` so each preset clearly advertises where rules will be written.

### `package.json`

#### [MODIFY] `package.json` — Add `targetedGitignore` enum and make it default

**Context:** Lines 300–315 define `switchboard.workspace.ignoreStrategy`.

**Logic:** Add `"targetedGitignore"` as the first enum value and change `default`
to `"targetedGitignore"`.

**Implementation:**

```diff
         "switchboard.workspace.ignoreStrategy": {
           "type": "string",
           "enum": [
+            "targetedGitignore",
             "localExclude",
             "gitignore",
             "none"
           ],
-          "default": "localExclude",
+          "default": "targetedGitignore",
           "enumDescriptions": [
+            "Write targeted rules to .gitignore — ignores machine-local state while keeping plans, workflows, and protocol docs tracked (recommended)",
             "Write rules to .git/info/exclude (local only, not committed)",
             "Write rules to .gitignore (committed to repo)",
             "Do not manage ignore rules (manual management required)"
           ],
           "description": "Strategy for excluding Switchboard files from git tracking.",
           "scope": "resource"
         },
```

---

#### Clarification — authoritative final package.json block
- Replace gitignore with custom in the enum rather than adding targetedGitignore alongside the old preset.
- Keep the existing ignoreRules default array for backward compatibility, because localExclude and previously saved workspaces still rely on that stored array.
- Clarification: the ignoreRules description should explain that the array backs localExclude and custom storage even though targetedGitignore ignores it at apply time.

```json
"switchboard.workspace.ignoreStrategy": {
  "type": "string",
  "enum": [
    "targetedGitignore",
    "localExclude",
    "custom",
    "none"
  ],
  "default": "targetedGitignore",
  "enumDescriptions": [
    "Write targeted rules to .gitignore while keeping shared plans, reviews, sessions, and workflow files tracked (recommended)",
    "Write rules to .git/info/exclude (local only, not committed)",
    "Write your own rules to .gitignore (editable)",
    "Do not manage ignore rules (manual management required)"
  ],
  "description": "Strategy for excluding Switchboard files from git tracking.",
  "scope": "resource"
},
"switchboard.workspace.ignoreRules": {
  "type": "array",
  "items": {
    "type": "string"
  },
  "default": [
    ".switchboard/*",
    ".agent/*"
  ],
  "description": "Stored ignore rules used by the localExclude preset and the editable custom preset. Each entry is appended as a separate line.",
  "scope": "resource"
}
```

### `src/services/TaskViewerProvider.ts`

#### [MODIFY] `TaskViewerProvider._normalizeGitIgnoreConfig()` — Add `targetedGitignore`

**Context:** Lines 1786–1795. The normalization function currently only accepts
`'gitignore'` and `'none'`, falling back everything else to `'localExclude'`.

**Logic:** Expand the valid strategy union and update the fallback default.

```diff
     private _normalizeGitIgnoreConfig(
         rawStrategy: unknown,
         rawRules: unknown
-    ): { strategy: 'localExclude' | 'gitignore' | 'none'; rules: string[] } {
-        const strategy = rawStrategy === 'gitignore' || rawStrategy === 'none' ? rawStrategy : 'localExclude';
+    ): { strategy: 'targetedGitignore' | 'localExclude' | 'custom' | 'none'; rules: string[] } {
+        const validStrategies = new Set(['targetedGitignore', 'localExclude', 'custom', 'none']);
+        const strategy = validStrategies.has(rawStrategy as string)
+            ? rawStrategy as 'targetedGitignore' | 'localExclude' | 'custom' | 'none'
+            : 'targetedGitignore';
         const rules = Array.isArray(rawRules)
             ? Array.from(new Set(rawRules.map(rule => String(rule).trim()).filter(Boolean)))
             : [];
         return { strategy, rules };
     }
```

#### [MODIFY] `TaskViewerProvider.handleGetGitIgnoreConfig()` — Update default

**Context:** Line 1778–1784. The `config.get` fallback for `ignoreStrategy` must
change from `'localExclude'` to `'targetedGitignore'`.

```diff
     public handleGetGitIgnoreConfig(): {
         strategy: 'targetedGitignore' | 'localExclude' | 'custom' | 'none';
         rules: string[];
         targetedRulesDisplay: string[];
     } {
         const config = vscode.workspace.getConfiguration('switchboard.workspace');
         const { strategy, rules } = this._normalizeGitIgnoreConfig(
-            config.get<string>('ignoreStrategy', 'localExclude'),
-            config.get<string[]>('ignoreRules', [])
+            config.get<string>('ignoreStrategy', 'targetedGitignore'),
+            config.get<string[]>('ignoreRules', ['.switchboard/*', '.agent/*'])
         );
+        return {
+            strategy,
+            rules,
+            targetedRulesDisplay: WorkspaceExcludeService.getTargetedRules()
+        };
      }
 ```

#### [MODIFY] `TaskViewerProvider._persistGitIgnoreConfig()` — Rebroadcast the enriched payload after saves

**Context:** Lines 1848-1857 currently normalize and persist the config, but then emit only `{ strategy, rules }`. Once the setup UI relies on `targetedRulesDisplay` for readonly preset rendering, that partial payload becomes a regression path after autosave.

**Logic:** Reuse the same backend contract after saves that initial hydration already uses: persist the normalized strategy/rules, derive `targetedRulesDisplay` from `WorkspaceExcludeService.getTargetedRules()`, then broadcast the full object through `_postSharedWebviewMessage`.

**Implementation:**

```diff
     private async _persistGitIgnoreConfig(
         rawStrategy: unknown,
         rawRules: unknown,
         options: { emitApplyResult: boolean }
     ): Promise<void> {
         const { strategy, rules } = this._normalizeGitIgnoreConfig(rawStrategy, rawRules);
         const config = vscode.workspace.getConfiguration('switchboard.workspace');
         await config.update('ignoreStrategy', strategy, vscode.ConfigurationTarget.Workspace);
         await config.update('ignoreRules', rules, vscode.ConfigurationTarget.Workspace);
-        this._postSharedWebviewMessage({ type: 'gitIgnoreConfig', strategy, rules });
+        this._postSharedWebviewMessage({
+            type: 'gitIgnoreConfig',
+            strategy,
+            rules,
+            targetedRulesDisplay: WorkspaceExcludeService.getTargetedRules()
+        });
         if (options.emitApplyResult) {
             this._postSharedWebviewMessage({ type: 'saveGitIgnoreConfigResult', success: true });
         }
     }
```

> [!NOTE]
> Keep the `ignoreRules` default array as `['.switchboard/*', '.agent/*']` for
> backward compatibility. The new default is the **strategy** (`targetedGitignore`),
> not silent deletion of previously stored editable rules.

---

#### Clarification — authoritative backend contract for src/services/TaskViewerProvider.ts
- handleGetGitIgnoreConfig() should return the normalized strategy, the persisted editable rules array, and a targetedRulesDisplay array sourced from WorkspaceExcludeService.getTargetedRules().
- _normalizeGitIgnoreConfig() should treat targetedGitignore as the fallback for legacy or invalid values, but it should not erase the stored ignoreRules array.
- _persistGitIgnoreConfig() can keep writing ignoreRules exactly as received, but it must rebroadcast the same enriched `gitIgnoreConfig` payload shape used during initial hydration so autosave does not strip the readonly targeted preview.
- postSetupPanelState() already calls handleGetGitIgnoreConfig(); keep relying on that shared entry point so one backend method defines the canonical setup-panel hydration shape.

```typescript
public handleGetGitIgnoreConfig(): {
    strategy: 'targetedGitignore' | 'localExclude' | 'custom' | 'none';
    rules: string[];
    targetedRulesDisplay: string[];
} {
    const config = vscode.workspace.getConfiguration('switchboard.workspace');
    const { strategy, rules } = this._normalizeGitIgnoreConfig(
        config.get<string>('ignoreStrategy', 'targetedGitignore'),
        config.get<string[]>('ignoreRules', ['.switchboard/*', '.agent/*'])
    );
    return {
        strategy,
        rules,
        targetedRulesDisplay: WorkspaceExcludeService.getTargetedRules()
    };
}

private _normalizeGitIgnoreConfig(
    rawStrategy: unknown,
    rawRules: unknown
): { strategy: 'targetedGitignore' | 'localExclude' | 'custom' | 'none'; rules: string[] } {
    const validStrategies = new Set(['targetedGitignore', 'localExclude', 'custom', 'none']);
    const strategy = validStrategies.has(rawStrategy as string)
        ? rawStrategy as 'targetedGitignore' | 'localExclude' | 'custom' | 'none'
        : 'targetedGitignore';
    const rules = Array.isArray(rawRules)
        ? Array.from(new Set(rawRules.map(rule => String(rule).trim()).filter(Boolean)))
        : [];
    return { strategy, rules };
}

private async _persistGitIgnoreConfig(
    rawStrategy: unknown,
    rawRules: unknown,
    options: { emitApplyResult: boolean }
): Promise<void> {
    const { strategy, rules } = this._normalizeGitIgnoreConfig(rawStrategy, rawRules);
    const config = vscode.workspace.getConfiguration('switchboard.workspace');
    await config.update('ignoreStrategy', strategy, vscode.ConfigurationTarget.Workspace);
    await config.update('ignoreRules', rules, vscode.ConfigurationTarget.Workspace);
    this._postSharedWebviewMessage({
        type: 'gitIgnoreConfig',
        strategy,
        rules,
        targetedRulesDisplay: WorkspaceExcludeService.getTargetedRules()
    });
    if (options.emitApplyResult) {
        this._postSharedWebviewMessage({ type: 'saveGitIgnoreConfigResult', success: true });
    }
}
```

### High-Complexity / Risky Implementation Steps
1. Replace the append-only file mutation model in `src/services/WorkspaceExcludeService.ts` with fenced managed-block helpers that can upsert, replace, and remove only the Switchboard-owned region while preserving all surrounding user-authored text verbatim.
2. Make strategy switching symmetric across both candidate targets: `targetedGitignore` and `custom` own `<workspaceRoot>/.gitignore`, `localExclude` owns `<workspaceRoot>/.git/info/exclude`, and `none` removes the managed block from both files without touching unmanaged residue.
3. Rework `src/webview/setup.html` rendering so preset previews are read-only, but the persisted editable rule draft survives toggling to `targetedGitignore`, `localExclude`, or `none` and then back to `custom`.
4. Align backend and frontend message payloads so initial hydration, autosave rebroadcasts, and subsequent setup refreshes all operate on the same normalized `{ strategy, rules, targetedRulesDisplay }` state.
5. Sequence work carefully against the active Visual Kanban Structure Reordering plan because both plans edit `src/webview/setup.html` and `src/services/TaskViewerProvider.ts`.

### `src/services/WorkspaceExcludeService.ts`

#### [MODIFY] `WorkspaceExcludeService.ts` — Add `targetedGitignore` branch

**Context:** The `apply()` method currently handles `localExclude`, `gitignore`,
and `none`. A new branch must handle `targetedGitignore`.

**Logic:**
1. Define a `TARGETED_RULES` static constant array containing the exact targeted
    rule set documented above, including blank-line separators and comment lines.
2. In `apply()`, update the default strategy fallback from `'localExclude'` to
    `'targetedGitignore'`.
3. Add explicit block markers such as `BLOCK_START` / `BLOCK_END` so Switchboard can
   safely replace or remove only its own managed section.
4. Upsert the managed block into the active target file and remove it from the inactive
   target file whenever the strategy changes.
5. Preserve all content outside the fenced block verbatim, even though the final write
   path may use `writeFile()` after in-memory block replacement.

**Implementation:**

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class WorkspaceExcludeService {
    private static readonly HEADER_COMMENT = '# Switchboard managed exclusions';

    /**
     * Targeted rules written by the `targetedGitignore` strategy.
     * Mirrors the repo's own .gitignore pattern: ignore machine-local state
     * while preserving plans, reviews, sessions, and shared protocol docs.
     */
    private static readonly TARGETED_RULES: string[] = [
        '# Switchboard runtime state (per-session, not shareable)',
        '.switchboard/*',
        '!.switchboard/reviews/',
        '!.switchboard/plans/',
        '!.switchboard/sessions/',
        '!.switchboard/CLIENT_CONFIG.md',
        '!.switchboard/README.md',
        '!.switchboard/SWITCHBOARD_PROTOCOL.md',
        '!.switchboard/workspace-id',
        '',
        '# ClickUp integration config (workspace-specific IDs)',
        '.switchboard/clickup-config.json',
        '',
        '# Linear integration config (workspace-specific IDs and sync map)',
        '.switchboard/linear-config.json',
        '.switchboard/linear-sync.json',
        '',
        '# Notion integration config and page content cache',
        '.switchboard/notion-config.json',
        '.switchboard/notion-cache.md',
        '',
        '# kanban.db is already excluded by .switchboard/* above \u2014 explicit entry for documentation clarity.',
        '# Never commit the kanban database: it contains machine-local state that differs per developer.',
        '.switchboard/kanban.db',
        '.switchboard/*.db-shm',
        '.switchboard/*.db-wal',
    ];

    constructor(private readonly workspaceRoot: string) {}

    async apply(): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard.workspace');
        const strategy: string = config.get('ignoreStrategy', 'targetedGitignore');
        const rules: string[] = config.get('ignoreRules', ['.switchboard/*', '.agent/*']);

        if (strategy === 'none') {
            console.log('[WorkspaceExcludeService] Strategy is "none" — skipping exclusion management.');
            return;
        }

        const gitRoot = path.join(this.workspaceRoot, '.git');
        if (!fs.existsSync(gitRoot) || !fs.statSync(gitRoot).isDirectory()) {
            console.log('[WorkspaceExcludeService] No .git directory found — skipping.');
            return;
        }

        let targetFile: string;
        let effectiveRules: string[];

        if (strategy === 'targetedGitignore') {
            targetFile = path.join(this.workspaceRoot, '.gitignore');
            effectiveRules = WorkspaceExcludeService.TARGETED_RULES;
        } else if (strategy === 'localExclude') {
            const infoDir = path.join(gitRoot, 'info');
            fs.mkdirSync(infoDir, { recursive: true });
            targetFile = path.join(infoDir, 'exclude');
            effectiveRules = rules;
        } else if (strategy === 'custom') {
            // Custom: user-managed rules written to .gitignore
            targetFile = path.join(this.workspaceRoot, '.gitignore');
            effectiveRules = rules;
        } else {
            console.warn(`[WorkspaceExcludeService] Unknown strategy "${strategy}" — skipping.`);
            return;
        }

        let existingContent = '';
        try {
            existingContent = await fs.promises.readFile(targetFile, 'utf-8');
        } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
        }

        const existingLines = new Set(existingContent.split('\n').map(l => l.trim()));
        // For targeted strategy, only check non-comment, non-empty lines for dedup
        const missingRules = effectiveRules.filter(rule => {
            const trimmed = rule.trim();
            if (trimmed === '' || trimmed.startsWith('#')) return false; // always include structural lines separately
            return !existingLines.has(trimmed);
        });

        if (missingRules.length === 0) {
            console.log('[WorkspaceExcludeService] All rules already present — no changes needed.');
            return;
        }

        const block = [
            '',
            WorkspaceExcludeService.HEADER_COMMENT,
            ...effectiveRules,
            ''
        ].join('\n');

        await fs.promises.appendFile(targetFile, block, 'utf-8');
        console.log(`[WorkspaceExcludeService] Appended ${missingRules.length} rule(s) to ${path.basename(targetFile)}`);
    }

    /**
     * Returns the targeted rule set for display purposes (used by the Setup UI).
     */
    static getTargetedRules(): string[] {
        return [...WorkspaceExcludeService.TARGETED_RULES];
    }
}
```

> [!NOTE]
> The old append-only approach is no longer sufficient because users may experiment
> with multiple strategies. The authoritative behavior in this plan is a fenced
> managed-block model: Switchboard updates or removes only its own marked section and
> leaves unrelated user-owned lines untouched.

---

#### Clarification — authoritative managed-block logic in src/services/WorkspaceExcludeService.ts
- Clarification: TARGETED_RULES should include comment lines and blank-string separators so both the writer and the readonly setup preview mirror the repo's `.gitignore` block exactly, but Switchboard must own them through explicit block markers rather than line-by-line append heuristics.
- If the managed block exists in a target file, replace only the contents of that block.
- If the managed block does not exist, append one new block to the end of the file.
- If the strategy changes, remove the managed block from the previously relevant target file and upsert the managed block into the newly relevant target file.
- If the strategy becomes `none`, remove the managed block from both `.gitignore` and `.git/info/exclude`.
- custom should write to `.gitignore` using the stored ignoreRules array; localExclude should keep writing to `.git/info/exclude` using that same stored array.
- Clarification: legacy unmanaged Switchboard lines outside the fenced block are not owned by this migration and must be preserved.

```typescript
private static readonly BLOCK_START = '# >>> Switchboard managed exclusions >>>';
private static readonly BLOCK_END = '# <<< Switchboard managed exclusions <<<';
private static readonly TARGETED_RULES: string[] = [
    '# Switchboard runtime state (per-session, not shareable)',
    '.switchboard/*',
    '!.switchboard/reviews/',
    '!.switchboard/plans/',
    '!.switchboard/sessions/',
    '!.switchboard/CLIENT_CONFIG.md',
    '!.switchboard/README.md',
    '!.switchboard/SWITCHBOARD_PROTOCOL.md',
    '!.switchboard/workspace-id',
    '',
    '# ClickUp integration config (workspace-specific IDs)',
    '.switchboard/clickup-config.json',
    '',
    '# Linear integration config (workspace-specific IDs and sync map)',
    '.switchboard/linear-config.json',
    '.switchboard/linear-sync.json',
    '',
    '# Notion integration config and page content cache',
    '.switchboard/notion-config.json',
    '.switchboard/notion-cache.md',
    '',
    '# kanban.db is already excluded by .switchboard/* above — explicit entry for documentation clarity.',
    '# Never commit the kanban database: it contains machine-local state that differs per developer.',
    '.switchboard/kanban.db',
    '.switchboard/*.db-shm',
    '.switchboard/*.db-wal',
];

private _renderManagedBlock(rules: string[]): string {
    return [
        WorkspaceExcludeService.BLOCK_START,
        ...rules,
        WorkspaceExcludeService.BLOCK_END
    ].join('\n');
}

private async _readTargetFile(targetFile: string): Promise<string> {
    try {
        return await fs.promises.readFile(targetFile, 'utf-8');
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return '';
        }
        throw error;
    }
}

private _replaceManagedBlock(existingContent: string, nextBlock: string | null): string {
    const normalized = existingContent.replace(/\r\n/g, '\n');
    const escapedStart = WorkspaceExcludeService.BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedEnd = WorkspaceExcludeService.BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockPattern = new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'm');
    const trimmedBlock = nextBlock ? nextBlock.trimEnd() : '';

    if (blockPattern.test(normalized)) {
        const replaced = trimmedBlock
            ? normalized.replace(blockPattern, `\n${trimmedBlock}\n`)
            : normalized.replace(blockPattern, '\n');
        return replaced.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    }

    if (!trimmedBlock) {
        return normalized;
    }

    const base = normalized.trimEnd();
    return `${base}${base ? '\n\n' : ''}${trimmedBlock}\n`;
}

private async _upsertManagedBlock(targetFile: string, rules: string[]): Promise<void> {
    const existingContent = await this._readTargetFile(targetFile);
    const nextContent = this._replaceManagedBlock(existingContent, this._renderManagedBlock(rules));
    if (nextContent === existingContent) {
        return;
    }
    await fs.promises.writeFile(targetFile, nextContent, 'utf-8');
}

private async _removeManagedBlock(targetFile: string): Promise<void> {
    const existingContent = await this._readTargetFile(targetFile);
    const nextContent = this._replaceManagedBlock(existingContent, null);
    if (nextContent === existingContent) {
        return;
    }
    await fs.promises.writeFile(targetFile, nextContent, 'utf-8');
}

async apply(): Promise<void> {
    const config = vscode.workspace.getConfiguration('switchboard.workspace');
    const strategy: string = config.get('ignoreStrategy', 'targetedGitignore');
    const storedRules: string[] = config.get('ignoreRules', ['.switchboard/*', '.agent/*']);

    if (strategy === 'none') {
        return;
    }

    const gitRoot = path.join(this.workspaceRoot, '.git');
    if (!fs.existsSync(gitRoot) || !fs.statSync(gitRoot).isDirectory()) {
        return;
    }

    const gitignoreFile = path.join(this.workspaceRoot, '.gitignore');
    const infoDir = path.join(gitRoot, 'info');
    const excludeFile = path.join(infoDir, 'exclude');
    fs.mkdirSync(infoDir, { recursive: true });

    if (strategy === 'targetedGitignore') {
        await this._upsertManagedBlock(gitignoreFile, WorkspaceExcludeService.TARGETED_RULES);
        await this._removeManagedBlock(excludeFile);
    } else if (strategy === 'localExclude') {
        await this._removeManagedBlock(gitignoreFile);
        await this._upsertManagedBlock(excludeFile, storedRules);
    } else if (strategy === 'custom') {
        await this._upsertManagedBlock(gitignoreFile, storedRules);
        await this._removeManagedBlock(excludeFile);
    } else if (strategy === 'none') {
        await this._removeManagedBlock(gitignoreFile);
        await this._removeManagedBlock(excludeFile);
    }
}

static getTargetedRules(): string[] {
    return [...WorkspaceExcludeService.TARGETED_RULES];
}
```

> [!NOTE]
> The retained implementation snippet above reflects the earlier minimal append-only
> sketch. It is preserved for history, but the **authoritative** final behavior is the
> managed-block contract in the clarification section below.

#### Clarification — no direct change required in src/services/SetupPanelProvider.ts
- The existing handler at src/services/SetupPanelProvider.ts lines 181-183 already forwards the entire object returned by TaskViewerProvider.handleGetGitIgnoreConfig().
- Clarification: document this explicitly so the coder does not waste scope adding duplicate message plumbing.

### `src/webview/setup.html`

#### [MODIFY] `setup.html` — Five coordinated changes

**Change A — Add `targetedGitignore` option to the strategy dropdown (line 390–394)**

```diff
     <select id="git-ignore-strategy" ...>
+        <option value="targetedGitignore">targetedGitignore — .gitignore (targeted, recommended)</option>
         <option value="localExclude">localExclude - .git/info/exclude (local only)</option>
-        <option value="gitignore">gitignore - .gitignore (committed)</option>
+        <option value="custom">custom — .gitignore (you manage the rules)</option>
         <option value="none">none - do not manage ignore files</option>
     </select>
```

**Change B — Make textarea read-only by default (line 398)**

```diff
-    <textarea id="git-ignore-rules" class="modal-textarea" style="min-height:96px; font-size:11px;" placeholder=".switchboard/*&#10;.agent/*"></textarea>
+    <textarea id="git-ignore-rules" class="modal-textarea" style="min-height:96px; font-size:11px;" readonly
+              placeholder="Rules displayed here (read-only for preset strategies)"></textarea>
```

**Change C — Update `lastGitIgnoreConfig` initializer (lines 799–802)**

```diff
         let lastGitIgnoreConfig = {
-            strategy: 'localExclude',
-            rules: ['.switchboard/*', '.agent/*']
+            strategy: 'targetedGitignore',
+            rules: ['.switchboard/*', '.agent/*'],
+            targetedRulesDisplay: ''
         };
```

**Change D — Cache backend-supplied `targetedRulesDisplay`, update
`renderGitIgnoreConfig()`, and keep the strategy-change listener read-only-aware
(around line 1097–1103 and 1287)**

The frontend should not duplicate the targeted preset. Instead, cache the
backend-supplied `targetedRulesDisplay` from the `gitIgnoreConfig` message and
render that cached preview whenever the selected strategy is `targetedGitignore`.

```javascript
function getRulesDisplayForStrategy(strategy) {
    if (strategy === 'targetedGitignore') return lastGitIgnoreConfig.targetedRulesDisplay || '';
    if (strategy === 'none') return '';
    return lastGitIgnoreConfig.rules.join('\n');
}
```

**Change E — Keep readonly preset previews from overwriting the stored custom draft in `collectSetupSavePayload()` (around line 1111–1119)**

```diff
     function collectSetupSavePayload() {
         const accurateCodingEnabled = !!document.getElementById('accurate-coding-toggle')?.checked;
         const advancedReviewerEnabled = !!document.getElementById('advanced-reviewer-toggle')?.checked;
         const leadChallengeEnabled = !!document.getElementById('lead-challenge-toggle')?.checked;
         const aggressivePairProgramming = !!document.getElementById('aggressive-pair-toggle')?.checked;
         const designDocEnabled = !!document.getElementById('design-doc-toggle')?.checked;
         const planIngestionFolder = document.getElementById('plan-ingestion-folder-input')?.value.trim() || '';
-        const gitIgnoreStrategy = document.getElementById('git-ignore-strategy')?.value || 'localExclude';
-        const gitIgnoreRules = sanitizeGitIgnoreRules(document.getElementById('git-ignore-rules')?.value || '');
+        const gitIgnoreStrategy = document.getElementById('git-ignore-strategy')?.value || 'targetedGitignore';
+        const gitIgnoreRules = gitIgnoreStrategy === 'custom'
+            ? sanitizeGitIgnoreRules(document.getElementById('git-ignore-rules')?.value || '')
+            : [...lastGitIgnoreConfig.rules];
         const commands = {
             ...lastStartupCommands,
             'team-lead': teamLeadCommandInput?.value.trim() || ''
         };
+        lastGitIgnoreConfig = {
+            ...lastGitIgnoreConfig,
+            strategy: gitIgnoreStrategy,
+            rules: gitIgnoreRules
+        };
         document.querySelectorAll('#agents-fields input[type="text"][data-role]').forEach(input => {
             const role = input.dataset.role;
             if (role) {
                 commands[role] = input.value.trim();
             }
```

Update `renderGitIgnoreConfig()`:

```javascript
function renderGitIgnoreConfig() {
    const strategySelect = document.getElementById('git-ignore-strategy');
    const rulesTextarea = document.getElementById('git-ignore-rules');
    if (strategySelect) strategySelect.value = lastGitIgnoreConfig.strategy;
    if (rulesTextarea) {
        rulesTextarea.value = getRulesDisplayForStrategy(lastGitIgnoreConfig.strategy);
        // Read-only for all preset strategies; editable only for 'custom'
        rulesTextarea.readOnly = lastGitIgnoreConfig.strategy !== 'custom';
    }
    updateGitIgnoreTargetStatus();
}
```

Update the strategy dropdown change listener (around line 1287):

```javascript
document.getElementById('git-ignore-strategy')?.addEventListener('change', () => {
    const strategy = document.getElementById('git-ignore-strategy')?.value || 'targetedGitignore';
    lastGitIgnoreConfig = { ...lastGitIgnoreConfig, strategy };
    renderGitIgnoreConfig();
});
```

Update `updateGitIgnoreTargetStatus()` map to include `targetedGitignore`:

```javascript
function updateGitIgnoreTargetStatus() {
    const strategy = document.getElementById('git-ignore-strategy')?.value || 'targetedGitignore';
    const targetMap = {
        targetedGitignore: '.gitignore (targeted)',
        localExclude: '.git/info/exclude',
        custom: '.gitignore (custom)',
        none: 'No file (manual management)'
    };
    const status = document.getElementById('git-ignore-target-status');
    if (status) {
        status.textContent = `Target: ${targetMap[strategy] || strategy}`;
    }
}
```

Update `gitIgnoreConfig` message handler (line 1563–1571) to guard against
`targetedGitignore` receiving a stale rules fallback:

```diff
     case 'gitIgnoreConfig': {
         runSetupHydration(() => {
-            const strategy = ['localExclude', 'gitignore', 'none'].includes(message.strategy) ? message.strategy : 'localExclude';
+            const validStrategies = ['targetedGitignore', 'localExclude', 'custom', 'none'];
+            const strategy = validStrategies.includes(message.strategy) ? message.strategy : 'targetedGitignore';
             const rules = Array.isArray(message.rules)
                 ? message.rules.map(rule => String(rule).trim()).filter(Boolean)
-                : ['.switchboard/*', '.agent/*'];
+                : ['.switchboard/*', '.agent/*'];
+            const targetedRulesDisplay = Array.isArray(message.targetedRulesDisplay)
+                ? message.targetedRulesDisplay.map(rule => String(rule)).join('\n')
+                : '';
+            lastGitIgnoreConfig = { strategy, rules, targetedRulesDisplay };
             renderGitIgnoreConfig();
         });
         break;
     }
```

---

#### Clarification — authoritative setup-state handling in src/webview/setup.html
- lastGitIgnoreConfig should cache three things: the selected strategy, the persisted editable rules array, and the backend-supplied targetedRulesDisplay string or array.
- renderGitIgnoreConfig() should compute the textarea value from strategy plus cached data, then set rulesTextarea.readOnly = strategy !== 'custom'.
- collectSetupSavePayload() should only sanitize the textarea into gitIgnoreRules when strategy === 'custom'. For targetedGitignore and none it should reuse lastGitIgnoreConfig.rules so custom drafts are not lost; for localExclude it may reuse the cached rules because the textarea is readonly and already displays those stored rules.
- The gitIgnoreConfig message handler should accept targetedRulesDisplay from the backend and default unknown strategies to targetedGitignore.

```javascript
let lastGitIgnoreConfig = {
    strategy: 'targetedGitignore',
    rules: ['.switchboard/*', '.agent/*'],
    targetedRulesDisplay: ''
};

function getRulesDisplayForStrategy(strategy) {
    if (strategy === 'targetedGitignore') return lastGitIgnoreConfig.targetedRulesDisplay || '';
    if (strategy === 'none') return '';
    return lastGitIgnoreConfig.rules.join('\n');
}

function renderGitIgnoreConfig() {
    const strategySelect = document.getElementById('git-ignore-strategy');
    const rulesTextarea = document.getElementById('git-ignore-rules');
    if (strategySelect) strategySelect.value = lastGitIgnoreConfig.strategy;
    if (rulesTextarea) {
        rulesTextarea.value = getRulesDisplayForStrategy(lastGitIgnoreConfig.strategy);
        rulesTextarea.readOnly = lastGitIgnoreConfig.strategy !== 'custom';
    }
    updateGitIgnoreTargetStatus();
}

function collectSetupSavePayload() {
    const gitIgnoreStrategy = document.getElementById('git-ignore-strategy')?.value || 'targetedGitignore';
    const gitIgnoreRules = gitIgnoreStrategy === 'custom'
        ? sanitizeGitIgnoreRules(document.getElementById('git-ignore-rules')?.value || '')
        : [...lastGitIgnoreConfig.rules];

    lastGitIgnoreConfig = {
        ...lastGitIgnoreConfig,
        strategy: gitIgnoreStrategy,
        rules: gitIgnoreRules
    };

    return {
        type: 'saveStartupCommands',
        gitIgnoreStrategy,
        gitIgnoreRules
    };
}

document.getElementById('git-ignore-strategy')?.addEventListener('change', () => {
    const strategy = document.getElementById('git-ignore-strategy')?.value || 'targetedGitignore';
    lastGitIgnoreConfig = { ...lastGitIgnoreConfig, strategy };
    renderGitIgnoreConfig();
});

case 'gitIgnoreConfig': {
    runSetupHydration(() => {
        const validStrategies = ['targetedGitignore', 'localExclude', 'custom', 'none'];
        const strategy = validStrategies.includes(message.strategy) ? message.strategy : 'targetedGitignore';
        const rules = Array.isArray(message.rules)
            ? message.rules.map(rule => String(rule).trim()).filter(Boolean)
            : ['.switchboard/*', '.agent/*'];
        const targetedRulesDisplay = Array.isArray(message.targetedRulesDisplay)
            ? message.targetedRulesDisplay.map(rule => String(rule)).join('\n')
            : '';
        lastGitIgnoreConfig = { strategy, rules, targetedRulesDisplay };
        renderGitIgnoreConfig();
    });
    break;
}
```

## Verification Plan

### Automated Tests
- npm run compile — verifies the extension still builds after the enum, provider, and webview changes.
- npx tsc --noEmit — keep the existing type-checking spot-check from the original plan; no new TypeScript errors should be introduced in WorkspaceExcludeService.ts, TaskViewerProvider.ts, or setup.html string injection paths. Clarification: if the known pre-existing dynamic-import complaint in `src/services/KanbanProvider.ts` still appears unchanged, treat it as baseline noise rather than a regression in this task.

### Manual Verification
- [ ] Open the Setup panel in a fresh workspace and confirm the strategy dropdown defaults to targetedGitignore.
- [ ] Confirm the textarea shows the targeted rule preview, including the same blank separators and kanban-db comment wording as the root `.gitignore` block, and is readonly when targetedGitignore is selected.
- [ ] Seed `.gitignore` with one unrelated user rule above and one below the future Switchboard region, click APPLY twice, and verify both user rules remain byte-for-byte unchanged while exactly one fenced Switchboard-managed block exists.
- [ ] Switch to localExclude and confirm the target label changes to .git/info/exclude while the textarea remains readonly.
- [ ] After switching to `localExclude`, verify the Switchboard-managed block is removed from `.gitignore` and appears in `.git/info/exclude`, with unrelated `.gitignore` lines preserved.
- [ ] Switch to custom, enter a distinct custom rule set, save, switch to targetedGitignore, then switch back to custom and confirm the draft is still present.
- [ ] Save once while `targetedGitignore` is selected, then wait for autosave/hydration to settle and confirm the readonly preview still shows the targeted block instead of collapsing back to the stored custom/local rules array.
- [ ] After saving `custom`, verify the fenced block in `.gitignore` is replaced with the custom rules rather than appended as a second Switchboard section.
- [ ] Select `none` and confirm the Switchboard-managed block is removed from both candidate target files while unrelated user-owned lines remain untouched.
- [ ] Verify .agent/ remains searchable and unignored after applying targetedGitignore.
- [ ] Verify .switchboard/plans/ remains tracked while .switchboard/kanban.db and .switchboard/*.db-wal remain ignored.
- [ ] If a repo contains legacy unmanaged Switchboard lines from older append-only behavior, verify the new implementation leaves those unmanaged lines untouched and only guarantees correctness for the fenced block.

## Recommendation
**Send to Lead Coder** (Complexity 7).
The work spans `package.json`, `.gitignore`, `src/services/WorkspaceExcludeService.ts`, `src/services/TaskViewerProvider.ts`, and `src/webview/setup.html`, and the hard part is not the enum rename but the cross-layer state contract: file-mutation safety, readonly preset rendering, autosave rebroadcast parity, and a live merge hotspot with the active Visual Kanban Structure Reordering plan. That combination pushes it into high-complexity territory even though the feature boundary is still local.

## Reviewer Addendum (2026-04-11)
### Stage 1 - Grumpy Critique
- **CRITICAL:** None. The managed-block rewrite is structurally sound and no longer plays append-only roulette with `.gitignore`.
- **MAJOR:** `WorkspaceExcludeService.apply()` was still reading the raw `ignoreStrategy` value straight from config and branching on it directly. That means legacy or invalid persisted values (notably the removed `gitignore` preset) bypass the new normalization contract and silently skip exclusion management on activation/config change — precisely where the real writer runs.
- **NIT:** `TARGETED_RULES` is functionally aligned with the repo block, but its whitespace formatting is not byte-for-byte identical to the current root `.gitignore` snippet.

### Stage 2 - Balanced Response
- **Keep:** The new enum/default, readonly preset rendering, and fenced managed-block writer are the right implementation.
- **Fix now:** Normalize strategy values in the actual writer path and reuse that same normalization in `TaskViewerProvider` so the UI contract and file-mutation contract cannot drift.
- **Defer:** Exact formatting parity with the checked-in `.gitignore` block is cosmetic compared with the normalization bug and can wait for a dedicated cleanup if desired.

### Fixed Items
- Added shared strategy normalization in `WorkspaceExcludeService.normalizeStrategy()`.
- Updated `WorkspaceExcludeService.apply()` to normalize persisted `ignoreStrategy` before writing managed blocks.
- Updated `TaskViewerProvider._normalizeGitIgnoreConfig()` to reuse the same normalization helper.
- Added `src/test/workspace-exclude-strategy-regression.test.js` to lock the writer/UI normalization contract together.

### Files Changed During Review
- `src/services/WorkspaceExcludeService.ts`
- `src/services/TaskViewerProvider.ts`
- `src/test/workspace-exclude-strategy-regression.test.js`
- `.switchboard/plans/brain_a5243677e6100f40a729fd8c8416490e12fe5b5d0e5eb4fd73a7e3a42a58d694_restore_targeted_gitignore_strategy_as_default_for_workspace_exclusion_system.md`

### Validation Results
- `npm run compile`
- `node src/test/setup-autosave-regression.test.js`
- `node src/test/workspace-exclude-strategy-regression.test.js`

### Remaining Risks
- `TARGETED_RULES` still differs slightly from the checked-in `.gitignore` block in blank-line formatting, but the managed behavior and rule set are now correct.

## Reviewer Addendum (2026-04-11)
### Stage 1 - Grumpy Critique
- **CRITICAL:** None. The managed-block rewrite is structurally sound and no longer plays append-only roulette with `.gitignore`.
- **MAJOR:** `WorkspaceExcludeService.apply()` was still reading the raw `ignoreStrategy` value straight from config and branching on it directly. That means legacy or invalid persisted values (notably the removed `gitignore` preset) bypass the new normalization contract and silently skip exclusion management on activation/config change — precisely where the real writer runs.
- **NIT:** `TARGETED_RULES` is functionally aligned with the repo block, but its whitespace formatting is not byte-for-byte identical to the current root `.gitignore` snippet.

### Stage 2 - Balanced Response
- **Keep:** The new enum/default, readonly preset rendering, and fenced managed-block writer are the right implementation.
- **Fix now:** Normalize strategy values in the actual writer path and reuse that same normalization in `TaskViewerProvider` so the UI contract and file-mutation contract cannot drift.
- **Defer:** Exact formatting parity with the checked-in `.gitignore` block is cosmetic compared with the normalization bug and can wait for a dedicated cleanup if desired.

### Fixed Items
- Added shared strategy normalization in `WorkspaceExcludeService.normalizeStrategy()`.
- Updated `WorkspaceExcludeService.apply()` to normalize persisted `ignoreStrategy` before writing managed blocks.
- Updated `TaskViewerProvider._normalizeGitIgnoreConfig()` to reuse the same normalization helper.
- Added `src/test/workspace-exclude-strategy-regression.test.js` to lock the writer/UI normalization contract together.

### Files Changed During Review
- `src/services/WorkspaceExcludeService.ts`
- `src/services/TaskViewerProvider.ts`
- `src/test/workspace-exclude-strategy-regression.test.js`
- `.switchboard/plans/brain_a5243677e6100f40a729fd8c8416490e12fe5b5d0e5eb4fd73a7e3a42a58d694_restore_targeted_gitignore_strategy_as_default_for_workspace_exclusion_system.md`

### Validation Results
- `npm run compile`
- `node src/test/setup-autosave-regression.test.js`
- `node src/test/workspace-exclude-strategy-regression.test.js`

### Remaining Risks
- `TARGETED_RULES` still differs slightly from the checked-in `.gitignore` block in blank-line formatting, but the managed behavior and rule set are now correct.
