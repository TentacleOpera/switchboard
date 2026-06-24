# Make "start memo capture" a Real Natural-Language Trigger for Memo Capture Mode (and Fix the Tip)

## Goal

Let a user enter Memo Capture mode by saying **"start memo capture"** in any agent chat — not just by typing the `/memo` slash command — and make the Memo sub-tab's tip advertise that working capability.

**Problem.** The Memo sub-tab tip in `implementation.html` reads:

> Tip: use the /memo skill to start memo capture.

This is wrong on two levels:

1. **The advertised entry path isn't universal.** The user's explicit, previously-given directive is that **"start memo capture"** must be the trigger, because *a slash command cannot be the trigger in every host* — some agent chats don't support custom slash commands. Pointing users at `/memo` strands anyone whose chat can't run it.
2. **"start memo capture" does not actually trigger anything today.** A codebase-wide search (`grep -rni "start memo capture"`) finds the phrase in exactly one place: the tip text itself (`src/webview/implementation.html:1592`). It is wired into **no** trigger surface — not the skill description, not the workflow body, not the registry. The earlier directive to make it a trigger was never carried through to the mechanism; at most a tip was reworded. So the proposed "fix it to say 'start memo capture'" would point users at a phrase that does nothing.

**Root cause — how memo capture is actually triggered.** There is **no code-level string parser** for `/memo` anywhere in `src/` (confirmed: the only `src/` references to memo are the `ClaudeCodeMirrorService` mirror-manifest entry and the sidebar backend that writes `.switchboard/memo.md`). Entry into capture mode is driven entirely at the agent/LLM layer:

- In **Claude Code**, the memo skill is registered with `invocation: 'default'` (`ClaudeCodeMirrorService.ts:43`), meaning the model auto-invokes it based on the skill's **frontmatter `description`** (confirmed by research: Claude Code uses progressive disclosure — only `name` + `description` are cached in the `<system-reminder>` block at session init; the model semantically matches user intent against these descriptions to decide auto-invocation). That generated description is copied verbatim from the source workflow's frontmatter `description` (`ClaudeCodeMirrorService.ts:236` — `parsed.description || entry.descriptionFallback || ''`). The current description — *"Memo capture mode — append-only, no analysis; exit with `process memo`"* (`.agents/workflows/memo.md:2`) — never names an entry phrase, so the model has no signal to fire on "start memo capture."
- The workflow body's Process step #1 (`.agents/workflows/memo.md:33`) keys initialization on the literal *"On `/memo`"*.
- `AGENTS.md` / `CLAUDE.md` document the trigger word as `/memo` only (`AGENTS.md:22` registry row, `AGENTS.md:92` skills table, `AGENTS.md:101` priority rule), and the MANDATORY PRE-FLIGHT CHECK (`AGENTS.md:29-30`) explicitly says *"Do not auto-trigger on generic language,"* which actively discourages the model from treating a natural-language phrase as an entry trigger.

So the lever that makes "start memo capture" work is **naming it in the skill `description` and in the workflow/registry entry rules** — exactly the surfaces the slash command can't substitute for.

**Source-of-truth constraint (critical — this is why prior attempts likely failed).** `.agents/` and the repo-root `AGENTS.md` are the **bundled source** shipped to user workspaces (`ControlPlaneMigrationService.ts:94-95`: `BUNDLED_AGENT_DIR = '.agents'`, `BUNDLED_AGENTS_FILE = 'AGENTS.md'`). The repo-root `CLAUDE.md` (managed-block markers at `CLAUDE.md:22` / `:156`) and every `.claude/skills/*/SKILL.md` are **GENERATED** from those sources by `ClaudeCodeMirrorService` and are overwritten on version refresh (invariant documented at `ClaudeCodeMirrorService.ts:12-22`). **Editing `.claude/skills/memo/SKILL.md` or `CLAUDE.md` by hand accomplishes nothing durable** — the change must be made in `.agents/workflows/memo.md` and `AGENTS.md`, then the generated layer regenerated. Both `.claude/skills/memo/SKILL.md` and `CLAUDE.md` are checked into git (verified via `git ls-files`), so the dev-repo copies must be updated too.

