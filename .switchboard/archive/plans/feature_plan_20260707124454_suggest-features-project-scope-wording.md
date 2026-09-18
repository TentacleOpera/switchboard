# Fix: Suggest Features prompt — project-scope section is wildly over-worded

**Plan ID:** a1b2c3d4-0005-4a05-9f05-suggestscope0005

## Goal

Rewrite the "Determine project scope" section of the Suggest Features prompt so it says in ~10 words what it currently says in ~100. When a project is injected, the prompt should simply say "filter by project X". When no project is injected, it should simply say "ignore all plans with projects". Eliminate the verbose explanation of every filter-state combination.

### Problem / background / root cause

The Suggest Features button copies the `group-into-features` skill text into the clipboard (`KanbanProvider._buildSuggestFeaturesPrompt`, `KanbanProvider.ts:10951-10991`), substituting `{{WORKSPACE_ROOT}}` and `{{ACTIVE_PROJECT_FILTER}}`. The skill's section "1a. DETERMINE PROJECT SCOPE" (`.agents/skills/group-into-features/SKILL.md:38-58`) is ~100 words explaining three filter states with examples:

```
### 1a. DETERMINE PROJECT SCOPE

The active project filter is injected as `{{ACTIVE_PROJECT_FILTER}}` when
invoked from the **Suggest Features** board button. This may be:
- A specific project name (e.g. `Remote sync`)
- `__unassigned__` (user is viewing plans with no project)
- Empty / unset / the literal placeholder token (no filter active, OR the
  skill was loaded directly without the button — include ALL plans)

If the filter is a specific project, skip plans whose `project:"..."` tag
does not match. If the filter is `__unassigned__`, skip plans that HAVE a
`project:"..."` tag (only untagged plans are candidates). If the filter is
empty/unset/the literal placeholder, include all plans (current behavior).

Plans with NO `project:` tag are unassigned and match the `__unassigned__`
filter; they are excluded from a specific-project filter.

Example filtering:
- Filter = `Remote sync` → only plans with `project:"Remote sync"` are candidates
- Filter = `__unassigned__` → only plans with NO `project:` tag are candidates
- Filter = empty / `{{ACTIVE_PROJECT_FILTER}}` → all plans are candidates
```

This is needlessly verbose. The user's request is unambiguous: if a project is injected, say "filter by project <X>"; if none is injected, say "ignore all plans with projects". The three-state enumeration, the placeholder-token explanation, and the worked examples are redundant — the agent can infer the `__unassigned__` case from the same logic. ~100 words where ~10 would do.

**Root cause:** the section was written defensively to cover every edge case in prose, instead of stating the rule once and trusting the agent to apply it. The `{{ACTIVE_PROJECT_FILTER}}` substitution already carries the value (or empty), so the prompt can branch on that value with a one-line directive.

## Metadata

**Tags:** prompt, suggest-features, bugfix, wording
**Complexity:** 2

## User Review Required

No — this is a pure wording rewrite of a single skill-file section (`group-into-features/SKILL.md` section 1a). No code changes, no architectural decisions, no DB or config impact. The user may optionally review the ~35-word replacement for clarity. The `__unassigned__` semantics collapse is the only subtlety — verified correct (untagged plans ARE unassigned, so the "no project name injected" branch correctly includes them).

## Complexity Audit

### Routine
- Rewriting section 1a of `.agents/skills/group-into-features/SKILL.md` to a 2-3 line directive.
- The `_buildSuggestFeaturesPrompt` substitution (`KanbanProvider.ts:10987-10990`) already injects `{{ACTIVE_PROJECT_FILTER}}` — no code change needed. The new wording just uses the injected value directly.
- The embedded fallback prompt in `_buildSuggestFeaturesPrompt` (`KanbanProvider.ts:10961-10981`) does NOT contain a project-scope section, so it needs no change.

### Complex / Risky
- **Preserving the `__unassigned__` semantics.** The current prose explicitly handles the "viewing unassigned plans" filter (`__unassigned__`). The terse rewrite must still produce correct behaviour for that case. The cleanest approach: have the prompt branch on the injected value — if a real project name is present, say "filter by project X"; if the value is empty/`__unassigned__`/the literal placeholder, say "ignore all plans with a project tag" (i.e. only untagged/all). This collapses the three states into two directives that the agent applies correctly. Verify the `__unassigned__` token is still handled (it is a real value the button can inject — `KanbanDatabase.UNASSIGNED_PROJECT_FILTER`).
- **Agent comprehension.** A terse directive must be unambiguous. State the rule as an instruction, not a description. Avoid the placeholder-token meta-discussion (the agent sees the substituted value, never the raw `{{...}}`).
- **Published extension** — the SKILL.md ships inside the extension's `.agents/skills/` and is also read from the workspace's `.agents/skills/group-into-features/SKILL.md` at runtime (`KanbanProvider.ts:10952`). Editing the workspace file updates the behaviour immediately for the user; updating the shipped copy in the repo updates it for the next VSIX build. Both should be kept in sync (they are the same file in this repo).

## Edge-Case & Dependency Audit

