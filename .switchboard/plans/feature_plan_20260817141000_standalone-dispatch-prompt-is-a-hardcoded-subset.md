# Standalone Dispatch Builds Its Own Prompt Instead of Calling generateUnifiedPrompt

## Goal

Under `npx switchboard`, a card dispatched from the board must produce the **same prompt** the VS Code extension produces. Today it does not: the standalone host hand-rolls a four-line prompt and every dispatch-scoped directive is silently missing.

### The problem

`src/standalone/bootstrap.ts:123-149` defines `buildPromptForCards(role, records, root)`. In full, it emits:

```
You are acting as the Switchboard <role> agent.
<FOCUS_DIRECTIVE>

Process the following N plan(s):

--- <planFile> (topic: …) ---
<first 20 000 chars of the plan file>
```

That is the entire prompt. It is called at `bootstrap.ts:1720`, inside the `triggerAction` arm (`:1651`) — the path every board drag-drop, every `POST /kanban/dispatch`, and every single-card trigger in the browser cockpit takes.

The extension host does not use it. `KanbanProvider.generateUnifiedPrompt` (`src/services/KanbanProvider.ts:4935-5262`) resolves ~40 options and hands them to `buildKanbanBatchPrompt`. Everything below is present there and absent in standalone:

| Missing in standalone | Where the extension gets it |
| :--- | :--- |
| Per-project **PRD injection** | `_resolvePrdReferences` → `resolvedOptions.prdReferences` (`KanbanProvider.ts:5115-5118`), emitted in `dispatchPrefixCore` — reaches every role |
| Per-project **design-system** references | `_resolveDesignSystemReferences` (`KanbanProvider.ts:5119-5122`) |
| **BATCH_EXECUTION_RULES** | `agentPromptBuilder.ts:789`, applied inside `buildKanbanBatchPrompt` |
| **Workflow-file redirection** | `workflowFilePathEnabled` / `workflowFilePath` per role (`KanbanProvider.ts:5089-5090`) |
| **Constitution** link + content | `_resolveConstitution` (planner / tester / custom-agent branches of `generateUnifiedPrompt`) |
| **Feature orchestration directive** | `_buildFeatureDirectivePrefix` (`KanbanProvider.ts:5255-5260`) + `featureMode` / `featureTopics` / `subtaskCount` |
| **Feature subtask expansion** | `buildDispatchPlans` appends the active-subtask bundle — standalone passes raw `records`, so a feature dispatches as a lone card with no subtasks |
| Git policy, safeguards, subagent policy, remote-mode, pair-programming, Phone-a-Friend, delegate directive | `resolvedOptions` (`KanbanProvider.ts:5062-5106`) |
| Per-project **prompt overrides** | `_getDefaultPromptOverrides(workspaceRoot, initiatorProject)` (`KanbanProvider.ts:5059`) |

> **Superseded:** the table row *"**PROJECT PIN** directive — `PROJECT_LINE_DIRECTIVE(options.manifestProject)` (`agentPromptBuilder.ts:1246`, emitted at `:2108-2113`)"*, listed as missing in standalone.
> **Reason:** Verified against HEAD — not a parity gap. `manifestProject` is never populated in `generateUnifiedPrompt`'s `resolvedOptions`; it arrives only from an explicit `overrides` field, and the only two callers that set it are the **chat/copy-prompt** paths (`KanbanProvider.copyGeneralChatPrompt:1377-1384` and the chat arm at `:9845-9848`). The extension's own board dispatch does **not** emit a PROJECT PIN block either, so swapping standalone onto `generateUnifiedPrompt` neither gains nor loses it.
> **Replaced with:** row removed from the gap table. Do **not** add a `manifestProject` override to the standalone call site to "close" it — that would be net-new scope and would make standalone diverge from the extension in the opposite direction. The corresponding "confirm which override key sets it" item is likewise removed from the Edge-Case audit, resolved.

### Root cause

The gap is **not** a missing capability. `generateUnifiedPrompt` is fully reachable from the standalone host and always has been:

- `bootstrap.ts:802-810` constructs a real `KanbanProvider` with the headless seams, broadcaster and workspace root injected.
- `bootstrap.ts:846-847` wires it to a real `TaskViewerProvider` in both directions.
- The `triggerAction` arm already calls `kanbanProvider._getScopedSetting(...)` (`:1657`) and `kanbanProvider.getProjectFilter()` (`:1718`) from inside itself.
- `bootstrap.ts:280-281` already calls `kanbanProvider.resolveSeatPromptOptions(role)` — which itself calls `_getPromptsConfig`, i.e. exactly the config resolution `generateUnifiedPrompt` needs. It works headless today.
- `vscode.workspace.getConfiguration` resolves through `src/standalone/vscodeShim.ts:192`.

