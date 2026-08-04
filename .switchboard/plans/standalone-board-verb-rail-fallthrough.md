# Standalone Board: fall through to the KanbanProvider verb passthrough

## Goal

Make the standalone (headless CLI) Board serve the same verb surface as the extension by changing
`kanbanVerb`'s `default:` arm to delegate to `kanbanProvider.handleServiceVerb()` — the passthrough
standalone already uses for three verbs — instead of returning `Verb '<x>' not implemented in
standalone mode`.

### Root problem / background (measured 2026-08-04 against a freshly built `dist/standalone/cli.js`)

A standalone server was booted on a scratch workspace and every verb `kanban.html` sends was POSTed
to `/kanban/verb/<name>`. **83 of 106 returned `not implemented in standalone mode`.** The same
probe against the other panels (`project`, `planning`, `setup`, `tickets`, `design` — 92 read verbs)
returned **zero** unimplemented, because those panels are routed to their real providers.

The gap is not missing functionality. It is a router that stops short:

- `src/standalone/bootstrap.ts:692-1001` is a hand-written 25-case switch. Its `default:` arm
  (`:994-995`) returns the not-implemented error.
- **82 of the 83 dead verbs are already in `KANBAN_VERBS`** (152 entries,
  `src/generated/verbAllowlist.ts`) and **already have handlers** in
  `KanbanProvider._handleMessage`. Spot-verified line numbers: `moveCardForward:8277`,
  `moveCardBackwards:8259`, `promptOnDrop:8669`, `triggerBatchAction:8195`, `createWorktree:10540`,
  `cleanupWorktree:10858`, `abandonWorktree:10865`, `getWorktreeStatuses:10891`,
  `openWorktreeTerminals:10773`, `archiveSelected:8526`, `recoverSelected:8509`,
  `sendToBacklog:9811`, `uncompleteCard:9591`, `getKanbanStructure:10290`, `saveKanbanColumn:10321`,
  `assignSelectedToProject:7749`, `setProjectOverride:8372`, `getCustomAgents:10435`,
  `getStartupCommands:10015`, `showInfo:8658`, `showWarning:8663`, `selectPlan:7349`,
  `focusTerminal:10005`, `fileExists:10061`.
- `KanbanProvider.handleServiceVerb` (`:7191-7223`) is a **generic** passthrough: allowlist check
  (`KANBAN_VERBS.has(verb)` → throws `Unknown Kanban verb: '<x>'`) → `validateVerbPayload('kanban',
  verb, payload)` → `this._handleMessage({...payload, type: verb, __viaHttp: true})`. All three steps
  and the `__viaHttp` flag are verified in source at those exact lines. Its own comment states "All
  144 arms RETURN their result … the HTTP rail serializes it as the response body". `__viaHttp` exists
  so arms that would focus an editor panel degrade to a WS push.
- Standalone **already constructs that provider completely** —
  `bootstrap.ts:627-635` news it up and injects `_hostSeams`, `_broadcaster` and
  `_currentWorkspaceRoot` specifically "to pre-empt `_initKanbanService`'s empty-root bail". The
  comment at `:625-626` says the quiet part out loud: *"Only the three feature verbs are routed to
  it (see kanbanVerb below); the existing hand-rolled arms are unchanged."*
- The precedent arm is at `:973-974` (`const result = await kanbanProvider.handleServiceVerb(verb,
  { ...payload, workspaceRoot: root }); await pushFullState();`) — an unconditional push, i.e. the
  three feature verbs are all treated as writes.

  > **Superseded:** the three-verb passthrough precedent cited as `bootstrap.ts:970-976`.
  > **Reason:** Line drift — `bootstrap.ts` carries uncommitted Tickets Panel Extraction edits.
  > **Replaced with:** `:973-974`. Re-locate by symbol (`kanbanProvider.handleServiceVerb`), not by
  > line, when implementing.

So this is an unfinished incremental migration, not a design decision. The provider is ready, the
allowlist is ready, the arms return their results — three verbs use the door and the other 82 are
told the room does not exist.

**The worst symptom is drag-and-drop, which fails while looking like it succeeded.** Every drop path
in `kanban.html` sends `moveCardForward`, `moveCardBackwards` or `promptOnDrop`
(`:7152-7189`, `:7361-7376`) — all three dead. And `:7148-7150` arms an optimistic render guard
*before* posting, so the card visibly moves, an error toast appears, and the card snaps back on the
next board push. A user reads that as a flaky board, not a missing feature.

