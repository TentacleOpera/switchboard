# Phone-a-Friend: per-instance addressing instead of one global role

## Goal

Make Phone-a-Friend addressable **per originating terminal**, not per role. Today there is exactly one Phone-a-Friend terminal for the whole workspace and the callback identifies its caller only by role name, so every coder shares one reviewer and the host cannot tell which coder called. After this change, `coder-1` and `coder-2` can each have their own friend, a friend can be attached to a specific terminal rather than a whole role, and every dispatch carries the instance identity of its caller.

This is the smallest independently-shippable piece of the subagent work. It is worth doing on its own merits — the role-level ambiguity is a live defect once more than one coder runs — and it establishes the caller-identity and per-target-locking primitives the subagent contract needs.

### Problem analysis & root cause

**How it works today.**

1. `phoneAFriend?: boolean` is a per-role addon flag (`agentConfig.ts:38`).
2. When set, `PHONE_A_FRIEND_DIRECTIVE(port)` is appended to the coder/lead/intern prompt (`agentPromptBuilder.ts:597`). The API port is interpolated at build time so worktree CWDs don't have to read the port file.
3. The agent curls `POST /phone-a-friend` with `{ planFile, originRole }` when its batch ends.
4. `TaskViewerProvider._dispatchPhoneAFriend` (`:4535`) resolves the target:

```ts
const agentName = await this._getAgentNameForRole('phone_a_friend', resolvedWorkspaceRoot) || 'Phone-a-Friend';
```

**Three consequences, all from the same root cause — role is the only identity in the system.**

- **One friend, workspace-wide.** `_getAgentNameForRole('phone_a_friend', …)` is a singleton lookup. Ten coders resolve to the same terminal. You cannot give `coder-2` a different friend from `coder-1`, and you cannot attach a friend to one terminal without attaching it to the whole role.
- **The caller is unidentifiable.** The payload carries `originRole: 'coder'` — a role, not an instance. With several coders running, the second-pass prompt cannot say *whose* work it is reviewing beyond the plan file, and the host cannot route a reply back even in principle.
- **All dispatches serialize globally.** `_phoneAFriendInFlight` (`:688`, `:4537`) chains every dispatch behind every other one, because they all land in the same terminal. That is correct given one target and wrong the moment there are several: two coders finishing simultaneously should be able to notify two different friends concurrently, and today the second waits on the first.

**Not a bug in the dispatch mechanics.** The `/clear`-then-prompt sequence, the deliberate omission of a Stage Complete marker (a continuation must not trigger a second stage-advance), and the must-not-throw contract on a missing terminal are all correct and stay. Only addressing changes.

**Why the silent-drop contract stays here.** `_dispatchPhoneAFriend` deliberately drops with a diagnostics line when no terminal is running, because a throw becomes a 500 and the directive tells the agent the call succeeds regardless. That is right for a best-effort nudge and must NOT be copied into the subagent work, where a parent blocking on a child that was never dispatched hangs forever. The two failure models are opposites on purpose — see `feature_plan_20260805180001_subagent-contract-and-join`.

## Metadata

- **Complexity:** 5
- **Tags:** feature, backend, reliability

## User Review Required

None. The three decisions this plan could have deferred are made below: config shape (per-instance overrides layered over the role flag), fallback behaviour (instance → role → workspace singleton), and locking granularity (per target terminal).

## Complexity Audit

**Moderate.** No new subsystems; it re-keys an existing one. The weight is in three places:

| Area | Why it costs |
|---|---|
| Config shape + migration | `phoneAFriend: boolean` has shipped. ~4,000 installs, many on older versions. The new shape must read the old one, not replace it. |
| Caller identity plumbing | The directive is *prompt text* built at dispatch time. The originating terminal's identity must be interpolated into it exactly as the port already is — there is no runtime way for the agent to discover which terminal it is. |
| Lock granularity | Replacing one global promise chain with a per-target map, without reintroducing interleaved `/clear` + prompt sequences into a shared terminal. |

## Edge-Case & Dependency Audit