**Fix (summary).** Add "start memo capture" as a recognized natural-language entry trigger in the memo workflow source (frontmatter description + Process step + a short entry-mode note), mirror it into the `AGENTS.md` registry/skills-table/priority-rule and the pre-flight rule, regenerate the `.claude/` + `CLAUDE.md` layer, and update the Memo-tab tip to the user's exact wording. `/memo` keeps working — the new phrase is purely additive.

## Metadata

- **Tags:** docs, ui, feature
- **Complexity:** 4/10
- **Affected surface:** Memo capture entry path across all agent hosts; Memo sub-tab tip
- **Files touched (source-of-truth):** 3 — `.agents/workflows/memo.md`, `AGENTS.md`, `src/webview/implementation.html`
- **Files regenerated (do NOT hand-edit):** `.claude/skills/memo/SKILL.md`, `CLAUDE.md`

## User Review Required

- **Confirm the exact tip wording.** The plan proposes: `Tip: you can also use 'start memo capture' in an agent chat.` The user's previously-given directive used this exact phrasing. If the user wants different copy, this is the time to say so — the tip is a single-source string at `src/webview/implementation.html:1592`.
- **Confirm the "close variant" entry semantics.** The plan proposes that "start memo capture (or a close variant, as a request to begin)" triggers entry, mirroring how `/memo` is described. This is deliberately fuzzy (model-invoked, not regex-parsed). If the user wants stricter or looser entry matching, specify before implementation.

## Complexity Audit

### Routine
- Editing the frontmatter `description` string in `.agents/workflows/memo.md:2` — one-line text change.
- Editing the Process step #1 text in `.agents/workflows/memo.md:33` — one-line text change.
- Adding a short "Entering Capture Mode" note to `.agents/workflows/memo.md` — pure documentation insertion.
- Updating the `AGENTS.md` registry row (line 22), skills table row (line 92), and priority rule paragraph (line 101) — text edits in a markdown table and paragraph.
- Reconciling the pre-flight rule at `AGENTS.md:29-30` — adding a clause to an existing sentence.
- Updating the tip text at `src/webview/implementation.html:1592` — one-line text change.
- Regenerating `.claude/skills/memo/SKILL.md` and `CLAUDE.md` from source — mechanical, via `generateClaudeMirror` + `ensureProtocolFile`.

