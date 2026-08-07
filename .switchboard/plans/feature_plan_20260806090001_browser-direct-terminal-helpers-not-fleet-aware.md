# Four Direct-to-`vscode.Terminal` Helpers Bypass the Dispatcher, So Browser Sends Land in Invisible Terminals and Still Report Success

## Goal

Make the four prompt-delivery helpers that drive `vscode.Terminal` directly — bypassing `_dispatchExecuteMessage` and its fleet routing entirely — reach the terminal the calling surface can display, and stop them reporting success when nothing was delivered.

### Problem

The audit of browser send-to-terminal failures found a second, distinct class: helpers that never touch the dispatcher at all. They resolve and write to `vscode.Terminal` (or create one), so from a browser panel they either send into a window the user cannot see or silently do nothing — and in three of the four cases the reply body still says `{ success: true }`.

| Helper | Location | Delivery mechanism | Browser-reachable via |
|---|---|---|---|
| `PlanningPanelProvider._sendPromptToTerminal` | `:1243-1272` | `HostTerminal` seam: `findByNameContains` → else `create()` → chunked `sendText` | `invokePrdBuilder` (`:4229`), `invokeConstitutionBuilder` (`:4345`), `invokeConstitutionUpdater` (`:4358`), `invokeSystemBuilder` (`:4377`), `openArchitectTerminal` (`:4415`) — **5 sites** |
| `TaskViewerProvider.sendPromptToAgentTerminal` | `:4442-4490` | `_registeredTerminals` → `vscode.window.terminals` → else `vscode.window.createTerminal` | `sendStitchTweakPrompt` (`DesignPanelProvider.ts:2957`), `sendHtmlTweakPrompt` (`:2978`), `sendClaudeImportPrompt` (`:2999`), `sendClaudeArtifactPrompt` (`:3022`), `sendArtifactPromptToTerminal` (`PlanningPanelProvider.ts:3335`), `sendHtmlTweakPrompt` (`PlanningPanelProvider.ts:3352`) — **6 sites** |
| `TaskViewerProvider._deliverPromptToPmTerminal` | `:23968` | registered → open-by-name → host clipboard fallback | `dispatchProjectManager` (`TASKVIEWER_VERBS`, `:11445` → `_handleDispatchProjectManager` `:23938` → `:23959`) **and the targeted-pass handler at `:24081`** — 2 callers |
| `TaskViewerProvider._handleSendAnalystMessage` | `:19376-19410+` | `_getAgentNameForRole('analyst')` — no root, no flag | `sendAnalystMessage` (`TASKVIEWER_VERBS`, `:12321`), the archive-query arm (`:12856`), and two internal `analystMap` callers (`:5024`, `:19520`) |

> **Superseded:** `_sendPromptToTerminal` is reached from seven call sites including `sendArtifactPromptToTerminal` (`:3333`) and `sendHtmlTweakPrompt` (`:3348`).
> **Reason:** Verified 2026-08-06 by grepping both symbols. `_sendPromptToTerminal` has exactly **five** call sites (`4229`, `4345`, `4358`, `4377`, `4415`). The two artifact/tweak arms in `PlanningPanelProvider` call **`sendPromptToAgentTerminal`** instead (at `:3335` and `:3352`) — a different helper with different semantics (it spawns with a startup command and 2000/3000 ms waits; `_sendPromptToTerminal` creates a bare terminal and chunks at 500 chars). A coder following the original attribution would add the surface parameter to the wrong helper for those two arms and leave them broken.
> **Replaced with:** the corrected table above. The eleven-call-site total is unchanged (5 + 6); only the attribution moves.

### Root cause

**1. No fleet awareness anywhere in these paths.** The PTY fleet lives in an out-of-process pty host; its terminals are not in `vscode.window.terminals`, not in `_registeredTerminals`, and not in the `HostTerminal` seam (`src/services/hostSeams.ts:230-259` — `create`/`findByNameContains` are thin `vscode.window` wrappers). The only way to reach one is `_ptyHostVerb('ptyListTerminals'|'ptySendPrompt', …)`, which is exactly what `_attemptDirectTerminalPush` does when `allowPtyFleet` is set (`TaskViewerProvider.ts:18883-18905`). None of these four helpers has that branch or a parameter to enable it.

