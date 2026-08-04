# De-collide the three tickets-folder verbs that Planning and Setup both define with different meanings

## Goal

Give the Setup panel's tickets-folder verbs provider-scoped names distinct from the Planning panel's identically-named verbs, and stop the two from sharing response `type`s. This removes a latent collision that becomes an active bug the moment both UIs share one panel (plan 4).

**This plan ships on its own and moves no UI.** It is a rename plus a message-shape disambiguation.

### Problem and background

Three verbs exist twice in the codebase under the same name, and the two copies are not duplicates — they are different features that happen to share a spelling:

| | `PlanningPanelProvider.ts` (`:2913`, `:2931`, `:2946`) | `SetupPanelProvider.ts` (`:1301`, `:1318`, `:1338`) |
|---|---|---|
| writes | `config.ticketsFolderPaths` — an **array** | `config.ticketSaveLocation` — a **string** |
| via | `LocalFolderService` | `GlobalIntegrationConfigService` |
| scope | **workspace** | **machine-global, per provider** (`clickup` / `linear`) |
| emits | `ticketsFoldersListed { paths[], workspaceRoot }` | `ticketsFoldersListed { provider, path, ticketsAutoSync }` |
| emits | `browseTicketsFolderResult { path, workspaceRoot }` | `browseTicketsFolderResult { provider, path }` |

All line anchors verified. The colliding verb names are `saveTicketsFolder`, `browseTicketsFolder`, and `listTicketsFolders`; all three appear in **both** `PLANNING_VERBS` and `SETUP_VERBS` in `src/generated/verbAllowlist.ts`.

**There are two shared response types, not one.** The original draft caught `ticketsFoldersListed` and missed `browseTicketsFolderResult`, which is emitted by `SetupPanelProvider.ts:1311` as `{ provider, path }` and by `PlanningPanelProvider.ts:2940` / `:2944` as `{ path, workspaceRoot }`, and is listened for at `setup.html:4632`. Both must be split.

> **Superseded:** "Note they also emit the **same response `type`** (`ticketsFoldersListed`) with incompatible payload shapes."
> **Reason:** Incomplete. `browseTicketsFolderResult` is a second shared type with the same incompatibility, and it is the one that drives an automatic write — `setup.html:4632-4645` reacts to it by immediately posting `saveTicketsFolder`. Splitting only `ticketsFoldersListed` leaves the more dangerous of the two intact.
> **Replaced with:** Both `ticketsFoldersListed` **and** `browseTicketsFolderResult` are split.

A third emitter compounds it: `saveTicketsFolderPaths` (Planning-only, `PlanningPanelProvider.ts:2921`) also emits `ticketsFoldersListed`, as do the two adjacent Planning handlers at `:2901` and `:2910`. Five Planning emission sites in total (`:2901`, `:2910`, `:2917`, `:2928`, `:2958`) against three on the Setup side (`:1326`, `:1343`, `:1349`).

### Verified call-site distribution (corrects the original justification)

| Side | Webview posts | Webview listens |
|---|---|---|
| Planning (`planning.js`) | **none** of the three | `ticketsFoldersListed` at `:6026` |
| Setup (`setup.html` inline script) | `listTicketsFolders` `:2795`; `browseTicketsFolder` `:3921`, `:3924`; `saveTicketsFolder` `:3929`, `:3934`, `:4636`, `:4640`, `:4645` | `ticketsFoldersListed` `:4598`; `browseTicketsFolderResult` `:4632` |

The Planning trio has **zero** webview callers. `planning.js` drives its folder UI through `addTicketsFolder` (`:9531`), `removeTicketsFolder` (`:3707`) and `saveTicketsFolderPaths`, and only *listens* for the shared `ticketsFoldersListed` type. The Planning trio is reachable exclusively over `POST /planning/verb/*` — an API-only surface published through `GET /catalog`.

> **Superseded:** "The Planning trio keeps its current names — it is the older, workspace-scoped meaning and has more call sites."
> **Reason:** The call-site claim is false in the direction stated. Planning has **zero** webview call sites; Setup has eight. Renaming Planning would in fact be the *cheaper* mechanical change.
> **Replaced with:** The Planning trio keeps its current names on **semantic** grounds, not call-site count. `ticketsFolder` accurately describes what Planning's trio does (browse and persist local ticket **folders**, workspace-scoped). Setup's trio is the misnomer: it sets a single per-provider ticket **save location**, which is not a folder list at all. Renaming the misnamed side is correct regardless of which side is cheaper to touch, and it keeps the rename inside one inline script (`setup.html`) rather than spread across a published Planning API and a provider.

