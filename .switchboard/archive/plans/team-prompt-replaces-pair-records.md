# Teams Own Their Prompt — Stop Generating Pair Records Per Member

## Goal

Give a team a single prompt of its own — its system prompt, carrying the safeguards its members need — instead of generating one `(member, head)` standing-order record per member at spawn time. Members keep receiving it on every message, which is what makes it survive the lead's `/clear`.

### Problem analysis and root cause

**Team members deliberately get no prompt at spawn, and standing orders are the intended safety channel — but they cannot currently carry safety.**

The spawn path is confirmed prompt-less by design: `spawnDelegates` creates each member with only `d.startupCommand` (`ptyFleetService.ts:527-536`), then the create path wires standing orders into config, registers the terminals group and returns (`bootstrap.ts:1211-1230`). Nothing sends a member text. `agentPromptBuilder.ts` contains **zero** references to teams — the concept does not exist in the prompt builder at all.

That is correct: the lead clears its members between tasks to keep their context clean, so anything delivered once at spawn would be wiped by the first clear. The only channel that survives is standing orders, because `applyStandingOrders` runs at **send** time (`TaskViewerProvider.ts:440`, and `bootstrap.ts:238` on the standalone host) and re-appends the block to every message.

**So the safeguards belong in the team's standing orders — and today they cannot go there.** `wireSpawnedTeam` does not store team configuration; it writes N standing-order rows, one per member, each of the form `parent = member, child = head` (`teamWiring.ts:460-468`). Rendering is hardcoded to `- Regarding terminal "<child>": <instruction>`, so a git-safety rule lands as `- Regarding terminal "Lead": Never run git reset --hard…` — incoherent, because the rule is not about the lead.

The consequence today: **a team coder operates on the repo with no git safety guardrail at all.** A board-dispatched coder receives `GIT_SAFETY_DIRECTIVE` (or its worktree variant) via `buildGitPolicyBlock`; a team coder receives only the lead's text plus one "report to your head" line. Given this repo's stance on destructive git operations, that is the gap worth closing.

**Root cause: teams was built on top of the pre-teams pair store rather than replacing its role.** The evidence is in the code shape — `wireSpawnedTeam` writes standing-order rows; a `relationship` in `linkPresets.ts` is a *template that generates pair-order text*; `AGENT_GROUP_CALLBACK_INSTRUCTION` is duplicated byte-identically across `teamWiring.ts` and `linkPresets.ts` to dodge a circular import; and `instantiateAgentGroupCore` pre-flights the legacy `MAX_ORDERS` budget before it will start a team. Standing orders keeps its own job (ad-hoc link-up between two arbitrary terminals, and workspace-wide notes) — it just should not be the storage layer for team configuration.

**The callback text is written to depend on the pair framing, and there are three copies of it.** This is the finding that makes the collapse harder than it looks. The instruction begins with a bare pronoun:

```
'it is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with …'
```

It has **no subject**. The subject is supplied entirely by the `- Regarding terminal "<head>": ` prefix that `applyStandingOrders` renders in front of it. Re-render that string under a `team` scope — which by design drops the "Regarding" framing — and the member reads `it is your head agent`, with no antecedent. So the text cannot simply be moved; it must be **rewritten to name the head explicitly**, and the head name interpolated at wiring time.

The three copies, all currently byte-identical and mechanically pinned:

| Site | Form |
| :--- | :--- |
| `teamWiring.ts:46` | `AGENT_GROUP_CALLBACK_INSTRUCTION` — the constant |
| `linkPresets.ts:111-114` | The `reports-to-head` preset's `template` (copy exists to dodge a circular import) |
| `terminals.js:8130-8132` | The webview's `LINK_PRESETS` mirror |

`src/test/link-presets-mirror-contract.test.js:138` asserts copies 1 and 2 are byte-identical, extracting the constant from `teamWiring.ts` by regex; other tests in the same file pin copy 3 to copy 2. Rewriting the constant without updating all three in lockstep turns that test red.

Note also that `resolvePreset` (`linkPresets.ts:129`) substitutes `{child}`/`{parent}` — and `reports-to-head` is the **only** preset containing neither placeholder, precisely because it leans on the render prefix instead. Every `head-receives` preset names `{child}` explicitly and would survive a framing change unharmed. That asymmetry is the tell.

**Blast radius.** Existing installs have real per-member pair rows in `terminals.standingOrders`. They must be imported into team prompts, not dropped.