The precedent is already in the codebase and its comment states the symptom verbatim. `sendToTerminal` (`:12864-12897`) was fixed this way:

> *"PTY fleet first for HTTP-originated calls, mirroring `_attemptDirectTerminalPush`. Without this arm the verb cannot reach a PTY at all in the extension host: PTYs live in the pty host child, not in `_registeredTerminals` and not in the `HostTerminal` seam, so every browser 'send to terminal' failed as 'not found or not local'."*

These four helpers are the ones that were never migrated.

**2. Creating a terminal makes it worse, not better.** `_sendPromptToTerminal` (`:1249`) and `sendPromptToAgentTerminal` (`:4464`) both *create* a VS Code terminal when no match is found, then `show()` it and send. From the browser that is the worst outcome available: the prompt is delivered into a brand-new VS Code panel terminal the user is not looking at, the agent starts working, and the browser reports success. There is no error to notice.

**3. Success is reported unconditionally.** `_sendPromptToTerminal` returns `Promise<void>` and the design-panel arms return a hardcoded `{ success: true }` immediately after awaiting `sendPromptToAgentTerminal` (`DesignPanelProvider.ts:2957-2962`, `:2978-2983`, `:2999-3004`, `:3021-3027`) — which also returns `void`. So there is no delivery signal to propagate even if a caller wanted to check. `transport.js` sees `success: true`, shows nothing, and the user concludes the send worked.

**4. The design rail never stamps `apiOriginated` at all — so four of the eleven call sites cannot be fixed by threading alone.**

Discovered 2026-08-06 while verifying this plan. `LocalApiServer._stampHttpSurface` (`:1762`) is called from only **four** of the seven verb-rail handlers:

| Handler | Stamps? | Rails it serves |
|---|---|---|
| `_handleKanbanVerb` (`:1767`) | ✅ `:1794` | `/kanban/verb/*` |
| `_handlePlanningVerb` (`:1807`) | ✅ `:1823` | `/planning/verb/*`, `/project/verb/*`, `/memo/verb/*` |
| `_handleTicketsVerb` (`:1836`) | ✅ `:1852` | `/tickets/verb/*` |
| `_handleDesignVerb` (`:1865`) | ❌ **never** | `/design/verb/*` |
| `_handleSetupVerb` (`:1901`) | ❌ **never** | `/setup/verb/*`, part of `/connections/verb/*` |
| `_handleTaskViewerVerb` (`:1945`) | ✅ `:1961` | `/taskViewer/verb/*` |
| `_handleTerminalVerb` (`:1683`) | ❌ never | `/terminals/verb/*` (pty control plane — no prompt dispatch, out of scope) |

`design.js` sets `data-panel="design"`, so `transport.js:26` posts every design verb to `/design/verb/<name>` → `_handleDesignVerb` → **no stamp**. Therefore `message.apiOriginated` is `undefined` in all four `DesignPanelProvider` send arms, and the fix this plan proposes for them (`{ apiOriginated: !!message.apiOriginated }`) evaluates to `false` on every browser click. The fleet branch would never run, no terminal would be conjured (so the "no dead terminal" half would appear to work), and the send would fall through to the VS Code path exactly as it does today — while every source-level contract test in §7 passed. This is the plan's goal-vs-appearance gap and it is **blocking**: without the stamp, the design half of this plan is a no-op.

Fixing it is one line per handler (Proposed Changes §0). This plan owns that fix because it is the only plan in the feature that depends on the design rail.

