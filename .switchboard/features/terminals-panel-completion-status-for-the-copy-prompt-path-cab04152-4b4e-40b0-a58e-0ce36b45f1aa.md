# Terminals Panel: Completion Status for the Copy Prompt Path

**Complexity:** 6

## Goal

Completion status in the Terminals panel only works for plans dispatched straight into a pane. A plan whose prompt was copied to the clipboard and pasted by hand gets no activity light and no completion toast, because the copy-prompt verbs never write plans.dispatched_at and PlanIngestionEngine gates the whole clear-and-broadcast on that field being non-null.

This feature closes that gap end to end: first make the Terminals-panel copy button actually reach the clipboard in the browser host, then attribute a pasted dispatch prompt to the exact pane it landed in by matching the plan identity the prompt already carries in plain text. The result is that copy-and-paste dispatch earns the same activity light, pane badge and completion toast as direct dispatch.

## How the Subtasks Achieve This

- **Terminals Panel's Kanban-Pane Copy Prompt Button Never Reaches the Clipboard in the Browser Host**: The kanban pane inside the Terminals panel posts `promptSelected` with a raw `fetch` and discards `data.prompt`, bypassing the browser host's only clipboard hook (`transport.js:292`). It advances the card, reports "Copied!", and leaves the clipboard untouched — silently, and only in the browser host, because the extension host happens to write the clipboard server-side. This subtask writes the prompt client-side and labels a clipboard rejection honestly. It is the copy affordance physically closest to the panes, so it is the one an operator uses for the flow the second subtask instruments.

- **Attribute Copied Dispatch Prompts to the Terminal Pane They Were Pasted Into**: Fixes the two links that keep the completion chain dark for copied prompts — nothing writes `plans.dispatched_at` on copy (so `PlanIngestionEngine.ts:851` never fires the broadcast at all), and nothing writes `plans.dispatched_terminal` (so there is no pane to badge). A detector in `term.onData` recognises a dispatch prompt from the `PLANS TO PROCESS:` / `PLAN_ID=` identity it already carries, arms on the paste, commits on the submit, and records the pane through a new narrow DB write that leaves routing analytics intact.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Attribute Copied Dispatch Prompts to the Terminal Pane They Were Pasted Into](../plans/paste-attribution-copied-dispatch-prompts-terminal-panes.md) — **CODE REVIEWED** — ID: b9a1f4e5-8bdb-4931-b6c6-a5f7254dc125
- [ ] [Terminals Panel's Kanban-Pane Copy Prompt Button Never Reaches the Clipboard in the Browser Host](../plans/terminals-kanban-pane-copy-prompt-never-reaches-clipboard.md) — **CODE REVIEWED** — ID: 636f58b6-7cd7-4fd8-be74-61c077a3bd63
<!-- END SUBTASKS -->

## Dependencies & sequencing

Do the clipboard fix first. The two subtasks touch different root causes and could technically land in either order, but paste attribution cannot be exercised end to end from the Terminals panel until the copy button in that panel actually populates the clipboard — otherwise the UAT step for the attribution work has to be performed from the board panel instead of the surface the feature is about.

They touch `src/webview/terminals.js` in different regions (the kanban-pane copy handler at ~`:2444` versus the `term.onData` handler at ~`:3846`), so sequential landing avoids no conflict in particular — the ordering is about being able to verify the second subtask, not about merge safety.

## Review Findings

Both subtasks reviewed in-place against their plan requirements. The clipboard fix (`terminals.js:2814-2823`) correctly writes `data.prompt` to `navigator.clipboard` and labels failures honestly. The paste attribution scanner (`extractPastedDispatchIdentity`), arm/commit state machine (`term.onData`), DB writer (`attributePasteDispatch`), and verb arm (`attributePastedPrompt`) are all implemented correctly, and the completion chain is verified end-to-end through `PlanIngestionEngine.ts:851` → `onWorkingStateCleared` → `agentCompleted` broadcast in both hosts. Three fixes applied during review: (1) test regex word-boundary bug in `paste-attribution-contract.test.js`; (2) verb-return-contract baseline updated Kanban 0→1 for legitimate nested-loop break; (3) `test:contract:paste-attribution` wired into CI. All automated checks green: `test:contract:paste-attribution` (7/7), `catalog:check`, `parity:check`, `verb-returns:check`, `push-routing:check`, `lint` (0 errors). Files changed during review: `src/test/paste-attribution-contract.test.js`, `scripts/verb-return-contract-baseline.json`, `.github/workflows/integration-tests.yml`. Remaining risk: manual UAT not exercised in this pass.
