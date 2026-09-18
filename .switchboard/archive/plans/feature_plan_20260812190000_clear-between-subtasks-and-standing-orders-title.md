# Clear The Coder Between Subtasks, And Call The Block What It Is

## Goal

Stop a driven coder's context accumulating across a feature's subtasks, and rename the standing-orders block header from `SWITCHBOARD STANDING ORDERS` to `STANDING ORDERS`.

### The problem

Reported after the first live run of the terminal-coder-dispatch pattern (an eight-subtask feature driven through three coders): *"subagent context can build up over big subtasks because the subagent context is not cleared between subtasks."*

Confirmed by construction. `.agents/skills/terminal-coder-dispatch/SKILL.md` makes `clearBeforePrompt: false` mandatory on **every** send (§ *"`clearBeforePrompt: false` is mandatory and non-obvious"*, `SKILL.md:51`), and it is right to for the case it argues — a fix resend must reach a coder that still remembers the work being corrected. Its own §6 depends on it: *"compose a fix prompt naming the specific defects and send it to the same terminal, which retains its context"* (`SKILL.md:192`).

But the skill applies that rule to a second, different send: the head agent's *"your subtask passed review, here is the next plan"* message. That message opens a **new** subtask. The coder does not need — and is actively harmed by — several thousand tokens of a finished subtask's diffs, review findings and fix rounds sitting above its new instructions.

### Root cause

The skill has one rule (`clearBeforePrompt: false`, always) for two send *kinds* that want opposite handling:

| send kind | wants |
| :-- | :-- |
| fix resend inside a subtask | context preserved — the correction refers to work the coder just did |
| first prompt of the next subtask | context cleared — the previous subtask is finished and closed |

There is no third mechanism needed. `clearBeforePrompt: true` already sends `/clear` and is already reachable on the same verb; the skill simply forbids it everywhere because the danger it was written against — the *link-up relay* wiping a mid-task terminal — is real on a different path. One blanket rule, two jobs.

The prose "passed review" message compounds it: it costs a turn, adds tokens, and carries no instruction the next dispatch does not already carry.

### Problem 2: the block header names the product, not the thing

`STANDING_ORDERS_MARKER = '=== SWITCHBOARD STANDING ORDERS ==='` (`src/services/standingOrders.ts:12`). The agent reading it does not need to be told which tool emitted it — it needs to know the lines below are standing orders. The word is noise in a block that is appended to every single prompt.

## Metadata

**Complexity:** 3
**Tags:** docs, refactor, dx

## User Review Required

None.

## Complexity Audit

### Routine

- The skill edit is prose plus a table in one markdown file, mirrored to `.claude/` by the existing generator.
- The marker rename touches exactly two literal declarations. Every other use in the tree dereferences the exported constant (`standingOrders.ts:59`, `:65`, `:80`; `terminals.js:8102`, `:8106`), so they follow the rename for free.
- No persisted state carries the marker. `validateInstruction` (`standingOrders.ts:80`) actively **rejects** any saved instruction containing it, so no stored standing order can hold the old string and there is nothing to migrate.

### Complex / Risky

- **Cross-version prompt skew.** The marker is an idempotency token compared as a literal across a process boundary (webview mirror ↔ host). A browser tab or webview left open across an extension upgrade runs the *old* `terminals.js` with the old marker while the host emits the new one, so `prompt.includes(MARKER)` misses and the prompt receives **two** standing-order blocks. Self-clearing on reload, invisible until then.
- Behaviour change in an agent protocol, not in code: a skill that told agents "never clear" now tells them "clear here, not there". A misread reintroduces the exact bug being fixed, in the more damaging direction (a cleared mid-task terminal).

## Edge-Case & Dependency Audit

### Race Conditions

- None in code. The only ordering hazard is the upgrade skew above — host and mirror are compared as literals but deployed as one artifact, so they are only ever out of step for the lifetime of an already-open surface.

### Security

- None. The marker is prompt-formatting text, not an authorisation boundary. `validateInstruction`'s marker rejection is a prompt-injection guard (a saved order must not be able to forge a block header); the rename preserves it verbatim because that check dereferences the constant.

### Side Effects

