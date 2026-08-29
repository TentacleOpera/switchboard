# One coder callback delivers four prompts to the lead, three of them carrying the whole standing-orders block

## Goal

Reduce a coder completion to one notification at the lead, and stop machine-origin notifications carrying the lead's standing-orders block. A single subtask callback currently delivers four separate prompts into the team head's terminal, three of which append roughly two thousand words of standing orders that the lead already holds and did not ask for again.

### The problem, captured live

From a team lead's terminal during a normal feature run, for **one** coder finishing **one** subtask:

1. `❭ Implemented lead-dispatched coder completion report directive feature. Changes: …` — the coder's own report, sent via the standing-order step-3 fallback (`POST /terminals/verb/ptySendPrompt` to the head). **Ends with the full `=== STANDING ORDERS ===` block.**
2. `❭ ping` — a bare liveness poke. **Also ends with the full standing-orders block.**
3. `❭ [queue/done] Coding-coder-1 reports its dispatched task complete (plan 68df47bb…) …` — the system relay. No standing orders (correct), but it now carries the whole directive bundle: `SUBAGENT POLICY`, `GIT POLICY`, `SKIP COMPILATION`, `SKIP TESTS`, `CAVEMAN MODE`, `SUPPRESS WALKTHROUGH`, `Accuracy Mode`.
4. `❭ Coding-coder-1 completed task: … Changed: …` — a second coder report. **Standing-orders block again.**

Four prompts, three full standing-orders blocks, one directive bundle, for a single callback. The lead's own useful output — its review of the diff, its dispatch decision — is a few lines between these walls of boilerplate.

### Root cause 1 — the relay rule was never generalised

Both relay sites already know this is wrong and act on it. `LocalApiServer.ts:5604`:

> *"A machine-origin relay: clearBeforePrompt false (never reset the lead's context), **standingOrders false (a relay is not a task dispatch — appending the lead's standing-orders block is pure inflation on the relay path)**."*

Its twin at `:3395` passes `standingOrders: false` too. **The relays are correct — about the standing-orders block.** What is missing is that the same rule was never applied to the **other two appends** that fire on a `ptySendPrompt`: the **seat directive block** (`buildSeatDirectiveBlock`) and the **dispatch-protocol directive** (`ensureDispatchProtocolDirectives`). `standingOrders: false` gates ONLY `applyStandingOrders` (`TaskViewerProvider.ts:922` → `:1086`; `bootstrap.ts:369` → `:383`). The seat block is gated by a *separate* flag, `applySeatBlock` (`:923`), and the dispatch directive by `roleTakesDispatchDirectives(role)` (`:1073` / `bootstrap.ts:365`). The relay sets neither, so both fire. Item 3's bundle is the seat block; the dispatch directive rides along behind it.

The discriminator cannot be the recipient's role. A lead legitimately receives real dispatches that *must* carry all three appends. What separates them is the **nature of the message**: a notification versus a task dispatch. The relays declare it explicitly (via `standingOrders: false`); the agent path has no way to, and the relay's own declaration covers only one of three appends.

### Root cause 2 — the coder reports twice

The standing orders give the coder a routed decision (step 1 `queue/done`, step 2 team queue, step 3 fallback to head) and the observed behaviour is that both the `queue/done` route **and** the step-3 fallback fired — producing the relay (3) *and* two direct reports (1 and 4). The routing prose reads as a fallback chain, but nothing enforces exclusivity: a coder that posts `queue/done` and then also reports to its head satisfies its literal instructions.

> **Superseded (root-cause coupling):** Root causes 1 and 2 were presented as three independent fixes (a flag, a prose change, a directive-bundle gate). The investigation found them **coupled**.
> **Reason:** The proposed origin flag is a *reliable* lever only for **host-internal** callers — the relay sites in `LocalApiServer.ts`, where the host sets the payload. Items 1, 2, and 4 are the **coder LLM** calling `ptySendPrompt` from its own terminal. The coder is the caller; it will only set an origin flag if the standing-orders text tells it to, and model compliance is not guaranteed. Relying on the flag to suppress the agent-direct path is a wish, not a mechanism.
> **Replaced with:** Root cause 2's **exclusive routing** is the load-bearing fix for items 1/2/4 — make the direct report not fire alongside the relay by construction. The origin flag is the load-bearing fix for item 3 (the relay), which the host controls. The step-3 fallback (the only agent-direct path that survives exclusivity) sets the flag via standing-orders text as a best-effort belt, not as the primary gate.

