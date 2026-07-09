# Comms Monitor: Testing Bugfixes and UX Improvements

**Complexity:** 7

## Goal

Fixes 6 bugs and UX issues found during testing of the Comms Monitor feature: start polling delay, Slack prompt error, stuck stop button, stop-polling-kills-terminal confusion, missing output capture, and excessive paste-to-enter delay. These plans are grouped because they were all surfaced during a single testing pass of the Comms Monitor and share the same files (`src/services/TaskViewerProvider.ts`, `src/webview/kanban.html`, `src/services/terminalUtils.ts`); shipping them together brings the monitor from "launched but rough" to a coherent, reliably-operable state.

## How the Subtasks Achieve This

- **Start Polling Immediate First Tick**: cuts the 30s first-prompt `setTimeout` in `startMcpMonitorPolling()` to ~2s so the user sees the first channel check within seconds of clicking Start Polling — eliminates the perceived "nothing happened" gap.
- **Slack Prompt Claude Error**: rewrites `_buildSlackPromptLine()` to explicitly invoke Slack MCP tools, prefix channel names with `#`, and guard the both-filters-checked edge case, so Claude queries Slack instead of erroring on ambiguous/bare channel references.
- **Stop Polling Button Stuck**: adds a deferred re-render flag (`commsPanelRenderPending`) plus immediate button feedback so the COMMS panel DOM reflects the stopped-polling state instead of staying stale behind the 500ms interaction guard.
- **Capture Output to UI**: adds file-based output capture — the prompt instructs Claude to write findings to `.switchboard/comms-monitor-latest.md`, and a "Latest Results" section in the COMMS tab displays them — so users see monitor findings without switching to the terminal.
- **Stop Polling Kills Terminal**: separates "Stop Polling" from "Kill Terminal" into different rows, relabels the destructive button, and adds tooltips so users stop accidentally killing the terminal when they only meant to pause polling.
- **Reduce Paste-to-Enter Delay**: cuts `POST_PASTE_SETTLE_MS` / `NEWLINE_DELAY` / `CLI_CONFIRM_ENTER_DELAY` so the paste→Enter window shrinks from ~1800ms to ~400ms, reducing user-typing interference with pasted prompts.

## Dependencies & sequencing

- **Cross-feature dependencies:** None external — all six are internal to the Comms Monitor feature and require no work from other features to land.
- **Shipping order within this feature:**
  - **Plan 6 (reduce delays) → first.** Independent (lives in `terminalUtils.ts`); landing it early makes every other plan's manual verification faster and more reliable.
  - **Plan 3 (stuck button) before Plan 5 (kill-terminal confusion).** Plan 5 explicitly states the stuck-button fix is a prerequisite — until users can see that "Stop Polling" worked, they fall back to the prominent red "Stop Monitor" button and kill the terminal anyway.
  - **Plan 1 (immediate first tick) before Plan 4 (capture output).** Plan 4's verification waits for "the first tick" and references the 2s delay; settle the first-tick timing before adding output capture on top.
  - **Plan 2 (slack prompt) before Plan 4 (capture output).** Both edit `_buildMcpMonitorPrompt` / the preamble — ship the smaller prompt-clarity fix first, then Plan 4 appends the file-write postscript, avoiding a preamble merge conflict.
  - **Plan 5** can land any time after Plan 3 (pure `kanban.html` UI, no backend coupling).
  - **Suggested merge order: 6 → 3 → 5 → 1 → 2 → 4.**
- **Prerequisites / guards:** the three-step launch flow (Start Terminal → Check Auth → Start Polling) is already implemented and separates auth from polling. For Plan 2 to have any effect, the Slack MCP server must be configured and authenticated in the user's Claude environment — this is environmental, not a code dependency. For Plan 4, the `.switchboard/` directory must exist (it does in any Switchboard-managed workspace).

## Uncertain Assumptions

Web research was run and findings integrated into the plans. Of the 4 original uncertainties, 2 are now resolved by research and 2 remain:

