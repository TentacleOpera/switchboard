# Phone-a-Friend: per-instance addressing instead of one global role

## Goal

Make Phone-a-Friend addressable **per originating terminal**, not per role. Today there is exactly one Phone-a-Friend terminal for the whole workspace and the callback identifies its caller only by role name, so every coder shares one reviewer and the host cannot tell which coder called. After this change, `coder-1` and `coder-2` can each have their own friend, a friend can be attached to a specific terminal rather than a whole role, and every dispatch carries the instance identity of its caller.

This is the smallest independently-shippable piece of the subagent work. It is worth doing on its own merits — the role-level ambiguity is a live defect once more than one coder runs.

> **Superseded:** "…and it establishes the caller-identity and per-target-locking primitives the subagent contract needs."
> **Reason:** Verified against source during the feature-level reconciliation pass and it is false. This plan operates entirely on `vscode.Terminal` objects — `_dispatchPhoneAFriend` resolves and delivers with `allowPtyFleet=false`, and `TaskViewerProvider.ts:4673` states outright that such a target "is always a `vscode.Terminal`". Subagent children are **node-pty handles owned by a separate pty host child process** (`src/standalone/ptyHost.ts`; `TaskViewerProvider.ts:24-28`: *"the fleet itself, the WebSocket gateway and the prompt-delivery helpers now live in the pty host child. The extension is control plane: it never constructs a fleet and never sees terminal bytes."*). A per-instance map keyed on `vscode.Terminal` display names establishes nothing reusable for a pty fleet in another process. The identity primitive for the contract is defined in `feature_plan_20260805180001` against `PtyFleetService`, not here.
> **Replaced with:** This plan is **independent** of the subagent contract. It shares the *shape* of an idea (address instances, not roles) but no code, no config key, and no primitive. Sequence it wherever convenient; nothing in `…180001` or `…180002` waits on it.

### Problem analysis & root cause

**How it works today.**

1. `phoneAFriend?: boolean` is a per-role addon flag (`agentConfig.ts:38`), sanitized on load at `agentConfig.ts:266` (`if (s.phoneAFriend === true) a.phoneAFriend = true;` — a truthy-only carry).
2. When set, `PHONE_A_FRIEND_DIRECTIVE(port)` is appended to the coder/lead/intern prompt (`agentPromptBuilder.ts:597`, consumed at `:1101`; also `KanbanProvider.ts:4646` for the custom-agent path). The API port is interpolated at build time so worktree CWDs don't have to read the port file.
3. The agent curls `POST /phone-a-friend` with `{ planFile, originRole }` when its batch ends (route: `LocalApiServer.ts:3612`, documented at `:2008`).
4. `TaskViewerProvider` receives it at `:2375` (`await this._dispatchPhoneAFriend(planFile, originRole || 'coder')`) and `_dispatchPhoneAFriend` (`:4560`) resolves the target at `:4572`:

```ts
const agentName = await this._getAgentNameForRole('phone_a_friend', resolvedWorkspaceRoot) || 'Phone-a-Friend';
```

**Four consequences, all from the same root cause — role is the only identity in the system.**

- **One friend, workspace-wide.** `_getAgentNameForRole('phone_a_friend', …)` (defined at `:8219`) is a singleton lookup. Ten coders resolve to the same terminal. You cannot give `coder-2` a different friend from `coder-1`, and you cannot attach a friend to one terminal without attaching it to the whole role.
- **The caller is unidentifiable.** The payload carries `originRole: 'coder'` — a role, not an instance. With several coders running, the second-pass prompt cannot say *whose* work it is reviewing beyond the plan file, and the host cannot route a reply back even in principle.
- **The role in the payload is a hardcoded literal, so even the role is wrong.** `PHONE_A_FRIEND_DIRECTIVE` emits `-d '{"planFile":"<PLAN_FILE_PATH>","originRole":"coder"}'` as a **constant string**. The builder never interpolates the role it is building for, so a `lead` or `intern` with the addon enabled reports itself as `coder`. The receiving end at `:2375` then applies `originRole || 'coder'`, which cannot correct it because the field is populated and merely wrong. Identity is not just coarse — it is falsified for two of the three roles that can enable the addon. *(Found during the feature reconciliation pass; not previously recorded in this plan.)*
- **All dispatches serialize globally.** `_phoneAFriendInFlight` (`:689`; chained at `:4562`, assigned `:4620`, cleared `:4624-4625`) chains every dispatch behind every other one, because they all land in the same terminal. That is correct given one target and wrong the moment there are several: two coders finishing simultaneously should be able to notify two different friends concurrently, and today the second waits on the first.