### Root cause 3 — the directive bundle now reaches relays

> **Superseded:** `lead` is a member of `DISPATCH_DIRECTIVE_ROLES`, added by `feature_plan_20260817141300_lead-dispatched-coders-never-get-the-completion-report-directive`. That plan's intent was to give a *dispatched coder* the completion directive it was missing. A side effect is that every machine relay into a lead now appends the full directive bundle, which is item 3's boilerplate. The gate is on the recipient's role, and a relay is not a dispatch regardless of who receives it.
> **Reason:** This attributes item 3's cited boilerplate (`SUBAGENT POLICY`, `GIT POLICY`, `SKIP COMPILATION`, `SKIP TESTS`, `CAVEMAN MODE`, `SUPPRESS WALKTHROUGH`, `Accuracy Mode`) to the wrong append. Those strings are emitted by **`buildSeatDirectiveBlock`** (`agentPromptBuilder.ts:1328`), gated by `applySeatBlock` (`TaskViewerProvider.ts:923/1044`, `bootstrap.ts:343/346`) — NOT by `DISPATCH_DIRECTIVE_ROLES`. `DISPATCH_DIRECTIVE_ROLES` gates `ensureDispatchProtocolDirectives` (`:1073` / `bootstrap.ts:365`), which appends the **`COMPLETION REPORT:`** handshake — a different, smaller block. Both appends fire on the relay because the relay opts out of neither, but the bulk of the cited noise is the seat block. Naming `DISPATCH_DIRECTIVE_ROLES` as the source sends the implementer to the wrong gate.
> **Replaced with:** Item 3's boilerplate is the **seat block** (`buildSeatDirectiveBlock`, gated by `applySeatBlock`), with the **dispatch-protocol directive** (`ensureDispatchProtocolDirectives`, gated by `roleTakesDispatchDirectives`) riding behind it. Both must be gated by the new origin flag. The `DISPATCH_DIRECTIVE_ROLES` change itself is still correct and must not be reverted — it fixed a real gap for dispatched coders; gate on origin instead of reverting it.

### Why this matters beyond noise

The operator reports that the lead's terminal display freezes mid-run — text stops updating, recovering only when the run ends — and that **this began with the standing-orders spam**. That symptom is not yet root-caused and is not claimed here. But four large pastes per callback is the load under which it appeared, so this plan is the first thing to land and re-test against: if the freeze is a volume effect, cutting four inflated prompts to one small one removes the cause without a second fix.

## Metadata

- **Complexity:** 5
- **Tags:** backend, reliability, ux, refactor

## User Review Required

None. Four decisions are made here:

1. **Origin is declared by the caller, never inferred from the recipient.** A `machineOrigin` flag on the prompt payload, set by the relays and (best-effort, via standing-orders text) by the agent report path. Role-based inference is what put the directive bundle on relays in the first place.
2. **A notification carries none of the three appends** — not standing orders, not the seat block, not the dispatch-protocol directive. All three exist to equip a seat for work it is about to do. A seat being told that someone else finished is not about to do that work.
3. **The coder reports once.** The routed decision becomes exclusive: whichever branch fires, the others do not. This is a prose fix in the standing orders plus an enforcement point, not a new mechanism. This — not the flag — is the reliable fix for the agent-direct reports (items 1, 2, 4).
4. **The flag is named `machineOrigin`, not `notification`.** `notification` is already semantically overloaded in this codebase (turn-end notification, stall notification, Mission Control notification). `machineOrigin` says what the discriminator IS.

## Complexity Audit

### Routine

- Threading a `machineOrigin` flag through the `ptySendPrompt` payload and honouring it where all three appends are decided.
- Setting the flag at the two relay sites in `LocalApiServer.ts` (host-internal, reliable).

### Complex / Risky

