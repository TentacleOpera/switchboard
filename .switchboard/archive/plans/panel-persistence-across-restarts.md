# Panel Persistence Across IDE Restarts

## Goal

Add a single global toggle in `setup.html` labeled **"Persist Switchboard panels across IDE restarts"**. When enabled, any Switchboard panels (Kanban, Project, Planning, Design) that were open when VS Code: last closed will automatically reopen on the next startup. When disabled, panels behave as they do today — they do not restore.

**Core problem, background, and root-cause analysis:**
Today, all four Switchboard webview panels (Kanban, Project, Planning, Design) are created on-demand via `createWebviewPanel` and disposed when the user closes them or VS Code: shuts down. When VS Code: restarts, none of these panels reopen automatically. Users must manually invoke commands (`switchboard.openKanban`, `switchboard.openProjectPanel`, etc.) to restore their workspace layout.

The internal state of these panels (active tabs, filters, dropdown selections) is already persisted via `PanelStateStore` into `ExtensionContext.globalState`. However, **panel visibility itself** — whether the panel was open — is not tracked or restored anywhere. VS Code:'s native `WebviewPanelSerializer` API is the canonical mechanism for restoring webview panels across restarts, but Switchboard does not currently register serializers for any of its four panel types.

**Scope constraints from user:**
- All-or-nothing (single toggle, not per-panel)
- Only panel visibility (internal tab/filter state is already handled by `PanelStateStore`)
- Global setting (applies across all VS Code: windows)

## Metadata

- **Tags:** frontend, ui, feature
- **Complexity:** 5

## User Review Required

- Confirm toggle label copy: "Persist Switchboard Panels Across IDE Restarts"
- Confirm Setup panel itself should NOT persist (user already said no, but good to re-validate)

## Complexity Audit

### Routine
- Adding a checkbox to `setup.html` and wiring `postMessage` handlers (follows existing toggle patterns like `prevent-agent-file-opening-toggle`)
- Reading/writing a boolean VS Code: configuration value via `getConfiguration().update()`
- Registering `WebviewPanelSerializer` objects at end of `activate()` — standard VS Code: API usage

### Complex / Risky
- Ensuring deserialized panels rehydrate with the same webview options (`localResourceRoots`) and event listeners as freshly created panels, without duplicating dispose logic that could self-terminate the restored panel
- `PlanningPanelProvider.open()` dispose handler calls `this.dispose()`, which disposes ALL shared disposables and the panel itself; a naive deserialize dispose handler could accidentally destroy the whole provider when the user closes a restored panel
- `PlanningPanelProvider.open()` sets up file watchers, adapter registration, and periodic sync; the deserialize path must decide which of these are essential for a restored panel vs. deferred until first interaction
- DesignPanelProvider's `open()` registers a workspace-folder-change listener that refreshes content and re-wires folder watchers; missing this in deserialize means restored Design panels won't react to workspace changes

## Edge-Case & Dependency Audit

- **Race Conditions:** VS Code: may call `deserializeWebviewPanel` before all providers are fully wired (e.g., before `kanbanProvider.setPlanningPanelProvider()`). Registering serializers at the very end of `activate()` after all provider init and command registration mitigates this.
- **Security:** No new secrets or external API calls. The feature only toggles serializer registration.
- **Side Effects:** Disabling the toggle mid-session does not close currently open panels; it only prevents them from restoring on the *next* restart. This is the correct VS Code: behavior, but worth documenting for support.
- **Dependencies & Conflicts:** None. This feature does not depend on other in-flight plans. It touches the same files as general panel UI work but in additive, non-overlapping ways.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) restored `PlanningPanelProvider` panels may silently lose `localResourceRoots` because the proposed `_hydratePanel` omits `_updateWebviewRoots()`, breaking script execution; (2) the `_hydratePanel` dispose handler only nulls the panel reference, unlike `open()` which calls `this.dispose()` — this inconsistency could leak `FileSystemWatcher` disposables on restored panel close; (3) restored `DesignPanelProvider` panels miss the `onDidChangeWorkspaceFolders` listener, so workspace-folder changes won't refresh content. Mitigations: add `_updateWebviewRoots()` to `_hydratePanel`, align dispose behavior with `open()`, and include the workspace-change listener in `DesignPanelProvider.deserializeWebviewPanel()`.

