# The Subagent Policy Is Delivered Once and Is Not a Standing Order

kanbanColumn: CREATED

## Goal

A seat configured for no subagents is still under that constraint on its second task, after a clear, and after a follow-up message — the same way it is still under the git-safety constraint.

### Problem analysis

**Observed 2026-09-04.** A coder finished one piece of work, was told *"now write the remaining tests"*, announced it would parallelise with subagents, and ran one. Asked about it, the coder said it had not been told not to.

**It was right.** The constraint is delivered once, with the dispatch prompt, and it is not part of the durable set.

(A tracked `.devin/agents/code-specialist/AGENT.md` was also advertising a subagent to every Devin seat in this checkout, with a description reading *"ALWAYS use for planning, code review, and editing tasks"*. That file was deleted outside this plan — host tool configuration is not Switchboard's to plan. It is recorded here only because it explains why the reported seat had a subagent to reach for.)

`NO_SUBAGENTS_DIRECTIVE` (`agentPromptBuilder.ts:1370`) appears only on the dispatch-prompt path — `:1443`, `:1502`, `:1834`. The standing-order fragments are a different list entirely:

```
codingHead   externalMemberCallback   gitSafety   globalCompletion
headCommit   headCompletion   headNext   memberCompletion
memberWork   orchestratorReport   reviewHead
```

**There is no subagent fragment.** Standing orders are the block that says *"These apply to everything you do in this terminal until told otherwise"*, and they are re-delivered on terminal establish and after every clear. `gitSafety` is among them, because destructive-git constraints were recognised as needing to persist. The subagent policy is the same class of constraint — a standing prohibition on how the seat works, not an instruction about one task — and was never made one.

So the policy survives exactly as long as the dispatch prompt stays in context. A follow-up message, a clear, a long task that pushes it out, and the seat is operating with no policy and no way to know one existed. It does not ignore the instruction; it no longer has it.

**The asymmetry is the tell.** Git safety persists and subagent policy does not, for no reason other than which list each was added to.

**So the constraint is only as durable as the dispatch prompt's place in context.** A follow-up message or a clear, and it is gone with no way for the seat to know it existed.

**A second, separate gap: nothing enforces it either.** Even while in context, the directive is a prompt string. A repo-wide search for tool-permission machinery finds only `ClaudeCodeMirrorService`'s `allowedTools`, which scopes *skills*, not the seat's own tools. Nothing writes a host settings file, disallows a tool, or checks afterwards. That matters less than the durability gap — an instruction that is present and ignored is a different failure from one that is absent — but both are real.

## Metadata

- **Complexity:** 3
- **Tags:** agents, prompts, standing-orders, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. Make the subagent policy a standing-order fragment

Add it beside `gitSafety` in `standingOrderFragments.ts`, gated on the seat's resolved `subagentPolicy`. It is then composed into the standing-orders block, re-delivered on establish and after clear, and lives under the block's own contract — *"until told otherwise"*.

This is the fix. Everything below is secondary.

### 2. It must express the authorized variant too

The policy has two shapes: forbidden, and *"authorized to use `<name>`, no others"* (`:1371`). Both are standing constraints on how the seat works. A fragment that only carries the ban leaves the authorized case with the same durability gap.

### 3. Enforce where the host allows it

Where a seat's CLI family supports restricting tools at spawn, apply it rather than relying on the prompt. The family is already resolved per seat, so the dispatch path knows which host it is talking to.

Where no mechanism exists, the prompt is what there is — but the setting should show which seats it binds and which are on the honour system. An operator who knows a seat is unenforced watches for it.

### 4. Do not soften the wording

"Strictly forbidden" is not the problem. An agent that ignores it will ignore anything gentler. The gaps are durability and mechanism, not phrasing.

## Edge-Case & Dependency Audit

1. **Check every other dispatch-only directive for the same gap.** The subagent policy was found because it failed loudly. Any constraint phrased as "how you work" rather than "what to do now" belongs in the standing orders, and the two lists should be reconciled rather than patched one entry at a time.
2. **The standing-orders block has a length budget.** It is re-delivered on every clear and already carries several fragments; adding to it is not free. One sentence is affordable, a policy essay is not.
3. **The `default` policy emits nothing** and must continue to — a seat with no policy set should not gain a standing order it never had.
4. **A memo finding records that `subagentPolicy` initialises to `'default'`** rather than `'noSubagents'` (`KanbanProvider.ts:6610-6613`). Whether the ban should be the default is a separate decision and not this card.
5. **Both hosts** compose standing orders and both must carry the new fragment.
6. **Relates to `7dae7ef2` and `1e2afcd8`** — the after-clear block and the startup orientation. All three concern what a seat is told and when. Fixes should agree on what the durable set contains.

## Verification Plan

1. A seat with `noSubagents` receives the policy in its standing orders, not only in its dispatch prompt.
2. That seat still has the policy after a clear.
3. That seat still has the policy on a follow-up message with no new dispatch.
4. A seat with an authorized subagent carries that constraint durably too.
5. A seat with `default` gains no subagent standing order.
6. Both hosts compose the fragment identically.
7. Where a host supports tool restriction, a seat cannot spawn a subagent regardless of the prompt.
