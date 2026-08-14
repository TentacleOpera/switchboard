# Terminals kanban pane: the per-row `link` button is inert — make it copy the plan's absolute path

## Goal

Make the `link` button on every row of the kanban-mode pane in `terminals.html` produce a visible, useful result in all three hosts (VS Code webview, browser cockpit, standalone `npx`): copy the plan's **absolute file path** to the clipboard with a transient `Copied!` confirmation, matching the "Copy Link" / "Link all" vocabulary already established in the Project panel.

### The problem

The kanban-mode pane (a live board column rendered inside an empty terminal grid slot) gives each plan row three buttons: `link`, `view`, `Copy Prompt` (`src/webview/terminals.js:5345-5437`). `view` and `Copy Prompt` work. `link` does nothing the operator can perceive — no panel opens, no clipboard write, no feedback, no error.

This is a direct instance of **PRD contract #6 — "Capability-gating honesty — no dead buttons"**: *"A panel or verb with no headless route/wiring is absent or disabled, never a control that dead-clicks and never a stub that fakes success."* The `link` button dead-clicks in all three hosts, and in standalone the verb behind it returns `{success: true}` while doing nothing — the exact "stub that fakes success" the contract forbids. The PRD's own prescribed remedy for editor-bound actions is the one adopted here: *"Terminal/editor-bound actions degrade gracefully (copy-to-clipboard, capability-gated buttons), never dead-click."*

### Root cause — a five-link chain, each link independently broken

`link` posts `POST /kanban/verb/selectPlan` and swallows the response (`src/webview/terminals.js:5349-5362`):

```js
linkBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
        await fetch('/kanban/verb/selectPlan', { ... });
    } catch { /* ignore */ }
});
```

1. **The verb is a dropdown-sync side effect, not a navigation action.** `selectPlan` resolves an id (`KanbanProvider.ts:7918`, delegating to `kanbanService.selectPlan`, `kanbanService.ts:70-76`) and calls `TaskViewerProvider.selectSession()` (`TaskViewerProvider.ts:4061-4063`), which only posts `{type:'selectSession'}` to the sidebar webview. Its sole consumer sets a `<select>` value (`implementation.html:2351-2356`):
   ```js
   case 'selectSession':
       if (message.sessionId && runSheetSelect) {
           runSheetSelect.value = message.sessionId;
           updatePlanActionStates();
       }
   ```
   On the board this is correct — it is fired as a *side effect* of clicking a card (`kanban.html:7355`, inside the card-click handler guarded by `if (!pid) return;` at `:7317`), never as a primary action. Promoted to a standalone button it has no visible effect.

2. **Nothing reveals the target surface.** There is no `view.show()`, no `revealSidebar`, no `__switchboardSwitchPanel` call. The terminals grid is an editor-tab panel — frequently maximised or in a second window — so the sidebar the message lands in is usually not even on screen. Compare `view` (`terminals.js:5407-5408`), which explicitly switches the shell to the Project panel.

3. **The title is factually wrong.** `linkBtn.title = 'Open this plan in the planning panel'` (`terminals.js:5348`). `planning.html`/`planning.js` have **no** `selectSession` handler — grep for `selectSession` across `src/webview/` returns exactly one hit, `implementation.html:2351`. The verb targets the *sidebar TaskViewer*, and the Kanban reading surface moved to `project.html` years ago. "Planning panel" is stale vocabulary describing a surface that never receives this message.

4. **Even the sidebar sync silently misses.** `runSheetSelect.value = X` is a no-op when `X` is not an existing `<option>` value, and the options are built from a *differently scoped* set (`implementation.html:2553-2673`): filtered by the sidebar's own resolved workspace root, `getProjectFilter()`, `repoScope`, column visibility, and the active/completed bucket — then further filtered to features and non-subtasks. The pane, by contrast, carries a **per-pane** workspace and project (`kanbanPaneWorkspace[index]`, `kanbanPaneProject[index]`) and `selectPlan`'s schema accepts only `planId` and `sessionId` (`verbSchemas.ts:316-321`) — the `workspaceRoot` the button sends at `terminals.js:5358` is dropped at the boundary, and the service signature (`selectPlan(payload: { planId?, sessionId? })`, `kanbanService.ts:70`) confirms it never had anywhere to go. A miss is worse than a no-op: assigning an unmatched value blanks the `<select>`, clearing whatever the operator had selected.

   > **Note — this same failure mode recurs one function over.** `terminals.js:5133` does `if (chosen && picker.value !== chosen) { picker.value = chosen; }` on the pane's own column picker. See **Dependencies & Conflicts #17**: the sibling subtask in this feature can make that assignment miss, which is why the two subtasks are ordered.

