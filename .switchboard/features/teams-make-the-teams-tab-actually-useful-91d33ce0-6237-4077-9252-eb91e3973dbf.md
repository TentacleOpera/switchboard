# Teams: make the TEAMS tab actually useful

**Complexity:** 6

## Goal

Make the TEAMS tab do what it looks like it does.

Today the tab stacks three overlapping mechanisms as if they were peers: teams, a legacy per-role delegate spawner that teams silently overrides, and Phone-a-Friend. Meanwhile the code that starts a team explicitly is fully built and has never been called, so the only way to start a team is to pick its head role in a control labelled New terminal - which then hands you five.

The root cause under all of it is that standing orders only ever had one scope: a note about another terminal. Teams was therefore layered on top of per-pair records rather than owning its own prompt, which is why a team cannot carry a prompt, why team coders get no safeguards at all, and why arbitrary caps on the old mechanism gate team creation.

This feature adds the missing scopes (global, team, pair), gives a team its own prompt carrying its safeguards, wires the explicit team-start path that already exists, fixes the gate that stops a lead being told its coders exist, and reduces the tab to three team types plus one Phone-a-Friend control.

The intended end state: **three shipped team types** — Batch planners, Coding, Multi-agent planning — plus **Phone-a-Friend as a per-coder option**, not a team type. Team members stay prompt-less at spawn by design, because the lead clears them between tasks to keep their context free; the team's standing orders are the durable channel that survives that clear, and they carry the safeguards.

## How the Subtasks Achieve This

- **Tell the Lead Its Coders Exist — Fix the DELEGATE PARENT Gate**: The `DELEGATE PARENT` notice is gated on the legacy `addons.delegates` role config, which a team-spawned head never has, so a lead is never told its coders exist and they idle forever. One condition, independent of everything else, and it converts the shipped default team from inert to functional. Ship this first.
- **Start a Team Explicitly — Wire the Button That Already Exists**: `instantiateAgentGroup` and the registered instantiator are complete and have zero callers, so the only way to start a team is picking its head role in a picker labelled "New terminal". This wires the explicit start action, makes the role picker honest about what it will spawn, and narrows the one-team-per-head-role rule to auto-start only — which is what lets two planning teams coexist.
- **Standing Orders — Add Scope (Global / Team / Pair), Drop the Caps**: The keystone. Adds the missing audiences so an order can address every agent, a team, or one terminal about another; removes three unjustified caps and a liveness gate that only makes sense for the pair scope; and applies orders on the VS Code delivery path, which silently skipped them.
- **Teams Own Their Prompt — Stop Generating Pair Records Per Member**: Collapses N per-member pair records into one team-scoped prompt, so a team can finally carry prose — including the git safeguards that team coders currently receive none of. Migrates existing per-member rows rather than dropping them.
- **TEAMS Tab — Three Team Types, One Phone-a-Friend Control, No Dead Spawner**: The visible payoff. Cuts the gallery to the three real workflows, demotes Phone-a-Friend from a team type to a per-coder toggle, and retires the "Delegate children" editor by importing its config into teams before removing its read path.

## Reconciliation record (improve-feature pass, 2026-08-16)

No plans were merged, split or deleted — the five subtasks divide cleanly by mechanism and each is independently codeable. One **scope move** and four **contended surfaces** were resolved. Coders should implement to the end-states below, not to any earlier draft.

**Scope move — the head-role collision rule now has one owner.** The rule is enforced at four sites: `teamWiring.migrateAgentGroups` step 3 (`teamWiring.ts:245-257`), `findTeamForHeadRole`'s `!g.unassigned` filter (`:328`), `teamsTabGalleryCard`'s `claimedRoles` gate (`kanban.html:4452`, `:4478-4484`), and `teamsTabShowGroupForm`'s dropdown disable (`:4674-4679`). *Start a Team Explicitly* previously narrowed only the first, while *TEAMS Tab* carried a verification step ("both planning teams can be adopted") that no implementation delivered — the two webview gates were unowned, so the second planning team would have stayed unadoptable. **End state:** *Start a Team Explicitly* owns all four; site 2 is deliberately kept as the auto-start rule; *TEAMS Tab* consumes it as a prerequisite.

**Contended surfaces — single reconciled end-state each:**

