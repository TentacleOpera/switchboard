# Standing Orders — Add Scope (Global / Team / Pair), Drop the Caps

## Goal

Give a standing order a `scope` — **global** (every agent hears it), **team** (a team's members hear it), or **pair** (one terminal, about another — today's ad-hoc link-up). Remove the three arbitrary caps and the liveness gate that only make sense for the pair scope, and apply orders on the VS Code delivery path as well as the PTY one.

### Problem analysis and root cause

**A standing order is meant to be "text attached to a prompt, plus who hears it." The implementation only ever built one of the three audiences, and everything downstream is bent around that.**

Today an order is `{ id, parent, child, instruction, createdAt }` where `parent` is the terminal that *receives* the block and `child` is the terminal it is *about*. `applyStandingOrders` (`src/services/standingOrders.ts:53`) filters `o.parent === targetName && liveNames.has(o.child)` and renders each as:

```
- Regarding terminal "<child>": <instruction>
```

Every order must therefore name a partner terminal. That single assumption produces every problem in this plan:

1. **A team cannot have a prompt.** A 4-member team is not one prompt, it is four near-identical pair records that each have to name the head. This is why `teamWiring.wireSpawnedTeam` writes N standing-order rows instead of storing a team prompt, and why `linkPresets.ts` relationships are *templates that generate pair-order text* rather than team configuration.
2. **A workspace-wide note is impossible.** "Here is what we are working on today, all agents please note" has no partner terminal to name.
3. **Safeguards do not fit.** A git-safety rule is not *about* another terminal. Put one in and the agent reads `- Regarding terminal "Lead": Never run git reset --hard…`, which is incoherent.
4. **The liveness gate deletes orders for the wrong reason.** `liveNames.has(o.child)` is correct for a pair order (a note about a dead terminal is noise) and wrong for the other two scopes — a global note must not vanish because some unrelated terminal exited.

**The caps are unjustified.** `MAX_ORDERS = 20`, `MAX_INSTRUCTION_CHARS = 2000`, `MAX_BLOCK_CHARS = 4000` (`standingOrders.ts:13-15`) are bare constants with **no comment and no rationale**, introduced in a bulk commit. Verified against what they could plausibly protect:

- **Not prompt size.** The dispatch prompts these are appended to routinely run far larger than 4000 chars (full plan lists, git policy, workflow bodies). The delivery path chunks at 256 bytes with an 8 ms pace, so 4000 chars is ~16 chunks — about a tenth of a second.
- **Not storage.** Worst case at the cap is 20 × 2000 ≈ 40 KB of JSON in one DB config row.
- **Not per-prompt volume.** `applyStandingOrders` filters to `o.parent === targetName`, so a terminal only ever renders *its own* orders — a member has one, a lead with four head-receives members has four. `MAX_ORDERS` is global across the workspace, so it does not bound what reaches any prompt. What it actually bounds is **how many teams you can have**.

`MAX_ORDERS` is also enforced as a hard refusal at team creation (`agentGroupInstantiation.ts:98`, `teamWiring.ts:488`, `LocalApiServer.ts:2367`), and **nothing ever prunes orders** — the only deletion is an explicit API call with an order id (`LocalApiServer.ts:2392`). There is no close/exit hook in the fleet service or either host. Since member names derive from the head's name (`${parent.friendlyName}-${d.label || d.role}`, `ptyFleetService.ts:525`) and heads pick up a collision counter, a head that comes up as `Lead` and later `Lead-2` yields a different pair and a new row. The count only rises, and at 20 **no team starts at all**.

`MAX_BLOCK_CHARS` truncation is a hard mid-sentence slice plus a `…[standing orders truncated]` marker. Harmless while the block only says "report to your head"; actively dangerous once safeguards live there.

**There are three render sites today, not one — and the plan originally named one.** This is the finding that most changes the size of the work. Verified by reading each:

| # | Site | Shape |
| :-- | :--- | :--- |
| 1 | `applyStandingOrders` (`standingOrders.ts:53-74`) | The canonical resolver |
| 2 | `applyStandingOrdersClient` (`terminals.js:8285-8299`) | **A full hand-copied mirror** — same filter, same `- Regarding terminal "X":` template, same `MAX_BLOCK_CHARS` truncation, its own `MAX_BLOCK_CHARS`/`MAX_INSTRUCTION_CHARS` constants at `terminals.js:8145-8146`, and its own character counter at `:8275` |
| 3 | `syncSendEnabled` (`terminals.js:8266-8278`) | Renders the `len / MAX_INSTRUCTION_CHARS` counter in the Link-up modal |