VS Code: provides `vscode.window.registerWebviewPanelSerializer(viewType, serializer)` as the canonical API for restoring webview panels across restarts. When a panel is open at shutdown, VS Code: remembers its `viewType`. On the next activation, it calls the registered serializer's `deserializeWebviewPanel(panel, state)` for each remembered panel. This is the correct, native mechanism — it avoids race conditions, state corruption, and the ambiguity of distinguishing user-closed panels from IDE-shutdown panels.

Our toggle controls whether serializers are registered during `activate()`. When ON, serializers are registered and VS Code: restores open panels. When OFF, no serializers are registered and VS Code: discards the panel restore state.

## Files to Change

| File | What |
|------|------|
| `src/webview/setup.html` | Add toggle UI in the "Setup" tab under "WORKFLOW SETTINGS" |
| `src/webview/setup.html` (inline script) | Add event listener, `postMessage` for get/set, and message handler for `persistPanelsSetting` |
| `src/services/SetupPanelProvider.ts` | Add `getPersistPanelsSetting` / `setPersistPanelsSetting` message handlers |
| `src/services/KanbanProvider.ts` | Add `deserializeWebviewPanel()` method to rehydrate a restored Kanban panel |
| `src/services/PlanningPanelProvider.ts` | Add `deserializeWebviewPanel()` and `deserializeProjectPanel()` methods |
| `src/services/DesignPanelProvider.ts` | Add `deserializeWebviewPanel()` method |
| `src/extension.ts` | After provider initialization, conditionally register serializers based on the global setting |
| `package.json` | Add `switchboard.persistPanels` to `contributes.configuration.properties` for settings.json auto-completion |

## Implementation Details

### 1. Setup UI — `src/webview/setup.html`

In the "Setup" tab (`data-tab-content="setup"`), add a new checkbox under the existing "WORKFLOW SETTINGS" section (after `exclude-reviewed-backlog-toggle`):

```html
<label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
    <input id="persist-panels-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
    <div style="display:flex; flex-direction:column; gap:4px;">
        <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Persist Switchboard Panels Across IDE Restarts</span>
        <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Automatically reopen Kanban, Project, Planning, and Design panels when VS Code: restarts.</span>
    </div>
</label>
```

In the inline `<script>`:
- On `ready`, send `getPersistPanelsSetting` and set the checkbox state on response
- On checkbox change, send `setPersistPanelsSetting` with the new value
- Add a `case 'persistPanelsSetting':` handler to update the checkbox

### 2. SetupPanelProvider — `src/services/SetupPanelProvider.ts`

Add two new message cases in `_handleMessage`:

```ts
case 'getPersistPanelsSetting': {
    const config = vscode.workspace.getConfiguration('switchboard');
    const enabled = config.get<boolean>('persistPanels', false);
    this._panel?.webview.postMessage({ type: 'persistPanelsSetting', enabled });
    break;
}
case 'setPersistPanelsSetting': {
    const config = vscode.workspace.getConfiguration('switchboard');
    const enabled = message.enabled === true;
    await config.update('persistPanels', enabled, vscode.ConfigurationTarget.Global);
    this._panel?.webview.postMessage({ type: 'persistPanelsSetting', enabled });
    break;
}
```

### 3. KanbanProvider — `src/services/KanbanProvider.ts`

Add a public `deserializeWebviewPanel` method:

