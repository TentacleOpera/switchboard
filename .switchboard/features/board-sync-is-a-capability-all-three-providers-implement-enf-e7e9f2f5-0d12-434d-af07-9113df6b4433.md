# Board sync is a capability all three providers implement, enforced by a contract test

**Complexity:** 6

## Goal

Board sync — the half of provider integration that carries kanban columns and feature structure — has no interface, no capability declaration, and no contract test. That is why repeated parity work landed truthfully and left the important half asymmetric: parity was measured against RemoteProviderCapabilities, which declares pull, push and archive, and board sync was never in it. The result is an inversion nobody could see. Notion runs a full two-way board sync filed under the name NotionBackupService, outside the seam entirely. ClickUp persists a planId anchor three separate ways and already looks tasks up by it, but has no restore pass. Linear persists no anchor at all, so a board can never be rebuilt from it. This feature makes board sync a declared capability, enforces symmetry in CI with explicit reviewed exemptions rather than silence, and then closes each gap by deleting an exemption. Deliberately excluded: no new capabilities beyond board sync, and no change to the Notion database property names that exist in real user workspaces.

## How the Subtasks Achieve This

- **Board sync is a seam with no interface — extend RemoteProviderCapabilities to cover it and add the contract test that keeps it symmetric**: the structural fix, and the reason the rest can be trusted. `RemoteProvider.ts:65` declares `pull`, `push`, `archive`, and its docblock already states the right principle — *"gate callers on these, never on `kind`"*. Board sync has no such declaration and no test (`ls src/test/ | grep -iE "provider|parity|capab"` returns nothing), so every parity plan was measured against the seam that had one and came up clean. This subtask adds the board-sync capabilities, declares the current truth at all three sites, and adds a contract test that fails on any asymmetry lacking an explicit reviewed exemption — the same shape as the loopback-guard contract test that already holds. **Note before coding:** a boolean per verb cannot distinguish a working implementation from a stub, and `ClickUpRemoteProvider.fetchCommentDeltas` (`:119-121`) returns a hardcoded empty result. The capability granularity and stub detection need revising in this plan first, or the test will rate that asymmetry green.
- **Notion's board sync is misnamed as "backup" and sits outside the provider seam**: `NotionBackupService` creates its own Notion database schema (`:219`) and writes `'Kanban Column'`, `'Status'`, `'Complexity'`, `'Tags'`, `'Is Feature'` and a `'Feature'` self-relation per plan (`:558-575`), then reads it all back in `restoreFromNotion()` (`:96`) keyed on `planId` (`:155`) with feature relations resolved in a second pass (`:173`). That is a two-way kanban board sync wearing the word "backup", outside the seam, invisible to any capability gate. This subtask moves it behind the interface and renames it to name its capability — while migrating the shipped `switchboard.notionBackup` key, four webview message names in lockstep with `setup.html`, and leaving every Notion property name byte-identical, because renaming one orphans every page in a real user's workspace.
- **ClickUp can already be queried by planId but cannot rebuild a board**: the cheap one. ClickUp already persists the identity anchor three ways — a `switchboard:{planId}` tag (`:2976`), a description footer (`:2980`), an optional custom field (`:2986`) — and already looks tasks up by it in `_findTaskByPlanId()` (`:2935`) with `include_closed=true`. `stateKeyToColumn` supplies the column mapping. Only the bulk pass is missing, so this subtask adds it: completeness-checked fetch that refuses to apply a truncated result, additive-only application, resolve-only project names, feature structure second.
- **Linear issues carry no planId, so a board can never be rebuilt from Linear**: the expensive one, and the reason this feature exists in the form it does. Linear persists **no** anchor on the remote object; identity lives solely in `linear_issue_id` (`KanbanDatabase.ts:218`), which is in `kanban.db` — the thing machine loss destroys. So the issues survive and the mapping does not. This subtask adds a durable anchor to what Linear pushes, protects it from content sync stripping it, backfills existing issues while `linear_issue_id` is still available, and then adds the same restore orchestration ClickUp establishes. Title matching is explicitly rejected: titles are user-editable and get renamed during planning, so a title match would confidently attach board state to the wrong card.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [ClickUp can already be queried by planId but cannot rebuild a board — add the restore orchestration](../plans/clickup-board-restore.md) — **PLAN REVIEWED**
- [ ] [Board sync is a seam with no interface — extend RemoteProviderCapabilities to cover it and add the contract test that keeps it symmetric](../plans/provider-capability-board-sync-and-contract-test.md) — **PLAN REVIEWED**
- [ ] [Notion's board sync is misnamed as "backup" and sits outside the provider seam — move it behind the interface without breaking shipped Notion databases](../plans/notion-board-sync-behind-the-seam.md) — **PLAN REVIEWED**
- [ ] [Linear issues carry no planId, so a board can never be rebuilt from Linear — add the anchor, then the restore](../plans/linear-board-restore-and-planid-anchor.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Strict order. Each subtask after the first proves it landed by deleting an exemption, not by asserting success.**

1. **Capability interface + contract test first.** Everything else is measured by it. Landing an implementation before the test exists reproduces exactly the failure this feature fixes — correct code with nothing holding the invariant.
2. **Notion behind the seam second.** It is a move, not a build: the implementation already exists and works. Doing it before the two new implementations means the interface is validated against working code rather than against something written to fit it.
3. **ClickUp third.** Every primitive exists, so it is the fastest route to two of three providers restorable while the larger change is still in review.
4. **Linear last.** Largest, and the only one needing a remote-side change plus a backfill.

**One hard external dependency:** the Notion subtask must not land before `standalone-durable-session-token.md`'s fail-closed `_checkAuth` fix if any part of it becomes reachable over HTTP — `_checkAuth` currently reads an empty stored token as *allow everything*.

**Two risks that are not sequencing but must not be lost:**

- **Linear's backfill is a one-shot opportunity per install.** It can only match issues to plans while `linear_issue_id` still exists locally, so it must run automatically on upgrade rather than behind a button a user finds later. A user whose DB is already gone cannot be recovered from Linear at all, and the UI must say so rather than implying otherwise.
- **The Notion subtask touches working code with roughly 4,000 installs behind it.** It is the only board restore that exists today; a regression there removes the capability while claiming to formalise it.

**Out of scope, deliberately:** ClickUp's `archive: false` is a pre-existing asymmetry carried as an exemption and not closed here — it may be a genuine platform limitation rather than unbuilt work, which is why the exemption mechanism must distinguish those two reasons. Notion's absent `ResearchSourceAdapter` (Linear and ClickUp both implement it) is a real gap this feature only makes *visible*; closing it is separate work.

