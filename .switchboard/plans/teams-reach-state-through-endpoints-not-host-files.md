# Teams reach state through endpoints, never through host files

## Goal

Establish and enforce one access contract for team agents: state is reached through the LocalApiServer's endpoints, using the port the host already put in the prompt. No agent instruction tells a lead or member to read `.switchboard/api-server-port.txt`, open `kanban.db`, or otherwise go looking for host-side state.

### Problem Analysis

Two separate instruction sets send team agents to fetch state the host had already resolved. Both are wording, not capability.

**1. The port file.** `teamWiring.ts` contains **15 references** to `.switchboard/api-server-port.txt`. Every queue order body says "against the port in `.switchboard/api-server-port.txt`" and the head order says "read the port from `.switchboard/api-server-port.txt`". Meanwhile the host already hands the port over: `_buildDrivePrefix` (`KanbanProvider.ts:5616-5626`) reads the file itself, host-side, and emits `Port is <n>. BASE="http://127.0.0.1:<n>"` into the prompt. The prompt builder does the same for other directives via `apiPort` and `apiToken` (`:5954-5960`), and its comment states why: *"plumb the LocalApiServer port at build time (Option A) so worktree CWDs don't read the port file (which lives only in the main workspace root's `.switchboard/`)."*

So the correct pattern was chosen deliberately for per-dispatch prompts, and the standing orders never followed. They are durable text appended at delivery, so they cannot be fixed per-dispatch — the wording itself has to change.

**2. The database.** `.gitignore:52` ignores `.switchboard/*`, so `kanban.db` is host-only by design — one DB, one owner. But the `query-kanban` skill instructs agents to resolve `$SB_ROOT/.switchboard/kanban.db` and query it with `sqlite3`, and it is `invocation: 'no-user'` — model-loadable, so a team member can pick it up unprompted.

**Neither is needed, because the read endpoints exist:** `GET /kanban/board`, `/kanban/columns`, `/kanban/features`, `/kanban/plan`, `/kanban/plans`. Agents already use them — the head order itself calls `GET /kanban/plans?featureId=<id>` (`teamWiring.ts:754-757`).

**Why this matters beyond tidiness.** Direct DB access bypasses every guard the API layer applies — the resolve-only project semantics, the feature cascade, the column canonicalisation that `POST /kanban/move` performs ("Column IDs are canonical uppercase (`LEAD CODED`), never state-file slugs … both endpoints canonicalize and 400 on unknown columns", `switchboard-orchestration/SKILL.md:125`). An agent writing SQL gets none of that and fails silently rather than with a 400. And the label/ID trap that `query-kanban` exists to warn about — displayed labels differing from stored IDs — is a problem the endpoints simply do not have, because they return records rather than requiring the caller to know the mapping.

**And it is the difference between working and not working in a worktree.** A team whose terminals are reopened in a per-feature worktree has neither the port file nor the DB there (both ignored, so absent from a fresh checkout). Every instruction naming those paths breaks; every instruction using the injected port keeps working. So this contract is a precondition for the per-feature-worktree queue design, not merely hygiene.

### Root Cause

Each instruction was written where its author's cwd was the main workspace root, so naming a relative path was correct at the time. The prompt builder later solved the general case by injecting values host-side, and the durable instruction text was never brought along. Nothing asserted the contract, so each new order restated the old habit.

## Metadata

**Complexity:** 3
**Tags:** reliability, refactor, docs, api

## User Review Required

- **Does SQL survive at all as a documented fallback?** Options: remove the SQL path from team-facing guidance entirely, or keep it labelled for the no-API case. Recommending removal for *team* agents specifically — a team always has a running extension by definition, so the fallback describes a state that cannot occur for them. The `query-kanban` rewrite itself is scoped in `skills-declare-preconditions-and-degrade.md`.
- Confirm the contract's wording, since it becomes the thing new orders are checked against.

## Complexity Audit

### Routine

- Rewording the 15 port-file references in `teamWiring.ts` to use the port supplied in the prompt.
- Adding grep gates for both classes.

### Complex / Risky

- **Installed orders are stale until rewritten.** The bodies live in DB config (`terminals.standingOrders`); editing the constants changes nothing already installed. This is the same delivery problem as `remove-the-seat-orders-code-reviewed-clause.md`, with the same precedent to follow (`rewriteStandingOrdersForRename`, `standingOrders.ts:63`) and the same documented failure mode (`a-stale-standing-order-can-still-reach-a-live-agent.md`). A constant-only edit ships nothing.
- **Standing orders have no per-dispatch injection point, which is the whole reason this is awkward.** The drive prefix can interpolate a port because it is built per dispatch; a durable order cannot. So the order text must refer to the port *the prompt already carries* rather than carrying a value itself — meaning the two must agree, and the prompt must always carry it. Verify the port line is present for every role that receives a queue order, not just the lead: if a member's prompt lacks it, rewording the order strands them. **This is the one thing that could turn a wording change into a real change, and it should be checked before the rewording, not after.**
- **`GET /catalog` is the discoverability answer, so do not add a second one.** `switchboard-manage-console-skill.md` records the decision: over a localhost HTTP API with shell-capable hosts, another surface "adds discoverability/ergonomics, not capability". The contract should point at the catalog rather than restating the endpoint list in prose that then drifts.
- **Do not overreach into non-team agents.** A cloud or DB-less agent legitimately has no API, and `skills-declare-preconditions-and-degrade.md` owns that case. This plan's contract is scoped to *team* agents, who always have a running extension.

