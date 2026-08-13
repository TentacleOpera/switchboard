# Terminals pane usability: scrolling, identity and dispatch feedback

**Complexity:** 5

## Goal

Four defects in the browser cockpit's terminals grid, all in terminals.js/terminals.html and the standalone PTY path. Two are scroll failures: the kanban-mode pane's card list cannot scroll because .pane-content lacks min-height:0, and Claude CLI seats have no scrollbar or jump-to-latest because the CLI enters the alternate screen buffer and grabs mouse reporting at startup. Two are pane-header gaps: dispatching a prompt gives no in-progress signal for the whole multi-second delivery window, and the header is the only terminal-identifying surface with no CLI brand mark.

These four are grouped because they are the same complaint from four directions: **a terminal pane does not behave like a terminal.** It will not scroll, it will not say which agent is in it, and it gives no sign that a dispatch is under way. Each has an independent root cause and an independent fix, but shipping any one alone leaves the pane still feeling broken — the grid is only usable when all four land.

## How the Subtasks Achieve This

- **Kanban-Mode Pane In terminals.html Cannot Scroll Its Card List**: Adds `min-height: 0` to `.pane-content` and normalises `layout-1`/`layout-2h`'s bare `1fr` grid rows to `minmax(0, 1fr)`. `.pane-content` was the one link in the flex chain missing the zero minimum every sibling declares, so it grew to fit the card list instead of clipping-and-scrolling it. Restores the scroll affordance that makes drag-to-dispatch reach every card in a column, not just the ones that happen to fit.
- **Show The CLI Brand Icon In Each Terminal Pane Header**: Resolves the agent's brand mark through the same `brandIconForCliLabel`/`brandIconUri` pair the sidebar rows, shell rail and startup curtain already use, and prepends it to `.pane-title` in `updatePaneElement`'s assigned branch. Turns identifying a pane's agent from a reading task into a glancing one — the pane header was the only terminal-identifying surface in the panel without a brand mark.
- **Snappier PTY Prompt Delivery With A Dispatch Progress Chip In The Pane Header**: Retunes `ptyPromptDelivery.ts`'s settle constants for a directly-owned pty (they were inherited from VS Code's clipboard/IPC path), introduces a PTY-scoped `terminal.ptyClearBeforePromptDelay` so the fast path can be tuned without regressing the VS Code path, and adds a refcounted `dispatching…` chip driven by the `ptySendPrompt` request lifecycle. Closes the ~2.4–3 s window in which a drop produced no visible change at all — the direct cause of operators double-dropping.
- **Claude CLI Seats Have No Scrollbar And No Jump-To-Latest**: Injects `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` / `CLAUDE_CODE_DISABLE_MOUSE` as lowest-precedence environment defaults when a seat spawns, resolved host-side and passed through `CreateOptions` because `ptyHost.ts` runs in a config-blind child process. Claude enters the alternate screen buffer (which has no scrollback in xterm.js) and grabs mouse reporting, which pins `baseY - viewportY` at 0 and makes the jump-to-latest pill structurally unreachable. Brings a Claude seat to parity with every other CLI seat in the grid.

## Dependencies & sequencing

Shipping order is driven by **file contention, not logical dependency** — no subtask needs another's behaviour to work.

- **1. Kanban-Mode Pane … Cannot Scroll** — lands first. It is the smallest change and it establishes the pane-box geometry the other two webview subtasks verify against. Its `minmax(0, 1fr)` edit is the only change in the feature that can alter pane *height*, so landing it alone makes any `FitAddon`/xterm sizing regression unambiguous.
- **2. Show The CLI Brand Icon …** — second. It hoists `fleetItem`/`agentLabel` to the top of `updatePaneElement`'s `if (assignedName)` block, which shifts every line below it in that branch.
- **3. Snappier PTY Prompt Delivery …** — third. It inserts into the *same* block (beside the `syncInputStateChip` call) and modifies `syncInputStateChip` itself, so it must re-derive line numbers after subtask 2 lands.
- **4. Claude CLI Seats …** — may land in parallel with any of the above; it touches no webview file. Prefer landing it after subtask 1 so a pane-geometry regression and a scrollback regression cannot be confused during verification.

Guards and constraints that must be in place:

- **Same-file serialisation is mandatory** for subtasks 1–3. All three edit `src/webview/terminals.html`, and 2–3 both edit `updatePaneElement`'s assigned branch in `src/webview/terminals.js`. Per the project PRD's orchestration discipline — *"One agent stream per provider file … the same file serialises"* — these must not be dispatched to concurrent agents. Subtask 4 is on a disjoint file set and parallelises safely.
- **`package.json` is contended between subtasks 3 and 4.** Subtask 3 registers `switchboard.terminal.ptyClearBeforePromptDelay`; subtask 4 registers `switchboard.terminal.claudeInlineRendering`. Both append to the same `configuration` object — serialise or expect a mechanical merge conflict.
- **`.pane-title` density is a joint outcome no single subtask can verify.** After 1–3 land, the 3x3 header carries brand icon + `P<n>` chip + name + optional badge + optional GAP badge + one of {dispatch chip, input chip}, and only `.pane-title-name` shrinks. The combined-density check belongs to whichever subtask lands last.
- **Research is done; both gating questions resolved 2026-08-12.** Subtask 3's config design is confirmed: a contributed `package.json` default *does* preempt `get(key, fallback)`'s second argument, so the PTY-scoped key is required and `inspect()` is the supported operator-set test. Subtask 4's env vars are confirmed documented and supported (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` from Claude Code v2.1.132), with `"tui": "default"` as a documented fallback if they are ever dropped. Only one assumption remains open anywhere in the feature — subtask 3's 600 ms clear-settle floor, which is empirical and is gated by its own Verification step 1.
- **Testing is via an installed VSIX or the live standalone server** — the webview loads from `dist/`, so a `src`-only edit appears to change nothing.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Snappier PTY Prompt Delivery With A Dispatch Progress Chip In The Pane Header](../plans/feature_plan_20260812093000_snappier-terminal-prompt-delivery-with-dispatch-progress-chip.md) — **CODER CODED**
- [ ] [Show The CLI Brand Icon In Each Terminal Pane Header](../plans/feature_plan_20260812093200_cli-brand-icon-in-terminal-pane-header.md) — **CODER CODED**
- [ ] [Kanban-Mode Pane In terminals.html Cannot Scroll Its Card List](../plans/feature_plan_20260812093500_terminals-kanban-pane-card-list-cannot-scroll.md) — **CODER CODED**
- [ ] [Claude CLI Seats Have No Scrollbar And No Jump-To-Latest: It Enters The Alternate Screen And Grabs The Mouse](../plans/feature_plan_20260812093600_claude-cli-alt-screen-kills-pane-scrollback-and-jump-to-latest.md) — **CODER CODED**
<!-- END SUBTASKS -->

