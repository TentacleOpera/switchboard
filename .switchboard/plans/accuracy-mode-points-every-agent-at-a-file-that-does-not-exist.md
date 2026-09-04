# Accuracy Mode Points Every Agent at a File That Does Not Exist

kanbanColumn: CREATED

## Goal

An agent told to follow the accuracy workflow can find it. Today the instruction names a path that is not in the repository, and a rewrite map actively redirects the two paths that might have worked.

### Problem analysis

**Observed 2026-09-04.** A dispatched coder was told: *"Accuracy Mode: Before coding, read and follow the workflow at `.agents/protocols/accuracy/SKILL.md`."* The read failed. It searched `.agents` twice, listed `.agents/protocols/`, found only `improve-feature` and `improve-plan`, and proceeded without the protocol — reporting *"Accuracy protocol not found. Proceeding."*

Three lines produce this:

```
agentPromptBuilder.ts:555   ACCURATE_CODING_DIRECTIVE → '.agents/protocols/accuracy/SKILL.md'
agentPromptBuilder.ts:1668  '.agents/workflows/accuracy.md'    → '.agents/protocols/accuracy/SKILL.md'
agentPromptBuilder.ts:1674  '.agents/skills/accuracy/SKILL.md' → '.agents/protocols/accuracy/SKILL.md'
```

The directive names the path, and the rewrite map redirects **both** plausible alternatives to the same place. A repo-wide search for an accuracy skill file returns only plan files that discuss accuracy — the workflow itself is not present under `.agents/` at all.

So every path an agent could try has been closed: the one it is told, and the two the map would have rewritten.

**Why no gate caught it.** The directive is a string. It compiles, it lints, it renders into the prompt correctly, and the agent's failure to find the file is invisible to every check — the agent says so in its own output and carries on. The only observer is whoever reads the transcript.

**What is unknown and must be established first:** whether the accuracy workflow was deleted deliberately, moved somewhere the map does not name, or never migrated when `.agents/protocols/` was created. That decides whether this is a path fix or a retirement.

## Metadata

- **Complexity:** 2
- **Tags:** prompts, agents, control-plane, bugfix

## User Review Required

None — but change 1 must be answered before changes 2 or 3 are chosen.

## Proposed Changes

### 1. Establish what happened to the accuracy workflow

Check the history for `.agents/workflows/accuracy.md`, `.agents/skills/accuracy/`, and `.agents/protocols/accuracy/`. One of three answers, and each has a different fix:

- **It exists somewhere else** — correct the directive and the map to the real path.
- **It was deliberately retired** — remove the directive, the map entries, and the toggle that emits it. An agent should not be told to follow a workflow that was deliberately removed.
- **It was lost in a move** — restore it, then correct the path.

Do not guess. A directive pointing at a plausible-but-absent path is what produced this.

### 2. If the directive stays, the path must be verifiable

A prompt fragment that names a file should be checked against the control plane it ships with, so a moved or deleted workflow fails visibly at build or test time rather than silently in a dispatched agent's terminal.

### 3. If the workflow is gone, remove the whole surface

The directive, both rewrite-map entries, and whatever setting turns Accuracy Mode on. A toggle that emits an instruction to read a deleted file is worse than no toggle.

## Edge-Case & Dependency Audit

1. **The rewrite map may serve other directives** — `:1668` and `:1674` sit in a table. Confirm what else it rewrites before editing entries around them.
2. **Other directives may name paths too.** Whatever check change 2 adds should cover them, not just this one; this is unlikely to be the only string naming a control-plane file.
3. **Agents fail soft here.** The coder proceeded without the protocol and reported it in one line. Nothing else notices, so this class of defect survives until a human reads a transcript.
4. **Do not restore a workflow that was retired on purpose.** Change 1 exists to prevent exactly that.

## Verification Plan

1. The fate of the accuracy workflow is established from history, and recorded.
2. An agent dispatched with Accuracy Mode on either reads a file that exists, or is not told to read one.
3. No rewrite-map entry points at a path absent from the repository.
4. A directive naming a missing control-plane file fails a check rather than reaching an agent.