### Complex / Risky
- **Source-of-truth routing (primary risk).** The intuitive edits (`.claude/skills/memo/SKILL.md`, `CLAUDE.md`, or just the tip) are exactly the ones that get silently overwritten or have no effect. The change must land in `.agents/workflows/memo.md` + `AGENTS.md`, then the generated layer must be refreshed. Mis-routing is the most likely failure and the reason the prior directive didn't stick.
- **Pre-flight rule reconciliation.** `AGENTS.md:30` says "Do not auto-trigger on generic language … unless the user explicitly asks to run that workflow." "start memo capture" must be enumerated as an **explicit** trigger (like `/memo`) so it is not mistaken for generic language. Without this reconciliation the new description and the pre-flight rule contradict each other.
- **Behavioral reliability (inherent, partially mitigated).** "start memo capture" is a model-invocation trigger, not a deterministic parse. Research confirms Claude Code uses **semantic matching** (not regex/substring) against the `description` field for auto-invocation — naming the exact phrase there is the correct and only lever. However, community evaluations report auto-invocation success rates around **~53% in complex multi-file sessions** due to context-window degradation: as the conversation grows, system messages and tool logs crowd the `<system-reminder>` block where skill descriptions live, causing the model to miss matches. In short/fresh sessions reliability is higher. This is inherent to the progressive-disclosure architecture and is the best available mechanism — the user's requirement explicitly rules out depending on a slash command. **Mitigation:** the description should lead with the exact trigger phrase ("Enter by saying 'start memo capture'") so it is the most prominent semantic signal.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. All edits are to static text files with no runtime concurrency.
- **Security:** None. No secrets, credentials, or permission surfaces touched.
- **Side Effects:**
  - **Generated-file overwrite (must respect).** `.claude/skills/memo/SKILL.md` and `CLAUDE.md`'s managed block are regenerated by `ClaudeCodeMirrorService` and tracked in `.claude/.switchboard-generated.json`. Hand-edits to them are non-durable. **Action:** edit only the sources, then regenerate.
  - **Description propagation.** The generated skill `description` = source frontmatter `description` (`ClaudeCodeMirrorService.ts:236`). Because `.agents/workflows/memo.md` already ships a frontmatter `description`, editing that line propagates correctly into `.claude/skills/memo/SKILL.md` on regeneration — no `descriptionFallback` involved.
  - **YAML escaping.** The proposed description contains double quotes and colons. `escapeYamlValue` (`ClaudeCodeMirrorService.ts:199-205`) detects `/[:#"']/` and wraps the value via `JSON.stringify()`, producing valid double-quoted YAML in the generated SKILL.md. The source file's unquoted YAML is parsed only by the `parseSource` regex (`ClaudeCodeMirrorService.ts:173`), not a strict YAML parser, so embedded quotes are safe. **Caveat:** if a future edit adds a colon-space (`: `) to the unquoted source description, a real YAML parser would break — but `parseSource` would still work. Low risk; note for future maintainers.
  - **Duplicate managed-block markers in AGENTS.md.** Lines 1-2 and 124-125 each contain duplicate `<!-- switchboard:agents-protocol:start/end -->` markers. `ensureProtocolFile` (`extension.ts:3084-3092`) handles this by collapsing first-start to last-end. Any content edit within the managed block will trigger a "collapsed duplicate markers" update on the next scaffold pass. This is a pre-existing condition, not caused by this plan, and is self-healing.
- **Dependencies & Conflicts:**
  - **Exit semantics unchanged.** The sole exit remains the exact message `process memo`; `edit N:` remains the in-place edit command. This change touches only **entry**. Do not alter exit/append rules.
  - **Embedded-phrase ambiguity (intentional, leave as-is).** The workflow already documents that trigger words inside a longer sentence are *content*, not commands (the "Anti-Example" section, `.agents/workflows/memo.md:18-30`). The new entry trigger should follow the same spirit: "start memo capture" as a clear request to begin (whole-message or unambiguous intent) starts capture; the same words buried mid-sentence while already capturing are appended verbatim. The Process-step wording should say "start memo capture (or a close variant)" without promising exact-match parsing, mirroring how `/memo` is described.
  - **Published-extension propagation (per project migration rule).** ~4,000 installs on older versions. This is **not** a data migration — no state/file/setting format changes, nothing is deleted, and `/memo` still works, so it is fully backward compatible. The new source files reach existing workspaces only when the bundled `.agents/`/`AGENTS.md` refresh fires (`ControlPlaneMigrationService._shouldRefreshAgentVersion`, gated on extension version). **Action:** ensure the change ships under a version bump so the agent-version refresh carries it; no archival/import shim is needed.
  - **Tip is single-source.** The tip string occurs once in `src/` (`src/webview/implementation.html:1592`, inside `#agent-list-memo`). The matching `dist/webview/implementation.html` line is a build artifact — do not hand-edit or flag it (project rule: `dist/` is not used in dev/testing).
  - **Tip honesty.** After this change the tip's promise ("you can also use 'start memo capture' in an agent chat") is backed by a real entry trigger, so the copy is accurate rather than aspirational.

## Dependencies

- `feature_plan_20260624112804_claude-code-native-discovery-mirror.md` — established the `ClaudeCodeMirrorService` mirror pipeline (`.agents/` → `.claude/skills/` + `CLAUDE.md` managed block) that this plan depends on for regeneration. The prior plan's resolution #3 ("keep `start memo capture`") intended this trigger but never carried it through to the source files.
- No session dependencies. No blocking plans.

## Research Findings

Web research was conducted to confirm the Claude Code skill auto-invocation mechanism. Key findings:

1. **CONFIRMED — `description` drives auto-invocation.** The `description` frontmatter field is the primary semantic signal Claude Code uses for model auto-invocation. Claude Code caches only skill metadata (`name` + `description`) into a persistent `<system-reminder>` block at session init (~60 tokens per skill via progressive disclosure). When user prompt intent matches a description, the full `SKILL.md` body is loaded on-demand. This validates the plan's core mechanism: naming "start memo capture" in the `description` field is the correct and only lever for making it a model-invoked trigger.

2. **CONFIRMED — Semantic matching, not keyword parsing.** Claude Code does NOT run regex or exact substring matching on user prompts. The description is evaluated semantically by the model. This means "start memo capture" will match when the user says that phrase, but may also match on close variants like "let's start capturing memos" — and conversely may be missed in crowded context windows. This validates the plan's "close variant" design decision.

3. **CONFIRMED — Hot-reload of SKILL.md mid-session.** Claude Code employs a native file watcher on `.claude/` directory. Changes to `SKILL.md` files are dynamically re-parsed mid-session — no CLI restart needed for skill updates. This simplifies verification: after regeneration, the new description is active immediately in any open Claude Code session.

4. **Reliability caveat — ~53% success in complex sessions.** Community evaluations (Vercel agent evals) report auto-invocation success rates around 53% in complex multi-file sessions due to context-window degradation. In short/fresh sessions reliability is higher. This is inherent to the progressive-disclosure architecture and cannot be fixed at the plan level — it is the tradeoff for host-independent entry without slash commands.

5. **Pre-existing codebase note — `user-invokable` spelling.** Research surfaced a Claude Code bug: the CLI runtime parser looks for `user-invocable` (with a "c"), but the VS Code extension validator flags that spelling and suggests `user-invokable` (with a "k"). The codebase uses `user-invokable` (`ClaudeCodeMirrorService.ts:248`) to avoid VS Code validator warnings, but this means the CLI may silently ignore the field for `no-user` invocation skills. **This is out of scope for this plan** (memo uses `invocation: 'default'`, not `no-user`), but should be tracked as a separate bugfix.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) source-of-truth mis-routing — editing generated files instead of `.agents/` sources, which is the exact failure that prevented the prior directive from sticking; (2) pre-flight rule contradiction — "do not auto-trigger on generic language" vs. a natural-language entry trigger, which must be reconciled by listing the phrase as an explicit recognized trigger; (3) behavioral non-determinism — research confirms `description`-driven semantic auto-invocation works but degrades to ~53% reliability in complex sessions due to context-window crowding; this is the best available mechanism given the user's requirement for host-independent entry. Mitigations: all edits land in the three source files only; the pre-flight rule is reconciled by tying the exception to the registry table; the description leads with the exact trigger phrase for maximum semantic prominence; regeneration path is specified concretely (Node script calling `generateClaudeMirror` + `buildManagedInner`). Low blast radius — purely additive, no state/format changes, `/memo` untouched.

## Proposed Changes

### 1. `.agents/workflows/memo.md` — source of truth for the memo skill (drives Claude Code model-invocation)

**(a) Frontmatter `description` (line 2)** — name the entry phrase so the generated skill description gives the model a signal to fire on. This is the load-bearing edit.

Before (line 2):
```markdown
description: Memo capture mode — append-only, no analysis; exit with `process memo`
```
After (line 2):
```markdown
description: Memo capture mode. Enter by saying "start memo capture" (or the /memo command) in chat; then append-only, no analysis; exit with `process memo`.
```

> **YAML escaping note:** The `parseSource` regex (`ClaudeCodeMirrorService.ts:173`) extracts the full line after `description: `, and `stripQuotes` does not fire (value starts with `M`, ends with `.`). The generated `.claude/skills/memo/SKILL.md` will have the description wrapped in double quotes via `JSON.stringify()` (because `escapeYamlValue` detects `"` and `:`), producing valid YAML. No manual escaping needed.

**(b) Process step #1 (line 33)** — recognize the natural-language entry alongside `/memo`.