## Metadata

**Complexity:** 6
**Tags:** backend, refactor, database, security

> **Superseded:** **Complexity:** 5
> **Reason:** Three concrete items surfaced in the improve pass that the estimate did not carry: `wireSpawnedTeam` has no team identity in its options object at all (so the signature and both hosts' call sites change), the standing-orders idempotency key `(parent, child)` does not survive a child-less team order, and the callback text needs a rewrite across three mechanically-pinned copies plus its contract test. Each is small; together with the existing pair-row migration they push past a 5.
> **Replaced with:** 6. Routing is unchanged — still Coder.

## User Review Required

None. The design is settled: members stay prompt-less at spawn, the team prompt is the durable channel, and it carries the safeguards.

## Complexity Audit

### Routine

- Adding a `prompt` field to the team definition shape.
- Emitting one `team`-scoped standing order per team instead of N pair rows.

### Complex / Risky

- **`wireSpawnedTeam` does not know which team it is wiring.** `WireSpawnedTeamOptions` is `{ db, headName, children, members }` (`teamWiring.ts:374-385`) — there is no team id, no team name, and no group definition. It *derives* a group id from the head name (`'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_')`, `:516`). Meanwhile `teamName` **is** already resolved at every call site (`bootstrap.ts:1203`, `:1882`; `TaskViewerProvider.ts:2539`) and threaded into `spawnDelegates` — but never into `wireSpawnedTeam`. Writing a `team`-scoped order with a `teamId` therefore requires extending the options object and updating all three call sites. This was not in the original draft.
- **The idempotency key does not survive the collapse.** `wireSpawnedTeam` de-duplicates on `(parent, child)` (`teamWiring.ts:485`, `:495`). A `team`-scoped order has **no `child`**, so `o.child === ro.childName` compares `undefined === undefined` and matches *any* other child-less row — while a re-wire under a drifted head name (`Lead` → `Lead-2`) would still add a duplicate. Key team-scoped orders on `(scope, teamId)` instead, and keep `(parent, child)` for pair orders.
- **Safeguard text must have one source of truth.** The team prompt's safety section must reuse the existing `GIT_SAFETY_DIRECTIVE` / `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` constants from `agentPromptBuilder.ts`, not a hand-written copy. A second copy drifts, and the drift is invisible.
- **The callback contract must not be lost in the move — and cannot be moved verbatim.** `AGENT_GROUP_CALLBACK_INSTRUCTION` is what makes a member report back to its head. It currently rides a per-member pair row because the render prefix supplies its subject; the text literally opens with an antecedent-less "it". In a team-scoped prompt the head's name must be interpolated into a rewritten sentence, across all three copies, or members are told to report to nobody in a sentence that does not parse.
- **Head vs member audience.** A team prompt aimed at members should not be delivered verbatim to the head — the head is not told to report to itself. The registered group's `members` array **includes the head** (`teamWiring.ts:520`), so a naive "everyone in the group" delivery hits the head too. Either scope the team prompt to members only, or split head/member sections explicitly.
- **Migration of existing pair rows is real work.** Every install that has started a team has per-member rows. Importing them means recognising the shipped callback text, grouping rows by head, and reconstructing a team prompt — while leaving genuinely ad-hoc link-up rows alone.
- **Relationship presets are still wanted.** `researcher` / `reviewer` / `tester` / `second-opinion` install `head-receives` orders that name a specific member. Those stay pair-scoped; only the default `reports-to-head` bulk collapses into the team prompt. They also all interpolate `{child}` explicitly, so they are unaffected by the framing change.

## Edge-Case & Dependency Audit

**Race Conditions** — `mutateStandingOrders` serialises writes already. Team-prompt writes go through the agent-groups store, which has its own `_groupsWriteChain` (`teamWiring.ts:90`).

**Security** — none new. Positively, this is the change that puts a git-safety guardrail in front of team coders who currently have none.

**Side Effects** — teams stop consuming the standing-orders budget per member, which is what made `MAX_ORDERS` bite. That cap is removed by the prerequisite plan regardless.

**Dependencies & Conflicts** — requires the `team` scope from `standing-orders-scopes-and-decap.md`, and specifically its `terminals.groups`-based membership resolution: this plan's `teamId` must be the same group id `wireSpawnedTeam` registers at `teamWiring.ts:516`. Interacts with `explicit-team-start-in-terminals-panel.md` only insofar as both touch team startup; they are independent otherwise.

> **Superseded:** "Interacts with `wire-explicit-team-start.md` only insofar as both touch team startup."
> **Reason:** Broken cross-reference — no file named `wire-explicit-team-start.md` exists in this feature or in `.switchboard/plans/`.
> **Replaced with:** `explicit-team-start-in-terminals-panel.md`, the actual subtask filename.

**Shared files.** `src/services/teamWiring.ts` is edited by `standing-orders-scopes-and-decap.md` (deletes the `MAX_ORDERS` check at `:488`) and rewritten here. Per the project's one-stream-per-file rule they serialise, and the standing-orders plan lands first. `src/webview/kanban.html` is edited here (step 7, the prompt text area) and by `teams-tab-three-presets-and-phone-a-friend.md` — this plan lands first.

**Test dependency.** `src/test/link-presets-mirror-contract.test.js` must be updated in the same change if the callback text is rewritten — `:138` extracts `AGENT_GROUP_CALLBACK_INSTRUCTION` from `teamWiring.ts` by regex and asserts byte-identity with the `reports-to-head` template.

## Dependencies

`standing-orders-scopes-and-decap.md` — provides the `team` scope this plan writes into, and the `terminals.groups` membership resolution that decides who hears it.

## Adversarial Synthesis

**Risk summary.** The collapse of N rows into one is straightforward; everything attached to it is not. `wireSpawnedTeam` has no team identity in its options at all despite every caller already holding `teamName`, the `(parent, child)` idempotency key silently degenerates when `child` is absent, and the callback text opens with a pronoun whose antecedent comes from the very render prefix this plan removes — across three byte-pinned copies guarded by a contract test. The migration of existing per-member rows is the item with genuine data risk: recognising shipped callback text and leaving operator-edited rows alone is a judgement the code has to make correctly on first run. Mitigations: thread `teamId` through the options object rather than re-deriving it, key team orders on `(scope, teamId)`, rewrite the callback sentence to name the head explicitly in all three copies plus the test, and make migration additive-then-verify so an unrecognised row is preserved as an ad-hoc order rather than dropped.

## Implementation

1. Add `prompt?: string` to the team definition in `terminals.agentGroups`.
2. Seed each shipped team type with a default prompt whose safety section is composed from the existing `GIT_SAFETY_DIRECTIVE` constants in `agentPromptBuilder.ts` — imported, not copied.
3. Extend `WireSpawnedTeamOptions` (`teamWiring.ts:374`) with the team identity it currently lacks — the team id (or the name it is derived from) plus the team's `prompt`. Thread it from all three call sites that already resolve `teamName`: `bootstrap.ts:1203`, `bootstrap.ts:1882`, `TaskViewerProvider.ts:2539`.
4. Change `wireSpawnedTeam` to emit **one** `team`-scoped standing order carrying the team prompt, instead of one `reports-to-head` pair row per member (`teamWiring.ts:460-468`). Set `teamId` to the same group id registered at `:516` so the standing-orders selection can resolve membership. Interpolate the head's terminal name so the report-back route still resolves.
5. Change the standing-orders idempotency key for team-scoped rows from `(parent, child)` to `(scope, teamId)` (`teamWiring.ts:485`, `:495`). Pair rows keep `(parent, child)`.
6. Rewrite the callback text so it names the head explicitly instead of leaning on the `- Regarding terminal "X": ` prefix — e.g. an interpolated `{parent}`/head-name token in place of the leading bare `it`. Update all three copies in lockstep (`teamWiring.ts:46`, `linkPresets.ts:111`, `terminals.js:8130`) and adjust `src/test/link-presets-mirror-contract.test.js` accordingly. Note `reports-to-head` is currently the only preset with no `{child}`/`{parent}` placeholder; after this change it has one.
7. Keep `head-receives` relationship presets (`researcher`, `reviewer`, `tester`, `handoff`, `second-opinion`) as pair-scoped orders — they name a specific member and that framing is correct for them.
8. Scope the team prompt's delivery to members. The registered group's `members` array includes the head (`teamWiring.ts:520`), so the head must be excluded explicitly here; if the head needs its own standing text, give it a separate section rather than reusing the member prompt.
9. Migrate on read: recognise existing per-member rows carrying the shipped callback text, group them by head, and fold them into that team's prompt; leave unrecognised rows untouched as ad-hoc pair orders. Match against the **pre-rewrite** constant text (step 6 changes it going forward — the rows on disk carry the old wording, so the recogniser must know both).
10. Surface the team prompt in the TEAMS tab team editor as a text area, so it is editable rather than implicit.

## Proposed Changes

### Team definition gains a prompt
- **Context:** Teams have no storage for prose; relationships are pair-order templates.
- **Logic:** `prompt` on the team, delivered as one `team`-scoped order.
- **Edge Cases:** Head vs member audience (the registered `members` array includes the head); head name interpolation for the report-back route.

### `wireSpawnedTeam` signature and wiring — `src/services/teamWiring.ts:374-548`
- **Context:** `WireSpawnedTeamOptions` carries no team identity; `teamName` is resolved at every call site but only reaches `spawnDelegates`.
- **Logic:** Add team id + prompt to the options; emit one team-scoped order; key it on `(scope, teamId)`.
- **Edge Cases:** All three call sites must be updated together; a child-less order under the old `(parent, child)` key matches any other child-less row.

### `wireSpawnedTeam` stops writing per-member rows
- **Context:** N members ⇒ N near-identical pair rows naming the head (`:460-468`).
- **Logic:** One team-scoped order per team; relationship presets still emit pair orders.
- **Edge Cases:** Losing the callback contract in the collapse; re-wiring must stay idempotent under a drifted head name.

### Callback text rewrite — three copies + contract test
- **Context:** The text opens with an antecedent-less "it", supplied by the render prefix the team scope removes.
- **Logic:** Name the head explicitly via interpolation; update `teamWiring.ts:46`, `linkPresets.ts:111`, `terminals.js:8130` and `link-presets-mirror-contract.test.js:138` together.
- **Edge Cases:** The regex in the contract test extracts the constant by name — a rename breaks extraction as well as comparison.

### Migration of existing pair rows
- **Context:** Shipped state — every install that started a team has these rows.
- **Logic:** Recognise the shipped callback text, group by head, fold into the team prompt.
- **Edge Cases:** An operator-edited callback row is no longer recognisable and must be left as an ad-hoc order rather than silently dropped; the recogniser must match the pre-rewrite wording, which is what is actually on disk.

## Verification Plan

1. A team coder's delivered prompt contains the git safety text — the gap this plan exists to close, checked in the received text, not the config.
2. A team coder still receives its report-back instruction naming the correct head terminal, **as a grammatical sentence with an explicit subject** — no bare leading "it".
3. Starting a 4-member team creates **one** standing-order row, not four.
4. Re-wiring the same team (e.g. after a partial failure, or with a head that came up as `Lead-2`) still leaves exactly one team-scoped row — the `(scope, teamId)` key holds.
5. A `/clear` followed by a new message from the lead still delivers the full team prompt — the survives-the-clear property.
6. The head does not receive a "report to your head agent" instruction about itself, despite being listed in the registered group's `members` array.
7. A team with a `reviewer` member still installs that pair-scoped order on the head, naming the reviewer.
8. An install with existing per-member callback rows has them folded into the team prompt on upgrade, with no duplicate delivery (member does not get both the old row and the new team prompt).
9. An operator-edited ad-hoc link-up order is untouched by the migration.
10. The safety text in the team prompt is byte-identical to `GIT_SAFETY_DIRECTIVE` — proving one source of truth rather than a copy.
11. `link-presets-mirror-contract.test.js` passes with the rewritten callback text — all three copies still byte-identical.
12. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline (5 `TS2835` errors at HEAD).

## Recommendation

Complexity 6 → **Send to Coder**, after `standing-orders-scopes-and-decap.md` lands. The migration is the part with data risk; the signature extension and the callback rewrite are the parts most easily half-done, because both have call sites and copies that compile fine when missed.

## Completion Summary

Replaced the per-member pair-row pattern with one `team`-scoped standing order per team, carrying the team prompt (callback + `GIT_SAFETY_DIRECTIVE`, imported from `agentPromptBuilder.ts`). `wireSpawnedTeam` (`teamWiring.ts`) now accepts `teamId` and `prompt` options, derives the team id from `headName` (same as the group registration), emits one `team`-scoped order keyed on `(scope, teamId)` for idempotency, and keeps `head-receives` presets as pair-scoped orders. The head is excluded from team-prompt delivery via `selectOrders` in `standingOrders.ts` (checks `o.parent === targetName` for team scope), even though the registered group's `members` array includes it. The callback text was rewritten across all three byte-pinned copies (`teamWiring.ts`, `linkPresets.ts`, `terminals.js`) to name the head explicitly via `{child}` interpolation instead of the antecedent-less `it` that relied on the render prefix; the contract test should still pass since all three remain byte-identical. A `PRE_REWRITE_CALLBACK_INSTRUCTION` constant preserves the old text for the `migrateTeamPairOrders` recogniser, which is called at all three standing-orders read sites (PTY chokepoint, VS Code path, standalone host) and folds existing per-member rows into team-scoped orders on read. The TEAMS tab editor in `kanban.html` gained a prompt text area (loaded in `teamsTabShowGroupForm`, saved in `teamsTabSaveAgentGroup`); `SHIPPED_TEAM_TYPES` was left untouched per instructions. All three call sites (`bootstrap.ts`, `agentGroupInstantiation.ts`, `TaskViewerProvider.ts`) now thread `prompt` from the team definition.

**Review fixes (round 2):** Three mirror-parity defects found in review, all from changing the host resolver without updating its hand-copied webview mirror in `terminals.js`. (1) Added the head-exclusion check (`o.parent && targetName === o.parent → false`) to the team branch of `applyStandingOrdersClient`, matching `standingOrders.ts:110` — without it the Shift-drop path delivered the team prompt to the head. (2) Hand-copied `migrateTeamPairOrders` as `migrateTeamPairOrdersClient` into `terminals.js` and applied it inside `applyStandingOrdersClient` at render time (NOT at the `fetchStandingOrders` level, to avoid uuid churn breaking the Link-up editor's delete-by-id), with mirror constants for the pre-rewrite callback text, post-rewrite template, and `GIT_SAFETY_DIRECTIVE`. (3) Updated `standing-orders-marker-contract.test.js`: the team-order test now asserts head exclusion when `parent` names the head (the old `teamOrder()` helper with no `parent` was a false-confidence case), and added two new mirror-parity tests — one asserting both files have the `o.parent` head-exclusion check in the team branch, and one asserting both files apply the team-pair migration with `PRE_REWRITE_CALLBACK_INSTRUCTION` and that the client does NOT apply it at the fetch level.

**Review fix (round 3):** Added a `GIT_SAFETY_DIRECTIVE` byte-identity parity test to `standing-orders-marker-contract.test.js` — extracts the backtick template literal from `agentPromptBuilder.ts` (handling escaped backticks via greedy match + unescape) and the single-quoted mirror from `terminals.js`, and asserts `deepStrictEqual`. This pins the one guardrail team coders get against invisible drift (verification step 10, "Safeguard text must have one source of truth"). Same shape as the existing marker and block-regex parity tests. No compile or test commands were run per instructions.

## Review Findings

One CRITICAL and one MAJOR, both fixed. **CRITICAL** — `bootstrap.ts:1276` threaded the team prompt as `prompt: team?.prompt`, but `const team` is block-scoped to the auto-start `if` at `:1238-1259` and the wiring call sits after it: optional chaining guards a null *value*, never an undeclared *binding*, so this was a `ReferenceError` (caught by `tsc` as `TS2304`, never run) that would throw on every standalone team spawn **after** the head and members were already created — orphan terminals with no group registration and no standing orders, exactly the "terminals are real, do not destroy them" contract inverted. Fixed by hoisting a `teamPrompt` local, mirroring the extension host's `payload.teamPrompt` threading (`TaskViewerProvider.ts:2648`→`:2802`), which was correct. **MAJOR** — the plan's "one source of truth" requirement and verification step 10 were unmet for the surface that matters: `kanban.html`'s three `SHIPPED_TEAM_TYPES` prompts hand-copy both `GIT_SAFETY_DIRECTIVE` and `AGENT_GROUP_CALLBACK_INSTRUCTION` (a fourth and third copy), and the round-3 parity test pinned only `terminals.js`; a new mechanical parity test now pins all three shipped prompts to `agentPromptBuilder.ts` and `teamWiring.ts`, mutation-tested to confirm it is not vacuous. **NIT:** `WireSpawnedTeamOptions.teamId` is passed by no caller — all three rely on the `headName` derivation, which does match the group registration. Files changed this pass: `src/standalone/bootstrap.ts`, `src/test/standing-orders-marker-contract.test.js`. Verification: `standing-orders-marker` 30/30, `link-presets-mirror` 7/7, `npx tsc --noEmit` clean for these files.
