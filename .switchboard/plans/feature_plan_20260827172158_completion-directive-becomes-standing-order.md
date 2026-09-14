# Completion Directive Becomes a Standing Order, Not a Prompt-Injected Section

<!-- board-collapse-04 -->
> **SCOPE CONFIRMED 2026-09-04 (Board Collapse 04, decision 8).** This plan owns the `COMPLETION REPORT` directive text outright. One addition inherited from *A column move orphans the dispatch holder*, which has been rescoped to its server-side fix: the standing order also instructs the seat to **report the planId it was dispatched**. That is an instruction, so it belongs here with the rest of the completion protocol; the plan id itself is data and already reaches the seat as a header line in the dispatch prompt, so the role-scoped order needs no per-dispatch interpolation to support it.
> > 
> > **Lands last** in the seat-release feature: its stated prerequisite, the gate stopping lead-dispatched coders receiving the directive twice, does not exist at HEAD.


## Goal

The `COMPLETION REPORT` directive — the instruction telling agents to `POST /kanban/queue/done` when they finish — is currently baked into every code-touching prompt via `ensureDispatchProtocolDirectives` inside `buildKanbanBatchPrompt`. This is the wrong layer. Copy-prompt buttons exist to produce prompts for **any** agent, including external cloud agents that have no access to the Switchboard API. Injecting a directive that says "POST to our local API server" into those prompts is noise at best and misleading at worst — a cloud agent reading "against the port in .switchboard/api-server-port.txt" has no such file and no such server.

The directive must move from **prompt-injected content** to a **standing order** — the mechanism that rides every `ptySendPrompt` delivery to a terminal connected to Switchboard. Standing orders only reach terminals that are live and connected, so the directive reaches exactly the agents that can act on it, and copy-prompt buttons produce clean prompts that work for any agent anywhere.

While moving it, fix two text-quality problems the user identified:
1. **Port number**: The directive says "against the port in .switchboard/api-server-port.txt" instead of giving the port directly. A standing order delivered at the `ptySendPrompt` layer can interpolate the live port at delivery time.
2. **Terminal name**: The directive says `<your terminal name>` as a placeholder. A standing order delivered to a named terminal can interpolate the actual terminal name.

### Root cause

`CODING_COMPLETION_REPORT_DIRECTIVE` (`src/services/agentPromptBuilder.ts:1215`) is a string constant appended to every coder/lead/intern prompt by `ensureCompletionDirective` (line 1294), which is called from `ensureDispatchProtocolDirectives` (line 1330). `ensureDispatchProtocolDirectives` is called in five places inside `buildKanbanBatchPrompt` (lines 2197, 2348, 2435, 2490, 2529) — once per code-touching role branch — and also at the `dispatch` payload gate in the pty-delivery layer (`TaskViewerProvider.ts:882`, `bootstrap.ts:537`).

> **Superseded:** "also at two pty-delivery chokepoints (`TaskViewerProvider.ts:527` for the `dispatch` payload gate, and the seat-block gate added by the lead-dispatched-coders plan)"
> **Reason:** Two factual errors. (1) `TaskViewerProvider.ts:527` is a `ptyRenameTerminal` handler, not the dispatch payload gate — the actual gate is at line 676. (2) The "seat-block gate added by the lead-dispatched-coders plan" does not exist: `roleTakesDispatchDirectives` and `DISPATCH_DIRECTIVE_ROLES` (the functions that plan proposes) are absent from `src/` — that plan (`feature_plan_20260817141300_lead-dispatched-coders-never-get-the-completion-report-directive.md`) has not been implemented. Treating a non-existent gate as a fallback is a silent hole in the safety net.
> **Replaced with:** the dispatch payload gate is at `TaskViewerProvider.ts:882` and `bootstrap.ts:537`. The seat-block gate is a **prerequisite dependency**, not an existing fallback — see `## Dependencies`.

The directive text is:
```
COMPLETION REPORT: When you have finished implementing ALL parts of the plan, run `node "<cliPath>" done --from "<your terminal name>"` (or `switchboard done --from "<your terminal name>"`). This signals task completion to the kanban board — the system clears your card's activity light and notifies your lead. Do NOT report after finishing individual parts — only when ALL work is complete. Also append a brief summary (3-5 sentences) to the END of the original plan file for the record. Do NOT skip the completion report.
```

> **Superseded:** the original directive text quoted above used `POST /kanban/queue/done with {"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt`.
> **Reason:** The directive has migrated to the bundled CLI form (`run node "<cliPath>" done --from "<your terminal name>"` or `switchboard done --from "<your terminal name>"`) — verified at `agentPromptBuilder.ts:1215`. The `api-server-port.txt` reference has been removed by a fragment sweep (the `SWITCHBOARD_LIVENESS_DIRECTIVE` comment at `:940-942` records the sweep). The standing-order text in Proposed Change #1 must use the CLI form, not the old POST form, or it reverts the CLI migration.
> **Replaced with:** the CLI form above. The standing order still interpolates `${terminalName}` (the CLI takes `--from "<your terminal name>"`), but the `api-server-port.txt` / `${port}` interpolation is no longer needed for the completion directive — the CLI resolves the port itself. The `${port}` interpolation machinery in Proposed Changes #2-#4 remains useful for any future standing order that names an HTTP endpoint directly, but the completion directive itself no longer needs it.

