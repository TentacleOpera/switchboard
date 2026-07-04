# Accuracy Workflow — Stop Writing Out Artifacts

**Plan ID:** dadc1229-0686-41a0-ada8-5429b107f4b2

## Goal

The `/accuracy` workflow currently instructs the agent to write out persistent artifacts to disk during execution. The user wants this stopped — the workflow should keep all planning, tracking, and review output **in-context** (in the conversation) rather than creating files on the filesystem.

### Problem Analysis & Root Cause

**Observed behavior:** When `/accuracy` runs, the agent creates files on disk:
- A `task.md` progress-tracking file (referenced in Steps 2, 4, and 6).
- A "detailed plan" artifact (Step 3: "MUST create a detailed plan listing every change...").
- A `### Red Team Findings` document (Step 5: "Document findings in `### Red Team Findings`").

**Why this is a problem:**
- The accuracy workflow is a **solo, in-conversation implementation mode** optimized for per-prompt pricing. Its value is doing work directly in the active session, not producing standalone deliverables.
- Writing `task.md` and plan files litters the workspace with throwaway files that are not part of the Switchboard plan/kanban pipeline (plans belong in `.switchboard/plans/` via the planning workflows, not generated ad-hoc by an implementation workflow).
- The `### Red Team Findings` instruction is ambiguous — the `###` markdown heading reads as "write a document" rather than "output this in your reply," so agents err toward creating a file.

**Root cause:** The workflow text in `.agents/workflows/accuracy.md` (and its mirror `.claude/skills/accuracy/SKILL.md`) contains explicit directives to create/update files:
- `.agents/workflows/accuracy.md` line 23: `Mark Phase 1 complete in your task tracking (e.g., update task.md or use Kanban UI if available).`
- `.agents/workflows/accuracy.md` line 26: `MUST create a detailed plan listing every change...`
- `.agents/workflows/accuracy.md` line 40: `MUST update `task.md` as you go: mark completed items `[x]`.`
- `.agents/workflows/accuracy.md` line 50: `Document findings in `### Red Team Findings` with specific line numbers.`
- `.agents/workflows/accuracy.md` line 57: `Mark Phase 5 complete in your task tracking. The workflow automatically terminates when all phases are done.`

> **Line-number note:** The `.claude/skills/accuracy/SKILL.md` mirror has a +2 line offset (extra `name: accuracy` frontmatter line) — the corresponding lines are 25, 28, 42, 52, and 59 respectively.

These directives cause the agent to materialize artifacts instead of tracking progress in its own reply/context.

## Metadata

**Complexity:** 2
**Tags:** docs, refactor
**Project:** Remote sync

## User Review Required

No — this is a text-only edit to two workflow markdown files with no runtime code change, no migration, and no breaking behavior. The change tightens existing intent (artifacts belong in-conversation). Safe to proceed directly to coding.

## Complexity Audit

### Routine
- Text-only edits to two markdown files (workflow definition + skill mirror).
- No code, no build, no migrations, no runtime behavior change.
- Edits are straightforward find-and-replace of file-writing directives with in-reply equivalents.
- Adding a new "No-Artifact Rule" section is a pure markdown insertion.

### Complex / Risky
- **Wording ambiguity risk:** The replacement text must clearly say "in your reply / in-context" so agents don't interpret it as "write a file." If wording is ambiguous, the fix doesn't fix anything.
- **Mirror-sync risk:** The two files must receive identical step-body edits (they differ only in frontmatter). A drift between them means one host sees old behavior.

## Edge-Case & Dependency Audit

- **Two source files must stay in sync:** `.agents/workflows/accuracy.md` and `.claude/skills/accuracy/SKILL.md` are mirror files kept in sync. They differ only in frontmatter — the workflow has `---\ndescription: ...\n---` (2 content lines) while SKILL.md has `---\nname: accuracy\ndescription: ...\n---` (3 content lines, +1 `name:` line). The step bodies (everything after the frontmatter) are identical. Both must receive identical step-body edits or the host that reads the skill copy will still see the old behavior.
- **Kanban UI reference:** Step 2 mentions "or use Kanban UI if available" as an alternative to `task.md`. The Kanban UI is a legitimate, non-artifact progress mechanism (it updates kanban state, not files). This alternative should be preserved — only the `task.md` file-writing path is being removed.
- **Plan creation ambiguity:** Step 3 says "create a detailed plan." This must be reworded to "produce a detailed plan in your reply" so it is not interpreted as "write a plan file to `.switchboard/plans/`." Plan files are the domain of `/improve-plan` and the planning workflows, not `/accuracy`.
- **Red Team Findings:** Must be explicitly scoped to the conversation reply, not a file. The `###` heading is fine as in-reply markdown.
- **Step 6 task-tracking directive (line 57/59):** Step 6 says "Mark Phase 5 complete in your task tracking." This is a generic "task tracking" reference (not explicitly `task.md`), but for consistency with the no-artifacts intent it should also be clarified to "in your reply." The original plan draft missed this; it is now included as Change F.
- **Downstream consumers of accuracy-produced `task.md`:** No code parses a `task.md` produced by `/accuracy`. **However**, `task.md` does appear elsewhere in the codebase in an unrelated context — as a **brain-session artifact filename** (Antigravity brain sessions contain `task.md` files): `src/services/TaskViewerProvider.ts` line 419 lists `task.md` in `EXCLUDED_BRAIN_FILENAMES`, and `docs/DELEGATION_WORKFLOWS_README.md` line 39 references "private `task.md`" in brain context. These are a different concept (brain session artifacts) and are NOT downstream consumers of an accuracy-workflow-produced `task.md`. Safe to remove the accuracy file-writing directives with no migration — the brain-context references are unaffected.
- **Published-extension consideration:** These workflow/skill `.md` files ship inside the extension and are read at runtime. Existing installs will pick up the change on next extension update. No state migration is required because no persisted state is involved — the change only affects future workflow executions.

