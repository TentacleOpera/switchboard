# Feature Plan: Clarify "Pin to Project" Mechanism in Workflow & Protocol Docs

## Goal

Make the `**Project:** <name>` plan-pinning mechanism explicit in the plan-creation workflow docs (`improve-plan.md`, `memo.md`, `improve-feature.md`) so agents pin to a real project — never the workspace name — and bring the generated CLAUDE.md mirror back in sync with its AGENTS.md source of truth.

### ⚠️ Pre-applied protocol fix — PRESERVE, do not revert
> On **2026-07-08** the pinning protocol was changed at the source so agents **never ask** which project to pin. `AGENTS.md:150` and `switchboard-chat.md` Rule 8 (both sources), plus their generated mirrors (`CLAUDE.md`, `.claude/skills/switchboard-chat/SKILL.md`), now read: *"if the user named a project, pin it; otherwise write no `**Project:**` line — do not ask the user."* This subtask must **preserve** that. Do **NOT** reintroduce any "ask whether there's a project" / "otherwise ask" wording. Every doc snippet below says **omit — never ask**. When regenerating `CLAUDE.md` (change #4), first confirm the **bundled** `AGENTS.md` already contains the ask→omit flip, or the regen will silently revert it.

### Problem
Agents are confused when asked to "pin to a project." The `**Project:** <name>` frontmatter mechanism is documented in `AGENTS.md` (lines 143–156) and partially in `CLAUDE.md` (lines 167–178), but it is **missing from the key plan-creation workflows** (`improve-plan.md`, `memo.md`, `improve-feature.md`) that agents actually follow when writing plans. A spot-check of 10 recent plan files showed **0 out of 10** had a `**Project:**` line — agents are simply not writing it.

> **Verified correction (improve-plan review, 2026-07-08):** The "0 out of 10" claim above is **inaccurate** and is retained only per the content-preservation rule. The actual repo data: 1084 plan files in `.switchboard/plans/`; 164 raw `**Project:**` occurrences; **47 files** carry a pin that looks like a real project name. Of those 47, **~43 pin to "switchboard" / "Switchboard" — the workspace name** — which the protocol forbids and which `KanbanDatabase._resolveProjectForInsert` (line 1549, `_isWorkspaceName` guard) **silently drops to unassigned**. Only ~4 pin to a genuine project name. So the real failure mode is **not** "agents never write the line" — it is "agents write it WRONG (the workspace name), and the importer silently discards it." The proposed workflow-doc changes (#1-3) still address the root cause (no workflow doc teaches correct pinning), but the problem framing must reflect the verified data.

### Background
- The pinning protocol lives in `AGENTS.md` lines 143–156 and `CLAUDE.md` lines 167–178.
- The parser is in `src/services/planMetadataUtils.ts` lines 105–112 (regex: `/^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Project(?:\*\*:\s*|:\*\*)\s*(.+)$/im`).
- DB resolution is in `src/services/KanbanDatabase.ts` lines 1504–1583 (`_resolveProjectForInsert`); the workspace-name guard is `_isWorkspaceName` at line 1549+ (best-effort, resolve-only is the load-bearing primary).
- `switchboard-chat.md` (lines 14–17, Rule 8) has the full protocol — but `improve-plan.md`, `memo.md`, and `improve-feature.md` do NOT.
- `CLAUDE.md` is missing the "System backstop" blockquote that explains why unknown pins are rejected.

> **Verified correction (improve-plan review, 2026-07-08) — CLAUDE.md is a GENERATED mirror, not hand-maintained.** `ensureProtocolFile` (`src/extension.ts:3077`) reads the **bundled AGENTS.md as the single source of truth** and overwrites the entire managed block (between `<!-- switchboard:claude-protocol:start -->` / `:end -->`) on every `switchboard.setup`/activation when the content differs (lines 3163-3168). The repo's `CLAUDE.md` is therefore a checked-in *generated artifact*. It is currently stale in **five** ways, not just the missing backstop: (a) missing the `/switchboard-orchestrator` workflow-registry row, (b) missing six skill rows (group-into-features, worktree_cleanup, switchboard-orchestrator, switchboard-orchestration, refine_feature, create-feature-from-plans), (c) missing the orchestrator exception in the kanban-column-transitions paragraph, (d) missing the "System backstop" blockquote, (e) the skill table is an older snapshot. Hand-editing the managed block is counterproductive — the scaffolder will overwrite it on the next setup. There is **no** dedicated npm script to regenerate it (scripts section, `package.json:774`); regeneration happens only via the running extension (`Switchboard: Setup AI Protocol Files` / `scaffoldProtocolLayers` on activation).

### Root Cause
1. **Workflow docs don't mention pinning**: `improve-plan.md` only mentions `**Project:**` in passing in the manifest section (line 107); `memo.md` says "create a plan file following the standard format" with no pinning instruction; `improve-feature.md` has nothing.
2. **CLAUDE.md is incomplete**: Missing the "System backstop" note about the resolve-only importer — and, more fundamentally, is a stale generated mirror (see verified correction above).
3. **Protocol is buried**: The pinning section is at the bottom of AGENTS.md/CLAUDE.md, after the skills table — not prominent.
4. **Agents pin the workspace name**: No workflow doc explicitly states "the workspace/repo name is NOT a project," so agents write `**Project:** switchboard`, which the importer drops. (Verified: ~43 of 47 pinned plans use the workspace name.)

## Metadata

- **Tags:** docs
- **Complexity:** 3

> **Tag note (review):** The original tags (`docs, protocol, agent-behaviour, project-pinning`) are reduced to `docs` — `protocol`, `agent-behaviour`, and `project-pinning` are NOT in the allowed tag set (`ALLOWED_TAGS`, `planMetadataUtils.ts:7-11`). Only values from `[frontend, backend, auth, authentication, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library]` are permitted.

## User Review Required

Yes — before implementation, confirm:
- [ ] The corrected problem framing (workspace-name mis-pinning, not "0/10 absent") is accepted.
- [ ] The decision to **regenerate** CLAUDE.md (change #4-revised) rather than hand-edit it is accepted.
- [ ] That no `.claude/skills/` mirror will be hand-edited (change #5-revised) — they regenerate from `.agents/` sources.

## Complexity Audit

### Routine
- Adding a "Project Pinning" reminder to `improve-plan.md`, `memo.md`, and `improve-feature.md` (the genuine `.agents/workflows/` sources of truth).
- Adding `**Project:** <name>` to the Metadata section example in workflow docs.
- Correcting the line target in change #1 (Metadata section = lines 31-36, not line 107).

### Complex / Risky
- CLAUDE.md is a **generated** managed block; the correct fix is regeneration (run `Switchboard: Setup AI Protocol Files` against the repo, or accept auto-scaffold on next activation), NOT a hand-edit. A hand-edit would be overwritten by `ensureProtocolFile` on the next setup and would only fix 1 of 5 staleness symptoms. (Clarification of existing requirement, not new scope.)
- `.claude/skills/*/SKILL.md` mirrors are **generated** by `ClaudeCodeMirrorService.generateClaudeMirror` from `.agents/` sources; they must NOT be hand-edited (tracked in `.claude/.switchboard-generated.json`). They will pick up changes #1-3 automatically on next activation. (Clarification of existing requirement, not new scope.)

## Edge-Case & Dependency Audit

### Race Conditions
- None for the `.agents/workflows/` edits (static docs).
- CLAUDE.md regeneration: the scaffolder is idempotent and marker-spanning (handles duplicate/stray markers, `extension.ts:3130-3138`); a regeneration concurrent with a manual edit to the managed block would lose the manual edit — which is the intended behavior (the managed block is owned by the scaffolder).

### Security
- None.

### Side Effects
- Agents following updated workflows will start writing `**Project:** <name>` lines in plan files. The importer already handles this (resolve-only; unknown/workspace-name/placeholder pins drop to unassigned, `KanbanDatabase.ts:1537-1562`). No DB migration needed.
- Regenerating CLAUDE.md will also restore the orchestrator workflow row, the missing skill rows, and the orchestrator exception — i.e., it brings the Claude-Code protocol layer fully current, a broader (beneficial) side effect than just the backstop.
- The `.claude/skills/` mirrors will regenerate on next activation, propagating the pinning notes added to the workflow sources — no manual mirror edit required.

### Dependencies & Conflicts
- The pinning protocol text must be consistent across AGENTS.md, CLAUDE.md, and all workflow files. Because CLAUDE.md is generated from AGENTS.md, consistency is automatic once CLAUDE.md is regenerated — do not diverge the wording by hand.
- Regeneration reads the **bundled** AGENTS.md (from the installed VSIX). If the installed VSIX bundles an older AGENTS.md than the repo's current one, regeneration would write the older content. For the repo's own CLAUDE.md to reflect the *current* repo AGENTS.md, the extension must be rebuilt/reinstalled from the repo first, OR `switchboard.setup` must run with a build that bundles the current AGENTS.md. Flag this to the user.

## Dependencies

- None (no prior session dependencies). All facts verified directly against source during this review.

## Adversarial Synthesis

Key risks: (1) the plan's original "0/10 absent" diagnosis was false — the real failure is workspace-name mis-pinning silently dropped by the importer, so the workflow-doc fix is still valid but for a corrected reason; (2) CLAUDE.md and the `.claude/skills/` mirrors are generated artifacts, so changes #4-5 must be "regenerate / don't hand-edit" rather than manual edits, or the scaffolder will overwrite them and only one of five staleness symptoms gets fixed. Mitigations: edit only the `.agents/` sources of truth (#1-3); regenerate CLAUDE.md via `switchboard.setup`; let mirrors auto-regenerate on activation; ensure the running build bundles the current AGENTS.md before regenerating.

## Proposed Changes

---

### 1. `.agents/workflows/improve-plan.md` — Add project pinning to required sections

**Context**: The workflow specifies required plan sections. Add a note about project pinning near the Metadata section requirement.

**Logic**: The Metadata section requirement lives at **lines 31-36** (NOT line 107 — line 107 is the Plan-Import Manifest section, which is the wrong location; an implementer placing the note there would bury it where plan-creators never look). Add the pinning reminder immediately after the Metadata bullets (after line 36).

**Implementation**: Add after the Metadata section requirement (after line 36, NOT "around line 107"):
```markdown
### Project Pinning
When creating or updating a plan, include `**Project:** <name>` in the Metadata section if a project is active or the user named one. The workspace/repo name is NOT a project — never pin it (the importer silently drops workspace-name pins to unassigned). If no project is active and the user didn't name one, omit the line — never ask the user which project to use. See AGENTS.md "Plan Project Pinning" for the full protocol.
```

**Edge Cases**: Keep the note compact — it points to AGENTS.md for the full protocol rather than duplicating it, so future AGENTS.md edits don't desync the workflow doc.

---

### 2. `.agents/workflows/memo.md` — Add project pinning to step 4

**Context**: Step 4 (line 52) says "create a separate plan file following the standard Switchboard plan format." Add pinning instruction.

**Logic**: Append to step 4 (line 52). The memo flow creates plans unattended, so the "never use the workspace name" warning is especially load-bearing here.

**Implementation**: Append to step 4:
```markdown
Include `**Project:** <name>` in the Metadata section if a project is active (read `kanban.activeProjectFilter` from kanban.db) or the user named one in the memo entry. The workspace/repo name is NOT a project — never use it as a pin (the importer silently drops workspace-name pins to unassigned). If no project is active, omit the line — never ask the user which project to use.
```

**Edge Cases**: Memo entries rarely name a project; the "omit if none" rule prevents agents from inventing a pin from the workspace name.

---

### 3. `.agents/workflows/improve-feature.md` — Add project pinning note

**Context**: The workflow improves feature subtasks but doesn't mention pinning.

**Logic**: Add a note in the section that deals with subtask plan updates (Step 2, "Improve every subtask," lines 31).

**Implementation**: Add a note in the section that deals with subtask plan updates:
```markdown
### Project Pinning
When updating subtask plans, ensure each has `**Project:** <name>` in Metadata if a project is active; if none is active, omit the line — never ask the user. The workspace/repo name is NOT a project — never pin it (the importer silently drops workspace-name pins to unassigned). See AGENTS.md "Plan Project Pinning" for the full protocol.
```

**Edge Cases**: Subtask plans inherit the feature's project context; the note keeps them consistent without forcing a re-read of `kanban.activeProjectFilter` per subtask.

---

### 4. `CLAUDE.md` — REGENERATE the managed block (do NOT hand-edit)

**Context**: Lines 167–178 have the pinning protocol but are missing the system backstop note that exists in AGENTS.md line 156. More broadly, the entire managed block (lines 33-181, between `<!-- switchboard:agents-protocol:start -->` / `:end -->`) is a **generated** artifact that is stale in five ways (see Background verified correction).

**Original proposal (preserved per content-preservation rule)**:
> Append after the existing pinning protocol in CLAUDE.md:
> ```markdown
> > **System backstop:** the importer is resolve-only. An unknown pin (or one equal to a workspace name / a literal `<...>` placeholder) leaves the plan unassigned instead of auto-creating a `projects` row. Only the user creates projects (on the board). The protocol above is the first line of defense; the import guard is the non-negotiable backstop.
> ```

**REVISED implementation (review correction)**: Do **not** hand-edit CLAUDE.md. Instead, **regenerate** the managed block from the bundled AGENTS.md (which already contains the backstop at line 156 AND the orchestrator row AND the current skill table):
1. Ensure the running Switchboard extension build bundles the **current** repo `AGENTS.md` (rebuild/reinstall the VSIX from the repo if the installed build is older — see Dependencies & Conflicts).
2. Run `Switchboard: Setup AI Protocol Files` in the repo workspace (command `switchboard.setup`), OR rely on auto-scaffold on next activation (`scaffoldProtocolLayers`, `extension.ts:3250`).
3. `ensureClaudeProtocol` (`extension.ts:3218`) will detect the managed block content differs from the bundled source and perform an in-place update (lines 3163-3168), restoring the backstop plus all four other missing pieces in one pass.

**Edge Cases**: If `switchboard.protocol.target` is set to `agents` (not `both`/`claude`), CLAUDE.md won't be scaffolded — verify the setting is `both` or `claude` first (`getProtocolTargets`, `extension.ts:3232`). The scaffolder skips when content already matches (idempotent, line 3159), so re-running is safe.

---

### 5. `.claude/skills/` mirrors — DO NOT hand-edit; they auto-regenerate

**Context**: The original proposal said "If these skill files mirror the workflow docs, add the same pinning note for consistency. Check and update if they contain Metadata section guidance."

**REVISED implementation (review correction)**: `.claude/skills/improve-plan/SKILL.md`, `.claude/skills/accuracy/SKILL.md`, etc. are **generated mirrors** (`ClaudeCodeMirrorService.generateClaudeMirror`, `ClaudeCodeMirrorService.ts:314`), tracked in `.claude/.switchboard-generated.json` (generator v1.7.5). They are rebuilt from the `.agents/workflows/*.md` and `.agents/skills/*` sources on every `generateClaudeMirror` call (invoked by `scaffoldProtocolLayers`, `extension.ts:3275`). **Do not hand-edit them** — any hand-edit is overwritten on the next mirror generation. Instead:
1. Make the `.agents/workflows/` edits in changes #1-3 (the sources of truth).
2. The pinning notes will propagate into the `.claude/skills/` mirrors automatically the next time `generateClaudeMirror` runs (on `switchboard.setup` / activation).
3. If immediate mirror refresh is desired without a full setup, the regeneration happens as part of the same `switchboard.setup` run as change #4.

**Edge Cases**: `generateClaudeMirror` only touches skills listed in `MIRROR_MANIFEST` plus dynamically-scanned `switchboard-*.md` skills (`ClaudeCodeMirrorService.ts:348-367`); user-authored `.claude/skills/` dirs are never modified (invariant #1, line 12-16).

## Verification Plan

### Automated Tests
Automated tests and compilation are **out of session scope** per session directives (SKIP TESTS, SKIP COMPILATION). The `AGENTS.md Scaffolding Logic` suite (`src/test/extension.test.ts:72`) covers the merge/idempotency rules and would be the relevant regression guard when tests are run normally — note it here for the eventual full-verification pass, not for this session.

### Manual Verification
- [ ] Read `improve-plan.md` — confirm a "Project Pinning" section is present after the Metadata requirement (after line 36), NOT in the manifest section.
- [ ] Read `memo.md` — confirm step 4 (line 52) mentions project pinning and the "workspace name is NOT a project" warning.
- [ ] Read `improve-feature.md` — confirm the Project Pinning note is present.
- [ ] Read `CLAUDE.md` — confirm the managed block was **regenerated** (System backstop blockquote present AND orchestrator workflow row present AND missing skill rows restored). Confirm it was NOT hand-edited.
- [ ] Confirm AGENTS.md and CLAUDE.md pinning sections are consistent (automatic once CLAUDE.md is regenerated from the current AGENTS.md).
- [ ] Read `.claude/skills/improve-plan/SKILL.md` — confirm it regenerated from the edited `.agents/workflows/improve-plan.md` (contains the pinning note). Confirm it was NOT hand-edited.
- [ ] Dispatch an agent to create a plan via `/improve-plan` — verify the output plan has `**Project:**` in Metadata pinned to a REAL project (not the workspace name), or omits the line if none is active.

### Grep Checks
```
grep -l "Project Pinning" .agents/workflows/improve-plan.md .agents/workflows/memo.md .agents/workflows/improve-feature.md
grep "System backstop" CLAUDE.md
grep "workspace.*NOT a project\|workspace name is NOT" .agents/workflows/improve-plan.md .agents/workflows/memo.md .agents/workflows/improve-feature.md
```

## Files Changed

- `AGENTS.md` + `.agents/workflows/switchboard-chat.md` (+ generated `CLAUDE.md`, `.claude/skills/switchboard-chat/SKILL.md`) — **already changed 2026-07-08: `ask`→`omit` (never ask which project). PRESERVE; do NOT reintroduce any "ask whether there's a project" wording. See the "Pre-applied protocol fix" callout above.**
- `.agents/workflows/improve-plan.md` — add Project Pinning section after the Metadata requirement (after line 36, NOT line 107)
- `.agents/workflows/memo.md` — add pinning (with workspace-name warning) to step 4 (line 52)
- `.agents/workflows/improve-feature.md` — add Project Pinning note in the subtask-update section
- `CLAUDE.md` — **regenerate** the managed block from bundled AGENTS.md via `switchboard.setup` (restores System backstop + orchestrator row + skill rows + orchestrator exception); do NOT hand-edit
- `.claude/skills/` mirrors — **no manual edit**; auto-regenerate from the `.agents/` sources above via `generateClaudeMirror` on next activation