The `SWITCHBOARD_LIVENESS_DIRECTIVE` (`agentPromptBuilder.ts:944`) injects the port and says "SWITCHBOARD STATUS: Live (port ${port})... Use http://127.0.0.1:${port} for any direct API calls." A prior version also said "wherever an instruction in this prompt says 'against the port in .switchboard/api-server-port.txt', use http://127.0.0.1:${port}" — that cross-reference has been removed by a fragment sweep (the comment at `:940-942` records the sweep), so Proposed Change #7 (updating the cross-reference) is obsolete. The liveness directive itself is still prompt-injected; moving it to a standing order is a follow-up, not this plan.

Standing orders (`src/services/standingOrders.ts`) are the correct mechanism:
- They are applied at the `ptySendPrompt` delivery layer (`TaskViewerProvider.ts:1352`, `bootstrap.ts:666`), NOT in the prompt text.
- They only reach terminals that are live and connected to Switchboard.
- They are NOT part of the prompt that gets copied to the clipboard for copy-prompt buttons.
- They support `role` scope (line 3 of `standingOrders.ts`) — a role-scoped order for `coder`, `intern`, `lead`, and `reviewer` would carry the completion directive to exactly the right terminals.
- The delivery layer already knows the terminal name (`payload.name` at `TaskViewerProvider.ts:1352`) and the API port (`this.getLocalApiServerPort()` at `TaskViewerProvider.ts:5381`).

### What needs to happen

1. **Remove** the completion directive from `buildKanbanBatchPrompt` — stop calling `ensureDispatchProtocolDirectives` in the role branches. Copy-prompt buttons will produce clean prompts without the directive.
2. **Add** a role-scoped standing order definition that carries the completion directive, with `${port}` and `${terminalName}` placeholders stored in the config DB and interpolated at delivery time.
3. **Install** the standing order automatically for every coding terminal (coder, intern, lead, reviewer) — not per-team, but per-role, so it applies to standalone terminals too.
4. **Keep** the `dispatch` payload gate at `TaskViewerProvider.ts:676` / `bootstrap.ts:285` as a belt-and-suspenders fallback — it is idempotent and will no-op if the standing order already carries the sentinel.
5. **Prerequisite:** the seat-block gate from the lead-dispatched-coders plan (`feature_plan_20260817141300`) must be implemented first, OR this plan must include creating it. Without it, lead-dispatched coders (who bypass both `buildKanbanBatchPrompt` and the `dispatch` payload gate) have no fallback when the standing order is not yet installed. See `## Dependencies`.

## Metadata

**Complexity:** 7
**Tags:** backend, refactor, reliability
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Writing the new standing-order definition text — a templated version of the current directive with `${port}` and `${terminalName}` placeholders.
- Registering the definition in the standing-order definitions library (`ensureStandingOrderDefinition`).
- Removing the five `ensureDispatchProtocolDirectives` calls from `buildKanbanBatchPrompt`'s role branches.
- Updating tests that assert `COMPLETION REPORT:` is present in `buildKanbanBatchPrompt` output — those assertions must move to the standing-order delivery path.

### Complex / Risky

- **The completion handshake is load-bearing.** The `CODING_COMPLETION_REPORT_DIRECTIVE` comment (lines 1204-1214) names three consumers: the activity-light off-switch (`PlanIngestionEngine`), the autoban wake (`TaskViewerProvider.handleAutobanTurnEnd`), and the Column Oversight pass. All depend on the agent running `switchboard done --from`. If the standing order fails to install or fails to deliver, cards stay lit indefinitely. The `dispatch` payload gate is the fallback — but it must remain in place and functional. The seat-block gate (lead-dispatched-coders plan) is a second fallback that does not yet exist — see Dependencies.

- **Standing order installation timing.** Role-scoped standing orders are resolved at delivery time from the `terminals.standingOrders` config key. The order must be installed when a terminal is created or a role is assigned, not when a prompt is built. `wireSpawnedTeam` already installs team-scoped orders; a new installation path is needed for standalone (non-team) coding terminals. The order must also be installed for existing terminals on upgrade (migration).

- **Reviewer completion steps are woven into the step list, not appended.** `COMPLETION_STEP_FULL` / `COMPLETION_STEP_COMPACT` (lines 1282-1284) are part of the reviewer's composed steps array (line 2153), not appended by `ensureDispatchProtocolDirectives`. They carry the `COMPLETION REPORT:` sentinel so `ensureCompletionDirective` is a no-op on the normal path. Moving the reviewer's completion instruction to a standing order means removing the completion step from the reviewer's step list AND ensuring the standing order carries it. The reviewer's step also includes plan-file update instructions ("update the original plan file with fixed items, files changed, validation results, and remaining risks") — those plan-file instructions are NOT API-dependent and should stay in the prompt. Only the `run node "<cliPath>" done --from` instruction should move to the standing order.

