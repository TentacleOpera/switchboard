# Four Dispatch Sites Hardcode the VS Code Fleet, So Orchestrator / Pair-Program / Airlock Sends Die in the Browser

## Goal

Make the four `_dispatchExecuteMessage` call sites that never pass `allowPtyFleet` surface-aware, so an orchestrator kickoff, an orchestrator wake, a pair-programming coder send, and an Airlock send-to-coder all reach the terminal the *calling surface* can display — including a browser PTY terminal.

### Problem

`_dispatchExecuteMessage` takes a trailing `allowPtyFleet` flag that decides whether delivery may reach the PTY fleet (the browser Terminals panel) or is restricted to `vscode.Terminal` instances:

```ts
// src/services/TaskViewerProvider.ts:18784-18790
private async _dispatchExecuteMessage(
    workspaceRoot: string,
    targetAgent: string,
    payload: string,
    metadata: Record<string, any>,
    sender: string = 'sidebar',
    allowPtyFleet: boolean = false
): Promise<boolean>
```

> **Superseded:** "Of its eight call sites, only two pass it."
> **Reason:** Verified against `src/services/TaskViewerProvider.ts` on 2026-08-06 — there are **seven** call sites, not eight: `:4675`, `:5411`, `:9387`, `:9975`, `:10923`, `:19316`, `:21411`. The count matters because the plan's own contract test asserts on it (see Proposed Changes §4); a wrong number makes the test fail on correct code.
> **Replaced with:** seven call sites — two pass the flag (`:5411` batch dispatch, `:19316` single-card dispatch), five do not. Four of those five are owned here; the fifth (`:4675`) belongs to the sibling plan.

Of its seven call sites, only two pass it (`:5411` batch dispatch, `:19316` single-card dispatch). Four of the remaining five are owned by this plan and are therefore permanently VS Code-only, even when the caller is the browser:

| Site | What it sends | Resolution call | Browser entry point |
|---|---|---|---|
| `:9387` | Orchestrator **kickoff** prompt to `ORCHESTRATOR_TERMINAL_NAME` | fixed name, no resolution | `startOrchestrator` (`KANBAN_VERBS`) → board AUTOMATION tab |
| `:10923` | Orchestrator **wake** prompt to `ORCHESTRATOR_TERMINAL_NAME` | fixed name, no resolution | autoban wake timer, armed from the same browser click |
| `:9975` | Pair-programming prompt to the coder | `:9972` `_resolveAgentTerminalForPlan('coder', workspaceRoot, worktreePath)` — **3-arg**, `allowPtyFleet` defaults false | `dispatchToCoderTerminal` via `:5459` (batch dispatch, pair mode), `switchboard.dispatchToCoderTerminal` (`src/extension.ts:1773`), **and the board's own pair-programming chain — `KanbanProvider._dispatchWithPairProgrammingIfNeeded` (`:5521`) → `executeCommand('switchboard.dispatchToCoderTerminal', …)` (`:5549`), which has 10 call sites** |
| `:21411` | Airlock patch prompt to the coder | `:21403` `_getAgentNameForRole('coder')` — **no workspaceRoot, no flag** | `airlock_sendToCoder` (`TASKVIEWER_VERBS`) |

(The remaining site, `:4675`, is `dispatchCustomPromptToRole` — owned by the sibling plan `browser-send-to-planner-drops-surface-flag`.)

### Scope correction — the pair-programming chain is the board's main path, and it was missed

