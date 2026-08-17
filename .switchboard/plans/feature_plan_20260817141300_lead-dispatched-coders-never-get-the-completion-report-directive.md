# Lead-Dispatched Coders Never Receive the Completion-Report Directive

## Goal

A coder dispatched **by a team lead** must receive the same completion-report handshake a coder dispatched **from the board** receives, so its card's working-state light clears when it finishes. Today it does not, and lead-driven cards systematically stay lit until a blind timeout sweeps them.

### The problem

`CODING_COMPLETION_REPORT_DIRECTIVE` (`src/services/agentPromptBuilder.ts:944`) is the sole signal the completion-detection chain keys on. Its own load-bearing comment (`:933-943`) names the three consumers:

- the activity-light OFF-switch — `PlanIngestionEngine` clears working state on the first plan-file **mtime advance** after dispatch (`src/services/PlanIngestionEngine.ts:444-483`);
- the autoban wake (`TaskViewerProvider.handleAutobanTurnEnd`);
- the switchboard-manage skill's Column Oversight pass.

All three depend on the dispatched agent editing the plan file at the end. If the agent is never told to, none of them fire.

### Root cause — the pty path *has* a directive gate, and the documented lead flow never opens it

> **Superseded:** "On that path the delivery layer appends exactly two things — and neither is the completion directive" (seat directive block, standing orders).
> **Reason:** Factually wrong at HEAD. The delivery layer appends **three** things. A dispatch-protocol bundle already exists on the pty path and already contains the completion directive — it is simply gated on a payload field that no documented caller sets. Diagnosing this as "the append does not exist" would have produced a fourth append site next to a working third one, and would have attached only *half* the bundle (see Proposed Changes §1).
> **Replaced with:** the three-row table and the gate analysis below.

| Appended at `ptySendPrompt` | Where | Gate | Carries the handshake? |
| :--- | :--- | :--- | :--- |
| Dispatch-protocol bundle (`ensureDispatchProtocolDirectives` = COMPLETION REPORT + ORCHESTRATOR REPORT) | `TaskViewerProvider.ts:527`, `bootstrap.ts:271-273` | `payload.dispatch` is an object | **Yes** |
| Seat directive block | `TaskViewerProvider.ts:589-613`, `bootstrap.ts:274-298` | `addonsComposed !== true && seatBlock !== false` (extension) / positional `applySeatBlock` (standalone) | No |
| Standing orders | `TaskViewerProvider.ts:615-633`, `bootstrap.ts:299-315` | `standingOrders !== false` / positional `applyOrders` | No |

The first row is the mechanism this defect needs, and it is unreachable in practice:

- `TaskViewerProvider._ptyHostVerb` (`:490-529`) treats a `dispatch` payload as a **folded** operation: it calls `attributePastedPrompt` through `handleServiceVerb`, fails the whole send if attribution attributes nothing, then applies `ensureDispatchProtocolDirectives(payload.data)` and reports `directivesAttached: ['COMPLETION REPORT', 'ORCHESTRATOR REPORT']`.
- `bootstrap.deliverPrompt` has the standalone twin: `if (dispatch && typeof dispatch === 'object') { out = ensureDispatchProtocolDirectives(out); }` (`:271-273`).
- **No skill documents the `dispatch` payload.** `.agents/skills/switchboard-orchestration/SKILL.md:185` documents the body as `{ name, data, clearBeforePrompt }`. `.agents/skills/terminal-coder-dispatch/SKILL.md:166-200` documents the *unfolded* two-call flow — `attributePastedPrompt` **first**, then a plain `ptySendPrompt`. A grep for a `dispatch` payload across `.agents/skills/` returns nothing.

So the documented, taught, and universally-used lead flow registers the dispatch correctly and then posts a prompt whose payload has no `dispatch` field — which skips the only gate that would have attached the handshake. The directive is not missing from the delivery layer; it is behind a door nobody was told about.