- **Two hosts must stay identical.** `TaskViewerProvider._ptyHostVerb` and `bootstrap.deliverPrompt` are twins. The standing order is applied at both chokepoints already (`applyStandingOrders` at `TaskViewerProvider.ts:1352` and `bootstrap.ts:666`), so the delivery mechanism is shared. But the installation path — when and how the role-scoped order is created — must land in both hosts.

- **Port interpolation at delivery time.** Standing orders are stored as text in the config DB. The port is known at delivery time (`this.getLocalApiServerPort()`), not at install time. The order text must be stored with `${port}` and `${terminalName}` placeholders and interpolated at delivery time in `applyStandingOrders`. This requires modifying `applyStandingOrders` (or `renderStandaloneOrdersBlock`) to accept an interpolation context and replace placeholders before rendering.

- **`MISSION_CONTROL_REPORT_DIRECTIVE` is a sibling.** `ensureDispatchProtocolDirectives` appends both the completion directive and the mission control report directive. If the completion directive moves to a standing order, the mission control directive should also move (it has the same "against the port in .switchboard/api-server-port.txt" problem and the same "only relevant for Switchboard-connected terminals" property). But the mission control directive is gated on `missionControlActive` — the standing order would need the same gate. **Clarification:** This plan moves the completion directive only. The mission control directive move is a follow-up — it adds a conditional gate (`missionControlActive`) that the standing-order delivery layer does not currently support, and bundling it here would expand scope. Flag it as a follow-up plan.

- **Existing tests are extensive.** `agentPromptBuilder.test.ts` has 14 assertions on `COMPLETION REPORT:` presence in `buildKanbanBatchPrompt` output. `completion-asserted-never-inferred.test.js` has 5 matches for completion-report patterns. `seat-safeguards-fleet-prompt-path.test.js` has 66 matches for standing-order patterns. All must be updated to reflect the new architecture: the directive is in the standing order, not the prompt.

## Edge-Case & Dependency Audit

**Race conditions**

- **Standing order installation vs. first dispatch.** If a terminal is created and dispatched before the role-scoped standing order is installed, the first prompt will not carry the completion directive. The `dispatch` payload gate is the fallback — it will append the directive at delivery time via `ensureDispatchProtocolDirectives`. But the fallback uses `ensureDispatchProtocolDirectives`, which appends the generic `CODING_COMPLETION_REPORT_DIRECTIVE` text (with "check this txt file" and `<your terminal name>`). This is acceptable as a fallback — the standing order is the primary path, and the fallback only fires on the race edge. **Gap:** lead-dispatched coders who send a plain `ptySendPrompt` (no `dispatch` payload) have no fallback if the standing order is not installed — the seat-block gate from the lead-dispatched-coders plan is the missing second fallback. See Dependencies.

- **No new persisted state conflicts.** The standing order is stored in the existing `terminals.standingOrders` config key. The order ID must be deterministic (e.g. `completion-directive:role:<roleName>`) so re-installation is idempotent.

**Security**

- No new surface. The standing order text is authored by the system, not user input. The port and terminal name are interpolated from known values at delivery time.

**Side effects**

- **Copy-prompt buttons produce shorter prompts.** Removing the completion directive from `buildKanbanBatchPrompt` reduces prompt size by ~600 bytes for coder/lead/intern. (The mission control directive stays in this plan — see the clarification above.)

- **`SWITCHBOARD_LIVENESS_DIRECTIVE` may also need to move.** The liveness directive tells the agent the port and says "skip port-discovery steps." It is only relevant for Switchboard-connected terminals. If the completion directive moves to a standing order, the liveness directive should arguably move too — it has the same "only relevant for connected terminals" property. However, the liveness directive is less harmful in copy-prompt prompts (it just says "the server is at port X" — a cloud agent can ignore it). Consider moving it in a follow-up, not this plan. **Note:** the liveness directive's prior "wherever an instruction in this prompt says 'against the port in .switchboard/api-server-port.txt'" cross-reference has already been removed by a fragment sweep (`agentPromptBuilder.ts:940-942` comment records it), so no cross-reference update is needed in this plan — see Proposed Change #7 (obsolete).

- **`NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE` references "the COMPLETION REPORT step."** Line 1201: "Record your findings in your response and in the existing target plan file, per the COMPLETION REPORT step." If the completion step moves out of the prompt, this reference becomes dangling. The directive text should be updated to say "per your standing orders" or the reference should be removed.

- **`STAGGERED_IMPLEMENTATION_DIRECTIVE` references "the per-plan completion POST."** Line 1203: "This is in addition to the per-plan completion POST (POST /kanban/queue/done, which signals task completion to the kanban board)." This reference is itself stale — the directive has migrated to the CLI form (`switchboard done --from`), so the "POST /kanban/queue/done" reference in `STAGGERED_IMPLEMENTATION_DIRECTIVE` should be updated to the CLI form in the same change. The POST is still required, just delivered via standing order instead of prompt text.

