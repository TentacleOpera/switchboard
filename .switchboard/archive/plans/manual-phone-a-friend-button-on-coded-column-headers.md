# Manual Phone-a-Friend Button on Coded Column Headers

## Goal

Add a button to the Autocode and individual coding column headers on the Kanban board that manually dispatches the Phone-a-Friend second-pass review prompt to the Phone-a-Friend terminal for selected plans — without advancing the cards to the next column.

### Problem & Background

The Phone-a-Friend second-pass review is currently triggered automatically: when a coder finishes a batch, it curls `POST /phone-a-friend` with the plan file path, which fires `_dispatchPhoneAFriend` in `TaskViewerProvider.ts`. That method resolves the Phone-a-Friend terminal, sends `/clear`, then a per-plan "assume hidden bugs, check and fix" prompt. When the automatic trigger mechanism is broken (or the user wants to re-run a second pass on plans that were already coded), there is no manual way to fire the same dispatch from the board UI.

### Root Cause

The Phone-a-Friend dispatch is only reachable via the HTTP callback (`POST /phone-a-friend` → `LocalApiServer` → `_dispatchPhoneAFriend`). There is no board UI action that calls it. The existing non-advancing column button pattern (`julesSelected`, `testingFailed`) proves the board already supports "dispatch to a terminal without moving cards" — this plan adds the same pattern for Phone-a-Friend.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, feature, backend
**Project:** Browser Switchboard

## User Review Required

- **Icon choice:** The plan reuses `{{ICON_77}}` (mapped in both icon maps but currently unused in board HTML). Verify this icon visually represents Phone-a-Friend adequately before implementation. No new icon file is needed, but the visual fit should be confirmed.
- **Silent-drop behavior:** `dispatchPhoneAFriend` silently drops when no Phone-a-Friend terminal is running (logs to diagnostics channel only). The status message count is unreliable — it increments on every `await` resolution including silent drops. This matches the existing fire-and-forget Phone-a-Friend contract. A future enhancement could return a boolean to report drops, but that changes the callback contract and is out of scope.

## Complexity Audit

### Routine
- Adding an icon constant alongside existing `ICON_*` constants (kanban.html ~line 5918)
- Adding a conditionally-rendered button to the coded column `buttonArea` (kanban.html ~line 7085, next to `testingFailBtn`)
- Adding an action name to the `nextCol` guard exempt list (kanban.html line 7254)
- Adding a `case` handler in the frontend action switch (kanban.html ~line 7343, alongside `julesSelected`)
- Adding a `case` handler in the backend `_handleMessage` switch (KanbanProvider.ts ~line 10697, alongside `julesSelected`)
- Card resolution via `_lastCards.filter` + `_cardMatchesIds` with `_buildCardsFromDbSessionIds` fallback — identical to `testingFailed` and `promptSelected`

### Complex / Risky
- Per-card `originRole` resolution using `_columnToRole(card.column)` — must handle cards from different coded columns in CODED_AUTO collapsed view (see Superseded callout in Proposed Changes)
- Changing `_dispatchPhoneAFriend` from `private` to `public` — exposes an internal method; the method's silent-drop contract and serialization behavior must be preserved exactly

## Edge-Case & Dependency Audit

**Race Conditions:**
- `_dispatchPhoneAFriend` serializes per target via `_phoneAFriendInFlight` (a Map of in-flight promises keyed by target terminal). Sequential per-plan dispatch in the backend handler respects this — each `await` chains behind the prior dispatch to the same target. Different targets run concurrently. No new race risk.

**Security:**
- No new attack surface. The backend handler validates `workspaceRoot` and `sessionIds` before dispatching. The `planFile` path comes from `card.planFile` (DB-sourced), not user input.

**Side Effects:**
- No card advancement — no `moveCardToColumn`, no `moveCards`, no `copyPlanLinkResult`. Cards stay in their current column.
- The Phone-a-Friend terminal receives `/clear` + a prompt per plan. If the terminal is mid-task, the `/clear` interrupts it (same behavior as the automatic trigger).
- `selectedCards` is cleared after dispatch (same as `julesSelected`).