- Clearing a coder between subtasks discards its scrollback. Anything the head needs from the finished subtask must already be in the head's own context — the standing-order callback and the review artefacts are the carriers, and both survive.
- `applyStandingOrders` runs server-side on every `ptySendPrompt` (`TaskViewerProvider.ts` handlePtyVerb path → `standingOrders.ts:52`), so the block is re-appended to the post-clear prompt. The callback contract is not destroyed by the clear.

### Dependencies & Conflicts

- Sibling subtask **Retire The Delegate Join Contract** deletes `.agents/skills/delegates/` and shortens the head prompt. Different skill file; no textual overlap with `terminal-coder-dispatch/SKILL.md`. Independent.
- Sibling subtask **Team Members Gain A Scope And A Relationship** makes `AGENT_GROUP_CALLBACK_INSTRUCTION` the body of a `reports-to-head` preset. That is instruction *text*; this plan changes the block *header*. No conflict.
- `.claude/skills/terminal-coder-dispatch/` is a generated mirror. Skill discovery is host-split — Claude Code resolves through `MIRROR_MANIFEST` (`ClaudeCodeMirrorService.ts`), Antigravity reads the filesystem — so editing only one copy leaves one host on stale instructions.

## Dependencies

- `sess_20260812190000 — terminal-coder-dispatch skill: clear-rule split`
- `sess_20260812190000 — standing-orders marker rename (writer + client mirror)`

## Adversarial Synthesis

Key risks: an upgrade-window prompt-skew that double-appends the standing-orders block when an open surface holds the old marker literal; and an agent misreading a two-case rule as one rule with an exception, which reintroduces the reported bug or — worse — clears a mid-task terminal. Mitigations: state the rule as a table with both rows filled rather than a rule plus a caveat; state explicitly in the skill that `applyStandingOrders` re-appends the block after a clear, because an unsure agent defaults to `false`; and grep the tree for the literal before and after so no third copy survives. The rename itself is safe on stored state — `validateInstruction` makes it impossible for a persisted order to contain the marker.

## Design

### The rule becomes two rules, stated in the skill

Rewrite `§6 The resend` and add to `§4 The dispatch prompt template`:

- **First prompt of a subtask** — `clearBeforePrompt: true`. The previous subtask is closed; the coder starts clean with the plan path and the working constraint. The standing order is re-appended by the server on this send as on every other, so the callback contract survives the clear.
- **Every send within a subtask** (fix resends, clarifications) — `clearBeforePrompt: false`, exactly as today, for the reason §6 already gives.
- **Delete the "passed review" message as a separate send.** Acknowledgement rides the next dispatch: a coder receiving a fresh subtask has, by that fact, passed. When a subtask is the coder's last, the head says so in its own reply to the user, not in a prompt to an idle terminal.

State the split as a table in the skill so it cannot be read as a single rule with an exception.

### The standing order survives the clear — say so

The one thing that could make an author nervous about `true` is whether clearing destroys the callback contract. It does not: `applyStandingOrders` runs server-side on every `ptySendPrompt`, so the block is appended to the post-clear prompt. Put that sentence in the skill next to the rule, because an agent that is unsure will default to `false` and reintroduce the bug.

### Rename the marker

`'=== SWITCHBOARD STANDING ORDERS ==='` → `'=== STANDING ORDERS ==='`, in **both** declarations, in one change:

| site | role |
| :-- | :-- |
| `src/services/standingOrders.ts:12` | the writer — the exported constant used to build, guard and validate the block |
| `src/webview/terminals.js:7976` | the client mirror — the same literal, re-declared inside the webview IIFE |

> **Superseded:** `src/webview/terminals.js:7942` — *"the client mirror — strips the block so the link-up modal does not show an agent its own orders"*.
> **Reason:** Two errors. The line number is wrong (the declaration is at `:7976`), and the mirror does not strip anything. `applyStandingOrdersClient` (`terminals.js:8100-8115`) **appends** the block, byte-for-byte as the host does; the marker's job there is the *idempotency guard* on its first line — `if (!prompt || prompt.includes(STANDING_ORDERS_MARKER)) { return prompt; }` — which stops a prompt that already carries a block from receiving a second one when it passes through both the client and the host. The file's own comment states it: *"the marker string is the contract that prevents double-blocking when a prompt is processed by both client and host"* (`terminals.js:7973-7975`).
> **Replaced with:** The mirror is a duplicate implementation of `applyStandingOrders`, and the marker is the cross-boundary de-duplication token. That makes the two-site edit *more* load-bearing, not less: a rename applied to one side does not degrade a modal's cosmetics, it breaks de-duplication and delivers two standing-order blocks in one prompt.

