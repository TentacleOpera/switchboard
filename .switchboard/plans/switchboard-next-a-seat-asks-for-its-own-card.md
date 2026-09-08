# `/switchboard-next <guidance>` — an Unseated Terminal Pulls Its Own Work, in Plain Words

kanbanColumn: CREATED

## Goal

An agent in any terminal — a tmux pane over ssh from a phone, a plain shell, anything the board did
not spawn — types `/switchboard-next review`, or `/switchboard-next code 3 low complexity plans`,
and receives one prompt covering the cards that guidance names, with those cards advanced on the
board. The agent states how it read the request before acting.

### Problem analysis

**The board cannot write into an unseated terminal, and does not need to.**
`register-an-agent-in-any-local-terminal.md` puts the gap precisely: *"there is no portable OS
mechanism to write into an unrelated process's stdin. This is a genuine capability gap, not an
unimplemented stub."* Its inversion — the agent pulls — is the answer, and this flow needs no
registration on top of it. The agent is already in the terminal; handing it the prompt text **is**
delivery.

**The guidance is free text, interpreted by the agent, and that is the point.** A fixed role enum
answers `review` and nothing else. The operator wants to say *"code 3 low complexity plans"* and
have it resolve to: source column `PLAN REVIEWED`, complexity band low, the three highest-precedence
matches, as one batch. Parsing that belongs in the skill, where a model reads it — not in a CLI
flag grammar that would need extending for every phrasing.

**Every primitive already exists.**

- **The read is complete.** `GET /kanban/plans` already returns `priorityStarred`, `priority`,
  `complexity`, `columnOrder`, `columnEnteredAt`, `isFeature`, `featureId` and `recommendedRole` on
  every card. Nothing needs adding to select or order.
- **The batch is native.** `promptSelected` takes `{ column, sessionIds, workspaceRoot }` —
  **`sessionIds` is plural** — and `/kanban/advance` already groups by column and passes arrays.
- **It returns the prompt.** `LocalApiServer.ts:2529`: *"`promptSelected` ALWAYS returns
  `{ success, prompt, targetColumn }`."* `/kanban/advance` discards it because a console has no
  clipboard. This flow is the clipboard.
- **The ordering exists.** `compareByPrecedence` (`kanbanOrdering.ts:75`): starred first, then
  `priority` 1–4 with null last.

**So there is no new mechanism here — there is an interpretation layer and a rule about honesty.**

## Metadata

- **Complexity:** 4
- **Tags:** cli, skills, dispatch, tmux, both-hosts
- **Project:** Browser Switchboard

## User Review Required

None.

### Goal Invariants — present-operator safety model

The whole safety mechanism is **"echo the interpretation before acting, then proceed."** That is a guard that works **only while a human is watching the terminal**. The headline use case is a tmux pane over ssh from a phone — the operator who typed the command and may have looked away. An unattended wrong reading advances the wrong cards with no rollback and no second chance. This is an explicit, accepted assumption of the design, not a gap to close with a confirmation gate (a gate is rejected below for the attended case, and misrouted cards are recoverable by re-advancing). State it, proceed, and let the echo do its work for the operator who is present.

## Complexity Audit

### Routine

- Read `GET /kanban/plans` (already returns `priorityStarred`, `priority`, `complexity`, `columnOrder`, `columnEnteredAt`, `isFeature`, `featureId`, `recommendedRole`).
- Filter and order client-side with `compareByPrecedence` semantics pinned to priority mode.
- One `promptSelected` call per source column (plural `sessionIds` already supported).
- Echo the interpretation; cap the count; report each leg.

### Complex / Risky

- **Free-text interpretation is non-deterministic.** Two agents reading "code 3 low complexity plans" can resolve it differently, and the only audit trail is the echoed text. The echo is the safety mechanism — and it is operator-present-dependent (see the safety-model note above).
- **The `Unknown`-complexity exclusion is a silent judgement.** A "code everything" reading that the operator intended to include unscored cards in will exclude them by band logic; the exclusion count is reported, but whether the operator *wanted* them is not. The echo is the only place this is catchable.
- **No seat identity, by design.** Under tmux, panes inherit the tmux server's environment, so an inherited seat name would be a plausible wrong answer — real cards delivered to the wrong agent. The guidance is the identity; reintroducing inference would be a regression. This is a correctness constraint, not a convenience gap.
- **`targetColumn` is the discriminator, not `success`.** A card in the final stage returns `{ success: true, prompt, advanced: 0 }` with no `targetColumn`; reporting that as progress is a false success on a no-op.

## Dependencies