- **Gating all three appends, not one.** The flag must suppress `applyStandingOrders` (gated by `applySO`), `buildSeatDirectiveBlock` (gated by `applySeatBlock`), AND `ensureDispatchProtocolDirectives` (gated by `roleTakesDispatchDirectives`). Suppressing only the first two leaves the completion-report directive; suppressing only the first and third leaves the seat block — the bulk of the cited noise. The original draft named only two of three.
- **Not stripping a real dispatch.** `applyStandingOrders` is `$`-anchored and must stay last on genuine dispatches. Contract tests already pin that ordering (`seat-safeguards-fleet-prompt-path.test.js:807/1656`) and must stay green. The seat-block cache (`_seatBlockCache` / `seatBlockCache`) must not be poisoned by a suppressed notification.
- **The `ping`.** Its origin was not identified during this investigation — it is not the WebSocket keepalive (`terminalWsGateway.ts:1173` handles that at the protocol level), and no literal `ping` exists in `src/`. It is most likely agent-emitted (a model habit or a standing-order liveness instruction in the runtime-composed block). Trace it before implementing. A bare liveness poke that costs a standing-orders block should be deleted, not slimmed.
- **Agent-compliance reliance.** The flag is reliable for the relay; for the agent-direct path it depends on the coder LLM setting it. Exclusive routing (root cause 2) is the structural fix; the flag on the step-3 fallback is best-effort only.
- **Making the coder's report exclusive** touches the standing-orders library text, which is versioned and migrated on read. Check `Review-Team Head Standing Orders Must Migrate On Read` before editing the block.
- **Both hosts.** The relay sites are in `LocalApiServer.ts` (shared); the append decisions live in `TaskViewerProvider.ts` (`:922-1101`) and `bootstrap.ts` (`:343-386`). All three appends must honour the flag in both roots, and the two roots must not diverge.

## Edge-Case & Dependency Audit

- **A real dispatch to a lead still carries everything.** The head takes work directly; that path is unchanged. The flag is set only on relays and the fallback report, never on a dispatch.
- **A notification to a seat with no standing orders installed** is a no-op either way.
- **`seatBlock: false` cannot be reused for the relay.** It is a host-only field stripped at the HTTP boundary (`TaskViewerProvider.ts:3548-3549`, `bootstrap.ts` twin), and the relay reaches the delivery layer via `terminalVerb`→`handlePtyVerb` (the HTTP-facing wrapper, wired at `:3747`), which performs the strip. `notifyTurnEnd` bypasses the strip by calling `_ptyHostVerb` directly (`:2067`); the relay does not. This is why a new caller-settable flag is required rather than reusing the existing opt-out.
- **Both hosts.** The relay sites are in `LocalApiServer.ts`; the append decision lives in `TaskViewerProvider.ts` and `bootstrap.ts`. All three need the flag honoured, and the two roots must not diverge.
- **Do not revert the `DISPATCH_DIRECTIVE_ROLES` change.** It fixed a real gap for dispatched coders. Gate on origin instead, so the coder keeps its directive and the relay loses it.

## Dependencies

- **Interacts with** `feature_plan_20260817141300_lead-dispatched-coders-never-get-the-completion-report-directive` (landed — `roleTakesDispatchDirectives` and `DISPATCH_DIRECTIVE_ROLES` are present in `src/services/agentPromptBuilder.ts:1197` and wired at both delivery chokepoints). Root cause 3 is its side effect.
- **Related:** `The "Seat Has Gone Quiet" Notice Flaps, and Every Flap Wakes the Lead` (PLAN REVIEWED, in *Dispatch prompt and completion handshake*). Same shape — machine traffic amplified at the head. Landing both reduces the same load.
- **Blocks re-testing** the lead-terminal display freeze, which the operator associates with the arrival of this spam.

## Adversarial Synthesis

Key risks: (1) Suppressing too narrowly — gating only standing orders and the dispatch directive leaves the seat block, which is the bulk of item 3's noise; mitigated by gating all three appends and by a verification assertion that names the seat-block markers (`SUBAGENT POLICY`/`GIT POLICY`) as absent. (2) Relying on the coder LLM to set the flag on its direct report — mitigated by making routing exclusive (root cause 2) so the direct report does not fire alongside the relay, with the flag on the step-3 fallback as belt only. (3) Declaring the freeze fixed because the noise stopped — this plan explicitly does not claim that; re-test and root-cause separately if it survives.

## Proposed Changes

### Prompt payload — the `machineOrigin` flag

