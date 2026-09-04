# Add a Resident Rule: Never File a New Plan Into an Already-Coded Feature

kanbanColumn: CREATED

## Goal

An agent creating a plan is told, every turn, not to attach it to a feature whose subtasks have already been coded — because nothing will ever pick it up.

### Problem analysis

**Observed 2026-09-05.** A new, uncoded card was filed into a feature sitting in CODE REVIEWED whose seven subtasks were all complete. A reviewed feature is not somewhere anyone looks for work, so the card was invisible the moment it was assigned. The operator caught it; nothing else would have.

The failure is quiet by construction. Assignment succeeds, the board renders, every gate passes, and the only symptom is a card that is never dispatched.

**Nothing states the rule.** The board carries *A Feature Must Be True Of The Plans Inside It*, which is about containment as a property of the feature, and the seat-orientation rules say nothing about feature membership at authoring time. An agent deciding where a plan belongs has no resident instruction covering this.

**It belongs in the resident block.** The choice is made at authoring time, on the turn the plan is written, by an agent that may never read a skill file. That is exactly the bar for residency — the rules re-presented every turn — and it is why the existing three (plan import, memo capture, kanban queries) are there.

## Metadata

- **Complexity:** 2
- **Tags:** control-plane, agents, board-hygiene

## User Review Required

None.

## Proposed Changes

### 1. Add the rule to the resident protocol body

One line, in the constant that is written into the managed block of **both** `CLAUDE.md` and `AGENTS.md`. Today that is `RESIDENT_PROTOCOL_BODY`; the emitted text is guaranteed by code, and the two files share one body deliberately so the hosts cannot drift.

Substance: a plan must not be attached to a feature whose subtasks are already coded — it will not be picked up. File it as a loose card instead.

### 2. Do not hand-edit `AGENTS.md` or `CLAUDE.md`

The managed block is regenerated from the constant. A hand-edit to either file is silently overwritten on the next scaffold, and the codebase says so: *"the emitted text is guaranteed by code rather than by the packaged AGENTS.md, which a hand-edit could otherwise silently change."*

### 3. Fit the size gate

`claude-protocol-block-size-contract.test.js:38` asserts the block stays under **800 characters**. Current state:

| | chars |
| :--- | ---: |
| `RESIDENT_PROTOCOL_BODY` | 527 |
| `DOCS_POINTER_RULE` (gated, reserved headroom) | 127 |
| **available for this rule** | **146** |

The rule must fit in that budget without consuming the docs pointer's reservation. If it cannot, shorten it — do not raise the gate. The block was cut from 14,826 characters deliberately, and every line in it is there because it must be re-presented every turn.

### 4. Sequence against the mirror retirement

`6c25a1e1` (*Delete the Claude mirror generator*) may relocate the managed-block helpers and retire `ClaudeCodeMirrorService.ts`. Its change 5 is explicit that `buildManagedInner` and `stripProtocolMarkers` *"serve the AGENTS.md/CLAUDE.md managed block and are unrelated to skill mirroring"* and must survive — but they may move.

So: target the resident body wherever it lives when this is coded, not a hardcoded path. If `6c25a1e1` has landed, follow the helpers to their new home.

## Edge-Case & Dependency Audit

1. **The rule is about filing, not about features.** It must not read as a prohibition on adding subtasks to a live feature — a feature still in a planning column gains subtasks routinely, and that is correct.
2. **"Already coded" is the test, not the column name.** Column labels differ from stored ids and users say the label; phrase it so it does not depend on either.
3. **Both hosts get it automatically** — one body, two targets. Do not add a per-host variant; that is the documented host-drift trap.
4. **The size test will fail loudly** if the budget is exceeded, which is the intended behaviour. Do not adjust `SIZE_GATE`.
5. **A skill file is the wrong home.** A skill is read when invoked; this decision is made whenever a plan is authored, including by agents that invoke nothing.

## Verification Plan

1. The rule appears in the managed block of both `CLAUDE.md` and `AGENTS.md`, from one source.
2. `claude-protocol-block-size-contract.test.js` passes, with the docs-pointer headroom intact.
3. A scaffold run does not remove or duplicate the rule.
4. Neither markdown file was hand-edited to achieve this.
5. The rule does not read as forbidding subtasks on a feature that is still being planned.
