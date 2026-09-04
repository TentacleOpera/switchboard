# The Repo Tells Devin to ALWAYS Use a Subagent, and the Prohibition Is Dispatch-Only

kanbanColumn: CREATED

## Goal

A seat configured for no subagents is still under that constraint on its second task, after a clear, and after a follow-up message — the same way it is still under the git-safety constraint.

### Problem analysis

**Observed 2026-09-04.** A coder finished one piece of work, was told *"now write the remaining tests"*, announced it would parallelise with subagents, and ran one. Asked about it, the coder said it had not been told not to.

**It was right, and worse — the repository was telling it the opposite.**

`.devin/agents/code-specialist/AGENT.md` is tracked in this repo and has been since `886e82e1` (2026-05-30, an auto-commit before a code review). Devin discovers subagents from `.devin/agents/<name>/AGENT.md`, so every Devin seat working in this checkout is offered it, with this description:

```yaml
name: code-specialist
description: High-performance subagent with GLM-5.1 model -
             ALWAYS use for planning, code review, and editing tasks
model: GLM-5.1
```

**"ALWAYS use... for editing tasks."** That is an imperative, it is permanent, it sits in the working tree, and it directly contradicts the operator's policy. The seat that ran `code-specialist` was following the repository's own instruction.

Against it, Switchboard's prohibition is delivered once and is not part of the durable set.

`NO_SUBAGENTS_DIRECTIVE` (`agentPromptBuilder.ts:1370`) appears only on the dispatch-prompt path — `:1443`, `:1502`, `:1834`. The standing-order fragments are a different list entirely:

```
codingHead   externalMemberCallback   gitSafety   globalCompletion
headCommit   headCompletion   headNext   memberCompletion
memberWork   orchestratorReport   reviewHead
```

**There is no subagent fragment.** Standing orders are the block that says *"These apply to everything you do in this terminal until told otherwise"*, and they are re-delivered on terminal establish and after every clear. `gitSafety` is among them, because destructive-git constraints were recognised as needing to persist. The subagent policy is the same class of constraint — a standing prohibition on how the seat works, not an instruction about one task — and was never made one.

So the policy survives exactly as long as the dispatch prompt stays in context. A follow-up message, a clear, a long task that pushes it out, and the seat is operating with no policy and no way to know one existed. It does not ignore the instruction; it no longer has it.

**The asymmetry is the tell.** Git safety persists and subagent policy does not, for no reason other than which list each was added to.

**So the contest was never close.** A permanent in-repo file saying *always use it* against a prompt line saying *never* that had already scrolled out of context. Nothing had to be ignored for this to happen.

**A second, separate gap: nothing enforces it either.** Even while in context, the directive is a prompt string. A repo-wide search for tool-permission machinery finds only `ClaudeCodeMirrorService`'s `allowedTools`, which scopes *skills*, not the seat's own tools. Nothing writes a host settings file, disallows a tool, or checks afterwards. That matters less than the durability gap — an instruction that is present and ignored is a different failure from one that is absent — but both are real.

## Metadata

- **Complexity:** 3
- **Tags:** agents, prompts, standing-orders, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. Stop shipping a subagent definition that contradicts the policy

Remove `.devin/agents/code-specialist/` from the repository, or rewrite its description so it does not instruct agents to ALWAYS use it. It arrived in a May auto-commit, is tracked, and is the strongest signal any Devin seat in this checkout receives about subagents.

Removing the affordance is the only enforcement that actually works on a host with no tool-restriction mechanism: a subagent that is not defined cannot be invoked. This is the fix that would have prevented the reported failure on its own.

Check `.devin/workflows/chat.md` in the same pass — it is the other tracked file in that tree.

### 2. Make the subagent policy a standing-order fragment

Add it beside `gitSafety` in `standingOrderFragments.ts`, gated on the seat's resolved `subagentPolicy`. It is then composed into the standing-orders block, re-delivered on establish and after clear, and lives under the block's own contract — *"until told otherwise"*.

This is the fix. Everything below is secondary.

### 3. It must express the authorized variant too

The policy has two shapes: forbidden, and *"authorized to use `<name>`, no others"* (`:1371`). Both are standing constraints on how the seat works. A fragment that only carries the ban leaves the authorized case with the same durability gap.

### 4. Enforce where the host allows it

Where a seat's CLI family supports restricting tools at spawn, apply it rather than relying on the prompt. The family is already resolved per seat, so the dispatch path knows which host it is talking to.

Where no mechanism exists, the prompt is what there is — but the setting should show which seats it binds and which are on the honour system. An operator who knows a seat is unenforced watches for it.

### 5. Do not soften the wording

"Strictly forbidden" is not the problem. An agent that ignores it will ignore anything gentler. The gaps are durability and mechanism, not phrasing.

## Edge-Case & Dependency Audit

1. **Audit `.devin/` and any other host-discovered agent directory** for definitions that contradict Switchboard's own directives. This one was found because it failed loudly; the tree is small and should be read in full.
1b. **Check every other dispatch-only directive for the same gap.** The subagent policy was found because it failed loudly. Any constraint phrased as "how you work" rather than "what to do now" belongs in the standing orders, and the two lists should be reconciled rather than patched one entry at a time.
2. **The standing-orders block has a length budget.** It is re-delivered on every clear and already carries several fragments; adding to it is not free. One sentence is affordable, a policy essay is not.
3. **The `default` policy emits nothing** and must continue to — a seat with no policy set should not gain a standing order it never had.
4. **A memo finding records that `subagentPolicy` initialises to `'default'`** rather than `'noSubagents'` (`KanbanProvider.ts:6610-6613`). Whether the ban should be the default is a separate decision and not this card.
5. **Both hosts** compose standing orders and both must carry the new fragment.
6. **Relates to `7dae7ef2` and `1e2afcd8`** — the after-clear block and the startup orientation. All three concern what a seat is told and when. Fixes should agree on what the durable set contains.

## Verification Plan

1. No file in the repository instructs an agent to use a subagent while the policy forbids it.
1b. A seat with `noSubagents` receives the policy in its standing orders, not only in its dispatch prompt.
2. That seat still has the policy after a clear.
3. That seat still has the policy on a follow-up message with no new dispatch.
4. A seat with an authorized subagent carries that constraint durably too.
5. A seat with `default` gains no subagent standing order.
6. Both hosts compose the fragment identically.
7. Where a host supports tool restriction, a seat cannot spawn a subagent regardless of the prompt.