`buildSeatDirectiveBlock` (`agentPromptBuilder.ts:1046-1084`) emits only subagent policy, git policy, skip-compilation, skip-tests, caveman, suppress-walkthrough and accurate-coding. Its docstring is explicit (`:1012-1015`): dispatch-scoped addons are "deliberately absent — they reference plan files and are meaningless on arbitrary text sends." That reasoning is right for `FOCUS_DIRECTIVE` and `BATCH_EXECUTION_RULES`. It is wrong for the completion report, and the omission is what leaves the light on: `attributePastedPrompt` turns the card **on**, and nothing on the lead path ever turns it **off**.

### What actually happens to a lead-driven card

1. Lead calls `attributePastedPrompt` → `dispatched_at` stamped, light on.
2. Lead sends work → `ptySendPrompt` with no `dispatch` field → prompt arrives with seat block + standing orders and **no** completion directive.
3. Coder finishes, commits, replies to the lead. It never appends to the plan file, because nobody asked it to.
4. The silence sweep sees no mtime advance (`PlanIngestionEngine.ts:456-470`), so `completed` stays false and the card is stamped **blocked** instead (`:483-497`).
5. The card clears only when `clearStaleWorkingState` reaches it — `activityLight.timeoutMs`, default **10 minutes**, or `blockedTimeoutMs`, default **4 hours** (`PlanIngestionEngine.ts:322, 338`).

So the light is not merely cosmetic: successful lead-driven work is misreported as blocked to the whole oversight chain.

### Why the fix belongs in the delivery layer, not the skill

The obvious alternative — now that the `dispatch` payload is known to exist — is to teach the two skills to use it. That is **not enforcement**. A lower-effort seat drops wiring silently rather than refusing, so a skill instruction reproduces exactly this bug with no signal, and the folded form additionally *hard-fails the send* when attribution matches nothing, which turns a missing plan file into a lost dispatch. External orchestrators driving the HTTP surface directly are not bound by our skills at all.