**Dependencies & Conflicts:**
- Depends on `_dispatchPhoneAFriend` being made public in `TaskViewerProvider.ts`. KanbanProvider already holds a reference via `this._taskViewerProvider`.
- No conflict with existing column buttons — the new button is conditionally rendered only for `def.kind === 'coded'`, same as `testingFailBtn`.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) CODED_AUTO collapsed view selects cards from multiple coded columns — a single batch-level `originRole` misroutes to the wrong Phone-a-Friend terminal if per-role targets are configured; (2) the `dispatched` counter increments on silent drops, making the status message unreliable; (3) changing a `private` method to `public` exposes an internal dispatch path. Mitigations: per-card role resolution via `_columnToRole(card.column)` eliminates risk #1; the unreliable count is documented as a known limitation matching the existing fire-and-forget contract; the access modifier change is the narrowest possible exposure (signature and logic unchanged).

## Proposed Changes

### src/webview/kanban.html

**Context:** The Kanban board HTML defines column header buttons in a `buttonArea` template string (~line 7134). Coded columns already conditionally render a `testingFailBtn` (~line 7085) using `def.kind === 'coded'`. Icon constants are defined ~line 5915-5921. The action switch starts at line 7256, with `julesSelected` at line 7343 as the closest non-advancing pattern. The `nextCol` guard at line 7254 returns early if there is no next column — non-advancing actions are exempted individually.

**Logic:** Add a Phone-a-Friend icon constant, a conditionally-rendered button in the coded column `buttonArea`, an exemption in the `nextCol` guard, and a `case` handler that posts the selected session IDs to the backend.

**Implementation:**

1. **Add icon constant** (~line 5918, alongside `ICON_TESTING_FAIL`):

```javascript
const ICON_PHONE_A_FRIEND = '{{ICON_77}}';
```

`{{ICON_77}}` is already mapped in both icon maps (`KanbanProvider.ts` line 12978, `headlessPanelHtml.ts` line 209) but unused in the board HTML — no new icon file or map entry needed.

2. **Add the button** (~line 7085, next to `testingFailBtn`):

```javascript
const phoneAFriendBtn = (def.kind === 'coded')
    ? `<button class="column-icon-btn" data-action="phoneAFriendSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Send selected plans to Phone-a-Friend for a second-pass review (no column advance)">
           <img src="${ICON_PHONE_A_FRIEND}" alt="Phone-a-Friend">
       </button>`
    : '';
```

Add `${phoneAFriendBtn}` to the `buttonArea` template string (~line 7142, alongside `${testingFailBtn}`).

3. **Add `phoneAFriendSelected` to the `nextCol` guard exempt list** (line 7254):

```javascript
if (!nextCol && action !== 'julesSelected' && /* ...existing... */ && action !== 'stageForQueue' && action !== 'phoneAFriendSelected') return;
```

4. **Add the `case 'phoneAFriendSelected'` handler** (~line 7343, alongside `julesSelected`):

```javascript
case 'phoneAFriendSelected': {
    const ids = getSelectedInColumn(column);
    if (ids.length === 0) return;
    postKanbanMessage({ type: 'phoneAFriendSelected', sessionIds: ids });
    ids.forEach(id => selectedCards.delete(id));
    break;
}
```

This matches the `julesSelected` pattern exactly — no `column` field in the message. The backend resolves `originRole` per-card from each card's own `column` field (see KanbanProvider.ts changes below). `postKanbanMessage` auto-injects `workspaceRoot` via `getActiveWorkspaceRoot()`.

**Edge Cases:**
- **No selection:** `getSelectedInColumn(column)` returns `[]`, handler returns early. No dispatch, no error.
- **CODED_AUTO collapsed view:** `column` is `'CODED_AUTO'` (the DOM column ID), used only for `getSelectedInColumn`. The message carries only `sessionIds` — the backend resolves each card's actual column individually.
- **Button visibility:** Only rendered when `def.kind === 'coded'` — same gate as `testingFailBtn`. Suppressed in backlog/dispatch views via `suppressPipeline` if the coded column is also the CREATED/PLAN REVIEWED column in those views (though coded columns are never CREATED or PLAN REVIEWED, so this is a non-issue in practice).

### src/services/TaskViewerProvider.ts

**Context:** `_dispatchPhoneAFriend` (line 5647) is a `private` method that resolves the Phone-a-Friend terminal by role, serializes dispatches per target via `_phoneAFriendInFlight`, sends `/clear` + a per-plan prompt, and silently drops when no terminal is running. The single internal call site is at line 3466 (the `POST /phone-a-friend` HTTP callback).

