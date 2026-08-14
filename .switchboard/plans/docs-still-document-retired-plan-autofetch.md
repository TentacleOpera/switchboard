# Four Published Doc Pages Still Document Plan Auto-Fetch, Retired and Replaced by the `fetch-plans` Scheduler Source

## Metadata

**Complexity:** 2
**Tags:** documentation, scheduler, drift, separate-repo
**Project:** Browser Switchboard

## Goal

Correct the `switchboard-site` pages that still document `switchboard.planAutoFetch.*` settings and a "Fetch now" control — **four** pages, not three, plus a page description — and point them at the `fetch-plans` Scheduler source that replaced them, describing the replacement's real behaviour and its real limits. Then confirm no orphan setting was left behind on upgraded installs.

### Problem analysis and root cause

Plan auto-fetch was **deliberately retired**, not lost. `replace-plan-autofetch-with-scheduler-source.md` records the reasoning: `PlanAutoFetchService` only ever fast-forwarded the *default* branch and hard-skipped whenever HEAD was on a feature branch, while the workflow it existed for — absorbing plans a cloud VM pushed — puts those plans on **new branches**. It could not serve its own use case. It was replaced by a Scheduler source, `fetch-plans`, whose authored preset prompt lives in `src/services/schedulerPresets.ts` (`buildFetchPlansPrompt`, `:19`).

The retirement landed in commit `4d335c3c`, which deleted `src/services/PlanAutoFetchService.ts` (328 lines), stripped its references from `extension.ts`, `PlanningPanelProvider.ts`, `webview/project.html` and `webview/project.js`, removed all five `switchboard.planAutoFetch.*` declarations from `package.json`, and added `schedulerPresets.ts` in their place. Re-verified against the tree at HEAD: `planAutoFetch` and `PlanAutoFetchService` appear **nowhere** in `src/` or `package.json`.

**The docs were never updated.** Verified against `switchboard-site` at HEAD:

| Page | Lines | What it still claims |
|---|---|---|
| `reference/settings-commands.md` | `102`, `106-110` | A "Plan auto-fetch (git)" section listing five `switchboard.planAutoFetch.*` settings with types and defaults, as live configuration |
| `integrations/cloud-agents.md` | `28`, `30`, `34-38` | Prose describing auto-fetch as the inbound bridge, "Configure it from the Project panel's KANBAN PLANS tab (the auto-fetch toggle and **Fetch now**)", plus the full settings table |
| `project/plan-browser.md` | `4`, `24`, `26`, `28` | A `## Plan auto-fetch` section, a **Fetch now** control, the settings line — **and the page's frontmatter `description`**, which advertises "auto-fetch" in search results and page metadata |
| `board/kanban-board/creating-plans.md` | `62` | A bullet linking "**Plan auto-fetch**" to the cloud-agents page as a live capability |

The earlier count of three missed `creating-plans.md` entirely and missed the frontmatter line on `plan-browser.md`. The frontmatter matters disproportionately: it is the page's description in metadata and listings, so it advertises the retired feature outside the page body where a body-only edit would leave it.

A reader following `cloud-agents.md` looks for a toggle and a **Fetch now** button in the KANBAN PLANS tab that were deleted with the service. A reader following `settings-commands.md` sets five settings that no longer exist in `package.json` and therefore do nothing.

**What the replacement actually does** — needed to describe it accurately rather than recreate the error in the other direction. `buildFetchPlansPrompt` emits an agent prompt, dispatched on a timer by the Scheduler, that:

- reads `sourceConfig.remote` (default `origin`) and `sourceConfig.branchGlob` (default `*`);
- runs `git fetch <remote> --prune`, then `git for-each-ref --sort=-committerdate` over `refs/remotes/<remote>/<branchGlob>` — recency-ordered, and **not** limited to the default branch, which is the whole point of the change;
- for each branch, `git ls-tree` under `.switchboard/plans/` and `git show <branch>:<path> > <path>` for files **absent locally**, skipping any file that already exists — never overwriting;
- writes a run summary to `.switchboard/scheduler-<job.id>-latest.md`, which is the only channel by which the run's result reaches the panel;
- is constrained to be read-only against git history and additive-only in the working tree: never switch branches, never `checkout`/`switch`/`merge`/`reset`/`pull`, never stage, idempotent across runs.