5. **Dead in two of the three hosts.** `reviewPlan` (the `view` button) has a `__viaHttp` branch that pushes the selection to the browser cockpit over WS (`KanbanProvider.ts:9291-9310`) and a dedicated standalone arm (`bootstrap.ts:1033`). `selectPlan` has **neither**. In standalone it falls into the `default:` arm, is classified read-only by the `'select'` prefix (`bootstrap.ts:1100`) so it does not even trigger a state push, and reaches a `selectSession` that has no implementation in `src/standalone/` at all. In the browser cockpit there is no sidebar surface to receive it. In both cases it returns `{success: true}` while doing nothing.

**Not a cause: ID mismatch.** Option values (`sheet.sessionId`, `implementation.html:2654`) do match what the pane sends for every card the pane can actually render. Ruled out by query, not assumed.

> **Superseded:** "`plans.session_id` equals `plan_id` for all 2272 rows in this workspace's `kanban.db`, with zero nulls."
> **Reason:** Re-verified against the live DB and the stated evidence is wrong. The table now holds **2276** rows, of which **2112** have `session_id = plan_id` and **164 do not** — every one of those 164 is an `antigravity_<planId>`-prefixed id, and every one sits in `COMPLETED`. "Zero nulls" is correct. The *conclusion* survives (the pane renders active-column cards, whose ids do match), but the absolute "all rows" claim would have misled anyone re-checking it.
> **Replaced with:** `session_id` is non-null for all 2276 rows and equals `plan_id` for 2112 of them. The 164 exceptions are `antigravity_`-prefixed ids confined to `COMPLETED`, a column the kanban pane does not render, so no id the pane can send is affected. Confirmed by query:
> `SELECT COUNT(*), SUM(session_id = plan_id), SUM(session_id IS NULL OR session_id = '') FROM plans;` → `2276|2112|0`.

### The decision: `link` becomes a clipboard copy of the absolute plan path

`link` already means exactly this everywhere else in Switchboard — Project panel per-row `Copy Link` (`project.js:1655, 1676`), Project panel `Link all` ("Copy all filtered plan links to clipboard", `project.js:1561-1577`), Project panel insight `Copy Link` (`project.js:1095, 1322`), Planning panel (`planning.js:5675`), Tickets `Link all`. All of them write a path to the clipboard via `toAgentRef`, whose own comment states the intent: *"the @ prefix was removed because users want clean absolute paths on clipboard copy"* (`sharedUtils.js:1-10`).

This is also the only fix that works in every host: it is pure client-side, needs no verb, no WS push, no standalone arm, and no host focus. And it is the affordance the panel actually wants — the pane sits beside a grid of agent terminals, so a path on the clipboard is one paste from being actionable, complementing the existing drag-to-terminal dispatch (full prompt) and `Copy Prompt` (full prompt + column advance).

**Rejected alternative — make `link` reveal the sidebar and select there.** (a) Impossible in the browser cockpit and standalone, where no sidebar surface exists. (b) Revealing the VS Code sidebar for a click that happened in a detached window or a browser tab steals focus into VS Code — the precise bug the `reviewPlan` `__viaHttp` branch was written to prevent (`KanbanProvider.ts:9291-9310`). (c) Redundant: `view` already opens the plan on its real reading surface, so a working "select it somewhere else" button would be a second, weaker route to the same place.

**Rejected alternative — reuse the existing `copyPlanLink` verb. ⚠️ This is a trap; do not take it.** `copyPlanLink` is in `KANBAN_VERBS` (`generated/verbAllowlist.ts`), has a schema (`verbSchemas.ts:1509`), and its name reads as an exact match for this task. It is a **misnomer**. `KanbanProvider.ts:10441` → `switchboard.copyPlanFromKanban` (`extension.ts:1711`) → `TaskViewerProvider.handleKanbanCopyPlan` (`:17659`) → `_handleCopyPlanLink` (`TaskViewerProvider.ts:17662`), which: resolves a role from the card's column, calls `buildDispatchPlans` + `generateUnifiedPrompt`, writes a **full dispatch prompt** to the clipboard, and then **auto-advances the card to the next column** via `_applyManualKanbanColumnChange` with integration sync and dispatch-identity recording. Wiring `link` to it would duplicate the adjacent `Copy Prompt` button *and* silently move the operator's card — a destructive side effect from a button labelled "link". It is also VS Code-bound (`executeCommand`), so it would stay dead in the browser cockpit and standalone, failing the very PRD contract this plan exists to satisfy.

