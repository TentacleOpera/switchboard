# Card Settle Latency: Confirm the Column Move Before Dispatching, Not After

## Goal

Make a dropped kanban card become authoritative within a DB write of the drop, instead of after a full agent dispatch completes. Convert the three remaining drag-drop arms (`triggerAction`, `triggerBatchAction`, `promptOnDrop`) to the persist → echo → dispatch order already used by `moveSelected`, `moveAll`, and `_distributePlannerDispatch`, and retire the two obsolete 350ms pre-dispatch timers on the move paths.

### Problem

Cards on the kanban board take a visibly long time to "settle" after a drop. The board itself feels snappy — buttons respond, panels switch instantly — because only the settle waits on a backend round trip.

### Root cause

The confirming signal is emitted at the *end* of a long serialized chain, so the card's DOM position is unbacked by any authoritative data for the whole duration:

1. **A 350ms client-side delay before the POST is even sent.** `src/webview/kanban.html:6999` (drag dispatch groups) and `:7178` (backward move) wrap `postKanbanMessage` in `setTimeout(..., 350)`.

   > **Superseded:** `:7178` characterised as "(backward move)".
   > **Reason:** Verified at `src/webview/kanban.html:7155-7178`. That `setTimeout` wraps **both** `forwardIds` and `backwardIds` — it is the main single/multi-card drop dispatch timer, gating `promptOnDrop`, `triggerAction`, `triggerBatchAction`, `moveCardForward` *and* `moveCardBackwards`. Calling it "the backward move" understates the blast radius of removing it.
   > **Replaced with:** `:7178` is the **main drop-dispatch timer** — it delays every forward path (prompt / CLI / plain move) and the backward path. `:6999` is the equivalent timer on the collapsed CODED_AUTO drag-group path (`:6954-6999`).

2. **The entire dispatch is awaited before any confirm is sent.**
   - `promptOnDrop` (`src/services/KanbanProvider.ts:8604`): the custom-user / prompt-mode branch awaits `dispatchConfiguredKanbanColumnAction(...)` — prompt assembly, clipboard write, terminal `sendRobustText` — and only then loops `_collectAllMovedSessionIds` and posts the `moveCards` delta (`:8649`). The built-in branch awaits `_generatePromptForColumn(...)` (plan-file reads) plus `clipboard.writeText(prompt)` before it starts persisting at all (`:8657-8697`).
   - `triggerAction` (`:7964`) and `triggerBatchAction` (`:8169`) await the dispatch, then call `_scheduleBoardRefresh` (100ms debounce → full board rebuild) and never send a targeted delta.

   > **Superseded:** "`triggerAction` (`:7964`) and `triggerBatchAction` (`:8169`) await the dispatch, then call `_scheduleBoardRefresh` … and never send a targeted delta." (The `promptOnDrop` half of bullet 2 is accurate and stands — verified at `:8629-8649` and `:8657-8697`.)
   > **Reason:** Read the code. Both statements about *persistence order* are false, and the fix is therefore narrower and differently shaped than the plan assumed.
   > • `triggerAction` **already persists first**: `await this.moveCardToColumn(workspaceRoot, sessionId, targetColumn)` at `KanbanProvider.ts:7996-7998`, with a comment explicitly stating the decoupling rationale. Nothing about its persistence is late.
   > • `triggerBatchAction` performs **no persist of its own**; the persist lives inside the dispatch helpers, and there it already runs **before the terminal send** — `handleKanbanBatchTrigger` persists the whole group at `TaskViewerProvider.ts:4868-4889` and even schedules a board refresh at `:4892` *before* `_dispatchExecuteMessage` at `:4897`. What precedes that persist is `generateUnifiedPrompt` at `:4864` (plan-file reads for every plan in the batch) plus plan resolution, feature partitioning and terminal resolution (`:4802-4850`).
   > **Replaced with:** The defect on these two arms is **the confirm, not the persist**. Both signal completion with `_scheduleBoardRefresh` (`:8166`, `:8191`) — a 100ms debounce followed by `switchboard.refreshUI`, a full sidebar+board rebuild (~84ms / ~124KB, fanned out 6× in the browser cockpit) — instead of the cheap targeted `moveCards` delta every converted arm already uses. On `triggerBatchAction` there is additionally a real pre-persist tax: unified prompt generation for the entire batch.

3. **The per-card work is a sequential `for` loop.** Each iteration does `moveCardToColumn` (a sql.js write, i.e. a full DB export + fs write), `recordRunSheetForColumnMove` (a file write), `_recordDispatchIdentity`, and `_collectAllMovedSessionIds`. N cards = N of each, serialized.

   > **Superseded:** "`moveCardToColumn` (a sql.js write, i.e. a full DB export + fs write) … N cards = N of each."
   > **Reason:** `KanbanDatabase._persist()` (`src/services/KanbanDatabase.ts:8704-8724`) is a **trailing debounce** — it bumps `_dataVersion`, marks dirty, and re-arms a `PERSIST_DEBOUNCE_MS = 300` timer (`:1429`). The `export()` + atomic tmp-write happens once per debounce window in `_doPersist()` (`:8747-8756`). A burst of N column updates inside 300ms produces **one** export, not N. The comment at `:8695-8702` says so explicitly.
   > **Replaced with:** The per-card serialized cost is **filesystem work outside the DB**, not the sql.js export:
   > • `recordRunSheetForColumnMove` → `_updateSessionRunSheet` → a SessionLog run-sheet read+write, per card.
   > • `queueIntegrationSyncForSession` (`KanbanProvider.ts:6703-6725`) → `Promise.allSettled` over `_queueClickUpSync` / `_queueLinearSync` / `_queueNotionSync`, each of which calls `loadConfig()` → `GlobalIntegrationConfigService.loadConfig(...)` (a read of `~/.switchboard/integration-config.json`). **Three config reads per card**, awaited inside `moveCardToColumn`. The actual sync itself is `debouncedSync` — non-blocking, correctly so.
   > • `_regenerateFeatureFile` — a feature-file write per card that is or belongs to a feature.
   > • `_autoCommitIfCodeReviewTransition` (`:6756-6775`) — on the `CODE REVIEWED` transition with auto-commit enabled, `moveCardToColumn` awaits a **git commit** before returning. This is the single largest item in the "persist" and it sits in front of any confirm.
   > `getPlanBySessionId` / `getSubtasksByFeatureId` / `_collectAllMovedSessionIds` are in-memory sql.js queries and are cheap.