Both sites are literal declarations; every other occurrence in the tree dereferences the constant and needs no edit. Nothing persists the marker — it is runtime prompt text, not stored state, and `validateInstruction` (`standingOrders.ts:80`) rejects any saved instruction that contains it — so there is no migration. The two-site edit is not optional.

## Implementation Notes

- The skill exists twice by design: `.agents/skills/terminal-coder-dispatch/SKILL.md` is the source of truth, and Claude Code resolves skills through the mirror manifest. Edit the `.agents/` copy and re-run whatever regenerates `.claude/`; do not hand-edit the mirror, and do not edit only one.
- Do **not** change `clearBeforePrompt`'s omitted-field default, which is now `false` in both hosts and deliberately so — `TaskViewerProvider.ts` handlePtyVerb documents why (*"an absent field meaning /clear is fail-dangerous for a relay into a mid-task terminal"*). This plan changes what a *skill instructs an agent to pass*, never what an absent field means.
- Grep for the marker string before editing — a third copy in a test fixture must move with it or the test asserts a string nothing emits any more.
- Keep the skill's existing warning that omitting the field entirely is not the same as passing `false`; the new table adds a case, it does not soften that.
- The dispatch skill quotes the callback instruction verbatim at `SKILL.md:141`. It is quoted for illustration, not compared as a literal, so it does not need to move in lockstep — but if a sibling subtask changes that text, re-read the quote so the skill does not teach a sentence the system no longer emits.

## Proposed Changes

### `.agents/skills/terminal-coder-dispatch/SKILL.md`

- **Context.** The single `clearBeforePrompt: false` rule at `:51-64` and the resend section at `:192` are the source of the reported context bleed.
- **Logic.** One rule becomes two, keyed on *which send this is* rather than on the verb.
- **Implementation.** Replace the blanket rule with a two-row table (first-prompt-of-subtask → `true`; every send within a subtask → `false`). Add one sentence stating that `applyStandingOrders` re-appends the standing-orders block after the clear, so the callback contract is not destroyed. Delete the "passed review" send from the subtask-transition sequence and state that acknowledgement rides the next dispatch.
- **Edge Cases.** Keep the existing warning that an omitted field is not the same as an explicit `false`. Keep the link-up relay warning intact — it is a different path and still wants `false`.

### `.claude/skills/terminal-coder-dispatch/SKILL.md`

- **Context.** Generated mirror; Claude Code resolves skills through `MIRROR_MANIFEST`, so a stale mirror means one host runs the old rule.
- **Implementation.** Regenerate from `.agents/`. Do not hand-edit.
- **Edge Cases.** Confirm the clear-rule table is present in the mirror before considering the change complete.

### `src/services/standingOrders.ts`

- **Context.** `:12` declares the exported `STANDING_ORDERS_MARKER`; `:59` guards, `:65` builds, `:80` validates — all by dereference.
- **Implementation.** Change the literal on `:12` only.
- **Edge Cases.** Do not touch `MAX_BLOCK_CHARS`/`MAX_INSTRUCTION_CHARS`; the shorter marker frees a few characters of block budget and changes nothing else.

### `src/webview/terminals.js`

- **Context.** `:7976` re-declares the same literal inside the IIFE; `:8102`/`:8106` are the client mirror of `applyStandingOrders`.
- **Implementation.** Change the literal on `:7976` to match `standingOrders.ts:12` exactly.
- **Edge Cases.** The two literals are compared across a process boundary. If only one changes, a prompt processed by both sides receives two standing-order blocks.

## Verification Plan

1. **The reported case.** Drive a two-subtask feature. After the first subtask passes review, confirm the coder receives `/clear` followed by the second subtask's prompt, and that its scrollback no longer holds the first subtask's diffs.
2. **Resends still remember.** Within one subtask, send a fix naming a defect. The coder must still have the context of the work being corrected — no clear.
3. **The callback survives the clear.** After a cleared dispatch, confirm the standing-orders block is present in the delivered prompt and that the coder still reports back unprompted.
4. **No "passed review" send.** Confirm the head issues exactly one send per subtask transition, not two.
5. **Marker rename is complete.** Grep the tree for `SWITCHBOARD STANDING ORDERS`; zero hits outside history.
6. **De-duplication still holds.** Deliver a prompt through the client path to a terminal that has standing orders, then let the host process the same prompt. Exactly one `=== STANDING ORDERS ===` block appears — this is the check that catches a one-sided rename, and it is the one the old plan's "the modal strips the block" framing would have skipped.
7. **Saved orders are unaffected.** Confirm existing persisted standing orders render unchanged under the new header, and that `validateInstruction` still refuses an instruction containing the new marker.
8. **Both skill copies agree.** Diff `.agents/skills/terminal-coder-dispatch/SKILL.md` against the `.claude/` mirror; the clear-rule table must be present in both.