The one verb not in `KANBAN_VERBS` is `exportAgentAsSkillResult`, which is a webview *response*
type, not a command — handled in the robustness-hardening plan, not here.

## Metadata
- **Tags:** backend, api, refactor, reliability, cli
- **Complexity:** 7

## Architecture Review — the approach was challenged

**The plan's chosen approach:** replace the hand-written switch's `default:` arm with delegation to
the provider's existing generic passthrough, letting `KANBAN_VERBS` + `validateVerbPayload` be the
boundary.

**Alternatives:**

1. **`default:` → `handleServiceVerb` (chosen).** One arm, one mechanism, no second allowlist. Blast
   radius is 82 verbs at once.
2. **An explicit `STANDALONE_PASSTHROUGH_VERBS` set, grown cluster by cluster.** Narrower per-step
   risk and it would let `standalone-editor-bound-verb-triage` gate admission per cluster instead of
   auditing after the fact. But it institutionalises a second list that must be kept in sync with
   `KANBAN_VERBS` — the exact drift this plan exists to remove — and the triage plan already runs
   per cluster, so the sequencing benefit is available without the second list.
3. **Port the 82 arms into standalone-native handlers.** Rejected on sight: it forks the engine,
   violates PRD contract #1 (anti-divergence), and is the shim approach the A2b design audit already
   rejected in 2026-07.

**Justification.** (1) is right because the mechanism is not new — three verbs already use this exact
door with this exact payload shape, and the editor host's HTTP rail uses it for all 152. (2)'s only
real advantage is staged risk, which the triage plan supplies without a durable second list.

**Goal-vs-appearance probe.** The stated goal is "serve the same verb surface as the extension".
This approach can achieve *reachability* while missing *usability*, in three specific ways — all of
which would still let the plan's own headline test ("no verb returns not implemented") pass:

- **Success without effect.** A delegated arm whose payoff is a `switchboard.*` command returns
  `{success:true}` having done nothing (that is `standalone-refreshui-and-command-bridge`, and this
  plan deliberately lands first to make it observable — stated in User Review 3).
- **Success without data.** `handleServiceVerb`'s "all 144 arms return their result" is a comment, not
  a guarantee; the Setup provider carries the opposite TODO. A read that pushes and returns a bare ack
  is reachable and useless over HTTP.
- **Success on the wrong tier.** Scoped settings arms key their project tier off
  `msg.initiatorProject`; standalone tracks the active project in a closure variable the payload never
  carries. Nothing errors. This one is *not* deferred to a sibling plan — it is closed here, in
  Proposed Changes, because it is created by this change's payload shape.

The first two are why `standalone-editor-bound-verb-triage` exists and why its pass bar rejects
`{success:true}` as evidence. The honest framing of this plan's acceptance is therefore "82 verbs are
reachable and payload-validated", not "82 verbs work" — the plan's own tests should not claim more.

## User Review Required (decisions, with defaults)

1. **Blanket fallthrough, or an explicit opt-in list?**
   **Default (recommended): blanket fallthrough.** Delegate every verb the hand-written switch does
   not claim, and let `KANBAN_VERBS` be the allowlist — it already is the allowlist for the
   extension's identical HTTP rail, so an explicit second list would drift from it. The alternative
   (naming ~82 verbs in a `STANDALONE_PASSTHROUGH_VERBS` set) buys a narrower blast radius at the
   cost of the same drift this plan exists to remove.

2. **Do the hand-rolled arms stay?**
   **Default: yes, unchanged — with two named exceptions handled by a sibling plan.** The 23 working
   arms do standalone-specific work the provider cannot (PTY dispatch via `handlePtyVerb`,
   `pushFullState()` broadcasts, the memo/clipboard degrades). They keep priority; the fallthrough
   only catches what falls past them.

   **Exceptions:** `getSetting` (`:713-722`) and `saveSetting` (`:724-729`) are *not* doing work the
   provider cannot — they read and write a process-local `Map` (`:300`) that loses everything on
   restart, while `KanbanProvider`'s own arms for the same two verbs
   (`KanbanProvider.ts:10085-10118`, both verbs present in `KANBAN_VERBS`) are durable, prefixed,
   key-guarded, four-tier and return-in-body. Retiring those two arms so they fall through is
   `standalone-persist-ui-settings`, sequenced after this plan. Do not retire them here — but do not
   deepen them either.

   Consolidating the remaining 21 is a separate, later question.

