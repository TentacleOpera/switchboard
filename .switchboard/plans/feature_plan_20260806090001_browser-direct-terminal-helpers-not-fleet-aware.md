# Four Direct-to-`vscode.Terminal` Helpers Bypass the Dispatcher, So Browser Sends Land in Invisible Terminals and Still Report Success

## Goal

Make the four prompt-delivery helpers that drive `vscode.Terminal` directly — bypassing `_dispatchExecuteMessage` and its fleet routing entirely — reach the terminal the calling surface can display, and stop them reporting success when nothing was delivered.

### Problem

The audit of browser send-to-terminal failures found a second, distinct class: helpers that never touch the dispatcher at all. They resolve and write to `vscode.Terminal` (or create one), so from a browser panel they either send into a window the user cannot see or silently do nothing — and in three of the four cases the reply body still says `{ success: true }`.

| Helper | Location | Delivery mechanism | Browser-reachable via |
|---|---|---|---|
| `PlanningPanelProvider._sendPromptToTerminal` | `:1243-1272` | `HostTerminal` seam: `findByNameContains` → else `create()` → chunked `sendText` | `invokePrdBuilder` (`:4229`), `invokeConstitutionBuilder` (`:4345`), `invokeConstitutionUpdater` (`:4358`), `invokeSystemBuilder` (`:4377`), `openArchitectTerminal` (`:4415`), `sendArtifactPromptToTerminal` (`:3333`), `sendHtmlTweakPrompt` (`:3348`) |
| `TaskViewerProvider.sendPromptToAgentTerminal` | `:4442-4490` | `_registeredTerminals` → `vscode.window.terminals` → else `vscode.window.createTerminal` | `sendStitchTweakPrompt` (`DesignPanelProvider.ts:2953`), `sendHtmlTweakPrompt` (`:2974`), `sendClaudeImportPrompt` (`:2995`), `sendClaudeArtifactPrompt` (`:3017`) |
| `TaskViewerProvider._deliverPromptToPmTerminal` | `:23968+` | registered → open-by-name → host clipboard fallback | `dispatchProjectManager` (`TASKVIEWER_VERBS`, `:11445`) |
| `TaskViewerProvider._handleSendAnalystMessage` | `:19376-19410+` | `_getAgentNameForRole('analyst')` — no root, no flag | `sendAnalystMessage` (`TASKVIEWER_VERBS`, `:12319`) |

### Root cause

**1. No fleet awareness anywhere in these paths.** The PTY fleet lives in an out-of-process pty host; its terminals are not in `vscode.window.terminals`, not in `_registeredTerminals`, and not in the `HostTerminal` seam (`src/services/hostSeams.ts:230-259` — `create`/`findByNameContains` are thin `vscode.window` wrappers). The only way to reach one is `_ptyHostVerb('ptyListTerminals'|'ptySendPrompt', …)`, which is exactly what `_attemptDirectTerminalPush` does when `allowPtyFleet` is set (`TaskViewerProvider.ts:18883-18905`). None of these four helpers has that branch or a parameter to enable it.

The precedent is already in the codebase and its comment states the symptom verbatim. `sendToTerminal` (`:12864-12897`) was fixed this way:

> *"PTY fleet first for HTTP-originated calls, mirroring `_attemptDirectTerminalPush`. Without this arm the verb cannot reach a PTY at all in the extension host: PTYs live in the pty host child, not in `_registeredTerminals` and not in the `HostTerminal` seam, so every browser 'send to terminal' failed as 'not found or not local'."*

These four helpers are the ones that were never migrated.

**2. Creating a terminal makes it worse, not better.** `_sendPromptToTerminal` (`:1249`) and `sendPromptToAgentTerminal` (`:4464`) both *create* a VS Code terminal when no match is found, then `show()` it and send. From the browser that is the worst outcome available: the prompt is delivered into a brand-new VS Code panel terminal the user is not looking at, the agent starts working, and the browser reports success. There is no error to notice.

**3. Success is reported unconditionally.** `_sendPromptToTerminal` returns `Promise<void>` and the design-panel arms return a hardcoded `{ success: true }` immediately after awaiting `sendPromptToAgentTerminal` (`DesignPanelProvider.ts:2957-2962`, `:2978-2983`, `:2999-3004`, `:3021-3027`) — which also returns `void`. So there is no delivery signal to propagate even if a caller wanted to check. `transport.js` sees `success: true`, shows nothing, and the user concludes the send worked.