**Rejected alternative — `openPlanByPath`.** It exists (`KanbanProvider.ts:7927`, `kanbanService.openPlanByPath`) and opens the plan file in an editor. Two disqualifiers: it resolves against `this._currentWorkspaceRoot` (the *board's* active workspace) and enforces a `startsWith(workspaceRoot)` traversal check, so a pane pointed at a different workspace gets "Path traversal denied"; and "open in an editor" has no meaning in the browser cockpit. It is also, again, a second route to what `view` already does.

The `selectPlan` verb itself stays — `kanban.html:7355` is a legitimate consumer and is out of scope.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard
- **Feature:** 6b06d0de-d630-4f6a-af61-3fb213772c15

## User Review Required

- None.

## Complexity Audit

### Routine

- Replacing one button's click handler with a clipboard write. The clipboard pattern is already proven in this exact function — `copyBtn` calls `navigator.clipboard.writeText` with a `Copied!` / `Copy failed` label swap on a 2s timer (`terminals.js:5433-5452`), and is pinned by `src/test/paste-attribution-contract.test.js:43-50`.
- Correcting a `title` string.
- Two declarative CSS properties on an existing shared selector (`terminals.html:1594-1606`).
- No backend, schema, verb-allowlist, DB, or migration change. No persisted state. No new verb round-trip — the change removes one.

### Complex / Risky

- **Absolute-path construction in a webview.** No `path` module and no `sharedUtils.js` — `terminals.html:2054-2058` loads only the three xterm bundles plus `terminals.js`, so `toAgentRef` is genuinely unavailable here (verified, not assumed). A ~6-line local join is required, and it must not double a separator or clobber an already-absolute `planFile`.
- **Choosing the workspace root.** Must reuse the pane's established fallback `card.workspaceRoot || kanbanPaneWorkspace[index]` (the same expression at `terminals.js:5233, 5358, 5386, 5428`), because a pane can point at a workspace other than the board's active one.
- **The transient label must not toggle `disabled`.** See the superseded callout under Proposed Change 2 — a disabled button suppresses the capture-phase `pointerdown` that disarms row-drag (`terminals.js:731-737`), which would leave the row draggable while the button is dimmed. The repo already treats this as established: `src/test/kanban-card-button-drag-guard.test.js:66-80` pins the board's equivalent button against ever setting `disabled`, with the comment *"The disabled attribute blocks pointerdown, which is the Stage 2 activation path."*
- **Test-harness placement.** `src/test/browser-kanban-pane-order.test.js` is a hand-rolled harness, not `node:test`. Appending tests after its trailing summary block (line 177) makes them run *after* the pass/fail tally is printed and after `process.exit(1)` can fire — i.e. a broken assertion would never turn CI red. See Proposed Change 4.

## Edge-Case & Dependency Audit

### Race Conditions

1. **The 5s poll vs. the transient label.** `renderKanbanPane` (`terminals.js:4946`) is signature-gated on `bodySig` (`terminals.js:5155-5158`), and that guard exists precisely because an unconditional rebuild *"wiped the 'Copied!' state off a button mid-timeout"*. `planFile` is not part of `bodySig`, so a poll tick that changes nothing else will not wipe the new label.

   > **Superseded:** "the transient `Copied!` label is not wiped by the 5s poll … the new label inherits the same protection for free."
   > **Reason:** Overstated as an absolute. `bodySig` (`terminals.js:5155-5156`) *does* include `c.working` and `c.column`, so if an agent starts working on any listed card, or any card changes column, within the 2s window, `contentEl` is wiped and every row rebuilt — the label goes with it. The claim is true for the steady state, not unconditionally.
   > **Replaced with:** The label survives an idle poll tick (the common case) because `bodySig` excludes `planFile`. It is **best-effort**, not guaranteed: a concurrent `working`/`column` change on any card in the pane re-renders the list and drops the label. This is acceptable and already the status quo for `Copy Prompt`, which *guarantees* the wipe by advancing the card and calling `fetchBoardCardsForPane` itself. No fix is needed; the orphaned `setTimeout` closure then re-labels a detached element, which is harmless.

2. **Rapid re-clicks on the same button.** Two clicks inside 2s stack two restore timers; the first fires mid-window and restores `link` while the second is still pending. Hold the timer handle in the row's closure and `clearTimeout` before re-arming — the pattern `implementation.html:1685-1687` already uses for its own copy-link button.

### Security

3. **Clipboard permission / insecure context.** `navigator.clipboard.writeText` requires a secure context and transient user activation. All three hosts satisfy this: the VS Code webview is secure; the browser cockpit is served from `http://localhost`, which is a secure context by definition; and the cockpit shell explicitly grants the permission to every panel iframe — `shell.js:383`, `frame.setAttribute('allow', 'clipboard-read; clipboard-write')`. The write happens inside a `click` handler, so activation is satisfied. A `catch` → `Failed` label covers the residual case.
4. **No new attack surface.** The change *removes* an HTTP call and adds no input parsing. `absolutePlanPath` only concatenates two values that already originate from the extension's own DB response; nothing is interpolated into HTML (`textContent` only), and no path is dereferenced client-side.

### Side Effects

5. **Card has no `planFile`.** Near-unreachable by two independent filters: `_filterGhostPlans` drops active rows with a missing/empty plan file (`KanbanProvider.ts:1844`) and the completed set is filtered on `!!row.planFile` (`KanbanProvider.ts:1898`). The live DB does contain exactly one row with an empty `plan_file`, and both filters exclude it — confirming the guard is defensive, not load-bearing. The handler must still degrade to a `No file` label rather than copying the string `"undefined"`.
6. **Row click-through and drag.** The row has its own click handler for multi-select (`terminals.js:5257`) and is `draggable`. `e.stopPropagation()` must be kept, and the existing guard `if (e.target.closest('button')) { return; }` (`terminals.js:5261`) is pinned by `browser-kanban-pane-order.test.js` ("row click handler guards buttons and does not select plans") — do not touch it. The `pointerdown` drag-disarm (`terminals.js:731-737`) must keep working, which is why the handler does not toggle `disabled`.
7. **Layout jitter is a misclick hazard, not a cosmetic one.** `link` (4 chars) → `Copied!` / `No file` (7 chars) widens the button inside a flex `.kanban-pane-row-actions`, shoving `view` and `Copy Prompt` sideways for 2s. `Copy Prompt` **advances the card**, so a shifted target is a destructive misclick — and `CLAUDE.md` states buttons here are *"deliberately hard to misclick"*. Reserve the width up front (Proposed Change 3).
8. **No column movement, ever.** Unlike `Copy Prompt` (`promptSelected`) and the rejected `copyPlanLink`, this button must not move the card, must not call `fetchBoardCardsForPane`, and must not clear the pane selection.

### Dependencies & Conflicts

9. **Relative vs absolute `planFile`.** Every row in the live DB stores a workspace-relative path (`.switchboard/plans/…`; `SUM(plan_file LIKE '/%')` = 0 across 2276 rows), and `_getKanbanPlans` passes `r.planFile` through unchanged (`PlanningPanelProvider.ts`), as does `_buildBoardCards` (`KanbanProvider.ts:1917`). The join must therefore run, while still short-circuiting if a future row ever stores an absolute path.
10. **`getBoardCards` really does carry `planFile`.** Verified end to end: `_buildBoardCards` (`KanbanProvider.ts:1886`) emits `planFile: row.planFile || ''` at `:1917`, with the parallel card builders at `:3562` and `:3787` doing the same; the `getBoardCards` arm returns those cards verbatim (`KanbanProvider.ts:11333-11356`, `return { success: true, cards: filtered, projects }`); and the pane stores the response in `kanbanPaneCards[index]` (`terminals.js:5600`). The adjacent `view` button already reads `card.planFile` (`terminals.js:5385`). Without this the whole approach would copy nothing, so it was confirmed rather than assumed.
11. **Windows drive letters.** The absolute test must accept `C:\…` and `\\server\…` as well as `/…`, and the join must use the separator already present in the root rather than hardcoding `/`.
12. **Cross-workspace panes.** The pane is explicitly multi-workspace (per-pane `kanbanPaneWorkspace`). Copying a bare relative path would be actively wrong when pasted into an agent whose cwd is a different repo — this is the reason to emit absolute here even though `project.js:1676` emits relative via `toAgentRef`. Not fixing `project.js` is deliberate: it is a single-workspace surface and out of scope.
13. **`selectPlan` must survive.** `kanban.html:7355` still posts it as a card-selection side effect, and `browser-kanban-pane-order.test.js` asserts the *row click handler* does not post `selectPlan`. Removing the button's call does not violate that test (it strengthens the invariant), but the verb, its schema (`verbSchemas.ts:316-321`), its allowlist entry (`generated/verbAllowlist.ts`), and its service method (`kanbanService.ts:70-76`) all stay untouched.
14. **Aggregate mode.** In the synthetic `AGGREGATE_CODED_ID` view rows come from several columns, but `planFile` and `workspaceRoot` are per-card, so nothing column-specific is involved.
15. **Solo popout.** The pane grid does not exist in a solo popout (`terminals.js:139-140, 704-709`), so the button is unreachable there — no new surface to consider.
16. **Build artifacts.** `dist/` is not used during development or testing per `CLAUDE.md`; `src/` is the source of truth and the installed VSIX is the test vehicle.
17. **Shared file with the sibling subtask — this is the feature's one ordering constraint.** The sibling plan *"Making an Agent Visible Also Forces a Kanban Column"* changes `TaskViewerProvider._filterVisibleColumns`, which is what `handleGetKanbanStructure` (`TaskViewerProvider.ts:6301-6311`) filters through. That structure is exactly what this pane's column picker is built from: `terminals.js:5541` sets `kanbanColumnsCache = buildColumnList(structData.structure, …)` from `POST /kanban/verb/getKanbanStructure` (`terminals.js:5536`). So the sibling can remove a column this pane is persisted on, and `terminals.js:5133`'s `picker.value = chosen` then misses — the same blank-select failure documented as root cause #4 above, one function over. **The fix for that belongs to the sibling plan** (it introduces the trigger, and it owns the change that causes it); this plan must not pre-empt it. What matters here is the file collision: per the PRD's *"one agent stream per provider file"*, `src/webview/terminals.js` must not be edited by both subtasks concurrently. **This plan lands first** — it is the smaller, self-contained edit, and it does not depend on anything the sibling produces.

## Dependencies

- None. (Ordering only — see Dependencies & Conflicts #17. This plan is not blocked by its sibling; the sibling should land after it.)

## Adversarial Synthesis

**Risk Summary.** The functional risk is low and fully client-side — one handler swap onto a clipboard pattern already proven three buttons away, with the card payload's `planFile` field verified present end to end. The real risks are second-order and all mitigated in this plan: a transiently `disabled` button would silently re-arm row-drag by suppressing the capture-phase `pointerdown` disarm (so the handler never touches `disabled`); a 2s label-widening would shove the destructive `Copy Prompt` button under the operator's cursor (so the width is reserved); and the plan's own pinning test would have been dead-on-arrival twice over — appended past the harness's `process.exit` summary, and asserting `!includes('selectPlan')` against a handler whose explanatory comment names `selectPlan` (both corrected below). The one trap left for the implementer is the existing `copyPlanLink` verb, which despite its name copies a full dispatch prompt and auto-advances the card; it is explicitly rejected above. The one coordination risk is that `src/webview/terminals.js` is also the landing site for the sibling subtask's fallout — hence the ordering in Dependencies & Conflicts #17.

## Proposed Changes

> **Line numbers in this section were re-anchored against `src/` at planning time.** An earlier pass cited a shape of `terminals.js` roughly 680 lines shorter; every reference below was re-verified. Anchor on the **quoted code**, not the number, if the file has moved again.

### 1. `src/webview/terminals.js` — add a path helper near `renderKanbanPane`

**Context.** No `path` module in a webview, and `terminals.html:2054-2058` loads only the three xterm addon bundles plus `terminals.js` — `sharedUtils.js` (and therefore `toAgentRef`) is not in scope on this surface. `terminals.js` is a single `(function() { 'use strict'; … })()` IIFE, so a module-level helper at four-space indentation matches the file's existing shape and needs no export.

**Logic.** Pass through anything already absolute; otherwise strip a trailing separator from the root, strip leading separators from the file, and join with whichever separator the root itself uses.

**Implementation.** Add above `function renderKanbanPane(paneEl, index) {` (currently line 4946):

```js
    /** Join a workspace root and a (usually relative) plan file into an absolute
     *  path for clipboard copy. No `path` module in a webview, and terminals.html
     *  loads only terminals.js — sharedUtils.js (toAgentRef) is not available here.
     *  Absolute inputs pass through: POSIX `/…` and Windows `C:\…` / `\\server\…`. */
    function absolutePlanPath(root, planFile) {
        const file = String(planFile || '').trim();
        if (!file) { return ''; }
        if (/^(\/|\\\\|[A-Za-z]:[\\/])/.test(file)) { return file; }
        const base = String(root || '').trim();
        if (!base) { return file; }
        const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
        return base.replace(/[\\/]+$/, '') + sep + file.replace(/^[\\/]+/, '');
    }
```

**Edge Cases.** Empty `planFile` → `''`, which the caller turns into a `No file` label. Empty root → the relative path, which is still better than `undefined`. A root of `C:\repo` with a file of `.switchboard\plans\x.md` joins on `\`; a mixed root containing both separators (a POSIX path with an escaped segment) falls to `/`, which is correct for POSIX.

### 2. `src/webview/terminals.js` — replace the `link` handler (lines 5345-5363)

**Context.** The current handler posts a verb that cannot produce a visible result in any host (see root cause). Everything it needs is already on the card. The block runs from `const linkBtn = document.createElement('button');` (5345) through `btnGroup.appendChild(linkBtn);` (5363), immediately after `const btnGroup = document.createElement('div');` (5342) and immediately before `const viewBtn = document.createElement('button');` (5365).

**Logic.** Resolve the absolute path from the per-pane workspace fallback, write it to the clipboard, and swap the label for 2s. No verb, no fetch, no column movement, no `disabled`.

> **Superseded:** the handler toggled `linkBtn.disabled = true` for the duration of the transient label (and Proposed Change 3 added a `:disabled` dimming rule to match `view`).
> **Reason:** Two problems. (a) It buys nothing — unlike `view` (an awaited fetch) and `Copy Prompt` (an awaited fetch plus a column advance), a clipboard write is synchronous-ish and idempotent, so there is no in-flight state to protect and a double-click is harmless. (b) It is actively harmful: the drag-disarm at `terminals.js:731-737` is a capture-phase `pointerdown` listener that sets `row.draggable = false` when a button is pressed, and a disabled control does not dispatch pointer events — so for the 2s the button is dimmed, pressing it would fail to disarm the row and a press-drag could start dragging the card toward a terminal pane, i.e. an accidental dispatch. The repo already holds this rule as settled for the board's equivalent button: `src/test/kanban-card-button-drag-guard.test.js:66-80` asserts the copy handler *"must NOT toggle btn.disabled at all"* because *"the disabled attribute blocks pointerdown."*
> **Replaced with:** never touch `disabled`; guard repeat clicks with a per-row `clearTimeout` handle instead (the `implementation.html:1685-1687` pattern). This also deletes the `:disabled` CSS rule from Proposed Change 3, shrinking the diff.

**Implementation.** Replace the whole block with:

```js
            const linkBtn = document.createElement('button');
            linkBtn.className = 'kanban-pane-link-btn';
            linkBtn.textContent = 'link';
            linkBtn.title = 'Copy this plan\u2019s file path to the clipboard';
            // Per-row timer handle: a second click inside the 2s window must not let
            // the first click's timer restore the label early (implementation.html:1685).
            let linkResetTimer = null;
            linkBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                // Clipboard, not a verb. The previous implementation posted
                // /kanban/verb/selectPlan, which only sets the SIDEBAR run-sheet
                // dropdown's value (kanbanService.selectPlan → TaskViewerProvider
                // .selectSession → implementation.html:2351). Nothing revealed that
                // sidebar, the dropdown is scoped to its own workspace/project/column
                // filters so the assignment usually missed anyway, and the verb has no
                // __viaHttp or standalone arm — so the button was inert in every host.
                // `view` already covers "open this plan"; `link` now means what it means
                // everywhere else in Switchboard (project.js:1676, planning.js:5675).
                //
                // Do NOT reuse the `copyPlanLink` verb despite its name: it copies a full
                // dispatch prompt AND auto-advances the card (TaskViewerProvider.ts:17662).
                // Do NOT set linkBtn.disabled: a disabled button suppresses the
                // capture-phase pointerdown that disarms row-drag (terminals.js:732), so
                // the row would stay draggable while the label is swapped.
                const abs = absolutePlanPath(
                    card.workspaceRoot || kanbanPaneWorkspace[index],
                    card.planFile
                );
                if (abs) {
                    try {
                        await navigator.clipboard.writeText(abs);
                        linkBtn.textContent = 'Copied!';
                    } catch {
                        linkBtn.textContent = 'Failed';
                    }
                } else {
                    linkBtn.textContent = 'No file';
                }
                if (linkResetTimer) { clearTimeout(linkResetTimer); }
                linkResetTimer = setTimeout(() => {
                    linkResetTimer = null;
                    linkBtn.textContent = 'link';
                }, 2000);
            });
            btnGroup.appendChild(linkBtn);