> **Superseded:** the pair-programming entry points are "`dispatchToCoderTerminal` via `:5459` (batch dispatch, pair mode) and `switchboard.dispatchToCoderTerminal` (`src/extension.ts:1773`)".
> **Reason:** Verified 2026-08-06. There is a third, larger chain the original audit missed: `KanbanProvider._dispatchWithPairProgrammingIfNeeded` (`KanbanProvider.ts:5521-5551`) ends in `await this._seams().commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt, worktreePath)` at `:5549` — **two arguments, no surface flag** — and it is invoked from **ten** call sites: `:8110`, `:8165`, `:8203`, `:8802`, `:8886`, `:9055`, `:9198`, `:9345`, `:9454`. This is the path a *board* dispatch actually takes when pair-programming mode is on, i.e. the browser's primary entry point for this defect. Threading the flag only through `TaskViewerProvider:5459` and `extension.ts:1773` would leave the browser board's pair-programming sends VS Code-only, and every source-level contract test in this plan would still pass.
> **Replaced with:** the chain is in scope. `_dispatchWithPairProgrammingIfNeeded` takes a trailing `options?: { apiOriginated?: boolean }` and forwards it as the command's third argument; all ten call sites pass it. The flag is already in scope at those sites — `:8101` reads `!!msg?.apiOriginated` for the main dispatch on the line immediately above `:8110`, so the value is available and merely discarded today.

This raises the plan's real size from "four one-line parameter additions" to four sites plus one KanbanProvider signature change with ten call sites, two orchestrator entry points, and one handler signature change (airlock). The complexity score is raised accordingly (5 → 6).

### Root cause

The surface information exists at every one of these entry points and is discarded on the way in.

`LocalApiServer._stampHttpSurface` (`src/services/LocalApiServer.ts:1755-1765`) puts `apiOriginated: true` on every verb-rail body, precisely so downstream code can tell a browser/CLI caller from the in-process sidebar. The comment on it is explicit: *"the previous per-caller convention left every browser panel dispatching into invisible VS Code terminals."* That is exactly the state these four sites are still in — they were never migrated when the discriminator was introduced.

Consequences, per site:

1. **Orchestrator kickoff (`:9387`).** Starting the orchestrator from the browser AUTOMATION tab creates/【re-uses】the orchestrator terminal, then dispatches the kickoff prompt with `allowPtyFleet=false`. If the orchestrator terminal is a PTY, `_attemptDirectTerminalPush` (`:18883`) skips the fleet, finds no `vscode.Terminal`, and the run is dead on arrival — the terminal exists and sits idle with no prompt. Worse, the `createdNew` path already waited 1500ms for the CLI to be ready (`:9386`), so the failure looks like a timing problem rather than a routing one.
2. **Orchestrator wake (`:10923`).** Same target, same defect, but on a timer — so an unattended overnight run silently never wakes. The return value *is* captured here (`ok = await …`), which makes this the cheapest site to verify.
3. **Pair programming (`:9975`).** Two defects stacked: resolution can't see a PTY coder (3-arg call at `:9972`), and even a correctly-named target can't be delivered to. The user-facing report is `"Pair Program: no Coder terminal found. Please register a Coder terminal first."` (`:9974`) — a VS Code toast, invisible in the browser, so the browser user sees nothing happen at all.
4. **Airlock send-to-coder (`:21411`).** `_getAgentNameForRole('coder')` is called with **no** `workspaceRoot`, so it resolves against `_resolveStateFilePath(undefined)` → the selected root, which may not be the root the browser panel is scoped to; and with `allowPtyFleet` false it skips PTY rows outright. The failure path does post `airlock_coderError` to the webview (`:21406`), so the browser at least sees *an* error — but the message ("No Coder agent assigned. Assign a terminal role first.") is wrong when a browser coder is running.

## Metadata

- **Complexity:** 6
- **Tags:** backend, bugfix, reliability
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 5
> **Reason:** The scope correction above adds a KanbanProvider signature change with ten call sites, a second orchestrator entry point (`TaskViewerProvider.ts:2390`, the LocalApiServer `orchestrationStart` callback), and a confirmed handler-signature change for the airlock arm (`data` is not in scope there). That is multi-file coordination across three providers plus `extension.ts`, not a set of one-line parameter additions.
> **Replaced with:** **Complexity:** 6

## User Review Required

None. The one genuine design decision — whether the orchestrator's starting surface is remembered on run state or re-read per dispatch — is resolved in Proposed Changes §1 (remembered on run state, because the wake fires from a timer with no request in scope). No open questions for the user.

