# Browser "Send to Planner" Fails Because the Dispatch Path Drops the Surface Flag

## Goal

Make every browser-originated "Send to Planner"-family button actually deliver its prompt to the planner terminal the browser user can see, and — when it genuinely cannot — report the real reason *in the browser* with the prompt on the *browser's* clipboard.

### Problem

In the browser Switchboard, buttons that send a prompt to the planner produce an error even though a `planner-1` terminal exists and is registered (`GET /health` lists it under `terminals`). The affected buttons all funnel through one method:

| Button | Panel | Verb | Handler |
|---|---|---|---|
| Send to Planner (memo) | memo | `memoGeneratePrompt` | `TaskViewerProvider.ts:12631` |
| Build PRD via planner | project | `invokePrdBuilder` | `PlanningPanelProvider.ts:4226` |
| Build / Update constitution | project | `invokeConstitutionBuilder`, `invokeConstitutionUpdater` | `PlanningPanelProvider.ts:4342`, `:4355` |
| Build AGENTS.md / CLAUDE.md | project | `invokeSystemBuilder` | `PlanningPanelProvider.ts:4374` |
| Open architect terminal | project | `openArchitectTerminal` | `PlanningPanelProvider.ts:4410` |
| Dispatch manager pass | board | `dispatchManagerForSelected` | `KanbanProvider.ts:10033` (role `lead`) |
| Ask agent (ticket) | tickets | `ticketsAskAgent` → `switchboard.askAgentTask` | `TaskViewerProvider.ts:7399-7409` |

### Root cause — the surface flag is stamped, then thrown away

Every request that arrives on a verb rail is stamped api-originated by the server before dispatch:

```ts
// src/services/LocalApiServer.ts:1762-1765
private _stampHttpSurface(body: any): any {
    body.apiOriginated = true;
    return body;
}
```

**Verified (2026-08-06): the premise holds for all eight call sites this plan owns, but not for every rail.** `_stampHttpSurface` is called from exactly four of the seven verb-rail handlers — `_handleKanbanVerb` (`:1794`), `_handlePlanningVerb` (`:1823`), `_handleTicketsVerb` (`:1852`), `_handleTaskViewerVerb` (`:1961`). `/project/verb/*` and `/memo/verb/*` both route to `_handlePlanningVerb` (`LocalApiServer.ts:3540-3545`), so the five `PlanningPanelProvider` arms, the memo arm, the board arm and the tickets arm are all stamped. `_handleDesignVerb` (`:1865-1899`) and `_handleSetupVerb` (`:1901-1943`) do **not** stamp — that gap breaks the sibling plan `browser-direct-terminal-helpers-not-fleet-aware`, which owns the fix. Nothing in *this* plan depends on the design or setup rail.

The memo path crosses one provider boundary and survives it: `/memo/verb/memoGeneratePrompt` → `_handlePlanningVerb` (stamped) → `PlanningPanelProvider.handleServiceVerb` delegates memo verbs to `TaskViewerProvider.handleServiceVerb` (`PlanningPanelProvider.ts:115-121`, passing `payload` unmodified) → `_handleMessage({ ...payload, type: verb })` (`TaskViewerProvider.ts:347`). So `data.apiOriginated` is genuinely readable in the memo arm.

That flag is the whole per-surface routing discriminator. Downstream it becomes `allowPtyFleet`, which decides whether a dispatch may resolve and deliver into the **PTY fleet** — the browser Terminals panel — or is restricted to `vscode.Terminal` instances:

- `src/services/TaskViewerProvider.ts:8261-8285` — `_resolveAgentTerminalForPlan(role, root, worktreePath, allowPtyFleet)`; the PTY fleet is consulted **only** when `allowPtyFleet` is true, because "`_getAliveAutobanTerminalRegistry` cannot supply one — it keeps a row only on a VS Code pid/name match or a heartbeat, and PTY rows have none of those".
- `src/services/TaskViewerProvider.ts:18870-18890` — `_attemptDirectTerminalPush(..., allowPtyFleet)`; the PTY fleet is checked **first**, again only when opted in.
- `src/services/TaskViewerProvider.ts:8288-8294`, `:8219-8258` — the registry readers skip `purpose: 'pty'` / `ideName === PTY_IDE_NAME` rows unless `allowPtyFleet`.