Before (line 33):
```markdown
1. **Initialize:** On `/memo`, read `.switchboard/memo.md` (create if absent). Write out the FULL current memo as a numbered list (one number per blank-line-separated entry), then state the total count. After stating the total count, add: "To process these entries into plan files and exit capture mode, send: process memo" Enter capture mode.
```
After (line 33):
```markdown
1. **Initialize:** On `/memo` — or when the user asks to **start memo capture** (that phrase or a close variant, as a request to begin) — read `.switchboard/memo.md` (create if absent). Write out the FULL current memo as a numbered list (one number per blank-line-separated entry), then state the total count. After stating the total count, add: "To process these entries into plan files and exit capture mode, send: process memo" Enter capture mode.
```

**(c) Add a short "Entering Capture Mode" note** — insert a new section between the title (line 5) and the intro paragraph (line 7), stating both entry paths and *why* the phrase exists:

```markdown
## Entering Capture Mode

There are two ways to enter Memo Capture Mode:
1. **Slash command:** Send `/memo` in chat (available in hosts that support custom slash commands).
2. **Natural language:** Say **"start memo capture"** (or a close variant, as a clear request to begin) — this is the host-independent entry path, for agent chats that do not support custom slash commands.

Both paths initialize capture mode identically. The sole exit remains the exact command `process memo`.
```

Insert this after line 5 (`# Memo Capture Mode`) and before line 7 (the `You are in Memo Capture Mode` intro paragraph). The existing intro paragraph and all subsequent content (Hard Rules, Anti-Example, Process, etc.) remain unchanged.

### 2. `AGENTS.md` — shipped source that regenerates `CLAUDE.md`

**(a) Workflow Registry row (line 22)** — add the phrase to the Trigger Words column and update the Description column.

Before (line 22):
```markdown
| `/memo` | **`memo.md`** | Memo capture mode — append-only, no analysis. Exit with `process memo`. Edit entries with `edit N: <text>`. |
```
After (line 22):
```markdown
| `/memo`, "start memo capture" | **`memo.md`** | Memo capture mode — append-only, no analysis. Enter via `/memo` or by saying "start memo capture". Exit with `process memo`. Edit entries with `edit N: <text>`. |
```

**(b) Skills table row (line 92)** — update the "When to Use" description.

Before (line 92):
```markdown
| `memo` | User invokes `/memo` to enter progressive capture mode — agent appends each user message to `.switchboard/memo.md` without analysis. |
```
After (line 92):
```markdown
| `memo` | User invokes `/memo` **or says "start memo capture"** to enter progressive capture mode — agent appends each user message to `.switchboard/memo.md` without analysis. |
```

**(c) Memo Priority Rule paragraph (line 101)** — add one sentence noting the natural-language entry path.

Insert after the first sentence of the priority rule paragraph (after "...takes precedence over the default "analyze and act" behavior."):

```markdown
Capture mode is entered by `/memo` **or the natural-language request "start memo capture"** (host-independent, for chats without slash commands).
```

**(d) Reconcile the pre-flight rule (lines 29-30)** — tie the "generic language" exception to the registry table.

Before (line 30):
```markdown
2. **Do not auto-trigger on generic language** (for example: "review this", "delegate this", "quick start") unless the user explicitly asks to run that workflow.
```
After (line 30):
```markdown
2. **Do not auto-trigger on generic language** (for example: "review this", "delegate this", "quick start") unless the user explicitly asks to run that workflow **or uses a recognized natural-language trigger listed in the table above** (e.g. "start memo capture").
```

### 3. `src/webview/implementation.html` — the Memo sub-tab tip (user's exact wording)

In the `#agent-list-memo` block (line 1592), replace the tip text node:

Before (line 1592):
```html
                        Tip: use the /memo skill to start memo capture.
```
After (line 1592):
```html
                        Tip: you can also use 'start memo capture' in an agent chat.
```

Only the text changes; the `<p>` element and inline styles (line 1591) are untouched. Reference by string, not line number — the surrounding file shifts.

### 4. Regenerate the generated layer (do NOT hand-edit these)