**4. The clipboard fallbacks are host-side.** `_deliverPromptToPmTerminal` falls back to the clipboard, and the design arms fall back to `this._seams().clipboard.writeText(prompt)` with the message *"Agent terminal unavailable — copied … to clipboard instead."* That writes the **extension host's** clipboard. `src/webview/transport.js:292-296` only reaches the browser clipboard when the reply body carries a `prompt` field, which none of these bodies do. So for a browser user the promised fallback does not exist either.

## Metadata

- **Complexity:** 7
- **Tags:** backend, bugfix, reliability, api
- **Project:** Browser Switchboard

## Complexity Audit

**Complex/risky.** This is the largest of the send-to-terminal plans: four helpers, three providers, eleven call sites, and a deliberate behaviour change (stop creating terminals for api-originated callers).

Risky:

- **Terminal *creation* semantics change for browser callers.** Today a browser send with no matching terminal silently creates and uses a VS Code one. After this change it must not. Deciding what happens instead is a real choice, not a mechanical edit: return a typed failure carrying the prompt so the browser can put it on the user's clipboard. Do **not** create a PTY on the user's behalf — spawning an agent terminal is a deliberate act with a startup command and a cost, and doing it as a side effect of a tweak-prompt button is worse than failing loudly.
- **Return types change from `void` to `boolean`.** `_sendPromptToTerminal`, `sendPromptToAgentTerminal` and `_deliverPromptToPmTerminal` all return `void` and eleven call sites ignore them. Every caller must be updated to propagate the result, or the "reports success when nothing was sent" defect survives the fix in a new place.
- **`sendPromptToAgentTerminal` is public.** Grep for external callers beyond `DesignPanelProvider` before changing its signature; keep the parameter additive (trailing optional) so any caller not updated still compiles with today's semantics.
- **The startup-command path has real timing.** `sendPromptToAgentTerminal` waits 2000ms after creating a terminal and 3000ms after a startup command (`:4475-4480`). The fleet path has no equivalent and needs none, but the *editor* path must keep those waits — removing them to "unify" the two paths will break cold-terminal sends in the editor.
- **Prompt shaping differs per path.** `_sendPromptToTerminal` flattens newlines for a known set of CLI agents (`:1256-1258`) and chunks at 500 chars with 50ms gaps (`:1253-1268`). The fleet path must not re-implement that by hand: `ptySendPrompt` already owns bracketed-paste framing, 256-byte chunking, the per-terminal send lock and the confirm CR (`:18899-18905`). Route through `_dispatchExecuteMessage`, not through a hand-rolled `ptyWrite`.

Routine: no DB work, no migration, no schema change, no new verbs, no UI layout change.

## Edge-Case & Dependency Audit

- **Fail-closed default.** Every new parameter defaults to "not api-originated". Editor callers pass nothing and keep byte-identical behaviour, including terminal creation. This is non-negotiable: an editor send that lands in a browser PTY is a prompt into a window the user is not looking at.
- **PTY host down.** All fleet branches guard on `this._ptyHostPort`. With no fleet, an api-originated call degrades to today's VS Code path — including creation — so a fleet-less browser install is no worse off than now.
- **Roles with no fleet equivalent.** `claude_artifacts`, `claude_import` and `analyst` may exist only as VS Code terminals (`sendPromptToAgentTerminal` even hardcodes the fallback name `'Claude Artifacts'` at `:4447`). The fleet lookup must be *additive*: try the fleet first for api-originated callers, then fall through to the existing VS Code resolution. Never replace the VS Code path.
- **`_deliverPromptToPmTerminal` falls back to the literal name `'Project Manager'`** so the open-terminals scan has something to match. Keep that; add the fleet lookup ahead of it.
- **`_handleSendAnalystMessage` resolves with no workspace root** (`:19393`, `_getAgentNameForRole('analyst')`). That is a latent wrong-workspace bug independent of the fleet. Thread the caller's root in at the same time — resolution and delivery must agree on one root.
- **Two plans touch the same five lines.** The sibling plan `browser-send-to-planner-drops-surface-flag` edits `PlanningPanelProvider.ts:4226/4342/4355/4374/4410` (the `dispatchCustomPromptToRole` call) while this plan edits the `_sendPromptToTerminal` fallback on the *next* line of each arm. Whichever lands second adds one argument to an already-edited block; no logical conflict.
- **`sendHtmlTweakPrompt` exists twice**, in `PlanningPanelProvider.ts:3348` and `DesignPanelProvider.ts:2974`, reaching different helpers. Both are in scope; fix both, do not assume one is dead.
- **Do not delete the clipboard fallbacks.** They are correct for the editor. Add the prompt to the failure *body* so the browser gets one too, and keep the host-side write for editor callers.
- **`showTemporaryNotification` is host-side too.** The design arms' "Sent … to agent terminal" notification is a VS Code toast; in the browser it is invisible. Once the arms return a real result, the browser gets its signal from the reply body, so the notification can stay as-is for the editor.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — a shared fleet-first pre-step