### Why this is low-risk: the fix already exists in-repo

`moveSelected` (`:8789`) and `moveAll` (`:8924`) were already converted. Their general branch (`:9033-9052`) persists each card, collects `failures`, posts `moveCards` for what succeeded and `moveCardsFailed` for what didn't, and *then* dispatches. The trailing comment at `:9059-9061` states the contract directly: *"No full refresh — the custom-user and general branches each posted their own targeted moveCards delta. Persist already happened; the move sticks independent of dispatch."* `_distributePlannerDispatch` (`:5529`) does the same, and the call-site comment at `:9024-9027` names this exact bug: *"posts its own targeted moveCards echo (and moveCardsFailed for any failed write) BEFORE the slow /clear+send chain … No trailing full refresh — that is what reverted the move to NEW until dispatch finished."*

The drag-drop arms are simply the stragglers that never got converted. This plan applies an established, documented pattern — it does not invent one.

**Verified against the code (2026-07-31):** `_distributePlannerDispatch` at `:5583-5606` and `moveSelected`'s general branch at `:8886-8905` do exactly what the paragraph above describes — per-card `moveCardToColumn` with an `ok` check, `movedIds` / `failures` accumulation, `moveCards` + `moveCardsFailed` posts, *then* dispatch. This is a real, working template.

**One caveat on the template:** `moveAll`'s custom-user branch (`:8996-9001`) and `moveSelected`'s (`:8852-8857`) post the `moveCards` delta *without persisting first* — they rely on `dispatchConfiguredKanbanColumnAction` to persist afterwards. That echo is **hopeful, not confirmed**: if the persist inside the dispatch fails, no `moveCardsFailed` follows and the card lies. Copy the *general* branch's pattern (persist → check `ok` → echo), not the custom-user branch's.

### Why the 350ms timers are obsolete

The surviving comment on the third site (`src/webview/kanban.html:6307`) records the original rationale: *"Slightly less than 400ms to ensure smooth handoff to the backend redraw"* — matched to `.card-dropped { animation: dropPulse 0.4s }` (`:1161-1167`). The POST was deliberately delayed so the backend's immediate full-board redraw would land as the drop animation finished instead of cutting it off.

Git history places the timer in the copy of `kanban.html` recovered from the installed VSIX on 2026-04-06 (`0f46416`), so it predates:
- `moveCardsOptimistically` — first appears 2026-05-23 (`da54d42`)
- the `optimisticMoveUntil` render guard — first appears 2026-06-25 (`c2dd949`)

*(All three commit dates re-verified via `git log` on 2026-07-31: `0f46416` = 2026-04-06, `da54d42` = 2026-05-23, `c2dd949` = 2026-06-25. The chronology in this section is correct.)*

> **Superseded:** "The guard now suppresses exactly the clobbering redraw the timer was hedging against. Two mitigations for one problem, and the older one taxes every settle 350ms."
> **Reason:** **The guard does not cover the message this plan makes arrive earlier.** `optimisticMoveUntil` is consulted in exactly one place: `case 'updateBoard'` at `src/webview/kanban.html:7437-7457`. The `case 'moveCards'` handler at `:7345-7366` reads no guard — it maps `currentCards`, then calls `renderBoard(currentCards)` **unconditionally**. And `renderBoard` is a full DOM replacement (`container.innerHTML = …createCardHtml(card).join('')`, `:6174-6177` and the per-column loop at `:6180+`), so it destroys and re-creates every card element, dropping any in-flight `.card-dropped` class.
> Therefore: today the 350ms timer is what lets `dropPulse` (0.4s) play out before the confirm-triggered re-render wipes it. Delete the timer with no other change and the `moveCards` delta — which this plan deliberately makes arrive *sooner* — lands tens of milliseconds after the drop and truncates the animation. That is a real, user-visible regression, and it is the one thing the timer was actually buying.
> **Replaced with:** The timers are obsolete **as a latency hedge** (the render guard does protect against the stale-`updateBoard` clobber that motivated the original delay) but they are **not** redundant **as an animation fence**. Remove them *together with* a fix that carries `.card-dropped` across a re-render, using the mechanism `renderBoard` already has for exactly this class of problem: the `justFinishedIds` parameter (`renderBoard(cards, justFinishedIds = new Set())`, `:6083`). Add a short-lived `recentlyDroppedIds` set, stamped at drop time and consulted by `createCardHtml`, so a re-render re-emits the class and the animation replays on the fresh element. See **Proposed Changes → `src/webview/kanban.html`**.
> Note this is not a *new* defect class: the button paths (`moveCardsOptimistically`, `:5026-5103`) already post immediately and already receive a `moveCards` delta that re-renders over their `card-dropped` class (`:5056`). The animation fence fixes drag and button paths in one move.

**It is not related to any recent button-registration fix — it is ~4 months old at minimum.**

`:6307` (the `completePlan` button) is a different case and must be **left alone**: it sequences the `card-completing` *exit* animation, so the backend removal doesn't truncate an animation on a card that is leaving the DOM. The two move sites delay a POST for a card that stays on screen; that is the redundant use.

### The goal-vs-appearance gap (added by the improve pass — read this before implementing)

This plan can be implemented exactly as originally written, every checklist item ticked, and **a full board rebuild will still fire on every drop.**

`_scheduleBoardRefresh` at `KanbanProvider.ts:8166` / `:8191` is not the only scheduler of that refresh. `TaskViewerProvider._scheduleSidebarKanbanRefresh` (`:3442-3444`) is a direct passthrough — `this._kanbanProvider?._scheduleBoardRefresh(workspaceRoot)` — and the dispatch layer calls it on **every** path this plan touches:

| Call site | Reached from |
| --- | --- |
| `TaskViewerProvider.ts:4445` | `_dispatchConfiguredKanbanColumnPrompt` — `promptOnDrop` custom-user / prompt-mode |
| `TaskViewerProvider.ts:4892`, `:4962`, `:4976` | `handleKanbanBatchTrigger` — `triggerBatchAction`, multi-card `triggerAction` |
| `TaskViewerProvider.ts:18632` | `_handleTriggerAgentActionInternal` — single-card `triggerAction` CLI path |