### Automated Tests

Per the session directive, no compilation or automated-test run is part of this pass's verification; the checks above are manual. At implementation time the coder should add one contract test asserting `STANDING_ORDERS_MARKER` in `src/services/standingOrders.ts` and the literal in `src/webview/terminals.js` are byte-identical — the mirror is currently held in sync by a comment alone, and this rename is exactly the change that comment fails to enforce.

## Recommendation

Complexity 3 → **Send to Intern**.

## Completion Summary

Renamed the standing-orders marker from `=== SWITCHBOARD STANDING ORDERS ===` to `=== STANDING ORDERS ===` in both declaration sites: `src/services/standingOrders.ts:12` (the writer) and `src/webview/terminals.js:7976` (the client mirror). All other references dereference the exported constant and followed the rename for free; a tree-wide grep confirms zero remaining hits in source code (only plan history files retain the old string). Rewrote the `terminal-coder-dispatch` skill's blanket `clearBeforePrompt: false` rule as a two-row table — `true` for the first prompt of a subtask (context cleared, standing-orders block re-appended by the server), `false` for every send within a subtask (context preserved for resends) — and added the "no passed-review send" subtask-transition rule to §7, stating that acknowledgement rides the next dispatch. Applied the same body edits to the `.claude/skills/` mirror (the `buildSkillMd` transformation preserves the body verbatim), and verified the two copies are byte-identical via diff. Added a contract test (`src/test/standing-orders-marker-contract.test.js`, registered as `test:contract:standing-orders-marker`) that asserts the marker literal is byte-identical across both files and rejects the retired `SWITCHBOARD` prefix — the mechanical guard the comment alone failed to enforce. A review pass corrected a factual error in three places where the skill claimed an omitted `clearBeforePrompt` defaults to `true` and sends `/clear`; both hosts actually default an omitted field to `false` deliberately (`bootstrap.ts:1248`, `TaskViewerProvider.ts:2150-2168`), so the prose was rewritten to state that omission is equivalent to explicit `false` today and to pass the field explicitly anyway so the value is deliberate and immune to a future default change. The failure-mode bullet for "Context wiped between turns" was corrected to name an explicit `true` on a within-subtask send as the cause, not an omission.

## Review Findings

Reviewed against the plan: the marker rename is complete in both declaration sites, a tree-wide grep for `SWITCHBOARD STANDING ORDERS` returns zero hits across `src/`, `.agents/` and `.claude/`, and the two-row clear table plus the §7 "no passed-review send" rule are present in both skill copies (`mirror:check` green). One MAJOR gate hole fixed: `src/test/standing-orders-marker-contract.test.js` was defined in `package.json` but never invoked by CI, so the mirror it exists to enforce was unguarded — added a step to `.github/workflows/integration-tests.yml`. Files changed by this review: `package.json`, `.github/workflows/integration-tests.yml`. Validation: `tsc -p tsconfig.test.json` clean, marker contract 4/4, `mirror:check` and all nine static gates exit 0. Remaining risk, stated only as far as it is verified: `sendPromptToPty`'s second confirm `\r` is gated on `CLI_AGENT_REGEX` (`/copilot|gemini|agy|claude|windsurf|cursor|cortex/i`) tested against `handle.name || handle.role`, and a fleet terminal's name and role (`Lead-coder-1`, `coder`) contain no CLI product name, so that write is skipped for exactly the terminals this plan's rule targets — whether that is a defect is the open question in `feature_plan_20260813103000_pty-prompt-delivery-never-submits.md`. The clear delay itself is **not** a concern: it is `switchboard.terminal.clearBeforePromptDelay` (`package.json:320`), operator-configurable and threaded through both hosts (`TaskViewerProvider.ts:2205`, `bootstrap.ts:201`).
