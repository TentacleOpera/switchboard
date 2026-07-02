# Accuracy Workflow — Stop Writing Out Artifacts

## Goal

The `/accuracy` workflow currently instructs the agent to write out persistent artifacts to disk during execution. The user wants this stopped — the workflow should keep all planning, tracking, and review output **in-context** (in the conversation) rather than creating files on the filesystem.

### Problem Analysis & Root Cause

**Observed behavior:** When `/accuracy` runs, the agent creates files on disk:
- A `task.md` progress-tracking file (referenced in Steps 2 and 4).
- A "detailed plan" artifact (Step 3: "MUST create a detailed plan listing every change...").
- A `### Red Team Findings` document (Step 5: "Document findings in `### Red Team Findings`").

**Why this is a problem:**
- The accuracy workflow is a **solo, in-conversation implementation mode** optimized for per-prompt pricing. Its value is doing work directly in the active session, not producing standalone deliverables.
- Writing `task.md` and plan files litters the workspace with throwaway files that are not part of the Switchboard plan/kanban pipeline (plans belong in `.switchboard/plans/` via the planning workflows, not generated ad-hoc by an implementation workflow).
- The `### Red Team Findings` instruction is ambiguous — the `###` markdown heading reads as "write a document" rather than "output this in your reply," so agents err toward creating a file.

**Root cause:** The workflow text in `.agents/workflows/accuracy.md` (and its mirror `.claude/skills/accuracy/SKILL.md`) contains explicit directives to create/update files:
- Line 23: `Mark Phase 1 complete in your task tracking (e.g., update task.md or use Kanban UI if available).`
- Line 40: `MUST update `task.md` as you go: mark completed items `[x]`.`
- Line 28: `MUST create a detailed plan listing every change...`
- Line 52: `Document findings in `### Red Team Findings` with specific line numbers.`

These directives cause the agent to materialize artifacts instead of tracking progress in its own reply/context.

## Metadata

**Complexity:** 2
**Tags:** workflow, accuracy, prompt-engineering, no-artifacts
**Project:** Remote sync

## Complexity Audit

**Routine.** This is a text-only edit to two markdown files (the workflow definition and its skill mirror). No code, no build, no migrations, no runtime behavior change. The only risk is wording ambiguity — the replacement text must clearly say "in your reply / in-context" so agents don't interpret it as "write a file."

## Edge-Case & Dependency Audit

- **Two source files must stay in sync:** `.agents/workflows/accuracy.md` and `.claude/skills/accuracy/SKILL.md` are byte-identical mirrors. Both must be edited identically or the host that reads the skill copy will still see the old behavior.
- **Kanban UI reference:** Step 2 mentions "or use Kanban UI if available" as an alternative to `task.md`. The Kanban UI is a legitimate, non-artifact progress mechanism (it updates kanban state, not files). This alternative should be preserved — only the `task.md` file-writing path is being removed.
- **Plan creation ambiguity:** Step 3 says "create a detailed plan." This must be reworded to "produce a detailed plan in your reply" so it is not interpreted as "write a plan file to `.switchboard/plans/`." Plan files are the domain of `/improve-plan` and the planning workflows, not `/accuracy`.
- **Red Team Findings:** Must be explicitly scoped to the conversation reply, not a file. The `###` heading is fine as in-reply markdown.
- **No downstream consumers:** Nothing in the codebase parses `task.md` or a Red Team Findings file produced by `/accuracy` — confirmed there are no references to `task.md` outside the two workflow files. Safe to remove the file-writing directives with no migration.
- **Published-extension consideration:** These workflow/skill `.md` files ship inside the extension and are read at runtime. Existing installs will pick up the change on next extension update. No state migration is required because no persisted state is involved — the change only affects future workflow executions.

## Proposed Changes

### File 1: `.agents/workflows/accuracy.md`

**Change A — Step 2 (line 23):** Remove the `task.md` file-writing directive; keep the Kanban UI option and add in-context tracking.

```diff
-   - Mark Phase 1 complete in your task tracking (e.g., update task.md or use Kanban UI if available).
+   - Mark Phase 1 complete in your reply (a brief checklist is fine) or via the Kanban UI if available. Do NOT create any tracking files on disk.
```

**Change B — Step 3 (line 28):** Scope the plan to the conversation reply.

```diff
-   - MUST create a detailed plan listing every change, which files are affected, and how to verify each.
+   - MUST produce a detailed plan in your reply listing every change, which files are affected, and how to verify each. Do NOT write a plan file to disk — plan files are the domain of `/improve-plan`, not `/accuracy`.
```

**Change C — Step 4 (line 40):** Replace `task.md` updates with in-reply checklist updates.

```diff
-   - MUST update `task.md` as you go: mark completed items `[x]`.
+   - MUST track progress in your reply as you go: mark completed items `[x]` in an in-context checklist. Do NOT create or update any `task.md` (or other tracking) file on disk.
```

**Change D — Step 5 (line 52):** Scope Red Team Findings to the reply.

```diff
-   - Document findings in `### Red Team Findings` with specific line numbers.
+   - Document findings in your reply under a `### Red Team Findings` heading with specific line numbers. Do NOT write these findings to a file.
```

**Change E — Add an explicit no-artifacts rule** near the top (after the "File Creation Rules" block, ~line 11), to make the intent unambiguous and catch any future drift:

```diff
 ## File Creation Rules
 - When creating files in `.switchboard/`, always use `IsArtifact: false` to prevent path validation errors.
+
+## No-Artifact Rule
+- `/accuracy` is a solo, in-conversation workflow. Do NOT write out artifacts to disk as part of execution — no `task.md`, no plan files, no Red Team Findings file, no progress logs. All planning, progress tracking, and review output belongs in your reply to the user. The only files you create or modify are the actual code files required by the task itself.
```

### File 2: `.claude/skills/accuracy/SKILL.md`

Apply **the identical five changes (A–E)** so the skill mirror stays byte-identical to the workflow definition. This file is the copy consumed by Claude Code / hosts that read from `.claude/skills/`.

## Verification Plan

1. **Diff review:** `git diff -- .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` — confirm both files received identical edits and no `task.md` / "create a detailed plan" / "Document findings in" file-writing phrasing remains.
2. **Sync check:** `diff .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` — the two files should differ only by the front-matter `name:`/`description:` block at the top of the SKILL.md (which the workflow lacks). Confirm no content drift in the Steps section.
3. **Grep sweep:** `grep -rn "task\.md" .agents/ .claude/skills/accuracy/` should return zero matches.
4. **Grep sweep:** `grep -rni "create a detailed plan\|Document findings in" .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` should return zero matches (the reworded versions say "produce a detailed plan in your reply" / "Document findings in your reply").
5. **Behavioral sanity (manual):** Run `/accuracy` on a trivial task and confirm the agent does NOT create `task.md`, a plan file, or a Red Team Findings file — all output appears in its reply.