- **Reuses** `GET /kanban/plans`, `promptSelected` (plural `sessionIds`), `compareByPrecedence` (`kanbanOrdering.ts:75`), and the dependency-gate that `queue/next` already applies. No new endpoint, no new primitive.
- **Depends on machine-parseable `--json`** if the skill reads via the CLI (`switchboard plans --json`) rather than `switchboard api GET /kanban/plans`. Either works; if the CLI path is used, the *json-output* subtask's guarantees (one parseable document, no truncation) are a prerequisite. The skill should pick one read path and state it.
- **`AGENTS.md` registry correction** — `AGENTS.md:23` currently says "These four are the ONLY user-typeable workflow commands." Adding `/switchboard-next` makes that false and must be corrected in the same change.
- **`MIRROR_MANIFEST`** in `ClaudeCodeMirrorService.ts:50` — Claude Code discovers skills through the mirror; an entry in `.agents/` alone exists for one host only. The new skill must be registered in both places.
- **Ordering within feature:** independent of the other three subtasks at the code level, but its `AGENTS.md` edit and the *agents-need-a-named-operation-set* subtask's `.agents/` rewrites touch neighbouring text — land together or coordinate to avoid clobbering the registry.

## Adversarial Synthesis

Key risks: (1) the echo-then-act safety model is operator-present-dependent and the phone-over-ssh marquee case is the absent-operator case — mitigated by stating the assumption explicitly and relying on card-re-advance for recovery, not by adding a gate; (2) free-text interpretation is non-deterministic with only the echo as audit trail — mitigated by echoing role, source column, count, filters, ordering, and the selected titles before acting; (3) `Unknown`-complexity exclusion is a silent judgement — mitigated by reporting the unscored-exclusion count in the echo; (4) inheriting a seat name from the tmux environment would deliver real cards to the wrong agent — mitigated by making the guidance the identity and refusing to reintroduce inference. A deterministic flag form (`--complexity/--count/--role`) is deliberately not built for the primary surface to avoid a second grammar kept in step with prose; it remains a reasonable future *script* surface, separate from rather than parallel to the prose.

## Proposed Changes

### 1. The skill interprets the guidance and says how it read it

Resolve, from the operator's words: the **role** (which gives the source column, as the inverse of
`getNextColumn`), the **count**, and any **filters** — complexity band, project, tags, features vs
plans.

**Then echo the interpretation before acting**, and name the cards:

```
Reading "code 3 low complexity plans" as:
  role        coder        source column: PLAN REVIEWED
  count       3
  complexity  1-3
  order       starred first, then priority (2 starred, 1 by priority)
Selected:
  1. [★]     Fix the copy-prompt label drift            complexity 4 → excluded
  ...
```

This is the whole safety mechanism. Free-text interpretation *will* sometimes be wrong, and a wrong
reading that acts silently advances the wrong cards. A wrong reading that is stated first is caught
by the operator in one glance. Do not add a confirmation prompt — state it and proceed.

### 2. One batch, one prompt

N cards produce **one** prompt for **one** terminal. That is the established shape — batch dispatch
is M plans to 1 prompt, never 1 plan to 1 agent, and the one-input-to-N-agents transpose does not
exist. `promptSelected`'s plural `sessionIds` already does this; pass the whole set in one call.

**Group by source column.** `promptSelected` filters on the source column, so a selection spanning
two columns is two calls — the same grouping `/kanban/advance` does. Report each leg.

Cap the count at a sane maximum and say so when the guidance asks for more. "Code everything" must
not advance 256 cards.

### 3. Ordering: starred, then priority — and complexity is not a number

Order candidates with `compareByPrecedence` semantics, **pinned to priority mode**: starred first,
then `priority` 1–4 with null last. Do not inherit the board's order-by mode — that is a view
preference, and a card an agent pulls should not change because someone toggled a dropdown. Do not
write a second comparator; four call sites already share one.

**`complexity` is a string, and one of its values is `Unknown`.** The live payload returns
`complexity: "6"`. Any "low complexity" filter must define its band explicitly and decide what
`Unknown` means — and `Unknown` must **not** silently fall inside the band. An unscored card
included in a "low complexity" batch is a wrong answer that looks like a right one; exclude it and
say how many were excluded for being unscored.

### 4. No CLI grammar for this

The skill composes existing calls: read `GET /kanban/plans`, filter and order client-side from
fields the payload already carries, then one `promptSelected` per source column. `switchboard next
--from <seat>` keeps popping the staged queue, unchanged.

Resist adding `--complexity`, `--count` and `--role` flags. The moment the guidance is free text,
flags are a second grammar that must be kept in step with the prose, and the prose is what the agent
actually reads.