All four helpers need the same thing: "if this caller is api-originated and the fleet has a live terminal for this role/name, deliver there and stop." Add one private helper so it is written once and cannot drift from `_attemptDirectTerminalPush`:

```ts
    /**
     * Fleet-first delivery for helpers that otherwise drive vscode.Terminal directly
     * (_sendPromptToTerminal, sendPromptToAgentTerminal, _deliverPromptToPmTerminal,
     * _handleSendAnalystMessage). PTYs live in the pty host child — not in
     * _registeredTerminals, not in vscode.window.terminals, not in the HostTerminal
     * seam — so a browser-originated send cannot reach one without this step. Mirrors
     * sendToTerminal (:12887) and _attemptDirectTerminalPush (:18883).
     *
     * Delivery goes through _dispatchExecuteMessage so ptySendPrompt owns bracketed-paste
     * framing, chunking, the per-terminal send lock and the confirm CR. Do NOT hand-roll
     * a ptyWrite here — a multi-line prompt written raw runs one fragment per line.
     *
     * Returns false when not applicable (not api-originated, no fleet, no match) so the
     * caller falls through to its existing VS Code path unchanged.
     */
    private async _tryFleetDeliveryForRole(
        role: string,
        prompt: string,
        workspaceRoot: string,
        apiOriginated: boolean,
        metadata: Record<string, any> = {}
    ): Promise<boolean> {
        if (!apiOriginated || !this._ptyHostPort) { return false; }
        const target = await this._resolveAgentTerminalForPlan(role, workspaceRoot, undefined, true);
        if (!target || !this._isValidAgentName(target)) { return false; }
        if (!this._isLikelyPtyDispatchTarget(target, true)) { return false; }
        return await this._dispatchExecuteMessage(workspaceRoot, target, prompt, metadata, 'sidebar', true);
    }
```

### 2. `src/services/PlanningPanelProvider.ts:1243` — `_sendPromptToTerminal`

```ts
-    private async _sendPromptToTerminal(promptText: string, wsRoot: string, name: string, searchSubstrings: string[]): Promise<void> {
+    /**
+     * @param options.apiOriginated True for verb-rail callers (browser cockpit / CLI).
+     * Tries the PTY fleet first, and — critically — does NOT create a VS Code terminal
+     * on miss: creating one delivers the prompt into a window a browser user cannot see
+     * and then reports success, which is worse than failing. Returns whether the prompt
+     * was actually delivered.
+     */
+    private async _sendPromptToTerminal(
+        promptText: string,
+        wsRoot: string,
+        name: string,
+        searchSubstrings: string[],
+        options?: { apiOriginated?: boolean; role?: string }
+    ): Promise<boolean> {
+        const apiOriginated = !!options?.apiOriginated;
+        if (apiOriginated && this._taskViewerProvider) {
+            const role = options?.role || searchSubstrings[0] || 'planner';
+            const delivered = await this._taskViewerProvider.tryFleetDeliveryForRole(
+                role, promptText, wsRoot, true, { source: 'planningPanel', label: name }
+            );
+            if (delivered) { return true; }
+        }
         let handle: TerminalHandle | null = null;
         for (const sub of searchSubstrings) {
             handle = this._seams().terminal.findByNameContains(sub);
             if (handle) { break; }
         }
         if (!handle) {
+            // Never conjure a VS Code terminal for a browser caller.
+            if (apiOriginated) { return false; }
             handle = this._seams().terminal.create(name, undefined, wsRoot);
         }
         handle.show();
         … (chunked sendText unchanged) …
-        handle.sendText('', true);
+        handle.sendText('', true);
+        return true;
     }
```

Expose the new TaskViewerProvider helper as `public async tryFleetDeliveryForRole(...)` (thin wrapper over the private one) since `PlanningPanelProvider` reaches it across providers.