Site 2 is live, not vestigial: `terminals.js:4196` calls it on the Shift-drop paste path, which — per the comment there — "bypasses both hosts, so the standing-orders block must be applied client-side". A scope-aware server renderer paired with an unchanged client mirror means a `global` order **never renders on Shift-drop at all** (the mirror filters `o.parent === targetName`, and a global order has no `parent`), while a `team` order that does slip through renders with the `- Regarding terminal "undefined":` framing this plan exists to remove.

**Two host chokepoints exist today, not one.** `applyStandingOrders` is hooked at `_ptyHostVerb` (`TaskViewerProvider.ts:440`), described in-code as "the sole extension-host chokepoint" — true *for that host*. The standalone host has its own at `deliverPrompt` (`bootstrap.ts:227-243`), described as "sole standalone chokepoint". Both must learn the new scopes.

> **Superseded:** "`applyStandingOrders` is hooked at `_ptyHostVerb` (`TaskViewerProvider.ts:422`), described in-code as 'the sole extension-host chokepoint'. That is true for the PTY fleet, the HTTP terminals rail and the browser cockpit."
> **Reason:** Line-number drift (`:422` → `:440`), and the framing implied a single hook to update. There are two host hooks plus a webview mirror; a change made at one of three renders behaves differently depending on which surface delivered the prompt.
> **Replaced with:** Two host chokepoints — `TaskViewerProvider.ts:440` and `bootstrap.ts:238` — plus the webview mirror at `terminals.js:8285`. Step 7 adds a fourth (`sendRobustText`).

**The VS Code path never gets orders.** VS Code terminal agents are delivered through `sendRobustText` (`terminalUtils.ts:130`, called at `TaskViewerProvider.ts:5175` and `:5256`), which bypasses both chokepoints entirely. This is a one-line omission, not an architectural boundary: both functions take a string and put it in a terminal.

**A contract test enforces the caps and the chokepoint count.** `src/test/standing-orders-marker-contract.test.js` is not incidental — it mechanically asserts the things this plan changes:

- §5 (`:104-115`) extracts `MAX_BLOCK_CHARS` and `MAX_INSTRUCTION_CHARS` from **both** `standingOrders.ts` and `terminals.js` and asserts they match. `extractNumber` **throws** when the constant is absent, so deleting the caps fails these two tests outright rather than skipping them.
- `:229-239` asserts an over-cap block truncates and announces itself.
- `:245` asserts `validateInstruction` rejects over-length text.
- §6 (`:135-185`) asserts each host has exactly one delivery chokepoint and that both gate on `payload.standingOrders !== false`.

Deleting the caps without touching this file turns four assertions red. Updating it is part of the change, not follow-up.

**Blast radius.** `terminals.standingOrders` is shipped state. Existing rows have no `scope` field and MUST keep working unchanged — `scope` is absent ⇒ `pair`, which is exactly today's behaviour.

## Metadata

**Complexity:** 6
**Tags:** backend, refactor, reliability

> **Superseded:** **Complexity:** 4 — "Mostly deletion."
> **Reason:** The improve pass found three surfaces the plan did not account for: a full hand-copied resolver mirror in the webview with its own constants, a contract test whose assertions go red on the cap deletion, and — the substantive one — that `applyStandingOrders`' four-parameter signature cannot answer "is this terminal in that team?", so the `team` scope requires a signature change propagated to two host call sites, the webview mirror and the test. That is multi-file coordination with a shipped-state compatibility requirement, not a deletion.
> **Replaced with:** 6. Routing moves from "Send to Coder" to the top of the Coder band; still Coder, not Lead Coder, because every individual edit is well understood and the risky part is breadth rather than depth.

## User Review Required

None. The scope vocabulary, the cap removal and the second delivery hook are all settled by the diagnosis above.

## Complexity Audit

### Routine

- Adding an optional `scope` field to the order shape and defaulting it on read.
- Deleting three constants and their enforcement sites.
- Calling an existing pure function from a second delivery path.

### Complex / Risky