## Complexity Audit

**Complex/risky — small per-site diff, but five independent call chains, one signature change with ten call sites, and one chain that is unattended automation.**

### Routine

- No DB work, no migration, no schema change, no new verb, no UI change.
- Every fleet branch this enables is already implemented and exercised by `:5411` / `:19316`.
- The ten `_dispatchWithPairProgrammingIfNeeded` call sites take an identical mechanical edit, and the value they need (`!!msg?.apiOriginated`) is already in scope at each one.
- No return-contract ratchet impact: this plan converts no `break` to `return` in any provider's `_handleMessage`, so `scripts/verb-return-contract-baseline.json` is untouched.

### Complex / Risky

- **The orchestrator sites are unattended.** A regression here does not throw an error a human sees; it silently stops a batch overnight. Both sites must be verified by observing the prompt actually land in the terminal, not by a green test.
- **Fail-closed default must survive.** `allowPtyFleet` must stay `false`-by-default at every layer. The editor's own orchestrator/pair/airlock flows must keep VS Code-only routing — a sidebar dispatch that lands in a browser PTY is a prompt sent into a window the user is not looking at, which is the exact bug the flag was introduced to prevent.
- **The orchestrator's surface is *persistent*, not per-request.** Kickoff comes from an HTTP click, but the wake fires from a timer with no request in scope. The flag therefore has to be *remembered* for the duration of the orchestrator run, not read from a body. This is the one genuine design decision in the plan (see Proposed Changes) and the only part that is not a mechanical parameter addition.
- **Pair programming has an existing test suite** (`src/test/pair-programming-comprehensive.test.ts:85,156-178,299`) that asserts on `switchboard.dispatchToCoderTerminal` being invoked with `(prompt, worktreePath)`. Adding a third argument must keep those `calledWithMatch` assertions passing — verified: they match on the command **name** only (`calledWithMatch('switchboard.dispatchToCoderTerminal')` at `:156`, and a negative form at `:178`), so an appended optional argument is safe. The command registration in `src/extension.ts:1773-1775` must forward it.
- **Two orchestrator start entry points, not one.** `startOrchestratorFromKanban(workspaceRoot?, initiatorProject?)` (`TaskViewerProvider.ts:9231`) is reached from (a) `KanbanProvider.ts:7881`, the `startOrchestrator` verb arm, where `msg.apiOriginated` is in scope, and (b) `TaskViewerProvider.ts:2390`, the LocalApiServer `orchestrationStart` callback, which is HTTP **by construction** and must therefore pass `true` unconditionally rather than reading a body it does not have. Missing (b) leaves `POST`-driven orchestrator runs VS Code-only while the board button works — the worst kind of partial fix, because the two paths are documented as equivalent (`LocalApiServer.ts:2220`: "the same path the AUTOMATION tab button" takes).

## Edge-Case & Dependency Audit