**5. The clipboard fallbacks are host-side.** `_deliverPromptToPmTerminal` falls back to the clipboard, and the design arms fall back to `this._seams().clipboard.writeText(prompt)` with the message *"Agent terminal unavailable — copied … to clipboard instead."* That writes the **extension host's** clipboard. `src/webview/transport.js:292-296` only reaches the browser clipboard when the reply body carries a `prompt` field, which none of these bodies do. So for a browser user the promised fallback does not exist either.

## Metadata

- **Complexity:** 8
- **Tags:** backend, bugfix, reliability, api
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 7
> **Reason:** Verification added three items the original scoring did not include: the blocking `LocalApiServer` stamp fix (a fourth file, and a change to the shared HTTP boundary that every design/setup verb crosses), the mandatory return-contract ratchet baseline edit for the Planning provider, and two additional call sites (`_deliverPromptToPmTerminal:24081`, plus the corrected `sendPromptToAgentTerminal` attribution). Four providers + the API server + a gate-file edit is squarely 8.
> **Replaced with:** **Complexity:** 8

## User Review Required

None. The one behaviour change that could have needed a ruling — what happens when a browser send finds no terminal — is already decided in this plan and is the right call: fail with the prompt in the reply body (browser clipboard), and never spawn a terminal on the user's behalf. No open questions.

## Complexity Audit

**Complex/risky.** The largest of the send-to-terminal plans: four helpers, four providers (`PlanningPanelProvider`, `TaskViewerProvider`, `DesignPanelProvider`, `LocalApiServer`), eleven call sites, a deliberate behaviour change (stop creating terminals for api-originated callers), and a gate-file edit (the ratchet baseline).

### Routine

- No DB work, no migration, no verb-schema change, no new verbs, no UI layout change.
- The `LocalApiServer` stamp fix is one line per handler, copied verbatim from the three handlers that already do it.
- The four `DesignPanelProvider` arms take an identical shape change.

### Complex / Risky

- **Terminal *creation* semantics change for browser callers.** Today a browser send with no matching terminal silently creates and uses a VS Code one. After this change it must not. Deciding what happens instead is a real choice, not a mechanical edit: return a typed failure carrying the prompt so the browser can put it on the user's clipboard. Do **not** create a PTY on the user's behalf — spawning an agent terminal is a deliberate act with a startup command and a cost, and doing it as a side effect of a tweak-prompt button is worse than failing loudly.
- **Return types change from `void` to `boolean`.** `_sendPromptToTerminal`, `sendPromptToAgentTerminal` and `_deliverPromptToPmTerminal` all return `void` and their thirteen call sites (11 + the second PM caller + the analyst arm) ignore them. Every caller must be updated to propagate the result, or the "reports success when nothing was sent" defect survives the fix in a new place. Note `_handleSendAnalystMessage` (`:19376-19379`) **already returns `Promise<boolean>`** — it needs the fleet pre-step and the root/flag parameters, not a return-type change.
- **The `break` → `return` conversion in the five Planning arms moves the ratchet.** Each of those arms currently ends `await this._sendPromptToTerminal(...); break;` and also contains `if (dispatched) { break; }` plus a guard `break`. Converting the delivery lines to typed returns lowers `PlanningPanelProvider`'s residual `break` count, and per the project PRD's Enforcement section the ceiling in `scripts/verb-return-contract-baseline.json` (`"Planning": 165` at time of writing) **must be lowered to the true post-conversion residual in the same change**. Get that number from `analyze-verb-migration2.js`; do not guess it, and never force it to 0 — `break` inside inner switches/loops is legitimate control flow.
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

## Dependencies

- None blocking outside this plan. No session dependency (`sess_*`) applies.
- **Internal ordering (within this plan):** Proposed Changes §0 (the `LocalApiServer` stamp) must land with or before §4 (the `DesignPanelProvider` arms). §4 without §0 is a verified no-op.
- Sibling coupling: `browser-send-to-planner-drops-surface-flag` edits the `dispatchCustomPromptToRole(...)` line in the same five `PlanningPanelProvider` arms this plan rewrites. Either order works; see the note in the dependency audit. That plan does **not** touch the ratchet baseline, so this plan is the sole owner of the `"Planning"` ceiling edit.