**Not a bug in the dispatch mechanics.** The `/clear`-then-prompt sequence, the deliberate omission of a Stage Complete marker (a continuation must not trigger a second stage-advance), and the must-not-throw contract on a missing terminal are all correct and stay. Only addressing changes.

**Why the silent-drop contract stays here.** `_dispatchPhoneAFriend` deliberately drops with a diagnostics line when no terminal is running, because a throw becomes a 500 and the directive tells the agent the call succeeds regardless ("if the Phone-a-Friend agent is not running, the request will still succeed silently, but you must send it regardless"). That is right for a best-effort nudge and must NOT be copied into the subagent work, where a parent blocking on a child that was never dispatched hangs forever. The two failure models are opposites on purpose — see `feature_plan_20260805180001_subagent-contract-and-join`.

**Which terminal universe this plan lives in.** `vscode.Terminal`, exclusively. Every symbol this plan touches — `_dispatchPhoneAFriend`, `_getAgentNameForRole`, `_suffixedName`, `_stripIdeSuffix`, `_normalizeAgentKey` — resolves against `vscode.window.terminals`. The pty fleet is explicitly excluded by the `allowPtyFleet` predicate (`:8222`: `allowPtyFleet || !(info?.purpose === 'pty' || info?.ideName === PTY_IDE_NAME)`), which defaults to `false`. State this in the implementation so nobody "helpfully" generalises this plan onto the pty fleet and couples it to the subagent contract.

## Metadata

- **Complexity:** 5
- **Tags:** feature, backend, reliability

## User Review Required

None. The three decisions this plan could have deferred are made below: config shape (per-instance overrides layered over the role flag), fallback behaviour (instance → role → workspace singleton), and locking granularity (per target terminal).

## Complexity Audit

**Moderate.** No new subsystems; it re-keys an existing one.

### Routine

- Adding an optional field to the `AgentAddons` interface (`agentConfig.ts:38` neighbourhood) and a matching sanitizer clause at `:266`.
- Extending `PHONE_A_FRIEND_DIRECTIVE`'s signature and its two call sites (`agentPromptBuilder.ts:1101`, `KanbanProvider.ts:4646`).
- Passing two extra fields through the `POST /phone-a-friend` route (`LocalApiServer.ts:3612`) into `onPhoneAFriend`.
- Reusing the existing name-normalisation helpers rather than writing new matching logic.

### Complex / Risky

| Area | Why it costs |
|---|---|
| Config shape + migration | `phoneAFriend: boolean` has shipped. ~4,000 installs, many on older versions. The new shape must read the old one, not replace it. The flag lives in **two** places that must stay consistent: the TS interface + sanitizer (`agentConfig.ts:38`, `:266`) and the webview defaults (`sharedDefaults.js` `DEFAULT_ROLE_CONFIG`, where `phoneAFriend: false` appears on `lead` `:24`, `coder` `:25`, `intern` `:28`). A change that lands in one and not the other produces a control whose state does not persist. |
| Caller identity plumbing | The directive is *prompt text* built at dispatch time. The originating terminal's identity must be interpolated into it exactly as the port already is — there is no runtime way for the agent to discover which terminal it is. The same builder must also finally interpolate the **real** role, fixing the hardcoded `"originRole":"coder"`. |
| Lock granularity | Replacing one global promise chain (`:689`) with a per-target map, without reintroducing interleaved `/clear` + prompt sequences into a shared terminal. |
| Rename participation | Any name-keyed config must join the rename migration or silently detach on rename (see Side Effects). |

## Edge-Case & Dependency Audit

### Race Conditions

