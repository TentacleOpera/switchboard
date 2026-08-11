# Three Published Doc Pages Still Document Plan Auto-Fetch, Retired and Replaced by the `fetch-plans` Scheduler Source

## Metadata

**Complexity:** 2
**Tags:** documentation, scheduler, drift

## Goal

Correct the three `switchboard-site` pages that still document `switchboard.planAutoFetch.*` settings and a "Fetch now" control, and point them at the `fetch-plans` Scheduler source that replaced them. Then confirm no orphan setting was left behind on upgraded installs.

### Problem analysis and root cause

Plan auto-fetch was **deliberately retired**, not lost. `replace-plan-autofetch-with-scheduler-source.md` records the reasoning: `PlanAutoFetchService` only ever fast-forwarded the *default* branch and hard-skipped whenever HEAD was on a feature branch, while the workflow it existed for — absorbing plans a cloud VM pushed — puts those plans on **new branches**. It could not serve its own use case. It was replaced by a Scheduler source, `fetch-plans`, whose authored preset prompt lives in `src/services/schedulerPresets.ts` (`buildFetchPlansPrompt`) and fetches with `--prune` then enumerates remote branches by recency — which does work on feature branches.

The retirement landed in commit `4d335c3c`, which deleted `src/services/PlanAutoFetchService.ts` (328 lines), stripped its references from `extension.ts`, `PlanningPanelProvider.ts`, `webview/project.html` and `webview/project.js`, removed all five `switchboard.planAutoFetch.*` declarations from `package.json`, and added `schedulerPresets.ts` in their place. Verified against the tree: `planAutoFetch` now appears **nowhere** in `src/` or `package.json`.

**The docs were never updated.** Three published pages still describe the retired feature as current:

| Page | What it still claims |
|---|---|
| `reference/settings-commands.md:106-110` | Five `switchboard.planAutoFetch.*` settings with types and defaults, as live configuration |
| `integrations/cloud-agents.md:30-38` | "Configure it from the Project panel's KANBAN PLANS tab (the auto-fetch toggle and **Fetch now**)" plus the full settings table |
| `project/plan-browser.md:28` | "Plan auto-fetch: periodically fetch and fast-forward plans… controlled by the `switchboard.planAutoFetch.*` settings" |

A reader following `cloud-agents.md` looks for a toggle and a **Fetch now** button in the KANBAN PLANS tab that were deleted with the service. A reader following `settings-commands.md` sets five settings that no longer exist in `package.json` and therefore do nothing.

**Why this matters beyond tidiness.** `cloud-agents.md` is the page describing the inbound half of the cloud-agent bridge — the mechanism by which plans authored off-machine reach the board. Documenting a retired implementation there means the *replacement* is undocumented: nothing on the site tells a user that the capability now lives in the AUTOMATION tab as a Scheduler source. The feature works and is invisible.

**Provenance note.** The doc-parity audit register flagged this (rows `PRJ-012`, `PMT-046`) but diagnosed it as "plan auto-fetch verbs not in the standalone catalog" — a standalone parity gap. That is wrong in scope and in cause: the verbs are absent from **both** hosts because the feature was retired everywhere on purpose. Nothing about this is standalone-specific, and no standalone verb should be added.

## User Review Required

None. Disposition: **correct the docs to describe the Scheduler source**, not restore the retired feature. The retirement reasoning stands on its own and is documented.

## Complexity Audit

### Routine

- Editing three markdown pages.

### Complex / Risky

- **Do not simply delete the claims.** The capability still exists; it moved. Deleting the sections leaves the `fetch-plans` Scheduler source undocumented, which is a different gap of the same size. Each page needs a redirect to where the behaviour now lives, not an excision.
- **The three pages need different treatments.** `settings-commands.md` is a settings enumeration — the five rows come out, since the settings genuinely no longer exist. `cloud-agents.md` needs its inbound-bridge section rewritten around the Scheduler source, because that page's whole purpose is describing that mechanism. `plan-browser.md` needs a one-line pointer, since auto-fetch was only ever a mention there.
- **Describe the replacement accurately.** `buildFetchPlansPrompt` is a *preset prompt dispatched to an agent on a timer*, configurable by `remote` and `branchGlob`. It is not a built-in git operation, and documenting it as one recreates the original error in the other direction.

## Edge-Case & Dependency Audit

**Race Conditions** — none.

**Security** — none. The retired trusted-author allow-list was part of the deleted service; the replacement is an agent prompt, so do not carry the old security language forward as if it still applied.

**Side Effects** — `switchboard-site` is public. Changes ship on the next site deploy.

**Dependencies & Conflicts** — the register rows `PRJ-012` and `PMT-046` are superseded by this plan and should be repointed here rather than planned as standalone verb work.

## Dependencies

None.

## Implementation

1. `reference/settings-commands.md:106-110` — remove the five `switchboard.planAutoFetch.*` rows; the settings are gone from `package.json`. Add a pointer to the Scheduler source if the page's structure supports one.
2. `integrations/cloud-agents.md:30-38` — rewrite the inbound-bridge section around the `fetch-plans` Scheduler source: where it is configured (AUTOMATION tab), what it does (dispatches an agent on a timer to fetch remote branches and import plan files), and its `remote` / `branchGlob` options. State plainly that it handles plans on **feature branches**, which is the whole reason for the change.
3. `project/plan-browser.md:28` — replace the auto-fetch line with a pointer to the Scheduler source.
4. Confirm the upgrade path for the five removed settings: an install carrying `switchboard.planAutoFetch.enabled: true` in its settings now holds an orphan key against a contributes block that no longer declares it. Establish whether that is inert or surfaces as an "unknown setting" warning, and if the latter, record it as a follow-up — the retirement removed shipped settings from ~4,000 installs and the disposition should be explicit rather than assumed.
5. Grep the rest of the doc corpus for `planAutoFetch`, `auto-fetch` and "Fetch now" so no fourth page is left behind.

## Proposed Changes

### `switchboard-site/.../reference/settings-commands.md`
- **Logic:** Drop the five retired settings rows.

### `switchboard-site/.../integrations/cloud-agents.md`
- **Logic:** Rewrite the inbound-bridge section around the `fetch-plans` Scheduler source.
- **Edge Cases:** Describe it as a scheduled agent prompt, not a built-in git operation; do not carry forward the deleted service's trusted-author language.

### `switchboard-site/.../project/plan-browser.md`
- **Logic:** Replace the auto-fetch line with a pointer.

## Verification Plan

1. `grep -rn "planAutoFetch"` across `switchboard-site/src/pages/docs/` returns nothing.
2. `grep -rni "fetch now"` returns nothing that refers to the retired Project-panel control.
3. `cloud-agents.md` describes the `fetch-plans` Scheduler source, names where it is configured, and states that it handles plans on feature branches.
4. No page implies the capability was removed — the replacement is documented, not just the deletion.
5. The orphan-setting question from step 4 is answered in writing, either resolved or filed.
6. Register rows `PRJ-012` and `PMT-046` are repointed at this plan and no standalone verb work is opened for them.

## Recommendation

Complexity 2 → **Send to Coder.** Small, but it is the difference between a working feature nobody can find and a documented one.