## Dependencies

None — this plan is self-contained and has no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) wording ambiguity — if replacement text doesn't unambiguously say "in your reply," agents may still create files; (2) mirror drift between the two files if edits aren't applied identically; (3) the missed Step 6 task-tracking directive would leave a residual artifact-creation loophole. Mitigations: use explicit "Do NOT create any file on disk" phrasing in every replacement, add a top-level No-Artifact Rule as a catch-all, include Change F for Step 6, and verify with a `diff` sync check + grep sweep.

## Proposed Changes

### File 1: `.agents/workflows/accuracy.md`

**Change A — Step 2 (line 23):** Remove the `task.md` file-writing directive; keep the Kanban UI option and add in-context tracking.

```diff
-   - Mark Phase 1 complete in your task tracking (e.g., update task.md or use Kanban UI if available).
+   - Mark Phase 1 complete in your reply (a brief checklist is fine) or via the Kanban UI if available. Do NOT create any tracking files on disk.
```

**Change B — Step 3 (line 26):** Scope the plan to the conversation reply.

```diff
-   - MUST create a detailed plan listing every change, which files are affected, and how to verify each.
+   - MUST produce a detailed plan in your reply listing every change, which files are affected, and how to verify each. Do NOT write a plan file to disk — plan files are the domain of `/improve-plan`, not `/accuracy`.
```

**Change C — Step 4 (line 40):** Replace `task.md` updates with in-reply checklist updates.

```diff
-   - MUST update `task.md` as you go: mark completed items `[x]`.
+   - MUST track progress in your reply as you go: mark completed items `[x]` in an in-context checklist. Do NOT create or update any `task.md` (or other tracking) file on disk.
```

**Change D — Step 5 (line 50):** Scope Red Team Findings to the reply.

```diff
-   - Document findings in `### Red Team Findings` with specific line numbers.
+   - Document findings in your reply under a `### Red Team Findings` heading with specific line numbers. Do NOT write these findings to a file.
```

**Change E — Add an explicit no-artifacts rule** near the top (after the "File Creation Rules" block, ~line 10), to make the intent unambiguous and catch any future drift:

```diff
 ## File Creation Rules
 - When creating files in `.switchboard/`, always use `IsArtifact: false` to prevent path validation errors.
+
+## No-Artifact Rule
+- `/accuracy` is a solo, in-conversation workflow. Do NOT write out artifacts to disk as part of execution — no `task.md`, no plan files, no Red Team Findings file, no progress logs. All planning, progress tracking, and review output belongs in your reply to the user. The only files you create or modify are the actual code files required by the task itself.
```

**Change F — Step 6 (line 57):** Clarify the generic "task tracking" reference to be in-reply, closing the residual artifact-creation loophole the original draft missed.

```diff
-   - Mark Phase 5 complete in your task tracking. The workflow automatically terminates when all phases are done.
+   - Mark Phase 5 complete in your reply. The workflow automatically terminates when all phases are done. Do NOT create or update any tracking file on disk.
```

### File 2: `.claude/skills/accuracy/SKILL.md`

Apply **the identical six changes (A–F)** to the corresponding lines (25, 28, 42, 52, ~12, 59) so the skill mirror's step body stays identical to the workflow definition. This file is the copy consumed by Claude Code / hosts that read from `.claude/skills/`. The only difference between the two files is the frontmatter block (SKILL.md has the extra `name: accuracy` line).

## Verification Plan

1. **Diff review:** `git diff -- .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` — confirm both files received identical step-body edits and no `task.md` / "create a detailed plan" / "Document findings in" file-writing phrasing remains.
2. **Sync check:** `diff .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` — the two files should differ only by the front-matter `name:`/`description:` block at the top of the SKILL.md (which the workflow lacks). Confirm no content drift in the Steps section.
3. **Grep sweep:** `grep -rn "task\.md" .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` should return zero matches.
4. **Grep sweep:** `grep -rni "create a detailed plan\|Document findings in\|Mark Phase .* complete in your task tracking" .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` should return zero matches (the reworded versions say "produce a detailed plan in your reply" / "Document findings in your reply" / "Mark Phase ... complete in your reply").
5. **No-Artifact Rule check:** `grep -n "No-Artifact Rule" .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` should return one match per file.
6. **Behavioral sanity (manual):** Run `/accuracy` on a trivial task and confirm the agent does NOT create `task.md`, a plan file, or a Red Team Findings file — all output appears in its reply.

> **Note:** Per session directives, compilation and automated tests are skipped — this is a markdown-only change with no code surface.

## Recommendation

Complexity 2 → **Send to Intern**.
