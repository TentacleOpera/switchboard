# The Warm-Set Size Is Operator Configuration, and Its Read Says Where It Came From

## Goal

Put the warm-set size under the operator's control in the Terminals panel Config
tab, defaulting to 2, and make its read say where the value came from — so
"the operator chose 2" and "the settings fetch failed" are never the same
observable state.

### Why this is not just a number input

The warm-set size decides how many scopes hold their WebSockets open. That is a
read of **configuration** whose wrong value silently changes behaviour and
memory footprint on a box that has little of it — exactly the class CLAUDE.md
puts under *"A fallback must never be indistinguishable from a real value."*

The existing reader is the failure mode that rule describes. `loadSetting`
(`src/webview/terminals.js:2140`) swallows every failure and substitutes the
caller's default:

```js
} catch { /* ignore */ }
return defaultVal;
```

A corrupt store, an unreachable host and an unconfigured key all return `2`.
An operator who set the cap to 6 to make switching fast would see it stay slow
and have nothing anywhere telling them their setting never loaded.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, config
- **Project:** Browser Switchboard

## User Review Required

None. Default `2`, range `1–6`, and "unavailable warms 1" are the plan's own
decisions, each justified in the body against the CLAUDE.md fallback rule they
implement.

## Scope: standalone only

`src/webview/terminals.html` and `src/webview/terminals.js` — the browser
cockpit, served by the standalone host. Per CLAUDE.md the VS Code extension host
is out of scope.

## Proposed changes

### 1. A Scope Warmth section in the Config tab

`terminals.html:252` (`#config-tab-body`) already hosts PTY Fleet Persistence,
PTY Host Status and Stop Fleet as `.tmux-section` blocks (`:253`, `:266`,
`:276`). Add a fourth in the same idiom: a numeric control, **default 2**,
range **1–6**, with a hint stating the cost in plain terms — each warm scope
holds its seats' connections open.

Clarification: the key is `terminals.warmScopeCap` (new, never shipped) and it
must **not** be added to `TEAM_NAMESPACED_KEYS` (`terminals.js:2118`) — the cap
is a property of the panel's socket budget, not of a team, and a namespaced key
would read a different cap per scope.

No confirm gate, no "are you sure" on the way out of a high value. Per CLAUDE.md
this codebase does not have those, and `window.confirm` is a silent no-op in a
VS Code webview anyway.

### 2. `loadSettingTagged(key)` — a tagged read, for this key only

Add a reader that returns `{ value, source }` with `source` one of:

- `'config'` — the key was present and parsed.
- `'default'` — the key was absent. The store answered; nothing was stored.
- `'unavailable'` — the fetch threw or returned non-OK. **The store did not
  answer.** This is the case today's `loadSetting` erases.

The source is logged where the value is used, so "which read answered?" is
answerable after the fact.

The consumer is `getWarmScopeCap()` — the single seam the warm-set subtask
leaves behind. This subtask replaces its constant `2` with the tagged read
(parse, clamp 1–6 with the clamp logged, map `source` to the table below) and
wires the control's change event to re-read + evict. Nothing else reads the
key.

This does **not** rewrite `loadSetting` for its other callers. Those are layout
reads on presentation paths where a quiet default is fine, and changing all of
them is a larger, unrelated change. Only the warm-set read is routed through the
tagged reader.

### 3. The unavailable case warms 1, not 2

On `'unavailable'` the panel warms **one** scope. Where a default is
unavoidable, CLAUDE.md says to pick the value whose failure is visible or safe
rather than the one that is merely quiet: warming 1 costs a slower switch, which
the operator can see and report. Warming 2 on a failed read quietly
overcommits memory on a box that has none, and looks exactly like success.

## Complexity Audit

### Routine
- The Config tab markup — an existing section idiom, no new CSS.
- Persisting and restoring the value through the existing `saveSetting` path.

### Complex / Risky
- **Distinguishing absent from failed.** `loadSetting` currently conflates
  `res.ok === false`, a thrown fetch, and `data.value === undefined`. The tagged
  reader has to separate the transport outcome from the payload outcome, which
  means not reusing `loadSetting`'s body as-is.
- **Applying a changed cap to a live ledger.** Lowering the cap while scopes are
  warm must evict the excess through the ordinary suspend path, not leave the
  ledger over its bound until the next switch.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Key absent (fresh install) | Warm 2. `source: 'default'`. |
| Key present and valid | Warm that value. `source: 'config'`. |
| Fetch throws or returns non-OK | Warm **1**. `source: 'unavailable'`, logged. |
| Stored value out of range or non-numeric | Clamp to 1–6 and log the clamp; do not silently treat it as absent — a corrupt value is not an unconfigured one. |
| Cap lowered below the current warm count | Evict the excess through `suspendTerminalStream`, oldest first. |
| Cap raised | No immediate effect; scopes warm as they are visited. |

**Dependencies & conflicts**
- **Depends on the warm-set subtask** for the ledger it configures. That subtask
  lands first with the cap behind `getWarmScopeCap()` returning `2`; this one
  replaces the seam's body with the tagged read and wires cap-changed eviction.
- No conflict with the unassigned-entry subtask.

**Security**
- None. Existing `getSetting`/`setSetting` verbs, no new endpoint.

## Dependencies

- `a-warm-set-keeps-a-scopes-sockets-open-so-switching-back-is-not-a-replay.md`
  — hard prerequisite. Owns `warmScopes`, `getWarmScopeCap()` and the eviction
  path this subtask drives; without it there is nothing to configure.

## Adversarial Synthesis

The obvious objection is that this is a lot of ceremony for one integer, and
that `loadSetting`'s existing default would do. The codebase's own history is the
counter-argument: CLAUDE.md names `catch { return {} }` on a config load as a
shipped bug of precisely this shape, where a corrupt file read as an
unconfigured one. The cost here is one extra reader and one log line; the cost of
being wrong is an operator tuning a setting that never loaded.

The narrower risk is scope creep into `loadSetting` itself. Held off
deliberately: this subtask adds a second reader beside it rather than changing
the semantics of every layout read in the panel.

## Verification Plan

### Automated Tests

- Set the cap to 1 in the Config tab, reload: the value round-trips and the read
  logs `source: 'config'`.
- Fresh workspace, key never written: warms 2, logs `source: 'default'`.
- Force the settings fetch to fail: the panel warms **1** and logs
  `source: 'unavailable'` — it does not behave as if 2 were chosen.
- Write a non-numeric value directly: it clamps, and the clamp is logged.
- Lower the cap from 4 to 2 with 4 scopes warm: two are evicted immediately.
- `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. `loadSettingTagged` exists in `src/webview/terminals.js` and returns
   `{ value, source }` with `source` ∈ `'config' | 'default' | 'unavailable'` —
   the transport outcome and the payload outcome are distinguished.
2. `loadSetting`'s signature and its other callers are unchanged — only the
   warm-set read is routed through the tagged reader. *(Negative — no silent
   semantic change to layout reads.)*
3. `getWarmScopeCap()` contains no literal `2` fallback divorced from the tagged
   read — every value it returns carries a `source`, and `'unavailable'` yields
   `1`. *(Negative — the unlogged silent default is gone; paired with 1.)*
4. `terminals.warmScopeCap` is absent from `TEAM_NAMESPACED_KEYS`
   (`terminals.js:2118`).
5. A Scope Warmth `.tmux-section` exists in `#config-tab-body`
   (`terminals.html`) and persists through the existing `saveSetting` path.

## No migration

The setting has never shipped, so there is nothing to import or archive. No
existing key is renamed, dropped or repurposed.