Note the cost asymmetry is worth stating plainly so a reviewer does not re-litigate it: this choice deliberately takes the *more* mechanical work (eight Setup call sites) in exchange for the *more* accurate end-state naming.

### Root cause

The verb rail is namespaced per panel. `transport.js:25-26` derives its route prefix from `document.body.dataset.panel`, so the Planning UI posts to `/planning/verb/*` and the Setup UI to `/setup/verb/*`, and each provider's allowlist gates its own set. That namespacing is the *only* thing keeping these apart. It was never a deliberate design decision that two different features could share a verb name — it is an accident that the panel boundary happened to hide.

Plan 4 moves the ClickUp and Linear config UIs into the Tickets panel. At that point both UIs post to `/tickets/verb/*` and both listen on the same `window` message stream:

- `saveTicketsFolder` becomes ambiguous — one payload carries `folderPath` + `provider`, the other carries `folderPath` alone and means a workspace array. Whichever handler is registered wins, and the other feature silently writes to the wrong store. `setup.html:4645` already posts a **provider-less** `saveTicketsFolder` as its fallback branch, which is byte-identical to the Planning payload shape.
- Both listeners receive every `ticketsFoldersListed` message. The ticket browser's folder list gets clobbered by the config tab's per-provider message and vice versa.
- Both listeners receive every `browseTicketsFolderResult`. Worse than a display glitch: `setup.html:4632-4645` responds to that message by immediately posting a `saveTicketsFolder`, so a Planning-side folder browse would trigger a Setup-side **write** with a path chosen for a different purpose.

This is silent and data-shaped rather than a visible crash, and it hits the standalone host hardest because there the rail is literally one HTTP namespace with one allowlist.

## Metadata

**Tags:** bugfix, backend, api, refactor
**Complexity:** 5

## User Review Required

- **Deprecated aliases: keep or break?** The verb rail is a documented surface (`GET /catalog`) and this is a published extension with ~4,000 installs. External API callers may be posting `POST /setup/verb/saveTicketsFolder` today. Recommendation: **keep all three old Setup names as thin deprecated aliases for one release**, marked deprecated in the catalog. Aliases are three `case` fall-throughs; a break is unrecoverable for a caller who does not read release notes. Record the decision in the completion notes either way. **Note the alias must be registered on the Setup rail only** — an alias that also lands in `TICKETS_VERBS` after plan 4 re-creates the exact collision this plan removes.
- **Resequence: land this before plan 2.** See `## Dependencies`.

## Approach

1. **Rename the Setup-side trio** to provider-scoped names that say what they do. Match the surrounding `SETUP_VERBS` naming, which already uses provider prefixes (`applyClickUpConfig`, `saveClickUpMappings`, `linearBrowseProjects`):
   - `saveTicketsFolder` → `saveIntegrationTicketSaveLocation`
   - `browseTicketsFolder` → `browseIntegrationTicketSaveLocation`
   - `listTicketsFolders` → `getIntegrationTicketSaveLocations`

2. **Split both response `type`s.** Setup's emissions become distinct types carrying the Setup payload shapes; Planning keeps the current names with its own shapes. After this, no listener can receive a message shaped for the other feature.

   | Emitter | Old `type` | New `type` | Payload |
   |---|---|---|---|
   | Setup `:1326`, `:1343`, `:1349` | `ticketsFoldersListed` | `integrationTicketSaveLocations` | `{ provider, path, ticketsAutoSync }` |
   | Setup `:1311` | `browseTicketsFolderResult` | `integrationTicketSaveLocationBrowsed` | `{ provider, path }` |
   | Planning `:2901`, `:2910`, `:2917`, `:2928`, `:2958` | `ticketsFoldersListed` | *unchanged* | `{ paths[], workspaceRoot }` |
   | Planning `:2940`, `:2944` | `browseTicketsFolderResult` | *unchanged* | `{ path, workspaceRoot }` |

3. **Update the Setup-side call sites** in `setup.html`'s inline script — all ten verified sites: posts at `:2795`, `:3921`, `:3924`, `:3929`, `:3934`, `:4636`, `:4640`, `:4645`; listeners at `:4598`, `:4632`. Pay specific attention to `:4645`, the provider-less fallback branch: decide whether it should carry a provider or be removed, because after the rename it is the one call site whose intent is genuinely ambiguous.