**One capability did not survive, and the docs must not imply it did.** The retired settings included `planAutoFetch.trustedAuthors` — "Only plans committed by these author emails are pulled". The `fetch-plans` prompt has **no author filtering**: it copies any plan file found on any branch matching the glob. That is a real reduction in what the mechanism guarantees. The instruction to drop the deleted service's security language is necessary but not sufficient — the new text must not leave a reader assuming the author filter simply moved.

**Why this matters beyond tidiness.** `cloud-agents.md` is the page describing the inbound half of the cloud-agent bridge — the mechanism by which plans authored off-machine reach the board. Documenting a retired implementation there means the *replacement* is undocumented: nothing on the site tells a user that the capability now lives in the AUTOMATION tab as a Scheduler source. The feature works and is invisible.

**Provenance note.** The doc-parity audit register flagged this (rows `PRJ-012`, `PMT-046`) but diagnosed it as "plan auto-fetch verbs not in the standalone catalog" — a standalone parity gap. That is wrong in scope and in cause: the verbs are absent from **both** hosts because the feature was retired everywhere on purpose. Nothing about this is standalone-specific, and no standalone verb should be added.

**Delivery note — this subtask lands in a different repository.** All four pages live in `switchboard-site`, a sibling git repo (`../switchboard-site` relative to this one), not in the extension repo. It cannot ride the same branch, commit or worktree as the other subtasks in this feature, and its "ship" event is a site deploy rather than an extension release. Plan it as its own change set.

## User Review Required

None. Disposition: **correct the docs to describe the Scheduler source**, not restore the retired feature. The retirement reasoning stands on its own and is documented.

## Complexity Audit

### Routine

- Editing four markdown pages.

### Complex / Risky

- **Do not simply delete the claims.** The capability still exists; it moved. Deleting the sections leaves the `fetch-plans` Scheduler source undocumented, which is a different gap of the same size. Each page needs a redirect to where the behaviour now lives, not an excision.
- **The four pages need four different treatments.** `settings-commands.md` is a settings enumeration — the five rows and their `<summary>` section come out, since the settings genuinely no longer exist. `cloud-agents.md` needs its inbound-bridge section rewritten around the Scheduler source, because that page's whole purpose is describing that mechanism. `plan-browser.md` needs its section replaced with a pointer **and its frontmatter description rewritten**. `creating-plans.md` needs its bullet re-labelled — the link target stays valid, the label "Plan auto-fetch" does not.
- **Describe the replacement accurately.** It is a *preset prompt dispatched to an agent on a timer*, configurable by `remote` and `branchGlob`. It is not a built-in git operation, and documenting it as one recreates the original error in the other direction.
- **State what the replacement does not do.** No author filtering; never overwrites an existing local plan file; additive-only. The first is a lost guarantee, the other two are useful properties a reader will want stated.

## Edge-Case & Dependency Audit

**Race Conditions** — none.

**Security** — the retired trusted-author allow-list was part of the deleted service; the replacement is an agent prompt with no equivalent. Do not carry the old security language forward as if it still applied, and do not omit the difference silently either.

**Side Effects** — `switchboard-site` is public. Changes ship on the next site deploy, independently of any extension release.

**Dependencies & Conflicts** — the register rows `PRJ-012` and `PMT-046` are superseded by this plan and should be repointed here rather than planned as standalone verb work. `standalone-code-verification-sweep-stubs-and-omissions.md` generalises this defect shape (retired-but-documented) across the whole doc corpus; this plan is its confirmed instance and does not wait on it.

## Dependencies

None.

## Implementation