The delivery chokepoint already carries a per-recipient, role-resolved append (the seat block resolves the recipient's role from the terminal record). The directive bundle is one more line on the same gate, and every member of the bundle is idempotent by construction (`agentPromptBuilder.ts:962-967`, `:986-991`), so a board-composed prompt or a folded `dispatch` send that already contains it is untouched.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, bugfix
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- The append itself: one call to the existing idempotent bundle guard at two existing chokepoints.
- Role allowlist: the same code-touching set the directive already targets on the board path.
- A one-line skill correction.

### Complex / Risky

- **Two hosts must stay identical.** `TaskViewerProvider._ptyHostVerb` (`:487-640`) and `bootstrap.deliverPrompt` (`:246-317`) are twins with different signatures — the extension uses payload flags (`addonsComposed`, `seatBlock`), standalone uses positional booleans. A fix landed in one host only is a parity gap, and standalone-parity audits routinely miss exactly this seam.
- **Bundle, not half of it.** `ensureDispatchProtocolDirectives` is the declared "add new dispatch-protocol directives HERE, never at a call site" entry point (`agentPromptBuilder.ts:993-996`), and `src/test/orchestrator-tick-and-reports-contract.test.js:357-360` asserts the report directive travels with every completion directive. Appending `ensureCompletionDirective` alone at a new site forks the bundle: lead-dispatched coders would get COMPLETION REPORT and not ORCHESTRATOR REPORT, while board- and `dispatch`-payload-driven coders get both.
- **Gate selection.** Appending on *every* `ptySendPrompt` would attach a plan-file instruction to a lead asking "status?". The gate must be the same one the seat block already uses, plus a role check — not a new mechanism and not a text heuristic on the prompt body.
- **Ordering.** The seat block strips and re-applies standing orders in a documented order (`bootstrap.ts:238-245`, `TaskViewerProvider.ts:936-941`): strip inbound SO → seat block → `applyStandingOrders`, because `STANDING_ORDERS_BLOCK_RE` is `$`-anchored and requires the SO block to be last. The directive bundle must be inserted **inside** that window, alongside the seat block, never after standing orders.

## Edge-Case & Dependency Audit

**Race conditions**

- **Repeat sends.** The seat block is cached per `agentInstanceId` and re-sent only on a clearing send or when the block text changes (`TaskViewerProvider.ts:602-611`, `bootstrap.ts:287-295`). The directive bundle must **not** ride that cache: every dispatch is about a different plan file and needs the handshake, and it is cheap. Append it unconditionally within the gate — the per-directive idempotence guards prevent duplication within a single prompt.
- No new persisted state, so no read/write race with the ingestion sweep. The sweep's completion test (`plan-file mtime > dispatchedAt`) is unaffected by prompt composition.

**Security**

- No new surface. The append reads the recipient's role from the terminal record the host already resolved; no user input reaches the directive text.

**Side effects**

- **Prompt growth on chatty channels.** Inside the gate the bundle rides *every* send to a code-touching seat, including a lead's "status?" ping — roughly 1.2 KB per send. This is the accepted cost of unconditional enforcement: a heuristic that suppressed it on "non-dispatch-looking" text is exactly the silent-drop failure this plan closes, and gating on "does the recipient have an outstanding dispatch record?" does not suppress the status-ping case either (the record is live while the coder works), so it buys nothing for an extra DB read per send.
- **ORCHESTRATOR REPORT reaches lead-driven coders.** They begin posting report files to `.switchboard/orchestrator/reports/`. That is already true of board-dispatched and `dispatch`-payload-dispatched coders, so this closes a divergence rather than opening one.

**Dependencies & conflicts**

- **Board dispatches must not double-append.** They set `addonsComposed: true` (`TaskViewerProvider.ts:460`), which already suppresses the seat block; the same flag suppresses this. Belt and braces: each guard no-ops when its sentinel is already present.
- **Folded `dispatch` sends must not double-append.** The bundle is applied at `TaskViewerProvider.ts:527` / `bootstrap.ts:272` *before* the seat-block gate. The second application is a no-op by idempotence.
- **Machine-origin notices.** `notifyTurnEnd` sends with `standingOrders: false` and the seat-block opt-out — verified in source: the standalone twin calls `deliverPrompt(handle, message, { clearBeforePrompt: false }, false, false)` (`bootstrap.ts:2085`). Those already fail the `applySeatBlock` gate, so a turn-end nudge will not carry a completion instruction telling a lead to edit a plan file. Re-verify explicitly after the change — this is the most likely wrong-recipient regression.
- **Sibling plan interaction (`feature_plan_20260817141000_standalone-dispatch-prompt-is-a-hardcoded-subset.md`).** That plan makes the standalone board dispatch pass `applySeatBlock = false`, which also skips *this* append. That is correct, not a hole: after that change the standalone board prompt is built by `generateUnifiedPrompt`, which already carries the bundle from `buildKanbanBatchPrompt`. Do not "fix" the composed-prompt call site back to `true`.
- **Role resolution.** The extension resolves the recipient's role from `terminals + hiddenTerminals` (`TaskViewerProvider.ts:591-593`); standalone reads `handle.role` directly (`bootstrap.ts:279`). An unresolved role is `''`. `''` must **not** be in the allowlist — an unknown seat is not necessarily a coder, and the seat block's fail-safe ("guardrail ON") does not transfer to an instruction about editing plan files.
- **Which roles.** Allowlist `coder`, `intern`, `lead` — matching `generateUnifiedPrompt`'s own code-touching branch. Exclude `reviewer`, `tester`, `planner`, `researcher`, `orchestrator`. Custom agents (`custom_agent_*`) already receive the directive on their own build path (`agentPromptBuilder.ts:2333`) but not on the pty path — include them, since a custom coding agent driven by a lead has the identical failure.
- **Role normalisation.** The extension has `_normalizeAgentKey`; standalone compares raw. Normalise inside the shared helper so both sides agree, or a seat whose role is stored as `Coder` slips through.
- **No new state, no migration.** Nothing persisted changes. This is prompt composition only.
- **Do not add a payload opt-out.** A `completionReport: false` flag would be a lever nobody sets correctly and the exact hollow-success hole this closes. The existing `seatBlock: false` / `addonsComposed: true` flags are sufficient and already have callers.

## Dependencies

- `feature_plan_20260817141000_standalone-dispatch-prompt-is-a-hardcoded-subset.md` — same feature; edits `bootstrap.ts` `deliverPrompt`'s docstring and its board-dispatch call site while this plan edits the function body, and rewrites section 11 of `src/test/seat-safeguards-fleet-prompt-path.test.js` while this plan appends to it. Land this plan **first** (it is the smaller edit and it makes the sibling's `applySeatBlock = false` decision legible), then serialise — do not run both against `bootstrap.ts` concurrently.
- No external dependencies. `ensureDispatchProtocolDirectives`, `buildSeatDirectiveBlock`, and both delivery chokepoints all exist at HEAD.