```ts
public async deserializeWebviewPanel(
    panel: vscode.WebviewPanel,
    state: any
): Promise<void> {
    this._panel = panel;
    this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
    this._panel.webview.html = await this._getHtml(this._panel.webview);
    this._panel.webview.onDidReceiveMessage(
        async (msg) => this._handleMessage(msg),
        undefined,
        this._disposables
    );
    this._panel.onDidDispose(() => {
        this._panel = undefined;
        this._lastColumnsSignature = null;
    }, null, this._disposables);

    const workspaceRoot = this._resolveWorkspaceRoot();
    if (workspaceRoot) {
        void this._getKanbanDb(workspaceRoot).ensureReady();
        await this.applyLiveSyncConfig(workspaceRoot);
    }
    this._setupSessionWatcher();
}
```

This mirrors the post-creation logic in `open()` but skips `createWebviewPanel` since VS Code: already created the panel.

### 4. PlanningPanelProvider — `src/services/PlanningPanelProvider.ts`

Add two public methods:

```ts
public async deserializeWebviewPanel(
    panel: vscode.WebviewPanel,
    state: any
): Promise<void> {
    this._panel = panel;
    await this._hydratePanel(this._panel, false);
}

public async deserializeProjectPanel(
    panel: vscode.WebviewPanel,
    state: any
): Promise<void> {
    this._projectPanel = panel;
    await this._hydratePanel(this._projectPanel, true);
}

private async _hydratePanel(
    panel: vscode.WebviewPanel,
    isProject: boolean
): Promise<void> {
    // Critical: set localResourceRoots so the webview can load scripts
    this._updateWebviewRoots();

    panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
    panel.webview.html = isProject
        ? this._getProjectHtml(panel.webview)
        : this._getHtml(panel.webview);

    panel.webview.onDidReceiveMessage(
        async (msg) => {
            try {
                await this._handleMessage(msg, isProject);
            } catch (err) {
                console.error(`[${isProject ? 'ProjectPanel' : 'PlanningPanel'}] Message handler error:`, err);
                panel.webview.postMessage({ type: 'error', message: String(err) });
            }
        },
        null,
        this._disposables
    );

    // Use the same dispose semantics as open(): for the planning panel,
    // dispose all shared resources; for project panel, just null the ref.
    if (isProject) {
        panel.onDidDispose(() => {
            this._projectPanel = undefined;
        }, null, this._disposables);
    } else {
        panel.onDidDispose(() => {
            this.dispose();
        }, null, this._disposables);
    }

    const theme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
    panel.webview.postMessage({ type: 'switchboardThemeChanged', theme });
    const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
    panel.webview.postMessage({ type: 'cyberAnimationSetting', disabled });

    if (isProject) {
        await this._sendActiveDesignDocState();
    }
}
```

### 5. DesignPanelProvider — `src/services/DesignPanelProvider.ts`

Add a public `deserializeWebviewPanel` method:

```ts
public async deserializeWebviewPanel(
    panel: vscode.WebviewPanel,
    state: any
): Promise<void> {
    this._panel = panel;
    this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
    this._panel.webview.html = this._getHtml(this._panel.webview);

    this._panel.webview.onDidReceiveMessage(
        async (message) => this._handleMessage(message),
        undefined,
        this._disposables
    );

    this._panel.onDidDispose(() => {
        this._panel = undefined;
        this.disposeWatchers();
    }, null, this._disposables);

    this._setupHtmlFolderWatchers();
    this._setupDesignFolderWatchers();
    this._setupImagesFolderWatchers();
    this._setupBriefsFolderWatchers();

    // Replicate the workspace-folder-change listener from open() so restored
    // panels react to workspace changes (refreshes content and re-wires watchers).
    this._disposables.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            this.postMessage({
                type: 'workspaceItemsUpdated',
                items: buildWorkspaceItems(this._getWorkspaceRoots())
            });
            this.disposeWatchers();
            this._setupHtmlFolderWatchers();
            this._setupDesignFolderWatchers();
            this._setupImagesFolderWatchers();
            this._setupBriefsFolderWatchers();
            await this._sendHtmlDocsReady();
            await this._sendDesignDocsReady();
            await this._sendImagesDocsReady();
            await this._sendBriefsDocsReady();
        })
    );

    if (!this._themeListenersRegistered) {
        this._themeListenersRegistered = true;
        this._disposables.push(
            vscode.window.onDidChangeActiveColorTheme(() => {
                this._panel?.webview.postMessage({ type: 'themeChanged' });
            })
        );
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
                    const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
                    this._panel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled });
                }
                if (e.affectsConfiguration('switchboard.theme.name')) {
                    const theme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
                    this._panel?.webview.postMessage({ type: 'switchboardThemeChanged', theme });
                }
            })
        );
    }
}
```