- **Per-target locking, not global.** Replace `_phoneAFriendInFlight` (`:689`) with `Map<targetTerminalName, Promise<void>>`. Dispatches to *different* friends run concurrently; dispatches to the *same* friend stay serialized so `/clear` + prompt cannot interleave in one terminal.
- **Map entries must be reaped.** The existing code nulls the chain only if it is still the current one (`:4624-4625`) — a deliberate guard against a stale continuation clobbering a newer chain. The per-target map must keep that identity check per key, and delete the key rather than leaving a resolved promise behind, or the map grows once per distinct target for the session's lifetime.
- **Concurrency contract change is user-visible.** Today two simultaneous batch-ends produce two serialized second passes in one terminal. After this, two friends may run at once. That is the intent, but it doubles peak terminal load — relevant to the pty fan-out concerns in `feature_plan_20260805180002`.

### Security

- **Self-dispatch must be refused.** With per-instance mapping it becomes possible to point a terminal's friend at itself, injecting `/clear` + a prompt into the terminal that is mid-batch — a self-inflicted context wipe. Reject the configuration at save time **and** guard at dispatch (config can be hand-edited; the save-time check is not a sufficient gate).
- **Cycles are possible but not worth preventing structurally.** A → B → A only fires if both agents actually complete batches and curl; it is self-limiting and visible. Log the chain rather than building cycle detection; revisit if the subagent work makes trees deep.
- **The route is unauthenticated and stays that way.** `POST /phone-a-friend` is already open on localhost and this change does not widen it — the new fields are advisory hints that resolve through config the caller cannot write. Do not add a token here; it would break every in-flight prompt built by an older version. (The subagent contract, which can *start processes*, has a different posture — see `…180001`.)

### Side Effects

- **Migration is mandatory.** `phoneAFriend?: boolean` is shipped state. The new per-instance map must be additive: an install with `phoneAFriend: true` on the coder role keeps behaving exactly as it does now (all coder instances → the one `phone_a_friend` terminal) until the user sets an instance override. Never drop the boolean; read it as the role-level default. A no-op migration costs nothing, a missing one silently unwires people's reviewers.
- **Resolution order must be total.** `instance override → role default → workspace singleton → none`. "None" must be reachable and must mean "do not dispatch", distinct from "not configured, use the singleton" — otherwise turning a friend *off* for one terminal is impossible. This is why the override value is `string | null` and why absent-key and `null` must not be conflated.
- **Terminal names are not stable identity.** Terminals can be renamed, and there is machinery that migrates every name-keyed collection from `oldName` to `newName` on rename (`src/standalone/terminalWsGateway.ts:610-651` — `moveMap` over each collection, with the explicit warning at `:622` to keep the list in sync with `untrackTerminalData`). There is also a contract test that *parses that collection list out of the source* rather than hardcoding it (`src/test/terminal-rename-rekey-contract.test.js:19,55`), so a new name-keyed map is checked mechanically. Keying on the friendly name and joining the rename migration is the smaller change; do that and add the config map to the collections it moves.
- **Fixing the hardcoded `originRole` changes observable payloads.** Once the builder interpolates the real role, a `lead`'s notification stops claiming `coder`. Anything that keyed on the wrong value would change behaviour — audit the `:2375` consumer and the diagnostics line before assuming it is inert.
- **The directive is built once per dispatch, not per plan.** The instruction says "send exactly one request per batch (not one per plan)". Interpolating an instance id does not change that — one identified caller, one notification.

### Dependencies & Conflicts

- **`_suffixedName` / `_stripIdeSuffix` / `_normalizeAgentKey` already exist** for exactly this class of name-matching — defined at `TaskViewerProvider.ts:3011`, `:3018`, `:2994` respectively, with the canonical resolve-then-scan-open-terminals fallback pattern demonstrated at `:4448-4458` and the send-lock key derivation at `:4493`. Per-instance resolution must reuse them rather than growing a fourth normalisation.
  > **Superseded:** "…plus a scan-open-terminals fallback (`:4551-4557`)."
  > **Reason:** Stale line numbers — nothing relevant sits at `:4551-4557`. The helpers are defined at `:2994`/`:3011`/`:3018`; the fallback pattern to copy is at `:4448-4458`.
  > **Replaced with:** the citations above.
- **A worktree agent cannot read the port file**, which is why the port is interpolated. The same constraint applies to the instance id: it must be baked into the prompt text, never discovered at runtime.
- **Backward compatibility with in-flight prompts.** An agent running a prompt built before this ships posts the old body with no `originTerminal`. That must fall back to role resolution and keep working — the prompt already in a terminal's scrollback cannot be upgraded.
- **No dependency on the subagent plans, and none on this from them.** Verified against source (see the Superseded callout in the Goal). Do not introduce a shared config key, a shared identity type, or a shared lock map across the two — they address different terminal backends in different processes.