| Surface | Contention | Reconciled end-state |
| :--- | :--- | :--- |
| `applyStandingOrders` signature (`standingOrders.ts:53`) | *Standing Orders* needs team membership; the function's four params cannot supply it, and no terminal record carries a team id | Fifth parameter carrying the registered `terminals.groups` rows; a `team` order's `teamId` is the group id `wireSpawnedTeam` already writes at `teamWiring.ts:516`. Owned by *Standing Orders*; consumed by *Teams Own Their Prompt* |
| `src/services/teamWiring.ts` | *Standing Orders* deletes the `MAX_ORDERS` check (`:488`); *Teams Own Their Prompt* rewrites `wireSpawnedTeam` around it | Serialise — *Standing Orders* first |
| `src/webview/kanban.html` | Three subtasks edit it (collision gates, team-prompt text area, gallery) | Serialise in dependency order: *Start a Team Explicitly* → *Teams Own Their Prompt* → *TEAMS Tab* |
| Callback text (`teamWiring.ts:46`, `linkPresets.ts:111`, `terminals.js:8130`) | Team scope drops the `- Regarding terminal "X": ` prefix that supplies the text's only subject — it opens with a bare "it" | Rewrite to name the head explicitly, all three copies plus `link-presets-mirror-contract.test.js:138`, in one change. Owned by *Teams Own Their Prompt* |

**Three surfaces the drafts did not name**, all verified in the tree and now folded into the owning plan: the webview's full hand-copied resolver mirror `applyStandingOrdersClient` (`terminals.js:8285`, live on the Shift-drop path at `:4196`) with its own cap constants; `src/test/standing-orders-marker-contract.test.js` §5, whose cap-parity assertions go red the moment the caps are deleted; and `WireSpawnedTeamOptions` (`teamWiring.ts:374`), which carries no team identity at all even though every call site already resolves `teamName`.