### 6. Extension Activation — `src/extension.ts`

After all providers are instantiated and commands are registered (around the end of `activate()`), add:

```ts
const persistPanels = vscode.workspace.getConfiguration('switchboard').get<boolean>('persistPanels', false);

if (persistPanels) {
    vscode.window.registerWebviewPanelSerializer('switchboard-kanban', {
        deserializeWebviewPanel: async (panel, state) => {
            await kanbanProvider!.deserializeWebviewPanel(panel, state);
        }
    });
    vscode.window.registerWebviewPanelSerializer('switchboard-planning', {
        deserializeWebviewPanel: async (panel, state) => {
            await planningPanelProvider.deserializeWebviewPanel(panel, state);
        }
    });
    vscode.window.registerWebviewPanelSerializer('switchboard-project', {
        deserializeWebviewPanel: async (panel, state) => {
            await planningPanelProvider.deserializeProjectPanel(panel, state);
        }
    });
    vscode.window.registerWebviewPanelSerializer('switchboard-design', {
        deserializeWebviewPanel: async (panel, state) => {
            await designPanelProvider.deserializeWebviewPanel(panel, state);
        }
    });
}
```

**Note:** `registerWebviewPanelSerializer` returns a `Disposable`, but VS Code: documentation states that it is auto-managed and does not need to be pushed to `context.subscriptions`.

### 7. package.json — Configuration Schema

Add under `contributes.configuration.properties`:

```json
"switchboard.persistPanels": {
    "type": "boolean",
    "default": false,
    "description": "Automatically reopen Kanban, Project, Planning, and Design panels when VS Code: restarts."
}
```

## Testing Strategy

1. **Manual test — toggle ON:**
   - Open Setup → check "Persist Switchboard Panels Across IDE Restarts"
   - Open Kanban, Project, Planning, and Design panels
   - Close VS Code: entirely
   - Reopen VS Code: — all 4 panels should restore automatically

2. **Manual test — toggle OFF:**
   - Ensure toggle is unchecked
   - Open Kanban and Project panels
   - Close VS Code:
   - Reopen VS Code: — no panels should restore

3. **Manual test — partial restore:**
   - Toggle ON
   - Open only Kanban and Design (leave Project/Planning closed)
   - Restart VS Code: — only Kanban and Design restore

4. **Manual test — toggle change at runtime:**
   - Toggle ON, open panels, restart → panels restore
   - Toggle OFF, restart → panels do NOT restore (even though they were open at shutdown)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Serializers called before providers fully initialized | Register serializers at the very end of `activate()`, after all provider constructors and command registrations |
| `deserializeWebviewPanel` duplicates setup logic from `open()` | Extract common hydration logic into a private helper (e.g., `_hydratePanel`) to keep `open()` and `deserialize*()` DRY |
| Restored panels may lack workspace context if opened before workspace is ready | Panels already handle "no workspace open" gracefully; no change needed |
| `registerWebviewPanelSerializer` conflicts with future VS Code: API changes | Uses stable VS Code: API; serializers have been supported since VS Code: 1.23 |
| User has an older extension version with panels open, then updates to this version | VS Code: will attempt to call serializers for panels that were open. Our serializers are registered, so it will work. If the user had panels open on an old version and the new version doesn't register serializers (toggle off), VS Code: silently discards the restore state |

## Proposed Changes