- Add a `machineOrigin: true` field to the `ptySendPrompt` payload. It is **caller-settable and NOT stripped** at the HTTP boundary (unlike `seatBlock`/`addonsComposed`), so the relay — which reaches delivery via `terminalVerb`→`handlePtyVerb` — can set it.
- When set, suppress **all three** appends at both delivery chokepoints:
  1. `applyStandingOrders` — set `applySO = false` (`TaskViewerProvider.ts:922`; `bootstrap.ts:369`).
  2. `buildSeatDirectiveBlock` — set `applySeatBlock = false` (`TaskViewerProvider.ts:923`; `bootstrap.ts` equivalent). **This is the append the original draft omitted, and it is the source of item 3's cited bundle.**
  3. `ensureDispatchProtocolDirectives` — skip the `roleTakesDispatchDirectives(role)` branch (`TaskViewerProvider.ts:1073`; `bootstrap.ts:365`).
- Set it at `LocalApiServer.ts:3440` and `:5643` (the two relay sites, which already pass `standingOrders: false` — the flag subsumes and generalises that).

> **Superseded (Proposed Changes — Prompt payload):** "Add a `notification` origin flag … When set: skip `applyStandingOrders` and skip the dispatch-directive append, regardless of recipient role."
> **Reason:** Two defects. (a) The skip list omits the **seat block** (`buildSeatDirectiveBlock`), which is the actual source of item 3's `SUBAGENT POLICY`/`GIT POLICY`/`SKIP COMPILATION` bundle — implementing the draft as written leaves item 3 inflated. (b) The name `notification` collides with existing overloaded terms (turn-end notification, stall notification).
> **Replaced with:** A `machineOrigin` flag that suppresses all three appends — standing orders, seat block, and dispatch-protocol directive — at both delivery chokepoints. See above.

### Standing-orders text — exclusive routing

- Make the coder's completion routing exclusive: the first **successful** branch ends the report. The step-3 fallback fires only when the primary (`queue/done`) **fails**, not in addition to it. This is the structural fix for items 1, 2, and 4 — the agent-direct reports that the flag cannot reliably suppress.
- In the step-3 fallback text, instruct the coder to include `machineOrigin: true` in its `ptySendPrompt` payload, as a best-effort belt (the primary suppression is exclusivity, not the flag).

### The `ping`

- Trace its origin before implementing. Most likely agent-emitted (no literal in `src/`); check the runtime-composed standing-orders block delivered to coders and any liveness instruction. Remove it, or — if it is a genuine liveness need — make it carry `machineOrigin: true`.

## Files Changed

- `src/services/LocalApiServer.ts` — set `machineOrigin: true` on both relays (`:3440`, `:5643`); the existing `standingOrders: false` becomes redundant but is kept for clarity until the flag is proven.
- `src/services/TaskViewerProvider.ts` — honour `machineOrigin` at all three append decisions (`:922`, `:923`, `:1073`); ensure it is NOT in the HTTP-boundary strip list (`:3548-3549`).
- `src/standalone/bootstrap.ts` — honour `machineOrigin` at the twin append decisions (`:343`, `:365`, `:369`); ensure it is NOT in the standalone strip.
- The standing-orders library — exclusive routing text + the step-3 `machineOrigin` instruction (migrated on read).
- Tests — see Verification Plan.

## Verification Plan

> **Session directive:** compilation and automated tests are NOT executed in this run. The checks below remain the plan's verification contract for the implementing coder; they are simply not run now.

### Automated Tests

1. **One callback, one notification.** Run a coder through a full subtask and assert the lead receives exactly one message about it.
2. **Notifications are lean — all three appends absent.** Assert that a relay (`machineOrigin: true`) carries NONE of: the `=== STANDING ORDERS ===` block, the seat-block markers (`SUBAGENT POLICY`, `GIT POLICY`, `SKIP COMPILATION`, `SKIP TESTS`, `CAVEMAN MODE`, `SUPPRESS WALKTHROUGH`), or the `COMPLETION REPORT:` directive. The original draft's "no standing-orders block" assertion is insufficient — it would pass while the seat block still inflated the relay.
3. **Dispatches are unchanged.** A real dispatch to a coder still carries the directive bundle and seat block; a real dispatch to a lead still ends with standing orders — the existing `$`-anchored ordering assertions (`seat-safeguards-fleet-prompt-path.test.js:807/1656`) stay green.
4. **The fallback still fires on failure — exactly once.** Force the primary route (`queue/done`) to fail and assert the report still reaches the head exactly once, lean (carrying `machineOrigin: true`).
5. **Exclusivity.** When the primary route succeeds, assert NO direct `ptySendPrompt` report reaches the head from the coder.
6. **No `ping`** *(gated on the trace)*. Assert no bare liveness prompt reaches a seat. This assertion is only valid after the `ping`'s origin is located; until then it is a placeholder, not a gate.
7. **Both hosts.** The `machineOrigin` suppression and the non-strip assertion must hold in both the `TaskViewerProvider` and `bootstrap` delivery paths.