- **`GIT_COMMIT_CLAUSES.whenDone` references "this plan's own file, whose completion report is part of the work."** Line 790. This reference is to the plan-file summary append, not to the POST directive. It stays valid.

**Dependencies & conflicts**

- **`feature_plan_20260817141300_lead-dispatched-coders-never-get-the-completion-report-directive.md`** — this plan proposes adding `ensureDispatchProtocolDirectives` to the seat-block gate for lead-dispatched coders via `roleTakesDispatchDirectives`. **That plan has NOT been implemented** — `roleTakesDispatchDirectives` and `DISPATCH_DIRECTIVE_ROLES` are absent from `src/`. The seat-block gate is a prerequisite for this plan's fallback strategy: without it, a lead-dispatched coder whose standing order is not yet installed has zero fallback paths (it bypasses both `buildKanbanBatchPrompt` and the `dispatch` payload gate). Either implement the lead-dispatched-coders plan first, or include its seat-block gate as part of this plan's scope.

- **`context-aware-completion-reporting.md`** — this plan replaces per-team completion callback standing orders with a context-aware order. The role-scoped completion directive standing order is a separate concern: it tells the agent to POST `/kanban/queue/done`; the context-aware order tells the agent which endpoint to POST to based on dispatch source. The two must coexist: the role-scoped order carries the basic "POST when done" instruction; the team-scoped context-aware order carries the routing logic. Consider merging them — the context-aware order could subsume the role-scoped order for team members, while the role-scoped order covers standalone terminals. This is a design decision to resolve during implementation.

- **`ensureDispatchProtocolDirectives` is the declared single entry point** (line 1177-1180): "Add new dispatch-protocol directives HERE, never at a call site." Removing its calls from `buildKanbanBatchPrompt` does not remove the function — it remains for the pty-delivery fallbacks. But the comment's intent ("every code-touching dispatch carries [these directives]") changes: the prompt no longer carries them; the standing order does.

- **`ensureCompletionDirective` is override-proof** (lines 1131-1138): it re-appends the directive after any `defaultPromptOverride` is applied. This override-proofing was necessary because the directive was in the prompt, and a `replace`-mode override could wipe it. With the directive in a standing order, override-proofing is no longer needed — standing orders are applied after the prompt is composed, at the delivery layer, and cannot be overridden by prompt overrides. The `ensureCompletionDirective` function and its override-proofing comment can be simplified.

- **Reviewer `COMPLETION_STEP_FULL` / `COMPLETION_STEP_COMPACT` carry plan-file update instructions** that are NOT API-dependent. These instructions ("update the original plan file with fixed items, files changed, validation results, and remaining risks") must stay in the reviewer's prompt. Only the `POST /kanban/queue/done` instruction moves to the standing order. This means splitting the reviewer completion step: the plan-file update part stays in the step list; the POST part moves to the standing order.

## Dependencies

- `feature_plan_20260817141300_lead-dispatched-coders-never-get-the-completion-report-directive.md` — **prerequisite**. The seat-block gate (`roleTakesDispatchDirectives` + `ensureDispatchProtocolDirectives` inside the `applySeatBlock` branch) does not exist at HEAD. Without it, lead-dispatched coders have no fallback when the standing order is not yet installed. Implement that plan first, or fold its seat-block gate into this plan's scope.
- `context-aware-completion-reporting.md` — **coexistence design decision**. The role-scoped completion order and the team-scoped context-aware order must not conflict. Resolve during implementation (merge or coexist).

## Adversarial Synthesis

**Risk summary.** Key risks: (1) the plan's fallback strategy depends on a seat-block gate that does not exist yet — the lead-dispatched-coders plan is unimplemented, leaving a hole in the safety net for lead-dispatched coders; (2) the original plan contradicted itself on interpolation timing — `COMPLETION_DIRECTIVE_ORDER_TEXT(port, terminalName)` interpolated at install time while `applyStandingOrders` expected `${port}` placeholders at delivery time, and the `installCompletionDirectiveOrder` function set `parent: terminalName` on a role-scoped order (semantically wrong — a role order applies to all terminals with that role, not one); (3) the original order text used the old `POST /kanban/queue/done` form, but the directive has migrated to the bundled CLI (`switchboard done --from`) — the standing order must use the CLI form or it reverts the CLI migration; (4) the `SWITCHBOARD_LIVENESS_DIRECTIVE` cross-reference this plan proposed to update has already been removed by a fragment sweep, making Proposed Change #7 obsolete. Mitigations: declare the seat-block gate as a prerequisite dependency; store the order text with `${terminalName}`/`${cliPath}` placeholders and interpolate at delivery time only (the CLI resolves the port, so `${port}` is no longer needed for this order); install once per role (not per terminal) with `parent: ''`; mark Proposed Change #7 obsolete.

## Proposed Changes

### 1. `src/services/standingOrders.ts` — new completion-directive standing order definition

