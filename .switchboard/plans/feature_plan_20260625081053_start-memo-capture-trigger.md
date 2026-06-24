# Make "start memo capture" a Real Natural-Language Trigger for Memo Capture Mode (and Fix the Tip)

## Goal

Let a user enter Memo Capture mode by saying **"start memo capture"** in any agent chat — not just by typing the `/memo` slash command — and make the Memo sub-tab's tip advertise that working capability.

**Problem.** The Memo sub-tab tip in `implementation.html` reads:

> Tip: use the /memo skill to start memo capture.

This is wrong on two levels:

1. **The advertised entry path isn't universal.** The user's explicit, previously-given directive is that **"start memo capture"** must be the trigger, because *a slash command cannot be the trigger in every host* — some agent chats don't support custom slash commands. Pointing users at `/memo` strands anyone whose chat can't run it.
2. **"start memo capture" does not actually trigger anything today.** A codebase-wide search (`grep -rni "start memo capture"`) finds the phrase in exactly one place: the tip text itself. It is wired into **no** trigger surface — not the skill description, not the workflow body, not the registry. The earlier directive to make it a trigger was never carried through to the mechanism; at most a tip was reworded. So the proposed "fix it to say 'start memo capture'" would point users at a phrase that does nothing.

**Root cause — how memo capture is actually triggered.** There is **no code-level string parser** for `/memo` anywhere in `src/` (confirmed: the only `src/` references to memo are the `ClaudeCodeMirrorService` mirror-manifest entry and the sidebar backend that writes `.switchboard/memo.md`). Entry into capture mode is driven entirely at the agent/LLM layer:

- In **Claude Code**, the memo skill is registered with `invocation: 'default'` (`ClaudeCodeMirrorService.ts:43`), meaning the model auto-invokes it based on the skill's **frontmatter `description`**. That generated description is copied verbatim from the source workflow's frontmatter `description` (`ClaudeCodeMirrorService.ts:236` — `parsed.description || entry.descriptionFallback`). The current description — *"Memo capture mode — append-only, no analysis; exit with `process memo`"* — never names an entry phrase, so the model has no signal to fire on "start memo capture."
- The workflow body's Process step #1 keys initialization on the literal *"On `/memo`"*.
- `AGENTS.md` / `CLAUDE.md` document the trigger word as `/memo` only, and the MANDATORY PRE-FLIGHT CHECK explicitly says *"Do not auto-trigger on generic language,"* which actively discourages the model from treating a natural-language phrase as an entry trigger.

So the lever that makes "start memo capture" work is **naming it in the skill `description` and in the workflow/registry entry rules** — exactly the surfaces the slash command can't substitute for.

**Source-of-truth constraint (critical — this is why prior attempts likely failed).** `.agents/` and the repo-root `AGENTS.md` are the **bundled source** shipped to user workspaces (`ControlPlaneMigrationService.ts`: `BUNDLED_AGENT_DIR = '.agents'`, `BUNDLED_AGENTS_FILE = 'AGENTS.md'`). The repo-root `CLAUDE.md` (managed-block markers at `CLAUDE.md:22` / `:156`) and every `.claude/skills/*/SKILL.md` are **GENERATED** from those sources by `ClaudeCodeMirrorService` and are overwritten on version refresh (invariant documented at `ClaudeCodeMirrorService.ts:12-22`). **Editing `.claude/skills/memo/SKILL.md` or `CLAUDE.md` by hand accomplishes nothing durable** — the change must be made in `.agents/workflows/memo.md` and `AGENTS.md`, then the generated layer regenerated.

**Fix (summary).** Add "start memo capture" as a recognized natural-language entry trigger in the memo workflow source (frontmatter description + Process step + a short entry-mode note), mirror it into the `AGENTS.md` registry/skills-table/priority-rule and the pre-flight rule, regenerate the `.claude/` + `CLAUDE.md` layer, and update the Memo-tab tip to the user's exact wording. `/memo` keeps working — the new phrase is purely additive.

## Metadata

- **Tags:** memo, trigger, skill-description, agents-md, claude-md, source-of-truth, implementation-html, ui-copy
- **Complexity:** 4/10
- **Affected surface:** Memo capture entry path across all agent hosts; Memo sub-tab tip
- **Files touched (source-of-truth):** 3 — `.agents/workflows/memo.md`, `AGENTS.md`, `src/webview/implementation.html`
- **Files regenerated (do NOT hand-edit):** `.claude/skills/memo/SKILL.md`, `CLAUDE.md`