- **`applyStandingOrders` cannot currently answer the `team` question.** Its signature is `(prompt, targetName, orders, liveNames)` — four inputs, none of which carry team membership. Neither call site has it either: `TaskViewerProvider.ts:440` has the raw `ptyListTerminals` rows, `bootstrap.ts:238` has `ptyFleetService.listActive()`, and **no terminal record carries a team id or team name** — `teamName` is threaded into `spawnDelegates` for shared-member *naming* only (`bootstrap.ts:1213`, `ptyFleetService.ts:475`) and is never persisted on the handle. So "does this order's team include this terminal?" is unanswerable without new plumbing. This is the single largest piece of work in the plan and the original draft did not name it. The reconciled design is in Implementation step 2 below.
- **Render framing is per-scope and must not leak.** Only `pair` renders `- Regarding terminal "X": …`. `team` and `global` render as plain rules. Getting this wrong produces the incoherent line this plan exists to remove.
- **The liveness gate must narrow, not disappear.** `pair` keeps `liveNames.has(o.child)` — a note about a dead terminal is noise. `team` and `global` have no `child` and must never be liveness-filtered.
- **Render ORDER is load-bearing once safeguards live here.** With three scopes composing into one block, whatever renders last is what a future truncation would eat. Render safeguard-bearing scopes first. Better: remove the truncation entirely (this plan does) so the question is moot.
- **The idempotency guard becomes more expensive.** `if (prompt.includes(STANDING_ORDERS_MARKER)) return prompt;` (`standingOrders.ts:59`) silently drops the *entire* block if the incoming text already contains the marker — e.g. a lead quoting its own block to a coder. Today that costs a "report back" line; with safeguards in the block it costs the safety rules. Either scope the guard to the block it is about to add, or strip a pre-existing block rather than bailing. **Note the cross-boundary purpose:** the marker is also what stops the client mirror and the host from both appending a block to the same prompt (test §1). Whatever replaces the bail must preserve that de-duplication, or Shift-drop delivers two blocks.
- **The webview mirror must change in lockstep.** Three copies of the render logic (host, mirror) and three copies of the cap constants (host, mirror, counter). The mirror is enforced against the host by contract test §5 for the caps and §1 for the marker; there is **no** test enforcing that the *filter* or the *template* match, which is precisely how they could silently diverge here.
- **`sendRobustText` needs a terminal name and a live set.** The PTY hook has both to hand. The VS Code path must resolve the same two inputs, and its "live names" set has to include VS Code terminals or pair orders naming them will never render.
- **The new hook needs the opt-out.** Contract test §6 (`:176-185`) asserts both existing chokepoints gate on `payload.standingOrders !== false`. The `sendRobustText` hook must carry the same gate, or head↔member comms suppression silently stops working on the VS Code path.

## Edge-Case & Dependency Audit

**Race Conditions** — `mutateStandingOrders` already serialises read-modify-write through a module-level promise chain (`standingOrders.ts:24-36`); unchanged by this plan.

**Security** — none new. Same store, same authenticated routes.

**Side Effects** — removing `MAX_ORDERS` removes a hard refusal from three call sites; team creation stops failing for a reason that never made sense. Removing truncation means a genuinely enormous order reaches the prompt intact — acceptable, and the honest failure (the agent sees it all) beats the silent one (mid-sentence cut).

**Dependencies & Conflicts** — `terminals.standingOrders` is read by `applyStandingOrders`, written by `wireSpawnedTeam`, the Link-up modal and the LocalApiServer routes. All must tolerate an absent `scope`. Blocks `team-prompt-replaces-pair-records.md`, which needs the `team` scope to exist. **Shared file with that plan:** both edit `src/services/teamWiring.ts` (this plan deletes the `MAX_ORDERS` check at `:488`; the team-prompt plan rewrites `wireSpawnedTeam` around it). Per the project's one-stream-per-file rule these serialise, and this plan lands first.

**Test dependency.** `src/test/standing-orders-marker-contract.test.js` must be updated in the same change (see Proposed Changes). `src/test/link-presets-mirror-contract.test.js` is **not** affected by this plan — it guards the preset text, which the team-prompt plan touches, not this one.

## Dependencies

None. This is the keystone of the set.

## Adversarial Synthesis

**Risk summary.** The deletions are safe and the scope vocabulary is settled; the danger is entirely in reach. Three surfaces the original draft did not name — a hand-copied resolver mirror in the webview with its own cap constants, a contract test that goes red the moment the caps are deleted, and the fact that neither `applyStandingOrders` nor either of its call sites can resolve team membership from the inputs they hold — turn "mostly deletion" into a coordinated multi-file change. Mitigations: resolve team membership from the already-registered `terminals.groups` rows rather than inventing new terminal state, change the resolver signature once and propagate it to both hosts plus the mirror in the same commit, and rewrite the contract test's cap section into a mirror-parity assertion on the new scope-aware renderer so the mirror stays mechanically pinned instead of comment-pinned.

