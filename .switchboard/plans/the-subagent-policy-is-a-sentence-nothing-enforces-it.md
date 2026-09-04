# The Subagent Policy Is a Sentence — Nothing Enforces It

kanbanColumn: CREATED

## Goal

A seat configured for no subagents cannot spawn one, on any host where that is enforceable. Where it is not enforceable, the operator is told that the setting is advice, and a violation is visible rather than silent.

### Problem analysis

**Observed 2026-09-04.** A Devin coder dispatched with the policy in its prompt announced *"Let me write them all in parallel using subagents"* and ran a `code-specialist` subagent. The prompt it was given says, in full:

> `SUBAGENT POLICY: You are strictly forbidden from spawning or invoking any subagents. Handle all tasks yourself.`

**That sentence is the entire mechanism.** `NO_SUBAGENTS_DIRECTIVE` (`agentPromptBuilder.ts:1369`) is a string appended to a prompt. A repo-wide search for tool-permission machinery finds only `ClaudeCodeMirrorService`'s `allowedTools`, which scopes *skills* — not the seat's own tools. Nothing writes a host settings file, disallows a tool, or checks afterwards whether the instruction was followed.

**So it is not a policy, it is a request** — and it competes against the host's own affordances. Spawning parallel subagents is a first-class, encouraged capability in the seat's harness; one line in a long prompt is the weaker signal. The failure is entirely predictable and will recur on any host that offers subagents natively.

**The cost is not theoretical.** The setting exists because the operator's teams *are* the parallelism: seats are the unit, and a coder fanning out to subagents spends budget outside the fleet, produces work no reviewer sees, and makes the seat's own progress unreadable. That is why the policy is set, and it did not hold.

**Two things are conflated today.** Whether a seat *should* use subagents is configuration and works. Whether a seat *can* is enforcement and does not exist. A setting that reads as the first while only delivering the second half of nothing is worse than an honest note, because the operator stops watching for the thing they believe is prevented.

## Metadata

- **Complexity:** 4
- **Tags:** agents, prompts, policy, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. Enforce it where the host can

Some seat CLIs can be launched with tools restricted or a permission file that denies subagent spawning. Where the seat's CLI family supports it, apply the restriction at spawn instead of asking in the prompt.

The CLI family is already resolved per seat, so the dispatch path knows which host it is talking to. Use it.

### 2. Where it cannot be enforced, say so

A host with no restriction mechanism gets the prompt directive and nothing else — that is unavoidable. What is avoidable is presenting it as a guarantee.

The setting must show which seats it actually binds and which it merely asks. An operator who knows a Devin seat is on the honour system watches for it; one who believes it is enforced does not.

### 3. Detect a violation rather than assuming compliance

Where enforcement is impossible, detection is still cheap. A seat that spawns a subagent produces recognisable output. Surface it as a turn-end notice to the lead, once, naming the seat.

The point is not to punish it — it is that today the violation is invisible until an operator reads the transcript, which is how this was found.

### 4. Do not soften the directive

The wording is not the problem and must not be weakened into a suggestion. An agent that ignores "strictly forbidden" will ignore anything gentler. The gap is mechanism, not phrasing.

## Edge-Case & Dependency Audit

1. **The authorized-subagent variant** (`:1371`, "you are authorized to use the `<name>` subagent") has the same gap in reverse — nothing stops a seat using a *different* one. Whatever enforcement lands must express both shapes, not just the ban.
2. **Do not enforce by breaking the seat.** A restriction that stops the CLI starting, or that removes tools the task needs, is worse than the current state.
3. **Host capability must be read, not assumed.** Guessing that a family supports a flag and silently doing nothing when it does not reproduces this bug one layer down. Record which mechanism was applied per seat.
4. **The default is separate.** A memo finding records that `subagentPolicy` initialises to `'default'` rather than `'noSubagents'` (`KanbanProvider.ts:6610-6613`) — whether the ban should be the default is its own decision and not this card.
5. **Both hosts** dispatch seats and both must apply whatever mechanism lands.
6. **Detection must not fire on a legitimate authorized subagent.**

## Verification Plan

1. A seat on a host that supports restriction cannot spawn a subagent, with the directive removed from the prompt entirely.
2. A seat on a host that cannot be restricted still receives the directive, and the setting shows that seat as unenforced.
3. A violation on an unenforced seat produces one notice to the lead naming the seat.
4. An authorized subagent does not trigger the violation notice.
5. The mechanism applied to each seat is recorded and readable after the fact.
6. No seat fails to start because of the restriction.