3. **Which arms are expected to still misbehave after this change?**
   Arms whose effect is `vscode.commands.executeCommand('switchboard.*')` will now return
   `{success:true}` while doing nothing, because the shim's `executeCommand` is a blanket no-op
   (`src/standalone/vscodeShim.ts:229`). That is the subject of the sibling plans
   `standalone-refreshui-and-command-bridge` and `standalone-editor-bound-verb-triage`. **This plan
   deliberately lands first and does not attempt to fix them** — the fallthrough is what makes them
   observable.

## Complexity Audit

### Routine
- The code change itself is one `default:` arm plus a `try/catch`.
- Reuses an existing, tested passthrough (`handleServiceVerb`) rather than adding a mechanism.
- The three existing feature-verb arms (`bootstrap.ts:970-976`) are a working template, including
  their `await pushFullState()` follow-up.

### Complex / Risky
- **Blast radius is 82 verbs at once.** Each reaches a handler written against the editor host; any
  that touches an unshimmed `vscode` member throws where it previously returned a clean error.
- **Mutating arms need a state push.** The hand-rolled arms call `pushFullState()` explicitly. The
  provider's arms instead call `executeCommand('switchboard.refreshUI')`, which no-ops here, so a
  DB write can succeed while the browser shows stale cards — a *worse* user-visible outcome than
  today's honest error, unless the push is added in the same change.
- Verb-name collisions between the switch and the allowlist must resolve to the switch, or
  standalone-specific behaviour (PTY dispatch) is silently replaced by editor behaviour.
- **The delegated arms read and write settings through helpers that are blind in this host.** See the
  hard prerequisite in Dependencies. This is the highest-consequence risk in the plan precisely because
  it cannot crash: a delegated verb resolves a setting from the wrong tier, or drops a role-config
  write, and still returns `{success:true}`.
- **The project tier is a second, independent way to land on the wrong tier.** Even with the root
  wiring fixed, `_getScopedSetting(fullKey, default, initiatorProject)` and
  `_updateScopedSetting(key, value, initiatorProject)` take the project from the *message*. Standalone
  holds it in a closure variable (`projectFilter`, `:301`). The fix is one line in the payload spread
  (Proposed Changes) — but it is easy to miss precisely because omitting it produces plausible values
  rather than an error.

## Edge-Case & Dependency Audit

- **Race Conditions.** `pushFullState()` after a delegated mutation races the plan watcher's own
  periodic scan (10s, `GlobalPlanWatcher`) and the ingestion engine's post-import push. Both already
  coexist today for the hand-rolled arms; adding one more publisher per delegated mutation is the
  same pattern, but a burst (e.g. `moveAll` over many cards) should push once at the end, not per
  card. Guard with the existing debounce if `pushFullState` has one; otherwise push after the
  delegated call returns, not inside a loop.
- **Security.** `handleServiceVerb` performs the allowlist check *and* `validateVerbPayload` before
  dispatch, so delegating does not widen the network boundary — it narrows it, since the
  hand-rolled arms mostly read `payload.x` unvalidated (see `getSetting` at `:713-719`, which throws
  a raw TypeError on a missing `key`). Do not bypass `handleServiceVerb` to call `_handleMessage`
  directly; that would skip both gates.
- **Side Effects.** Arms that write plan files will now fire the plan watcher, which re-imports and
  can move cards. Expected, and identical to extension behaviour.
- **Dependencies & Conflicts.** Touches the same `kanbanVerb` function as any in-flight standalone
  work. The current working tree already has uncommitted `bootstrap.ts` edits from the Tickets Panel
  Extraction; land this after that settles or expect a merge in `kanbanVerb`.

## Dependencies