## Edge-Case & Dependency Audit

**Migration.** Installed orders rewritten in place. No user-visible state changes; agents receive different text on their next delivery.

**Security.** Net positive. Fewer instructions telling agents to read files under `.switchboard/`, and no instruction to open the DB directly. The port and token continue to be host-injected, never file-scraped, which is already the pattern `apiToken` follows.

**Side effects.** Order bodies get slightly shorter. Any agent mid-session with an old order keeps the old wording until re-delivered — acceptable, since the old wording still works in the main workspace.

**Ordering.** Should land before the per-feature-worktree queue work, which depends on the contract holding. Independent of the orders library, but the library is where the reworded fragments ultimately live, so if that ships first this becomes part of it.

## Dependencies

- **Pairs with** `skills-declare-preconditions-and-degrade.md`, which owns the `query-kanban` rewrite. This plan owns the contract and the order text; that one owns the skill.
- **Absorbed by** `compose-standing-orders-from-a-library.md` if that ships first — the reworded text becomes fragments there.
- **Precondition for** the per-feature-worktree queue design.

## Adversarial Synthesis

**"The port file works — this is churn."** It works in the main workspace and nowhere else, and "nowhere else" now includes every per-feature worktree. The rewording is what makes the worktree design possible without touching it again.

**"Just copy the port file into the worktree."** Considered and rejected: it plants ephemeral runtime state inside a git checkout that deliberately ignores it, and it needs re-planting on every server restart. The host already knows the port and already injects it. Making the instruction match the mechanism is strictly less machinery.

**"SQL is a useful escape hatch when the API is missing something."** Then the API is missing something, and that is the finding worth having. A silent SQL workaround hides the gap and bypasses canonicalisation; a failed endpoint call surfaces it. Note the rewrite is instructed to flag any query with no endpoint equivalent for exactly this reason.

**"A written contract will not stop the next order re-adding a path."** On its own, no — which is why the deliverable is a grep gate as much as a sentence. The gate is what makes the contract enforceable.

## Proposed Changes

1. **Verify the port line reaches every role receiving a queue order**, before rewording anything.
2. **Reword the 15 port-file references** in `teamWiring.ts` to use the port supplied in the prompt.
3. **Rewrite installed orders** carrying the old text, per `rewriteStandingOrdersForRename`'s pattern.
4. **State the access contract** in one place — team agents use endpoints; the port comes from the prompt; the DB is host-owned and not a team capability; `GET /catalog` is the endpoint reference. Not in the injected block, which is being emptied.
5. **Grep gates**: no agent-facing instruction names `api-server-port.txt` or `kanban.db`.
6. **Leave non-team guidance alone** — that is the preconditions plan's scope.

### Migration

Installed orders rewritten in place; a constant-only change reaches nobody.

## Verification Plan

### Goal Invariants

- No standing order or prompt directed at a team agent names `.switchboard/api-server-port.txt` or `kanban.db`.
- Every role that receives a queue order also receives the port in its prompt.
- Installed orders carrying the old wording are rewritten.
- Every board read a team performs goes through an endpoint.

### Automated Tests

- **Port line present per role:** for every role that can receive a queue order, assert the composed prompt carries a literal port. This runs *first* — rewording the order while a member's prompt lacks the port would strand that member, and it is the only way this plan breaks something.
- **No host-path instructions:** assert no agent-facing instruction in `teamWiring.ts` or the prompt builder contains `api-server-port.txt` or `kanban.db`, with an explicit allowlist for host-side code that legitimately reads them (the drive prefix does, correctly, and must keep doing so).
- **Installed orders rewritten:** seed old bodies, migrate, assert they are updated — the assertion that distinguishes a shipped fix from an edited constant.
- **Reinstall does not resurrect:** run the installers after migration; assert the old wording does not return via the deterministic-id skip.
- **Endpoints cover the orders' needs:** assert every board read named in an order body corresponds to a real endpoint. Catches an order asking for something the API cannot serve, which would otherwise become the next reason someone reaches for SQL.

## Outstanding Questions

- **[user]** Does SQL survive as a labelled fallback for team agents, or go entirely?
- Is there any board read a team legitimately needs that no endpoint serves? If so it is an API gap and should be recorded as one rather than met with SQL.
- Does the standalone host inject the port the same way? The drive prefix is in `KanbanProvider`; if the standalone path composes prompts differently, the port-line assertion needs to cover both hosts.