## Implementation

1. Add `scope?: 'global' | 'team' | 'pair'` and `teamId?: string` to `StandingOrder`. Absent `scope` reads as `'pair'`; absent `child` is only legal for `global`/`team`.
2. Rewrite `applyStandingOrders` selection: `global` always applies; `team` applies when the target is a member of that team; `pair` keeps `o.parent === targetName && liveNames.has(o.child)`.

   **Resolving team membership — the reconciled design.** Do **not** add a team id to the terminal record. `wireSpawnedTeam` already registers every started team into `terminals.groups` (`teamWiring.ts:516-529`) as
   `{ id: 'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_'), name: headName, members: [headName, ...childNames] }`.
   That row is the membership answer, it is already persisted, and it is already written on both hosts' create paths. So:
   - A `team`-scoped order carries `teamId` equal to that group id.
   - `applyStandingOrders` takes a fifth parameter — the registered groups array (or a pre-resolved `Set<string>` of member names for the target). A `team` order applies when the group whose `id === o.teamId` lists `targetName` in `members`.
   - Both host call sites read `terminals.groups` alongside `terminals.standingOrders` (`TaskViewerProvider.ts:440` already opens the DB for the orders read; `bootstrap.ts:238` likewise) and pass it through.
   - The webview mirror does the same from its already-loaded group state.

   > **Superseded:** "`team` applies when the target is a member (or head) of that team."
   > **Reason:** States the predicate without stating what evaluates it. `applyStandingOrders` is a pure function over `(prompt, targetName, orders, liveNames)` and neither it nor its two call sites hold any team membership data — no terminal record carries a team id or name. As written the step is not implementable without an unnamed design decision, which is exactly where two hosts diverge.
   > **Replaced with:** The `terminals.groups` design above — reuses state `wireSpawnedTeam` already writes, requires no new terminal field, and gives both hosts and the webview the same source.

   **Head vs member:** the registered group's `members` array includes the head. If the team prompt should not reach the head (see `team-prompt-replaces-pair-records.md`, which owns that decision), the exclusion belongs in that plan's prompt construction, not in this selection predicate. This plan delivers "member of the group named by `teamId`" and nothing finer.
3. Rewrite rendering per scope — `pair` keeps `- Regarding terminal "X": …`; `global` and `team` render the instruction as a plain rule with no "regarding" framing. Emit scopes in a fixed order, safeguard-bearing scopes first.
4. Delete `MAX_ORDERS` and its three enforcement sites (`agentGroupInstantiation.ts:98`, `teamWiring.ts:488`, `LocalApiServer.ts:2367`). Team creation stops pre-flighting an orders budget. The two **delegate** caps in `instantiateAgentGroupCore` (`MAX_DELEGATES_PER_PARENT`, `MAX_LIVE_DELEGATE_PTYS`, `agentGroupInstantiation.ts:91-97`) are real fleet-resource limits and **stay**.
5. Delete `MAX_BLOCK_CHARS` truncation and `MAX_INSTRUCTION_CHARS` validation. Keep `validateInstruction`'s marker rejection (`standingOrders.ts:80`) — that one guards a real parsing hazard.
6. Fix the idempotency guard so a pre-existing marker in the incoming text does not discard the block being added, while still preventing client+host double-blocking.
7. Hook `applyStandingOrders` into the `sendRobustText` delivery path so VS Code terminal agents receive orders. Resolve the live-names set to include VS Code terminals, and gate on `payload.standingOrders !== false` like the other two chokepoints.
8. Update the webview mirror in lockstep: `applyStandingOrdersClient` (`terminals.js:8285`) gets the same scope-aware selection and rendering; delete its `MAX_BLOCK_CHARS`/`MAX_INSTRUCTION_CHARS` constants (`:8145-8146`) and the truncation at `:8295`; drop or rework the `len / MAX_INSTRUCTION_CHARS` counter in `syncSendEnabled` (`:8275`).
9. Update `src/test/standing-orders-marker-contract.test.js`: remove the cap-parity section (§5, `:104-115`), the truncation assertion (`:229-239`) and the over-length assertion in `:245`; **replace** them with scope-behaviour assertions (global applies with no partner; team applies by group membership; pair keeps its liveness gate and its "Regarding" framing; the other two scopes never emit that framing) and a mirror-parity assertion on the new renderer so `terminals.js` stays mechanically pinned to `standingOrders.ts`. Extend §6's chokepoint enumeration to cover the new `sendRobustText` hook.
10. Extend the LocalApiServer standing-orders routes to accept and return `scope`/`teamId`, defaulting absent `scope` to `pair` on read.