## Adversarial Synthesis

**Risk summary.** The dominant risk is a fix that reports itself complete while half of it is inert: without the `_handleDesignVerb` stamp (§0), the four design arms read `apiOriginated: undefined`, the fleet branch never runs, and every source-level contract test still passes — the exact "reachable but not usable" failure the PRD's capability-gating contract names. The second risk is editor regression in the opposite direction: three helpers currently spawn a terminal on miss, and that behaviour must survive untouched for editor callers (including the 2000 ms / 3000 ms startup settle), because removing it to "unify the paths" breaks cold-terminal sends. Third, the ratchet: converting five Planning arms from `break` to `return` without lowering the `"Planning"` ceiling in the same change leaves the win unlocked and the gate lying. Mitigations: land §0 first and prove it with a real browser design send; keep every new parameter trailing, optional and fail-closed; assert `prompt` appears on failure bodies only; and take the new ceiling from `analyze-verb-migration2.js` rather than by hand.

## Proposed Changes

### 0. `src/services/LocalApiServer.ts` — stamp the design and setup rails (BLOCKING PREREQUISITE)

Without this, §4 is inert. One line each, mirroring `_handlePlanningVerb:1823`:

```ts
     // _handleDesignVerb, after `delete body.type` (:1888)
     const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
     delete body.type;
+    // Every body on a verb rail arrived over HTTP, so it is by definition not the
+    // in-process sidebar. Without this stamp the four design send arms read
+    // apiOriginated:undefined and their fleet branch is dead code — a browser Stitch
+    // or artifact send lands in (or creates) an invisible VS Code terminal.
+    this._stampHttpSurface(body);
```

Apply the identical line in `_handleSetupVerb` after its `delete body.type` (`:1932`). Setup has no prompt-dispatch arm today, so it is stamped for consistency rather than to fix a live defect — the discriminator is meant to be impossible to forget, which is the stated rationale on `_stampHttpSurface` itself (`:1755-1761`), and leaving two of seven rails unstamped is how this defect happened.

Do **not** also copy `delete body.bypassTriggerGate` into these two handlers. The kanban/planning/tickets handlers strip it because their verbs consult it; no design or setup verb does, so adding the delete would be unexplained churn. (Noted so a reviewer does not read the asymmetry as an oversight.)

`_handleTerminalVerb` (`:1683`) stays unstamped: it is the pty control plane (`ptyWrite`/`ptyListTerminals`), it dispatches no prompts, and the fleet-selection flag has no meaning there.

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
        // Authoritative single lookup: ask the fleet for an ACTIVE terminal of this role.
        // A miss means "no fleet terminal for this role" — return false and let the caller
        // run its unchanged VS Code path (roles like claude_artifacts may exist only there).
        const res = await this._ptyHostVerb('ptyListTerminals', {});
        if (!res?.success || !Array.isArray(res.terminals)) { return false; }
        const normalizedRole = this._normalizeAgentKey(role);
        const match = res.terminals
            .filter((t: any) => t.status === 'active')
            .find((t: any) => this._normalizeAgentKey(t.role) === normalizedRole);
        const target = match?.friendlyName;
        if (!target || !this._isValidAgentName(target)) { return false; }
        return await this._dispatchExecuteMessage(workspaceRoot, target, prompt, metadata, 'sidebar', true);
    }