**Logic:** Change the access modifier from `private` to `public` and remove the underscore prefix from the method name. Update the single internal call site. The method's signature, logic, serialization, and silent-drop behavior stay identical.

**Implementation:**

1. **Change access modifier and rename** (line 5647):

```typescript
// Before:
private async _dispatchPhoneAFriend(planFile: string, originRole: string, originTerminal?: string, dispatchId?: string): Promise<void> {

// After:
public async dispatchPhoneAFriend(planFile: string, originRole: string, originTerminal?: string, dispatchId?: string): Promise<void> {
```

2. **Update the internal call site** (line 3466):

```typescript
// Before:
await this._dispatchPhoneAFriend(planFile, originRole || 'coder', originTerminal, dispatchId);

// After:
await this.dispatchPhoneAFriend(planFile, originRole || 'coder', originTerminal, dispatchId);
```

**Edge Cases:**
- **Called with 2 args (from KanbanProvider):** `originTerminal` and `dispatchId` are `undefined`. The target resolution falls through to the role-level default (`phoneAFriendTargets['*']`) or the workspace singleton (`'Phone-a-Friend'`). The prompt text shows `originTerminal: unknown, dispatch: none` — informational only. The self-dispatch guard (line 5692) is bypassed because `originKey = ''` — harmless since board-initiated dispatch has no origin terminal.
- **Silent drop:** Returns `void` regardless of whether the terminal was found. The caller cannot distinguish a successful dispatch from a drop. This is the existing contract — unchanged.

### src/services/KanbanProvider.ts

**Context:** The `_handleMessage` switch handles board actions. `julesSelected` (line 10697) and `testingFailed` (line 11498) are the closest non-advancing patterns. Card resolution uses `_lastCards.filter` with `_cardMatchesIds`, falling back to `_buildCardsFromDbSessionIds`. `_columnToRole` (line 12884) maps column IDs to agent roles. `KanbanCard` has a `column: KanbanColumn` field (line 126) that holds each card's actual column.

**Logic:** Add a `case 'phoneAFriendSelected'` handler that resolves selected cards, derives `originRole` per-card from each card's own `column` field via `_columnToRole()`, and dispatches each plan to `dispatchPhoneAFriend` on the `TaskViewerProvider` reference.

**Implementation:**

1. **Add `case 'phoneAFriendSelected'`** in `_handleMessage` (~line 10697, alongside `julesSelected`):

> **Superseded:** The original plan resolved a single `originRole` from `msg.column` for the entire batch:
> ```typescript
> const column: string = msg.column;
> const originRole = column === 'CODER CODED' ? 'coder'
>     : column === 'INTERN CODED' ? 'intern'
>     : 'lead'; // LEAD CODED and CODED_AUTO (already resolved to LEAD CODED by frontend)
> ```
> **Reason:** The comment "already resolved to LEAD CODED by frontend" is factually wrong — the frontend resolves CODED_AUTO to `columnDefinitions.find(d => d.kind === 'coded')?.id` (the FIRST coded column definition), which may be CODER CODED or INTERN CODED, not necessarily LEAD CODED. More importantly, in CODED_AUTO collapsed view the user can select cards from DIFFERENT coded columns. A single batch-level `originRole` assigns the wrong role to cards not in the resolved column. If per-role Phone-a-Friend targets are configured, this silently misroutes to the wrong terminal.
> **Replaced with:** Per-card role resolution using the existing `_columnToRole(card.column)` method (line 12884), which already maps LEAD CODED → 'lead', CODER CODED → 'coder', INTERN CODED → 'intern'. The `column` field is removed from the frontend message entirely, making it consistent with the `julesSelected` pattern.