### Goal Invariants

- Assert `machineOrigin: true` on the payload at `LocalApiServer.ts` relay site A (`:3440`) and relay site B (`:5643`).
- Assert `machineOrigin` is absent from the HTTP-boundary strip list at `TaskViewerProvider.ts:3548-3549` and the `bootstrap.ts` twin (it must survive as a caller-settable field).
- Assert that when `payload.machineOrigin === true`, the `buildSeatDirectiveBlock` branch (`TaskViewerProvider.ts:1044` / `bootstrap.ts:343`) is skipped — count of seat-block markers in the delivered text equals 0.
- Assert that when `payload.machineOrigin === true`, the `roleTakesDispatchDirectives` branch (`TaskViewerProvider.ts:1073` / `bootstrap.ts:365`) is skipped — `COMPLETION REPORT:` is absent from the delivered text.
- Paired negative/positive for dispatches: when `machineOrigin` is unset, the seat-block markers ARE present and `COMPLETION REPORT:` IS present on a dispatch to a coder (regression guard against over-suppression).

## Outstanding Questions

- **[user]** The `ping` (item 2) could not be located in `src/` — it is most likely agent-emitted. Proceeding on the assumption that it is a model habit or a runtime-composed standing-orders liveness instruction, to be removed or flagged `machineOrigin: true` once traced. The verification assertion for it is held as a placeholder until the trace lands.

## Recommendation

Complexity 5 → **Send to Coder.** Multi-file, two-host parity, a standing-orders migration, and a behavioural reliance (agent compliance) that the exclusive-routing fix must backstop. Not intern-tier; not lead-tier.

## Implementation Summary

Implemented all three root-cause fixes across both hosts. (1) **`machineOrigin` flag**: added a caller-settable, non-stripped `machineOrigin: true` field to the `ptySendPrompt` payload at both relay sites in `LocalApiServer.ts` (`:3440`, `:5643`); honoured at all three append decisions — `applyStandingOrders`, `buildSeatDirectiveBlock`, and `ensureDispatchProtocolDirectives` — in both `TaskViewerProvider.ts` (`:922`, `:923`, `:1073`) and `bootstrap.ts` (`:295`, `:366`, `:370`). The flag is NOT in either host's HTTP-boundary strip list, so it survives the relay path. (2) **Exclusive routing**: `CONTEXT_AWARE_COMPLETION_ORDER_BODY` now declares routes 1/2/3 exclusive ("the first one that succeeds ends your report — do NOT also take the other routes") and the step-3 fallback payload includes `machineOrigin: true` as a best-effort belt. (3) **Migration**: `migrateCodingTeamOrders` rewrites system-installed context-aware completion orders (id prefix `context-aware-completion:`) whose frozen instruction matches the pre-exclusivity `LEGACY_CONTEXT_AWARE_COMPLETION_ORDER_BODY` text, so existing ~4,000 installs get the new routing on their next message. The `ping` (item 2) was traced — no literal exists in `src/`; it is agent-emitted, so no code change was needed (verification assertion remains a placeholder per the plan). Compilation and tests were skipped per session directives.

## Review Findings