## Adversarial Synthesis

**Risk summary.** The dominant risk was mis-diagnosis, now closed: a dispatch-directive gate already exists on the pty path and appending beside it — with only half the bundle — would have forked the protocol while looking green. Remaining risks are host divergence (two twins with different signatures; a one-host fix is a silent standalone parity gap) and mis-gating (attaching a plan-file instruction to a reviewer, a tester, or a machine-origin turn-end notice). Mitigations: one shared, normalising role helper used verbatim by both hosts; the existing `applySeatBlock` gate reused rather than a new one; `ensureDispatchProtocolDirectives` (never a raw concat) so the bundle stays whole and idempotent; and explicit negative verification for reviewer, turn-end, board-composed, and folded-`dispatch` sends.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — name the code-touching set once

Add beside `ensureDispatchProtocolDirectives` (`:993-999`):

```ts
/**
 * Roles whose prompts must carry the dispatch-protocol bundle regardless of who
 * composed them. The board path appends it inside buildKanbanBatchPrompt and the
 * folded `dispatch` payload appends it at the pty verb; a lead composing its own
 * prose via a plain ptySendPrompt reaches neither, which is why its coders were
 * never told to append to the plan file. Keep this list in step with
 * generateUnifiedPrompt's code-touching branch.
 */
export const DISPATCH_DIRECTIVE_ROLES = new Set(['coder', 'intern', 'lead']);

/** True when `role` should receive the dispatch-protocol bundle on the pty
 *  delivery path. An EMPTY/unknown role returns false: an unresolved seat is not
 *  assumed to be a coder — unlike the seat block, whose fail-safe is "guardrail
 *  ON", a plan-file instruction to a non-coder is noise. Normalises here so the
 *  extension (which has _normalizeAgentKey) and standalone (which compares raw
 *  handle.role) cannot disagree about `Coder` vs `coder`. */
export function roleTakesDispatchDirectives(role: string): boolean {
    const key = (role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return DISPATCH_DIRECTIVE_ROLES.has(key) || key.startsWith('custom_agent_');
}
```

> **Superseded:** `COMPLETION_DIRECTIVE_ROLES` / `roleTakesCompletionDirective`, gating a bare `ensureCompletionDirective(...)` call.
> **Reason:** `ensureDispatchProtocolDirectives` is the declared single entry point for dispatch-protocol directives ("Add new dispatch-protocol directives HERE, never at a call site", `agentPromptBuilder.ts:993-996`), and both existing pty-path appends use it. Gating only the completion half would give lead-dispatched coders a different protocol from board- and `dispatch`-payload-dispatched ones, and would contradict `src/test/orchestrator-tick-and-reports-contract.test.js:357-360` ("the report directive travels with every completion directive").
> **Replaced with:** `roleTakesDispatchDirectives`, gating `ensureDispatchProtocolDirectives` — the whole bundle, one entry point, both hosts.

