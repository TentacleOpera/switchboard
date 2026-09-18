# Bump markdown preview body text +1pt in planning, design, and project views

## Goal

The body text (paragraphs and list items) rendered inside the markdown preview panes of `planning.html`, `design.html`, and `project.html` is slightly too small — it reads as smaller than even terminal text, making plan/constitution/kanban content hard to read. The base font-size for these preview containers is `13px`; it should be bumped up one point to `14px`.

### Problem analysis & root cause

All three webview HTML files declare a "Unified Markdown Preview Styling" block that sets a single base `font-size: 13px` on the markdown preview container. Body-level elements (`p`, `li`) inherit this base via `font-size: inherit`, and headings (`h1`–`h6`) are sized in `em` units relative to this same base. There is no separate paragraph font-size override — the entire body-text scale is anchored to the container's `13px`.

At `13px` in a VS Code webview (which renders at device pixel ratios that often make 13px appear smaller than the editor's own ~14px terminal/editor font), the preview body text ends up visually smaller than the surrounding terminal and editor chrome, hurting readability.

**Root cause:** The base font-size constant (`13px`) chosen for the markdown preview containers is one point too small relative to the editor/terminal baseline the user reads alongside.

**Fix:** Change the container base from `13px` → `14px` in all three files. Because headings and body text both derive from this base (via `em` and `inherit` respectively), a single one-line change per file lifts the entire readable scale by one point while preserving all relative proportions.

## Metadata

- **Tags:** `frontend`, `ui`, `ux`
- **Complexity:** 2/10
- **Files touched:** 3 (`src/webview/planning.html`, `src/webview/design.html`, `src/webview/project.html`)
- **Risk:** Very low — pure CSS font-size bump, no logic/data changes.

## User Review Required

No user review required before implementation. The change is a non-breaking visual refinement scoped to three CSS values and their accompanying comments. No data, state, migrations, or user-facing behavior changes beyond typography. Proceed directly.

## Complexity Audit

### Routine
- Three single-line CSS value changes (`font-size: 13px` → `font-size: 14px`), one per file, at verified line numbers (planning.html:1022, design.html:1022, project.html:847).
- Updating inline comments that hard-reference the old `13px` base (4 comments per file, verified).
- No conditional branches, no JS logic, no state, no migrations.
- Headings (`em`), body text (`inherit`), and inline code (`0.85em`, verified at planning.html:1144, design.html:1155, project.html:972) all cascade from the single base — no per-element overrides needed.

### Complex / Risky
- None. The only subtlety is ensuring all three files are updated consistently so preview typography stays uniform across views, and that the comment sweep does not accidentally touch unrelated `13px` values elsewhere in the files (planning.html alone has ~22 total `13px` references, only 5 of which are in scope).

## Edge-Case & Dependency Audit

**Race Conditions:** None. CSS is static; no runtime mutation, no JS reads or computes against `13px`. Confirmed by grep — no `fontSize`/`13` references in webview JS that bind to these containers.

**Security:** None. No user input handling, no template injection surface, no CSP changes. Pure stylesheet value change.

**Side Effects:**
1. **Heading scaling.** Headings use `em` units relative to the container base. Bumping `13px → 14px` proportionally scales all headings:
   - h1: 26px → 28px
   - h2: 19.5px → 21px
   - h3: 16.25px → 17.5px
   - h4: 13px → 14px (equals new body size)
   - h5: ~11.4px → ~12.25px
   - h6: ~11.05px → ~11.9px
   This is desirable — keeping headings on the same base preserves the visual hierarchy ratio.
2. **Inline code / code blocks.** Inline `code` uses `font-size: 0.85em` (verified at planning.html:1144, design.html:1155, project.html:972); code blocks (`pre code`) inherit. Both scale proportionally with the base bump — no separate change required.
3. **Theme variants (cyber-theme, claudify).** These themes override heading font-family/color/letter-spacing but do **not** override the container base `font-size`. They inherit the new `14px` base automatically. Verified: no `font-size` override on `#markdown-preview*` or `#kanban-preview-content*` under `.cyber-theme-enabled` or `.theme-claudify` selectors.

**Dependencies & Conflicts:**
- **Stale comments.** Several inline comments hardcode "13px base" (e.g. `/* 2em relative to 13px base = 26px */`, `/* Inherits from container's 13px */`). These must be updated to `14px` to avoid misleading future readers. This is the bulk of the per-file edits. Verified locations: planning.html lines 1071, 1085, 1120, 1155; design.html lines 1076, 1091, 1128, 1167; project.html lines 896, 910, 948, 983.
- **Other webview files.** `kanban.html` also has markdown preview styling (9 `font-size: 13px` matches) but was not named in the issue. It is out of scope — leaving it at `13px` would create an inconsistency, but the user explicitly scoped this to planning/design/project. (See Verification Plan for a note on optional follow-up.)
- **`dist/` not relevant.** Per project rules, `dist/` is not used during dev/testing; `src/` is the source of truth. No `dist/` audit needed.

## Dependencies

None. This plan is self-contained and depends on no other plan or session.

## Adversarial Synthesis

Key risks: (1) the comment sweep could accidentally touch unrelated `13px` values outside the preview block (planning.html has ~22 total `13px` references, only 5 in scope); (2) the three files could drift if updated inconsistently. Mitigations: scope verification greps to the preview-block line ranges and the specific stale-comment strings rather than a blanket `13px` search; update all three files in one pass with the exact line numbers listed in Proposed Changes.

## Proposed Changes

### File 1: `src/webview/planning.html`

**Change A — container base font-size (line ~1022):**

```css
/* BEFORE */
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets,
#kanban-preview-pane {
    ...
    font-family: var(--font-family);
    font-size: 13px;
    line-height: 1.5;
    ...
}

/* AFTER */
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets,
#kanban-preview-pane {
    ...
    font-family: var(--font-family);
    font-size: 14px;
    line-height: 1.5;
    ...
}
```

**Change B — update stale `13px` comments** on heading/paragraph rules to reference `14px` (verified line numbers):
- Line 1071, h1 comment: `/* 2em relative to 13px base = 26px */` → `/* 2em relative to 14px base = 28px */`
- Line 1085, h2 comment: `/* 1.5em relative to 13px base = 19.5px */` → `/* 1.5em relative to 14px base = 21px */`
- Line 1120, h3 comment: `/* 1.25em relative to 13px base = 16.25px */` → `/* 1.25em relative to 14px base = 17.5px */`
- Line 1155, `p` rule comment: `/* Inherits from container's 13px */` → `/* Inherits from container's 14px */`

### File 2: `src/webview/design.html`

**Change A — container base font-size (line ~1022):**

```css
/* BEFORE */
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets,
#markdown-preview-briefs,
#kanban-preview-pane {
    ...
    font-family: var(--font-family);
    font-size: 13px;
    ...
}

/* AFTER */
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets,
#markdown-preview-briefs,
#kanban-preview-pane {
    ...
    font-family: var(--font-family);
    font-size: 14px;
    ...
}
```

**Change B — update stale `13px` comments** (verified line numbers, same set as planning.html):
- Line 1076, h1 comment: `/* 2em relative to 13px base = 26px */` → `/* 2em relative to 14px base = 28px */`
- Line 1091, h2 comment: `/* 1.5em relative to 13px base = 19.5px */` → `/* 1.5em relative to 14px base = 21px */`
- Line 1128, h3 comment: `/* 1.25em relative to 13px base = 16.25px */` → `/* 1.25em relative to 14px base = 17.5px */`
- Line 1167, `p` rule comment: `/* Inherits from container's 13px */` → `/* Inherits from container's 14px */`

### File 3: `src/webview/project.html`

**Change A — container base font-size (line ~847):**

```css
/* BEFORE */
#kanban-preview-content,
#epics-preview-content,
#constitution-preview-content,
#system-preview-content,
#tuning-preview-content {
    ...
    font-family: var(--font-family);
    font-size: 13px;
    line-height: 1.5;
    ...
}

/* AFTER */
#kanban-preview-content,
#epics-preview-content,
#constitution-preview-content,
#system-preview-content,
#tuning-preview-content {
    ...
    font-family: var(--font-family);
    font-size: 14px;
    line-height: 1.5;
    ...
}
```

**Change B — update stale `13px` comments** on the heading `em` rules (verified line numbers):
- Line 896, h1 comment: `/* 2em relative to 13px base = 26px */` → `/* 2em relative to 14px base = 28px */`
- Line 910, h2 comment: `/* 1.5em relative to 13px base = 19.5px */` → `/* 1.5em relative to 14px base = 21px */`
- Line 948, h3 comment: `/* 1.25em relative to 13px base = 16.25px */` → `/* 1.25em relative to 14px base = 17.5px */`
- Line 983, `p` rule comment: `/* Inherits from container's 13px */` → `/* Inherits from container's 14px */`

## Verification Plan

### Automated Tests

No automated tests run as part of this session (per session directive — the test suite will be run separately by the user). This change is pure CSS with no logic surface, so unit/integration tests would not exercise it meaningfully; visual verification via installed VSIX is the appropriate check.

### Static Verification (grep, scoped to preview blocks)

1. **No stale `13px base` comments remain** (scoped to the exact stale-comment strings, not a blanket `13px` search, to avoid noise from unrelated `13px` values):
   ```
   grep -n "relative to 13px base\|Inherits from container's 13px" src/webview/planning.html src/webview/design.html src/webview/project.html
   ```
   Expect zero matches.

2. **New `14px` comments present** (one per stale-comment location, 4 per file = 12 total):
   ```
   grep -n "relative to 14px base\|Inherits from container's 14px" src/webview/planning.html src/webview/design.html src/webview/project.html
   ```
   Expect 12 matches.

3. **Container base bumped** (exactly one `font-size: 14px` in each file's markdown-preview container block):
   ```
   grep -n "font-size: 14px" src/webview/planning.html src/webview/design.html src/webview/project.html
   ```
   Confirm at least one match per file inside the preview container block (planning.html:1022, design.html:1022, project.html:847). Note: other unrelated `14px` values may exist elsewhere; this check confirms the container block specifically.

4. **Out-of-scope `13px` values untouched.** The blanket grep below should still return the same unrelated matches as before the change (excluding the 5 in-scope matches per file that were converted). If the count drops by more than 5 in any file, an implementer accidentally touched unrelated values:
   ```
   grep -c "13px" src/webview/planning.html src/webview/design.html src/webview/project.html
   ```
   Pre-change total counts (verified): planning.html 22, design.html 22, project.html 6. In-scope per file: 5 (1 container + 4 comments). Post-change expected totals: planning.html 17, design.html 17, project.html 1. All remaining `13px` references are unrelated to the markdown preview block and must remain.

### Manual Visual Verification (via installed VSIX)

5. **Visual verification (manual, via installed VSIX):**
   - Open the Planning view → select a plan → confirm body text in the markdown preview is visibly larger and now reads at least as large as terminal text.
   - Open the Design view → select a design doc / brief → confirm same.
   - Open the Project view → select a kanban plan / constitution / tuning doc → confirm same.
   - Toggle the cyber theme and claudify theme on each view → confirm headings scaled proportionally and no layout breakage.

6. **No build step required for dev verification** — `src/` is the source of truth per project rules. `npm run compile` is only needed when producing a release VSIX.

7. **Optional follow-up (out of scope, flag only):** `src/webview/kanban.html` was not named in the issue but has 9 `font-size: 13px` matches. If the user wants fully uniform typography across all markdown previews, a separate follow-up can align it. Do not touch it in this plan.

## Recommendation

Complexity 2/10 → **Send to Intern**. This is a mechanical three-file CSS value bump plus a pinned comment sweep, with all line numbers verified and no logic, state, or migration surface.

---

## Code Review (Reviewer Pass)

### Stage 1 — Grumpy Principal Engineer

*"You want me to review a three-line CSS bump? Fine. Let me see if the intern managed to not screw up finding-and-replacing a number."*

**CRITICAL:** None.

**MAJOR:** None.

**NIT-1:** The plan's audit claimed "4 stale comments per file" and listed exact line numbers. The actual code has a **5th** `/* Inherits from container's 14px */` comment per file (planning.html:1345, design.html:1370, project.html:1169) on the `.empty-state` rule. This comment pre-dated the change — it already said `14px` while the container was `13px`, making it a **pre-existing stale comment** that the plan's audit completely missed. The bump accidentally made it correct. The plan's verification grep ("Expect 12 matches" for new 14px comments) would have **failed** — it returns 15, not 12. Sloppy audit work, but harmless outcome. (`src/webview/planning.html:1345`, `src/webview/design.html:1370`, `src/webview/project.html:1169`)

**NIT-2:** Plan says planning.html container is at "line ~1022". Actual line is **1026**. Within `~` tolerance, but the Proposed Changes block hardcoded `1022` in the comment. The implementer found the right line anyway. (`src/webview/planning.html:1026`)

**NIT-3:** The plan's Verification Plan step 2 says "Expect 12 matches" for the new-14px-comment grep. Actual result is **15 matches** (5 per file, not 4) due to NIT-1. The verification expectation was wrong, not the code.

*"Honestly? The implementation is clean. Every in-scope change is correct, every out-of-scope `13px` is untouched, and the counts reconcile perfectly (22→17, 22→17, 6→1). The only black mark is on the plan's audit, not the code. The intern did better than the planner. Dismissed."*

### Stage 2 — Balanced Synthesis

**Keep as-is:**
- All 15 code changes (3 container bumps + 12 comment updates). Verified correct via git diff and live grep.
- Out-of-scope `13px` values: all 35 remaining references confirmed unrelated to the markdown preview block (toggle labels, kanban topics, ticket bodies, code blocks, etc.).

**Fix now:** None needed. No CRITICAL or MAJOR findings.

**Defer:**
- NIT-1 (5th pre-existing comment): No action — the comment is now accurate post-bump. Documenting it here is sufficient.
- NIT-2/NIT-3 (plan line-number/expectation drift): Documentation-only; no code impact.

### Verification Results

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| Stale `13px base` / `Inherits from container's 13px` comments | 0 matches | 0 matches | PASS |
| New `14px base` / `Inherits from container's 14px` comments | 12 matches | 15 matches | PASS (see NIT-1) |
| Container `font-size: 14px` in preview block | 1 per file | planning:1026, design:1022, project:847 | PASS |
| `13px` count — planning.html | 17 | 17 | PASS |
| `13px` count — design.html | 17 | 17 | PASS |
| `13px` count — project.html | 1 | 1 | PASS |
| Inline code `0.85em` untouched | 3 matches (1 per file) | 3 matches | PASS |
| h4/h5/h6 `em` rules — no stale base comments | No `13px`/`14px` base comments | Confirmed (h4 uses `1em` with no base comment) | PASS |

**Compilation:** Skipped per session directive (pre-compiled state).
**Tests:** Skipped per session directive (user runs separately).

### Files Changed (Committed)

All changes were committed in `116def1` (auto-commit before code review):
- `src/webview/planning.html` — 5 changes (1 container + 4 comments)
- `src/webview/design.html` — 5 changes (1 container + 4 comments)
- `src/webview/project.html` — 5 changes (1 container + 4 comments)

### Remaining Risks

1. **`kanban.html` inconsistency (out of scope, deferred):** `src/webview/kanban.html` still uses `13px` for its markdown preview (9 matches). Typography will be inconsistent between kanban.html and the three bumped views. Flagged for optional follow-up — do not touch in this plan.
2. **Pre-existing stale comment (benign):** The 5th "Inherits from container's 14px" comment per file was stale before the bump and correct after. No action needed, but future base changes must update all 5 comment sites per file, not 4.
3. **Visual verification pending:** Manual VSIX visual check (step 5) not performed in this session — user to confirm readability and theme behavior.