- **PTY host down.** Every fleet branch is guarded on `this._ptyHostPort` (`:18777`, `:18883`, `:8276`). With no fleet, passing `allowPtyFleet=true` is a no-op and behaviour is byte-identical to today. So the change cannot break a fleet-less install.
- **Same name in both fleets.** A VS Code `coder-1` and a PTY `coder-1` normalize to the same agent key. `_attemptDirectTerminalPush` resolves this deliberately — fleet first *when opted in* (`:18877-18883`), because that is the terminal the calling surface can show. Browser click → PTY; editor click → VS Code terminal. No new tie-break logic needed.
- **Orchestrator terminal may be created in either fleet.** Check how the orchestrator terminal is created on the browser path before assuming a PTY: if the browser's Start-orchestrator still creates a *VS Code* terminal, then the correct fix for `:9387`/`:10923` is to create it in the fleet the caller can see, and the flag alone is insufficient. Verify by starting the orchestrator from the browser and looking at which panel the terminal appears in. If it lands in VS Code, this plan additionally covers routing creation through the fleet for api-originated starts.
- **Focus call must become conditional.** Neither `:9387` nor `:10923` focuses a terminal today, so nothing to guard there. `dispatchToCoderTerminal` (`:9964-9979`) also does not focus. Only `:21411` (airlock) is silent too. So unlike `dispatchCustomPromptToRole`, no `_isLikelyPtyDispatchTarget` guard is needed at these four sites — do not add one speculatively.
- **Airlock's missing `workspaceRoot`.** `:21403` calls `_getAgentNameForRole('coder')` with no root. Even after threading the flag, this is a latent wrong-workspace bug. Pass the `workspaceRoot` the handler already has in scope (`:21411` uses it) so resolution and delivery agree on one root.
- **Pair-programming worktree routing.** `:9972` passes `worktreePath` as the third argument, which is correct and must be preserved — `_findTerminalNameByWorktreePathAndRole` is the worktree-aware branch and it takes `allowPtyFleet` as its *fourth* argument (`:8294-8300`). Append, do not reorder.
- **`ok` is discarded at three of four sites.** `:9387`, `:9975`, `:21411` ignore the boolean. Once delivery can succeed for browser callers, a discarded `false` means "orchestrator started" / "sent to coder" is reported to the browser when nothing arrived. Capture and report it at each site.
- **Reference implementation to copy.** `sendToTerminal` (`:12864-12897`) already does exactly this correctly: `if (data?.apiOriginated && this._ptyHostPort) { … ptyListTerminals … ptyWrite … }` with a comment recording that *"every browser 'send to terminal' failed as 'not found or not local'"* before it was added. Mirror its structure rather than inventing a new shape.
- **Do not switch `ptyWrite` for `ptySendPrompt` or vice versa.** `_attemptDirectTerminalPush` deliberately uses `ptySendPrompt` (`:18899-18905`) because the child owns bracketed-paste framing, chunking and the send lock; `sendToTerminal` deliberately uses `ptyWrite` because it mirrors a bare line submit. These four sites all send multi-line prompts, so they must go through `_dispatchExecuteMessage` (i.e. `ptySendPrompt`) — do not hand-roll a `ptyWrite`.

## Dependencies

- None blocking. No session dependency (`sess_*`) applies.
- Sibling coupling (same feature): `browser-direct-terminal-helpers-not-fleet-aware` adds a new `_dispatchExecuteMessage` call site, which interacts with this plan's contract test — see Proposed Changes §4.1. Whichever lands second must confirm the property assertion still holds; nothing needs reordering.
- Sibling coupling: `browser-send-to-planner-drops-surface-flag` owns the seventh `_dispatchExecuteMessage` site (`:4675`). Independent of this plan's four.

## Adversarial Synthesis

**Risk summary.** Two risks dominate. First, silent unattended failure: the orchestrator wake fires from a timer with no request in scope, so if the remembered surface is wrong (or never set at the LocalApiServer `orchestrationStart` entry point) an overnight batch simply never wakes and nothing reports it — which is why both orchestrator sites must be verified by reading the terminal, never by a green test or a log line. Second, an incomplete fix that tests green: the pair-programming chain reaches `dispatchToCoderTerminal` through `KanbanProvider._dispatchWithPairProgrammingIfNeeded` (10 call sites), and a fix confined to the two originally-listed callers passes every source-level assertion while the browser board's pair sends stay VS Code-only. Mitigations: set the run-state flag at both start entry points and reset it on stop; assert *properties* over all call sites rather than counts; capture and report the discarded `ok` at the three sites that drop it; and keep the `false` default at every layer so a sidebar dispatch can never land in a terminal VS Code cannot show.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — orchestrator kickoff (`:9387`) and wake (`:10923`)

The wake has no request in scope, so store the starting surface on the orchestrator run state when it is started, and read it at both dispatch sites.

Add a field next to the other orchestrator run state:

```ts
    /**
     * Which surface started the current orchestrator run. The kickoff arrives on an
     * HTTP click (apiOriginated stamped by LocalApiServer._stampHttpSurface), but the
     * WAKE fires from a timer with no request in scope — so the surface has to be
     * remembered for the life of the run rather than read from a body. Reset on stop.
     * false = started from the VS Code sidebar (fail-closed default).
     */
    private _orchestratorApiOriginated = false;
```

Set it at **both** start entry points and clear it on stop. `startOrchestratorFromKanban` (`:9231`) gains a trailing surface parameter:

```ts
-    public async startOrchestratorFromKanban(workspaceRoot?: string, initiatorProject?: string | null): Promise<void> {
+    public async startOrchestratorFromKanban(
+        workspaceRoot?: string,
+        initiatorProject?: string | null,
+        options?: { apiOriginated?: boolean }
+    ): Promise<void> {
+        // Remember the starting surface for the life of the run — the WAKE dispatch
+        // has no request in scope. Fail-closed default: a sidebar start stays VS Code-only.
+        this._orchestratorApiOriginated = !!options?.apiOriginated;
```

and `stopOrchestratorFromKanban` (`:9417`) resets it:

```ts
+        this._orchestratorApiOriginated = false;
```

Both callers must pass it:

- `src/services/KanbanProvider.ts:7881` — the `startOrchestrator` verb arm, where the flag is in scope:
  ```ts
  -                    await this._taskViewerProvider.startOrchestratorFromKanban(workspaceRoot);
  +                    await this._taskViewerProvider.startOrchestratorFromKanban(workspaceRoot, undefined, { apiOriginated: !!msg?.apiOriginated });
  ```
- `src/services/TaskViewerProvider.ts:2390` — the LocalApiServer `orchestrationStart` callback. This path is HTTP **by construction** (there is no in-process caller), so it passes `true` unconditionally rather than reading a body it does not receive:
  ```ts
               orchestrationStart: async (wsRoot) => {
  -                await this.startOrchestratorFromKanban(wsRoot);
  +                // POST /kanban/orchestration/start — an HTTP caller by definition, so the
  +                // surface is known statically here. There is no body to stamp.
  +                await this.startOrchestratorFromKanban(wsRoot, undefined, { apiOriginated: true });
               },
  ```

Then at the two dispatch sites:

```ts
-        await this._dispatchExecuteMessage(root, ORCHESTRATOR_TERMINAL_NAME, kickoffPrompt, { orchestrationKickoff: true });
+        const kickoffSent = await this._dispatchExecuteMessage(
+            root, ORCHESTRATOR_TERMINAL_NAME, kickoffPrompt,
+            { orchestrationKickoff: true }, 'sidebar', this._orchestratorApiOriginated
+        );
+        if (!kickoffSent) {
+            // Silent failure here means the orchestrator terminal sits idle forever and the
+            // board reports a run that never started. Surface it instead.
+            this._seams().ui.showErrorMessage(
+                `Orchestrator kickoff could not be delivered to '${ORCHESTRATOR_TERMINAL_NAME}'. The run did not start.`
+            );
+            this.postMessage({ type: 'orchestratorStartResult', success: false, error: 'kickoff prompt not delivered' });
+            return;
+        }
```

```ts
-                ok = await this._dispatchExecuteMessage(root, ORCHESTRATOR_TERMINAL_NAME, wakePrompt, { orchestrationWake: true });
+                ok = await this._dispatchExecuteMessage(
+                    root, ORCHESTRATOR_TERMINAL_NAME, wakePrompt,
+                    { orchestrationWake: true }, 'sidebar', this._orchestratorApiOriginated
+                );
```

(`ok` is already consumed at `:10923`; no further change there.)

### 2. `src/services/TaskViewerProvider.ts` — pair-programming coder (`:9964-9979`)