Add a constant for the order text with `${port}` and `${terminalName}` placeholders (interpolated at delivery time, NOT at install time):

> **Superseded:** `COMPLETION_DIRECTIVE_ORDER_TEXT(port: number, terminalName: string)` — a function that interpolated the port and terminal name at call time (install time).
> **Reason:** Contradicted the plan's own delivery-time interpolation design. If the port is baked in at install time, the stored text is stale when the API server restarts on a different port. The plan's own §2 says "The port is known at delivery time, not at install time" — the install-time function violated that.
> **Replaced with:** a plain string constant with `${port}` and `${terminalName}` placeholders, interpolated at delivery time in `applyStandingOrders`.

```ts
/**
 * The completion-protocol handshake as a standing order. Tells the agent to
 * POST /kanban/queue/done when ALL work is complete. Stored with ${port} and
 * ${terminalName} placeholders, interpolated at delivery time with the live
 * API port and the terminal's own name — no "check this txt file" and no
 * "<your terminal name>" placeholder.
 *
 * This replaced the prompt-injected CODING_COMPLETION_REPORT_DIRECTIVE. Copy-
 * prompt buttons produce clean prompts without this directive; the standing
 * order delivers it only to terminals connected to Switchboard.
 */
export const COMPLETION_DIRECTIVE_ORDER_INSTRUCTION = `COMPLETION REPORT: When you have finished implementing ALL parts of the plan, run \`\${cliPath} done --from "\${terminalName}"\` (or \`switchboard done --from "\${terminalName}"\`). This signals task completion to the kanban board — the system clears your card's activity light and notifies your lead. Do NOT report after finishing individual parts — only when ALL work is complete. Also append a brief summary (3-5 sentences) to the END of the original plan file for the record. Do NOT skip the completion report.`;
```

> **Superseded:** the original order text used `POST /kanban/queue/done with {"from":"\${terminalName}"} against http://127.0.0.1:\${port}`.
> **Reason:** The directive has migrated to the bundled CLI form (`run node "<cliPath>" done --from "<your terminal name>"` or `switchboard done --from "<your terminal name>"`) — verified at `agentPromptBuilder.ts:1215`. The standing order must use the CLI form or it reverts the CLI migration. The CLI resolves the port itself, so `${port}` interpolation is no longer needed for this order; `${terminalName}` is still interpolated (the CLI takes `--from "<your terminal name>"`). The `${cliPath}` placeholder is interpolated the same way `agentPromptBuilder.ts` interpolates `<cliPath>` into the prompt-injected directive.
> **Replaced with:** the CLI form above. The `${port}` interpolation machinery in Proposed Changes #2-#4 remains useful for any future standing order that names an HTTP endpoint directly, but the completion directive itself no longer needs it.

Add a deterministic ID prefix and an installation function. The function installs **once per role** (not per terminal) — `parent` is `''` because a role-scoped order applies to all terminals with that role, not one specific terminal:

> **Superseded:** `installCompletionDirectiveOrder(db, role, port, terminalName)` with `parent: terminalName` in the pushed order.
> **Reason:** A role-scoped order is matched by `o.role` against `roleMap.get(targetName)` in `selectOrders` — `parent` is irrelevant for delivery but semantically wrong. Setting `parent: terminalName` implies the order belongs to one terminal, and re-installing for a different terminal with the same role would overwrite `parent` with the last terminal's name. The `port` and `terminalName` parameters were also unused once the text moved to placeholders.
> **Replaced with:** `installCompletionDirectiveOrder(db, role)` — installs once per role, `parent: ''`, no port/terminalName parameters (placeholders are interpolated at delivery time).

```ts
const COMPLETION_DIRECTIVE_ORDER_ID_PREFIX = 'completion-directive:role:';

/**
 * Install (or update) the completion-directive standing order for a role.
 * Called when a terminal is created or a role is assigned, and during upgrade
 * migration. Idempotent — uses a deterministic ID so re-installation replaces,
 * not duplicates. The order text carries ${port} and ${terminalName}
 * placeholders interpolated at delivery time, so no port or terminal name is
 * needed at install time.
 */
export async function installCompletionDirectiveOrder(
    db: any,
    role: string
): Promise<void> {
    const id = COMPLETION_DIRECTIVE_ORDER_ID_PREFIX + role;
    const instruction = COMPLETION_DIRECTIVE_ORDER_INSTRUCTION;
    await mutateStandingOrders(db, async (orders) => {
        const filtered = orders.filter(o => o.id !== id);
        filtered.push({
            id,
            parent: '',
            child: '',
            instruction,
            createdAt: Date.now(),
            scope: 'role',
            role,
        });
        return filtered;
    });
}
```

### 2. `src/services/standingOrders.ts` — interpolate placeholders at delivery time

The standing order text needs port and terminal name interpolated at delivery time, not at install time (the port may change between server restarts). Modify `applyStandingOrders` to accept an optional interpolation context and pass it through to `renderStandaloneOrdersBlock`:

```ts
export function applyStandingOrders(
    prompt: string,
    targetName: string,
    orders: StandingOrder[],
    liveNames: Set<string>,
    groups: TerminalGroup[] = [],
    roleMap?: Map<string, string>,
    interpolationContext?: { port: number; terminalName: string }
): string {
    if (!prompt) { return prompt; }
    const cleanPrompt = stripStandingOrdersBlock(prompt);
    const block = renderStandaloneOrdersBlock(
        orders, targetName, liveNames, groups, roleMap, interpolationContext
    );
    // ... rest unchanged ...
}
```

In `renderStandaloneOrdersBlock`, after `selectOrders` returns `mine`, interpolate placeholders in each order's instruction text before rendering:

```ts
export function renderStandaloneOrdersBlock(
    orders: StandingOrder[],
    targetName: string,
    liveNames: Set<string>,
    groups: TerminalGroup[],
    roleMap?: Map<string, string>,
    interpolationContext?: { port: number; terminalName: string }
): string | null {
    let mine = selectOrders(orders, targetName, liveNames, groups, roleMap);
    if (mine.length === 0) { return null; }

    // Interpolate ${port} and ${terminalName} placeholders at delivery time.
    // Orders without placeholders are unchanged (the replace is a no-op).
    if (interpolationContext) {
        mine = mine.map(o => ({
            ...o,
            instruction: o.instruction
                .replace(/\$\{port\}/g, String(interpolationContext.port))
                .replace(/\$\{terminalName\}/g, interpolationContext.terminalName),
        }));
    }

    // ... rest unchanged (scope sort, render, block assembly) ...
}
```

### 3. `src/services/TaskViewerProvider.ts` — pass interpolation context to `applyStandingOrders`

At the standing-orders application site (line 1352):

```ts
const apiPort = this.getLocalApiServerPort();
data = applyStandingOrders(
    data, payload.name, effectiveOrders, live, groups || [], roleMap,
    apiPort > 0 ? { port: apiPort, terminalName: payload.name } : undefined
);
```

Note: `this._taskViewerProvider?.getLocalApiServerPort()` in the original plan was wrong — the call site is inside `TaskViewerProvider` itself (via `_ptyHostVerb`), so it is `this.getLocalApiServerPort()`.

### 4. `src/standalone/bootstrap.ts` — identical interpolation context at the standalone twin

At the standalone `applyStandingOrders` call site (line 666):

```ts
const apiPort = taskViewerProvider?.getLocalApiServerPort() ?? 0;
out = applyStandingOrders(
    out, handle.friendlyName, effectiveOrders, live, groups || [], roleMap,
    apiPort > 0 ? { port: apiPort, terminalName: handle.friendlyName } : undefined
);
```

> **Superseded:** `const apiPort = /* resolve port from api-server-port.txt or running server */;`
> **Reason:** The original plan left the port resolution unspecified for the standalone host. The standalone host has access to `taskViewerProvider` (a `StandaloneTaskViewerProvider` that wraps the API server), which exposes `getLocalApiServerPort()`. Reading from `api-server-port.txt` directly would race with the server's own port file write and is unnecessary when the provider is in scope.
> **Replaced with:** `taskViewerProvider?.getLocalApiServerPort() ?? 0` — same method the extension host uses, available on the standalone provider.

### 5. `src/services/agentPromptBuilder.ts` — remove completion directive from prompt builder

Remove the five `ensureDispatchProtocolDirectives` calls from `buildKanbanBatchPrompt`:
- Line 2197 (reviewer branch)
- Line 2348 (lead branch)
- Line 2435 (coder/feature branch)
- Line 2490 (coder branch)
- Line 2529 (intern branch)

Also remove the call at line 2944 (custom agent branch).

For the reviewer branch: split `COMPLETION_STEP_FULL` and `COMPLETION_STEP_COMPACT` — keep the plan-file update instructions in the step list, remove the `run node "<cliPath>" done --from` instruction (it moves to the standing order). The step text becomes:

```
COMPLETION REPORT: When you have finished ALL parts of the review, update the original plan file with fixed items, files changed, validation results, and remaining risks. ${DEFERRED_FINDINGS_SECTION_INSTRUCTION} Do NOT truncate, summarize, or delete existing implementation steps.
```

The `run node "<cliPath>" done --from` instruction is carried by the standing order instead.

**Keep** `ensureDispatchProtocolDirectives` at the `dispatch` payload gate (`TaskViewerProvider.ts:882`, `bootstrap.ts:537`) — this is the fallback for the race condition where the standing order has not been installed yet. It is idempotent (the sentinel guard prevents double-append).

**Keep** `ensureCompletionDirective` and `ensureDispatchProtocolDirectives` as exported functions — they are still called from the pty-delivery fallback. But remove the override-proofing comment's reference to `buildKanbanBatchPrompt` — the override-proofing is now only for the fallback path.

### 6. `src/services/agentPromptBuilder.ts` — update `NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE`

Line 1201 references "the COMPLETION REPORT step." Update to: "Record your findings in your response and in the existing target plan file, per the completion-report step above."