After editing the sources, regenerate so `.claude/skills/memo/SKILL.md` and the `CLAUDE.md` managed block pick up the new description/registry. **Concrete regeneration method:**

Write a temporary Node script (e.g. `scripts/regen-claude-mirror.js`) that:
1. Imports `generateClaudeMirror` and `buildManagedInner`, `CLAUDE_BLOCK_START`, `CLAUDE_BLOCK_END`, `CLAUDE_PREAMBLE` from `src/services/ClaudeCodeMirrorService.ts` (compile first or use `ts-node`/`tsx`).
2. Calls `generateClaudeMirror(repoRoot, extensionVersion)` to regenerate `.claude/skills/memo/SKILL.md`.
3. Reads the updated `AGENTS.md`, calls `buildManagedInner(source, CLAUDE_PREAMBLE)`, wraps with `CLAUDE_BLOCK_START` / `CLAUDE_BLOCK_END`, and writes the managed block back into `CLAUDE.md` (replacing the existing block between markers).
4. Deletes the temporary script after use.

Alternatively, launch VS Code with the Switchboard extension installed and open the repo — `scaffoldProtocolLayers` (`extension.ts:3204`) runs on activation and calls both `ensureClaudeProtocol` (updates CLAUDE.md managed block in-place) and `generateClaudeMirror` (regenerates `.claude/skills/`).

**Verification after regeneration:**
- `.claude/skills/memo/SKILL.md` frontmatter `description` matches the new source description (escaped via `JSON.stringify` — double-quoted with inner quotes escaped).
- `CLAUDE.md` managed block (lines 22-156) matches `AGENTS.md` content (with the Claude preamble prepended).
- No hand-edits left in generated files.

## Verification Plan

### Automated Tests

No automated tests are applicable. This plan touches only documentation, skill metadata (YAML frontmatter), and a single HTML text string — there is no runtime logic, state machine, or data path to test programmatically. The `ClaudeCodeMirrorService` generation pipeline is exercised by its existing test coverage; the only new assertion would be that `parseSource` correctly extracts the updated description string, which is a trivial regex match already covered by the function's existing behavior.

### Manual Verification

1. **Source edits present.** `.agents/workflows/memo.md` frontmatter `description` (line 2) and Process step #1 (line 33) both name "start memo capture"; the new "Entering Capture Mode" section is inserted after line 5. `AGENTS.md` registry row (line 22), skills row (line 92), priority rule (line 101), and pre-flight rule (line 30) all reference it. `grep -rni "start memo capture"` now returns the workflow, `AGENTS.md`, the (regenerated) `CLAUDE.md` + `.claude/skills/memo/SKILL.md`, and the tip — not the tip alone.
2. **Generated layer matches source.** Regenerate, then confirm `.claude/skills/memo/SKILL.md` frontmatter `description` equals the new source description (YAML-escaped), and the `CLAUDE.md` managed block (lines 22 / 53 / 123 / 130 / 132) matches `AGENTS.md`. No hand-edits left in generated files.
3. **No stale `/memo`-only language.** Confirm no source surface still presents `/memo` as the *only* way into capture mode (registry, skills table, priority rule, tip).
4. **Trigger behavior (manual, installed VSIX).** In a Claude Code agent chat with the scaffolded skills, send "start memo capture" as a whole message → the agent enters Memo Capture mode (replies `[MEMO CAPTURE ACTIVE]`, echoes the memo list, advises `process memo`). Then confirm `/memo` still enters capture mode, and `process memo` still exits and produces one plan per entry. Confirm a mid-sentence occurrence of the phrase while already capturing is appended as content, not re-triggered. **Note:** Claude Code hot-reloads `SKILL.md` changes mid-session via its file watcher, so no CLI restart is needed after regeneration — the new description is active immediately. Test in a **fresh/short session** first (research shows ~53% auto-invocation reliability in complex multi-file sessions due to context-window degradation; reliability is higher in short sessions).
5. **Tip render.** Open the sidebar → Agents panel → Memo sub-tab; the tip reads `Tip: you can also use 'start memo capture' in an agent chat.`, wraps cleanly above the textarea, with the single quotes rendering literally and no markup breakage.
6. **Backward compatibility.** Confirm the sidebar Memo tab append path and the `/memo` path are unchanged, and that no persisted state/format was touched (pure docs/metadata + one HTML string).