```ts
-    public async dispatchToCoderTerminal(prompt: string, worktreePath?: string): Promise<void> {
+    /**
+     * @param options.apiOriginated True when the caller is a verb rail (browser cockpit /
+     * CLI). Becomes allowPtyFleet for BOTH resolution and delivery so a browser-side coder
+     * PTY is reachable. Defaults false — sidebar/autoban callers keep VS Code-only routing.
+     */
+    public async dispatchToCoderTerminal(
+        prompt: string,
+        worktreePath?: string,
+        options?: { apiOriginated?: boolean }
+    ): Promise<boolean> {
         const workspaceRoot = this._resolveWorkspaceRoot();
         if (!workspaceRoot) {
             this._seams().ui.showWarningMessage('Pair Program: no workspace root found.');
-            return;
+            return false;
         }
-        const coderAgent = await this._resolveAgentTerminalForPlan('coder', workspaceRoot, worktreePath);
+        const allowPtyFleet = !!options?.apiOriginated;
+        // Fourth arg is the fix — without it the PTY branch at :8276 is skipped and a
+        // browser-only coder is invisible. worktreePath stays the third arg.
+        const coderAgent = await this._resolveAgentTerminalForPlan('coder', workspaceRoot, worktreePath, allowPtyFleet);
         if (!coderAgent) {
             this._seams().ui.showWarningMessage('Pair Program: no Coder terminal found. Please register a Coder terminal first.');
-            return;
+            return false;
         }
-        await this._dispatchExecuteMessage(workspaceRoot, coderAgent, prompt, {
-            batch: true,
-            pairProgramming: true
-        });
+        return await this._dispatchExecuteMessage(workspaceRoot, coderAgent, prompt, {
+            batch: true,
+            pairProgramming: true
+        }, 'sidebar', allowPtyFleet);
     }
```

Callers — all three chains:

- `src/services/TaskViewerProvider.ts:5459` — inside the batch-dispatch pair path, where `allowPtyFleet` is already computed at `:5320`. Pass it: `await this.dispatchToCoderTerminal(coderPrompt, group.worktreePath, { apiOriginated: allowPtyFleet });`
- `src/extension.ts:1773-1775` — forward a third argument through the command registration:
  ```ts
  registerSwitchboardCommand('switchboard.dispatchToCoderTerminal',
      async (prompt: string, worktreePath?: string, options?: { apiOriginated?: boolean }) => {
          await taskViewerProvider.dispatchToCoderTerminal(prompt, worktreePath, options);
      });
  ```
- **`src/services/KanbanProvider.ts:5521-5551` — `_dispatchWithPairProgrammingIfNeeded`, the board's own pair-programming chain (the site the original audit missed).** Add a trailing surface parameter and forward it as the command's third argument:
  ```ts
       private async _dispatchWithPairProgrammingIfNeeded(
           cards: KanbanCard[],
  -        workspaceRoot: string
  +        workspaceRoot: string,
  +        options?: { apiOriginated?: boolean }
       ): Promise<void> {
           …
  -            await this._seams().commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt, worktreePath);
  +            // Third arg is the fix: without it the pair-programming coder send is
  +            // VS Code-only even when the board click came from the browser cockpit.
  +            // The value is already in scope at every call site (see :8101).
  +            await this._seams().commands.executeCommand(
  +                'switchboard.dispatchToCoderTerminal', coderPrompt, worktreePath,
  +                { apiOriginated: !!options?.apiOriginated }
  +            );
       }
  ```
  Then pass `{ apiOriginated: !!msg?.apiOriginated }` at all **ten** call sites: `:8110`, `:8165`, `:8203`, `:8802`, `:8886`, `:9055`, `:9198`, `:9345`, `:9454`. At each of these, `msg` is the same object the surrounding dispatch already reads the flag from (e.g. `:8101` `apiOriginated: !!msg?.apiOriginated`), so this is a copy of the adjacent line — not a new derivation. Do **not** invent a different source for the flag at any site; if `msg` is genuinely out of scope at one of them, thread it rather than defaulting to `true`.

### 3. `src/services/TaskViewerProvider.ts` — Airlock send-to-coder (`:21398-21418`)

