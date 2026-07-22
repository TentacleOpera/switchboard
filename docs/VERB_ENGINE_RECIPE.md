# Verb Engine — Arm Migration Recipe (A2b, subtasks 2–6)

Foundations shipped by **Verb Engine · 1** (`a2b-verb-engine-01-foundations.md`).
This is the mechanical checklist for the per-provider burndowns:
Design (remaining) → Setup (117) → Kanban (144) → TaskViewer (110) → Planning (172).

## The contract (decided at kickoff, 2026-07-16)

**Return-in-body is the contract; the webview push is additive.** Every migrated
arm `return`s its result object from `_handleMessage`. The HTTP rail
(`POST /<panel>/verb/<name>`) sends that object as the response body
(`success:false` ⇒ HTTP 502). Existing webview pushes stay, unchanged and in the
same order — the webview listener ignores the return value, so returning is
byte-compatible for panel callers. Un-migrated arms keep `break` (resolve
`undefined`; the rail acks `{success:true}`).

## Foundations you build on (already in place)

| Piece | Where | Notes |
| :--- | :--- | :--- |
| Seam bundle | `src/services/hostSeams.ts` | `pathConfig, terminal, commands, ui, editor, secrets, clipboard, workspace, watcher` |
| Command registry | `src/services/commandRegistry.ts` | `switchboardCommandRegistry`; extension.ts registers all 45 arm-invoked `switchboard.*` commands via `registerSwitchboardCommand` |
| Registry-first dispatch | `VscodeHostCommands` | `seams.commands.executeCommand('switchboard.X')` runs the registered handler in-process; non-registry commands fall through to vscode |
| Verb schemas | `src/services/verbSchemas.ts` | data-driven; validated in every `handleServiceVerb` after the allowlist check; schemaless verbs pass through |
| Test harness | `src/test/helpers/verbEngineTestSeams.js` | vscode trap + in-memory seams + recorders; see `src/test/verb-engine-headless-seams.test.js` |

## Per-arm checklist

1. **Swap host couplings inside the arm (in place — no twin methods):**
   - `vscode.env.clipboard.*` → `this._seams().clipboard.*`
   - `vscode.window.show{Warning,Information,Error}Message` → `this._seams().ui.show*` (keep fire-and-forget sites fire-and-forget: `void this._seams().ui.showErrorMessage(...)`)
   - `showTemporaryNotification(...)` → `this._seams().ui.showTemporaryNotification(...)`
   - `vscode.window.showOpenDialog` (folders) → `this._seams().ui.pickFolder(label)`; (files) → `this._seams().ui.pickFiles({...})`. For dialog-driven write verbs, also accept a direct payload field (e.g. `folderPath`) so HTTP callers can skip the dialog — additive, webview flow unchanged.
   - `this._context.secrets.*` → `this._seams().secrets.*`
   - `vscode.commands.executeCommand('switchboard.X', ...)` → `this._seams().commands.executeCommand('switchboard.X', ...)` (registry-routed). If the command is not yet in the registry, convert its registration in extension.ts to `registerSwitchboardCommand` first.
   - `vscode.workspace.workspaceFolders` → `this._seams().workspace.getWorkspaceRoots()` (or the provider's `_getWorkspaceRoots()` once that helper is seam-routed — done for Design).
   - `vscode.workspace.createFileSystemWatcher` → `this._seams().watcher.watchFolder(folder, (event, filePath) => ...)`; watcher array fields become `HostWatchHandle[]`.
   - Raw `panel.webview.postMessage` → the provider's `postMessage`/broadcaster helper (push-routing ratchet enforces this).
   - **Seam-growth protocol:** an arm hits an uncovered host surface → STOP, add the seam to `hostSeams.ts` (interface + vscode impl + bundle + `createVscodeHostSeams`), extend the test-seam helper, wire, resume.
2. **`break` → `return`:** return `{ success: true, ...data }` (reads return their data; keep field names matching what the arm pushes). Failure paths return `{ success: false, error }`. **Do not reorder side effects** — pushes happen exactly where they did; the `return` replaces the `break` at the end of each path.
3. **Add the verb's input schema** to `verbSchemas.ts` (the fields the arm actually reads; `required` only for fields whose absence the arm treats as an error).
4. **Headless test:** extend the provider's headless test (pattern: `verb-engine-headless-seams.test.js`) — drive the verb through `handleServiceVerb` under `installVscodeTrap()`; assert the returned body, the recorded seam effects, and the additive push. **This, not "compiles", is the acceptance signal.**

## Provider wiring notes

- `_handleMessage` signature: `Promise<void>` → `Promise<any>` (done for Design; do per provider on first migrated arm).
- `createVscodeHostSeams(root, secrets)` — pass `this._context.secrets`. `SetupPanelProvider` has **no ExtensionContext**; it gets `UnavailableHostSecrets` (reads → undefined, writes → throw). Thread a SecretStorage through its constructor before migrating any Setup arm that touches secrets.
- Test harness injects seams by assigning `provider._hostSeams` / `provider._broadcaster` directly — pre-empting `_initXService`. A test workspace needs `KanbanDatabase.forWorkspace(root).createIfMissing()` (the DB never auto-creates — scaffold-litter protection).

## Batch protocol & ratchets

- One agent stream per provider file (no cross-file collisions); batches of ~20–30 arms.
- Gates between batches — all must be green:
  - `npm run compile-tests`
  - `npm run catalog:check` (regen with `npm run catalog:generate` if arms/pushes moved — verb surface itself must not change)
  - `npm run parity:check`
  - `npm run push-routing:check` (baselines only ever go DOWN)
  - `npm run verb-returns:check` (break ceilings in `scripts/verb-return-contract-baseline.json` only ever go DOWN as arms convert to `return`)
    - A ceiling is a provider's **true residual `break` count**, NOT necessarily 0. `break` inside a nested switch or loop within an arm is legitimate control flow — it MUST stay, and converting it to `return` is a bug — so a provider that has such breaks floors above 0 (e.g. Design = 14, TaskViewer = 1; Kanban/Setup happen to reach 0). When you finish converting a provider, **do NOT hand-edit the ceiling (and never force 0)** — run `npm run verb-returns:baseline`, which rewrites the baseline from the true counts. It only ever LOWERS a ceiling and refuses to raise one (so it can't launder a regression); review the diff and commit it. A genuinely new nested/loop break is the one case you hand-edit, with justification in the commit.
  - `npm run test:contract:verb-engine` + the provider's headless test
- Ratchet metric: migrated-arm count per provider (arms that `return` + pass under the trap). Design after subtask 1: **25 / 68** (18 folder CRUD, createBrief, deleteBrief, persistTabState, activeTabChanged, copyStitchTweakPrompt, copyHtmlTweakPrompt, stitchSaveApiKey). Kanban after subtask 4: **144 / 144, 0 shims** (zero `vscode.` refs and zero `break;` in the `_handleMessage` switch; headless test `test:contract:verb-engine-kanban`).
- Byte-compat is the hard constraint (~4,000 installs): same pushes, same order, same webview behavior. New behavior is allowed only where it was impossible before (HTTP callers reading results, payload-supplied dialog answers).