---

**Recommendation:** Complexity is 4/10 → **Send to Coder**.

## Reviewer Pass (2026-06-25)

### Stage 1 — Grumpy Principal Engineer

*Alright, let me see what passes for "done" around here.*

**Source-of-truth routing.** I'll give credit where it's due — the edits landed in `.agents/workflows/memo.md` and `AGENTS.md`, NOT in the generated `.claude/skills/memo/SKILL.md` or `CLAUDE.md` by hand. The one failure mode that killed every prior attempt at this directive, and you actually dodged it. The generated layer was regenerated and matches the source byte-for-byte (verified via `diff`). Fine. You get one gold star. Don't let it go to your head.

**The frontmatter description.** `.agents/workflows/memo.md:2` — the load-bearing edit. The description now leads with "Enter by saying \"start memo capture\"" which is exactly the semantic prominence the research said was needed. The generated `SKILL.md:3` has it YAML-escaped via `JSON.stringify()` (double-quoted, inner quotes escaped). I checked `escapeYamlValue` at `ClaudeCodeMirrorService.ts:199-205` — it detects `"` and `:` and wraps correctly. The escaping is right. Moving on.

**Process step #1.** `.agents/workflows/memo.md:41` — "On `/memo` — or when the user asks to **start memo capture** (that phrase or a close variant, as a request to begin)". Good. The "close variant" hedge is deliberate and matches the plan's design decision. The model-invoked nature is documented, not pretending to be a regex.

**"Entering Capture Mode" section.** Inserted at `.agents/workflows/memo.md:7-13`, right after the title and before the intro paragraph. Both entry paths documented, exit semantics restated. Clean insertion, no surrounding content displaced.

**AGENTS.md — all four surfaces.**
- Registry row (line 22): trigger words column now reads `/memo`, "start memo capture". Description updated. ✅
- Pre-flight rule (line 30): the "do not auto-trigger on generic language" clause now has the exception "or uses a recognized natural-language trigger listed in the table above (e.g. \"start memo capture\")". This is the reconciliation the plan demanded — without it, the pre-flight rule and the new description would contradict each other. ✅
- Skills table (line 92): "User invokes `/memo` or says \"start memo capture\"". ✅
- Priority rule (line 101): "Capture mode is entered by `/memo` or the natural-language request \"start memo capture\"". ✅

**CLAUDE.md managed block.** Matches AGENTS.md content exactly (verified via `diff` — the only delta is the outer `claude-protocol:end` wrapper, which is expected). The Claude preamble is prepended correctly. ✅

**Tip text.** `src/webview/implementation.html:1592` — "Tip: you can also use 'start memo capture' in an agent chat." Exact wording from the plan. The `<p>` element and inline styles are untouched. ✅

**No stale `/memo`-only language.** I searched every source surface. The only remaining "use the /memo skill to start" string is in THIS plan file (the "Before" examples). `setup.html:559` mentions `/memo` as a slash command example — that's describing what Claude Code generates, not the only entry path, so it's fine. `ClaudeCodeMirrorService.ts:133` lists `/memo` in the Claude preamble as a slash command example — also fine. No source surface presents `/memo` as the *only* way in. ✅

**Now the nits.** And I do mean nits, because you actually did the work right.

**NIT-1:** `.agents/workflows/memo.md:20` — Hard Rule #3 says "on `/memo` entry" when describing when reading `.switchboard/memo.md` is permitted. Entry can now also happen via "start memo capture", so this is technically stale. But Hard Rule #3 is about *read permissions*, not entry triggers, and Process step #1 (line 41) is the authoritative entry procedure. Behavior is unaffected. The plan didn't scope this edit. Leave it or fix it — it's cosmetic.