- **`{{ACTIVE_PROJECT_FILTER}}` substitution.** `_buildSuggestFeaturesPrompt` replaces `{{ACTIVE_PROJECT_FILTER}}` with `projectFilter ?? ''` (`KanbanProvider.ts:10987-10990`). When no filter is active, the value is empty string. When the unassigned filter is active, the value is `__unassigned__`. When a specific project is active, the value is the project name. The new wording must read correctly for all three substituted values.
- **Skill loaded directly (not via button).** If an agent loads the skill directly (not via the button), `{{ACTIVE_PROJECT_FILTER}}` is NOT substituted — the literal token remains in the text. The current prose handles this ("the literal placeholder token ... include ALL plans"). The terse rewrite must still make sense when the literal token is present. Recommended: phrase the directive so the "no project injected" branch covers the literal-placeholder case too (e.g. "If no project name is injected above, ignore all plans with a project tag." — the literal `{{ACTIVE_PROJECT_FILTER}}` token is not a project name, so it falls into this branch naturally).
- **Dependencies** — Issue 1's plan edits the same SKILL.md but only the SCAN step's `cat` target (unchanged path). This plan edits section 1a. No conflict — different sections of the same file. Coordinate so both edits land.
- **No code change to `KanbanProvider.ts`** — the substitution machinery is unchanged; only the skill text changes.

## Dependencies

None — standalone prompt-wording fix. The board-snapshot-staleness plan (same feature) edits the same `group-into-features/SKILL.md` file but a different section (the SCAN step's `cat` target vs section 1a) — no conflict. Coordinate so both edits land on the same file. No dependency on the create-feature-skill or feature-creation-must-use-skill plans.

## Adversarial Synthesis

Key risk: the `__unassigned__` case is handled implicitly — it falls into the "no project name injected" branch because `__unassigned__` is not a project name, so only untagged plans are candidates. This is correct (untagged plans ARE unassigned) but fragile; a one-line comment in the SKILL.md noting that `__unassigned__` is not a project name would make the logic self-documenting. No other risks; the `{{ACTIVE_PROJECT_FILTER}}` substitution machinery at `KanbanProvider.ts:10987-10990` is verified correct, and the embedded fallback prompt (`KanbanProvider.ts:10961-10981`) contains no project-scope section and needs no change. Complexity 2 — routine single-file text edit.

## Proposed Changes

### 1. `.agents/skills/group-into-features/SKILL.md` — rewrite section 1a

Replace the entire "### 1a. DETERMINE PROJECT SCOPE" block (`SKILL.md:38-58`) with a terse directive:

```markdown
### 1a. PROJECT SCOPE

The active project filter is injected above as `{{ACTIVE_PROJECT_FILTER}}`.

- If a project name is injected: only consider plans tagged `project:"<that name>"`.
- If no project name is injected (empty, `__unassigned__`, or the literal placeholder): ignore all plans that have a `project:"..."` tag — only untagged plans are candidates.
```

This is ~35 words (down from ~100), states the rule as two directives, and correctly handles all three substituted values (real name → first branch; empty / `__unassigned__` / literal `{{ACTIVE_PROJECT_FILTER}}` → second branch, since none of those is a project name).

### 2. (Optional) Tighten the SCAN step reference

The SCAN step (`SKILL.md:15-36`) already says "Scope: CREATED and PLAN REVIEWED columns only." That is fine. No change required — only section 1a is verbose.

### 3. No code change

`KanbanProvider._buildSuggestFeaturesPrompt` (`KanbanProvider.ts:10951-10991`) is unchanged — it already strips YAML frontmatter and substitutes both placeholders. The new section 1a text flows through the same path.

## Verification Plan

> **Session directive:** Compilation and automated tests are SKIPPED per session directives (SKIP COMPILATION, SKIP TESTS). All verification below is manual — no build or test step is required for this plan (pure skill-text edit).

1. **Word count:** Confirm the new section 1a is ≤40 words (down from ~100).
2. **Manual — project injected:**
   - On the kanban board, set the active project filter to a real project (e.g. "Remote sync").
   - Click **Suggest Features**; paste the clipboard into a chat agent.
   - Confirm the prompt's project-scope directive says to filter by that project name (first branch), and the agent only groups plans tagged with that project.
3. **Manual — no project:**
   - Clear the active project filter (or set to All Projects).
   - Click **Suggest Features**; paste into an agent.
   - Confirm the directive says to ignore plans with a project tag (second branch), and the agent only groups untagged plans.
4. **Manual — unassigned filter:**
   - Set the active project filter to "Unassigned" (`__unassigned__`).
   - Click **Suggest Features**; paste into an agent.
   - Confirm the directive falls into the second branch (ignore tagged plans) — untagged plans only.
5. **Skill loaded directly:** Open `.agents/skills/group-into-features/SKILL.md` directly (not via the button) so `{{ACTIVE_PROJECT_FILTER}}` stays as the literal token. Confirm the directive still reads sensibly — the literal token is not a project name, so the second branch applies (ignore tagged plans).
6. **No regression on the rest of the flow:** Confirm SCAN/READ/PROPOSE/CONFIRM/EXECUTE/BACKLOG steps are unchanged and the prompt still produces correct feature groupings.

---

**Recommendation:** Complexity 2 (Low) → **Send to Intern.** Single-file text rewrite (~100 words → ~35 words). No code, no DB, no config. The only subtlety is the `__unassigned__` semantics collapse — verified correct, but a one-line comment in the SKILL.md would make it self-documenting.

**Stage Complete:** PLAN REVIEWED
**Stage Complete:** CODER CODED

## Review Findings

Reviewed commit `8949e07` against plan requirements. Section 1a of `group-into-features/SKILL.md` was rewritten from ~100 words to ~35 words, collapsing three filter-state descriptions into two terse directives. The new wording correctly handles all substituted values: real project name → first branch; empty/`__unassigned__`/literal `{{ACTIVE_PROJECT_FILTER}}` → second branch (none is a project name). The `create-feature-from-plans` cross-reference was also added to the "When to Use" section (from Plan 1). No CRITICAL or MAJOR findings. One NIT: "injected above as" is slightly misleading since `{{ACTIVE_PROJECT_FILTER}}` appears in the same sentence, not above — but the agent sees the substituted value and understands. No code fixes needed. No code changes (pure skill-text edit).

**Stage Complete:** CODE REVIEWED