### `src/webview/setup.html`
- **Context:** The "Setup" tab (`data-tab-content="setup"`) has a "WORKFLOW SETTINGS" section (line ~517) containing existing toggles like `exclude-reviewed-backlog-toggle`.
- **Logic:** Add a new checkbox immediately after `exclude-reviewed-backlog-toggle` with id `persist-panels-toggle`. In the inline `<script>`, on `ready` send `getPersistPanelsSetting` and set checkbox state; on change send `setPersistPanelsSetting`; add `case 'persistPanelsSetting':` to update checkbox.
- **Implementation:** See HTML snippet in Implementation Details §1.
- **Edge Cases:** If the webview reloads while the user has the checkbox checked, the `ready` handler re-fetches the setting and restores correct state.

### `src/services/SetupPanelProvider.ts`
- **Context:** `_handleMessage` (line ~111) switches on `message?.type` and handles settings read/write.
- **Logic:** Add `getPersistPanelsSetting` and `setPersistPanelsSetting` cases. Both use `vscode.workspace.getConfiguration('switchboard')` with `ConfigurationTarget.Global`.
- **Implementation:** See TypeScript snippet in Implementation Details §2.
- **Edge Cases:** `message.enabled` may be undefined if the webview sends a malformed message; coerce with `=== true`.

### `src/services/KanbanProvider.ts`
- **Context:** `open()` (line ~806) creates the panel, sets iconPath, assigns HTML, wires message/dispose handlers, ensures DB ready, applies live sync config, and sets up session watcher.
- **Logic:** `deserializeWebviewPanel` skips `createWebviewPanel` and replicates the post-creation wiring. `_getHtml` is async, so use `await`.
- **Implementation:** See TypeScript snippet in Implementation Details §3.
- **Edge Cases:** If no workspace is open at deserialize time, `_resolveWorkspaceRoot()` returns null and DB/live-sync setup is skipped; the webview will self-populate on `ready`.

### `src/services/PlanningPanelProvider.ts`
- **Context:** `open()` (line ~388) and `openProject()` (line ~271) each create a panel, call `_updateWebviewRoots()`, set HTML, wire handlers, and set up theme/adapters/watchers. The dispose handler for `open()` calls `this.dispose()`; for `openProject()` it only nulls the ref.
- **Logic:** `_hydratePanel` must call `_updateWebviewRoots()` (critical for `localResourceRoots`), mirror the correct dispose semantics per panel type, and send theme messages. It intentionally does NOT re-register adapters or start periodic sync on deserialize; those are deferred to first `open()` call to avoid duplicate sync jobs.
- **Implementation:** See TypeScript snippet in Implementation Details §4.
- **Edge Cases:** If `_hydratePanel` is called for both Planning and Project in the same session, `_updateWebviewRoots()` is idempotent (roots-key guard), so calling it twice is safe.

### `src/services/DesignPanelProvider.ts`
- **Context:** `open()` (line ~93) creates the panel, sets iconPath/HTML, wires handlers, sets up folder watchers, registers a workspace-folder-change listener, and registers theme listeners (guarded by `_themeListenersRegistered`).
- **Logic:** `deserializeWebviewPanel` must include the workspace-folder-change listener and the full theme listeners (not just the guard block). Folder watcher setup is already present.
- **Implementation:** See TypeScript snippet in Implementation Details §5.
- **Edge Cases:** `_themeListenersRegistered` prevents duplicate theme listeners if both `open()` and `deserializeWebviewPanel()` run in the same session (e.g., user closes then reopens the panel).

### `src/extension.ts`
- **Context:** `activate()` ends around line 2580 after all provider instantiation, command registration, status bar setup, and terminal sync.
- **Logic:** After all provider references are assigned and pushed to `context.subscriptions`, read `switchboard.persistPanels` and conditionally register four serializers.
- **Implementation:** See TypeScript snippet in Implementation Details §6.
- **Edge Cases:** If `persistPanels` is toggled ON mid-session, already-open panels are tracked by VS Code: and will restore on next restart. If toggled OFF, VS Code: silently discards restore state on next activation.