`buildPromptForCards` is a leftover from before the provider was wired up. Two later fixes patched around it rather than removing it: the `dispatch-analysis` arm (`bootstrap.ts:1719-1720`) was bolted on because "`buildPromptForCards` has no notion of `instruction`", and the seat-scoped directives were pulled out of it into `deliverPrompt`. Nobody deleted the function; the dispatch-scoped half of the prompt was never restored.

### Second, smaller root cause: the API port reads as 0 headless

`generateUnifiedPrompt` plumbs `apiPort: this._taskViewerProvider?.getLocalApiServerPort() ?? 0` (`KanbanProvider.ts:5085`; the custom-agent branch reads the same accessor at `:5006`). `getLocalApiServerPort()` returns `this._localApiServer?.getPort() ?? 0` (`TaskViewerProvider.ts:3720-3722`), and `_localApiServer` is only assigned by the extension's own `_startLocalApiServer` (`:3138`). Standalone wires its server through `taskViewerProvider.setApiServer(server)` (`bootstrap.ts:2330`), which assigns `_apiServerForBroadcast` (`TaskViewerProvider.ts:841-843`) — a different field, and one the extension never assigns at all.

So under `npx switchboard` the port resolves to 0 and both the Phone-a-Friend directive and the delegate directive are omitted, *even after* this plan's main change. Fixing this is in scope because it is otherwise a silent second parity hole hiding behind the first. Three existing readers in the same file already handle both fields (`TaskViewerProvider.ts:811`, `:816`, `:1338`); the accessor is the odd one out.

## Metadata

**Complexity:** 6
**Tags:** backend, cli, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Widening `getLocalApiServerPort()` to fall back to `_apiServerForBroadcast`.
- Deleting `buildPromptForCards` and replacing section 11 of `src/test/seat-safeguards-fleet-prompt-path.test.js`.

### Complex / Risky

- **Record shape.** `buildDispatchPlans` takes `KanbanPlanRecord[]`; the `triggerAction` arm already holds exactly that (`db.getPlanBySessionId` / `db.getPlanByPlanFile` results at `:1680-1686`). No adaptor is needed — but the shape must be verified per-field, not assumed.
- **Feature dispatch changes behaviour.** Today a feature card dispatches as one plan with no subtasks. After the change it expands, enters feature mode, and (for `role === 'coder'`) triggers `_regenerateFeatureFile` per feature. That is the correct behaviour and the point of the change, but it is a real behavioural delta in standalone — the prompt gets much longer and a file on disk is rewritten.
- **The tester role throws.** `generateUnifiedPrompt` *throws* for `role === 'tester'` when no PRD resolves. `buildPromptForCards` never threw. The `triggerAction` arm must catch and return `{ success: false, error }` rather than letting a rejection escape the verb handler.
- **`dispatch-analysis` routing order.** `buildDispatchAnalysisPrompt` (`bootstrap.ts:158-178`) is documented as byte-for-byte matching the extension's arm and deliberately omits plan bodies. `generateUnifiedPrompt`'s own `dispatch-analysis` arm (`KanbanProvider.ts:5031-5053`) is equivalent — but note the local builder currently reads the **correct** port (`server?.getPort() ?? 0`, the live standalone local) while `generateUnifiedPrompt` reads the broken accessor. Routing through the provider is therefore a *regression* until change (1) lands. Order: port fix first, then the swap.
- **Seat-block double-emission (cross-plan).** See Edge-Case audit — the delivery call site must flip to `applySeatBlock = false`, and the sibling completion-directive plan rides the same flag.

## Edge-Case & Dependency Audit

**Race conditions**

- **`sql.js` heap.** Feature expansion adds per-subtask DB reads on every dispatch. The standalone process is long-lived and shares the WASM heap budget; this is well inside the existing per-tick sweep budget, but do not add a retry loop around it.
- No new concurrent writers. `_regenerateFeatureFile` writes the feature `.md`, which the plan watcher then re-imports — the same round trip a board dispatch already causes in the extension.

**Security**

- No new surface. `apiPort` is already plumbed into prompts on the extension host; widening the accessor exposes the same localhost port to the same directives.

**Side effects**