Then at each of the seven call sites, pass the flag and act on the result. Example for `invokePrdBuilder` (`:4229`):

```ts
-                await this._sendPromptToTerminal(promptText, wsRoot, 'PRD Builder', ['planner', 'lead']);
-                break;
+                const sent = await this._sendPromptToTerminal(
+                    promptText, wsRoot, 'PRD Builder', ['planner', 'lead'],
+                    { apiOriginated: !!msg.apiOriginated, role: 'planner' }
+                );
+                if (!sent) {
+                    // `prompt` in the failure body is what puts it on the BROWSER clipboard
+                    // (transport.js:292). The host-side clipboard is useless to a cockpit user.
+                    return { success: false, error: 'No planner terminal could be reached — prompt copied to clipboard instead.', prompt: promptText };
+                }
+                return { success: true };
```

Apply the same shape to `:4345`, `:4358`, `:4377`, `:4415`, `:3333` (`sendArtifactPromptToTerminal`), `:3348` (`sendHtmlTweakPrompt`) with each arm's own role (`planner` / `architect` / `coder` as applicable).

### 3. `src/services/TaskViewerProvider.ts:4442` — `sendPromptToAgentTerminal`

```ts
-    public async sendPromptToAgentTerminal(role: string, text: string, workspaceRoot?: string): Promise<void> {
+    public async sendPromptToAgentTerminal(
+        role: string,
+        text: string,
+        workspaceRoot?: string,
+        options?: { apiOriginated?: boolean }
+    ): Promise<boolean> {
         const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot || '');
-        if (!resolvedWorkspaceRoot) return;
+        if (!resolvedWorkspaceRoot) { return false; }
+        const apiOriginated = !!options?.apiOriginated;
+        if (await this._tryFleetDeliveryForRole(role, text, resolvedWorkspaceRoot, apiOriginated, { source: 'designPanel' })) {
+            return true;
+        }
 
-        const agentName = await this._getAgentNameForRole(role, resolvedWorkspaceRoot) || (role === 'claude_artifacts' ? 'Claude Artifacts' : role);
+        const agentName = await this._getAgentNameForRole(role, resolvedWorkspaceRoot, apiOriginated)
+            || (role === 'claude_artifacts' ? 'Claude Artifacts' : role);
         …
         if (!terminal) {
+            // A browser caller must not have a VS Code terminal spawned on its behalf.
+            if (apiOriginated) { return false; }
             const startupCmd = await this.getAgentStartupCommand(role, resolvedWorkspaceRoot);
             terminal = vscode.window.createTerminal({ … });
             … (2000ms / 3000ms waits unchanged — editor path only) …
         }
         …
+        return true;
     }
```

### 4. `src/services/DesignPanelProvider.ts` — the four send arms (`:2953`, `:2974`, `:2995`, `:3017`)

Each currently awaits and then hardcodes success. Propagate the real result and give the browser its prompt back:

```ts
             case 'sendStitchTweakPrompt': {
                 const prompt = String(message.prompt || '');
                 if (!prompt) return { success: false, error: 'prompt is required' };
                 if (this._taskViewerProvider) {
-                    await this._taskViewerProvider.sendPromptToAgentTerminal('coder', prompt, message.workspaceRoot || undefined);
-                    showTemporaryNotification('Sent element tweak prompt to agent terminal.');
+                    const sent = await this._taskViewerProvider.sendPromptToAgentTerminal(
+                        'coder', prompt, message.workspaceRoot || undefined,
+                        { apiOriginated: !!message.apiOriginated }
+                    );
+                    if (sent) {
+                        showTemporaryNotification('Sent element tweak prompt to agent terminal.');
+                        return { success: true };
+                    }
+                    // Host clipboard for the editor; `prompt` in the body for the browser.
+                    await this._seams().clipboard.writeText(prompt);
+                    showTemporaryNotification('Agent terminal unreachable — copied tweak prompt to clipboard instead.');
+                    return { success: false, error: 'No coder terminal could be reached — prompt copied to clipboard instead.', prompt };
                 } else {
                     await this._seams().clipboard.writeText(prompt);
                     showTemporaryNotification('Agent terminal unavailable — copied tweak prompt to clipboard instead.');
+                    return { success: false, error: 'Agent terminal unavailable — prompt copied to clipboard instead.', prompt };
                 }
-                return { success: true };
             }
```