`dispatchCustomPromptToRole` has **no parameter for it**:

```ts
// src/services/TaskViewerProvider.ts:4642
public async dispatchCustomPromptToRole(role: string, prompt: string, workspaceRoot: string): Promise<boolean> {
    …
    // :4651  planner set from the VS Code-only autoban registry
    const { terminals, locationKey } = await this.getRoleTerminalSet('planner', resolvedWorkspaceRoot);
    …
    // :4663  THREE-ARG CALL — worktreePath and allowPtyFleet both default
    targetAgent = await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot);
    …
    // :4674  unconditional reveal (correct only for a vscode.Terminal target)
    this._seams().commands.executeCommand('switchboard.focusTerminalByName', targetAgent, { silent: true });
    // :4675  FOUR-ARG CALL — allowPtyFleet defaults to false (:18790)
    const success = await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, prompt, {});
}
```

So a browser click is resolved and delivered as though it were the VS Code sidebar. Two failure shapes follow:

1. **Resolution miss.** `getRoleTerminalSet` reads `<root>/.switchboard/state.json` (`:8405-8421` → `:8429-8484` → `_resolveStateFilePath` at `:2846`). If the browser user's planner is a PTY-fleet terminal, it has no row there and no VS Code pid — the set comes back empty, `_resolveAgentTerminalForPlan` (PTY branch skipped) also misses, and the method hits `showErrorMessage("No agent assigned to role 'planner'. Please assign a terminal first.")` at `:4666-4669` and returns `false`.
2. **Delivery refusal.** If a *name* does resolve, `_dispatchExecuteMessage` with `allowPtyFleet=false` skips the fleet, finds no matching `vscode.Terminal`, then deliberately detects the PTY and refuses (`:18810-18822`): *"'planner-1' is a browser terminal (Switchboard Terminals panel), so the VS Code sidebar cannot dispatch to it."* — a correct message for the sidebar, wrong for a caller that **is** the browser.

### Secondary root cause — the failure is invisible and the fallback is a no-op in the browser

- Both failure reports are `showErrorMessage` / `showWarningMessage` (`:4667`, `:18820`) — VS Code toasts. A browser user never sees them; they get only the generic body. For memo that body is `"Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry."` (`TaskViewerProvider.ts:12651`) — which names the planner and so reads as "the planner is broken", matching the report.
- That message promises a clipboard fallback, and the code does write one (`:12633-12636`) — but to the **extension host's** clipboard via `this._seams().clipboard`. `transport.js` only reaches the browser clipboard when the reply body carries a `prompt` field (`src/webview/transport.js:292-296`), and the memo reply carries none. So in the browser the promised recovery does not happen at all.

### Fix

Thread the already-present `apiOriginated` flag from each verb payload into `dispatchCustomPromptToRole`, and from there into planner-set resolution, `_resolveAgentTerminalForPlan`, and `_dispatchExecuteMessage`. Then make the failure path browser-visible by returning `error` + `prompt` in the reply body.

## Metadata

- **Complexity:** 6
- **Tags:** backend, bugfix, reliability, api
- **Project:** Browser Switchboard

## User Review Required

None. Every decision in this plan is determined by the existing `allowPtyFleet` contract: the parameter is additive and trailing, the default is fail-closed, and the failure-only `prompt` field follows the established `transport.js` clipboard convention. No user input is needed before coding.

## Complexity Audit

**Complex / risky — the risk is in the direction of the flag, not the size of the diff.**

### Routine