The goal is achieved for the paths code can reach: the two relays (`LocalApiServer.ts:3462`, `:5665`) now set `machineOrigin: true`, both hosts suppress all three appends on it, the flag survives both HTTP-boundary strips, and `CONTEXT_AWARE_COMPLETION_ORDER_BODY` now declares routes 1/2/3 exclusive with `machineOrigin: true` on the step-3 fallback. One MAJOR was found and fixed: the standalone implementation gated the branches themselves (`if (applySeatBlock && !machineOrigin)`, `if (applyOrders && !machineOrigin)`), which broke two CI-wired assertions in `seat-safeguards-fleet-prompt-path.test.js` that anchor on the literal `if (applySeatBlock)` — `machineOrigin` is now folded into the two flags at the top of `deliverPrompt` (`bootstrap.ts:253`), which also restores the shape parity with `TaskViewerProvider.ts:922-923` the plan demands. Files changed by this review: `src/standalone/bootstrap.ts` (the fold), plus three pre-existing HEAD build breakages fixed forward so verification could run at all — `PlanIngestionEngine.ts:1134` (`_applyFeatureLink`'s outer `try` lost its `catch` in commit `0b124e0c`, TS1472, the project has not typechecked since), `LocalApiServer.ts:449` (`onWorkingStateCleared` declared 2 params, called with 3), `bootstrap.ts:2259` (`const records` reassigned). Verification: `tsc -p tsconfig.test.json` clean, `eslint` 0 errors, `seat-safeguards` 96 passed / 3 pre-existing count-drift failures (was 94/5), and `queue-done-relay`, `standing-orders-marker`, `coding-head-prompt`, `team-scoped-routing`, `standing-orders-fleet-root`, `minimal-prompt`, `terminal-coder-dispatch`, `atomic-team-lifecycle`, `task-complete`, `dispatch-curtain`, `pty-clear-policy`, `clear-readiness`, `queue-stall-watch` all green; the migration was exercised directly and rewrites both the `team-head` (raw body) and `team` (body + `GIT_SAFETY_DIRECTIVE`) shapes, leaves operator-custom text by reference, is idempotent on a second pass, and surfaces `stale` + `effectiveInstruction` through `describeStandingOrderMigrations` for the Standing Orders UI.

## Deferred Findings

- MAJOR — `LocalApiServer.ts:4534` is a third machine relay carrying the identical "relays are agent-to-agent notes, not task dispatches" rationale, and it still appends the seat block and the dispatch-protocol directive. Root cause 1 ("the relay rule was never generalised") covers it, but the plan named only two sites and this one can deliver to a seat that was just cleared, where suppressing the seat block would drop `GIT POLICY`/`SUBAGENT POLICY` outright. Needs its own decision, not a silent third flag. `src/services/LocalApiServer.ts:4534`
- MAJOR — none of the plan's five Goal Invariants has an automated guard. Nothing asserts `machineOrigin: true` at either relay site, nothing asserts it is absent from either strip list, nothing asserts a `machineOrigin` delivery carries zero seat-block markers and no `COMPLETION REPORT:`. The paired positive (a real dispatch still carries both) is only incidentally covered. `src/services/LocalApiServer.ts:3462`
- NIT — `machineOrigin: true` combined with `clearBeforePrompt: true` suppresses the seat block on a clearing send while leaving the pre-clear entry in `_seatBlockCache`/`seatBlockCache`, so the next non-clearing dispatch would not re-deliver it. Unreachable from every shipped caller (all three pass `clearBeforePrompt: false`, and an omitted flag defaults to `false` in both hosts), so no guard was added. `src/services/TaskViewerProvider.ts:923`
- NIT — `parsedDispatchRole` is resolved inside the block that `machineOrigin` now skips, so a machine-origin message whose text carried a `PLANS TO PROCESS:` header would register a dispatch with an empty role. Unreachable: `extractDispatchIdentity` requires that header and no relay text has one. `src/services/TaskViewerProvider.ts:949`
- NIT — `migrateCodingTeamOrdersClient` is documented as the client mirror of `migrateCodingTeamOrders` but mirrors only the drop half, not the new rewrite. Self-healing (the host persists the rewrite on the first delivery) and the only consumer is the shift-drop paste path. `src/webview/terminals.js:11317`
- NIT — item 2 (the bare `ping`) is still unaddressed and still arrives without `machineOrigin`, so it still costs a full standing-orders block. Traced and confirmed agent-emitted with no literal in `src/`, exactly as the plan's Outstanding Question anticipated; no code reaches it. `src/services/teamWiring.ts:155`
- PRE-EXISTING (not this plan) — `seat-safeguards` has three red count assertions from other work: 12 `_dispatchExecuteMessage` call sites against an audited 7, 9 uncomposed dispatch sites against 5, and 2 `ptyListTerminals` calls against 1. `src/test/seat-safeguards-fleet-prompt-path.test.js:519`
- PRE-EXISTING (not this plan) — `completion-asserted-never-inferred`'s `wireSpawnedTeam` test fails because its key-blind db mock lets the definitions write clobber the orders array; `external-headed-team` test 8 and `queue-pipeline`'s `_scheduleQueuePop` assertion are red from other work. `src/test/completion-asserted-never-inferred.test.js:195`