- **Empty plan array.** `generateUnifiedPrompt` returns the preamble rather than `''` for `plans: []` (`KanbanProvider.ts:5246-5248`). The `triggerAction` arm already returns early on `records.length === 0` (`bootstrap.ts:1685`), so this is unreachable — keep that guard.
- **Custom agents.** `role.startsWith('custom_agent_')` takes an early-return branch (`KanbanProvider.ts:4943-5021`). Standalone's `targetRole` comes from `payload.role` or the column map, so a custom-agent role can arrive. The branch reads `_getCustomAgents` → `_taskViewerProvider.getCustomAgents`, which is wired headless, and reads `getLocalApiServerPort()` at `:5006` — so change (1) fixes its Phone-a-Friend directive too. No extra work, but it must be exercised in verification.
- **Worktrees.** The arm already computes `matchWorktreePath(activeWorktrees, records[0])` for terminal resolution (`bootstrap.ts:1725-1726`). `buildDispatchPlans` resolves worktrees itself via the record heuristic when no `worktreePathMap` is passed — pass **no map**, matching the CLI/trigger mode the docstring describes. Do not hand it the terminal-resolution value.

**Dependencies & conflicts**

- **Seat block double-emission.** `deliverPrompt` appends the seat directive block unless told not to (`bootstrap.ts:246-317`). `generateUnifiedPrompt` already emits git policy / skip / caveman directives inside the prompt body. The extension host solves this with `addonsComposed: true` on board-composed prompts (`TaskViewerProvider.ts:460`). Standalone's `deliverPrompt` has **no such flag** — its 5th parameter `applySeatBlock` is positional. The board-dispatch call site at `bootstrap.ts:1758` must pass `applySeatBlock = false` after this change, or every standalone dispatch carries the git-policy block twice.
- **Sibling plan interaction (`feature_plan_20260817141300_lead-dispatched-coders-never-get-the-completion-report-directive.md`).** That plan adds a role-gated `ensureDispatchProtocolDirectives` append **inside** the same `applySeatBlock` branch. Flipping this call site to `false` therefore also skips that append — which is correct and intended: the prompt built by `generateUnifiedPrompt` already carries the bundle from `buildKanbanBatchPrompt`. Land the sibling first, then this plan, so the coder making the flip can see the append it is bypassing. Do not "restore" `true`.
- **`initiatorProject`.** Pass `kanbanProvider.getProjectFilter()` as `overrides.initiatorProject` so per-project prompt overrides (`_getDefaultPromptOverrides`) and the routing map (`_routingMapForScope`) resolve against the board the dispatch came from — the same value the arm already reads at `:1718`.
- **No migration.** Nothing on disk changes shape. `buildPromptForCards` is unreleased-path code in the standalone host and takes a clean break.

## Dependencies

- `feature_plan_20260817141300_lead-dispatched-coders-never-get-the-completion-report-directive.md` — same feature; edits the body of `bootstrap.ts` `deliverPrompt` and appends to `src/test/seat-safeguards-fleet-prompt-path.test.js`, both of which this plan also touches. Land that plan first, then this one. Do not run the two concurrently against `bootstrap.ts`.
- No external dependencies. `buildDispatchPlans` and `generateUnifiedPrompt` are public on `KanbanProvider` at HEAD and already exercised headless by `resolveSeatPromptOptions`'s shared `_getPromptsConfig` path.

## Adversarial Synthesis

**Risk summary.** The swap is a deletion plus one provider call, but it changes three behaviours at once: feature cards now expand (longer prompts, a feature file rewritten on disk), the tester role can now *throw* where the old builder never did, and the composed prompt must stop re-collecting the seat block or every dispatch ships the git policy twice. The second root cause is the sharper trap — routing `dispatch-analysis` through the provider *before* widening `getLocalApiServerPort()` swaps a correct port for a hardcoded `0`, so the port fix must land first. Mitigations: strict change ordering (port → delete → route → `applySeatBlock=false`), an explicit `try/catch` returning `{success:false,error}` around the provider call, and a cross-host prompt diff as the acceptance test rather than "the tests are green".

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — make the API port resolvable headless

At `:3720-3722`:

```ts
    public getLocalApiServerPort(): number {
        // `_localApiServer` is assigned only by the extension's own
        // `_startLocalApiServer`. The standalone host hands its server in through
        // `setApiServer`, which lands in `_apiServerForBroadcast` — so without this
        // fallback every headless prompt resolves apiPort to 0 and silently drops
        // the Phone-a-Friend and delegate directives.
        const server = this._apiServerForBroadcast ?? this._localApiServer;
        return typeof server?.getPort === 'function' ? (server.getPort() ?? 0) : 0;
    }
```