## Complexity Audit

**Complex / Risky-ish (4/10).** This is not a one-line copy change. The substance is documentation/skill-metadata, so there is no compiled code path or runtime logic to break — but correctness depends on getting the **source-of-truth routing** right and on the change actually influencing model behavior:

- **Routing risk (primary).** The intuitive edits (`.claude/skills/memo/SKILL.md`, `CLAUDE.md`, or just the tip) are exactly the ones that get silently overwritten or have no effect. The change must land in `.agents/workflows/memo.md` + `AGENTS.md`, then the generated layer must be refreshed. Mis-routing is the most likely failure and the reason the prior directive didn't stick.
- **Behavioral risk (secondary).** "start memo capture" is a model-invocation trigger, not a deterministic parse. Reliability comes from naming the exact phrase in the frontmatter `description` and reconciling it with the pre-flight "do not auto-trigger on generic language" rule (otherwise the two instructions conflict and the model may decline to fire). This is inherent to how skills work in Claude Code and is the best available mechanism — the user's requirement explicitly rules out depending on a slash command.
- **Low blast radius otherwise.** Purely additive: `/memo` and the sidebar Memo tab paths are untouched. No state, settings, or persisted format changes.

## Edge-Case & Dependency Audit

- **Generated-file overwrite (must respect).** `.claude/skills/memo/SKILL.md` and `CLAUDE.md`'s managed block are regenerated by `ClaudeCodeMirrorService` and tracked in `.claude/.switchboard-generated.json`. Hand-edits to them are non-durable. **Action:** edit only the sources, then regenerate.
- **Description propagation.** The generated skill `description` = source frontmatter `description` (`ClaudeCodeMirrorService.ts:236`). Because `.agents/workflows/memo.md` already ships a frontmatter `description`, editing that line propagates correctly into `.claude/skills/memo/SKILL.md` on regeneration — no `descriptionFallback` involved.
- **Pre-flight conflict.** `AGENTS.md` / `CLAUDE.md` contain: *"Do not auto-trigger on generic language … unless the user explicitly asks to run that workflow."* "start memo capture" must be enumerated as an **explicit** trigger (like `/memo`) so it is not mistaken for generic language. Without this reconciliation the new description and the pre-flight rule contradict each other.
- **Exit semantics unchanged.** The sole exit remains the exact message `process memo`; `edit N:` remains the in-place edit command. This change touches only **entry**. Do not alter exit/append rules.
- **Embedded-phrase ambiguity (intentional, leave as-is).** The workflow already documents that trigger words inside a longer sentence are *content*, not commands (the "Anti-Example" section). The new entry trigger should follow the same spirit: "start memo capture" as a clear request to begin (whole-message or unambiguous intent) starts capture; the same words buried mid-sentence while already capturing are appended verbatim. The Process-step wording should say "start memo capture (or a close variant)" without promising exact-match parsing, mirroring how `/memo` is described.
- **Published-extension propagation (per project migration rule).** ~4,000 installs on older versions. This is **not** a data migration — no state/file/setting format changes, nothing is deleted, and `/memo` still works, so it is fully backward compatible. The new source files reach existing workspaces only when the bundled `.agents/`/`AGENTS.md` refresh fires (`ControlPlaneMigrationService._shouldRefreshAgentVersion`, gated on extension version). **Action:** ensure the change ships under a version bump so the agent-version refresh carries it; no archival/import shim is needed.
- **Tip is single-source.** The tip string occurs once in `src/` (`src/webview/implementation.html`, inside `#agent-list-memo`). The matching `dist/webview/implementation.html` line is a build artifact — do not hand-edit or flag it (project rule: `dist/` is not used in dev/testing).
- **Tip honesty.** After this change the tip's promise ("you can also use 'start memo capture' in an agent chat") is backed by a real entry trigger, so the copy is accurate rather than aspirational.

## Proposed Changes

### 1. `.agents/workflows/memo.md` — source of truth for the memo skill (drives Claude Code model-invocation)

**(a) Frontmatter `description`** — name the entry phrase so the generated skill description gives the model a signal to fire on. This is the load-bearing edit.

Before:
```markdown
---
description: Memo capture mode — append-only, no analysis; exit with `process memo`
---
```
After:
```markdown
---
description: Memo capture mode. Enter by saying "start memo capture" (or the /memo command) in chat; then append-only, no analysis; exit with `process memo`.
---
```

**(b) Process step #1 — recognize the natural-language entry alongside `/memo`.**

