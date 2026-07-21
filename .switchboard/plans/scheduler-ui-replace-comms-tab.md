# Scheduler UI in the Automation Tab; Retire the Standalone Comms Tab

## Goal

Surface the generic scheduler as a **Scheduler** section inside the Automation tab, with a source dropdown that puts board-automation first and **demotes comms to a single option** — and **remove the standalone COMMS tab** that currently clutters the board for the many users who never use it.

**Problem & background.** The kanban webview has a dedicated `COMMS` tab ([kanban.html:2652](src/webview/kanban.html#L2652) button, [:2742-2744](src/webview/kanban.html#L2742) content) whose entire content is the comms-specific `createCommsPanel()` ([:9798](src/webview/kanban.html#L9798)) with its own interaction guard and render path ([:9774](src/webview/kanban.html#L9774), `renderCommsPanel`). Comms — watching Slack/Gmail/GCal — is off-mission for a plan-orchestration board, and giving it a top-level tab overstates its importance. Meanwhile the Automation tab ([:2648](src/webview/kanban.html#L2648)/[:2737-2739](src/webview/kanban.html#L2737)) already hosts a heterogeneous mode dropdown ([:8564-8602](src/webview/kanban.html#L8564)): `single-column`, `multi-column`, `antigravity-batch`, `orchestration`.

**Root cause / design.** Comms earned a tab only because it was the sole home of Switchboard's scheduler. Once scheduling is generic (plans 1–3), comms is just one *source* of one *job*. The right home is a **Scheduler** entry in the Automation mode dropdown, where the sub-hourly local-terminal niche (the one thing that justifies comms staying at all — cloud can't poll faster than hourly) is available without a dedicated tab.

Depends on plans 1–3 (data model, local engine, presets/targets).

## Implementation Steps

1. **Add a `scheduler` automation mode** to the dropdown ([kanban.html:8564-8602](src/webview/kanban.html#L8564)) and the `automationMode` union ([autobanState.ts:107](src/services/autobanState.ts#L107), [:307](src/services/autobanState.ts#L307)), with a description explaining scheduled prompts + targets. Render its panel in the Automation tab body ([:2737-2739](src/webview/kanban.html#L2737)).
2. **Build the Scheduler panel.** A job list (add / edit / enable / delete) over `SchedulerConfig`. Per job: a **source dropdown** ordered `Board batch → Reconcile cloud work → Custom prompt → Comms (Slack/Gmail/Calendar)` (comms last, unremarkable); a **target dropdown** (`Local terminal` / `Antigravity` / `Cloud`) that shows the target's prerequisites block and interval floor from plan 3; an interval control respecting the floor; and a "Copy prompt" button for external targets / start-stop for local.
3. **Reuse the comms sub-form.** When `source = comms`, render the existing comms controls (sources checklist, per-source intervals, Slack channel/DM scoping, Gmail label, editable prompt preview) from `createCommsPanel()` ([:9798-10050](src/webview/kanban.html#L9798)) as a nested section — lifted, not rewritten — so no comms capability is lost.
4. **Fold in antigravity-batch.** Present the current `antigravity-batch` behavior as `source = board-batch` + `target = antigravity`, so the standalone `antigravity-batch` mode can be removed (or aliased) and its confusing "run manually" copy retired (plan 3, step 4). Keep `orchestration`, `single-column`, `multi-column` untouched.
5. **Remove the COMMS tab.** Delete the `COMMS` tab button ([:2652](src/webview/kanban.html#L2652)) and `comms-tab-content` container ([:2742-2744](src/webview/kanban.html#L2742)); remove the standalone `renderCommsPanel` invocation and its tab-switch wiring, folding the panel into the Scheduler. Keep the message handlers (`commsMonitorOutput`, preview updates — [:7650-7668](src/webview/kanban.html#L7650)) but route them to the Scheduler panel's comms job.
6. **State migration for the webview.** Ensure `currentAutomationMode` restore ([:6923](src/webview/kanban.html#L6923), [:7528](src/webview/kanban.html#L7528)) tolerates users whose last tab was `comms` (redirect to the Scheduler section, don't error).

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, refactor, feature

## Verification Plan

### Automated Tests
- N/A for webview DOM wiring (no harness); covered by manual acceptance. If a lightweight builder test exists for the prompt preview mirror, assert the comms preview still renders identically inside the Scheduler panel.

### Manual Acceptance
- The COMMS tab is gone; the board has one fewer top-level tab.
- Automation tab → mode dropdown shows **Scheduler**; selecting it shows the job list.
- Add a comms job: the full comms sub-form (Slack/Gmail/GCal, channels, intervals, editable preview) is present and functional; it runs in the interactive "Comms Monitor" terminal and output appears.
- Add a board-batch job with Antigravity target: "Copy prompt" yields the batch prompt + the explicit Antigravity-Scheduled-Tasks instructions.
- Add a board-batch job with Cloud target: prerequisites block names board-state-export + origin; interval cannot be set below 60 min.
- Add a reconcile job (Custom/Reconcile): copy yields the git-pull + scan + `kanban_operations` forward-only prompt.
- A user previously on the COMMS tab reopens the board and lands cleanly (redirected to Scheduler, no error); their comms settings are intact (migrated in plan 1).