```

> **Superseded:** the helper resolves via `_resolveAgentTerminalForPlan(role, workspaceRoot, undefined, true)` and then gates on `_isLikelyPtyDispatchTarget(target, true)`.
> **Reason:** Two problems, both verified in source. (a) `_isLikelyPtyDispatchTarget`'s own docstring is explicit that it is **advisory only** — *"Used only to skip a pointless pre-dispatch reveal — never to route delivery"* (`TaskViewerProvider.ts:18762-18775`) — because it reads the cached `_ptyTerminalNames` snapshot rather than asking the fleet. Using it as the routing gate makes delivery depend on cache freshness for no benefit. (b) `_resolveAgentTerminalForPlan` deliberately falls through to `_getAgentNameForRole` (`:8285`), so it can return a **VS Code** terminal name that the advisory gate then has to reject — two pty round-trips (one inside the resolver at `:8278`, one inside `_isLikelyPtyDispatchTarget`'s snapshot dependency) to answer one question.
> **Replaced with:** one authoritative `ptyListTerminals` call matched on role, exactly mirroring the fleet arm in `_resolveAgentTerminalForPlan:8276-8284` and the reference implementation in `sendToTerminal:12887`. Same semantics, one round-trip, no advisory predicate, no cache dependency. (`_ptyHostVerb` also refreshes `_ptyTerminalNames` as a side effect on every `ptyListTerminals` — `:414-418` — so the snapshot other callers rely on stays warm either way.)

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

Then at each of the **five** `_sendPromptToTerminal` call sites, pass the flag and act on the result. Example for `invokePrdBuilder` (`:4229`):

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

Apply the same shape to `:4345` (`invokeConstitutionBuilder`), `:4358` (`invokeConstitutionUpdater`), `:4377` (`invokeSystemBuilder`) and `:4415` (`openArchitectTerminal`), with each arm's own role — `planner` for the three builders, `architect` for the architect terminal (its `searchSubstrings` are `['architect', 'planner']`).

Each of these five arms also converts its trailing `break;` and its `if (dispatched) { break; }` into typed returns — that is what makes the browser see a real result, and it is the change that moves the ratchet (see the Complexity Audit and Verification step 2).

The two remaining `PlanningPanelProvider` arms — `sendArtifactPromptToTerminal` (`:3335`) and `sendHtmlTweakPrompt` (`:3352`) — call **`sendPromptToAgentTerminal`**, not `_sendPromptToTerminal`, so they are fixed by §3 + the §4 shape rather than here. Do not add a `_sendPromptToTerminal` parameter for them; there is no such call.

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

Identical shape for `sendHtmlTweakPrompt` (`coder`), `sendClaudeImportPrompt` (`claude_import`), `sendClaudeArtifactPrompt` (`claude_artifacts`) — and for the two `PlanningPanelProvider` arms that reach the same helper: `sendArtifactPromptToTerminal` (`:3335`, role `claude_artifacts`) and `sendHtmlTweakPrompt` (`:3352`, role `coder`).

**This section is inert without §0.** `message.apiOriginated` is `undefined` on `/design/verb/*` until `_handleDesignVerb` stamps.

### 5. `src/services/TaskViewerProvider.ts:23968` — `_deliverPromptToPmTerminal`

Add `options?: { apiOriginated?: boolean }`, call `_tryFleetDeliveryForRole('project_manager', prompt, workspaceRoot, apiOriginated)` ahead of the registered/open-by-name lookup, and return a boolean. (`'project_manager'` is confirmed as the role key — `:23974` reads `_getAgentNameForRole('project_manager', workspaceRoot) || 'Project Manager'`; keep the literal-name fallback for the editor's open-terminals scan.)

**Both callers must be updated**, not just the dispatch arm:

- `_handleDispatchProjectManager` (`:23938`, calling at `:23959`) — takes no parameters today (`private async _handleDispatchProjectManager(): Promise<void>`) and reads the root from `this._getWorkspaceRoot()`. Add `options?: { apiOriginated?: boolean }`, forward it, return the delivery result, and have the `dispatchProjectManager` arm (`:11445-11447`) pass `{ apiOriginated: !!data.apiOriginated }` and return `{ success: sent, ...(sent ? {} : { error, prompt }) }` instead of the unconditional `{ success: true }` it returns today.
- **The targeted-pass handler at `:24081`** — the second `_deliverPromptToPmTerminal` caller (the shared delivery path was extracted precisely so this one reuses it). Thread the flag from its own arm too; leaving it on the default keeps that path VS Code-only and it will report success either way.

### 6. `src/services/TaskViewerProvider.ts:19376` — `_handleSendAnalystMessage`

Already returns `Promise<boolean>` (`:19376-19379`) — no return-type change needed. Add `workspaceRoot` and `options?: { apiOriginated?: boolean }` parameters; replace `_getAgentNameForRole('analyst')` (`:19393`) with `_getAgentNameForRole('analyst', resolvedRoot, apiOriginated)`; try `_tryFleetDeliveryForRole('analyst', …)` first.

It has **four** call sites, and they split two ways:

- `:12321` — the `sendAnalystMessage` arm. Has `data` in scope; forward both root and flag.
- `:12856` — the archive-query arm (builds a DuckDB helper instruction). Also has `data` in scope; forward both. Missing this one leaves the browser's archive-query send VS Code-only.
- `:5024` and `:19520` — internal `analystMap` callers (context-map batching). No HTTP surface of their own; pass nothing and let the fail-closed default apply.

**Do not break the existing source-level test.** `src/test/analyst-direct-dispatch-regression.test.js:55-66` extracts this method's body and asserts (a) it contains `sendRobustText(terminal, messageText, true)` and (b) it contains **no** match for `/inbox/i`. The fleet pre-step keeps (a) true because the VS Code fallback path is unchanged; keep (b) true by not using the word "inbox" in the new code or its comments.

### 7. `src/test/browser-direct-terminal-helpers.test.js` (new)

Source-level contract test:

1. `_tryFleetDeliveryForRole` exists, guards on `apiOriginated && this._ptyHostPort`, and delivers via `_dispatchExecuteMessage` (not a raw `ptyWrite`).
2. `_sendPromptToTerminal` and `sendPromptToAgentTerminal` return `Promise<boolean>` and both contain an `if (apiOriginated) { return false; }` guard immediately before their terminal-creation call.
3. No `DesignPanelProvider` send arm returns a bare `{ success: true }` after awaiting `sendPromptToAgentTerminal`.
4. Every failure return in these arms carries both `error` and `prompt`; no success return carries `prompt`.
5. Fail-closed: no `options?.apiOriginated` read defaults to `true`.
6. **`_handleDesignVerb` and `_handleSetupVerb` both call `_stampHttpSurface`.** Assert over *every* `private async _handle*Verb(` in `LocalApiServer.ts` that it either calls `_stampHttpSurface` or is named in a documented exclusion list (`_handleTerminalVerb`, with the reason inline). This is the assertion that would have caught the blocking defect, and it prevents the next rail from shipping unstamped.
7. Note this plan adds an eighth `_dispatchExecuteMessage` call site (inside `_tryFleetDeliveryForRole`). The sibling plan `browser-stray-dispatch-sites-hardcode-vscode-fleet` also asserts on those sites; its assertion is a property over all sites plus a `>= 7` floor, so this addition is compatible by construction. If that plan landed with an equality count, fix the assertion — do not weaken it.

## Verification Plan

### Automated Tests

1. **Compile + suite:** `npx tsc --noEmit -p .`, `npm test`. New test green, nothing pre-existing red. `tsc` is load-bearing here — three signatures change from `void` to `boolean` across three providers, and any missed call site shows up as an unused-result or type error.
2. **Ratchet lowered in the same change:** run `analyze-verb-migration2.js`, read the Planning provider's post-conversion residual `break` count, set `scripts/verb-return-contract-baseline.json` `"Planning"` to exactly that number (down from 165), then `npm run verb-returns:check` must pass. A green check against the **old** ceiling means the win was not locked — that is a failed verification, not a pass.
3. **Parity + push-routing:** `npm run parity:check`, `npm run push-routing:check` green.

### Manual / UAT

4. **Editor regression, all four helpers, fail-closed.** From the editor with a VS Code coder/planner terminal open: Stitch tweak → send, HTML tweak → send, Claude import → send, artifact upload → send, PRD/constitution/system builders → send, architect terminal, Project Manager dispatch, analyst message. Every one must behave exactly as today, **including** spawning a terminal when none exists.

5. **Editor cold-terminal creation still works.** Close all agent terminals, then trigger a design send from the editor. A terminal must be created, the startup command run, and the prompt delivered after the existing 2000ms/3000ms settle. This is the behaviour the api-originated guard must not touch.

6. **The stamp actually arrives (proves §0 before anything else).** With devtools open in the browser cockpit, trigger a design send and inspect the request/response for `POST /design/verb/sendStitchTweakPrompt`. Then confirm server-side that the arm saw `apiOriginated: true` — a temporary log line, or simply the observable outcome of step 7. **If this check is skipped, a green step 7 could be a coincidence** (a matching VS Code terminal happening to exist); run it first.

7. **Browser happy path, fleet present.** With a browser PTY coder + planner running, repeat all of step 4 from the browser cockpit. Every send must land in the browser terminal. Before the fix: the design/tweak sends land in an invisible VS Code terminal (or create one) and report success; the builder sends land in an ad-hoc VS Code terminal.

8. **No terminal conjured for browser callers.** With **no** coder terminal in either fleet, trigger a browser Stitch tweak send. Assert: no new VS Code terminal appears (check the editor's terminal dropdown), the browser shows an error naming the missing role, and the prompt is on the **browser** clipboard (paste to confirm).

9. **Success does not clobber the clipboard.** Put a known string on the browser clipboard, then do a *successful* browser design send. Paste — the known string must survive (proves `prompt` is failure-only).

10. **Browser Project Manager + analyst — both callers each.** Dispatch the Project Manager from the browser (`dispatchProjectManager`) **and** trigger the targeted-pass path that reuses `_deliverPromptToPmTerminal` (`:24081`); send an analyst message from the browser via both the `sendAnalystMessage` arm and the archive-query arm (`:12856`). All four must reach browser terminals, and all four must report a real failure (not silent success) when no such terminal exists.

11. **Fleet-less browser install.** Stop the PTY host and repeat step 7 from the browser. Sends must fall through to the VS Code path minus creation — i.e. deliver if a matching VS Code terminal happens to exist, otherwise fail loudly with the prompt in the body. Nothing may hang.

12. **Prompt fidelity on the fleet path.** Send a multi-line prompt (the PRD builder prompt is multi-line) to a browser terminal and confirm the agent receives it as **one** prompt, not one fragment per line — this is what routing through `_dispatchExecuteMessage`/`ptySendPrompt` buys, and a hand-rolled `ptyWrite` would break it.

## Recommendation

Complexity 8 → **Send to Lead Coder.** Land Proposed Changes §0 first — the rest of the design-panel work is unverifiable without it.

## Review Findings

**Reviewer:** Direct reviewer pass (GLM-5.2 High)
**Date:** 2026-08-07
**Verdict:** PASS — all material requirements verified in source; one MAJOR finding (missing contract test) now fixed; one NIT (pre-existing test breakage) fixed.

### Verified

| Requirement | Status | Evidence |
|---|---|---|
| `_tryFleetDeliveryForRole` guards on `!apiOriginated \|\| !this._ptyHostPort` | ✅ | Short-circuit `return false` confirmed |
| `_tryFleetDeliveryForRole` delivers via `_dispatchExecuteMessage` (not raw `ptyWrite`) | ✅ | Confirmed; `ptyWrite` does NOT appear in method body |
| Public `tryFleetDeliveryForRole` wrapper exists | ✅ | `public async tryFleetDeliveryForRole` confirmed |
| `sendPromptToAgentTerminal` returns `Promise<boolean>`, guards terminal creation for browser callers | ✅ | Signature confirmed; `if (apiOriginated) { return false; }` before terminal creation; tries fleet first |
| `sendPromptToAgentTerminal` keeps 2000ms/3000ms editor settle waits | ✅ | Both `setTimeout(r, 2000)` and `setTimeout(r, 3000)` confirmed in body |
| `_deliverPromptToPmTerminal` returns `Promise<boolean>`, tries fleet first | ✅ | Signature confirmed; `_tryFleetDeliveryForRole('project_manager')` confirmed |
| `_handleSendAnalystMessage` tries fleet first, threads root + flag | ✅ | `_tryFleetDeliveryForRole('analyst')` confirmed; `_getAgentNameForRole('analyst', resolvedRoot, apiOriginated)` confirmed |
| `_handleSendAnalystMessage` does not introduce "inbox" | ✅ | `doesNotMatch(/inbox/i)` passes |
| All 4 DesignPanelProvider send arms pass `{ apiOriginated: !!message.apiOriginated }` | ✅ | All 4 case blocks confirmed: `sendStitchTweakPrompt`, `sendHtmlTweakPrompt`, `sendClaudeImportPrompt`, `sendClaudeArtifactPrompt` |
| All 4 DesignPanelProvider arms branch on delivery result | ✅ | All 4 have `if (!sent)` / `if (sent)` branch |
| All 4 DesignPanelProvider failure bodies carry `error` + `prompt` | ✅ | All 4 confirmed |
| `_sendPromptToTerminal` returns `Promise<boolean>`, guards terminal creation | ✅ | Signature confirmed; `if (apiOriginated) { return false; }` confirmed; tries fleet first |
| PlanningPanelProvider builder arms carry `prompt` only on failure | ✅ | `invokePrdBuilder` confirmed: failure returns `{ success: false, error, prompt: promptText }`, success returns `{ success: true }` |
| `_handleDesignVerb` stamps `_stampHttpSurface(body)` | ✅ | Confirmed |
| `_handleSetupVerb` stamps `_stampHttpSurface(body)` | ✅ | Confirmed |
| Every verb-rail handler stamps (or is in exclusion list) | ✅ | All `_handle*Verb` handlers checked; `_handleTerminalVerb` excluded (pty control plane) |
| Fail-closed: no helper defaults `apiOriginated` to literal `true` | ✅ | All 5 helper bodies checked |
| Verb-return baseline Planning 165→154 | ✅ | `scripts/verb-return-contract-baseline.json` confirmed |

### MAJOR Finding (Fixed)

**Missing contract test.** The plan's verification section specified a new contract test file (`browser-direct-terminal-helpers`), but it was never created. **Fixed:** Created `src/test/browser-direct-terminal-helpers.test.js` (12 assertions), wired into `package.json` as `test:contract:browser-direct-terminal-helpers` and CI workflow `integration-tests.yml`. All 12 assertions pass.

### NIT (Fixed)

**`analyst-direct-dispatch-regression.test.js` was broken by the new `options?: { apiOriginated?: boolean }` parameter.** The test's naive `extractMethodBody` helper found the first `{` after the method marker — which was the parameter type brace, not the method body. **Fixed:** Updated the extractor to walk paren depth past the parameter list (matching the robust version in `pty-dispatch-focus-contract.test.js`). Also updated the focus-fallback assertion to match the `_seams().commands` convention (the test expected `vscode.commands` but the code uses `this._seams().commands` per PRD contract #3 — this was a pre-existing stale assertion, not introduced by this feature, but the test guards the feature's modified method so it must stay green). 4/4 pass.

### Gate Wiring Audit

| Gate | Status |
|---|---|
| `npx tsc --noEmit` | ✅ No new errors (5 pre-existing TS2835 in unrelated modules) |
| `npm run parity:check` | ✅ Pass |
| `npm run push-routing:check` | ✅ Pass |
| `npm run verb-returns:check` | ⚠️ Kanban break regression — from unrelated `attributePastedPrompt` feature, not this plan |
| `npm run catalog:generate` | ✅ No unintended diff |
| `test:contract:browser-direct-terminal-helpers` | ✅ 12/12 pass (NEW) |
| `test:contract:analyst-direct-dispatch-regression` | ✅ 4/4 pass (fixed) |
| `test:contract:pty-route-surface` | ✅ Pass |
| `test:contract:pty-host-gating` | ✅ Pass |