> **Superseded:** `const server = this._localApiServer ?? this._apiServerForBroadcast;` — "Order matters: `_localApiServer` first, so the editor host's behaviour is byte-identical."
> **Reason:** The stated reason does not hold, and the order contradicts the file's own precedent. `taskViewerProvider.setApiServer(...)` is called **only** from `bootstrap.ts:2330`; the extension never assigns `_apiServerForBroadcast` (its `setApiServer` calls at `:3590-3605` target the *other* providers). Both orders are therefore byte-identical in the editor host, and the three existing readers of this pair in this same file (`:811`, `:816`, `:1338`) all read `_apiServerForBroadcast ?? _localApiServer`.
> **Replaced with:** `_apiServerForBroadcast ?? _localApiServer`, matching the file's three existing readers so a future reader does not have to work out why one accessor inverts the idiom.

### 2. `src/standalone/bootstrap.ts` — delete `buildPromptForCards`

Remove lines `123-149` in full. Remove the now-unused `FOCUS_DIRECTIVE` import from the `agentPromptBuilder` specifier list (`:11-17`) if nothing else in the file references it (`buildDispatchAnalysisPrompt` does not).

### 3. `src/standalone/bootstrap.ts` — route `triggerAction` through the provider

Replace the prompt-building block at `:1710-1721`:

```ts
                    const analysisScope = payload.analysisScope !== undefined
                        ? payload.analysisScope
                        : kanbanProvider.getProjectFilter();

                    let prompt: string | null = null;
                    try {
                        // ONE builder for both hosts. No worktreePathMap: this is the
                        // CLI/trigger mode, where buildDispatchPlans resolves worktrees
                        // from the record itself (matchWorktreePath), which is exactly
                        // what the terminal-resolution block below already does.
                        const dispatchPlans = await kanbanProvider.buildDispatchPlans(root, records);
                        prompt = await kanbanProvider.generateUnifiedPrompt(
                            targetRole,
                            dispatchPlans,
                            root,
                            {
                                instruction: payload.instruction,
                                analysisScope,
                                initiatorProject: kanbanProvider.getProjectFilter(),
                                ...(targetColumn ? { destinationColumn: targetColumn } : {}),
                            }
                        );
                    } catch (promptErr) {
                        // generateUnifiedPrompt THROWS for the tester role with no PRD.
                        // buildPromptForCards never threw, so this arm had no failure
                        // path. Report it instead of rejecting out of the verb handler.
                        return {
                            success: false,
                            error: promptErr instanceof Error ? promptErr.message : String(promptErr)
                        };
                    }
                    if (!prompt) { return { success: false, error: 'Failed to build dispatch prompt' }; }
```

The `payload.instruction === 'dispatch-analysis'` special case disappears: `generateUnifiedPrompt` handles that instruction itself (`KanbanProvider.ts:5031-5053`), and with change (1) its `apiPort` now resolves to the live port instead of `0`. `buildDispatchAnalysisPrompt` (`:158-178`) and its `buildAnalysisScopeLine` import can be deleted along with it.

**Land change (1) before this one.** Routing `dispatch-analysis` through the provider while the accessor still returns `0` replaces a correct `API_PORT=` line with `API_PORT=0` — a regression the local builder does not have.

### 4. `src/standalone/bootstrap.ts` — stop double-appending the seat block

The dispatch delivery at `:1758` currently takes the default `applySeatBlock = true`:

```ts
                    // 4th arg: standing orders still apply (a dispatched seat reports to
                    // its head). 5th arg: the seat block does NOT — generateUnifiedPrompt
                    // already emitted the git policy / skip / caveman directives, and the
                    // dispatch-protocol bundle, inside the prompt body. This is the
                    // positional twin of the extension's `addonsComposed: true`
                    // (TaskViewerProvider.ts:460).
                    await deliverPrompt(terminal, prompt, getPromptDeliveryOptions(), true, false);
```

Also extend the comment on `deliverPrompt`'s `applySeatBlock` parameter (`:236-245`) to name this call site as the composed-prompt exception, so the next reader does not "fix" it back.

### 5. `src/test/seat-safeguards-fleet-prompt-path.test.js` — replace the four dead tests