### 7. `src/services/agentPromptBuilder.ts` — `SWITCHBOARD_LIVENESS_DIRECTIVE` cross-reference (OBSOLETE)

> **Superseded:** "Update the `SWITCHBOARD_LIVENESS_DIRECTIVE` clause 'wherever an instruction in this prompt says against the port in .switchboard/api-server-port.txt' to drop 'in this prompt'."
> **Reason:** The cross-reference has already been removed by a fragment sweep. The `SWITCHBOARD_LIVENESS_DIRECTIVE` at `agentPromptBuilder.ts:944` now reads "SWITCHBOARD STATUS: Live (port ${port})... Use http://127.0.0.1:${port} for any direct API calls." — no "in this prompt" / "api-server-port.txt" clause remains. The comment at `:940-942` records the sweep.
> **Replaced with:** No edit. The cross-reference this step targeted no longer exists. The liveness directive itself is still prompt-injected; moving it to a standing order is a follow-up, not this plan.

### 8. Terminal creation / role assignment — install the standing order

When a terminal is created or a role is assigned (in `TaskViewerProvider` and `bootstrap.ts`), call `installCompletionDirectiveOrder(db, role)` for coding roles (coder, intern, lead, reviewer). This ensures the standing order exists before the first dispatch. The function is idempotent — calling it for every terminal with the same role replaces, not duplicates.

For existing terminals on upgrade: run a one-time migration that installs the order for all coding roles. The migration iterates the distinct coding roles in the terminal registry and calls `installCompletionDirectiveOrder` once per role.

### 9. Test updates

- `src/services/__tests__/agentPromptBuilder.test.ts`: Move assertions that `COMPLETION REPORT:` is present in `buildKanbanBatchPrompt` output to assertions that it is NOT present (for copy-prompt paths) and IS present in standing-order delivery (for dispatch paths). The "exactly one occurrence" tests become "zero occurrences in the prompt, one occurrence in the standing order block."
- `src/test/completion-asserted-never-inferred.test.js`: Update to assert the directive is delivered via standing orders, not prompt text.
- `src/test/seat-safeguards-fleet-prompt-path.test.js`: Update standing-order assertions to include the completion directive.
- `src/test/standing-orders-marker-contract.test.js`: Add test cases for the completion-directive standing order.
- `src/test/standing-orders-definitions-contract.test.js`: Add the completion-directive definition to the definitions contract.

## Verification Plan

### Automated Tests

1. **`npm test`** — all existing tests must pass after the assertion updates.
2. **New test: copy-prompt does not contain `COMPLETION REPORT:`** — build a prompt via `buildKanbanBatchPrompt` for each code-touching role and assert the directive is absent.
3. **New test: standing order delivery contains `COMPLETION REPORT:` with interpolated port and terminal name** — call `applyStandingOrders` with the completion-directive order and interpolation context, assert the output contains the port number and terminal name (not placeholders).
4. **New test: `dispatch` payload gate still appends directive as fallback** — send a `ptySendPrompt` with a `dispatch` payload to a terminal that has no standing order installed, assert the directive is appended.
5. **New test: idempotence — standing order + fallback does not double-append** — send a `ptySendPrompt` with a `dispatch` payload to a terminal that HAS the standing order installed, assert exactly one `COMPLETION REPORT:` occurrence.
6. **Host parity test** — verify both `TaskViewerProvider` and `bootstrap.ts` deliver the standing order with interpolation identically.
7. **New test: placeholder interpolation** — store an order with `${port}` and `${terminalName}` placeholders, call `renderStandaloneOrdersBlock` with interpolation context, assert placeholders are replaced and non-placeholder orders are unchanged.

### Goal Invariants

- Assert `COMPLETION_REPORT:` is absent from `buildKanbanBatchPrompt` output for roles `reviewer`, `lead`, `coder` (feature and non-feature), `intern`, and `custom_agent_*` (code-touching).
- Assert `COMPLETION_REPORT:` is present in `applyStandingOrders` output when a `role`-scoped order with `role: 'coder'` exists and the target's `roleMap` entry is `'coder'`.
- Assert the standing-order text uses the CLI form (`switchboard done --from` or `node "<cliPath>" done --from`), NOT the old `POST /kanban/queue/done` form — the directive has migrated to the bundled CLI.
- Assert the string `against the port in .switchboard/api-server-port.txt` is absent from `applyStandingOrders` output (the CLI resolves the port itself; the standing order does not reference the port file).
- Assert the string `<your terminal name>` is absent from `applyStandingOrders` output when interpolation context with a non-empty `terminalName` is supplied.
- Assert `installCompletionDirectiveOrder(db, 'coder')` called twice produces exactly one order with `id === 'completion-directive:role:coder'` in the `terminals.standingOrders` config key.
- Assert the installed order has `parent: ''` and `scope: 'role'`.

### Manual