### `package.json`
- **Context:** `contributes.configuration.properties` already defines many `switchboard.*` settings.
- **Logic:** Add `switchboard.persistPanels` boolean with default `false` and a user-facing description.
- **Implementation:** See JSON snippet in Implementation Details §7.
- **Edge Cases:** No runtime behavior change; purely improves DX in `settings.json`.

## Verification Plan

### Automated Tests
- None required. This feature depends on VS Code:'s extension host lifecycle and `WebviewPanelSerializer` behavior, which cannot be exercised in the existing unit-test environment (no VS Code: API shim for serializer callbacks). Manual testing per the Testing Strategy section is the appropriate verification approach.

## Recommendation

**Send to Coder**

---

## Code Review — Reviewer-Executor Pass (2026-06-19)

Implementation was found present and faithful to the plan in all eight files
(`setup.html`, `SetupPanelProvider.ts`, `KanbanProvider.ts`, `PlanningPanelProvider.ts`,
`DesignPanelProvider.ts`, `extension.ts`, `package.json`). Serializers register at the
very end of `activate()` (extension.ts:2746–2769), gated on `switchboard.persistPanels`;
`activationEvents` is `onStartupFinished`, so the extension is active when VS Code restores
panels — no `onWebviewPanel:*` activation events needed. The Setup toggle wiring (ready →
`getPersistPanelsSetting`, change → `setPersistPanelsSetting`, `persistPanelsSetting` handler)
is complete and matches sibling toggles.

### Stage 1 — Grumpy Principal Engineer