```typescript
case 'phoneAFriendSelected': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) {
        return { success: false, error: 'workspaceRoot and sessionIds are required' };
    }
    // Resolve selected cards (same pattern as testingFailed / promptSelected)
    let sourceCards = this._lastCards.filter(card =>
        card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds)
    );
    if (sourceCards.length === 0) {
        const dbCards = await this._buildCardsFromDbSessionIds(workspaceRoot, msg.sessionIds);
        if (dbCards.length === 0) {
            void this._seams().ui.showInformationMessage('No matching plans found.');
            return { success: false, error: 'No matching plans found.' };
        }
        sourceCards = dbCards;
    }
    // Per-card originRole resolution — each card's actual column determines the role.
    // This handles CODED_AUTO collapsed view where cards from different coded columns
    // (LEAD CODED, CODER CODED, INTERN CODED) may be selected together.
    // _columnToRole (line 12884) maps: LEAD CODED → 'lead', CODER CODED → 'coder',
    // INTERN CODED → 'intern', CODED → 'lead'. Fallback 'lead' for unknown columns.
    let dispatched = 0;
    for (const card of sourceCards) {
        const planFile = card.planFile || '';
        if (!planFile) continue;
        const originRole = this._columnToRole(card.column) || 'lead';
        try {
            await this._taskViewerProvider?.dispatchPhoneAFriend(planFile, originRole);
            dispatched++;
        } catch (e) {
            console.error(`[KanbanProvider] Phone-a-Friend dispatch failed for ${planFile}:`, e);
        }
    }
    // NOTE: `dispatched` counts await resolutions, including silent drops (no terminal running).
    // dispatchPhoneAFriend returns Promise<void> and never throws on drop — the count is
    // unreliable when no Phone-a-Friend terminal is open. This matches the existing
    // fire-and-forget Phone-a-Friend contract. A future enhancement could return a boolean.
    this.postMessage({ type: 'showStatusMessage',
        message: `Sent ${dispatched} second-pass review(s) to Phone-a-Friend.`,
        isError: false });
    return { success: true, dispatched };
}
```

**No card advancement** — there is no `moveCardToColumn`, no `moveCards` message, no `copyPlanLinkResult`. The cards stay in their current column.

**Edge Cases:**
- **No matching cards:** `_lastCards.filter` returns `[]`, fallback to `_buildCardsFromDbSessionIds`. If that also returns `[]`, shows "No matching plans found." and returns failure.
- **Card with no `planFile`:** `continue` skips it. No dispatch, no error.
- **`_columnToRole` returns `null`:** Fallback to `'lead'`. This covers custom columns or unexpected column IDs.
- **`_taskViewerProvider` is undefined:** Optional chaining (`?.`) short-circuits. `dispatched` is not incremented. No error thrown.
- **CODED_AUTO mixed-column selection:** Each card gets its own `originRole` from `card.column`. A card in CODER CODED gets `'coder'`, a card in INTERN CODED gets `'intern'`, a card in LEAD CODED gets `'lead'`. Correct target resolution per card.
- **Silent drop (no Phone-a-Friend terminal):** `dispatchPhoneAFriend` resolves `void`. `dispatched++` fires. The status message count includes the drop. The user will notice the terminal didn't respond. Diagnostics channel logs the drop. This is the existing contract.

## Verification Plan

### Automated Tests
- No automated tests — this is a UI-triggered dispatch feature. Verification is manual.

### Manual Tests
1. **Build**: `npm run compile` — no type errors
2. **Manual test — single plan**: Select one plan in a coded column (Lead Coder / Coder / Intern / Autocode), click the Phone-a-Friend button, verify the Phone-a-Friend terminal receives the second-pass prompt and the card does NOT move to the Reviewed column
3. **Manual test — multiple plans (same column)**: Select 2+ plans in the same coded column, click the button, verify each plan gets a sequential `/clear` + prompt dispatch to the Phone-a-Friend terminal
4. **Manual test — no selection**: With nothing selected, click the button, verify nothing happens (no dispatch, no error)
5. **Manual test — no Phone-a-Friend terminal running**: With no Phone-a-Friend terminal open, select a plan and click the button, verify the status message appears but the dispatch is silently dropped (check diagnostics channel for the drop log)
6. **Manual test — Autocode collapsed view (single plan)**: Collapse the coder columns into AUTOCODE, select one plan, click the button, verify the dispatch works (backend resolves `originRole` from `card.column` via `_columnToRole`)
7. **Manual test — Autocode collapsed view (mixed columns)**: Collapse the coder columns into AUTOCODE, select 2+ plans that are in DIFFERENT coded columns (e.g. one in CODER CODED, one in LEAD CODED), click the button, verify each plan dispatches with the correct `originRole` for its actual column (check the prompt text in the Phone-a-Friend terminal — "origin role: coder" vs "origin role: lead")

## Completion Report