**NIT-2:** The regeneration propagated AGENTS.md's pre-existing duplicate `<!-- switchboard:agents-protocol:start/end -->` markers into CLAUDE.md (lines 33-34 and 156-157). Before this change, CLAUDE.md had single markers; after, it has duplicates. The plan explicitly documented this as a pre-existing condition in AGENTS.md and said `ensureProtocolFile` handles it by collapsing first-start to last-end. Functionally harmless — the collapse logic treats everything between the first `start` and the last `end` as the managed block, so the content is correct. It's just cosmetically messier than before. Self-healing on the next scaffold pass.

**Verdict:** No CRITICAL findings. No MAJOR findings. Two NITs, both cosmetic, neither affecting behavior. The implementation matches the plan specification exactly across all five files. Ship it.

### Stage 2 — Balanced Synthesis

**Keep (no changes needed):**
- All source-of-truth edits (`.agents/workflows/memo.md` frontmatter, Process step, Entering Capture Mode section) — correct and complete.
- All `AGENTS.md` surfaces (registry, pre-flight rule, skills table, priority rule) — correctly reconciled.
- Generated layer (`.claude/skills/memo/SKILL.md`, `CLAUDE.md` managed block) — faithfully regenerated, YAML escaping correct.
- Tip text in `src/webview/implementation.html` — exact user wording, no markup breakage.

**Fix now:** None. No CRITICAL or MAJOR findings to fix.

**Defer (optional, cosmetic):**
- NIT-1: Hard Rule #3 "on `/memo` entry" → could generalize to "on entry" in a future pass. Not scoped by this plan; behavior unaffected.
- NIT-2: Duplicate markers in CLAUDE.md — self-healing on next scaffold pass via `ensureProtocolFile` collapse logic. No action needed.

### Code Fixes Applied

None. No valid CRITICAL or MAJOR findings to fix.

### Validation Results

- **Source-to-generated body diff:** `diff <(tail -n +5 .agents/workflows/memo.md) <(tail -n +6 .claude/skills/memo/SKILL.md)` → exit code 0 (identical). ✅
- **AGENTS.md-to-CLAUDE.md managed block diff:** `diff <(tail -n +1 AGENTS.md) <(sed -n '33,158p' CLAUDE.md)` → only delta is the outer `claude-protocol:end` wrapper (expected). ✅
- **YAML escaping:** Generated `description` is double-quoted with inner `\"` escaping, matching `escapeYamlValue`'s `JSON.stringify()` behavior for values containing `"` and `:`. ✅
- **No stale `/memo`-only language:** `grep` across `src/` and `.agents/` confirms no source surface presents `/memo` as the sole entry path. ✅
- **Tip text:** `src/webview/implementation.html:1592` matches the plan's exact proposed wording. ✅
- **Compilation/tests:** Skipped per review instructions (pre-compiled state; tests run separately by user).

### Files Changed (by implementation, commit 7ac4b01)

| File | Role | Change |
|------|------|--------|
| `.agents/workflows/memo.md` | Source of truth | Frontmatter description, Process step #1, new "Entering Capture Mode" section |
| `AGENTS.md` | Shipped source | Registry row, pre-flight rule, skills table, priority rule |
| `src/webview/implementation.html` | UI tip | Line 1592 tip text |
| `.claude/skills/memo/SKILL.md` | Generated (regenerated) | Mirrors `.agents/workflows/memo.md` |
| `CLAUDE.md` | Generated (regenerated) | Managed block mirrors `AGENTS.md` |

### Remaining Risks

1. **Behavioral non-determinism (inherent, documented).** "start memo capture" is a model-invocation trigger via semantic matching against the skill `description`, not a deterministic parse. Research confirms ~53% auto-invocation reliability in complex multi-file sessions due to context-window degradation; higher in short/fresh sessions. This is the best available mechanism for host-independent entry. No code-level fix possible.
2. **NIT-1 (deferred):** Hard Rule #3's "on `/memo` entry" reference is technically stale but behaviorally harmless.
3. **NIT-2 (self-healing):** Duplicate managed-block markers in CLAUDE.md will collapse on the next `ensureProtocolFile` scaffold pass.