4. **Regenerate the allowlist:** `npm run catalog:generate`, then confirm `catalog:check` is clean and that `SETUP_VERBS` no longer shares these three names with `PLANNING_VERBS`.

5. **Audit for other collisions while here.** Several verbs legitimately appear in more than one set because separate providers each own a real implementation (`clickupLoadSpaces`, `linearLoadProject`, `clickupImportTask` in both `PLANNING_VERBS` and `TASKVIEWER_VERBS`; `getDbPath`, `ready`, `getCustomAgents`, `runSetup`, `scaffoldMultiRepo` across several). Those are fine — the question is not "is the name duplicated" but "would the two implementations disagree if they landed on one rail". Check specifically for pairs that write different stores or emit a shared `type` with different payloads, and report anything found even if it is out of scope to fix here. The two shared response types found in this plan are proof that the response-`type` axis, not just the verb-name axis, needs sweeping.

## Complexity Audit

### Routine

- A rename across one inline script and one provider file, with the compiler and `catalog:check` catching most of the mechanical misses.
- Three optional alias `case` fall-throughs if the alias decision is yes.
- No new files, no new panels, no UI movement, no host-parity work beyond re-running both sweeps.

### Complex / Risky

- **Two shared response types, one of which drives an automatic write.** `browseTicketsFolderResult` → `setup.html:4645` → `saveTicketsFolder`. Get the split half-right and a browse in one feature writes config in the other.
- **The provider-less `saveTicketsFolder` at `setup.html:4645`** is byte-shape-identical to Planning's payload. It is the specific line that makes the collision undetectable by shape inspection at runtime.
- **A half-finished rename is silent on the Setup side.** `setup.html`'s inline script posts strings; a missed call site produces a verb the allowlist rejects, which surfaces as a feature that quietly stops working rather than an error. `verb-returns:check` is the gate most likely to catch it.
- **Published API surface.** Renaming a `GET /catalog` verb without aliases breaks external callers with no compile-time signal anywhere.
- Five Planning emission sites of `ticketsFoldersListed` must be left untouched — an over-eager global rename that catches them breaks the Planning folder UI's only listener (`planning.js:6026`).

## Edge-Case & Dependency Audit

**Race Conditions**
- `setup.html:2795` fires `listTicketsFolders` on panel init, and the Setup handler responds with **two** messages (one per provider, `:1343` and `:1349`). The listener must be idempotent across both and must not assume ordering. Preserve that two-message shape under the new type name.
- `GlobalIntegrationConfigService.loadConfig` / `saveConfig` are read-modify-write on a machine-global store. Two panels open at once (the normal case after plan 4) can interleave. Out of scope to fix, but do not make it worse: keep the save path a single load-mutate-save as it is today.

**Security**
- No credential path is touched. `GlobalIntegrationConfigService` holds the save-location string, not tokens.
- Renaming a verb narrows the allowlist surface, which is the safe direction. Aliases widen it back — keep them on `/setup/verb/*` only and remove them on schedule.

**Side Effects**
- `GET /catalog` output changes. Anything that snapshots the catalog needs regenerating.
- `src/generated/verbAllowlist.ts` is generated; do not hand-edit. Regenerate and diff.
- No storage read or write changes shape, so no user data moves. This is a wire-contract change only.

**Dependencies & Conflicts**
- **Blocks plan 4** — hard, non-optional.
- **Should precede plan 2** (see below) so plan 2 does not need its three-verb carve-out.
- Touches `SetupPanelProvider.ts`, `setup.html`, `PlanningPanelProvider.ts` (response-type sites only) and the generated allowlist. **Plan 4 also touches `SetupPanelProvider.ts` and `setup.html`** — they must not be worked concurrently.
- Shares no file with plan 1.

## Dependencies

- No prior research sessions — nothing to reference in `sess_…` form.
- **Upstream:** none. This plan is a leaf and may start immediately, in parallel with plan 1.
- **Downstream:** `tickets-panel-2-extract-tickets-tab-into-standalone-panel.md` (recommended after this), `tickets-panel-4-move-clickup-and-linear-config-out-of-setup.md` (hard requirement).

### Resequencing recommendation

The feature's original order was 1 → 2 → 3 → 4, with plan 3 needing only to precede plan 4. Two verified facts argue for **1 and 3 in parallel, then 2, then 4**:

- This plan is genuinely independent of plans 1 and 2 — it shares no file with plan 1 and touches only response-type strings in the file plan 2 rewrites.
- Under the original order, plan 2 must carve out three verbs it otherwise owns (its own constraint says to leave the Planning trio alone until plan 3 merges) and then a later pass must go back for them. Landing this plan first deletes that carve-out and lets plan 2 move the whole ticket verb surface in one cut.

## Adversarial Synthesis

**Risk Summary.** The plan's own framing understated the blast radius twice: there are **two** shared response types rather than one, and the missed one (`browseTicketsFolderResult`) is the dangerous one because `setup.html:4632-4645` reacts to it by immediately writing config — so a Planning-side browse could trigger a Setup-side save once both UIs share a rail. The justification for renaming the Setup side rather than the Planning side was also factually backwards (Planning has zero webview call sites, Setup has eight); the direction is still right, but on semantic grounds, and the plan now says so. Mitigations: split both response types, treat `setup.html:4645`'s provider-less `saveTicketsFolder` as a named decision rather than a line to search-and-replace, keep deprecated aliases on the Setup rail only, and prove isolation with the cross-contamination check rather than trusting `catalog:check`.

## Proposed Changes

### `src/services/SetupPanelProvider.ts`

- **Context:** `browseTicketsFolder:1301` (emits `browseTicketsFolderResult:1311`), `saveTicketsFolder:1318` (writes `config.ticketSaveLocation:1323`, emits `ticketsFoldersListed:1326`), `saveTicketsAutoSync:1334`, `listTicketsFolders:1338` (emits twice, `:1343` and `:1349`).
- **Logic:** Rename the three `case` labels; rename the two emitted `type` strings.
- **Implementation:** New names per the table above. If aliases are kept, add the old names as fall-through `case` labels on the same handlers.
- **Edge Cases:** `browseTicketsFolder` returns `{ success: true }` with **no** typed message when the user cancels the dialog (`:1316`), whereas Planning returns a typed null result (`:2944`). Preserve the existing Setup behaviour — this plan is not the place to unify it.

### `src/webview/setup.html` (inline script)

- **Context:** Eight posts and two listeners, verified at `:2795`, `:3921`, `:3924`, `:3929`, `:3934`, `:4598`, `:4632`, `:4636`, `:4640`, `:4645`.
- **Logic:** Update every post to the new verb name and both listeners to the new response types.
- **Implementation:** Site-by-site, not a global find-and-replace — `:3897` contains a *comment* mentioning `saveTicketsFolder` that should be updated for accuracy but is not a call site.
- **Edge Cases:** `:4645` is the provider-less fallback. Resolve it explicitly (attach a provider, or delete the branch) and record the choice.

### `src/services/PlanningPanelProvider.ts`

- **Context:** Emission sites `:2901`, `:2910`, `:2917`, `:2928`, `:2940`, `:2944`, `:2958`. Verb handlers `listTicketsFolders:2913`, `saveTicketsFolderPaths:2921`, `browseTicketsFolder:2931`, `saveTicketsFolder:2946`.
- **Logic:** **No change.** Listed here so the implementer knows exactly which sites must survive the rename untouched.
- **Edge Cases:** `planning.js:6026` is the sole consumer of Planning's `ticketsFoldersListed`. If it stops receiving messages, the rename over-reached.

### `src/generated/verbAllowlist.ts`

- **Context:** Generated output.
- **Logic:** Regenerate via `npm run catalog:generate`; never hand-edit.
- **Edge Cases:** Diff it and confirm each of the three names now appears in exactly one set (or, with aliases, that the old Setup names appear only in `SETUP_VERBS`).

## Constraints

- **No storage-format changes.** `config.ticketsFolderPaths` stays an array; `config.ticketSaveLocation` stays a string. This plan renames the wire contract, not the data. Both formats shipped in released versions, so neither may be rewritten here.
- **No user-visible behaviour change.** Both features must work exactly as before, in both hosts, from their current panels.
- **Do not "unify" the two features into one.** They are genuinely different — workspace-scoped multi-folder browsing versus machine-global per-provider save location. Merging them is a product decision nobody has made.
- Do not rename the Planning trio in this plan even though it is cheaper. Its disposition (move to `TicketsPanelProvider`, keep as API-only, or deprecate) belongs to plan 2.

## Verification Plan

### Automated Tests