## Proposed Changes

### `src/services/standingOrders.ts`
- **Context:** One scope hardcoded into the shape (`:3-9`), the filter (`:60-62`) and the renderer (`:66-68`); three unjustified caps (`:13-15`).
- **Logic:** Add `scope` + `teamId`; scope-aware selection and rendering; a fifth parameter carrying registered groups; delete the caps.
- **Edge Cases:** Absent `scope` on every shipped row must read as `pair`; `pair` keeps its liveness gate, the others must not acquire one; a `team` order whose `teamId` matches no registered group must render for nobody rather than for everybody.

### `src/webview/terminals.js` — the client mirror
- **Context:** `applyStandingOrdersClient` (`:8285`) is a full hand-copy of the resolver, with its own caps (`:8145-8146`) and counter (`:8275`). Live on the Shift-drop path (`:4196`).
- **Logic:** Same scope-aware selection and rendering as the host; caps and truncation deleted.
- **Edge Cases:** A `global` order has no `parent`, so the unchanged `o.parent === targetName` filter would drop it entirely — the mirror must be updated, not left to "mostly work".

### Host delivery hooks
- **Context:** Two chokepoints exist (`TaskViewerProvider.ts:440`, `bootstrap.ts:238`); `sendRobustText` (`terminalUtils.ts:130`) bypasses both.
- **Logic:** Apply orders on the VS Code path too, and pass the registered groups through on all three.
- **Edge Cases:** Live-names set must span both terminal kinds, or pair orders naming a VS Code terminal never render; the new hook must carry the `standingOrders !== false` opt-out.

### Cap enforcement removal
- **Context:** `MAX_ORDERS` hard-refuses team creation for a budget that bounds nothing real, and orders are never pruned.
- **Logic:** Remove the checks; team creation no longer consults an orders budget.
- **Edge Cases:** The three call sites return a cap error today — callers must handle its disappearance, not just stop hitting it. `LocalApiServer.ts:2371` constructs a typed cap error whose consumer must tolerate it never being thrown.

### `src/test/standing-orders-marker-contract.test.js`
- **Context:** §5 asserts the caps exist in both files and match; `:229`/`:245` assert truncation and over-length rejection; §6 asserts one chokepoint per host.
- **Logic:** Replace cap assertions with scope-behaviour and mirror-parity assertions; extend the chokepoint enumeration to three.
- **Edge Cases:** `extractNumber` throws on a missing constant, so these fail loudly rather than silently — good, but it means the test edit cannot be deferred to a follow-up.

## Verification Plan

1. An existing install's orders (no `scope` field) render byte-identically to before — the migration test that matters.
2. A `global` order appears in the prompt of every agent dispatched, including one with no team and no links.
3. A `global` order still renders when unrelated terminals have exited — proving the liveness gate was narrowed to `pair`.
4. A `team` order reaches that team's members and no one else, resolved through the registered `terminals.groups` row.
5. A `team` order whose `teamId` matches no registered group renders for nobody.
6. A `pair` order renders `- Regarding terminal "X": …`; `global`/`team` orders render with no "regarding" framing.
7. A VS Code terminal agent receives standing orders — the path that silently skipped them before — and a dispatch carrying `standingOrders: false` on that path still receives none.
8. **Shift-drop (`terminals.js:4196`) delivers the same block the host would**, including a `global` order — proving the client mirror was updated and not left behind.
9. Shift-drop followed by a host dispatch does not deliver two standing-order blocks — the marker de-duplication survived the idempotency-guard rewrite.
10. A team starts successfully with 25+ orders registered, proving the cap refusal is gone.
11. A 10,000-character order reaches the prompt uncut, with no `…[standing orders truncated]` marker, on both the host path and Shift-drop.
12. Incoming text that already contains `=== STANDING ORDERS ===` no longer causes the block to be silently dropped.
13. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline (verified 2026-08-15: exactly 5 `TS2835` errors at HEAD, unrelated).

## Recommendation

Complexity 6 → **Send to Coder.** Still mostly deletion at its core, but the reach is the work: three render sites, two host chokepoints becoming three, and a contract test that must be rewritten rather than left. The one part to get right is scope-aware rendering — the `pair` framing must not leak into the other two scopes, because that incoherent line is the whole reason teams could not own a prompt — and the one part to not skip is the webview mirror, which is live on the Shift-drop path.

