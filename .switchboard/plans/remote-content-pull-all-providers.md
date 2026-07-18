# Remote content-pull for all providers (Notion, ClickUp) — not just Linear

## Goal

Make plan **content** (the plan body/description) sync *back* from remote boards to the local plan file for **every** remote provider — Notion and ClickUp — the way it already does for Linear. Today a plan's content is effectively one-way after creation: it is pushed out to the remote, and pulled *in* only once (when a brand-new remote card is first imported). Edits made to an existing plan's body on the remote never return, and an outbound content push can silently overwrite them.

### Problem Analysis (background + root cause)

**Why this matters now.** The remote system was designed when the remote surface was a place a *human* moved cards and left comments — the plan text was authored locally and mirrored out, so one-way content was fine. Since then the SaaS boards (Linear, Notion, ClickUp) shipped their own AI agents that can *rewrite a plan body in place*. A remote agent that deepens a plan's spec now has nowhere for that work to land: the extension never reads it back.

**Root cause — it's a gate, not a missing feature.** The content-pull mechanism already exists and is complete:

- `RemoteControlService._pollDescriptions()` (`src/services/RemoteControlService.ts`, ~L594–675) is a full, correct implementation: a per-issue description cursor (`remote.descriptionCursor.${kind}`), sha256 hash-based loop prevention, an empty-body guard ("never clobber with empty"), a 100 KB size guard, and H1-title preservation when rewriting the file.
- It is invoked every poll from `_poll()` (~L312), right after `_pollState` and `_pollComments`.
- The dependency wiring in `KanbanProvider.ts` (`getDescriptionCursors`/`setDescriptionCursor` ~L1966–1980, `onDescriptionPulled` hash registration ~L2007) is already **kind-generic** — it takes a `RemoteProviderKind` argument.

Two things restrict it to Linear:

1. **A hard gate:** `_pollDescriptions` returns early with `if (provider.kind !== 'linear') { return; }` (~L601).
2. **Provider data:** the method reads `d.description` and `d.updatedAt` off the state deltas, and **only `LinearRemoteProvider.fetchStateDeltas` populates them** (`LinearRemoteProvider.ts` ~L54–79: the GraphQL query selects `description` + `updatedAt` inline). `NotionRemoteProvider.fetchStateDeltas` sets neither (`NotionRemoteProvider.ts` ~L98–117 — only `remoteId`, `stateKey`, `parentRemoteId`, `isFeatureCandidate`); ClickUp likewise.

So the work is **generalizing an existing feature to two more providers**, not building content-pull from scratch. The subtlety is entirely in *how each provider supplies the body* and in not re-introducing echo loops or mass-overwrites.

## Dependencies

None blocking. Builds on the existing `_pollDescriptions` machinery and the per-kind cursor/hash wiring already in `KanbanProvider.ts`. Should land after any in-flight remote-sync work to avoid churn in `RemoteControlService.ts`.

## Metadata

**Tags:** backend, integrations, remote, notion, clickup, sync
**Complexity:** 6

## User Review Required

Two product decisions are baked into this plan as defaults; flag them for confirmation:

