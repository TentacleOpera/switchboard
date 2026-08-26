# Drive Feature Implementation Through Coder Terminals

**Complexity:** 6

## Goal

Make this work: tell an agent to implement a feature using a terminal as a coder, and have it dispatch the first subtask, get told when the coder is done, review the work, and resend a fix prompt if it falls short — repeating per subtask.

Every primitive for this already ships. sendToTerminal addresses a terminal by name, standing orders carry a durable parent-to-child callback contract, and the fleet already models coder terminals as children of a head agent. Nothing composes them, nothing documents them, and one of them corrupts long prompts on delivery. The result is that the capability is undiscoverable and, where it is reached, unreliable.

This feature closes those four gaps: fix the delivery path, write the agent-facing contract, give the capability a trigger the user can click, and add a place to define a wired agent team once and instantiate it.

## How the Subtasks Achieve This

- **`sendToTerminal` Delivers Multi-Line Prompts Line By Line**: Fixes the delivery primitive everything else rides on. The verb's PTY branch — the one every HTTP caller hits — does a raw `ptyWrite` of `input + '\r'`, so a multi-KB implementation prompt is submitted one line at a time and the coder starts work on the first fragment. Routes it through `ptySendPrompt`, which owns bracketed-paste framing, chunking and the per-terminal lock. It also flips standing orders from suppressed to applied, which is what carries the callback contract to the coder; without that flip the loop dies silently at its first handoff.

- **Teach The Head Agent To Drive A Coder Terminal**: The agent-facing contract, written as the `terminal-coder-dispatch` skill. Documents addressing a terminal by name, registering the callback as a standing order rather than re-typing it into every prompt, reviewing the diff instead of the coder's claim of it, and the bounded resend to the same terminal. It exists because the capability is currently undiscoverable: `sendToTerminal` appears in no skill, so an agent asked to do this finds only the delegates join (sized for 90-second tasks) or fire-and-forget kanban dispatch, and reasonably concludes the thing is unsupported.

- **Agent Groups: Define a Team of Agents Once, Instantiate It Wired**: The composition surface. A named definition of members — role, count, CLI or model, and which one leads — that instantiates into real terminals with workers parented to the head and standing orders installed. Ships seeded with a **Feature Implementation** group. It is deliberately a general concept rather than a "create N coders" button, because each such button is another entry point for what is one capability: standing up agents that work together. The per-member model field is the cost-routing lever the subagent feature was built for.

- **Add a Third Feature-Workflow Toggle**: The trigger. A `Drive` toggle beside the existing Ultracode and Goal toggles, which prepends a directive naming the skill to feature dispatch prompts. It exists because skill-description matching is not a discovery mechanism — this product's working pattern is a control that owns the invocation, the way Refine does. Without it the other three subtasks are reachable only by the model guessing correctly, which is the failure this whole feature exists to end.

## Reconciled end-state (improve-feature pass, 2026-08-12)

The four subtasks were verified against the code. No plan was merged, split or deleted — the set is genuinely four disjoint units — but seven factual defects were corrected, three of which would have shipped a capability that does not work. Implement to the reconciled facts below; where a subtask plan and this section agree, the subtask plan carries the detail.

**Corrections that change what gets built**