```

**Edge Cases.** No `planFile` → `No file`, nothing written. Clipboard rejection → `Failed`. A re-render inside the 2s window discards the button and the pending timer re-labels a detached node (harmless). Net effect: one fewer HTTP round trip per click; no backend surface touched.

### 3. `src/webview/terminals.html` — reserve the button width (shared rule, lines 1594-1606)

**Context.** `.kanban-pane-link-btn` and `.kanban-pane-view-btn` share one base rule (1594-1606) and one `:hover` rule (1607-1608). Both now swap in longer transient labels (`Copied!` / `No file` / `Failed`) inside a flex action group that also holds the card-advancing `Copy Prompt` (whose own rules are the separate `.kanban-pane-copy-btn` block above, ending at 1593 — do not touch it).

**Logic.** Reserve the widest label's width on the shared base rule so no sibling button moves during the swap. `7ch` covers `Copied!` and `No file` (7 characters each) and `Failed` (6).

**Implementation.** Add two properties to the existing `.kanban-pane-link-btn, .kanban-pane-view-btn` base declaration — do not add a new selector:

```css
        .kanban-pane-link-btn,
        .kanban-pane-view-btn {
            /* …existing properties unchanged… */
            min-width: 7ch;
            text-align: center;
        }
```

**Edge Cases.** `min-width` only grows the resting `link` / `view` buttons slightly; it cannot shrink them below their padded content. `ch` is font-relative, so it tracks the panel's `font-family: inherit` rather than hardcoding a pixel width. The pre-existing `.kanban-pane-view-btn:disabled` rule at line 1609 stays exactly as it is — `view` still toggles `disabled` around its fetch, and that behaviour is out of scope here.

### 4. `src/test/browser-kanban-pane-order.test.js` — pin the fix

**Context.** This file is **not** a `node:test` file. It is 178 lines. It defines its own `test()` wrapper with `passed`/`failed` counters (lines 11-15), reads `terminalsSrc` at line 17, and ends with a summary plus a conditional `process.exit(1)` at lines 176-177:

```js
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
```

> **Superseded:** "Append source-shape assertions alongside the existing kanban-pane tests."
> **Reason:** Taken literally — appended at end of file — the new tests would run *after* the summary is printed and after `process.exit(1)` can fire on an earlier failure. Their own failures would print below the tally and never affect the exit code, so a broken assertion would report green in CI. The plan's pinning test would have been decorative.
> **Replaced with:** Insert the new tests **immediately before** the `console.log(\`\n${passed} passed, ${failed} failed\`)` line (currently line 176), so they are counted by the harness they rely on.

> **Superseded:** `assert.ok(!block.includes('selectPlan'), …)`
> **Reason:** Self-contradictory with Proposed Change 2, whose explanatory comment necessarily names `/kanban/verb/selectPlan` — that is the documentation value of the comment. A bare substring check would fail against the exact code this plan instructs the coder to write, and the natural "fix" is to delete the comment, losing the rationale. The assertion must target the *call*, not the token.
> **Replaced with:** a regex on the `fetch` invocation, which is comment-immune and states the real invariant.

**Implementation.** Insert before the summary block:

```js
test('kanban pane link button copies a path and does not post selectPlan', () => {
    const start = terminalsSrc.indexOf("linkBtn.className = 'kanban-pane-link-btn'");
    assert.ok(start > -1, 'link button must exist');
    const end = terminalsSrc.indexOf("viewBtn.className = 'kanban-pane-view-btn'", start);
    assert.ok(end > start, 'link button block must end before the view button');
    const block = terminalsSrc.slice(start, end);
    // Regex on the CALL, not the token: the handler's comment names the verb on
    // purpose (it documents why the button no longer posts it).
    assert.ok(!/fetch\(\s*['"]\/kanban\/verb\/selectPlan/.test(block),
        'link must not POST selectPlan — the verb only sets the sidebar dropdown value, ' +
        'has no __viaHttp or standalone arm, and nothing reveals that sidebar');
    assert.ok(!/fetch\(\s*['"]\/kanban\/verb\/copyPlanLink/.test(block),
        'link must not POST copyPlanLink — that verb copies a full dispatch prompt and ' +
        'auto-advances the card (TaskViewerProvider._handleCopyPlanLink)');
    assert.ok(block.includes('navigator.clipboard.writeText'),
        'link must write the plan path to the clipboard');
    assert.ok(block.includes('absolutePlanPath'),
        'link must resolve an absolute path — plan_file is stored workspace-relative');
    assert.ok(block.includes('card.workspaceRoot || kanbanPaneWorkspace[index]'),
        'link must use the per-pane workspace fallback — a pane can point at another workspace');
    assert.ok(!/linkBtn\.disabled/.test(block),
        'link must never toggle disabled — a disabled button suppresses the capture-phase ' +
        'pointerdown that disarms row-drag (terminals.js:732), re-arming accidental dispatch');
});

test('absolutePlanPath passes absolute inputs through and joins relative ones', () => {
    assert.match(terminalsSrc, /function\s+absolutePlanPath\s*\(\s*root\s*,\s*planFile\s*\)/,
        'absolutePlanPath helper must exist in terminals.js');
    const start = terminalsSrc.indexOf('function absolutePlanPath');
    const block = terminalsSrc.slice(start, start + 700);
    assert.ok(/\[A-Za-z\]:/.test(block), 'absolute test must accept Windows drive letters');
});
```

**Edge Cases.** Both tests are source-shape assertions over `terminalsSrc`, which the file already reads at line 17 — no new harness, no DOM, no imports. Note that the existing `row click handler guards buttons and does not select plans` test slices from `row.addEventListener('click', (e) => {` to `const rowText = document.createElement`, a region that *ends before* the link button — so the new handler's `selectPlan`-naming comment cannot leak into that older assertion.

## Verification Plan

> **Session directive:** the dispatching prompt for this plan carries **SKIP COMPILATION** and **SKIP TESTS** — the implementing agent authors the tests in Proposed Change 4 but does **not** execute the suite or run a TypeScript build. The commands below are recorded for the user and CI; the implementer's own gate is the manual UAT.

### Automated Tests

1. `node src/test/browser-kanban-pane-order.test.js` — the two new tests pass, and the pre-existing ones (`bodySig` composition, `row click handler … does not post selectPlan`, drag payload) stay green. **Invoke with plain `node`, not `node --test`:** the file is a hand-rolled harness whose results are reported by its own `console.log` tally and `process.exit(1)`, so `node --test` would collapse it to a single opaque pass/fail and hide which assertion broke.
2. `node src/test/paste-attribution-contract.test.js` — the `Copy Prompt` clipboard contract is untouched.
3. `node src/test/kanban-card-button-drag-guard.test.js` — the board-surface drag guard is unaffected (this plan does not touch `kanban.html`), and it is the file that documents the never-disable rule this change now also honours.
4. Confirm no backend surface moved: `git diff --name-only` lists only `src/webview/terminals.js`, `src/webview/terminals.html`, and `src/test/browser-kanban-pane-order.test.js`. `verbSchemas.ts`, `kanbanService.ts`, `generated/verbAllowlist.ts`, `KanbanProvider.ts`, `TaskViewerProvider.ts`, and `bootstrap.ts` must be unchanged. No TS file is edited, so the ratchet/parity/push-routing gates in the PRD cannot move.

### Manual — VS Code (installed VSIX, not `dist/`)

5. Open the Terminals panel, set a 2×2 layout, toggle one pane to kanban mode (KANBAN button), pick a column with plans.
6. Click `link` on a row → the label flips to `Copied!` for ~2s and returns to `link`. Paste into a terminal: an **absolute** path ending in the plan's filename, matching the row's title.
7. Repeat with the pane's workspace picker set to a *different* workspace than the board's active one → the pasted path is rooted in that other workspace, not the active one.
8. Click `link` twice in quick succession on the same row → the label stays `Copied!` for a full 2s after the *second* click (the timer is re-armed, not raced).
9. Click `link` across two rows in quick succession → each button shows its own transient label independently.
10. **Drag-disarm regression (the reason `disabled` was dropped):** click `link`, then immediately press-and-hold that same `link` button and drag toward a terminal pane → **no drag starts and no dispatch occurs**. Repeat while the label still reads `Copied!`.
11. **No layout shift:** watch `view` and `Copy Prompt` while the label swaps to `Copied!` → neither moves horizontally.
12. Confirm the row's multi-select is unaffected: clicking `link` must not toggle the row's `selected` class; clicking the row body still does.
13. Confirm the card **does not move column** and the pane list does not refetch when `link` is clicked.
14. Confirm `view` and `Copy Prompt` are unchanged — `view` opens the plan in the Project panel; `Copy Prompt` copies the prompt and advances the card.
15. Hover `link` → tooltip reads "Copy this plan's file path to the clipboard"; the old "planning panel" wording is gone.
16. Regression check on the surface the old verb served: click a card on the Kanban board (`kanban.html`) → the sidebar run-sheet dropdown still syncs to it. `selectPlan` must still work from the board.

### Manual — browser cockpit

17. Open the cockpit in a browser tab, go to the Terminals panel, put a pane in kanban mode, click `link` → `Copied!` appears and the clipboard holds the absolute path. (This is the case that previously could not work at all: no sidebar surface, no `__viaHttp` branch. The shell grants the panel iframe `clipboard-write` at `shell.js:383`.)
18. Confirm VS Code does **not** take focus when `link` is clicked from the browser tab.

### Manual — standalone

19. Run the standalone host (`npx`), open `/terminals`, put a pane in kanban mode, click `link` → `Copied!` and a correct absolute path. Previously `selectPlan` reached the `default:` arm in `bootstrap.ts`, was prefix-classified read-only (`bootstrap.ts:1100`), and resolved to a `selectSession` with no implementation in `src/standalone/`.

### Negative

20. Temporarily blank a card's `planFile` in the response (dev-tools override) → the button shows `No file` for 2s and writes nothing to the clipboard; the string `undefined` never reaches it.

## Resolved Assumptions

Recorded so no one re-opens them. All were live uncertainties during a planning pass and all were settled **from the repo**, not from external research.

- **Does the pane's card payload actually carry `planFile`?** Yes. `_buildBoardCards` (`KanbanProvider.ts:1886`) emits it at `:1917`, the `getBoardCards` arm returns those cards verbatim (`:11333-11356`), and the pane stores the response in `kanbanPaneCards[index]` (`terminals.js:5600`). The whole approach depends on this, so it was confirmed by reading the pipeline rather than inferred from the adjacent `view` button.
- **Is `navigator.clipboard.writeText` available in the browser cockpit's panel iframe?** Yes. `http://localhost` is a secure context, the write occurs inside a `click` handler (transient activation satisfied), and the cockpit shell grants the permission explicitly: `shell.js:383` sets `allow="clipboard-read; clipboard-write"` on every panel frame. No fallback path (`document.execCommand('copy')`) exists anywhere in `src/`, and none is needed.
- **Does a `disabled` button suppress the capture-phase `pointerdown` that disarms row-drag?** Treated as established in-repo: `src/test/kanban-card-button-drag-guard.test.js:66-80` pins the board's copy button against toggling `disabled` at all, on the stated grounds that *"the disabled attribute blocks pointerdown."* This plan does not depend on the precise cross-engine semantics because it simply never sets `disabled`.
- **Is `toAgentRef` reachable from `terminals.html`?** No. `terminals.html:2054-2058` loads only the three xterm addon bundles plus `terminals.js`; `sharedUtils.js` is not among them. Confirmed by reading the script tags, which is why Proposed Change 1 exists at all.
- **Does the pane's column picker come from the same structure the sibling subtask filters?** Yes — `terminals.js:5536-5541` fetches `/kanban/verb/getKanbanStructure` and feeds it to `buildColumnList`, and that verb resolves to `TaskViewerProvider.handleGetKanbanStructure` → `_buildSetupKanbanStructure` → `_filterVisibleColumns`. This is the basis for the ordering note in Dependencies & Conflicts #17 and was traced end to end rather than assumed from the two plans' file lists.

---

**Recommendation: Send to Intern.** Complexity 3 — three localised files, no backend or schema surface, and every pattern it uses (clipboard write + label swap, per-pane workspace fallback, source-shape pinning tests) already exists within a few lines of the change. The three things an implementer could plausibly get wrong are all called out explicitly above: do not reuse the `copyPlanLink` verb, do not toggle `disabled`, and do not trust the line numbers over the quoted code.