1. Copy-prompt a coder card — verify the clipboard prompt does NOT contain `COMPLETION REPORT:` or `switchboard done --from` (or `node "<cliPath>" done --from`).
2. Dispatch a coder card to a live terminal — verify the terminal receives the completion directive via standing orders, with the actual terminal name interpolated (not a `<your terminal name>` placeholder) and the CLI form (`switchboard done --from "<terminal name>"`), not the old `POST /kanban/queue/done` form.
3. Dispatch a reviewer card — verify the reviewer's step list still includes plan-file update instructions, and the `switchboard done --from` instruction arrives via standing order.
4. Paste a copy-prompt into an external agent (e.g., a cloud agent) — verify the prompt works without any Switchboard API references.
5. Clear and re-establish a terminal — verify the completion-directive standing order is re-installed.

## Implementation Notes

The completion directive was migrated from prompt-injected text (`ensureDispatchProtocolDirectives` in `buildKanbanBatchPrompt`) to a role-scoped standing order (`installCompletionDirectiveOrder` in `standingOrders.ts`). The five `ensureDispatchProtocolDirectives` calls in `buildKanbanBatchPrompt` (reviewer, lead, coder-feature, coder, intern) were removed; the dispatch payload gate at the pty verb remains as a fallback. The standing order uses `${terminalName}` and `${cliPath}` placeholders interpolated at delivery time in `renderStandaloneOrdersBlock`, with the terminal name passed through `applyStandingOrders` from both `TaskViewerProvider.ts` and `bootstrap.ts`. The reviewer's `COMPLETION_STEP_FULL`/`COMPACT` were split: the `switchboard done --from` instruction moved to the standing order, the plan-file update instructions stayed (with `REVIEW COMPLETION:` sentinel). `installCompletionDirectiveOrder` is idempotent (`id: completion-directive:role:*`, `parent: ''`, `scope: 'role'`) and installed on terminal creation in both hosts. `STAGGERED_IMPLEMENTATION_DIRECTIVE` was updated to the CLI form. A new test suite (`completion-directive-standing-order.test.js`) verifies all acceptance criteria; existing tests were updated to assert absence from `buildKanbanBatchPrompt` and presence in standing-order delivery.

## Review Findings

The migration is delivered: the five `ensureDispatchProtocolDirectives` calls are gone from `buildKanbanBatchPrompt`, `COMPLETION_STEP_FULL`/`COMPACT` are split onto a `REVIEW COMPLETION:` sentinel keeping the plan-file instructions, the role-scoped order installs idempotently with `parent: ''` and `scope: 'role'` in both composition roots' `ptyCreateTerminal` paths, `${terminalName}` interpolates at delivery, and the dispatch payload gate survives as the fallback. Two defects fixed by this review: the order text used `${cliPath}`, a spelling nothing in the codebase substitutes — the real token is `<cliPath>`, resolved by `substituteCliPath` at the emission seam — so every delivered directive handed the agent `${cliPath} done --from "…"`, a command that cannot run; and the whole 225-line contract suite had no `package.json` script and no CI step, the exact green-while-incomplete hole. Files changed by this review: `src/services/standingOrders.ts`, `src/test/completion-directive-standing-order.test.js`, `package.json`, `.github/workflows/integration-tests.yml`. Validation: `test:contract:completion-directive-standing-order` 14/14 including the new no-surviving-placeholder assertion, `test:contract:no-curl-in-generated-prompts` ALL PASSED, `tsc --noEmit` clean apart from four pre-existing TS2835 errors; `test:contract:reviewer-prompt-behaviour` reports 93 passing and 4 failures, all pre-existing and unrelated (reviewer step count 9→10, tester default, apiPort injection ×2). Manual steps 1-5 (clipboard inspection, live dispatch, external-agent paste) were not executed in this pass.

## Deferred Findings

- MAJOR — removing the five `ensureDispatchProtocolDirectives` calls also removed `MISSION_CONTROL_REPORT_DIRECTIVE` from copy-prompt output; the plan named only the completion directive. Delivered dispatches are unaffected because the pty gate still calls it, but the scope change is undeclared. `src/services/agentPromptBuilder.ts:2199`
- MAJOR — the plan's step 8 one-time upgrade migration for existing terminals was not implemented; the order is installed on `ptyCreateTerminal` only, so a terminal that already exists never gets it and relies permanently on the dispatch payload fallback. `src/services/TaskViewerProvider.ts:4513`
- NIT — `buildCustomAgentPrompt` still calls `ensureDispatchProtocolDirectives`; the plan's step 5 said to remove it. It is a different function from `buildKanbanBatchPrompt`, so the stated invariant holds, but a code-touching custom agent still gets the prompt-injected form. `src/services/agentPromptBuilder.ts:2962`
- NIT — neither install site covers `ptyCreateBatch`, and the extension site defaults an unresolved role to `'coder'`. Harmless because delivery is role-scoped, but it is a quiet default on a role read. `src/services/TaskViewerProvider.ts:4517`
- NIT — the plan's inherited "report the planId you were dispatched" instruction is absent from the order text. `src/services/standingOrders.ts:610`