## Completion Summary

Implemented all 10 steps of the standing-orders scope and decap plan, plus two review fixes. Added `scope` (`global`/`team`/`pair`) and `teamId` to the `StandingOrder` shape with absent-scope-defaults-to-`pair` backward compat, rewrote `applyStandingOrders` with scope-aware selection (global always applies, team resolves membership through the already-registered `terminals.groups` rows, pair keeps its liveness gate), per-scope rendering (only `pair` emits the `- Regarding terminal "X":` framing), and a fixed scope-rank render order (safeguard-bearing scopes first). Deleted all three caps (`MAX_ORDERS`, `MAX_BLOCK_CHARS`, `MAX_INSTRUCTION_CHARS`) and their enforcement sites in `agentGroupInstantiation.ts`, `teamWiring.ts` (only the `MAX_ORDERS` check — `wireSpawnedTeam` left otherwise alone per subtask constraint), and `LocalApiServer.ts`. Fixed the idempotency guard to strip a pre-existing COMPLETE block via an anchored regex (marker + body + trailing `These apply...` line) and re-append a fresh one rather than silently bailing on the marker — the anchoring prevents a mid-text marker quote from being truncated. Hooked `applyStandingOrders` into the `sendRobustText` VS Code delivery path (`terminalUtils.ts`) with a `standingOrders !== false` opt-out gate, and added a `_resolveStandingOrdersForVsCode` helper in `TaskViewerProvider` that builds a live-names set spanning both PTY and VS Code terminals; updated 10 agent-dispatch call sites to pass resolved orders. Updated the webview mirror (`terminals.js:applyStandingOrdersClient`) in lockstep with the same scope-aware selection, rendering, and anchored block-strip logic. Rewrote the contract test to replace cap-parity assertions with mirror-parity assertions on the scope-aware renderer, scope-behavior tests (global/team/pair selection, liveness gating, framing, unknown-teamId, 10k-char uncut, mid-text marker quote not truncated), and an extended chokepoint enumeration covering the third `sendRobustText` hook. Extended the LocalApiServer routes to accept and return `scope`/`teamId`, defaulting absent scope to `pair` on read. **Review fix 1:** the `sendToTerminal` VS Code fallback branch in `TaskViewerProvider.ts` now passes `false` when `data.standingOrders === false`, matching the PTY branch's opt-out — head/member comms suppression no longer silently breaks on the VS Code path. **Review fix 2:** `STANDING_ORDERS_BLOCK_RE` anchored to a complete block (requires the trailing `These apply...` line) in both `standingOrders.ts` and `terminals.js`, so a prompt quoting the marker mid-text is not silently truncated. Files changed: `src/services/standingOrders.ts`, `src/services/teamWiring.ts`, `src/services/agentGroupInstantiation.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/services/terminalUtils.ts`, `src/services/LocalApiServer.ts`, `src/webview/terminals.js`, `src/test/standing-orders-marker-contract.test.js`. No compile or test commands were run per instruction. No issues encountered — all edits are backward-compatible with shipped-state rows (absent `scope` reads as `pair`, absent `child` is handled in selection and rendering).

## Review Findings

One CRITICAL and one MAJOR, both fixed. **CRITICAL** — `terminalUtils.ts:154`: the new VS Code chokepoint's opt-out was written `options?.standingOrders && options.standingOrders !== false`, which narrows the union before the second comparison and is a hard `TS2367`; it broke `npm run compile-tests`, the first CI gate (`integration-tests.yml:29`). Rewritten as `!== undefined && !== false`, which type-checks and still satisfies the chokepoint contract test's opt-out assertion. **MAJOR** — this plan's own rewritten contract test shipped with two red assertions that had never been run: the framing test scanned raw source including comments (`renderOrder`'s JSDoc names "Regarding terminal" before the `scope === 'pair'` code that gates it) and the strip test asserted `!out.includes('old')` against a block whose own trailing line reads "until t**old** otherwise" — unpassable regardless of behaviour; both fixed, and the underlying resolver logic was correct in each case. Files changed this pass: `src/services/terminalUtils.ts`, `src/test/standing-orders-marker-contract.test.js`. Verification: `standing-orders-marker` 30/30, `link-presets-mirror` 7/7, `verb-returns`/`parity`/`push-routing`/`standalone-parity`/`mirror` all pass; `npx tsc --noEmit` clean for this plan's files.
