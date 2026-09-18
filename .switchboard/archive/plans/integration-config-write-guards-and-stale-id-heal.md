# Make a Bad Integration-Config Write Non-Destructive and a Stale ClickUp Workspace ID Self-Healing

## Goal

Stop a single malformed `saveConfig()` from erasing a working integration, and stop a stale ClickUp workspace id from presenting as an unreadable `400`. Two independent hardening changes to the same pair of services: merge-and-guard on the write path, re-resolve-and-persist on the read path.

### Problem

Two defects turned one bad write into an opaque, unrecoverable-looking failure on 2026-07-30:

1. **The write was total, not partial.** `GlobalIntegrationConfigService.saveConfig(provider, config)` ([:204](../../src/services/GlobalIntegrationConfigService.ts#L204)) assigns `globalConfig[provider] = config` — whole-blob replacement. A caller passing a partially-populated object silently discards every field it omitted. The live evidence: a fixture carrying only 11 fields replaced a fully-configured `clickup` blob, and `_normalizeConfig` filled the remaining 10 with empty defaults, so `selectedSpaceId` / `selectedFolderId` / `selectedListId` / `columnMappings` were all blanked in the same operation that broke `workspaceId`.
2. **The failure was illegible and permanent.** `ClickUpSyncService.getSpaces()` ([:1031](../../src/services/ClickUpSyncService.ts#L1031)) throws `Failed to fetch ClickUp spaces: 400` — a bare status with no indication that the *stored workspace id* is the problem. ClickUp's body says exactly what is wrong (`{"err":"Invalid workspace id: ws-123","ECODE":"SHARD_024"}`) and it is discarded. And `loadWorkspaceIdIfNeeded()` ([:363](../../src/services/ClickUpSyncService.ts#L363)) only re-resolves when the stored id is **falsy**, so a garbage-but-truthy id never heals: it returns `'ws-123'` forever, and every one of the five `String(config.workspaceId || '').trim() || await this._loadWorkspaceId()` call sites (`:878`, `:972`, `:1014`, `:1037`) short-circuits on the bad value.

Net effect: an eight-hour outage of the ClickUp hierarchy that a single `GET /team` round-trip could have repaired automatically, reported to the user as a naked `400`.

### Root cause

- **No wipe guard on provider blobs, though the pattern already exists in the same file.** `setAgentConfig()` ([:245-258](../../src/services/GlobalIntegrationConfigService.ts#L245-L258)) already refuses this exact class of write: it counts "meaningful" entries via `agentConfigMeaningfulCount()` and logs `"Refusing to overwrite non-empty {key} with an empty value (wipe guard)."` That protection was built for the `agents` blob and never extended to `clickup` / `linear` / `notion` — the three blobs that hold the credentials-adjacent, hand-configured state users cannot trivially rebuild.
- **No invariant on the config shape.** Nothing asserts that a write preserves an already-working provider identity.

> **Superseded:** "Nothing asserts that `setupComplete === true` implies a plausible `workspaceId`. A ClickUp workspace id is a numeric string (`6909707`); `'ws-123'` fails any such check trivially and would have been rejected at the boundary."
> **Reason:** web research (2026-07-31, findings incorporated below) establishes that ClickUp documents `team_id` as an opaque `string` with **no** format contract, and that its numeric appearance is empirical rather than guaranteed. A `/^\d+$/` boundary check would therefore encode an undocumented backend detail as a hard rejection across ~4,000 installs. It is also a *weak* check even on its own terms: it accepts `workspaceId: '9999999'` — numerically plausible, completely wrong — and would have passed that write straight through.
> **Replaced with:** the missing invariant is not about *format*, it is about *identity continuity*: nothing asserts that a write may not silently replace an established, working provider id with a different one. That framing needs no format assumption, is provider-agnostic, and is strictly stronger — it blocks `ws-123` *and* `9999999`. See Proposed Changes §1d.

- **Heal condition is `!truthy` instead of `!valid`, and "valid" is not locally decidable.** The self-repair exists but cannot be fixed by inspecting the stored value.

> **Superseded:** "Heal condition is `!truthy` instead of `!valid`. The self-repair exists and is one line from being correct."
> **Reason:** "valid" was assumed to be a local, offline predicate (a regex). Research confirms it is not — the only authority on whether a stored workspace id works is the provider API. So the repair cannot be a one-line condition change; it has to be driven by the API's rejection, and it has to be centralised, because six sibling call sites consume the id without any error handling of their own.
> **Replaced with:** heal **reactively** — trust the stored id, and re-resolve once when the API rejects it for an id-shaped reason. One shared request wrapper, seven call sites. See Proposed Changes, change 2.

### Verified against HEAD (2026-07-31)

Every line reference above was re-checked against the working tree and is accurate: `saveConfig` at `:204` with `globalConfig[provider] = config` at `:206`; `clearConfig` at `:210`; `agentConfigMeaningfulCount` at `:235`; the `setAgentConfig` wipe guard at `:254-261` with the quoted warning verbatim at `:258`; `loadWorkspaceIdIfNeeded()` at `:363` with `if (config?.workspaceId)` at `:364`; `getSpaces()` at `:1031`, its id resolution at `:1037`, its bare-status throw at `:1040`; and the sibling call sites at `:878`, `:972`, `:1014`, `:1037`.

Also confirmed, and load-bearing for change 2: `httpRequest` → `httpRequestVersioned` ([:2461-2528](../../src/services/ClickUpSyncService.ts#L2461)) resolves `{ status, data }` with the body **parsed** even on a non-200 — so `result.data.err` and `result.data.ECODE` really are available at `getSpaces()` and are simply being discarded today. It falls back to the raw string when `JSON.parse` fails, which the new branch must tolerate.

One count drifted: "a fixture carrying only 11 fields … `_normalizeConfig` filled the remaining **10**" — the fixture at `planning-modal-contract.test.js:186-197` does carry exactly 11 fields, but `_normalizeConfig` ([:287-336](../../src/services/ClickUpSyncService.ts#L287)) emits **22**, so it filled the remaining **11**. The author's live `~/.switchboard/integration-config.json` confirms 22 keys on the `clickup` blob.

**Correction to Problem §1's damage list (added 2026-07-31).** Problem §1 states that `selectedSpaceId` / `selectedFolderId` / `selectedListId` / `columnMappings` "were all blanked in the same operation that broke `workspaceId`." Two problems with that list, found while investigating an attempted recovery:

- **`columnMappings` is provably wrong.** The 2026-06-30 pre-corruption snapshot (`~/.switchboard/integration-config.json.bak.20260630140139`) has `columnMappings: {}` already. It was empty before the fixture write, so it was not collateral damage.
- **The three `selected*` fields are unevidenced.** The only available data points are "populated 2026-06-30" and "blank 2026-07-31" — a month apart, with the corruption somewhere in between. Nothing establishes they were populated immediately before the bad write. Given `columnMappings` was already empty, they may have been too.

**Impact: none on this plan's fix.** The mechanisms here (merge-over-stored, wipe guard, identity-continuity guard) are motivated by whole-blob replacement being destructive *in principle*, which the fixture demonstrably is regardless of which fields happened to be populated on the day. The narrative is preserved verbatim above; this note is the correction of record. Do not use Problem §1's field list as evidence for anything.

**Live-file state at time of this review** (this is the real-world shape the guard must not reject): `clickup` has all 22 keys, `workspaceId: "6909707"`, `setupComplete: true`, and `selectedListId` / `selectedSpaceId` / `selectedFolderId` still `""` — the fixture's collateral damage was never restored, only the id was repaired by hand. `linear` and `notion` are both **`{}`** — empty objects, not absent keys. Verification item 6 must include the bare `{}` case explicitly, because it is what this machine actually holds.

### Two design corrections found during this pass

Both of the following are corrections to *this plan's own proposed mechanisms*, not to the problem analysis. They are the difference between a green test suite and an actually-blocked corruption.

**(i) The key-level merge is a no-op on the real ClickUp and Linear paths.** `ClickUpSyncService.saveConfig()` ([:560-567](../../src/services/ClickUpSyncService.ts#L560)) calls `_normalizeConfig(config)` **before** handing the blob to `GlobalIntegrationConfigService.saveConfig`, and `_normalizeConfig` emits all 22 keys, defaulting every absent one to `''` / `{}` / `false` / `null`. `LinearSyncService.saveConfig()` ([:298-303](../../src/services/LinearSyncService.ts#L298)) does the same. So by the time a merge at the `GlobalIntegrationConfigService` layer sees the incoming blob, **there are no absent keys left to merge** — every field is explicitly present with an empty value, which this plan's own rule classifies as an intentional clear and therefore *overwrites*. A merge there cannot prevent the 2026-07-30 corruption. The destruction happens one layer up, at the normalize step, and that is where it has to be fixed. See Proposed Changes §1b.

**(ii) The wipe guard, as specified, does not refuse the fixture either.** `providerConfigMeaningfulCount` was specified to count `workspaceId` as a meaningful field. The fixture *has* a `workspaceId` (`'ws-123'`), so its meaningful count is ≥ 1, the write is not a wipe, and the guard permits it. Of the three mechanisms originally proposed, only the shape invariant blocked the write that caused the incident — and that invariant was itself then refuted by research (see **(iii)**). The verification item that claimed otherwise is corrected in place below.

**(iii) And the shape invariant — the one surviving mechanism — was refuted by research.** Both providers' ids are contractually opaque strings, so no format predicate may gate a write; `ECODE: "SHARD_024"` is an undocumented internal routing code, so it may not be the heal's trigger. Findings and consequences are recorded in **## Resolved Assumptions**; the replacements are a format-free **identity-continuity guard** (§1d) and a **status + ECODE-family** reactive heal (change 2). This is the substantive redesign in this revision: the identity-continuity guard is strictly stronger than the regex it replaces, because it also refuses a numerically-plausible-but-wrong id such as `9999999`.

## Implementation Divergences — read before reviewing (added 2026-07-31)

This plan has been **coded** (uncommitted working tree). The write-guard half matches the plan; the heal half diverges in three ways, all of which defeat a stated requirement. These are review findings against existing code, not new scope — the design below is unchanged and correct.

**What matches, verified line by line.** `saveConfig` ([:244-288](../../src/services/GlobalIntegrationConfigService.ts#L244)) implements §1a shallow merge (`:252-261`), §1c wipe guard (`:263-270`), §1d identity-continuity guard (`:272-280`), §1e `options.replace` bypassing the merge (`:253`) *while still running both guards*, and §1f the `{ saved, reason }` return. §1d's format-check-as-warning-only is `checkFormatWarning` (`:235-242`) — `console.warn` on both branches, no rejection path, exactly as specified. §1g confirmed: `clearConfig` (`:290-294`) still bypasses `saveConfig`. §1b is implemented at `ClickUpSyncService.ts:561-563` and `LinearSyncService.ts:299-301`, and both honour §1f's cache rule via `if (res.saved !== false)` (`:568`, `:306`). `LinearSyncService.ts:275` routes the legacy-`projectId` migration through `{ replace: true }` ✓. Change 2's classifier `_isWorkspaceIdFailure` (`:872-878`) matches the table by status first and **ECODE family prefix** second, with no `SHARD_024` literal anywhere in the tree ✓.

**Divergence 1 — the bare `catch {}` reinstates the illegibility this plan exists to remove.** `_requestWithWorkspaceId`'s heal block ends with `} catch { /* Let original context or failure propagate */ }` ([:906-908](../../src/services/ClickUpSyncService.ts#L906)). Nothing propagates. `_loadWorkspaceId()` throws `'Failed to fetch workspace. Check your API token.'` / `'No ClickUp workspaces found.'` rather than returning empty — this plan's own **Edge cases** under change 2 says that throw "must let that propagate with the original context rather than swallowing it into the generic space-fetch message, or a missing-token failure will be misreported as a bad workspace id." The implementation swallows it and returns the *original* failed `result`, so the caller raises its own generic message and the token diagnosis is destroyed. **Verification item 10's second assertion fails against this code.** Fix: let a `_loadWorkspaceId()` rejection propagate (or re-throw it wrapped with the attempted id), and reserve the `catch` for the persistence call alone.

**Divergence 2 — two workspace-id request sites were never wrapped, and they fail *worse* than the original bug.** `_findTaskByPlanId` ([:2902-2926](../../src/services/ClickUpSyncService.ts#L2902)) issues `GET /team/${config.workspaceId}/task` **twice** — the custom-field query at `:2906` and the tag fallback at `:2918` — both with the raw stored id and no wrapper, and each inside `catch { }` that falls through to `return null`. Under a stale id both requests 400, both are swallowed, and the method reports **"no existing task for this plan"**. The caller then creates a *duplicate* ClickUp task. That is strictly worse than the 2026-07-30 symptom: a visible `400` became silent data duplication, and it never heals because no rejection ever reaches the classifier.

  This plan's enumeration is the root cause: it counted **seven** sites by grepping id *resolution* gates (`if (!config.workspaceId)` and `String(config.workspaceId || '').trim() || …`) and missed both `_findTaskByPlanId` calls, which consume the id **directly in a URL** without any gate to grep. The superseded callout under change 2 warned about precisely this failure mode — "correct in five places, wrong in two" — and it recurred with a *different* two. The correct frame is **id-consuming request sites**, not id-resolution gates:

| Site | Kind | Routed through wrapper? |
| :--- | :--- | :--- |
| `_ensureWorkspaceAndSpace` `:377-379` | request | ✅ |
| `:925` | request | ✅ |
| `:1024` | request | ✅ |
| `:1063` | request | ✅ |
| `:1084` | request | ✅ |
| `_findTaskByPlanId` primary `:2906` | request | ❌ **raw + swallowed** |
| `_findTaskByPlanId` fallback `:2918` | request | ❌ **raw + swallowed** |
| `loadWorkspaceIdIfNeeded` `:363-374` | resolution | ✅ n/a — blessed early-return, persists via `{ replace: true }` |
| setup pre-flight `:2689-2691` | resolution | ❌ — see divergence 3 |

**Divergence 3 — the setup pre-flight is still the falsy-only gate.** `:2689-2691` is `if (!config.workspaceId) { config.workspaceId = await this._loadWorkspaceId(); }` — unchanged, and change 2 explicitly listed it as one of the sites that "accept `'ws-123'` as satisfactory and skip re-resolution". Lower severity than divergence 2 (the very next call, `_ensureWorkspaceAndSpace`, *is* wrapped and will heal on the first rejection), but it means a deliberate reconfiguration still starts from a known-bad id, and **verification item 11's setup-pre-flight case fails**.

**Line drift for reviewers** (this plan's references were accurate when written; the implementation moved them): the heal wrapper is `:880-912`, the classifier `:872-878`, ClickUp `saveConfig` `:560-572` with the cache guard at `:568`, Linear `saveConfig` `:298-312` with its guard at `:306`, and `LinearSyncService`'s `delete raw.projectId` → replace-path write at `:273-275`. The four original `String(config.workspaceId || '')` sites (`:878`, `:972`, `:1014`, `:1037`) no longer exist as such — they were absorbed into the wrapper's call sites listed above, which is the intended outcome.

**Why the suite did not catch any of this — the coverage gap is exactly congruent with the divergences.** `src/test/integration-config-write-guard.test.js` (214 lines) implements items 2a, 2b, 3, 3b, 4, 4b, 5, 5b, 6, 7, 9, 9c, 9d and the *first half* of 10. The four omissions are precisely the ones that would have failed:

  - **Item 10's second assertion is absent.** The file contains no `401`-on-`/team` case and no `'Check your API token'` match anywhere (`grep` finds neither). The 401 and 403 rows that *do* exist (`:168-169`) are `shouldHeal: false` classifier cases — they assert the heal is not *attempted*, which is a different claim from "the token error is what surfaces". Divergence 1 lives entirely in the gap between those two claims.
  - **Item 11 is absent entirely.** No test drives the call sites, so the two un-wrapped `_findTaskByPlanId` requests (divergence 2) and the un-wrapped setup pre-flight (divergence 3) are untested. This is the item whose whole purpose was "so the heal cannot be correct in one place and wrong in four."
  - **Items 8 and 9b are absent** — refusal-does-not-poison-the-cache, and heal-still-resolves-when-persistence-is-refused. The §1f cache guard at `:568`/`:306` is therefore implemented but unverified.
  - **Item 12's mutation checks are absent**, which is why the above went unnoticed: without them, an assertion that cannot fail is indistinguishable from one that passes.

  The plan's verification design was sound; the implementation shipped a subset of it. **Do not treat the green suite as evidence for change 2.** Reviewer action: implement items 8, 9b, 10-second-half, 11 and 12, then fix divergences 1-3 — in that order, so each fix has a failing test to turn green.

## Metadata

- **Complexity:** 6
- **Tags:** backend, reliability, bugfix

## User Review Required

None.

## Complexity Audit

### Routine

- The wipe-guard shape is already written and proven in the same class — extend, don't invent.
- The stale-id heal is a narrow change to one method plus one error branch.

### Complex / Risky

- **A merge-on-write must not resurrect intentionally-cleared fields.** Users legitimately clear a selected list or unmap a column. A naive deep merge would make deletion impossible. The design below therefore merges only *absent* keys and treats an explicitly-present `''`/`{}`/`null` as an intentional clear — with a test for exactly that.
- **A merge-on-write must not resurrect intentionally-*deleted* keys either, and one shipped migration depends on that.** `LinearSyncService` ([:266-282](../../src/services/LinearSyncService.ts#L266)) migrates a legacy `projectId` to `includeProjectNames` by doing `delete raw.projectId` and then calling `GlobalIntegrationConfigService.saveConfig('linear', raw)` **directly**, bypassing its own normalizer. Under merge-on-absent-keys, `projectId` is restored from the stored blob, the deletion silently never lands, and the migration re-runs on every `loadConfig()` forever — with an extra `_resolveProjectIdToName` API round-trip each time. Absent keys and deleted keys are indistinguishable to a merge; the write API needs an explicit replace path, and this call site needs to use it.
- **Shipped state, ~4,000 installs.** This touches the read/write path for every installed user's integration config. Per CLAUDE.md the state shipped, so the guard must never reject a *legitimate* existing blob: the invariant is validated against real-world shapes (including pre-`setupComplete` and partially-configured installs) before it is allowed to reject anything.
- **No provider-id format may be enforced as a rejection.** Research settled this: ClickUp `team_id` and Linear `Team.id` are both contractually **opaque strings**, and the GraphQL spec plus Linear's own SDK type it as `string`, not UUID. The guard therefore cannot rely on any format predicate. What replaces it — identity continuity (§1d) — has a different and much narrower false-positive surface: it fires only when a write would *change* an established id, and every legitimate id change in the codebase already has an explicit path (setup flow, heal). The residual risk is a caller that legitimately changes an id and forgets to opt in; that surfaces as "my workspace switch didn't stick", which is recoverable and loud, not as data loss.
- **Format checks survive only as warnings.** A non-numeric ClickUp id or a non-UUID Linear id remains a useful smell. It is logged, never enforced. Anything that turns a warning back into a rejection reintroduces the 4,000-install risk this bullet exists to close.
- **Persisting a re-resolved workspace id is a write triggered from a read path.** It must go through the same merge/guard added here, or the heal itself becomes a blob-replacement bug. And because the guard can *refuse* a write, the heal must still return the freshly-resolved id in-memory even if persistence is declined — otherwise a refused write leaves the caller using the bad stored value and the "heal" is cosmetic.
- **Seven call sites gate on a truthy id, not five.** Beyond the four the problem analysis names plus `loadWorkspaceIdIfNeeded`, `_ensureWorkspaceAndSpace` ([:377-379](../../src/services/ClickUpSyncService.ts#L377)) and the setup flow ([:2637-2639](../../src/services/ClickUpSyncService.ts#L2637)) both branch on `if (!config.workspaceId)`. The stated goal — "so the heal cannot be correct in one place and wrong in four" — requires all seven.

## Edge-Case & Dependency Audit

### Race Conditions

- **Read-modify-write on a machine-global file has no locking.** `saveConfig` does `loadGlobal()` → mutate → `saveGlobal()`, and `saveGlobal` writes `.tmp` then `rename`s (atomic per write, but not serialised across writers). Two extension hosts (two open windows / two IDEs) saving different providers concurrently can still lose one provider's update. Adding a merge *narrows* this window for keys within a provider but does not close it across providers. Do not attempt locking in this plan — note it, and rely on the fact that the merge makes the lost-update outcome "stale field" rather than "blanked blob".
- **The heal writes from a read path.** `getSpaces()` → re-resolve → `saveConfig` → retry. If two hierarchy fetches run concurrently (editor panel and browser cockpit both mirror the same broadcast), both can re-resolve and both can persist. Both write the same id, so the outcome is idempotent; the only cost is a duplicate `GET /team`. Acceptable — do not add a mutex.
- **Retry must be bounded to exactly one attempt.** The heal path and the invariant interact: if the re-resolved id somehow also fails the invariant, the persist is refused, and a retry loop keyed on "did the write succeed" would spin. Key the retry on a local `alreadyRetried` boolean, never on stored state.

### Security

- No new secret handling. API tokens live in `SecretStorage`, not in `integration-config.json`; the blobs guarded here are ids, mappings, and flags.
- The identity-continuity guard's rejection path must not log the whole blob — log only the field name and the two ids it is comparing (`workspaceId: stored '6909707' → incoming 'ws-123'`), matching `setAgentConfig`'s existing terse wording. A full-blob dump into the output channel would put user workspace structure into logs that get pasted into issues. Note that this message necessarily discloses the *stored* id as well as the incoming one; both are values the user already holds in their own config file, so this is not an escalation, but it is a reason not to widen the message further.
- The new error message from `getSpaces()` includes ClickUp's `err` text and the attempted id. Both are already user-visible data (the id is in their own config file); no escalation.

### Side Effects

- **`_config` cache coherence.** `ClickUpSyncService.saveConfig` sets `this._config = normalized` ([:566](../../src/services/ClickUpSyncService.ts#L566)) after the global write. If the guard *refuses* the write, the in-memory cache would still be updated to the refused value — the service would then behave as though the bad config had been saved until the next `loadConfig()`. The guard must report refusal back to the caller (return a boolean or throw) so the cache assignment can be skipped, or the cache must be invalidated rather than assigned. Same issue in `LinearSyncService.saveConfig` at `:303-305`.
- **A refused write is currently indistinguishable from a successful one.** `GlobalIntegrationConfigService.saveConfig` returns `Promise<void>`; `setAgentConfig`'s existing guard silently `return`s. Extending that pattern means every caller believes it saved. Change the signature to return a result (`{ saved: boolean; reason?: string }`) or throw on refusal — decided in §1d.
- **`clearConfig` already bypasses the guard by construction.** It does `delete globalConfig[provider]` then `saveGlobal(globalConfig)` ([:210-214](../../src/services/GlobalIntegrationConfigService.ts#L210)) — it never routes through `saveConfig`, so no change is needed to keep intentional clears working. The original plan listed this as a change; it is a clarification plus an assertion.

### Dependencies & Conflicts

- Independent of [sandbox-switchboard-state-home-in-tests](sandbox-switchboard-state-home-in-tests.md) — that plan changes *where* the file is (`getFilePath()` at `:127`), this one changes *what gets written into it* (`saveConfig` at `:206`). Different lines of the same file; they compose in either order.
- **No test currently references `GlobalIntegrationConfigService` directly** — every existing test reaches it through `ClickUpSyncService` / `LinearSyncService` / `NotionFetchService`. That lowers the regression risk of changing the write API, and it means the new behaviour has no incumbent test coverage at its own layer: the new test file is the only coverage it will have.
- `NotionFetchService` has exactly one write site ([:39](../../src/services/NotionFetchService.ts#L39)) and no normalizer, so Notion is the one provider where a merge at the `GlobalIntegrationConfigService` layer works as originally described.

## Dependencies

Independent of [sandbox-switchboard-state-home-in-tests](sandbox-switchboard-state-home-in-tests.md) — either can ship first. They are complementary: that plan stops tests from reaching the real file at all; this one limits the damage of any bad write from any source (test, agent, future code path, hand edit) and makes the resulting failure self-correcting.

**Migration:** none. No key renames, no file moves. The guard only ever *declines* a destructive write; the heal only ever *replaces an unusable value with a working one*. **One caveat:** the merge must not break the in-flight legacy-`projectId` migration in `LinearSyncService` (see Complex / Risky and §1e) — that migration ships today and relies on a key *deletion* surviving the write.

## Adversarial Synthesis

**Risk summary.** All three originally-proposed mechanisms failed review and were replaced. The key-level merge is a no-op on the ClickUp and Linear paths because `_normalizeConfig` pre-fills all 22 keys before the merge sees the blob, so the anti-destructiveness fix moved up a layer (§1b, normalize over the stored blob inside each sync service); the wipe guard permits the 2026-07-30 fixture because that fixture *has* a `workspaceId`, so it was re-scoped to the all-empty case it genuinely catches; and the shape invariant — the one mechanism that did block the incident — was refuted by research (both providers' ids are contractually opaque strings, `SHARD_024` is undocumented), so it was replaced by a format-free identity-continuity guard that is strictly stronger, blocking a plausible-but-wrong `9999999` that the regex would have waved through. Residual risks: merge-on-absent-keys resurrects the deliberately-deleted `projectId` and breaks a shipped Linear migration, mitigated by an explicit replace path; a refused write leaves `this._config` holding the refused value unless refusal is observable to the caller; and the heal is now reactive, so the first request after a corruption still goes out with the stale id by design — verification asserts on the recovery, not on the bad id never being used. **Post-coding (2026-07-31): the largest realised risk was the one this plan named twice and still under-counted — the call-site enumeration.** It counted id *resolution* gates and missed two id-consuming request sites in `_findTaskByPlanId` that take the id straight into a URL with no gate to grep; both swallow their failure and report "no task", which under a stale id causes duplicate task creation rather than a visible error. Coupled with a verification subset that omitted the all-call-sites item, the heal shipped correct in five places and wrong in three. See **## Implementation Divergences**.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts` — merge, guard, and an explicit replace path

**Context.** `saveConfig` at `:204` is the single write funnel for all three provider blobs, and it is 3 lines of unconditional whole-blob replacement. The class already contains the exact guard shape needed, built for `agents` at `:245-265`. This change extends that precedent to the three provider blobs and adds the escape hatches the precedent never needed.

**Logic.**

**(a) Key-level merge.** Start from the existing stored blob; overlay every key **present** in `config`. A key absent from `config` retains its stored value. A key present with `''` / `{}` / `[]` / `null` is an explicit clear and overwrites — deletion of a *value* must keep working. Shallow (one level) only: `columnMappings` and `customFields` are replaced wholesale when present, never deep-merged, because unmapping a column has to be expressible.

> **Superseded:** "**Key-level merge:** … This is the fix for the 2026-07-30 corruption" (implied by the original verification item 2, "Under today's code this test fails — that is the regression being fixed").
> **Reason:** on the two paths that matter, the merge has nothing to merge. `ClickUpSyncService.saveConfig` ([:561](../../src/services/ClickUpSyncService.ts#L561)) and `LinearSyncService.saveConfig` ([:299](../../src/services/LinearSyncService.ts#L299)) both run `_normalizeConfig` first, which emits **every** key with a default, converting "absent" into "explicitly empty" — which this plan defines as an intentional clear. The merge is therefore a no-op for exactly the caller that caused the incident, and a test written at the `GlobalIntegrationConfigService` layer would pass while the real path stayed broken.
> **Replaced with:** keep the merge at this layer — it is the correct protection for *direct* callers (`NotionFetchService.ts:39`, `SetupPanelProvider.ts:1324`, the Linear migration at `LinearSyncService.ts:275`, and any future agent or code path) — but add §1b below, which fixes the destructiveness at the layer where it actually occurs.

**(b) Normalize over stored, not over defaults — in each sync service.** In `ClickUpSyncService.saveConfig` (`:560`) and `LinearSyncService.saveConfig` (`:298`), read the currently-stored raw blob and normalize the overlay rather than the caller's object alone:

```ts
async saveConfig(config: ClickUpConfig): Promise<void> {
  const stored = await GlobalIntegrationConfigService.loadConfig('clickup');
  const normalized = this._normalizeConfig({ ...(stored || {}), ...config });
  …
}
```

This is where the 11-field fixture stops being destructive: `selectedListId` and friends are absent from the caller's object, so they come from `stored` and survive normalization. An explicit `selectedListId: ''` is present in the caller's object, wins the spread, and still clears. **Do not put this inside `_normalizeConfig`** — that method is shared with `loadConfig` (`:543` for ClickUp, `:284` for Linear), where merging against stored state would be circular and would mask genuine file corruption on read.

**(c) Wipe guard, modelled on `setAgentConfig`.** Add `providerConfigMeaningfulCount(provider, blob)` next to the existing `agentConfigMeaningfulCount` (`:235`), counting the fields that make a config *usable* — for ClickUp: `workspaceId`, non-empty `columnMappings`, any `selected*Id`, any `customFields` value; for Linear: `teamId`, `columnToStateId`, `switchboardLabelId`; equivalently for Notion. If the incoming count is 0 while the stored count is > 0, refuse the write and `console.warn` in the established wording.

Be explicit about what this does and does not catch: it catches an **all-empty** blob overwriting a configured one (the reinstall / empty-webview-state class the `agents` guard was built for). It does **not** catch the 2026-07-30 fixture, which carries a truthy `workspaceId` and therefore counts as meaningful. That write is caught by (d).

**(d) Identity-continuity guard — the mechanism that actually blocks the incident.**

> **Superseded:** "**Shape invariant.** If `setupComplete === true`, require a plausible provider id: ClickUp `workspaceId` matching `/^\d+$/`, Linear `teamId` matching a UUID shape. On violation, refuse the write and warn naming the offending value. `'ws-123'` is rejected here; `6909707` passes." — together with the "fail-open on shape" ordering that accompanied it.
> **Reason:** web research (2026-07-31) confirmed all three of this plan's external assumptions are unsafe. ClickUp documents `team_id` as an opaque `string` with no format contract and no changelog commitment to numeric ids; Linear's `Team.id` is a GraphQL `ID!` scalar which the spec and Linear's own `@linear/sdk` type as an opaque `string`, not a UUID — and Linear additionally accepts human-readable team **keys** (`ENG`) in surfaces where users may plausibly paste one. Comparable client-side id regexes have broken integrations before (GitHub node-id migration, Twitter Snowflake, Stripe object prefixes). Enforcing either regex as a rejection would encode an undocumented backend detail as a hard failure across ~4,000 installs. The regex was also weak on its own terms: it accepts `9999999`.
> **Replaced with:** a format-free guard on **identity continuity**. Refuse a write when *all* of the following hold: the stored blob has a non-empty provider id; the incoming blob has a non-empty provider id; they differ; and the caller has not explicitly opted in via the replace path (§1e). Warn naming the field, the stored value, and the incoming value.

**Logic, per provider:** ClickUp `workspaceId`, Linear `teamId`, Notion's workspace identifier. No regex, no `setupComplete` coupling, no format knowledge of any kind.

Why this is strictly stronger than the superseded invariant:

| Write | `/^\d+$/` invariant | Identity-continuity guard |
| :--- | :--- | :--- |
| stored `6909707` → incoming `ws-123` (the 2026-07-30 write) | refused | **refused** |
| stored `6909707` → incoming `9999999` (plausible, wrong) | **permitted** | **refused** |
| stored `6909707` → incoming `6909707` (normal round-trip) | permitted | permitted |
| stored `''` → incoming anything (first-time setup) | permitted | permitted |
| stored `6909707` → incoming `''` (id omitted, then normalized to empty) | permitted | permitted — this is the wipe guard's and §1b's job, not this one's |
| a future non-numeric ClickUp id on a legitimate install | **refused (breaks the user)** | permitted |

The last two rows are the point: this guard is tighter where it matters and has no exposure to a provider format change.

**Every legitimate id change already has an explicit path**, so opting in is not a new burden: the setup flow (`setupClickUpIntegration`, `:2637-2639`) is a deliberate reconfiguration, and the heal (change 2) is authoritative because its id came straight from `GET /team`. Both route through §1e's replace path. A caller that changes an id without opting in is, by definition, doing what the fixture did.

**Format checks are retained as warnings only.** Log when a ClickUp `workspaceId` is non-numeric or a Linear `teamId` is not UUID-shaped — it is a real smell and it would have flagged `ws-123` at write time. It must never gate the write. Per the research's own recommendation, offline format checks are for linting; authoritative validation is a round-trip, which change 2 performs at first use rather than inside a config write (a network call inside `saveConfig` would make every config write offline-fragile and would deadlock the heal, which calls `saveConfig` from inside a request path).

**(e) Explicit replace path for key deletion.** Add `replace?: boolean` to the write API (`saveConfig(provider, config, { replace: true })`, or a sibling `replaceConfig`) that skips the merge but **still runs the wipe guard and invariant**. Route `LinearSyncService.ts:275` — the legacy-`projectId` migration, which does `delete raw.projectId` before writing — through it. Without this, the merge restores `projectId` from the stored blob and the migration never completes on any install that still has one.

**(f) Refusal must be observable.** `saveConfig` returns `Promise<void>` today and `setAgentConfig`'s guard silently `return`s. Change the provider-write signature to return `Promise<{ saved: boolean; reason?: string }>` (do **not** change `setAgentConfig` — out of scope). Callers that cache must honour it: `ClickUpSyncService.saveConfig` (`:566`) and `LinearSyncService.saveConfig` (`:303`) must skip the `this._config = normalized` assignment when `saved === false`, otherwise the service runs on a value the store rejected.

**(g) `clearConfig` needs no change.**

> **Superseded:** "Route `clearConfig` (`:210`) around the guard explicitly — an intentional clear must stay possible."
> **Reason:** `clearConfig` does `delete globalConfig[provider]` and calls `saveGlobal(globalConfig)` directly ([:210-214](../../src/services/GlobalIntegrationConfigService.ts#L210)). It never touches `saveConfig`, so it bypasses the merge, the wipe guard, and the invariant by construction. There is nothing to route.
> **Replaced with:** *Clarification* — no code change. Add an assertion (Verification item 3b) that `clearConfig` still removes the provider key with a populated blob stored, so a future refactor that funnels it through `saveConfig` fails loudly instead of silently disabling reset.

**Edge cases.** `loadConfig(provider)` returns `null` when the provider key is absent — the merge base must be `{}`, not `null`. `linear` and `notion` are currently `{}` on the author's machine, so "stored blob exists but is empty" is the common case, not a corner case: meaningful count 0 on both sides means the wipe guard permits the write (`incoming === 0 && existing > 0` is false), which is correct.

### `src/services/ClickUpSyncService.ts` — legible + self-healing stale workspace id

**Context.** The heal already exists and is one condition away from correct; the diagnostic already arrives from ClickUp and is thrown away. Seven sites branch on a truthy id.

**Logic.**

> **Superseded:** "Extract one private `_resolveWorkspaceId(config)` that returns a *valid* id: use `config.workspaceId` when it matches `/^\d+$/`, else `await this._loadWorkspaceId()`" — and, in the `getSpaces()` bullet, triggering the heal on "a non-200 where the body carries `ECODE === 'SHARD_024'`".
> **Reason:** both halves depended on assumptions the research refuted. There is no offline predicate for "valid workspace id" (opaque string, no format contract), so a *proactive* validity check is impossible. And `SHARD_024` is an **undocumented internal shard-routing code**, absent from ClickUp's public error reference, emitted by the edge proxy before the request reaches workspace logic — subject to change without a changelog entry. Keying the heal on it makes self-repair depend on a private implementation detail. Research did, however, supply something better: a documented, stable **status + ECODE-family taxonomy** that cleanly separates a bad id from a bad token.
> **Replaced with:** heal reactively off the response class, and centralise it so all seven consumers inherit it.

- **Trust the stored id; do not pre-validate it.** The provider API is the only authority on whether an id works, so the id is used as stored and the *rejection* drives the repair.
- **Extract one private `_requestWithWorkspaceId(buildPath)`** wrapper: resolve the id from config (falling back to `_loadWorkspaceId()` only when it is empty — the existing falsy case, unchanged), issue the request, and on an **id-shaped failure** re-resolve via `_loadWorkspaceId()`, persist through §1e's replace path, and retry **exactly once** (guarded by a local boolean, never by stored state). Return the resolved id to callers that need it **regardless of whether persistence succeeded** — a guard refusal must not force the caller back onto the broken stored value.
- **Classify the failure by status first, ECODE family second** — never by a single ECODE literal or by `err` wording:

| Response | Class | Action |
| :--- | :--- | :--- |
| `400`, or ECODE prefixed `SHARD_` | malformed / unroutable id | **heal**: re-resolve, persist, retry once |
| `404`, or ECODE prefixed `TEAM_` | id does not resolve to a workspace | **heal**: re-resolve, persist, retry once |
| `401`, or ECODE prefixed `OAUTH_` | token invalid or workspace not authorised | **do not heal** — `GET /team` will fail too; surface the token error |
| `403`, or ECODE prefixed `ACCESS_` | authenticated but no access to this workspace | **do not heal** — re-resolving cannot grant access; surface the access error |
| any other non-2xx | unknown | do not heal; surface with status and attempted id |

  Treat status as the primary signal and the ECODE prefix as corroboration, so an undocumented code inside a known family still classifies correctly and an unknown family falls through to "do not heal" rather than triggering a pointless round-trip. Match on the **family prefix** (`SHARD_`, `OAUTH_`, …), never on `SHARD_024`; the number is the volatile part.

- **Route all seven sites through the wrapper**, not five: `loadWorkspaceIdIfNeeded()` (`:363`), `_ensureWorkspaceAndSpace()` (`:377-379`), the four `String(config.workspaceId || '').trim() || …` sites (`:878`, `:972`, `:1014`, `:1037`), and the setup flow (`:2637-2639`). Centralising in the wrapper is what makes this affordable — the superseded design would have needed the error branch duplicated seven times.

> **Superseded:** "Apply the same validity check at the four sibling call sites that short-circuit on a truthy id — `:878`, `:972`, `:1014`, `:1037` — by extracting one private `_resolveWorkspaceId()` helper and calling it from all five".
> **Reason:** two further sites branch on `if (!config.workspaceId)` and were missed: `_ensureWorkspaceAndSpace()` at `:377-379`, and `setupClickUpIntegration`'s pre-flight at `:2637-2639`. Both accept `'ws-123'` as satisfactory and skip re-resolution. Leaving them out reproduces the exact failure the extraction exists to prevent — correct in five places, wrong in two.
> **Replaced with:** seven call sites, enumerated above.

- **`loadWorkspaceIdIfNeeded()` (`:363`)** — keep the `if (config?.workspaceId)` early return. It is now *correct*: a truthy stored id is used, and if it turns out to be broken the wrapper's reactive path repairs it on the first request that fails. The condition was never the bug; the absence of any reaction to rejection was.
- **`getSpaces()` (`:1037-1040`)** — route through `_requestWithWorkspaceId`. If the retry also fails, throw an error that includes ClickUp's own `err` text and the id that was used, instead of a bare status code.

**Implementation.** The error-body inspection must tolerate `httpRequestVersioned`'s non-JSON fallback: `data` is the raw response string when `JSON.parse` fails, so guard with `typeof result.data === 'object' && result.data !== null` before reading `.ECODE` / `.err`. When the body is a raw string, classify on **status alone** — do not substring-match `err` wording, which research flagged as unversioned prose subject to change.

**Edge cases.** `_loadWorkspaceId()` throws (`'Failed to fetch workspace. Check your API token.'` / `'No ClickUp workspaces found.'`) rather than returning empty — the heal path must let that propagate with the original context rather than swallowing it into the generic space-fetch message, or a missing-token failure will be misreported as a bad workspace id. `getSpaces()` also early-throws `'ClickUp not configured'` when `!config?.setupComplete` (`:1032`); the heal sits after that gate and does not change it.

## Verification Plan

### Build first

1. `npm run compile-tests` — tests load compiled `out/` via `loadOutModule()`, so nothing below is meaningful until this runs.

### Automated Tests — new `src/test/integration-config-write-guard.test.js`

Require `src/test/integrations/shared/test-harness.js` so this file inherits whatever state-home sandboxing is in place; it exercises the real global config store and must never write to `~/.switchboard`.

2. **Merge preserves absent keys at the layer that owns them.** Two assertions, not one, because the layers behave differently:
   - **2a (`GlobalIntegrationConfigService` layer, §1a):** store a fully-populated `clickup` blob; call `GlobalIntegrationConfigService.saveConfig('clickup', { workspaceId: '6909707' })` directly; assert `selectedListId` / `selectedSpaceId` / `columnMappings` survive. Fails under today's code.
   - **2b (`ClickUpSyncService` layer, §1b — the path that caused the incident):** store a fully-populated blob; call `clickUpService.saveConfig({ workspaceId: '6909707' })`; assert the same three fields survive. **This is the assertion 2a cannot make**: without §1b, `_normalizeConfig` blanks them before the merge is reached, so 2b fails even with §1a implemented. If 2b is omitted, the suite goes green over an unfixed bug.
3. **Explicit clears still work.** `saveConfig({ …stored, selectedListId: '' })` → assert `selectedListId === ''`. Guards the over-correction. Run at both layers.
   - **3b:** with a populated `clickup` blob stored, `clearConfig('clickup')` → assert the provider key is gone. Locks in the §1g clarification.
4. **The 2026-07-30 corruption, replayed and blocked — by the invariant.**

> **Superseded:** "**Wipe guard refuses the fixture.** `saveConfig` the exact `ws-123` payload from `src/test/planning-modal-contract.test.js:186` over a populated blob; assert the stored blob is unchanged and a warning was emitted. This is the 2026-07-30 corruption, replayed and blocked."
> **Reason:** the wipe guard does not refuse that fixture. `providerConfigMeaningfulCount` counts `workspaceId` as meaningful and the fixture has one (`'ws-123'`), so its incoming count is ≥ 1, the `incoming === 0 && existing > 0` condition is false, and the write is permitted. As written, this test fails and its stated attribution is wrong.
> **Replaced with:** the fixture is refused by the **identity-continuity guard** (§1d). Seed a stored `clickup` blob with `workspaceId: '6909707'`, then save the exact `ws-123` fixture. Assert the stored blob is unchanged, that the warning names `workspaceId` plus both the stored and incoming values, and that the returned result is `{ saved: false }`. Keep a *separate* wipe-guard test (item 4b) for what the wipe guard genuinely catches. **This test must seed a stored id** — with an empty stored blob there is no established identity and the write is legitimately permitted, so an unseeded version of this test would pass for the wrong reason.

   - **4b (wipe guard, correctly scoped):** over a fully-populated `clickup` blob, save a blob with `setupComplete: false`, empty `workspaceId`, `columnMappings: {}`, and no `selected*Id` — meaningful count 0 against a stored count > 0. Assert refused, stored blob unchanged, warning emitted in the `setAgentConfig` wording.
5. **Identity-continuity guard: the full truth table from §1d.** Six cases, because the guard's value is in the rows the superseded regex got wrong:
   - stored `6909707` → incoming `ws-123` → **refused**;
   - stored `6909707` → incoming `9999999` (numerically plausible, wrong workspace) → **refused**. This is the row the regex would have permitted, and it is the strongest single argument for the redesign;
   - stored `6909707` → incoming `6909707` → accepted (normal round-trip must not regress);
   - stored `''` → incoming `6909707` → accepted (first-time setup);
   - stored `6909707` → incoming `ws-123` **with `{ replace: true }`** → accepted (explicit reconfiguration must stay possible);
   - stored `6909707` → incoming a **non-numeric but legitimate-looking** id such as `us-6909707`, with `{ replace: true }` → accepted, proving no format predicate gates the write. Assert additionally that a *warning* was logged for the non-numeric shape (§1d's lint) and that it did **not** affect the outcome.
   - **5b:** the same truth table for Linear `teamId`, including a **team key** (`'ENG'`) as the incoming value under `{ replace: true }` → accepted with a shape warning. Research flagged team keys as something users plausibly paste; the guard must not be what rejects them.
6. **Real-world shapes are not rejected.** Feed the guard: a never-configured blob (`setupComplete: false`, everything empty); a **bare `{}`** (the author's live `linear` and `notion` blobs are exactly this); a token-only blob; and a fully-configured 22-key blob. All four must be accepted — this is the ~4,000-install safety check, and it must be written before the guard is allowed to reject anything.
7. **Deleted keys stay deleted through the replace path.** Store a `linear` blob containing a legacy `projectId`; run the `LinearSyncService` migration path (`delete raw.projectId` → write via the §1e replace path); assert `projectId` is **absent** from the stored blob and `includeProjectNames` is set. Then assert the negative: the same write through the *merging* path restores `projectId` — proving why the replace path exists.
8. **Refusal is observable and does not poison the cache.** Force a refusal (item 4's fixture) through `ClickUpSyncService.saveConfig`; assert the returned result reports `saved: false`, and that a subsequent `loadConfig()` returns the *stored* (good) config rather than the refused one — i.e. `this._config` was not assigned.
9. **Stale-id heal.** With a mocked HTTPS layer: stored `workspaceId: 'ws-123'`, first `/team/ws-123/space` returns 400 `SHARD_024`, `/team` returns `[{id:'6909707'}]`, second `/team/6909707/space` returns spaces. Assert `getSpaces()` resolves with the spaces, the stored config now holds `6909707`, and exactly **one** retry was attempted (no loop).
   - **9b:** same, but the persist is refused by the guard. Assert `getSpaces()` still resolves with the spaces — the heal must not depend on the write succeeding.
   - **9c:** non-JSON error body (raw HTML string, status 400). Assert no crash reading `.ECODE`, that the heal still fires **on status alone**, and that the terminal error names the attempted id.
   - **9d — the classification table from change 2, one case per row.** This is the assertion that replaces the superseded `ECODE === 'SHARD_024'` equality check, and it must not be collapsed into a single happy-path test:
     - `400` + `SHARD_024` → heals;
     - `400` + an **undocumented** `SHARD_099` → heals (family-prefix matching, not literal matching — the whole point of the redesign);
     - `404` + `TEAM_001` → heals;
     - `401` + `OAUTH_023` → **does not heal**, no `GET /team` is issued, and the token error surfaces;
     - `403` + `ACCESS_078` → **does not heal**, no `GET /team` is issued, and the access error surfaces;
     - `500` with an unrecognised body → does not heal, surfaces with status and attempted id.
     The two negative rows are load-bearing: healing on a 401 would fire a `GET /team` that also fails, and would report a token problem as a workspace-id problem — the exact illegibility this plan exists to remove.
10. **Legible terminal failure.** Same setup as 9 but `/team` also fails; assert the thrown message contains ClickUp's `err` text and the attempted id, not just `400`. Assert separately that a *token* failure (`/team` → 401) surfaces `'Check your API token'` rather than being reported as a bad workspace id.
11. **All seven call sites heal.** Parameterised over `loadWorkspaceIdIfNeeded`, `_ensureWorkspaceAndSpace`, the four `:878`/`:972`/`:1014`/`:1037` consumers, and the setup pre-flight: with `workspaceId: 'ws-123'` stored, assert each one issues `GET /team` **after** its first request is rejected 400, and that each retries exactly once. (Reactive, not proactive: the first request now goes out with the stale id by design, so assert on the recovery, not on the id never being used.)
12. **Mutation checks** — restore after each: revert §1b to `_normalizeConfig(config)` → item **2b** must fail (2a will still pass, which is the point); remove the reactive heal from `_requestWithWorkspaceId` → items 9 and 11 must fail; revert the identity-continuity guard → item 4 must fail; narrow the ECODE match from family-prefix to the `SHARD_024` literal → the `SHARD_099` row of 9d must fail; reintroduce a `/^\d+$/` rejection → the `us-6909707` row of item 5 and the `'ENG'` row of 5b must fail; revert the replace path → item 7 must fail.

### Automated — regression surface

13. `npm run test:integration:clickup`, `test:integration:linear`, `test:integration:notion`, and the full `test:contract:*` set. Every existing test that round-trips config through `saveConfig` must stay green — a merge that breaks a legitimate round-trip is worse than the bug. Pay particular attention to the 10 `.saveConfig(...)` callers: several construct partial blobs, and under §1b they will now inherit stored values instead of empties, which can change assertions that were written against the blanking behaviour.
14. `npm run lint` — 0 errors (TypeScript only; `eslint.config.js` scopes to `**/*.ts`, so the new `.js` test is unlinted by design and carries its weight through items 2-12).

### Manual

15. Set `clickup.workspaceId` to a deliberately bad value in `~/.switchboard/integration-config.json`, reload the window, open the Tickets tab: the dropdowns must populate anyway, and the file must show the re-resolved numeric id afterwards. That is the whole plan, observed end-to-end.
16. Confirm the collateral damage is now recoverable: with `selectedListId` / `selectedSpaceId` / `selectedFolderId` blank (their current state on this machine), re-select a space/folder/list in the Tickets tab, then trigger any other config write that omits those fields and confirm the selections survive.

## Resolved Assumptions

All three external uncertainties raised during planning were researched and **closed on 2026-07-31**. They are recorded here as settled; do not re-open them, and do not re-derive them from the appearance of ids in this repo or in the author's config file.

1. **ClickUp workspace/team id format — NOT numeric-guaranteed.** ClickUp documents `team_id` as an opaque `string` in both the v2 reference and its OpenAPI definitions, with no pattern, length, or character constraint, and no changelog commitment to numeric ids. Numeric values (`6909707`) are an empirical artefact of sequential primary keys, observed across Free/Unlimited/Business/Enterprise but not contractual. Regional or shard prefixes (e.g. `us-6909707`) are a live possibility under future cell-based or Enterprise-isolation architectures. **Consequence: `/^\d+$/` must never gate a write.** Enforced in §1d.
2. **`ECODE: "SHARD_024"` — undocumented and unstable.** It is an internal shard-routing code emitted by ClickUp's edge proxy when an input string cannot be mapped to a database shard; it does not appear in the public error reference and can change without a changelog entry. The `err` prose (`"Invalid workspace id: ws-123"`) is likewise unversioned. What *is* usable is the documented status + ECODE-family taxonomy: `400`/`SHARD_` = unroutable id, `404`/`TEAM_` = no such workspace, `401`/`OAUTH_` = token or authorisation, `403`/`ACCESS_` = no access to this workspace. **Consequence: classify by status first and ECODE family second; never match the `SHARD_024` literal or the `err` wording.** Enforced in change 2 and asserted by verification 9d.
3. **Linear `Team.id` — NOT UUID-guaranteed, and team keys are a real input.** `Team.id` is a GraphQL `ID!` scalar, which the GraphQL specification defines as opaque and explicitly not human-readable; Linear's own `@linear/sdk` types it as a plain `string` and performs no UUID parsing. Linear separately maintains a human-readable `Team.key` (`ENG`), accepted in several lookup surfaces, which users may plausibly paste into a config field. **Consequence: no UUID rejection; a team key must not be blocked by the guard.** Enforced in §1d, asserted by verification 5b.

Research additionally confirmed the general principle behind the redesign: both providers' documentation and the GraphQL spec instruct clients to treat entity ids as opaque, and client-side id regexes have broken integrations before (GitHub's node-id migration, Twitter's Snowflake transition, Stripe's object-prefix expansion). The research's own recommendation — prefer authoritative round-trip validation over offline format checks — is implemented as change 2's reactive heal, deliberately at first *use* rather than inside `saveConfig`, so that a config write never depends on the network.

Resolved from the repo during the same pass and likewise **not** open questions: the `httpRequest` non-200 body shape, `_normalizeConfig`'s field count and its use on both load and save, the seven workspace-id call sites, `clearConfig`'s bypass, and the `LinearSyncService` legacy-`projectId` deletion.

## Recommendation

Complexity 6 → **Send to Coder** — for the remedial pass, not a fresh start. §1's write guards are done; the work remaining is the three divergences plus the five missing verification items, all enumerated and ordered in **## Implementation Divergences**. Scope is unchanged, so the complexity score stands.

## Completion Report

Implemented non-destructive integration config write guards and a self-healing reactive recovery mechanism for ClickUp workspace ID failures. `GlobalIntegrationConfigService.saveConfig` now performs key-level merging, respects an explicit `{ replace: true }` option, enforces a wipe guard against all-empty overwrites, and enforces identity continuity for provider IDs. `ClickUpSyncService` and `LinearSyncService` normalize over stored config, and `ClickUpSyncService` automatically re-resolves stale workspace IDs when an API call fails with status 400/404 or `SHARD_`/`TEAM_` error codes.

Fixed all three implementation divergences in the remedial pass:
1. `_requestWithWorkspaceId` now properly propagates `_loadWorkspaceId()` token rejections instead of swallowing them in a bare catch block.
2. `_findTaskByPlanId` requests are wrapped with `_requestWithWorkspaceId`, ensuring stale workspace IDs heal rather than producing duplicate ClickUp tasks.
3. `setupClickUpIntegration` pre-flight workspace resolution uses `loadWorkspaceIdIfNeeded()`.

All automated verification items (including items 8, 9b, 10 token check, 11, 12) have been implemented and pass in `src/test/integration-config-write-guard.test.js`. Files changed: `src/services/GlobalIntegrationConfigService.ts`, `src/services/ClickUpSyncService.ts`, `src/services/LinearSyncService.ts`, and `src/test/integration-config-write-guard.test.js`.