- `npm run catalog:generate` then `npm run catalog:check` — clean, and diff `src/generated/verbAllowlist.ts` to confirm the three names now appear in exactly one set each (aliases excepted, and only in `SETUP_VERBS`).
- `npm run parity:check`, `npm run verb-returns:check` — the latter guards verb return shapes and is the gate most likely to catch a half-finished rename.
- `npm run lint`, `npm run compile-tests`.
- `npm run test:contract:verb-engine-planning`, `npm run test:contract:verb-engine`, `npm run test:contract:verb-engine-kanban`.
- Response-type sweep: grep the tree for `ticketsFoldersListed` and `browseTicketsFolderResult` and confirm each name is now emitted by exactly one provider and consumed by exactly one listener.

### Manual

- **VS Code host, installed VSIX** — Artifacts panel: add, browse, remove and list local ticket folders; confirm the workspace-scoped array still persists and reloads. Setup panel, ClickUp and Linear tabs: set and browse the per-provider ticket save location, toggle tickets auto-sync; confirm the machine-global config still persists and reloads.
- **Standalone browser host** — repeat both sweeps against `/planning` and `/setup`, confirming `POST /planning/verb/saveTicketsFolder` and `POST /setup/verb/saveIntegrationTicketSaveLocation` each hit exactly one handler and reject the other's name.
- **Cross-contamination check, the point of the whole plan:** set a workspace ticket folder in Artifacts, then set a ClickUp ticket save location in Setup, then reload both. Neither value may have moved or cleared the other.
- **Browse-triggered-write check (the newly-found path):** in Setup, click Browse for the ClickUp ticket save location and complete the dialog; confirm exactly one save fires, for ClickUp only, and that the Artifacts folder list is untouched. Then cancel a browse and confirm nothing is written.
- If deprecated aliases are kept, confirm the old Setup names still resolve, are marked deprecated in `GET /catalog`, and are absent from every set other than `SETUP_VERBS`.

## Resolved Assumptions

Settled this pass by direct inspection — do not re-open, and do not send to research:

- `browseTicketsFolderResult` is a **second** shared response type with incompatible payloads (`SetupPanelProvider.ts:1311` vs `PlanningPanelProvider.ts:2940`/`:2944`).
- The Planning trio has **zero** webview callers; Setup has eight posts and two listeners.
- `saveTicketsFolderPaths` (Planning `:2921`) is a fourth verb emitting the shared `ticketsFoldersListed` type; five Planning emission sites in total.
- `setup.html:4645` posts a **provider-less** `saveTicketsFolder`, shape-identical to Planning's payload.
- `src/generated/verbAllowlist.ts` is generated by `catalog:generate`, not hand-edited.
- All named `npm run` gates in this plan exist in `package.json`.

## Recommendation

**Complexity 5 → Send to Coder.** Ready to execute once the alias decision is made. Record in the completion notes: the alias choice, the disposition of `setup.html:4645`, and any additional shared-response-`type` collisions found by the step-5 sweep.

## Completion Report

De-collided Setup ticket-folder verbs (`saveIntegrationTicketSaveLocation`, `browseIntegrationTicketSaveLocation`, `getIntegrationTicketSaveLocations`) and response types (`integrationTicketSaveLocations`, `integrationTicketSaveLocationBrowsed`) in `SetupPanelProvider.ts` and `setup.html`. Preserved backwards-compatible fall-through aliases for Setup verbs. Removed ambiguous provider-less save branch at `setup.html:4645`. Regenerated protocol catalog and verb allowlist. No issues encountered.

## Review Findings

**Clean — no defects found, no fixes applied.** All three Setup verbs are renamed, both shared response types are split (`integrationTicketSaveLocations` and `integrationTicketSaveLocationBrowsed`), the deprecated aliases are fall-through `case` labels on the Setup rail only and appear in no other verb set, and the provider-less `saveTicketsFolder` fallback at `setup.html:4645` is removed as specified. Planning's five `ticketsFoldersListed` emission sites and its `browseTicketsFolderResult` sites are untouched, so `planning.js:6026` still receives its messages — the rename did not over-reach. Validation: `catalog:check`, `parity:check`, `verb-returns:check`, `compile-tests`, and `test:contract:verb-engine` / `verb-engine-planning` / `verb-engine-kanban` (26/41/19 passed, 0 failed) all green. Remaining risk: none from this plan; note the aliases are still due for removal on the release schedule recorded here.