### 5. The skill, and its two registrations

`.agents/skills/switchboard-next/SKILL.md` — the interpretation rules, the echo format, the batch
rule, the complexity-band definition. This one is *not* thin: the interpretation is the feature.

- **`AGENTS.md`'s registry** says four commands are *"the ONLY user-typeable workflow commands"*.
  That becomes false here and must be corrected in the same change.
- **`MIRROR_MANIFEST`** in `ClaudeCodeMirrorService`. Claude Code discovers skills through the
  mirror, Antigravity through the filesystem; an entry in `.agents/` alone exists for one host only.

## Edge-Case & Dependency Audit

1. **No seat identity anywhere in this flow.** Not an env var, not process ancestry, not the fleet.
   Under tmux, panes inherit the tmux *server's* environment, so an inherited seat name is a
   plausible wrong answer — the command would succeed and deliver real cards to the wrong agent. The
   guidance is the identity. Do not reintroduce inference.
2. **Do not build locking for concurrent calls.** A human types this in one terminal at a time, and
   it is self-limiting: `promptSelected` advances cards out of their source column, so a second call
   scans a column that no longer holds them. Note the window; add no lock, lease or `inFlight`
   correlation.
3. **`targetColumn` is the discriminator, not `success`.** A card in the final stage returns
   `{ success: true, prompt, advanced: 0 }` with no `targetColumn`. Reporting that as progress is a
   false success on a no-op.
4. **A disabled agent means no destination.** `_getNextColumnId` (`KanbanProvider.ts:7428`) skips
   columns whose role is off in `visibleAgents`. A role the operator disabled must be refused by
   name, not advanced somewhere unexpected.
5. **Dependency gates.** `queue/next` refuses a card whose dependency is unmet; this path applies
   the same gate rather than reaching past it.
6. **Features and subtasks are different requests.** "3 plans" should not silently return a feature
   that expands to nine subtasks. `isFeature` and `featureId` are both in the payload — use them,
   and say which kind was selected.
7. **Ambiguous guidance asks, rather than guessing.** "Code some stuff" has no count and no filter.
   One short question beats advancing an arbitrary set. This is the one place a question is right,
   because the alternative is a silent wrong action, not a confirmation gate on a known one.
8. **Both hosts.** The phone-over-ssh case is the standalone host; the flow must behave identically
   on both.

## Verification Plan

1. In an unseated tmux pane, `/switchboard-next review` returns a prompt for a card in a coded
   column and advances it to `CODE REVIEWED`.
2. `/switchboard-next code 3 low complexity plans` returns **one** prompt covering exactly three
   cards from `PLAN REVIEWED`, all within the stated complexity band, and advances all three.
3. The interpretation is echoed before acting, naming role, source column, count, filters, ordering
   and the selected titles.
4. Given a starred card and an unstarred card both eligible, the starred one is selected regardless
   of priority label; among unstarred, priority 1 beats priority 3, and null priority sorts last.
5. Selection is unchanged when the board's order-by mode is switched to `date` or `complexity`.
6. A card with `complexity: "Unknown"` is **excluded** from a low-complexity batch, and the count of
   unscored exclusions is reported.
7. Guidance requesting more than the cap is capped, and the cap is stated.
8. A selection spanning two source columns produces one `promptSelected` call per column, with each
   leg reported.
9. A card in the final stage is reported as such — no `targetColumn`, no false advance.
10. A role whose agent is disabled is refused by name.
11. Ambiguous guidance produces one clarifying question, not an arbitrary batch.
12. `switchboard next --from <seat>` still pops the staged queue, unchanged.
13. The skill resolves on both hosts, and `AGENTS.md` no longer claims four commands are the only
    user-typeable ones.

### Goal Invariants

- **Positive:** `/switchboard-next <guidance>` produces exactly one prompt covering the selected cards and advances them, via `promptSelected` with plural `sessionIds` (one call per source column) — never one prompt per card.
- **Positive:** the interpretation is echoed before acting, naming role, source column, count, filters, ordering, and the selected titles.
- **Positive:** ordering is pinned to `compareByPrecedence` priority mode (starred first, then priority 1-4, null last) and is unchanged when the board's order-by mode is switched.
- **Negative:** no seat identity is read from the environment, process ancestry, or the fleet — the guidance is the only identity input (grep-asserted: no `process.env` seat lookup, no terminal-fleet query on this path).
- **Negative:** a card with `complexity: "Unknown"` is never included in a complexity-banded batch — it is excluded and counted in the unscored-exclusion report.
- **Negative:** `switchboard next --from <seat>` (the existing staged-queue pop) is unchanged in behaviour and exit code.