1. **Conflict resolution = last-write-wins by timestamp**, no merge dialog. The owner has stated conflicts are expected to be rare and acceptable. The existing hash check already prevents *no-op* clobbers; a genuine divergence resolves in favour of whichever side changed more recently (remote pull overwrites local only when the remote's `updatedAt`/`last_edited_time` is newer than the per-issue cursor). No 3-way UI in this plan. **Forward-compatibility:** implement the resolution as a *pluggable strategy* (last-write-wins now) rather than hard-coded — the follow-on `cross-platform-agent-collaboration` plan will add locking/turn-taking, and shouldn't require ripping this out. Concurrent edits are rare for one remote human but become the *normal* case once multiple agents collaborate on one plan.
2. **Gating:** content-pull rides the existing **Full** remote mode plus a new **"Poll content from remote"** toggle (parallel to the existing "Poll comments from remote"), default **on** for new setups. Alternative: no toggle, always-on in Full mode. Recommend the toggle for symmetry and an escape hatch.

## Complexity Audit

### Routine
- Remove the `provider.kind !== 'linear'` gate in `_pollDescriptions`.
- Populate `updatedAt` on Notion state deltas (the value is already in hand as `row.last_edited_time`).
- Populate `description` + `updatedAt` on ClickUp state deltas (task payload already carries `description`/`text_content` and `date_updated`).
- Add the "Poll content from remote" setting + Setup Panel checkbox, mirroring the comments toggle.

### Complex / Risky
- **Notion body fetch is not a single field.** A Notion page body must be assembled via `fetchBlocksRecursive` + `convertBlocksToMarkdown` (one+ extra API call per page). Inlining that into `fetchStateDeltas` would fetch every changed page's blocks on every poll. Introduce a **lazy** provider method `fetchDescription(remoteId)` that `_pollDescriptions` calls *only* for rows whose `updatedAt` is past that issue's description cursor.
- **Notion round-trip fidelity → loop risk.** `markdown → Notion blocks → markdown` is lossy, so the sha256 echo guard (which compares the re-rendered pull against local file content) can mismatch even when nothing meaningfully changed, causing a pull↔push ping-pong. Mitigation: compare against the **hash registered at push time** via the existing `onDescriptionPulled` loop-prevention registry (register the pushed content's hash on `pushContent`, not only on pull), rather than trusting a byte-identical re-render.

## Edge-Case & Dependency Audit

### Race conditions / data-loss
- **First-enable mass overwrite.** When content-pull turns on for an existing Notion/ClickUp remote, there is no description cursor yet. It MUST **seed-on-first-poll to "now"** (no history replay), exactly as the state and comment cursors already do (`_pollState`/`_pollComments` baseline when `!cursor`). Without this, the first poll would overwrite every local plan with the remote body. This is the single most dangerous edge case.
- **Concurrent local agent write.** Plan files are "write-once-at-the-end" by the coding agent. A remote pull mid-run could overwrite an agent's fresh write (or vice-versa). Accepted as rare per the owner; last-write-wins. The empty-body guard already prevents wiping a plan with a blank remote.
- **Echo guard on our own push.** `pushContent` bumps the remote `updatedAt`/`last_edited_time`; the next poll must not treat that as an inbound edit. Handled by registering the pushed hash (see Complex section) + the existing `newHash === existingHash → skip + advance cursor` branch.

### Rate limits / cost
- Notion: bound block-fetches to genuinely-changed pages via the lazy `fetchDescription` + per-issue cursor check; respect the existing `LIMITER_MS` pacing in `NotionRemoteProvider`.
- ClickUp: description arrives with the task query already used for state — no extra call.

### Dependencies & conflicts
- `RemoteStateDelta` (`RemoteProvider.ts` ~L19) already carries optional `description?`/`updatedAt?` (Linear populates them) — no type change needed for the inline path; add `fetchDescription?(remoteId)` as an optional interface method for the lazy path.
- Cursor storage reuses `db.getConfig`/`setConfig` under `remote.descriptionCursor.${kind}` — new keys, unreleased for notion/clickup, so **no migration required** (clean addition).
- ClickUp lacks the comment bus but that is orthogonal; content-pull is independent of comments.

## Proposed Changes

### Phase 1 — Ungate the poller, keep Linear green
**File: `src/services/RemoteControlService.ts`**
- Remove `if (provider.kind !== 'linear') { return; }` from `_pollDescriptions`.
- Replace the "read `d.description` off the delta" assumption with a resolver: use `d.description` when present (Linear/ClickUp inline path); otherwise, if `provider.fetchDescription` exists, call it lazily for rows where `d.updatedAt > cursors[d.remoteId]`.
- Add **seed-on-first-poll**: when a provider has no `remote.descriptionCursor.${kind}` entry set at all, baseline every current row's cursor to its `updatedAt` (or "now") and pull nothing this cycle.
- Gate the whole method on the new "Poll content from remote" setting.
- Regression check: Linear path must behave identically (inline description, existing tests pass).

### Phase 2 — ClickUp inline description
**File: `src/services/remote/ClickUpRemoteProvider.ts`**
- In `fetchStateDeltas`, set `description` (task `description`/`text_content`) and `updatedAt` (`date_updated`, normalized to the same ISO/string form the cursor comparison expects) on each delta. No new fetch call.

### Phase 3 — Notion lazy fetchDescription + fidelity guard
**Files: `src/services/remote/NotionRemoteProvider.ts`, `src/services/RemoteControlService.ts`, `src/services/KanbanProvider.ts`**
- Set `updatedAt` on Notion state deltas from `row.last_edited_time` (already read for `nextCursor`).
- Add `fetchDescription(remoteId)` using the existing `fetchPageTitle` + `fetchBlocksRecursive` + `convertBlocksToMarkdown` path (the same one `importRemotePlan` uses at ~L415–417), returning `{ body, updatedAt }`.
- **Preferred, if available:** evaluate Notion's **Markdown API** (Developer Platform, 2026 — read/write pages as markdown directly) in place of the block-fetch + `convertBlocksToMarkdown` round-trip. Reading the body as markdown natively is cleaner and likely sidesteps the lossy block round-trip that drives the ping-pong risk below. Weigh availability/token cost against the existing block path before committing.
- On `pushContent`, register the pushed content's sha256 in the loop-prevention registry (extend the `onDescriptionPulled` mechanism, or add a sibling `onContentPushed`) so the pull comparison in `_pollDescriptions` uses the pushed hash and doesn't ping-pong on lossy re-render.

### Phase 4 — Setting + UI
**Files: setup/remote settings (`SetupPanelProvider.ts` / kanban remote config), `src/webview/setup.html`**
- Add "Poll content from remote" toggle beside "Poll comments from remote"; persist in the Kanban DB like the other remote flags. No `settings.json`.

### Phase 5 — Tests + docs
- Unit: ClickUp/Notion `fetchStateDeltas` populate `updatedAt` (+ ClickUp `description`); Notion `fetchDescription` renders body; seed-on-first-poll pulls nothing; echo guard no-ops an own-push round-trip (esp. lossy Notion); last-write-wins on genuine divergence. Extend `src/test/integrations/notion/*` and add a ClickUp equivalent.
- Docs (switchboard-site, separate repo/branch): `integrations/remote-boards.md` currently calls Notion "Full two-way" and lists only "Poll comments from remote" — update the provider table and options to reflect content-pull, and note last-write-wins.

## Definition of Done
- Editing an existing plan's body in Notion or ClickUp updates the local plan file within one poll cycle, on par with Linear.
- Enabling the feature on an existing remote does not retroactively overwrite local plans (seed-on-first-poll verified).
- No pull↔push loop on any provider, including Notion's lossy round-trip.
- Linear behaviour unchanged; all existing remote tests green.