1. `reference/settings-commands.md:102,106-110` — remove the "Plan auto-fetch (git)" section and its five setting rows; the settings are gone from `package.json`. Add a pointer to the Scheduler source if the page's structure supports one.
2. `integrations/cloud-agents.md:28,30,34-38` — rewrite the inbound-bridge section around the `fetch-plans` Scheduler source: where it is configured (AUTOMATION tab), what it does (dispatches an agent on a timer that fetches with `--prune`, enumerates remote branches by recency, and copies in plan files absent locally), and its `remote` / `branchGlob` options. State plainly that it handles plans on **feature branches**, which is the whole reason for the change, that it never overwrites an existing local plan file, and that it applies no author filter.
3. `project/plan-browser.md:4,24,26,28` — replace the `## Plan auto-fetch` section with a pointer to the Scheduler source, and rewrite the frontmatter `description` so it no longer advertises auto-fetch.
4. `board/kanban-board/creating-plans.md:62` — re-label the bullet from "Plan auto-fetch" to the Scheduler source; keep the link to the cloud-agents page, which will describe the replacement after step 2.
5. No action required here — the orphan-settings question is **resolved and split out**. It is not inert: VS Code flags an unregistered key in `settings.json` as "Unknown Configuration Setting" in the JSON editor and the Problems view, and never prunes it. That is extension work in `package.json`, not site work, and is owned by `planautofetch-settings-removed-without-deprecation-orphan-warnings.md`. Keep the site copy consistent with the deprecation messages that plan lands.
6. Re-grep the doc corpus for `planAutoFetch`, `auto-fetch`, `autofetch` and "Fetch now" after the edits — the same grep is what found the fourth page and the frontmatter line that the first pass missed.

## Proposed Changes

### `switchboard-site/src/pages/docs/reference/settings-commands.md`
- **Logic:** Drop the "Plan auto-fetch (git)" section and its five retired setting rows.

### `switchboard-site/src/pages/docs/integrations/cloud-agents.md`
- **Logic:** Rewrite the inbound-bridge section around the `fetch-plans` Scheduler source.
- **Edge Cases:** Describe it as a scheduled agent prompt, not a built-in git operation; state the no-overwrite and additive-only properties; do not carry forward the deleted service's trusted-author language, and do not imply an author filter still exists.

### `switchboard-site/src/pages/docs/project/plan-browser.md`
- **Logic:** Replace the auto-fetch section with a pointer; rewrite the frontmatter `description`.
- **Edge Cases:** The frontmatter is outside the page body — a body-only edit leaves the retired feature advertised in metadata.

### `switchboard-site/src/pages/docs/board/kanban-board/creating-plans.md`
- **Logic:** Re-label the "Plan auto-fetch" bullet; keep the link.

## Verification Plan

*Per session directive, no compilation or automated-test execution is part of this plan's verification.*

1. `grep -rn "planAutoFetch"` across `switchboard-site/src/pages/docs/` returns nothing.
2. `grep -rni "auto-fetch\|autofetch\|fetch now"` returns nothing that refers to the retired Project-panel control — including inside frontmatter.
3. `cloud-agents.md` describes the `fetch-plans` Scheduler source, names where it is configured, and states that it handles plans on feature branches.
4. The page states that the source never overwrites an existing local plan file and applies no author filter.
5. No page implies the capability was removed — the replacement is documented, not just the deletion.
6. The orphan-setting question from step 5 is answered in writing, either resolved or filed.
7. Register rows `PRJ-012` and `PMT-046` are repointed at this plan and no standalone verb work is opened for them.

## Uncertain Assumptions

The user was advised to run web research to confirm the following before implementation:

- **VS Code's treatment of orphan settings keys.** Whether a `settings.json` entry under a `switchboard.*` namespace whose `contributes.configuration` declaration has been removed is silently inert, or surfaces as an "Unknown Configuration Setting" diagnostic in the settings editor / problems view. This determines whether step 5 resolves as a no-op or files a follow-up for ~4,000 installs carrying the five removed keys. It is the only item in this plan not established by reading this repository.

## Recommendation

Complexity 2 → **Send to Coder.** Small, and in a separate repo, but it is the difference between a working feature nobody can find and a documented one — and between a lost author-filter guarantee that is stated and one that is quietly assumed to have survived.