- **HARD PREREQUISITE: `standalone-workspace-root-wiring`.** `KanbanProvider._taskViewerProvider` is
  permanently `undefined` in standalone (`bootstrap.ts` wires the reverse direction at `:642` but never
  the forward one), and `TaskViewerProvider._resolveWorkspaceRoot()` returns `null` because the shim's
  `workspaceFolders` is a hardcoded empty array (`vscodeShim.ts:189`). Every settings helper the
  delegated arms depend on — `_getSetting:494`, `_getScopedSetting:636`, `_updateSetting:602`,
  `_updateScopedSetting:674`, `_loadOverrideFlags:622` — therefore skips the `kanban.db` config tiers
  and answers from the file-backed globalState memento or a default, and `saveRoleConfig` in the
  both-OFF path (`:598`) is a silent no-op on `undefined`. Nothing throws, so landing this plan first
  would produce 82 verbs that read the wrong settings store and discard role-config writes **without
  any error**. Fix the wiring first.
- Sibling plans that should land **after** this one, because this is what surfaces their symptoms:
  `standalone-refreshui-and-command-bridge`, `standalone-editor-bound-verb-triage`,
  `standalone-capability-gating-honesty`.
- (No session IDs are cited: these plans are new and the system assigns IDs on import.)

## Adversarial Synthesis

**Risk summary.** The change is small and the mechanism is proven, but it converts 82 honest
failures into 82 code paths that have never executed headlessly — and the most likely failure mode
is the quiet one: a verb that mutates the DB, returns success, and never refreshes the browser.
That is a regression in *perceived* reliability even though it is progress in capability. The
mitigation is to land the state-push in this same change and to triage with a script that exercises
every delegated verb against a scratch workspace, rather than shipping on the strength of the
compile.

## Proposed Changes

### `src/standalone/bootstrap.ts`

- **Context.** `kanbanVerb` (`:692-1001`); the three-verb passthrough precedent at `:973-974`; the
  `default:` arm at `:995`; `kanbanProvider` fully wired at `:627-635`; `projectFilter` at `:301`,
  mutated by the `setProjectFilter` arm at `:708`.
- **Logic.** Replace the `default:` arm with: attempt `kanbanProvider.handleServiceVerb(verb,
  {...payload, workspaceRoot: root})`; on success, if the verb is not a known pure read, `await
  pushFullState()`; return the provider's result verbatim. If `handleServiceVerb` throws
  `Unknown Kanban verb`, return the pre-existing not-implemented error so a genuinely unknown verb
  still reports clearly. Any other throw returns `{success:false, error: <message>}` — the shape
  `transport.js:283-301` already renders as a toast. **The payload must also carry
  `initiatorProject`**, or every delegated scoped-settings read and write silently resolves on the
  wrong tier (see below).
- **Implementation.**
  ```ts
  default: {
      // Everything the hand-rolled arms above do not claim is served by the same
      // KanbanProvider passthrough the editor host uses (KanbanProvider.ts:7191).
      // KANBAN_VERBS + validateVerbPayload stay the network boundary.
      //
      // initiatorProject FIRST so a caller-supplied value wins; workspaceRoot LAST
      // because the router's resolved root is authoritative. The provider's scoped
      // helpers key their project tier off msg.initiatorProject
      // (_getScopedSetting:636, _updateScopedSetting:674) and standalone tracks the
      // active project in the `projectFilter` closure, which the webview payload does
      // not carry. Omit it and scoped reads/writes land on the workspace tier with no
      // error of any kind.
      try {
          const result = await kanbanProvider.handleServiceVerb(verb, {
              initiatorProject: projectFilter,
              ...payload,
              workspaceRoot: root,
          });
          if (!KANBAN_READ_ONLY_VERBS.has(verb)) { await pushFullState(); }
          return result;
      } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith('Unknown Kanban verb')) {
              return { success: false, error: `Verb '${verb}' not implemented in standalone mode` };
          }
          return { success: false, error: msg };
      }
  }
  ```
- **Edge Cases.** Define `KANBAN_READ_ONLY_VERBS` as the `get*`/`fetch*`/`load*` subset so reads do
  not trigger a full board broadcast on every poll. If the set is wrong in the conservative
  direction (a read treated as a write) the cost is a redundant push, so prefer over-inclusion of
  writes. `exportAgentAsSkillResult` will now report "not implemented" via the `Unknown Kanban verb`
  branch, which is correct — it is not a verb (confirmed absent from `KANBAN_VERBS`). The
  `initiatorProject` line is shared surface with `standalone-persist-ui-settings`: whichever plan
  lands second must not add it twice.

### `src/standalone/bootstrap.ts` — drag-and-drop acceptance

- **Context.** `kanban.html:7148-7150` arms an optimistic guard before posting; `:7152-7189` and
  `:7361-7376` send the three movement verbs.