> **CRITICAL — The dedup guard quietly guillotines the second restored panel.**
> `_hydratePanel` (PlanningPanelProvider.ts:518) reverently calls `_updateWebviewRoots()` and
> labels it "Critical: set localResourceRoots so the webview can load scripts." Adorable. But
> `_updateWebviewRoots()` short-circuits the instant the roots signature matches its cache
> (line 5127). `open()` and `openProject()` BOTH reset `_lastWebviewRootsSignature = ''` first —
> there's a screaming all-caps comment at line 396 explaining that skipping this leaves a panel
> "with scripts disabled… stuck on an infinite Loading…". `_hydratePanel` did NOT reset it. So when
> a user restores BOTH the Planning and Project panels (the headline test case — "open all 4
> panels, restart"), the first hydrate caches the signature and the second hydrate's
> `_updateWebviewRoots()` returns early, never assigning `enableScripts`/`localResourceRoots` to
> the second panel. You shipped the exact failure mode your own comment warns about, in the same file.
>
> **MAJOR — "It'll work after an update," says the risk table. Does it?**
> The Risks table (this plan, the "older extension version… then updates" row) flatly asserts restore
> "will work." Meanwhile `KanbanProvider.deserializeWebviewPanel` and
> `DesignPanelProvider.deserializeWebviewPanel` never re-apply `webview.options`. VS Code persists the
> panel's `localResourceRoots` from creation time — URIs baked with the OLD version's install path. Update
> the extension (≈4,000 installs love doing this), restore a panel, and those roots 404 → scripts blocked →
> a beautiful blank panel. The canonical VS Code serializer sample resets options "so we use latest uri for
> localResourceRoots" for precisely this reason. Planning launders this through `_updateWebviewRoots()`
> (current `extensionUri`); Kanban and Design simply pray.
>
> **NIT — "VS Code:" — since when does the IDE have a colon in its name?**
> setup.html:541 ships user-facing copy "when VS Code: restarts." to ~4,000 humans. The colon is a
> copy-paste scar from the plan text.
>
> **NIT — `this._panel.webview` sans optional-chaining** (SetupPanelProvider.ts:556,571). The plan snippet
> used `this._panel?.`. The handler only runs on a live panel and every sibling case does the same, so this
> is consistent-by-convention, not a real defect. Left as-is.
>
> **OBSERVATION (not a bug) — restored Planning panels are statically lit.** `_hydratePanel` omits the
> theme listeners, docs/local/antigravity/kanban-plans/constitution watchers, and the
> `onDidChangeWorkspaceFolders` listener that `open()` registers — and `open()` early-returns when
> `this._panel` exists, so they never get registered later either. The plan, however, *explicitly* scoped
> adapters/sync as deferred, and `_handleMessage` calls `_ensureAdaptersRegistered()` on every message
> (line 1303), so a restored panel self-heals adapters on its first `ready`/`fetchRoots`. Net effect: the
> panel is fully *functional*; it just won't auto-refresh on external file/theme/workspace changes until
> reopened. Degraded reactivity, not breakage — and within the plan's stated scope.

### Stage 2 — Balanced synthesis

- **Fix now (CRITICAL):** Reset `_lastWebviewRootsSignature` in `_hydratePanel` so both restored
  Planning/Project panels actually receive their webview options. This is a direct violation of the plan's
  own "Critical: set localResourceRoots" requirement.
- **Fix now (MAJOR):** Re-apply `webview.options` with the current `extensionUri` in Kanban and Design
  `deserializeWebviewPanel`, before assigning `html`. Required to honor the plan's update-safety claim and
  CLAUDE.md's "~4,000 installs on old versions" mandate.
- **Fix now (NIT, user-visible):** Correct the "VS Code:" copy in setup.html.
- **Keep:** serializer registration placement/gating, dispose semantics (Planning `this.dispose()` vs
  Project null-ref, matching `open()`/`openProject()`), Design's replicated workspace + theme listeners,
  package.json config entry, SetupPanelProvider handlers.
- **Defer (documented):** Planning restored-panel live reactivity (watchers/theme listeners). Consciously
  out of plan scope; adapters self-heal; panel remains functional. Acceptable as-is.

### Fixes applied

| Severity | File:line | Fix |
|----------|-----------|-----|
| CRITICAL | `src/services/PlanningPanelProvider.ts:518` (`_hydratePanel`) | Reset `this._lastWebviewRootsSignature = ''` before `_updateWebviewRoots()`, mirroring `open()`/`openProject()`, so the second-restored panel's `webview.options` are assigned. |
| MAJOR | `src/services/KanbanProvider.ts:912` (`deserializeWebviewPanel`) | Set `this._panel.webview.options` (`enableScripts` + `localResourceRoots: [this._extensionUri]`) before assigning html — survives extension updates. |
| MAJOR | `src/services/DesignPanelProvider.ts:174` (`deserializeWebviewPanel`) | Set `this._panel.webview.options` with current-`extensionUri` roots (dist/webview/designs/node_modules + workspace folders), mirroring `open()`, before assigning html. |
| NIT | `src/webview/setup.html:541` | "when VS Code: restarts." → "when VS Code restarts." |

### Validation results

- **Compilation:** Skipped per session directive (SKIP COMPILATION). Edits use only pre-existing fields
  (`this._extensionUri`, `this._panel`, `this._lastWebviewRootsSignature`) and the `vscode` import already
  present in each file; no new imports or symbols introduced.
- **Tests:** Skipped per session directive (SKIP TESTS). Plan's Verification Plan notes no automated tests
  are applicable (serializer callbacks have no unit-test shim); manual testing per the Testing Strategy
  section remains the verification path.

### Remaining risks

1. **`dist/` rebuild required.** Per CLAUDE.md, the extension serves webviews from `dist/webview/`; the
   `setup.html` copy fix only takes effect after `npm run compile`. Compilation was skipped this session —
   run it before packaging/release.
2. **Toggle requires a restart to take effect.** Serializers are registered only at `activate()` based on
   the setting's value; toggling ON/OFF mid-session applies on the next window restart. Expected VS Code
   behavior; worth a one-line support note.
3. **Restored Planning panel reactivity** (file/theme/workspace watchers) is deferred — see Stage 1
   OBSERVATION. Functional but not live-reactive until reopened. In-scope per plan.