Implemented manual Phone-a-Friend button on coded column headers in the Kanban board. Added `ICON_PHONE_A_FRIEND` using `{{ICON_77}}`, rendered `phoneAFriendBtn` on coded columns, exempted `phoneAFriendSelected` from next-column guards, and added frontend action handling in `kanban.html`. Made `dispatchPhoneAFriend` public in `TaskViewerProvider.ts`, and implemented the backend handler in `KanbanProvider.ts` resolving origin roles per-card to support mixed column selections in `CODED_AUTO` view without advancing cards. Files changed: `src/webview/kanban.html`, `src/services/TaskViewerProvider.ts`, and `src/services/KanbanProvider.ts`. No issues encountered.

## Review Findings

One CRITICAL: the new `phoneAFriendSelected` arm was never propagated to the generated verb surface, so `protocol-catalog.json` / `src/generated/verbAllowlist.ts` were stale — `npm run catalog:check` (a CI gate, `.github/workflows/integration-tests.yml:26`) failed on drift, and `KanbanProvider.handleServiceVerb`'s `KANBAN_VERBS` guard would have thrown `Unknown Kanban verb: 'phoneAFriendSelected'` for every browser-cockpit and standalone click, leaving the button dead on those hosts while working in the editor webview. Fixed by running the generators (`protocol-catalog.json`, `src/generated/verbAllowlist.ts`); also fixed one orphaned identifier reference in a `kanban.html` comment left by the `_dispatchPhoneAFriend` → `dispatchPhoneAFriend` rename. Files changed by this review: `protocol-catalog.json`, `src/generated/verbAllowlist.ts`, `src/webview/kanban.html`. Verification: `catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `kanban-dispatch-callers:check`, `verb-returns:check`, `icons:parity` and `test:contract:verb-engine-kanban` (19/19) all green; two failures are pre-existing and unrelated to this plan (`mirror:check` drift on `switchboard-orchestration/SKILL.md`, and `browser-panel-verb-routing`'s `connections.js: copyTextToClipboard`, both present at HEAD), and `tsc -p tsconfig.test.json` reports three errors that all belong to concurrent uncommitted orchestrator-adopt work in `TaskViewerProvider.ts` (missing `OrchestratorSeat` import, `showInfoMessage` not on `HostUI`) — zero type errors on any line this plan touched. Remaining risks, all pre-existing and deliberately out of scope: `dispatchPhoneAFriend` resolves its own workspace root and ignores the board's selected one (cross-workspace misroute in multi-root setups), a role-level `phoneAFriendTargets['*'] = null` "off" is not honoured when `originTerminal` is absent, and the reported dispatch count still counts silent drops.


## Review Findings — second pass (dispatch cadence)

A CRITICAL functional defect survived the first review pass: the handler looped `dispatchPhoneAFriend` once per selected plan, and that promise resolves when the keystrokes land (~3.3s: `/clear` paste + 1000ms + Enter + `clearBeforePromptDelay` 2000ms + prompt paste + 300ms), NOT when the review finishes — which takes minutes. Every dispatch opens with `/clear`, so a multi-plan selection wiped each review about three seconds after starting it and only the last plan was ever actually reviewed; role-based grouping would not have helped either, because with no per-role `phoneAFriendTargets` configured (the default) lead, coder and intern all resolve to the same singleton terminal. Fixed by extracting the target resolution into a new public `TaskViewerProvider.resolvePhoneAFriendTarget(originRole, originTerminal?)`, widening `dispatchPhoneAFriend` to accept `string | string[]`, and having the board handler group selected plans by resolved target terminal and send ONE numbered, work-the-list-in-order prompt per target (single-plan prompt text kept byte-identical so the HTTP batch-end path does not drift). The handler now also reports `unrouted` — plans whose origin role has Phone-a-Friend explicitly switched off — and the status message reads `Sent N plan(s) to Phone-a-Friend in M prompt(s)`. Verification after the fix: `tsc -p tsconfig.test.json` clean for every line this plan touches (the only three errors belong to concurrent uncommitted orchestrator-adopt work in `TaskViewerProvider.ts`), and `catalog:check`, `parity:check`, `verb-returns:check`, `standalone-fork:check`, `kanban-dispatch-callers:check`, `test:contract:verb-engine-kanban` (19/19), `test:contract:reviewer-prompt` and `test:contract:minimal-prompt` all green.


## Review Findings — third pass (sequential queue)