## Dependencies

- None. This plan is independently shippable and has no prerequisite in this feature.
- Sibling context (not prerequisites): `feature_plan_20260805180001_subagent-contract-and-join` — deliberately *inverted* failure semantics; `feature_plan_20260805180002_subagent-terminals-lifecycle-and-lazy-view` — shares the "peak terminal load" concern.
- No session-id dependencies recorded for this plan.

## Adversarial Synthesis

**Risk summary.** The dominant risk is silent unwiring of ~4,000 shipped installs: `phoneAFriend: boolean` must be read as the role default forever, and it lives in two files (`agentConfig.ts` + `sharedDefaults.js`) that must change together. Second is the rename path — a name-keyed override map that skips the `moveMap` list in `terminalWsGateway.ts:610-651` detaches on the first rename, and the contract test that parses that list is the only thing that will catch it. Third is lock-map leakage: replacing one promise with a keyed map reintroduces the stale-continuation hazard the existing identity check at `:4624` exists to prevent. Mitigations: compatibility test runs first and is the gate; join the rename migration explicitly; preserve the per-key identity check and delete keys on completion.

## Proposed Changes

### 1. `src/services/agentConfig.ts` — additive per-instance shape

**Context.** `phoneAFriend?: boolean` at `:38`, sanitized at `:266`.

**Logic.** Keep `phoneAFriend?: boolean` as the role-level default. Add an optional per-instance map alongside it:

```ts
/** Phone-a-Friend, per-role default (SHIPPED — never remove; read as the role default). */
phoneAFriend?: boolean;

/**
 * Per-terminal-instance Phone-a-Friend overrides, keyed by originating terminal
 * friendly name. Value is the TARGET terminal's friendly name, or null to disable
 * the friend for that instance specifically. Absent key → fall back to the role
 * default above. Layered, never replacing: an install that only has `phoneAFriend`
 * keeps its current behaviour untouched.
 *
 * NOTE: vscode.Terminal display names only. This map has no relationship to the
 * pty fleet or to `agentInstanceId` in the subagent contract — see …180001.
 */
phoneAFriendTargets?: Record<string, string | null>;
```

**Implementation.** Add a sanitizer clause next to `:266`, modelled on the `subagentPolicy` / `customSubagentName` clauses at `:258-264` (which show the established allowlist-and-sanitize idiom). It must accept `null` as a *meaningful* value — a naive truthy filter would erase every explicit "off" override, collapsing the resolution order's fourth state.

**Edge cases.** Reject self-referential entries (`key === value` after normalisation). Drop entries whose value is neither a non-empty string nor `null`.

### 2. `src/webview/sharedDefaults.js` — keep the mirror consistent

**Context.** `DEFAULT_ROLE_CONFIG` carries `phoneAFriend: false` for `lead` (`:24`), `coder` (`:25`), `intern` (`:28`). The file header says **"CRITICAL: DO NOT CHANGE DEFAULTS UNLESS SPECIFICALLY ASKED"** — so add, never alter.

**Logic.** The new map defaults to absent (not `{}`) so an untouched install serialises identically. Do not add `phoneAFriendTargets` to the default role config unless the Agents-tab control needs a seed value; an absent key is the compatibility guarantee.

### 3. `src/services/agentPromptBuilder.ts` — carry the caller's instance, and the real role

**Context.** `PHONE_A_FRIEND_DIRECTIVE` at `:597`; call sites at `:1101` and `KanbanProvider.ts:4646`.

**Logic.** Interpolate the originating terminal's name and a dispatch-time correlation id, exactly as the port is interpolated, and include them in the POST body. **Also interpolate the actual role**, replacing the hardcoded `"originRole":"coder"` literal:

```ts
export const PHONE_A_FRIEND_DIRECTIVE = (port: number, originRole: string, originTerminal: string, dispatchId: string) => …
//  -d '{"planFile":"<PLAN_FILE_PATH>","originRole":"lead","originTerminal":"lead-2","dispatchId":"…"}'
```

`originRole` stays in the payload — now correct rather than constant — for compatibility with in-flight prompts issued before the upgrade.