Identical shape for `sendHtmlTweakPrompt` (`coder`), `sendClaudeImportPrompt` (`claude_import`), `sendClaudeArtifactPrompt` (`claude_artifacts`).

### 5. `src/services/TaskViewerProvider.ts:23968` — `_deliverPromptToPmTerminal`

Add `options?: { apiOriginated?: boolean }`, call `_tryFleetDeliveryForRole('project_manager' /* the PM role key actually used */, prompt, workspaceRoot, apiOriginated)` ahead of the registered/open-by-name lookup, return a boolean, and have `_handleDispatchProjectManager` (`:23938`) accept and forward the flag from the `dispatchProjectManager` arm (`:11445`), reporting failure to the webview instead of returning `{ success: true }` unconditionally.

### 6. `src/services/TaskViewerProvider.ts:19376` — `_handleSendAnalystMessage`

Add `workspaceRoot` and `options?: { apiOriginated?: boolean }` parameters; replace `_getAgentNameForRole('analyst')` (`:19393`) with `_getAgentNameForRole('analyst', resolvedRoot, apiOriginated)`; try `_tryFleetDeliveryForRole('analyst', …)` first. Forward both from the `sendAnalystMessage` arm (`:12319-12323`), which already has `data` in scope.

### 7. `src/test/browser-direct-terminal-helpers.test.js` (new)

Source-level contract test:

1. `_tryFleetDeliveryForRole` exists, guards on `apiOriginated && this._ptyHostPort`, and delivers via `_dispatchExecuteMessage` (not a raw `ptyWrite`).
2. `_sendPromptToTerminal` and `sendPromptToAgentTerminal` return `Promise<boolean>` and both contain an `if (apiOriginated) { return false; }` guard immediately before their terminal-creation call.
3. No `DesignPanelProvider` send arm returns a bare `{ success: true }` after awaiting `sendPromptToAgentTerminal`.
4. Every failure return in these arms carries both `error` and `prompt`; no success return carries `prompt`.
5. Fail-closed: no `options?.apiOriginated` read defaults to `true`.

## Verification Plan

1. **Compile + suite:** `npx tsc --noEmit -p .`, `npm test`. New test green, nothing pre-existing red. `tsc` is load-bearing here — three signatures change from `void` to `boolean` across three providers, and any missed call site shows up as an unused-result or type error.

2. **Editor regression, all four helpers, fail-closed.** From the editor with a VS Code coder/planner terminal open: Stitch tweak → send, HTML tweak → send, Claude import → send, artifact upload → send, PRD/constitution/system builders → send, architect terminal, Project Manager dispatch, analyst message. Every one must behave exactly as today, **including** spawning a terminal when none exists.

3. **Editor cold-terminal creation still works.** Close all agent terminals, then trigger a design send from the editor. A terminal must be created, the startup command run, and the prompt delivered after the existing 2000ms/3000ms settle. This is the behaviour the api-originated guard must not touch.

4. **Browser happy path, fleet present.** With a browser PTY coder + planner running, repeat all of step 2 from the browser cockpit. Every send must land in the browser terminal. Before the fix: the design/tweak sends land in an invisible VS Code terminal (or create one) and report success; the builder sends land in an ad-hoc VS Code terminal.

5. **No terminal conjured for browser callers.** With **no** coder terminal in either fleet, trigger a browser Stitch tweak send. Assert: no new VS Code terminal appears (check the editor's terminal dropdown), the browser shows an error naming the missing role, and the prompt is on the **browser** clipboard (paste to confirm).

6. **Success does not clobber the clipboard.** Put a known string on the browser clipboard, then do a *successful* browser design send. Paste — the known string must survive (proves `prompt` is failure-only).

7. **Browser Project Manager + analyst.** Dispatch the Project Manager from the browser and send an analyst message from the browser; both must reach browser terminals, and both must report a real failure (not silent success) when no such terminal exists.

8. **Fleet-less browser install.** Stop the PTY host and repeat step 4 from the browser. Sends must fall through to the VS Code path minus creation — i.e. deliver if a matching VS Code terminal happens to exist, otherwise fail loudly with the prompt in the body. Nothing may hang.

9. **Prompt fidelity on the fleet path.** Send a multi-line prompt (the PRD builder prompt is multi-line) to a browser terminal and confirm the agent receives it as **one** prompt, not one fragment per line — this is what routing through `_dispatchExecuteMessage`/`ptySendPrompt` buys, and a hand-rolled `ptyWrite` would break it.