The batch prompt was an interim fix — the friend works the list in one context, but a review that finds real bugs takes minutes per plan and the user has no visibility into progress. Replaced the batch with a per-target sequential queue: one plan in flight per target terminal, the next plan dispatched only when the friend calls `POST /phone-a-friend/done`. Four files changed:

- `src/services/agentPromptBuilder.ts` — `PHONE_A_FRIEND_DONE_DIRECTIVE(port, targetKey, planFile)`: appended to queue-originated review prompts only. Tells the friend to curl `/phone-a-friend/done` exactly once with `{target, planFile}`. No false claims about host auto-advance.
- `src/services/TaskViewerProvider.ts` — `_phoneAFriendQueues` per-target in-memory queue map. `dispatchPhoneAFriend` (public void wrapper) passes `queueOriginated=false` — no directive on the automatic batch-end path. `_dispatchPhoneAFriendInternal` (private, returns `boolean` delivery status) appends the directive ONLY when `queueOriginated=true` AND `apiPort>0`. `enqueuePhoneAFriend` resolves target, appends to pending, pumps head; standalone (`suppressLocalApiServer`) and no-port both force batch fallback; accepts pre-resolved target to avoid redundant re-resolve. `_pumpPhoneAFriendQueue` dispatches head, arms 10-min stall notification timer. `handlePhoneAFriendDone(target, planFile?)` correlates `planFile` against `queue.inFlight` — spurious callbacks from non-queue dispatches that clobbered the terminal are ignored, not advanced. `_emitPhoneAFriendNotice` always logs to diagnostics + posts `showStatusMessage` to the kanban webview; `notifyTurnEnd` (durable report + live delivery) gated on `_hasOrchestrator` only. `_resolveOrchestratorRecipient` passes `recipientSeat` explicitly — addresses the orchestrator, not the friend's fleet head. `notifyTurnEnd` mirror moved above `_ptyHostPort` guard — file survives when no pty host (unattended case). `dispose` clears all stall timers + empties queue map.
- `src/services/LocalApiServer.ts` — `onPhoneAFriendDone` callback option. `POST /phone-a-friend/done` route — callable by the orchestrator to force-advance a wedged queue.
- `src/services/KanbanProvider.ts` — `phoneAFriendSelected` calls `enqueuePhoneAFriend` instead of `dispatchPhoneAFriend`. Passes pre-resolved target. Status message: `Queued N plan(s) for Phone-a-Friend; sent the first.`

Edge cases: dispatch dropped (no terminal) = fail OPEN, advance to next plan. No API port = batch fallback. Standalone host = batch fallback (token auth + no callback wired). Friend never calls back = 10-min stall notice, NO auto-advance (see below). Duplicate callbacks = silently ignored. Spurious callbacks (wrong `planFile`) = ignored, not advanced. Host restart = in-memory queue dropped (correct — no replay of unrequested reviews).

**CRITICAL — stall timer does NOT auto-advance.** An earlier iteration of this change made the stall timer clear `inFlight` and pump the next plan after 10 minutes. That was the original bug with a bigger constant: every pump dispatches, every dispatch opens with `/clear`, so a review still running at the 10-minute mark would be destroyed mid-flight. A second-pass review that reads a plan, audits the code and fixes bugs routinely exceeds ten minutes. The host cannot distinguish "crashed / ignored the directive" from "still working" — there is no idle signal for a `vscode.Terminal`, which is the entire reason the callback exists. Auto-advance is a guess, and guessing wrong destroys the user's work. The handoff spec said it explicitly: do not advance the queue on a timer, a delay, or on the dispatch promise resolving; advance only on the completion signal. Fixed: on stall, emit the notice and STOP. Leave `inFlight` set and the pending plans queued. The notice body includes force-advance instructions (`POST /phone-a-friend/done` with `{target, planFile}`) — safe because `/done` correlates on `planFile`, so a deliberate advance cannot skip the wrong plan. A human or the orchestrator decides whether the friend is dead; a timer must not.

Verification: `tsc -p tsconfig.test.json` — 3 pre-existing errors only (`OrchestratorSeat` unimported, `showInfoMessage` not on `HostUI`), zero new. `catalog:check`, `parity:check`, `verb-returns:check`, `standalone-fork:check`, `test:contract:verb-engine-kanban` (19/19) all green.