- **Migration is mandatory.** `phoneAFriend?: boolean` is shipped state. The new per-instance map must be additive: an install with `phoneAFriend: true` on the coder role keeps behaving exactly as it does now (all coder instances → the one `phone_a_friend` terminal) until the user sets an instance override. Never drop the boolean; read it as the role-level default. A no-op migration costs nothing, a missing one silently unwires people's reviewers.
- **Resolution order must be total.** `instance override → role default → workspace singleton → none`. "None" must be reachable and must mean "do not dispatch", distinct from "not configured, use the singleton" — otherwise turning a friend *off* for one terminal is impossible.
- **Terminal names are not stable identity.** Terminals can be renamed, and there is machinery that migrates every name-keyed collection from `oldName` to `newName` on rename (`terminalWsGateway.ts`, "Move every name-keyed collection"). Any per-instance config keyed on display name must either participate in that rename migration or key on something durable. Keying on the friendly name and joining the rename migration is the smaller change; do that and add the config map to the collections it moves.
- **`_suffixedName` / `_stripIdeSuffix` / `_normalizeAgentKey` already exist** for exactly this class of name-matching, plus a scan-open-terminals fallback (`:4551-4557`). Per-instance resolution must reuse them rather than growing a fourth normalisation.
- **The directive is built once per dispatch, not per plan.** The instruction says "send exactly one request per batch (not one per plan)". Interpolating an instance id does not change that — one identified caller, one notification.
- **A worktree agent cannot read the port file**, which is why the port is interpolated. The same constraint applies to the instance id: it must be baked into the prompt text, never discovered at runtime.
- **Self-dispatch must be refused.** With per-instance mapping it becomes possible to point a terminal's friend at itself. That injects `/clear` + a prompt into the terminal that is mid-batch. Reject the configuration at save time and guard at dispatch.
- **Cycles are possible but not worth preventing structurally.** A → B → A only fires if both agents actually complete batches and curl; it is self-limiting and visible. Log the chain rather than building cycle detection; revisit if the subagent work makes trees deep.
- **Concurrency contract change is user-visible.** Today two simultaneous batch-ends produce two serialized second passes in one terminal. After this, two friends may run at once. That is the intent, but it doubles peak terminal load — relevant to the pty fan-out concerns in `feature_plan_20260805180002`.

## Proposed Changes

### 1. `src/services/agentConfig.ts` — additive per-instance shape

Keep `phoneAFriend?: boolean` as the role-level default. Add an optional per-instance map alongside it:

```ts
/** Phone-a-Friend, per-role default (SHIPPED — never remove; read as the role default). */
phoneAFriend?: boolean;

/**
 * Per-terminal-instance Phone-a-Friend overrides, keyed by originating terminal
 * friendly name. Value is the TARGET terminal's friendly name, or null to disable
 * the friend for that instance specifically. Absent key → fall back to the role
 * default above. Layered, never replacing: an install that only has `phoneAFriend`
 * keeps its current behaviour untouched.
 */
phoneAFriendTargets?: Record<string, string | null>;
```

### 2. `src/services/agentPromptBuilder.ts` — carry the caller's instance

Extend `PHONE_A_FRIEND_DIRECTIVE` to interpolate the originating terminal's name and a dispatch-time correlation id, exactly as the port is interpolated, and include them in the POST body:

```ts
export const PHONE_A_FRIEND_DIRECTIVE = (port: number, originTerminal: string, dispatchId: string) => …
//  -d '{"planFile":"<PLAN_FILE_PATH>","originRole":"coder","originTerminal":"coder-2","dispatchId":"…"}'
```

`originRole` stays in the payload for compatibility with in-flight prompts issued before the upgrade.

### 3. `src/services/TaskViewerProvider.ts` — resolve per instance, lock per target

Replace the singleton lookup with the total resolution order, and replace the single `_phoneAFriendInFlight` promise with a `Map<targetTerminalName, Promise<void>>` so dispatches to *different* friends run concurrently while dispatches to the *same* friend stay serialized. Keep the silent-drop-with-diagnostics contract, and add the resolved origin and target to the diagnostics line so a misrouted friend is visible.

### 4. `src/services/LocalApiServer.ts` — accept and forward the new fields

`POST /phone-a-friend` passes `originTerminal` and `dispatchId` through to `onPhoneAFriend`. A body without them (an agent running an older prompt) falls back to role resolution — the existing behaviour.

### 5. Agents tab — per-instance control

Surface the override where instances are already listed, so a friend can be attached to `coder-2` without touching `coder-1`. A terminal with no override shows the inherited role default rather than an empty control, or the UI implies "off" for something that is on.

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
10. `npm test` — no new failures. Five regression tests are already red at HEAD; stash-verify before attributing a failure to this change.