**Complexity re-scored** after the audit: Standing Orders 4→6, Teams Own Their Prompt 5→6, Start a Team Explicitly 3→4. Routing is unchanged — all five remain Coder-band.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standing Orders — Add Scope (Global / Team / Pair), Drop the Caps](../plans/standing-orders-scopes-and-decap.md) — **CODE REVIEWED**
- [ ] [Teams Own Their Prompt — Stop Generating Pair Records Per Member](../plans/team-prompt-replaces-pair-records.md) — **CODE REVIEWED**
- [ ] [Start a Team Explicitly — Wire the Button That Already Exists](../plans/explicit-team-start-in-terminals-panel.md) — **CODE REVIEWED**
- [ ] [Tell the Lead Its Coders Exist — Fix the DELEGATE PARENT Gate](../plans/delegate-parent-notice-gate-fix.md) — **CODE REVIEWED**
- [ ] [TEAMS Tab — Three Team Types, One Phone-a-Friend Control, No Dead Spawner](../plans/teams-tab-three-presets-and-phone-a-friend.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Two subtasks are independent and can ship immediately; the other three form a spine.

**Independent — ship now, in either order:**
- *Fix the DELEGATE PARENT Gate* — one condition, no dependencies. Makes the existing teams feature work today regardless of how the redesign lands.
- *Start a Team Explicitly* — the engine is already written and unreachable; this is wiring plus honest labelling.

**Spine — strict order:**
1. *Standing Orders — Add Scope* — the keystone. Nothing else in the spine is possible until a `team` scope exists.
2. *Teams Own Their Prompt* — requires the `team` scope from (1) to write into.
3. *TEAMS Tab — Three Team Types* — requires (2) so the shipped types carry team prompts rather than per-member pair rows, and requires *Start a Team Explicitly* so two planning teams can both be startable. Authoring the gallery before (2) means rewriting it twice.

**Ordering constraint inside the tab work:** the `addons.delegates` import must run *before* its read path is removed, or an un-migrated install is left spawning delegates from an editor that no longer exists.

**Not included here:** `feature-prompt-worktree-contradiction.md` was written in the same investigation but is unrelated to teams — it fixes a self-contradictory worktree instruction in the feature-dispatch prompt. It stays a standalone plan and can ship at any time.

## Completion Summary (terminal-coder-dispatch, 2026-08-16)

All five subtasks implemented and reviewed, driven serially through three coder terminals in the dependency order the feature specifies (DELEGATE PARENT gate → standing-orders scopes → explicit team start → team prompt → TEAMS tab). Serial rather than parallel because `TaskViewerProvider.ts`, `kanban.html`, `terminals.js` and `teamWiring.ts` are each edited by three or more subtasks, and the project PRD's one-agent-stream-per-provider-file contract overrides the feature's "ship now, either order" note. Files changed: `standingOrders.ts`, `teamWiring.ts`, `linkPresets.ts`, `terminalUtils.ts`, `agentGroupInstantiation.ts`, `agentPromptBuilder.ts`, `TaskViewerProvider.ts`, `KanbanProvider.ts`, `LocalApiServer.ts`, `bootstrap.ts`, `extension.ts`, `kanban.html`, `terminals.js`, `terminals.html`, plus `standing-orders-marker-contract.test.js` and `link-presets-mirror-contract.test.js`. Four review rounds were needed across subtasks 2, 4 and 5, and every defect was the same class — correct logic shipped on an unreachable path: the webview's hand-copied resolver mirror left un-updated (head exclusion, legacy-row migration), the `standingOrders: false` opt-out missing on the VS Code branch of `sendToTerminal`, and the `addons.delegates` import wired only to a UI path while auto-start resolves teams through `findTeamForHeadRole`, which never runs it. Three new mirror-parity tests now pin the selection filter, the migration and the `GIT_SAFETY_DIRECTIVE` copy mechanically, so that divergence class is closed rather than merely fixed.

**Known residual (not a defect in any subtask's scope):** the boot-time delegate import runs for the primary workspace root only. `getScopedRoleConfig` takes no root argument, so a per-root loop would import the currently-scoped role config into every other root's group table and mint spurious teams — a worse outcome than the gap. Non-primary roots still get the import the moment any surface calls `_loadAgentGroups`, and `addons.delegates` remains intact on disk either way. Root-scoping that read is a separate change.

**Verification limited to static review:** the dispatch carried SKIP COMPILATION and SKIP TESTS, so `npx tsc --noEmit` and the contract suites were not run, and every plan's runtime verification step is unexecuted. Each subtask was reviewed against its plan's acceptance criteria by reading the diff and tracing call sites; the tests written during this work are unrun.

## Review Findings (reviewer pass, 2026-08-16 — verification executed)

This pass carried **no** skip directive, so the checks the implementation dispatch skipped were run for the first time — and they caught two defects that static review had passed. **CRITICAL** `bootstrap.ts:1276`: `prompt: team?.prompt` read a binding block-scoped to the auto-start `if` above it — a `ReferenceError`, not a silent `undefined`, throwing on every standalone team spawn *after* the terminals existed. **CRITICAL** `terminalUtils.ts:154`: the new VS Code chokepoint's opt-out was type-invalid (`TS2367`) and broke `npm run compile-tests`, the first CI gate. **MAJOR**: the plan's own rewritten `standing-orders-marker-contract.test.js` shipped with two assertions that had never passed — one scanned raw source including the comments it was testing around, the other asserted `!includes('old')` against a block whose boilerplate reads "until t**old** otherwise". **MAJOR**: `kanban.html`'s three shipped team prompts hand-copy `GIT_SAFETY_DIRECTIVE` and the callback instruction with nothing pinning them, so this feature's claim that the mirror-divergence class is "closed rather than merely fixed" was false for the surface an operator actually adopts; a mutation-tested parity test now covers it. All four are fixed. Files changed: `src/standalone/bootstrap.ts`, `src/services/terminalUtils.ts`, `src/test/standing-orders-marker-contract.test.js`.

**Verification results:** `standing-orders-marker` 30/30, `link-presets-mirror` 7/7, `team-autostart-scope` 8/8, `multi-parent-terminals` 29/29, `terminal-input-path` 19/19, `terminal-rename-rekey` 8/8, plus `pty-route-surface`, `pty-host-gating`, `pty-prompt-delivery-framing`, `catalog:check`, `parity:check`, `verb-returns:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `kanban-dispatch-callers:check`, `mirror:check` — all pass. `npx tsc --noEmit` is back to the documented 5-error `TS2835` baseline for every file this feature touches.

**Remaining risk — CI is red for a reason outside this feature.** `npm run compile-tests` still fails on `TaskViewerProvider.ts:9826` and `:10264`, which reference the retired `'orchestration'` `AutobanAutomationMode`; `autobanState.ts:39` narrowed that union to `'run-sheet' | 'scheduler'` as part of the in-flight automation-scheduler work. Not this feature's scope and deliberately not fixed here — the semantic choice belongs to that stream — but it blocks a green pipeline for this branch. Secondary residuals unchanged: the boot-time delegate import is primary-root-only (documented above), and `_resolveDelegateIdentityForTarget`'s caller-supplied fast path has no caller, so each dispatch pays one extra `ptyListTerminals` round-trip.