**Resolved by research:**
- ~~**Plan 4 — VS Code terminal output-capture API status.**~~ **RESOLVED:** `vscode.window.onDidWriteTerminalData` remains proposed-only (VS Code team confirmed no plans to stabilize — cross-process performance barrier). Shell Integration API (`TerminalShellExecution.read()`) is stable (v1.93+) but blind to REPL sub-turns — it treats the entire Claude CLI session as one undemarcated stream. File-based capture is confirmed as the only viable path for a published extension. Plan 4 upgraded: 60s polling timer replaced with `vscode.workspace.createFileSystemWatcher` (fires the moment Claude writes) + 90s fallback timeout.
- ~~**Plan 6 — xterm.js paste latency on all terminals.**~~ **RESOLVED:** Research confirmed 100ms `POST_PASTE_SETTLE_MS` is safe for local terminals but **unsafe for Remote-SSH** (50-200ms RTT) — Enter can arrive before the clipboard buffer transfers, corrupting bracketed paste. Plan 6 upgraded: connection-aware delays via `vscode.env.remoteName` (local: 100/300ms, remote: 300/600ms). The `fast` option is now secondary.

**Still uncertain (implementation-time verification):**
- **Plan 2 — root cause is speculative.** The actual Claude error response was never captured (user report truncated). The prompt rewrite (explicit MCP-tool invocation, `#` prefixes, both-filters guard) is a best-effort fix; the real cause could instead be a custom startup command overriding the `mcp__*` fallback, or a missing/unauthenticated Slack MCP server. Research confirmed `mcp__slack__*` is the canonical tool pattern and the `mcp__*` fallback covers Slack, but this doesn't tell us what the actual error IS. The plan's diagnostic step (capture the full error first) remains essential and non-negotiable.
- **Plan 4 — Claude file-write reliability.** Research found typical multi-source MCP response latency is 15-45s (within the 90s fallback) and identified known failure modes: Claude may output "All clear" inline without calling its file-write tool, or halt on permission prompts if not spawned with `--dangerously-skip-permissions`. Plan 4 now uses stricter prompt wording ("you MUST call your filesystem write tool... Do not output your final analysis solely in natural language") and flags the skip-permissions requirement. Reliability should be verified during manual testing — if Claude frequently doesn't write the file, the "No output captured" fallback will show frequently and the UX will need iteration.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Comms Monitor: Start Polling Button Should Immediately Poll, Not Wait 30s](../plans/feature_plan_20260706092056_comms-monitor-start-polling-immediate-first-tick.md) — **LEAD CODED**
- [ ] [Comms Monitor: Stop Polling Button Stuck — UI Never Updates After Stop](../plans/feature_plan_20260706092058_comms-monitor-stop-polling-button-stuck.md) — **LEAD CODED**
- [ ] [Comms Monitor: Capture Agent Output and Display in COMMS Tab UI](../plans/feature_plan_20260706092100_comms-monitor-capture-output-to-ui.md) — **LEAD CODED**
- [ ] [Comms Monitor: Stop Polling Kills the Terminal Instead of Just Stopping Polling](../plans/feature_plan_20260706092059_comms-monitor-stop-polling-sends-clear.md) — **LEAD CODED**
- [ ] [Comms Monitor: Reduce Delay Between Prompt Paste and Enter Submission](../plans/feature_plan_20260706092101_comms-monitor-reduce-paste-to-enter-delay.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Completion Report

Implemented all 5 subtasks of the Comms Monitor testing-bugfixes/UX feature. Files changed: `src/services/terminalUtils.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/kanban.html`. (1) Start-polling first-tick delay cut 30s→2s in `startMcpMonitorPolling()`. (2) Stop-polling stuck button fixed via a `commsPanelRenderPending` deferred-render flag wired into the interaction-guard timer callback, plus immediate "Stopping…" visual feedback on the Stop Polling button. (3) Stop-polling-kills-terminal confusion fixed by relabeling "Stop Monitor"→"Kill Terminal", restyling to a red outline on gray, moving it to a separate row with a dashed divider, and adding tooltips to both stop buttons. (4) Paste-to-Enter delay reduced from ~1800ms to ~400ms (local) / ~900ms (remote) via connection-aware `POST_PASTE_SETTLE_MS`/`NEWLINE_DELAY`/`CLI_CONFIRM_ENTER_DELAY` using `vscode.env.remoteName`. (5) Output capture added: every monitor prompt now appends a mandatory file-write postscript targeting `.switchboard/comms-monitor-latest.md`; a `vscode.workspace.createFileSystemWatcher` (plus 90s fallback timer) reads the file and pushes a `commsMonitorOutput` message to the webview, which renders it in a new "Latest Results" section using `textContent` (XSS-safe). No issues encountered; the Slack-prompt-clarity subtask referenced in the feature description was not in the dispatched subtask set and was not implemented.