- No DB work, no migration, no schema change, no new verb, no UI layout change.
- The `allowPtyFleet` plumbing this hooks into already exists and is exercised by the board's own api-originated dispatch path (`KanbanProvider.ts:8101`, `:8187`).
- Five of the eight call sites (`PlanningPanelProvider.ts:4226/4342/4355/4374/4410`) take an identical one-line change.
- No ratchet impact: this plan edits the `dispatchCustomPromptToRole(...)` argument list only and converts no `break` to `return`, so `scripts/verb-return-contract-baseline.json` is untouched. (The sibling plan `browser-direct-terminal-helpers-not-fleet-aware` edits the *next* line of the same five arms and **does** change Planning's residual — see the merge note in Proposed Changes.)

### Complex / Risky

- **Fail-closed default must be preserved.** The new parameter must default to `false`. Every in-process/sidebar caller (autoban, oversight pass, the extension's own buttons) relies on that default so a sidebar dispatch can never land in a terminal VS Code cannot show. Making `allowPtyFleet` default to `true`, or deriving it from anything other than an explicit caller opt-in, silently breaks the editor.
- **An existing contract test asserts today's behaviour.** `src/test/pty-dispatch-focus-contract.test.js:170-180` asserts `dispatchCustomPromptToRole` must **not** use the PTY predicate, on the grounds that "it resolves and delivers with `allowPtyFleet=false`, so its target is always a `vscode.Terminal`". That premise is exactly what this plan changes; the test and the comment at `TaskViewerProvider.ts:4671-4673` must be updated in the same commit or the suite goes red.
- **Focus call becomes conditional.** With PTY targets now possible, the unconditional `switchboard.focusTerminalByName` at `:4674` must be guarded by `_isLikelyPtyDispatchTarget(targetAgent, allowPtyFleet)`, mirroring `:19198-19201`. A PTY has no VS Code terminal to reveal.
- **Eight call sites, three providers, one command boundary.** The tickets path crosses `TicketsPanelProvider → switchboard.askAgentTask → TaskViewerProvider.askAgentTask`, so the flag has to ride through the command payload — and that boundary **drops unknown fields today** (verified, see Proposed Changes: `src/extension.ts:2085-2086` destructures the payload field-by-field). Threading the flag on the `TicketsPanelProvider` side alone is a silent no-op.

## Edge-Case & Dependency Audit

- **Editor callers must not change behaviour.** `askAgentTask` and the five `PlanningPanelProvider` arms are reachable from *both* the editor webview (no `apiOriginated`) and the browser rail (`apiOriginated: true`). Passing `!!msg.apiOriginated` yields `false` for editor clicks, preserving today's semantics exactly. Do not "simplify" this to always-true.
- **Both fleets hold the same name.** A VS Code `planner-1` and a PTY `planner-1` can coexist and normalize to the same agent key. `_attemptDirectTerminalPush` already resolves this: fleet first when opted in (`:18877-18883`), because that is the terminal the calling surface can display. Browser click → PTY; sidebar click → VS Code terminal. Correct in both directions, no new tie-breaking needed.
- **Planner rotation cursor.** `getRoleTerminalSet` supplies the `locationKey` that drives `advancePlannerRotationCursor` (`:5566-5578`). When the planner set is resolved from the PTY fleet instead, there is no `locationKey`; leave `plannerLocationKey` undefined so the cursor is simply not advanced (the existing `if (success && plannerLocationKey)` guard at `:4677` already handles this). Do not invent a synthetic key — that would fork the cursor namespace between hosts.
- **PTY host may be down.** `_ptyHostPort` is falsy when the fleet is not running (`terminalFleet: ptyHostReady()` in `TaskViewerProvider.ts:2278`). Every fleet branch is already guarded on it, so an api-originated dispatch with no fleet degrades to exactly today's VS Code-only behaviour rather than throwing.
- **Mixed setup (this machine).** `GET /health` currently reports 7 VS Code-registered terminals including `planner-1`, while no `.switchboard/state.json` exists on any active root — so `getRoleTerminalSet` and `_getAgentNameForRole` both return nothing regardless of host. That means the "No agent assigned to role 'planner'" branch is reachable even with a live VS Code planner. The fix must therefore *also* surface that error to the browser (below); threading the flag alone would leave a silent failure when neither registry has a row.
- **`workspaceRoot` default differs per host.** On a verb rail with no `workspaceRoot` in the body, `LocalApiServer` falls back to `this._options.workspaceRoot` — the *primary* root — not the *selected* root (`/health.selectedWorkspaceRoot`). Panels that omit `workspaceRoot` can therefore resolve their planner against the wrong workspace. Out of scope for this plan, but the verification steps below pass `workspaceRoot` explicitly so a root mismatch cannot be mistaken for a dispatch bug.
- **Return `prompt` only on failure.** Adding `prompt` to the *success* body would make `transport.js:292-296` overwrite the browser clipboard on every successful send — a silent clipboard clobber. Include it strictly in the failure body.
- **Memo clear-on-success invariant.** `memoGeneratePrompt` clears `memo.md` only when `sendSucceeded` (`:12643-12647`), and `src/test/memo-browser-clear-and-copy-contract.test.js:225,249` stubs `dispatchCustomPromptToRole` to force both outcomes. Adding a trailing optional parameter keeps those stubs valid; changing the parameter *order* would break them.
- **Sibling plans cover the rest of the family — nothing is left unfixed.** This plan owns exactly one method (`dispatchCustomPromptToRole`) and its eight call sites. Three sibling plans, written alongside this one, own the other browser send-to-terminal defects found in the same audit:
  - *Stray `_dispatchExecuteMessage` call sites* — orchestrator kickoff/wake, pair-programming coder, airlock send-to-coder (`browser-stray-dispatch-sites-hardcode-vscode-fleet`).
  - *Direct-to-`vscode.Terminal` helpers that bypass the dispatcher entirely* — `_sendPromptToTerminal`, `sendPromptToAgentTerminal`, `_deliverPromptToPmTerminal`, `_handleSendAnalystMessage`, plus the design/planning arms that report `{success:true}` when nothing was delivered (`browser-direct-terminal-helpers-not-fleet-aware`).
  - *Verb-routing misses* — `project.js` posts `improvePlan` (`src/webview/project.js:2075`, in `KANBAN_VERBS` only) and `webviewReady` (`:1166`, in no allowlist at all), so the browser rail throws `Unknown Planning verb: '<verb>'` where the editor either swallows it or handles it (`browser-project-panel-verbs-rejected-by-planning-allowlist`).

  They are separate plans because each is independently shippable and touches a different method set — not because any of them is deferred. Land them in any order; they do not conflict except where noted below.

## Dependencies

- None blocking. No session dependency (`sess_*`) applies — this plan is self-contained within the existing `allowPtyFleet` plumbing, which is already shipped and exercised.
- Sibling coupling (same feature, no ordering requirement): `browser-direct-terminal-helpers-not-fleet-aware` edits the line immediately following this plan's edit in the same five `PlanningPanelProvider` arms. Either order works; the second to land adds one argument to an already-edited block. See the merge note in Proposed Changes.

## Adversarial Synthesis

**Risk summary.** The single load-bearing risk is direction, not size: if `allowPtyFleet` is ever derived from anything other than an explicit caller opt-in — or defaulted to `true` — every sidebar dispatch becomes eligible to land in a browser terminal the editor user cannot see, which is the exact defect the flag was introduced to prevent. The second risk is a false green: three source-level tests (`pty-dispatch-focus-contract`, `memo-browser-clear-and-copy-contract`, and the new surface test) can all pass while the tickets path stays broken, because the flag dies at the `switchboard.askAgentTask` command boundary in `extension.ts` rather than in any of the methods those tests inspect. Mitigations: keep the parameter trailing and optional with a `!!options?.apiOriginated` derivation; invert the stale contract-test assertion in the same commit; make the `extension.ts:2085` forward a required edit with its own UAT line (Verification step 3, tickets row); and prove the failure path by pasting from the *browser* clipboard, not by reading a log.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

**(a) Add the surface parameter to `dispatchCustomPromptToRole` (line 4642) and thread it through all three consumers.**

```ts
-    public async dispatchCustomPromptToRole(role: string, prompt: string, workspaceRoot: string): Promise<boolean> {
+    /**
+     * @param options.apiOriginated True when the caller is a verb rail (browser cockpit,
+     * CLI, orchestrator) rather than the in-process VS Code sidebar. Set from the payload's
+     * `apiOriginated` flag, which LocalApiServer._stampHttpSurface stamps on every HTTP
+     * body. It becomes `allowPtyFleet` for resolution AND delivery, so a browser click can
+     * reach the browser's own PTY terminal. Defaults false — every sidebar caller keeps
+     * today's VS Code-only routing and can never dispatch into a terminal VS Code cannot show.
+     */
+    public async dispatchCustomPromptToRole(
+        role: string,
+        prompt: string,
+        workspaceRoot: string,
+        options?: { apiOriginated?: boolean }
+    ): Promise<boolean> {
         const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
         if (!resolvedWorkspaceRoot) { return false; }
+        const allowPtyFleet = !!options?.apiOriginated;
 
         let targetAgent: string | undefined;
         let plannerLocationKey: string | undefined;
         if (role === 'planner') {
             const { terminals, locationKey } = await this.getRoleTerminalSet('planner', resolvedWorkspaceRoot);
             if (terminals.length > 0) { … }
         }
         if (!targetAgent) {
-            targetAgent = await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot);
+            // Fourth arg is the fix: without it the PTY branch at :8276 is skipped and a
+            // browser-only planner is unreachable. Third arg stays undefined (no worktree).
+            targetAgent = await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot, undefined, allowPtyFleet);
         }
 
         if (!targetAgent) {
             this._seams().ui.showErrorMessage(`No agent assigned to role '${role}'. Please assign a terminal first.`);
             return false;
         }
         if (!this._isValidAgentName(targetAgent)) { return false; }
-        this._seams().commands.executeCommand('switchboard.focusTerminalByName', targetAgent, { silent: true });
-        const success = await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, prompt, {});
+        // A PTY has no VS Code terminal to reveal — mirrors the board path at :19198.
+        if (!this._isLikelyPtyDispatchTarget(targetAgent, allowPtyFleet)) {
+            this._seams().commands.executeCommand('switchboard.focusTerminalByName', targetAgent, { silent: true });
+        }
+        const success = await this._dispatchExecuteMessage(
+            resolvedWorkspaceRoot, targetAgent, prompt, {}, 'sidebar', allowPtyFleet
+        );
```

Also update the stale comment at `:4671-4673` ("No PTY predicate — … so its target is always a `vscode.Terminal`"), which no longer holds.

**(b) `memoGeneratePrompt` (line 12631) — pass the flag and return the prompt on failure so the browser clipboard fallback is real.**

```ts
-                            sendSucceeded = await this.dispatchCustomPromptToRole('planner', prompt, workspaceRoot);
+                            sendSucceeded = await this.dispatchCustomPromptToRole(
+                                'planner', prompt, workspaceRoot, { apiOriginated: !!data.apiOriginated }
+                            );
```

and in the failure branch of the return (line ~12665):

```ts
-                            ...(sendSucceeded ? {} : { error: msg }),
+                            // `prompt` ONLY on failure: transport.js:292 copies any body-level
+                            // `prompt` to the BROWSER clipboard, which is the only clipboard a
+                            // cockpit user has. On success that would clobber it silently.
+                            ...(sendSucceeded ? {} : { error: msg, prompt }),
```

**(c) `askAgentTask` (line 7399) — accept and forward the flag; drop the VS Code-only pre-check.**

```ts
-    public async askAgentTask(workspaceRoot: string, data: { id: string; title: string; description: string; provider: 'linear' | 'clickup' }): Promise<void> {
+    public async askAgentTask(
+        workspaceRoot: string,
+        data: { id: string; title: string; description: string; provider: 'linear' | 'clickup'; apiOriginated?: boolean }
+    ): Promise<void> {
         const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
         if (!resolvedRoot) return;
-        const agentName = await this._getAgentNameForRole('planner', resolvedRoot);
-        if (!agentName) {
-            this._seams().ui.showWarningMessage('No planner agent found. Set one up in the Setup panel.');
-            throw new Error('No planner agent configured');
-        }
+        // The pre-check duplicated resolution and, at allowPtyFleet=false, reported "no
+        // planner" for a browser user whose planner is a PTY. dispatchCustomPromptToRole
+        // owns resolution (fleet-aware) and reports its own failure; throw on ITS result so
+        // the tickets panel still surfaces an error to the caller.
         const prompt = `…unchanged…`;
-        await this.dispatchCustomPromptToRole('planner', prompt, resolvedRoot);
+        const dispatched = await this.dispatchCustomPromptToRole(
+            'planner', prompt, resolvedRoot, { apiOriginated: !!data.apiOriginated }
+        );
+        if (!dispatched) { throw new Error('No planner agent could be reached for this ticket'); }
     }
```

### `src/services/PlanningPanelProvider.ts`

All five arms take the same one-line change (lines 4226, 4342, 4355, 4374, 4410):

```ts
-                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
+                    const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole(
+                        'planner', promptText, wsRoot, { apiOriginated: !!msg.apiOriginated }
+                    );
```

Note the existing `_sendPromptToTerminal(...)` fallback on each of these arms creates an **ad-hoc VS Code terminal** — invisible to a browser user. Threading the flag here means the fallback is reached far less often, but it is still reachable and still broken in the browser; making it fleet-aware is the sibling plan `browser-direct-terminal-helpers-not-fleet-aware`. **Merge note:** that plan changes `_sendPromptToTerminal`'s signature, so if it lands first, these five arms pass the surface flag to *both* calls. Either order works; the second one to land just adds one argument to an already-edited line.

### `src/services/KanbanProvider.ts` (line 10033)

```ts
-                        const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('lead', prompt, workspaceRoot);
+                        const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole(
+                            'lead', prompt, workspaceRoot, { apiOriginated: !!msg?.apiOriginated }
+                        );
```

### `src/services/TicketsPanelProvider.ts` (line 3248)

Forward the flag across the command boundary:

```ts
                     await this._seams().commands.executeCommand(
                         'switchboard.askAgentTask',
                         {
                             workspaceRoot: askWorkspaceRoot,
                             id: ticketId,
                             title: String(msg.title || '').trim(),
                             description: String(msg.description || '').trim(),
-                            provider
+                            provider,
+                            apiOriginated: !!msg.apiOriginated
                         }
                     );
```

### `src/extension.ts` (lines 2085-2086) — REQUIRED, not optional

> **Superseded:** "Check `src/extension.ts`'s `switchboard.askAgentTask` registration passes the payload object through unmodified; if it destructures fields explicitly, add `apiOriginated` there too."
> **Reason:** Verified 2026-08-06 — it *does* destructure, field by field. Leaving this as a conditional check invites a coder to skip it, and the flag would then be silently dropped at the command boundary: the tickets *Ask agent* button would still fail in the browser while every source-level contract test passed.
> **Replaced with:** a required edit, below.

```ts
-    const askAgentTaskDisposable = vscode.commands.registerCommand('switchboard.askAgentTask', async (data: { workspaceRoot: string; id: string; title: string; description: string; provider: 'linear' | 'clickup' }) => {
-        return taskViewerProvider.askAgentTask(data.workspaceRoot, { id: data.id, title: data.title, description: data.description, provider: data.provider });
+    const askAgentTaskDisposable = vscode.commands.registerCommand('switchboard.askAgentTask', async (data: { workspaceRoot: string; id: string; title: string; description: string; provider: 'linear' | 'clickup'; apiOriginated?: boolean }) => {
+        // apiOriginated MUST be forwarded explicitly: this registration destructures the
+        // payload field-by-field, so any field not named here is dropped at the command
+        // boundary. Without it the browser tickets 'Ask agent' button keeps failing even
+        // though TicketsPanelProvider set the flag one call earlier.
+        return taskViewerProvider.askAgentTask(data.workspaceRoot, { id: data.id, title: data.title, description: data.description, provider: data.provider, apiOriginated: !!data.apiOriginated });
     });
```

### `src/test/pty-dispatch-focus-contract.test.js` (lines 170-180)

Invert the assertion to match the new contract: `dispatchCustomPromptToRole` **must** guard its focus call with `_isLikelyPtyDispatchTarget` (because its target can now be a PTY), **must** pass a fourth argument to `_resolveAgentTerminalForPlan`, and **must** pass `allowPtyFleet` as the sixth argument to `_dispatchExecuteMessage`. Update the assertion message to state why.

### `src/test/browser-planner-dispatch-surface.test.js` (new)

Source-level contract test asserting:
1. `dispatchCustomPromptToRole` declares an `options` parameter and derives `allowPtyFleet` from `options?.apiOriginated`.
2. It defaults to `false` (fail-closed) — grep for `!!options?.apiOriginated`, reject a literal `true` default.
3. All eight call sites pass an `apiOriginated` value (none calls the 3-arg form).
4. The memo failure body carries `prompt`, and the success body does not.

## Verification Plan

### Automated Tests

1. **Compile + suite:** `npx tsc --noEmit -p .` then `npm test`. The updated `pty-dispatch-focus-contract` and the new `browser-planner-dispatch-surface` test must be green; `memo-browser-clear-and-copy-contract` must stay green (the trailing optional parameter keeps its stubs valid).
2. **Ratchet + parity unchanged:** `npm run verb-returns:check`, `npm run parity:check`, `npm run push-routing:check` must all pass with **no baseline edit** — this plan converts no `break` to `return`. A ratchet diff here means scope leaked in from the sibling plan.
3. **Show the new test fails pre-fix.** Stash the provider changes, run `browser-planner-dispatch-surface`, and confirm it reports the three-arg `_resolveAgentTerminalForPlan` call and the four-arg `_dispatchExecuteMessage` call. A contract test that passes on the unfixed tree proves nothing.

### Manual / UAT

4. **Editor regression (fail-closed default holds).** With the extension sidebar focused and a VS Code `planner-1` open, click the project panel's *Build PRD via planner*. Confirm the prompt lands in the VS Code terminal and that no PTY was targeted. Then close all VS Code agent terminals, leave only a browser PTY planner running, and repeat from the **editor**: it must still refuse (today's behaviour) rather than reaching into the browser fleet.

5. **Browser happy path — PTY planner.** In the browser cockpit, open the Terminals panel and start a `planner` PTY. Then from the browser:
   - memo panel → type an entry → *Send to Planner*;
   - project panel → *Build PRD via planner*, *Build/Update constitution*, *Build AGENTS.md*, *Open architect terminal*;
   - tickets panel → *Ask agent* on a ticket — **this is the one that also proves the `extension.ts:2085` forward**; if every other button works and this one does not, the command boundary is still dropping the flag;
   - board → *Dispatch manager pass* on a selection (role `lead`).

   Each must deliver the prompt into the browser PTY terminal, with no error banner. Before the fix, each raises an error.

6. **Browser happy path — VS Code planner only.** With no PTY fleet running and a VS Code `planner-1` open, repeat step 5 from the browser. Every button must still succeed (fleet branches guard on `_ptyHostPort`, so this degrades to the old path).

7. **Browser failure path is honest.** Close every planner terminal in both fleets, then click memo *Send to Planner*. Expect: an error banner in the browser stating the real reason, `memo.md` **not** cleared (preserved for retry), and the generated prompt on the **browser** clipboard (paste it somewhere to confirm). Before the fix the browser clipboard is untouched despite the message promising otherwise.

8. **Success does not clobber the clipboard.** Put a known string on the browser clipboard, then do a *successful* memo send. Paste — the known string must still be there (proves `prompt` is failure-only).

9. **Rotation cursor unaffected.** With two VS Code planner terminals registered, dispatch twice from the editor and confirm alternation still works (`switchboard.planner.rotationCursor` advances). With a PTY-resolved target, confirm the cursor is *not* advanced and nothing throws.

10. **Explicit root, no ambiguity.** Run the browser checks with the panel's workspace selector set to the same root as `GET /health` → `selectedWorkspaceRoot`, so a primary-vs-selected root mismatch cannot be mistaken for a dispatch failure.

## Recommendation

Complexity 6 → **Send to Coder.**