So deleting the two `_scheduleBoardRefresh` calls in `KanbanProvider` removes a *duplicate*, not the refresh. The settle win comes **entirely** from posting the `moveCards` delta early — not from deleting the refresh. Any success metric phrased as "removed the trailing full refresh" is a green metric over an unmet goal.

This has a design consequence, not just a documentation one: because the refresh is going to happen anyway, **keep it as the slow-path corrector** rather than fighting it (see the Superseded callout on Scope §1).

## Scope

### 1. Reorder `triggerAction` (`KanbanProvider.ts:7964`) and `triggerBatchAction` (`:8169`)

Persist the column move first, post a targeted `moveCards` delta (plus `moveCardsFailed` for any card whose write returned falsy), then dispatch. Drop the trailing `_scheduleBoardRefresh` (`:8166`, `:8190`) — the delta is the confirm, and the full refresh is what forces a whole-board rebuild at settle time.

> **Superseded:** "Drop the trailing `_scheduleBoardRefresh` (`:8166`, `:8190`) — the delta is the confirm, and the full refresh is what forces a whole-board rebuild at settle time."
> **Reason:** Three independent problems with deleting it.
> (a) **It doesn't remove the rebuild.** Per the goal-vs-appearance section above, the dispatch layer schedules the identical debounced refresh on every one of these paths. Deleting `KanbanProvider`'s call saves one `clearTimeout`/`setTimeout` on a shared 100ms-debounced timer field (`this._refreshDebounceTimer`, `:3778-3786`) and nothing else.
> (b) **It is the only corrector for state the delta cannot carry.** `moveCards` sets `column` and nothing else. Dispatch mutates more than the column: `_recordDispatchIdentity` (`:3220-3260`) writes `routedTo` / `dispatchedAgent` / `dispatchedIde`, and dispatch flips the card's `working` state. On the branches that *don't* go through `_handleTriggerAgentActionInternal` — notably the IDE-Lead branch at `:8078-8091`, which calls `moveCardToColumn` + `_recordDispatchIdentity` directly — deleting the trailing refresh leaves the card without its agent badge until an unrelated refresh happens to fire.
> (c) **It papers over a latent double-move.** The drag path calls `switchboard.triggerAgentFromKanban` with no options (`:8109`), so `explicitTargetColumn` is empty and `_handleTriggerAgentActionInternal` computes its own `targetColumn = this._targetColumnForRole(role)` (`TaskViewerProvider.ts:18620`) and persists to *that* (`:18628`). For built-in columns it agrees with the drop target; for any role whose `_targetColumnForRole` differs from the dropped column (`researcher` → `PLAN REVIEWED`, `:3225-3226`), it does not — and the early delta would then assert a column the DB no longer holds. The trailing refresh is what currently reconciles this.
> **Replaced with:** **Keep the trailing `_scheduleBoardRefresh` on both arms.** Add the targeted `moveCards` delta immediately after the persist and *before* the dispatch — that alone is the settle fix. The refresh stays as the debounced, off-critical-path reconciler for dispatch identity, `working` state, and any dispatch-layer column rewrite. Note the delta must therefore be **idempotent-safe against a later correction**: the webview's `moveCards` handler already tolerates this (it maps by id and re-renders), and a subsequent `updateBoard` with the true column simply corrects it after the 2000ms guard window.
> If the trailing refresh later proves genuinely wasteful, the right removal target is the *dispatch layer's* `_scheduleSidebarKanbanRefresh` calls — a separate, wider-blast-radius change that also affects the Agents tab, and out of scope here.

**Concretely, per arm:**

- **`triggerAction`** — the persist is already first at `:7996-7998`. The only change is to post `{ type: 'moveCards', sessionIds: <cascade ids>, targetColumn }` right after it (and `moveCardsFailed` if `moveCardToColumn` returned falsy — note the current code ignores its return value entirely). Use `_collectAllMovedSessionIds` so feature→subtask cascades echo correctly, matching every other converted arm. Everything below stays where it is.
- **`triggerBatchAction`** — currently persists nothing itself. Add the persist + delta loop *before* calling `dispatchConfiguredKanbanColumnAction` / `switchboard.triggerBatchAgentFromKanban`, copying `moveSelected`'s general branch (`:8886-8905`). The downstream `_updateKanbanColumnForSession` calls become idempotent no-ops on the same column. Note the handler **discards** the dispatch result (`:8181-8187` awaits and ignores the boolean), so nothing downstream depends on the `await` completing before the confirm.

Note `triggerAction` currently returns `{ success, role, targetColumn, dispatchable }` and its `_scheduleBoardRefresh` comment claims the refresh exists to "correct optimistic UI that already moved the card visually" when `canDispatch` is false. A targeted delta serves that purpose more precisely; keep the response shape.

### 2. Reorder `promptOnDrop` (`:8604`)

Three branches, each needing care:

- **Custom-user / prompt-mode built-in (`:8626-8654`)**: `dispatchConfiguredKanbanColumnAction` currently owns the persist (per the comment at `:8644-8645`). Determine whether it can be called after an explicit `moveCardToColumn` without double-moving, or whether the delta can be hoisted using the already-known `targetColumn` while leaving the persist where it is. **Investigate before editing** — this is the one genuine unknown in the plan. `moveSelected`'s custom-user branch (`:9000-9017`) is the reference for how this was resolved there.

  > **Superseded:** "Determine whether it can be called after an explicit `moveCardToColumn` without double-moving … **Investigate before editing** — this is the one genuine unknown in the plan."
  > **Reason:** Investigated during this improve pass; it is no longer unknown. (The cited reference line numbers were also off: `:9000-9017` lands in `moveAll`, not `moveSelected` — `moveSelected`'s custom-user branch is `:8851-8877`.)
  > **Replaced with:** **Yes, it can be called after an explicit `moveCardToColumn`, with no double-move.** The chain is `dispatchConfiguredKanbanColumnAction` (`TaskViewerProvider.ts:4269`) → `_dispatchConfiguredKanbanColumnPrompt` (`:4379`) → per-plan `_updateKanbanColumnForSession(root, sessionId, targetColumn)` (`:4415`) → `KanbanProvider.moveCardToColumn` (`TaskViewerProvider.ts:3438`). It is the **same method**, with the **same target column**, so the second call is an idempotent `UPDATE … SET kanban_column = <same value>`. There is no source-column capture and no relative move anywhere in the path, so it cannot compound.
  >
  > The side effects are the thing to check, and all three are safe to run twice:
  > • `_autoCommitIfCodeReviewTransition` — a second commit attempt on an already-clean tree is a no-op (only fires on `CODE REVIEWED` with auto-commit on).
  > • `queueIntegrationSyncForSession` → `debouncedSync` — coalesces by design.
  > • `_regenerateFeatureFile` — deterministic regeneration from DB state; rewriting the same content is harmless.
  > `_recordDispatchIdentity` is **not** called by `moveCardToColumn` — it is called separately at `:4416-4422` — so hoisting the persist does not duplicate it.
  >
  > **Therefore the fix is:** persist explicitly (per-card, checking `ok`), post `moveCards` / `moveCardsFailed`, *then* call `dispatchConfiguredKanbanColumnAction` unchanged. This is worth doing rather than merely hoisting the echo, because the persist inside `_dispatchConfiguredKanbanColumnPrompt` sits **after** `generateUnifiedPrompt` (`:4404`, plan-file reads for every plan) and `clipboard.writeText` (`:4407`) — hoisting only the echo would make it a hopeful echo (the same weakness flagged in the template caveat above), not a confirmed one.

- **`PLAN REVIEWED` complexity-routing (`:8666-8686`)**: the target column isn't known until `_partitionByComplexityRoute` runs, but that's a DB read, not a dispatch. Order: partition → persist → per-group delta → generate prompt → clipboard → dispatch. Preserve the existing FE behaviour where mixed-complexity batches deliberately suppress the optimistic move (see the comments at `kanban.html:5507`, `:5526`, `:5550`, `:5569`, `:6335-6343`).

  **Clarification (strictly implied):** the prompt generation this branch must move behind the persist is `_generatePromptForColumn` + `clipboard.writeText` at `:8657-8659`, which currently run **before** the `sourceColumn === 'PLAN REVIEWED'` check at `:8665`. The persist/delta loop itself (`:8672-8685`) is already correctly structured — per-group `moveCardToColumn` then a per-group `moveCards` post. This branch needs the two lines above it moved down, plus an `ok` check + `moveCardsFailed` to match the converted arms; the loop body otherwise stands.

- **General branch (`:8687-8697`)**: straightforward — hoist the persist + delta above `_generatePromptForColumn` and `clipboard.writeText`.

  **Clarification (strictly implied):** same two lines (`:8658-8659`) — this branch and the routing branch share them, so one relocation serves both. Add the `ok` / `moveCardsFailed` handling here too; the loop at `:8688-8695` currently ignores `moveCardToColumn`'s return value.

### 3. Batch the per-card work

Replace the sequential loops with a single pass where the data layer allows it: one batched column update (one sql.js export instead of N), one run-sheet write pass, one `_collectAllMovedSessionIds` call. Audit what the kanban DB layer already offers for batched writes before adding anything new — do not hand-roll a transaction wrapper if one exists.

> **Superseded:** "one batched column update (one sql.js export instead of N)".
> **Reason:** Per the correction to Root Cause 3, `_persist()` already coalesces exports behind a 300ms trailing debounce (`KanbanDatabase.ts:8704-8724`), so a burst of N column updates already produces one export. Batching the *column update* buys close to nothing.
> **Replaced with:** The batching target is the **per-card filesystem work**, in this order of payoff:
> 1. **Integration config reads.** `queueIntegrationSyncForSession` triggers three `loadConfig()` reads of `~/.switchboard/integration-config.json` per card, awaited inside `moveCardToColumn`. Hoist/memoize the config for the duration of a batch (or make the three queue calls fire-and-forget — they end in `debouncedSync` anyway, so nothing downstream needs them awaited).
> 2. **Run-sheet writes.** `recordRunSheetForColumnMove` → `_updateSessionRunSheet` is a read+write per card through SessionLog. Check whether SessionLog exposes a batch update before adding one.
> 3. **`_regenerateFeatureFile`.** N cards in the same feature regenerate the same file N times. Dedupe by feature id per batch.
>
> **Recommended: split this item into its own plan.** It is a different root cause (per-card fs fan-out, not confirm ordering), it touches paths shared with the already-converted `moveSelected` / `moveAll` / `_distributePlannerDispatch` arms rather than only the drag arms, and it is independently shippable and independently valuable. Items 1, 2 and 4 form one coherent, self-contained change; item 3 does not depend on them and they do not depend on it.

### 4. Remove the two obsolete timers

Delete the `setTimeout(..., 350)` wrappers at `kanban.html:6999` and `:7178`, posting immediately instead. Leave `:6307` in place and extend its comment to say why it survives, so a later cleanup sweep doesn't remove it as a leftover twin.

**Blocked on the animation fence.** Per the Superseded callout in "Why the 350ms timers are obsolete": do not land this without the `recentlyDroppedIds` change, or `dropPulse` is truncated on every drop. Ship them in the same commit.

Also update the stale comment at `kanban.html:4214` — `const OPTIMISTIC_MOVE_WINDOW_MS = 2000; // covers the 350ms dispatch + backend round-trip` — since the 350ms component is gone. Keep the value at 2000ms: it now covers backend round-trip only, with headroom for a slow persist (a `CODE REVIEWED` drop can include a git commit).

### Out of scope

- **The render-guard bounce** (the `workingChanged` escape hatch rendering stale pre-move positions, and `moveCards` doing a full board rebuild). Separate plan — it is a correctness bug, not a latency one, and the two are independently shippable.

  **Note (scope interaction, not a scope change):** because `moveCards` → `renderBoard` is a full rebuild and stays that way, the delta is targeted in *transport* only. The win this plan delivers is "the authoritative confirm arrives ~a dispatch earlier", not "the board does less work per drop". State the win that way in the commit message so the follow-up plan isn't assumed to be already done.

- **Browser fan-out amplification**: the headless shell mounts all six panels as live iframes (`shell.js`), `wsHub.broadcast` re-`JSON.stringify`s each payload per connection (`wsHub.ts:263`), `transport.js`'s `onmessage` never checks `msg.surface`, and `getFullState` builds the whole kanban board for every connection regardless of panel (`TaskViewerProvider.ts:1962` → `KanbanProvider.getFullStateMessages:1065`). Measured: `GET /kanban/board` = 84ms / 124KB. This multiplies the `updateBoard`-flavoured pushes 6× on both ends. Worth its own plan; it is secondary to the settle symptom and does not block this work.

- **Removing the dispatch layer's own `_scheduleSidebarKanbanRefresh` calls** (`TaskViewerProvider.ts:4445`, `:4892`, `:4962`, `:4976`, `:18632`). Named here because the goal-vs-appearance section shows they, not `KanbanProvider`'s calls, are what actually keep the full rebuild alive. They also serve the Agents tab, so removing them is a wider change than this plan.

### Non-goals

No user-visible behaviour change beyond faster settling. No new state, settings, or files, so no migration is required.

**Confirmed:** nothing in this plan touches persisted state, settings keys, file formats, or DB schema — only in-process ordering and two client-side timers. The ~4,000-install migration rule does not apply.

## Metadata

**Complexity:** 7
**Tags:** performance, backend, ui, refactor

## User Review Required

- None. Every decision in this plan is an engineering call and has been made above. The one item that would otherwise be a judgement call — whether to split Scope §3 into its own plan — is a recommendation with a stated rationale; if the user declines, implement all four items in one pass and the plan still stands.

## Complexity Audit

### Routine

- Adding a `moveCards` / `moveCardsFailed` post after an existing `moveCardToColumn` call in `triggerAction` — the persist is already in the right place.
- Relocating `_generatePromptForColumn` + `clipboard.writeText` (`KanbanProvider.ts:8657-8659`) below the persist loops in `promptOnDrop`.
- Adding `ok`-checking + `failures` accumulation to three existing per-card loops, copying `moveSelected:8886-8905` verbatim in shape.
- Deleting two `setTimeout(..., 350)` wrappers and updating two comments.

### Complex / Risky

- **The animation fence.** Removing the timers without carrying `.card-dropped` across the confirm-triggered `renderBoard` truncates `dropPulse` on every drop. Requires a new short-lived `recentlyDroppedIds` set threaded from three drop sites through `renderBoard` into `createCardHtml`, plus expiry so a stale id doesn't re-animate a card on an unrelated refresh.
- **Four dispatch branches in `triggerAction` with different persistence owners** (custom-user CLI, custom-user prompt-fallback, IDE-Lead, built-in CLI, no-agent fallback). Each has a different downstream refresh story; the trailing refresh must survive in all of them.
- **`triggerBatchAction` gains a persist it never had**, layered above a dispatch chain that also persists (`handleKanbanBatchTrigger:4878`). Idempotent by inspection, but it is a new double-write path across two services.
- **Latent double-move via `_targetColumnForRole`** (`TaskViewerProvider.ts:18620`) on the no-options drag path — the early delta can assert a column the dispatch layer subsequently rewrites.
- ~~Cross-service ordering: the correctness of "confirm before dispatch" depends on the webview processing the `moveCards` delta before the dispatch-layer `updateBoard`, across two different transports (VS Code webview postMessage; browser-cockpit WebSocket).~~ **Resolved — no longer a risk.** Ordering holds on both transports and both handlers are synchronous; see `## Resolved Assumptions` §1. Retained here struck through so the risk isn't re-raised in review.

## Edge-Case & Dependency Audit

**Race Conditions**

- *Delta vs. trailing refresh.* The delta is posted synchronously; the refresh is a 100ms debounce that then awaits `switchboard.refreshUI`. The delta wins by construction on both transports, but the refresh's payload is built *after* the persist, so it agrees with the delta — except in the `_targetColumnForRole` double-move case, where the refresh legitimately corrects the delta. Do not "fix" that by suppressing the refresh.
- *`_refreshDebounceTimer` is a single shared field* (`KanbanProvider.ts:3781`). Every `_scheduleBoardRefresh` caller across both services re-arms the same timer, so a rapid multi-group drop collapses to one refresh — but it also means a later unrelated caller can *push the refresh out* by re-arming. Harmless here (the delta is the confirm), worth knowing.
- *Render guard expiry.* `optimisticMoveUntil` is armed for 2000ms at drop time (`:6952`, `:7146`). A `CODE REVIEWED` drop whose persist includes a git commit can exceed that; a stale `updateBoard` landing after expiry but before the confirm re-renders pre-move positions. Pre-existing, and *reduced* by this plan (the confirm arrives earlier), not introduced by it.
- *`moveCards` arrives while a second drag is in flight.* Unchanged by this plan — the handler maps by id and only touches listed cards.

**Security**

- None. No new inputs, no new surfaces, no auth or path handling touched. Session ids flowing into the delta are the same ids already flowing into the existing `moveCards` posts on the converted arms.

**Side Effects**

- `moveCardToColumn` is **not** a pure DB write. Hoisting it earlier hoists its side effects earlier too: a git commit (`CODE REVIEWED` + auto-commit), three integration-config reads, integration `debouncedSync` scheduling, and feature-file regeneration. On the `CODE REVIEWED` transition specifically, the confirm still cannot beat a git commit — the plan's Goal sentence ("within a DB write of the drop") is not literally achievable on that column without also moving `_autoCommitIfCodeReviewTransition` off the critical path. Either accept it or file it with Scope §3.
- `triggerBatchAction`'s new persist means the DB is written even when the subsequent dispatch fails outright. That is the *intended* semantic change (it matches every converted arm and the `persistColumnOnError: true` contract already set at `TaskViewerProvider.ts:4310`), but it is a behaviour change: a failed batch dispatch now leaves cards advanced rather than in place.
- Removing the 350ms timers changes `moveCardForward` / `moveCardBackwards` timing too — they share the `:7178` timer.

**Dependencies & Conflicts**

- `src/services/KanbanProvider.ts` and `src/webview/kanban.html` are both modified in the working tree at the time of writing (`git status`). Rebase/merge care required.
- No new packages. No config or schema changes.
- Touches the same handlers as the out-of-scope render-guard plan (`.switchboard/plans/kanban-render-guard-stale-bounce.md`). If both land, the render-guard plan's changes to `case 'moveCards'` interact directly with the animation fence added here — sequence them, don't parallelise.

## Dependencies

- None. This plan is self-contained; no prior session's output is required.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is a silent cosmetic regression: deleting the 350ms timers makes the confirm-triggered full `renderBoard` land mid-`dropPulse`, and the `optimisticMoveUntil` guard does **not** cover `case 'moveCards'`, so nothing else prevents it — the animation fence must ship in the same commit. The second risk is a green-metric outcome: deleting `KanbanProvider._scheduleBoardRefresh` looks like it removes the whole-board rebuild, but the dispatch layer schedules the identical refresh on all five affected paths, so the settle win comes solely from posting the delta early — and deleting that refresh actually removes the only corrector for dispatch identity, `working` state, and the `_targetColumnForRole` double-move. Mitigations: keep the trailing refresh, ship the fence with the timers, add `ok`/`moveCardsFailed` handling to every loop that currently ignores `moveCardToColumn`'s return value, and measure before and after rather than asserting the win.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `case 'triggerAction'` (`:7964-8168`)

- **Context.** The persist is already first (`:7996-7998`) and its return value is discarded. Completion is signalled only by `_scheduleBoardRefresh` at `:8071` (custom-user branch) and `:8166` (all other branches).
- **Logic.** Confirm the move the moment it is persisted, independent of which of the five dispatch branches runs.
- **Implementation.** Capture `const ok = await this.moveCardToColumn(...)` at `:7997`. If `ok`, `const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sessionId)` and `this.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn })`. If not, `this.postMessage({ type: 'moveCardsFailed', failures: [{ id: sessionId, sourceColumn: sourceColumnForPrompt ?? '', reason: "couldn't save — board may be out of sync" }] })` and return early with `{ success: false, ... }` — dispatching a card whose move did not persist is the bug this plan exists to prevent. Leave both `_scheduleBoardRefresh` calls and the `{ success, role, targetColumn, dispatchable }` response shape untouched.
- **Edge cases.** `workspaceRoot` may be falsy — the existing code already guards the persist on it (`:7996`); guard the delta the same way. `sourceColumnForPrompt` is captured at `:7991` before the persist, which is exactly what `moveCardsFailed` needs to revert to.

### `src/services/KanbanProvider.ts` — `case 'triggerBatchAction'` (`:8169-8193`)

- **Context.** No persist of its own; both dispatch calls (`:8181`, `:8189`) are awaited and their results discarded; completion signalled by `_scheduleBoardRefresh` at `:8191`.
- **Logic.** Add the persist + confirm loop ahead of the dispatch, matching `moveSelected`'s general branch.
- **Implementation.** After resolving `role` (`:8178`) and before the `if (dispatchSpec?.source === 'custom-user' …)` at `:8179`, insert the loop from `:8886-8905`: per `sid`, `const ok = await this.moveCardToColumn(workspaceRoot, sid, targetColumn)`; on `ok`, `recordRunSheetForColumnMove(sid, targetColumn, 'forward', workspaceRoot)` + `_collectAllMovedSessionIds` into `movedIds` and `sid` into `dispatchIds`; else push a failure. Post `moveCards` for `movedIds` and `moveCardsFailed` for `failures`. Pass `dispatchIds` (not the raw `sessionIds`) to both dispatch calls. Keep `_scheduleBoardRefresh` at `:8191`.
- **Edge cases.** `workspaceRoot` can be null here (`_resolveWorkspaceRoot` may return falsy) — skip the persist loop and fall through to today's behaviour rather than crashing. If every write fails, `dispatchIds` is empty: skip the dispatch entirely.

### `src/services/KanbanProvider.ts` — `case 'promptOnDrop'` (`:8604-8710`)

- **Context.** Three branches. Custom-user / prompt-mode (`:8627-8655`) delegates the persist to `dispatchConfiguredKanbanColumnAction` and echoes after it. `PLAN REVIEWED` routing (`:8665-8685`) and general (`:8686-8697`) both persist-and-echo correctly but sit below `_generatePromptForColumn` + `clipboard.writeText` at `:8657-8659`.
- **Logic.** Persist and confirm before any prompt assembly or clipboard write, on all three branches.
- **Implementation.**
  1. **Custom-user / prompt-mode:** before `dispatchConfiguredKanbanColumnAction` at `:8629`, add the per-card persist loop with `ok` checks, post `moveCards`/`moveCardsFailed`, then dispatch unchanged. Delete the now-redundant post-dispatch echo at `:8644-8649`. The second persist inside `_dispatchConfiguredKanbanColumnPrompt:4415` is an idempotent same-column write — see the resolved investigation in Scope §2.
  2. **Move `_generatePromptForColumn` + `clipboard.writeText` (`:8657-8659`) down**, below both remaining branches' persist/echo loops and above the `promptOnDropResult` / status posts at `:8707-8708`. Both branches keep their existing `moveCards` posts; add `ok` checks and `moveCardsFailed`.
  3. `_partitionByComplexityRoute` (`:8666`) and `_getVisibleAgents` (`:8667`) stay where they are — DB reads, cheap, and the routed target column is not knowable without them.
- **Edge cases.** The "no coding agent enabled" early-return at `:8668-8671` must stay **above** the persist — it aborts the whole operation and must not leave cards half-moved. The mixed-complexity no-optimistic-move FE behaviour (`kanban.html:5507`, `:5526`, `:5550`, `:5569`, `:6335-6343`) is unaffected: it governs whether the *client* pre-moves, not what the server echoes.

### `src/webview/kanban.html` — animation fence + timer removal

- **Context.** `case 'moveCards'` (`:7345-7366`) calls `renderBoard` unconditionally; `renderBoard` (`:6083`) replaces column `innerHTML`, destroying any in-flight `.card-dropped`. The 350ms timers at `:6999` and `:7178` are currently what keeps `dropPulse` (0.4s, `:1166-1167`) intact.
- **Logic.** Make the drop animation survive a re-render, then remove the timers, in one commit.
- **Implementation.**
  1. Add `const recentlyDropped = new Map(); // id -> expiryMs` near `optimisticMoveUntil` (`:4213`).
  2. At each site that adds `.card-dropped` — `moveCardsOptimistically:5056`, the CODED_AUTO drag group at `:6930-6933`, and the main drag path at `:7135-7140` — also `recentlyDropped.set(id, Date.now() + 400)`.
  3. In `createCardHtml`, emit `card-dropped` in the card's class list when `recentlyDropped.get(id) > Date.now()`; prune expired entries at the top of `renderBoard` (mirroring how `justFinishedIds` is threaded at `:6083`).
  4. Delete the `setTimeout(..., 350)` wrappers at `:6954-6999` and `:7155-7178`, posting immediately. Leave `:6307` (`completePlan`) alone and extend its comment to record that it fences a *card-exit* animation on a card leaving the DOM, so a later sweep doesn't remove it as a twin of the two deleted here.
  5. Update the stale comment at `:4214` (`// covers the 350ms dispatch + backend round-trip`); keep the 2000ms value.
- **Edge cases.** A card re-rendered *after* its 400ms expiry must not re-animate — hence the expiry map rather than a plain Set. A card that is dropped and then immediately fails (`moveCardsFailed`) re-renders in its source column; letting it carry the pulse there is acceptable and arguably desirable (it draws the eye to the revert), but the status message is the real signal.

## Verification Plan

Measure first, so the change is provable rather than asserted:

1. **Baseline instrumentation.** Timestamp in the browser console: drop → POST sent → `moveCards`/`updateBoard` received → render complete. Capture for each path below. Record the numbers in the plan before changing code.

2. **Per-path manual test** (browser cockpit *and* the editor webview — the reorder is host-agnostic and must not regress the editor):
   - Drag forward into a coder column with CLI triggers **on** (`triggerAction`)
   - Same with CLI triggers **off** (`moveCardForward` — should be unchanged)

     > **Superseded:** "Same with CLI triggers **off** (`moveCardForward` — should be unchanged)."
     > **Reason:** `moveCardForward` is posted from inside the `:7155-7178` `setTimeout` (`kanban.html:7169`), the same timer this plan deletes. It will not be unchanged — it gets ~350ms faster, and it becomes subject to the animation-fence question like every other drop path.
     > **Replaced with:** Same with CLI triggers **off** (`moveCardForward` — backend handler unchanged, but expect ~350ms faster settle and verify `dropPulse` still plays).

   - Multi-select drag forward (`triggerBatchAction`) — additionally confirm the card stays advanced when the dispatch fails, which is a **new** behaviour on this arm
   - Drag into a prompt-mode column (`promptOnDrop`, custom-user branch)
   - Drag out of `PLAN REVIEWED` with a mixed-complexity batch (routing branch — confirm cards land in the *routed* columns and the FE's deliberate no-optimistic-move behaviour still holds)
   - Drag backward (`moveCardBackwards` + the removed `:7178` timer)
   - `completePlan` button — confirm the exit animation still plays cleanly (the timer we deliberately kept)
   - **Added:** drag a card into `CODE REVIEWED` with auto-commit enabled — confirm the settle now waits on the git commit, and record how long, so the residual latency is documented rather than surprising.
   - **Added:** drag a **feature** card (with subtasks) on each arm — confirm the delta carries the cascaded subtask ids via `_collectAllMovedSessionIds` and the subtasks move with it.
   - **Added:** drop a card, then immediately switch workspace/project — `optimisticMoveUntil = 0` fires (`:7669`, `:8348`, `:8407`); confirm no stale `card-dropped` leaks onto an unrelated card.

3. **Failure path.** Force `moveCardToColumn` to return falsy for one card in a batch; confirm `moveCardsFailed` arrives and that card alone reverts to its source column with the status message, while its siblings stay moved.

4. **Dispatch failure.** With no agent terminal live, confirm the card stays in the target column (persist is now independent of dispatch — this is the intended change) and the existing "no agent" messaging still fires.

5. **Regression suite.** Run the kanban tests, in particular `src/test/kanban-card-button-drag-guard.test.js`, which asserts on the *ordering* of `moveCards` relative to other posts via source regex — it will likely need updating in lockstep, and its assertions encode the invariant this plan is changing. Confirm the five known-red tests at HEAD are still the same five and no new failures appear (stash-verify before attributing any red test to this work).

   > **Superseded:** "in particular `src/test/kanban-card-button-drag-guard.test.js`, which asserts on the *ordering* of `moveCards` relative to other posts via source regex — it will likely need updating in lockstep, and its assertions encode the invariant this plan is changing."
   > **Reason:** Read the file (114 lines). Its only ordering assertion — Assertion 8, `:83-105` — slices `KanbanProvider.ts` from `case 'promptSelected':` and asserts `copyPlanLinkResult` follows `moveCards` **within `promptSelected`**, a handler this plan does not touch. Assertions 1-7 are about the card-button drag guard, pointer capture, and `.card-btn` CSS. Nothing in it covers `triggerAction`, `triggerBatchAction`, `promptOnDrop`, or the 350ms timers. A separate grep confirmed **no** test in `src/test/` asserts on the `350` literal or on these timers.
   > **Replaced with:** `kanban-card-button-drag-guard.test.js` needs **no** lockstep update — but re-run it, because Assertion 4 (`kanbanHtml.includes('draggable="false"') === false`) and Assertion 8's fixed 8000-char slice are brittle against edits to `kanban.html` / `KanbanProvider.ts`. The tests most likely to be affected are the source-regex regressions over the drag handler: `kanban-coded-auto-batching-regression`, `kanban-coded-auto-drag-out-regression`, `kanban-coded-auto-prompt-mode-regression`, `kanban-backward-reset-regression`, and `kanban-batch-prompt-regression`. Read those five before editing, not after. There is **no** existing test asserting the persist-before-dispatch invariant on the drag arms — see Automated Tests below.

6. **Post-change measurement.** Re-run step 1 and confirm the settle time drops by roughly the dispatch duration plus 350ms.

   **Sharpened:** the expected win is **350ms + (prompt generation + terminal send) − (nothing)**. It is *not* "minus a full board rebuild" — the rebuild still fires from the dispatch layer (see the goal-vs-appearance section). If the measured win materially exceeds prompt-gen + send + 350ms, something else changed and the measurement is suspect.

### Automated Tests

Per session directive, tests are **not run** as part of this planning pass. The following are specified for the implementer:

- **New source-regex test** (`src/test/kanban-drag-confirm-before-dispatch.test.js`), matching the house style of the existing `kanban-*-regression.test.js` files: slice `KanbanProvider.ts` at `case 'triggerAction':`, `case 'triggerBatchAction':` and `case 'promptOnDrop':`, and assert in each that the first `type: 'moveCards'` post appears **before** the first `dispatchConfiguredKanbanColumnAction` / `executeCommand('switchboard.trigger…` / `_generatePromptForColumn` occurrence. This is the invariant the plan establishes and nothing currently guards it — the converted arms regressed once already.
- **Negative test:** assert `kanban.html` contains no `}, 350);` inside the two drag-dispatch blocks while still containing the `completePlan` one, so a later sweep can't silently reintroduce or over-remove.
- **Fence test:** assert `createCardHtml` consults the `recentlyDropped` map, so the animation fence can't be dropped in a later refactor of `renderBoard`.
- Re-run the five source-regex drag regressions named in Verification step 5.

## Resolved Assumptions

Two external platform behaviours were flagged as uncertain during the improve pass. Both were settled by web research plus a follow-up code check on 2026-07-31. **This section is authoritative — do not re-open these during implementation, and do not commission further research on them.**

### 1. VS Code webview `postMessage` delivery ordering — RESOLVED, safe

**Question:** does the early `moveCards` delta reliably reach the webview before the later `updateBoard` from the debounced refresh?

**Answer:** Yes, on both transports.

- There is no formal FIFO clause in `vscode.d.ts` or the API reference, but host→webview messages are serialized over a **single IPC channel** (Electron IPC on desktop; `MessagePort`/WebSocket in web/remote hosts), so arrival order at the webview's `message` event queue matches post order. The in-repo assertion at `wsHub.ts:20-24` ("VS Code's implicit postMessage ordering") is correct.
- The documented residual risk is **not** transport reordering but **async handling inside the webview** — a handler that `await`s mid-way can apply state out of order. **This does not apply here:** `case 'moveCards'` (`kanban.html:7345-7366`) and `case 'updateBoard'` (`:7388+`) are both fully synchronous; neither awaits.
- The extension's own queueing path also preserves order: `KanbanProvider.postMessage` (`:2107-2122`) pushes to `_pendingWebviewMessages` when `!_webviewReady` and the flush at `:7329-7331` replays the array in insertion order.
- Browser cockpit: `wsHub` already implements monotonic per-connection sequence numbers with client gap detection plus a full-state resync on every (re)connect (`wsHub.ts:20-24`, `:193-202`) — the industry-standard mitigation for the higher-latency remote case.

**Implementation consequence:** none. The ordering the design depends on holds. **Do not** use `webview.postMessage`'s `Thenable<boolean>` as a delivery confirmation if tempted — it is a dispatch/queue acknowledgement only, and the official docs state explicitly that `true` does not mean the webview received the message. `KanbanProvider.postMessage` correctly ignores it.

### 2. `postMessage` while the panel is hidden or restored — RESOLVED, does not apply

**Question:** could an early `moveCards` delta be silently dropped to a hidden webview on a path where today's trailing full refresh would have recovered on reveal?

**Answer:** No. The failure mode is real in general but the kanban panel is already immune, via all four mitigations the research identifies as standard practice:

| Risk | Mitigation already in this codebase |
| --- | --- |
| Hidden panel's iframe destroyed → messages silently dropped, `postMessage` resolves `false` | `retainContextWhenHidden: true` at `KanbanProvider.ts:1454` — the context is never destroyed on hide |
| Restored panel can't re-enable retention (creation-time option) | Documented at `:1552-1556`; covered by the `ready` handshake + broadcaster re-init |
| Speculative send before the webview's listener is attached | Handshake on mount: `_webviewReady` gate + `_pendingWebviewMessages` queue (`:2107-2122`, `:7299`, `:7329-7331`); comment at `:1519-1520` confirms the webview drives initial sync via `ready` |
| Stale state after a hide→reveal cycle | Visibility resync: `onDidChangeViewState` → `_refreshBoard` on **both** creation paths (`:1509-1517` and `:1592-1600`) |
| Messages posted between dispose and reopen | Broadcaster's own pending queue, cleared deliberately at `:1585-1589` |

**Implementation consequence — this *strengthens* the "keep the trailing refresh" decision in Scope §1.** The reveal-time `_refreshBoard` at `:1511-1512` is the same full-refresh-as-reconciler pattern the research names as Pattern B, already load-bearing elsewhere in this file. Deleting the trailing refresh on the dispatch arms would make the drag paths the only ones without a reconciler, in a codebase that applies one everywhere else. Keep it.

**Also note:** because retention is a creation-time option, a *restored* panel (after a window reload) genuinely has no retention. Its safety comes entirely from the `ready` handshake and the visibility resync — two mechanisms this plan must not disturb. Nothing in the proposed changes touches either, but do not "simplify" the `_webviewReady` gate while working in `postMessage`.

### Everything else

All other uncertainties raised during the improve pass were code-answerable and were resolved inline above: persistence ownership in `dispatchConfiguredKanbanColumnAction`, sql.js persist coalescing, the render guard's actual coverage, the dispatch layer's own refresh scheduling, and the test-suite impact. **No open assumptions remain. No further research is required before implementation.**

## Agent Recommendation

**Complexity 7 → Send to Lead Coder.**

## Completion Summary

Implemented card settle latency optimization by confirming column moves before agent dispatch rather than after. Updated `KanbanProvider.ts` (`triggerAction`, `triggerBatchAction`, and `promptOnDrop`) to persist column moves and post targeted `moveCards` / `moveCardsFailed` deltas immediately. In `kanban.html`, added a `recentlyDropped` map animation fence to carry `.card-dropped` across full re-renders, and removed the obsolete 350ms `setTimeout` delays on drag dispatch paths. No issues encountered during implementation.
