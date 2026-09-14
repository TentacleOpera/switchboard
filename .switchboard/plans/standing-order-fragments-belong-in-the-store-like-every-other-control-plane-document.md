# Standing-Order Fragment Bodies Belong in the Store, Like Every Other Control-Plane Document

## Goal

The text an agent is told lives in one place. Standing-order fragment **bodies** move into
`control_plane` alongside protocols, skills, workflows, personas and rules — versioned,
content-hashed, and overridable per workspace — instead of being TypeScript constants that need a
rebuild to change.

### Problem analysis

**Three kinds of system-authored text, three different homes, and only one has a stated reason.**

| Text | Where it lives today | Changeable without a rebuild? |
| :--- | :--- | :--- |
| Protocols, skills, workflows, personas, rules | **`control_plane`** table — `name, kind, version, content_hash, body, delivery, override_body, workspace_override` | yes |
| **Standing-order fragments** | **`src/services/standingOrderFragments.ts`** — 315 lines of constants | **no** |
| A composed standing order | nowhere — built at delivery from the fragments | n/a |

**Operator, 2026-09-14:** *"why not keep them in db like protocols. where else would they be kept."*

The third row is correct and settled: a composed order names this team and this seat, so persisting it
stores a snapshot that goes stale the moment the roster changes. That is the *"editing or replacing
them loses critical detail"* failure, and `standing-orders-additive-contract.test.js` invariant 4
already pins it — *"system protocol is composed at delivery, never persisted."*

The **second row has no such justification**. A fragment is a template. It contains no live state. It
is as static as a protocol document and it sits in source anyway.

**Why it cannot simply be moved, and this is the real constraint.** A fragment is not text — it is an
object carrying executable logic:

```ts
{ id: 'team.member.work', name: 'Team member work', order: 20, obligation: 'work',
  applies: ctx => ctx.inTeam && !ctx.isHead && !ctx.externalHead,        // predicate
  body:    ctx => ctx.headRole === 'lead' ? `Work your assigned subtask…` : '' }  // builder
```

`control_plane.body` is `TEXT`. A predicate cannot go in a text column without inventing an
interpreter, and inventing one to store twelve fragments is a worse outcome than leaving them in
source.

**So the split is between a fragment's parts, not between fragments.** Some bodies are already plain
constants — `TEAM_HEAD_COMMIT_FRAGMENT_BODY` (`:70`) and `GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY`
(`:250`) are exported as strings with no context argument. Those are indistinguishable from a protocol
document and can move today. Others are builders and must stay.

**And the override mechanism already exists.** `control_plane` carries `override_body` and
`workspace_override`. A fragment body in the store inherits per-workspace override for free — which is
the capability an operator actually wants and cannot have while the text is a compiled constant.

### Root cause

Fragments were introduced as a refactor of prompt-building code, so they landed where prompt-building
code lives. The control-plane store arrived later and took the documents that were already documents.
Nothing revisited the fragments, because from the code's point of view they are functions, and from
the operator's point of view they are text — and only the operator's view makes the inconsistency
visible.

### Non-goals

- **Persisting composed orders.** Settled and correct: composed at delivery, never stored.
- **Storing predicates or builders.** `applies` and function-valued `body` stay in source. No
  interpreter, no expression language, no sandbox.
- **Changing the additive model.** Core composes at delivery, add-ons persist as human-authored rows.
  This moves where core *text* is authored, not who may replace it.
- **Editing fragments from the UI.** The Orders tab is read-only
  (`add-an-orders-tab-to-agent-control.md`). Store-backed does not mean operator-editable.

## Metadata

**Tags:** control-plane, standing-orders, storage, standalone
**Complexity:** 5

## User Review Required

**Which fragments move?** Asserted: only those whose `body` is a **plain string constant**, verified
by type rather than by eye. A fragment whose body is a function stays in source, and the split must be
enforced by a check, not a convention — otherwise the next fragment authored as a constant lands in
source because that is where its neighbours are.

Twelve fragment ids exist today (`STANDING_ORDER_FRAGMENT_IDS`, `:55-68`). The static/dynamic census
is a prerequisite, not a detail: if only two of twelve move, this is not worth doing, and that census
should be the first step rather than an assumption.

## Proposed Changes

### 1. Census first — how many are actually static

Count fragments whose `body` is a string rather than a function. **If the answer is two, stop and
close this plan.** The value is proportional to how much text becomes changeable without a rebuild.

### 2. Static bodies become `control_plane` rows

`kind: 'standing-order-fragment'`, keyed by the existing fragment id (`team.head.commit`,
`global.queue.completion`, …). Same version and content-hash discipline as every other row.

### 3. The registry reads the store, with source as the seeded default

`STANDING_ORDER_FRAGMENTS` resolves a static body from `control_plane`, falling back to the compiled
constant when no row exists — and **records which source answered**, per the repo's fallback rule. A
store row and a compiled default must never be indistinguishable in a log.

### 4. Seeding follows the existing control-plane path

Fragments seed the way protocols do, so a fresh install has them and an upgrade does not lose an
operator's `override_body`.

### 5. Host scope

`control_plane` and the fragment registry are shared. Per `CLAUDE.md` (2026-09-14) the extension host
is being removed in a hard cutover — land it in standalone and the shared services; add no
extension-specific wiring.

## Verification Plan

### Automated Tests

- **Contract (census gate)** — assert every fragment is classified static or dynamic, and that a
  fragment with a function body is **not** in the store. The split must be mechanically enforced.
- **Contract** — a fragment body edited in `control_plane` reaches the next delivered prompt with no
  rebuild and no restart. This is the capability the plan exists for.
- **Contract** — with no store row, the compiled constant is used and the resolution logs
  `source: 'compiled-default'`.
- **Contract** — `override_body` on a fragment row wins over the seeded body, and the override
  survives an upgrade that re-seeds.
- **Contract** — `standing-orders-additive-contract` still passes unchanged. Moving where core text is
  authored must not alter the additive model or start persisting composed orders.

Run `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. A static fragment body is changeable without a rebuild.
2. A dynamic fragment stays in source, and nothing can put one in the store.
3. Every fragment resolution records whether it came from the store or the compiled default.
4. Composed orders remain unpersisted, and add-ons remain the only human-authored rows.