Section 11 (`:681-720`) asserts facts about a function that no longer exists. Note their failure modes are not uniform: the three negative assertions (`no longer hardcodes GIT_SAFETY_DIRECTIVE` / `SKIP_COMPILATION_DIRECTIVE` / `SKIP_TESTS_DIRECTIVE`) resolve `indexOf(...) === -1` and slice an **empty** body, so they pass **vacuously** once the function is gone; only `standalone buildPromptForCards keeps FOCUS_DIRECTIVE (dispatch-scoped)` actually goes red. Delete all four — a vacuous green is worse than a red — and replace with a parity contract:

```js
// ── 11. Standalone dispatch uses the shared prompt builder ──────────────
test('standalone triggerAction calls generateUnifiedPrompt, not a local builder', () => {
    assert.ok(!/function buildPromptForCards/.test(BOOTSTRAP_SRC),
        'buildPromptForCards must be gone — the standalone host builds prompts via KanbanProvider');
    assert.ok(/kanbanProvider\.buildDispatchPlans\(/.test(BOOTSTRAP_SRC),
        'standalone must funnel records through buildDispatchPlans (feature subtasks are dropped otherwise)');
    assert.ok(/kanbanProvider\.generateUnifiedPrompt\(/.test(BOOTSTRAP_SRC),
        'standalone must build its dispatch prompt with generateUnifiedPrompt');
});

test('standalone dispatch does not re-append the seat directive block', () => {
    const arm = BOOTSTRAP_SRC.slice(BOOTSTRAP_SRC.indexOf("case 'triggerAction'"));
    const call = arm.slice(0, arm.indexOf('updateDispatchInfoByPlanFile'));
    assert.ok(/deliverPrompt\(terminal, prompt, getPromptDeliveryOptions\(\), true, false\)/.test(call),
        'a composed prompt must pass applySeatBlock=false or the git policy block is delivered twice');
});

test('getLocalApiServerPort resolves the standalone-wired server', () => {
    const fn = TASK_VIEWER_SRC.slice(TASK_VIEWER_SRC.indexOf('public getLocalApiServerPort()'));
    assert.ok(/_apiServerForBroadcast/.test(fn.slice(0, 400)),
        'the accessor must fall back to the field setApiServer writes, or every headless prompt reads apiPort 0');
});
```

(The existing constant in this file is `TASK_VIEWER_SRC` — not `TASKVIEWER_SRC`.)

## Verification Plan

### Automated Tests

1. `npx tsc --noEmit -p .` — no type errors from the new `buildDispatchPlans` / `generateUnifiedPrompt` call.
2. `node --test src/test/seat-safeguards-fleet-prompt-path.test.js` — new section 11 passes; nothing else in that file regresses.
3. `node --test src/test/dispatch-plan-builder.test.js` — the "plan arrays for dispatch must come from buildDispatchPlans" guardrail still holds and now covers standalone.
4. Run the full suite and diff against the pre-change baseline. Five tests are red at HEAD independently of this work — stash-verify before attributing any failure to this change.

### Manual / end-to-end

5. **Headless.** From a workspace with an active project that has a PRD and a constitution:
   - `npx switchboard --verbose`, open the browser board.
   - Drag a loose plan card to a coder column. Read the delivered prompt in the terminal pane. Assert present: `CRITICAL INSTRUCTIONS:` (batch rules), the PRD reference line, the constitution link, and the git-policy block **exactly once**.
   - Drag a **feature** card. Assert the prompt enters `FEATURE MODE`, lists every active subtask under `[SUBTASK]` labels, and that the feature file on disk was regenerated (`git status` shows it modified).
   - Click **Analyze** on the Planned column. Assert the prompt is the read-only `dispatch-analysis` form (skill path, `API_PORT=<real non-zero port>`, `PLANS TO PROCESS`, **no** inlined plan bodies).
   - With Phone-a-Friend enabled for the coder role, assert the directive's curl URL carries the live port, not `:0`.
   - Dispatch to a **custom agent** role and assert the same non-zero port reaches its Phone-a-Friend directive (`KanbanProvider.ts:5006` reads the same accessor).
6. **Cross-host diff.** Dispatch the same plan to the same role in the VS Code extension and in `npx switchboard`; capture both prompts and diff. The only permitted differences are the dispatch id in the Phone-a-Friend directive and the port number. Any other delta is a remaining parity gap and must be recorded.
7. **Tester-role failure path.** Dispatch a card to the tester role in a workspace with no project PRD. Assert the API returns `{ success: false, error: 'Acceptance review requires a product requirements baseline…' }` and the standalone process does not crash on an unhandled rejection.

---

**Recommendation:** Complexity 6 → **Send to Coder**.