**Edge cases.** Both call sites must pass the new arguments; a defaulted parameter would let one site silently keep emitting the wrong role. Prefer required parameters so the compiler finds every site.

### 4. `src/services/TaskViewerProvider.ts` — resolve per instance, lock per target

**Context.** `_dispatchPhoneAFriend` at `:4560`; singleton resolution at `:4572`; global chain at `:689`/`:4562`/`:4620`/`:4624`; receiver at `:2375`.

**Logic.** Replace the singleton lookup with the total resolution order (`instance → role → singleton → none`), and replace `_phoneAFriendInFlight` with `Map<targetTerminalName, Promise<void>>` so dispatches to *different* friends run concurrently while dispatches to the *same* friend stay serialized. Keep the silent-drop-with-diagnostics contract, and add the resolved origin and target to the diagnostics line so a misrouted friend is visible.

**Implementation.** Keep `allowPtyFleet` at its default `false` — this path is `vscode.Terminal`-only by design (`:4673`). Reuse the `:4448-4458` resolve-then-scan pattern for the per-instance target.

**Edge cases.** Preserve the per-key identity check from `:4624` when clearing map entries. Delete the key on settle. Guard self-dispatch here too, not only at save time.

### 5. `src/services/LocalApiServer.ts` — accept and forward the new fields

**Context.** Route at `:3612`, documented at `:2008`.

**Logic.** Pass `originTerminal` and `dispatchId` through to `onPhoneAFriend`. A body without them (an agent running an older prompt) falls back to role resolution — the existing behaviour.

**Edge cases.** Per the project PRD's boundary-validation contract, validate the two new fields permissively: require nothing new, and accept-but-ignore unknown shapes. A schema that rejects the *old* two-field body would break every terminal holding a pre-upgrade prompt.

### 6. Agents tab — per-instance control

**Logic.** Surface the override where instances are already listed, so a friend can be attached to `coder-2` without touching `coder-1`. A terminal with no override shows the inherited role default rather than an empty control, or the UI implies "off" for something that is on. Provide three visibly distinct states: *inherit*, *specific target*, *off* — matching the four-state resolution order minus the unreachable "singleton" internal.

**Edge cases.** Do not add a confirmation dialog to any control here (project rule; `window.confirm` is a no-op in webviews regardless).

## Verification Plan

1. **Compatibility:** an install with only `phoneAFriend: true` on coder, no overrides — behaviour is byte-for-byte what it is today, including the singleton target and the diagnostics line. This is the migration test; run it first.
2. Two coders, no overrides → both dispatch to the one friend, serialized, as now.
3. `coder-1 → friend-a`, `coder-2 → friend-b` → both fire concurrently; each friend's `/clear` + prompt sequence is intact and un-interleaved.
4. Two coders both mapped to `friend-a` finishing simultaneously → serialized on that target only.
5. Instance override set to `null` → that terminal dispatches nothing; its role sibling still does.
6. Rename an origin terminal that carries an override → the override follows the rename.
7. Self-dispatch configuration → rejected at save; if forced into config by hand, refused at dispatch with a diagnostics line.
8. Friend terminal not running → silent 200, diagnostics line names both origin and intended target. Unchanged contract, better message.
9. Agent posting the OLD payload (no `originTerminal`) → falls back to role resolution and still works.
10. **Role fidelity:** enable the addon on `lead`, dispatch, inspect the POST body → `originRole` is `lead`, not `coder`. Repeat for `intern`.
11. Round-trip the Agents-tab control: set an override, reload the panel, confirm it persisted (this is what catches an `agentConfig.ts`-only change that missed `sharedDefaults.js`).
12. Lock-map hygiene: dispatch to three distinct targets, let all settle, confirm no residual keys.

### Automated Tests

Not run in this planning pass (session directive). Recorded for the implementer as guard rails that must not regress:

- `src/test/terminal-rename-rekey-contract.test.js` — parses the name-keyed collection list out of `untrackTerminalData`; a new name-keyed override map that skips the rename `moveMap` is expected to trip this.
- `src/test/webview-shim-injection-contract.test.js` — asserts the shared-defaults symbols are injected into webviews; relevant if the Agents-tab control reads a new default.
- Note: five regression tests are already red at HEAD. Stash-verify before attributing any failure to this change.

## Recommendation

**Complexity 5 → Send to Coder.**
