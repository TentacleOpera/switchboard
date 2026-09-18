# Sharpen Multi-Workspace Plan Creation Instructions in AGENTS.md

## Goal

Agents frequently write plan files to the wrong workspace when working across multi-root setups. Fix this by teaching agents a precise, filesystem-based discovery algorithm in AGENTS.md — rather than relying on implicit assumptions or a new indicator file.

## Metadata

- **Tags:** documentation, workflow
- **Complexity:** 2

## User Review Required

None. Documentation-only change to `AGENTS.md`.

## Complexity Audit

### Routine
- Rewrite the `📂 Workspace Detection for Plan Creation` section of `AGENTS.md` with a clearer, step-by-step discovery algorithm.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None — documentation only.

**Security:** None.

**Side Effects:** Agents that previously relied on the vague "primary signal" rule will now follow a deterministic algorithm. This is intentional and strictly better.

**Dependencies & Conflicts:** The new instructions must remain consistent with the `## Workspace Detection for Plan Creation` section referenced in `AGENTS.md`. No other files reference this section.

## Dependencies

- None

## Adversarial Synthesis

Key risk: agents still misroute if they don't perform the filesystem check (i.e., they skip Step 1 and assume). Mitigation: the new rule explicitly labels the filesystem check as mandatory and states the fallback (ask the user) when no `.switchboard/plans/` is found. The documentation change is self-contained with no runtime risk.

## Proposed Changes

### AGENTS.md — `📂 Workspace Detection for Plan Creation` section

**Context:** The current section uses vague priority signals ("primary signal", "secondary signal") that agents can easily misapply when the active file is in a repo that has no `.switchboard/plans/` directory. The critical missing piece is that agents must first *discover* which workspace is Switchboard-managed via a filesystem check before writing anything.

**Logic:**

Replace the existing section with a deterministic algorithm:

1. **Discover which workspace(s) are Switchboard-managed** — check each open workspace root for `.switchboard/plans/`. This directory does NOT exist in every repo; it only exists in Switchboard-managed workspaces.
2. **If exactly one workspace has `.switchboard/plans/`** — always write the plan there, regardless of which repo the active file is in. The plan's *content* describes the work; the *file location* is always the Switchboard workspace.
3. **If multiple workspaces have `.switchboard/plans/`** — use the active editor's workspace root as the tiebreaker: write to the `.switchboard/plans/` in whichever Switchboard-managed workspace contains the active file. If the active file is not in any Switchboard-managed workspace, ask the user which workspace to use.
4. **If no workspace has `.switchboard/plans/`** — ask the user. Never create the directory structure yourself.

**Critical rule to add:** Never assume `.switchboard/plans/` exists. Always verify with a filesystem check (`ls` or equivalent) before writing.

**Implementation — replacement text for the section:**

```markdown
### 📂 Workspace Detection for Plan Creation

**MANDATORY**: Before writing any plan file, you MUST verify where to write it using this algorithm:

**Step 1 — Discover the Switchboard workspace**
Check each open workspace root for the existence of `.switchboard/plans/`. Not every repo in a multi-root setup has this — only Switchboard-managed workspaces do. Run: `ls {workspaceRoot}/.switchboard/plans/` for each root.

**Step 2 — If exactly one workspace has `.switchboard/plans/`**
Write the plan there. Period. Do not write it to the repo the task is *about* — that repo may not be Switchboard-managed. The plan content describes the work; the file location is always the Switchboard workspace.

**Step 3 — If multiple workspaces have `.switchboard/plans/`**
Use the active editor's workspace root as the tiebreaker. Write to the `.switchboard/plans/` directory in whichever Switchboard-managed workspace contains the currently active file. If the active file is not in any Switchboard-managed workspace, ask the user which workspace to use.

**Step 4 — If no workspace has `.switchboard/plans/`**
Ask the user where to write the plan. Never create `.switchboard/plans/` yourself.

**NEVER** skip the filesystem check and assume a workspace is Switchboard-managed based on file context alone.
```

## Verification Plan

### Automated Tests
- None applicable (documentation change).

### Manual Verification
1. Open a multi-root workspace with two repos: one Switchboard-managed (has `.switchboard/plans/`), one not.
2. Open a file in the non-Switchboard repo.
3. Ask an agent to "write a plan to improve X" where X is in the non-Switchboard repo.
4. Verify the plan is written to the Switchboard repo's `.switchboard/plans/`, not the non-Switchboard repo.
5. Open a file in the Switchboard repo and repeat — verify plan still goes to the correct location.

---

**Recommendation: Send to Coder**

---

## Review Pass — Completed

### Reviewer Findings

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | **MAJOR** | Step 3's "or most closely matches the task description" was subjective — the exact class of ambiguity this plan was created to eliminate. It reintroduced the old "Secondary signal: Task content keywords" problem in new wording. | **Fixed**: Replaced with deterministic fallback: "If the active file is not in any Switchboard-managed workspace, ask the user which workspace to use." |
| 2 | NIT | `ls` command suggestion doesn't handle non-zero exit codes; `test -d` would be more robust. | Deferred — agents interpret instructions, not literal shell scripts. |
| 3 | NIT | Single-workspace case (most common) isn't explicitly called out. | Deferred — Step 2 implicitly handles it clearly enough. |

### Files Changed

- **`AGENTS.md`** (line 103-104): Step 3 rewritten — removed subjective "most closely matches" clause, added deterministic "ask the user" fallback when active file is not in any Switchboard-managed workspace.
- **Plan file** (this file): Updated Logic item #3 and implementation code block to match the AGENTS.md fix.

### Validation Results

- Documentation-only change; no automated tests applicable.
- Full section reviewed for internal consistency: Steps 1-4 now form a fully deterministic decision tree with no subjective branches.
- Every branch terminates in either a concrete write action or "ask the user."
- Git diff confirms only the intended line was changed.

### Remaining Risks

- None material. The algorithm is now fully deterministic at every branch point.