1. **The HTTP route was wrong in two plans.** `sendToTerminal` is a *taskViewer* verb (`TASKVIEWER_VERBS`, `src/generated/verbAllowlist.ts:15`) served at `POST /taskViewer/verb/sendToTerminal` (`LocalApiServer.ts:3897`) — not `/terminals/verb/sendToTerminal`, which routes to `handlePtyVerb` and has no such case in the extension host.
2. **The verb has two incompatible host contracts.** Standalone serves `sendToTerminal` on `/terminals/verb/` with `{terminalName, text}`, auto-creates a terminal when the name misses (`bootstrap.ts:1439-1447`), and clears the recipient's context before every send. The two hosts have disjoint working routes for one verb name. The skill's **primary** recipe is therefore `POST /terminals/verb/ptySendPrompt` with `{name, data, clearBeforePrompt:false}` — identical route and payload on both hosts, correct today.
3. **`clearBeforePrompt` defaults to clearing on the routes an agent will actually use.** Omitting it wipes the coder's conversation before every dispatch, destroying the property that makes a resend work. Mandatory on every agent-issued send.
4. **`sendToTerminal`'s only four shipped callers all send `/clear`** (`implementation.html:1744, 2927, 2962, 3367`). Switching the branch wholesale to prompt delivery would paste a standing-orders block into every context reset. Delivery is therefore content-routed: single-line-leading-slash keeps the raw write; everything else gets framing plus standing orders.
5. **Agent Groups must reuse `spawnDelegates`, not `addAutobanTerminal`.** `_createAutobanTerminal` takes no parent and no launch command. `DelegateDefinition {role, count, label, startupCommand}` is already the member model, already editable in the Agents tab (`kanban.html:4222-4294`), and `spawnDelegates` already parents children, applies per-member launch commands and enforces caps (8 per parent, 32 live).
6. **Per-member CLI/model cannot cross the wire.** Both `ptyHost.ts:212-216` and `TaskViewerProvider.ts:2109-2117` deliberately strip caller-supplied launch commands. Group instantiation must be host-resolved, following the delegates precedent.
7. **The `Drive` toggle's persistence is two flat DB config keys, not a blob.** Adding the new key to the loader's migration gate (`KanbanProvider.ts:4310`) silently resets every existing install's Ultracode and Goal settings. Read `feature_drive_enabled` on its own line, outside that gate.

**Amendment to the sequencing below**

The `## Dependencies & sequencing` section calls the `sendToTerminal` fix a **hard** runtime prerequisite. That was true of the original design, in which the driving agent dispatched through `sendToTerminal`. Under the corrected design the skill's primary route is `ptySendPrompt`, which is correct on both hosts today, so the delivery fix is **no longer blocking** the driven loop — it remains a required bugfix in its own right (latent multi-line corruption, no standing orders, a misleading error, and the standalone divergence), and it is what makes the documented `sendToTerminal` alternative safe.

The toggle-goes-last constraint is unchanged and still hard: its directive names the skill by path.

Net order: **skill → (delivery fix ∥ Agent Groups) → toggle.** Delivery and Agent Groups remain independent of each other and of the skill's authoring; only the toggle has a hard predecessor.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Teach The Head Agent To Drive A Coder Terminal: Dispatch, Callback, Review, Resend](../plans/feature_plan_20260812120000_head-agent-terminal-dispatch-pattern.md) — **CODE REVIEWED** — ID: 5ceaf2db-c6db-48e0-9c81-7fb988744046
- [ ] [`sendToTerminal` Delivers Multi-Line Prompts Line By Line And The Receiving Agent Runs Fragments](../plans/feature_plan_20260812120100_sendtoterminal-pty-path-corrupts-long-prompts.md) — **CODE REVIEWED** — ID: 440629cb-6d5d-4ed8-a64a-2cffdeb17a73
- [ ] [Add a Third Feature-Workflow Toggle: Drive Subtasks Through a Coder Terminal](../plans/feature_plan_20260812120200_feature-workflow-toggle-drive-subtasks-through-coder.md) — **CODE REVIEWED** — ID: 89422a33-527f-4b4e-8563-b17cbf9406e7
- [ ] [Agent Groups: Define a Team of Agents Once, Instantiate It Wired](../plans/feature_plan_20260812120400_agent-groups-in-agents-tab.md) — **CODE REVIEWED** — ID: 9e0b228e-8b3f-4757-9123-61edcce8acf9
<!-- END SUBTASKS -->

## Dependencies & sequencing

One hard ordering constraint, one soft one, and no file collisions anywhere in the set.

**`sendToTerminal` goes first — hard.** It is the delivery primitive the other three depend on at runtime. Land anything else before it and the capability appears to work while delivering fragmented prompts, which presents as the coder misbehaving rather than as a delivery fault. Its standing-orders flip is equally load-bearing: the agent contract and Agent Groups both put the callback in a standing order, and a delivery path that strips them produces a coder that finishes and reports to nobody.

**The toggle goes last — hard.** It prepends a directive naming `.agents/skills/terminal-coder-dispatch/SKILL.md` by path. Shipped before the skill exists, the directive points at nothing.