### 2. `src/services/TaskViewerProvider.ts` — append on the extension's chokepoint

Inside the `applySeatBlock` branch (`:589-613`), **after** the seat-block `try/catch` closes at `:612` and before the branch's own closing brace at `:613` — outside the `try` so a seat-block failure cannot swallow the handshake, and before the standing-orders block at `:615`:

```ts
                    // Dispatch-protocol handshake for lead-/orchestrator-dispatched
                    // work. The board path gets this from buildKanbanBatchPrompt and a
                    // folded `dispatch` payload gets it above; a lead composing its own
                    // prose via a plain ptySendPrompt reaches neither, so its coders were
                    // never told to append to the plan file — and the plan-file mtime
                    // advance is the ONLY thing that clears the card's working-state light
                    // (PlanIngestionEngine silence sweep). Idempotent, so a prompt that
                    // already carries it is untouched. Deliberately NOT inside the
                    // seat-block cache: every dispatch is about a different plan file.
                    // Placed before applyStandingOrders — the SO block must stay last.
                    if (roleTakesDispatchDirectives(role)) {
                        data = ensureDispatchProtocolDirectives(data);
                    }
```

`role` is resolved at `:592` (`targetRow?.role || ''`) inside the `try`. Hoist it to a `let role = '';` declared just above the `try` at `:590` so it is in scope at the append, and assign it inside — an exception during seat-block resolution then leaves `role === ''`, which fails the allowlist, which is the correct fail-safe for a plan-file instruction.

Add `ensureDispatchProtocolDirectives` and `roleTakesDispatchDirectives` to the existing `agentPromptBuilder` import (`ensureDispatchProtocolDirectives` may already be imported — do not duplicate the specifier).

### 3. `src/standalone/bootstrap.ts` — the identical append on the standalone twin

Inside `deliverPrompt`'s `applySeatBlock` block (`:274-298`), after the `} catch { /* a degraded prompt beats a lost dispatch */ }` at `:297` and before the block's closing brace at `:298`:

```ts
            // Twin of TaskViewerProvider.ts's append — see the comment there.
            // Positional `applySeatBlock` is this host's `addonsComposed`, so a
            // board-composed prompt (which passes false) is not touched, and the
            // turn-end notice (which passes false) never carries a plan-file
            // instruction to a lead.
            if (roleTakesDispatchDirectives(handle.role || '')) {
                out = ensureDispatchProtocolDirectives(out);
            }
```

`handle.role` is read directly here rather than reusing the `const role` declared inside the `try` at `:279`, for the same scope/fail-safe reason as §2. `ensureDispatchProtocolDirectives` is already imported (`:16`); add `roleTakesDispatchDirectives` to the same specifier list.

### 4. `.agents/skills/switchboard-orchestration/SKILL.md` — one line, no new ceremony

Append to the `ptySendPrompt` row's Purpose cell (`:185`): *"The dispatch-protocol directives (COMPLETION REPORT, ORCHESTRATOR REPORT) are appended automatically for coder/intern/lead recipients — do not paste your own."*

Nothing else changes. The skill must not grow a checklist for a thing the system now guarantees, and the two-call `attributePastedPrompt` → `ptySendPrompt` flow documented in `terminal-coder-dispatch` stays correct as written.

### 5. `src/test/seat-safeguards-fleet-prompt-path.test.js` — contract tests