```ts
-            const targetAgent = await this._getAgentNameForRole('coder');
+            // Pass the root explicitly (it is already in scope and used on the dispatch
+            // line below) so resolution and delivery agree on one workspace, and pass the
+            // surface flag so a browser coder PTY is eligible.
+            const allowPtyFleet = !!data?.apiOriginated;
+            const targetAgent = await this._getAgentNameForRole('coder', workspaceRoot, allowPtyFleet);
 
             if (!targetAgent) {
                 this.postMessage({ type: 'airlock_coderError', message: 'No Coder agent assigned. Assign a terminal role first.' });
                 return;
             }
 
             const payload = `This is a patch from the Airlock. …`;
-            await this._dispatchExecuteMessage(workspaceRoot, targetAgent, payload, {
-                source: 'airlock',
-                patchFile: patchPath,
-            }, 'airlock');
-
-            this.postMessage({ type: 'airlock_coderSent' });
+            const sent = await this._dispatchExecuteMessage(workspaceRoot, targetAgent, payload, {
+                source: 'airlock',
+                patchFile: patchPath,
+            }, 'airlock', allowPtyFleet);
+
+            // Reporting 'sent' on a failed delivery is what made this read as a silent
+            // no-op in the browser: the patch file was written, nothing was dispatched.
+            if (!sent) {
+                this.postMessage({
+                    type: 'airlock_coderError',
+                    message: `Patch written to ${patchPath}, but the prompt could not be delivered to '${targetAgent}'.`
+                });
+                return;
+            }
+            this.postMessage({ type: 'airlock_coderSent' });
```

**`data` is NOT in scope here — the handler signature must change.** Verified 2026-08-06: the enclosing method is `private async _handleAirlockSendToCoder(text: string): Promise<void>` (`:21380`) — it receives only the patch text. Thread the flag in from the `airlock_sendToCoder` arm:

```ts
-    private async _handleAirlockSendToCoder(text: string): Promise<void> {
+    private async _handleAirlockSendToCoder(text: string, options?: { apiOriginated?: boolean }): Promise<void> {
```

and at the `airlock_sendToCoder` arm, pass `{ apiOriginated: !!data.apiOriginated }`. Note `workspaceRoot` at `:21385` comes from `this._resolveWorkspaceRoot()` with **no argument**, i.e. the selected/primary root rather than the panel's — the same latent wrong-workspace bug flagged in the dependency audit. Passing that same `workspaceRoot` into `_getAgentNameForRole` (as this plan does) at least makes resolution and delivery agree on one root, which is the fix in scope; re-scoping the airlock handler to the panel's root is not.

### 4. `src/test/browser-stray-dispatch-surface.test.js` (new)

Source-level contract test, matching the suite's existing style:

1. Every `_dispatchExecuteMessage(` call site in `TaskViewerProvider.ts` passes **six** arguments (i.e. no site relies on the `allowPtyFleet` default).

   > **Superseded:** "Assert on the count of call sites so a newly added site fails the test rather than slipping through."
   > **Reason:** The sibling plan `browser-direct-terminal-helpers-not-fleet-aware` **adds** an eighth call site (its shared `_tryFleetDeliveryForRole` helper delivers through `_dispatchExecuteMessage`). A hardcoded count would turn that correct change into a red test, and the coder's likely reaction — bump the number — silently removes the guard. Asserting the *property* over every site is strictly stronger anyway: a new site that omits the flag fails on its own merits, no count needed.
   > **Replaced with:** assert the property over **every** matched call site (all pass an explicit sixth argument), and additionally assert the count is **≥ 7** as a discovery floor — never an equality. If a future change legitimately raises it, the floor still holds.