**The skill and Agent Groups are independent of each other** and can run in parallel. They touch disjoint surfaces — one writes `.agents/skills/` plus the control-plane mirrors, the other writes `kanban.html`, its provider, and a DB config key. The skill references the Agents-tab control in its empty-pool guidance, but only as prose telling the user where to go; it does not read anything the group work produces.

### Shared surfaces

- **`sendToTerminal`'s PTY branch** (`TaskViewerProvider.ts:13337-13344`) — one owner, the delivery subtask. Nobody else edits it.
- **Standing orders** — the delivery subtask changes whether they are *applied*; Agent Groups changes what is *registered*. Different concerns, different files (`TaskViewerProvider.ts:382` vs `standingOrders.ts` callers). No conflict, but both must be present for the callback to reach a coder, so verify them together rather than separately.
- **`setFeatureWorkflowMode`** (`kanban.html:5265` → `KanbanProvider.ts:8910`) — owned solely by the toggle subtask.
- **The Agents tab** — owned solely by Agent Groups.

### Two assumptions to confirm before starting

- **Agent Groups adds a section that does not exist yet.** The subagent feature's parent-child model is live in `terminals.js`, but there is no subagent-definition UI in the Agents tab today. This subtask is the first of its kind there, not a sibling of an existing control.
- **The toggle assumes feature-generic directive composition.** Confirmed with the user: the Ultracode/Goal directive site is feature-generic, not role-specific, so the third toggle composes the same way.

### One durable caveat

Every plan in this set cites line numbers in `TaskViewerProvider.ts`, `kanban.html` and `terminals.js` — all large, actively-edited files. Symbol and function names are authoritative; line numbers will drift. Locate by symbol first.

## Review Findings

Reviewer pass over all four subtasks. One CRITICAL defect ran through the feature's centre: standing orders are **recipient-facing** — `applyStandingOrders` selects on `o.parent === <recipient>` and renders `- Regarding terminal "<child>": …` — but Agent Groups registered `parent: head, child: worker` and the skill documented the same inversion, so the callback contract was delivered to the head and the coder was never told to report. Inverted in `instantiateAgentGroup`, rewritten in the skill and in `switchboard-contracts` contract #9, and the instruction now names the `ptySendPrompt` reply route rather than just the obligation.

Also fixed: three-cap pre-flight before creating the head (was `MAX_ORDERS` only, so an over-cap group left an orphan agent CLI); the `runtime.terminals` registry mirror, which the instantiate arm skipped by bypassing `handlePtyVerb`; unserialised agent-group read-modify-writes; a swallowed `error` on a `success:true` instantiate result; `{{ICON_DRIVE}}` missing from the browser cockpit's icon map; four unregistered Kanban verbs; and a stale `.claude/skills` mirror. The last two had CI gates that were **red** — `catalog:check` and `mirror:check` — both now green.

Files changed: `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/headlessPanelHtml.ts`, `src/webview/kanban.html`, `protocol-catalog.json`, `src/generated/verbAllowlist.ts`, `.agents/skills/terminal-coder-dispatch/SKILL.md`, `.agents/skills/switchboard-contracts/SKILL.md`, and the regenerated `.claude/` mirrors. Verification: typecheck clean (5 pre-existing TS2835), `catalog:check`, `mirror:check`, `pty-route-surface`, `delegate`, `multi-parent-terminals`, `terminal-open-all-seating`, `paste-attribution` all green.

Standalone parity was then closed rather than deferred — the project is Browser Switchboard, so an extension-only Agent Groups instantiation was the wrong call. The host-varying step (create head + delegates below the `handlePtyVerb` wrapper) is now the only per-host piece; caps, orientation, idempotency and partial-failure handling live in the shared `src/services/agentGroupInstantiation.ts`, with `KanbanProvider.setAgentGroupInstantiator()` as the seam and an in-process creator registered in `bootstrap.ts`.

Remaining risks: no automated test pins the standing-order orientation (the inverted version passed every gate) or the standalone instantiation path; and every plan's own verification section is manual-only, so the end-to-end dispatch→callback→review→resend loop has still not been exercised.