```js
test('pty delivery appends the dispatch-protocol bundle for code-touching roles', () => {
    for (const src of [TASK_VIEWER_SRC, BOOTSTRAP_SRC]) {
        assert.ok(/roleTakesDispatchDirectives\(/.test(src),
            'both hosts must gate the dispatch directives on the recipient role');
    }
});

test('the pty-path append uses the whole bundle, not the completion half', () => {
    for (const src of [TASK_VIEWER_SRC, BOOTSTRAP_SRC]) {
        const at = src.indexOf('roleTakesDispatchDirectives(');
        const window = src.slice(at, at + 240);
        assert.ok(/ensureDispatchProtocolDirectives\(/.test(window),
            'the role-gated append must use ensureDispatchProtocolDirectives — a bare ensureCompletionDirective forks the protocol');
    }
});

test('the dispatch directives are appended before standing orders', () => {
    for (const src of [TASK_VIEWER_SRC, BOOTSTRAP_SRC]) {
        const directivesAt = src.indexOf('roleTakesDispatchDirectives(');
        const soAt = src.indexOf('applyStandingOrders(', directivesAt);
        assert.ok(directivesAt > -1 && soAt > -1 && directivesAt < soAt,
            'STANDING_ORDERS_BLOCK_RE is $-anchored — the SO block must stay last');
    }
});

test('an unresolved role does not take the dispatch directives', () => {
    assert.strictEqual(roleTakesDispatchDirectives(''), false);
    assert.strictEqual(roleTakesDispatchDirectives('reviewer'), false);
    assert.strictEqual(roleTakesDispatchDirectives('Coder'), true, 'role comparison must normalise case');
    assert.strictEqual(roleTakesDispatchDirectives('custom_agent_x'), true);
});
```

Import `roleTakesDispatchDirectives` alongside the existing `ensureDispatchProtocolDirectives` import at `:44`.

## Verification Plan

### Automated Tests

1. `npx tsc --noEmit -p .` clean.
2. `node --test src/test/seat-safeguards-fleet-prompt-path.test.js` — new contracts pass, existing seat-block/standing-order ordering assertions still pass.
3. `node --test src/test/orchestrator-tick-and-reports-contract.test.js` — the "report directive travels with every completion directive" contract still holds.
4. Full suite. Five tests are red at HEAD independently of this work — stash-verify before attributing any failure to this change.

### Manual / end-to-end

5. **Extension host.** Start a lead + one coder. From the lead terminal:
   ```bash
   PORT=$(cat .switchboard/api-server-port.txt); BASE="http://127.0.0.1:$PORT"
   curl -s -X POST "$BASE/terminals/verb/ptySendPrompt" -H 'Content-Type: application/json' \
     -d '{"name":"coder-1","data":"Implement .switchboard/plans/<file>.md","clearBeforePrompt":false}'
   ```
   Assert the coder terminal shows both `COMPLETION REPORT:` and `ORCHESTRATOR REPORT:` at the end of the delivered text, above the standing-orders block. Let the coder finish; assert the card's working light clears on the plan-file write **within one sweep tick (~10s)** rather than after the 10-minute timeout.
6. **Negative: reviewer.** Repeat with `name` pointing at a reviewer seat. Assert **no** `COMPLETION REPORT:` block.
7. **Negative: turn-end notice.** Force a turn-end notification to a lead. Assert the delivered notice carries neither the seat block nor the dispatch directives.
8. **No double-append: board.** Dispatch a card from the board to a coder. Assert `COMPLETION REPORT:` appears **exactly once** in the delivered prompt.
9. **No double-append: folded dispatch.** Post `ptySendPrompt` with a `dispatch` payload (`{ planId, planFile, role }`) to a coder. Assert the response carries `directivesAttached` and the delivered text contains each sentinel **exactly once**.
10. **Standalone parity.** Repeat steps 5–9 under `npx switchboard`, driving `deliverPrompt` through the same HTTP verb. Both hosts must produce byte-identical directive placement.
11. **Board rollup.** With a lead driving three subtasks of one feature, assert every card clears on its own completion and the feature's blocked ring never lights — the observable end of the reported defect.

---

**Recommendation:** Complexity 4 → **Send to Coder**.