- **Logic.** No webview change needed: once the verbs resolve, the optimistic guard behaves as
  designed (the DOM move is confirmed by the delta rather than reverted). This is called out so the
  acceptance test targets it explicitly rather than assuming it.
- **Implementation.** None beyond the fallthrough.
- **Edge Cases.** `promptOnDrop` returns a `promptOnDropResult` message the webview handles at
  `kanban.html:8217`; confirm the delegated arm still returns that typed body, since
  `transport.js:299-301` re-dispatches typed bodies into the panel's handlers.

## Verification Plan

### Automated Tests

- **Contract test — no board verb reports "not implemented" unless genuinely unknown.** Extend the
  headless verb-engine suite: enumerate every `type: '...'` that `src/webview/kanban.html` posts,
  POST each to `/kanban/verb/<name>` against a scratch workspace, and assert none returns
  `not implemented in standalone mode`. Assert a deliberate junk verb (`__nope__`) still does. This
  test is the regression lock for the whole plan and should fail today with 83 names.
- **Contract test — hand-rolled arms keep priority.** Assert `triggerAction` and `sendToTerminal`
  still route to `handlePtyVerb` (not the provider) by asserting the PTY-unavailable error text when
  `ptyReady` is false.
- **Contract test — mutating delegation pushes state.** Spy on `pushFullState`; POST
  `moveCardForward` for a seeded plan and assert one push after the call; POST `getKanbanStructure`
  and assert none.
- **Integration test — drag-and-drop round trip.** Seed a plan in `CREATED`, POST `moveCardForward`
  with its sessionId and a target column, then assert via `GET /kanban/board` that
  `kanbanColumn` actually changed. This is the check that today's optimistic-guard revert would fail.
- **Contract test — the project tier survives delegation.** With a project filter active
  (`POST setProjectFilter`), POST a scoped-settings verb and assert the value lands on the *project*
  tier in the DB, not the workspace tier. Assert the inverse with no filter active. This is the
  `initiatorProject` assertion; without it the payload change is untested and its omission is
  invisible.
- **Scope note for the headline test.** The "no verb reports not implemented" test proves
  **reachability and payload validation**, not that 82 verbs work. Name that in the test description
  so a green run is not cited as capability. Proving effect is
  `standalone-editor-bound-verb-triage`'s job, and its pass bar deliberately rejects `{success:true}`.
- **Manual smoke.** Boot `node dist/standalone/cli.js --workspace <scratch> --no-open`, open the
  board, drag a card between columns, reload, confirm it stayed.

## Uncertain Assumptions

- That every delegated arm returns rather than only pushing. `handleServiceVerb`'s comment asserts
  all 144 arms return; the sibling Setup provider carries the *opposite* TODO
  (`SetupPanelProvider.ts:59-65`, "write-only reads"). Verify per cluster during triage rather than
  trusting the comment. **One counter-example already found** outside the Board:
  `SetupPanelProvider.ts:966-968` (`getDefaultPromptPreviews`) pushes `defaultPromptPreviews` and
  returns a bare `{success:true}` — so the anti-pattern is live in a wired provider, not hypothetical.
- That the delegated arms tolerate an injected `initiatorProject` they did not expect. It is an
  additive field and the arms that ignore it are unaffected, but `validateVerbPayload` schemas must be
  permissive about it (PRD contract #5: "require only the fields the arm dereferences") — a strict
  schema that rejects the extra key would break the delegation for that verb.
- That `_handleMessage` needs no `_lastCards` warm-up in standalone. Arms using the `_lastCards`
  cache (`promptSelected`'s fallback is documented at `KanbanProvider.ts:7228-7231`) may behave
  differently when the cache is cold because no editor webview ever populated it.

## Out of Scope

- Fixing `executeCommand` no-ops (sibling plans).
- Consolidating the 23 hand-rolled arms into the passthrough.
- Anything in the in-flight Tickets Panel Extraction.

## Completion Summary
Implemented `kanbanVerb` default fallthrough in `src/standalone/bootstrap.ts` to route all unclaimed Kanban verbs directly to `kanbanProvider.handleServiceVerb` with `initiatorProject` and `workspaceRoot`. Automatically calls `pushFullState()` for non-read-only operations.
- Files changed: `src/standalone/bootstrap.ts`
- Issues encountered: None.