Before:
```markdown
1. **Initialize:** On `/memo`, read `.switchboard/memo.md` (create if absent). ...
```
After:
```markdown
1. **Initialize:** On `/memo` — or when the user asks to **start memo capture** (that phrase or a close variant, as a request to begin) — read `.switchboard/memo.md` (create if absent). ...
```

**(c) Add a short "Entering Capture Mode" note** near the top of the body (above or beside the Process section) stating both entry paths and *why* the phrase exists: not every host supports custom slash commands, so "start memo capture" is the host-independent way in. Keep `process memo` as the only exit.

### 2. `AGENTS.md` — shipped source that regenerates `CLAUDE.md`

- **Workflow Registry row** (`AGENTS.md:22`): add the phrase to the Trigger Words column.
  Before: `| `/memo` | **`memo.md`** | Memo capture mode — append-only, no analysis. Exit with `process memo`. ... |`
  After: `| `/memo`, "start memo capture" | **`memo.md`** | Memo capture mode — append-only, no analysis. Enter via `/memo` or by saying "start memo capture". Exit with `process memo`. ... |`
- **Skills table row** (`AGENTS.md:92`): change "User invokes `/memo` to enter…" → "User invokes `/memo` **or says \"start memo capture\"** to enter…".
- **Memo Priority Rule paragraph** (`AGENTS.md:101`): add one sentence noting capture mode is entered by `/memo` **or the natural-language request "start memo capture"** (host-independent, for chats without slash commands).
- **Reconcile the pre-flight rule:** in the MANDATORY PRE-FLIGHT CHECK, list "start memo capture" as an explicit recognized trigger so it is exempt from the "do not auto-trigger on generic language" guard.

### 3. `src/webview/implementation.html` — the Memo sub-tab tip (user's exact wording)

In the `#agent-list-memo` block, replace the tip text node:
Before: `Tip: use the /memo skill to start memo capture.`
After: `Tip: you can also use 'start memo capture' in an agent chat.`
(Only the text changes; the `<p>` element and inline styles are untouched. Reference by string, not line number — the surrounding file shifts.)

### 4. Regenerate the generated layer (do NOT hand-edit these)

After editing the sources, regenerate so `.claude/skills/memo/SKILL.md` and the `CLAUDE.md` managed block pick up the new description/registry. This happens via the `ClaudeCodeMirrorService` scaffold/refresh path (e.g. on the next extension-version bump / control-plane bootstrap). Verify the regenerated `.claude/skills/memo/SKILL.md` frontmatter `description` matches the new source description, and that `CLAUDE.md`'s registry block matches `AGENTS.md`. If the dev-repo copies are checked in and must be current immediately, regenerate them via the same service rather than editing by hand.

## Verification Plan

1. **Source edits present.** `.agents/workflows/memo.md` frontmatter `description` and Process step #1 both name "start memo capture"; `AGENTS.md` registry row, skills row, priority rule, and pre-flight list all reference it. `grep -rni "start memo capture"` now returns the workflow, `AGENTS.md`, the (regenerated) `CLAUDE.md` + `.claude/skills/memo/SKILL.md`, and the tip — not the tip alone.
2. **Generated layer matches source.** Regenerate, then confirm `.claude/skills/memo/SKILL.md` frontmatter `description` equals the new source description, and the `CLAUDE.md` managed block (lines 22 / 92 / priority rule) matches `AGENTS.md`. No hand-edits left in generated files.
3. **No stale `/memo`-only language.** Confirm no source surface still presents `/memo` as the *only* way into capture mode (registry, skills table, priority rule, tip).
4. **Trigger behavior (manual, installed VSIX).** In a Claude Code agent chat with the scaffolded skills, send "start memo capture" as a whole message → the agent enters Memo Capture mode (replies `[MEMO CAPTURE ACTIVE]`, echoes the memo list, advises `process memo`). Then confirm `/memo` still enters capture mode, and `process memo` still exits and produces one plan per entry. Confirm a mid-sentence occurrence of the phrase while already capturing is appended as content, not re-triggered.
5. **Tip render.** Open the sidebar → Agents panel → Memo sub-tab; the tip reads `Tip: you can also use 'start memo capture' in an agent chat.`, wraps cleanly above the textarea, with the single quotes rendering literally and no markup breakage.
6. **Backward compatibility.** Confirm the sidebar Memo tab append path and the `/memo` path are unchanged, and that no persisted state/format was touched (pure docs/metadata + one HTML string).