2. `_orchestratorApiOriginated` exists, is initialised `false`, is **set at both start entry points** (`KanbanProvider.ts:7881` from `msg`, `TaskViewerProvider.ts:2390` as a literal `true`), is reset in `stopOrchestratorFromKanban`, and is read at both orchestrator dispatch sites.
3. `dispatchToCoderTerminal` declares an `options` parameter, returns `Promise<boolean>`, and passes a 4th arg to `_resolveAgentTerminalForPlan`.
4. The airlock arm passes `workspaceRoot` to `_getAgentNameForRole` and gates `airlock_coderSent` on the delivery result.
5. `KanbanProvider._dispatchWithPairProgrammingIfNeeded` declares an `options` parameter, forwards it as the third argument to `executeCommand('switchboard.dispatchToCoderTerminal', …)`, and **every one of its call sites passes an `apiOriginated` value** — count them and assert none uses the 2-arg form. This is the assertion that would have caught the missed chain.
6. Fail-closed: no `options?.apiOriginated` read in any of the touched files defaults to a literal `true`, except the `orchestrationStart` callback at `TaskViewerProvider.ts:2390`, which must be allowlisted by name in the test with the reason (HTTP-only path, no body to read).

## Verification Plan

### Automated Tests

1. **Compile + suite:** `npx tsc --noEmit -p .` and `npm test`. New contract test green; `pair-programming-comprehensive` must stay green (its assertions match on the command name at `:156`/`:178`, so the appended argument is safe — confirmed by reading the test, but re-run it).
2. **Ratchet + parity unchanged:** `npm run verb-returns:check`, `npm run parity:check`, `npm run push-routing:check` pass with **no baseline edit**. This plan converts no `break` to `return`.
3. **New test must fail pre-fix.** Stash the changes and run `browser-stray-dispatch-surface`; it must name the four bare `_dispatchExecuteMessage` sites and the 2-arg `executeCommand('switchboard.dispatchToCoderTerminal', …)` at `KanbanProvider.ts:5549`.

### Manual / UAT

4. **Editor regression, fail-closed.** With only a VS Code coder terminal open, run a pair-programming dispatch from the editor board and confirm the prompt lands there. Then close it, leave only a browser PTY coder running, and repeat from the **editor**: it must still refuse (VS Code-only), proving the default did not flip.

5. **Browser orchestrator kickoff.** From the browser board AUTOMATION tab, Start orchestrator. Confirm: the orchestrator terminal receives the kickoff prompt (visible text beginning "You are the Switchboard orchestrator"), and the board does not report a started run if delivery failed. Note which panel the terminal appeared in — if it appears in VS Code rather than the browser fleet, apply the creation-side fix flagged in the dependency audit before signing this off.

6. **Orchestrator start over HTTP, not just the button.** `POST /kanban/orchestration/start` (the `orchestrationStart` callback at `TaskViewerProvider.ts:2390`) must also deliver the kickoff. Curl it and read the terminal. This is the entry point the original plan missed; a working AUTOMATION-tab button proves nothing about it.

7. **Browser orchestrator wake.** With the run armed, wait for (or force) a wake tick and confirm the wake prompt arrives in the same terminal. This is the site that silently killed unattended runs, so verify by reading the terminal, not by a log line.

8. **Browser pair programming — via the board, not just the batch path.** Enable pair-programming mode, then dispatch a **lead**-role card from the browser board so the flow goes through `KanbanProvider._dispatchWithPairProgrammingIfNeeded` (`:8110` is the site reached by a single-card lead dispatch). Confirm the coder prompt lands in the browser coder PTY. Repeat via a batch/high-complexity dispatch (`:8802`/`:8886`) to cover the second family of call sites. Before the fix nothing happens and the only report is an invisible VS Code toast.

9. **Browser airlock.** From the NotebookLM/Airlock surface in the browser, send a patch to the coder. Confirm the prompt arrives in the browser coder terminal. Then close every coder terminal and repeat: the browser must show `airlock_coderError` naming the patch path, and must **not** show "sent".

10. **Fleet-less install.** Stop the PTY host (`terminalFleet` false in `/health`-derived capabilities) and re-run steps 4, 8 and 9 from the editor. Everything must behave exactly as before the change.

11. **Worktree routing preserved.** Dispatch a pair-programming card whose plan lives in a worktree and confirm it still routes to that worktree's coder terminal (the third argument was not displaced by the new fourth one).

## Recommendation

Complexity 6 → **Send to Coder.**
