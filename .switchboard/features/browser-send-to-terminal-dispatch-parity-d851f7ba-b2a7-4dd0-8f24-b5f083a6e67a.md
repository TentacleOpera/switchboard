# Browser Send-to-Terminal Dispatch Parity

**Complexity:** 7

## Goal

Every browser-originated prompt dispatch reaches the terminal the calling surface can display, and reports honestly when it cannot. The browser rail already stamps apiOriginated on every request (LocalApiServer._stampHttpSurface), but only 2 of 8 _dispatchExecuteMessage call sites pass the resulting allowPtyFleet flag, four helpers bypass the dispatcher entirely and drive vscode.Terminal directly (two of them creating an invisible terminal on miss), several report success on a failed delivery, and the clipboard fallbacks write the extension host's clipboard rather than the browser's. Subtasks: (1) dispatchCustomPromptToRole + its 8 call sites; (2) the four stray _dispatchExecuteMessage sites — orchestrator kickoff/wake, pair-programming coder, Airlock send-to-coder; (3) the four direct-to-vscode.Terminal helpers and the arms that hardcode success; (4) project-panel verbs rejected by the Planning allowlist (improvePlan, webviewReady).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Browser "Send to Planner" Fails Because the Dispatch Path Drops the Surface Flag](../plans/feature_plan_20260805210001_browser-send-to-planner-drops-surface-flag.md) — **PLAN REVIEWED**
- [ ] [Four Dispatch Sites Hardcode the VS Code Fleet, So Orchestrator / Pair-Program / Airlock Sends Die in the Browser](../plans/feature_plan_20260806090000_browser-stray-dispatch-sites-hardcode-vscode-fleet.md) — **PLAN REVIEWED**
- [ ] [Four Direct-to-`vscode.Terminal` Helpers Bypass the Dispatcher, So Browser Sends Land in Invisible Terminals and Still Report Success](../plans/feature_plan_20260806090001_browser-direct-terminal-helpers-not-fleet-aware.md) — **PLAN REVIEWED**
- [ ] [Project Panel Posts Two Verbs the Planning Allowlist Rejects, So the Browser Shows an Error Banner on Every Open](../plans/feature_plan_20260806090002_browser-project-panel-verbs-rejected-by-planning-allowlist.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

