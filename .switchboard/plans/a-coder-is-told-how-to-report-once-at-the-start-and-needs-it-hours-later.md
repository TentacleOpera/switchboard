# A Coder Is Told How to Report Once, at the Start, and Needs It Hours Later

kanbanColumn: CREATED

## Goal

A coder that has finished its work knows how to report it, regardless of how long the task took or how much context it consumed.

### Problem analysis

**Observed 2026-09-05.** Coders are consistently failing to post their completion reports on long tasks. The operator's reading is that the coding work fills the context and the instruction is gone by the time it is needed. That is what the delivery points show.

**Every delivery of the reporting instruction is front-loaded:**

| when | carries standing orders |
| :--- | :--- |
| terminal establish / orientation | yes |
| dispatch prompt | yes — `payload.standingOrders !== false && !isMessage` (`bootstrap.ts:2462`) |
| after a clear | yes |

All three are at the beginning of the seat's work. Nothing delivers the instruction near the moment it is acted on, and a long task can put hours and a full context between the two.

**A plain message carries nothing.** The `!isMessage` term above means a lead prodding its coder mid-task — the most natural moment to re-state an expectation — sends no standing orders at all.

**The head is topped up and the member is not.** Turn-end notifications are delivered with `standingOrders: true` (`bootstrap.ts:3177`, *"the recipient acts on this notification"*), and those fire whenever a seat goes quiet. So a lead's obligations are refreshed throughout its life. A member's are delivered once and never again — `grep` for any re-delivery of completion instructions returns nothing.

So the two roles have opposite exposure to exactly the failure being reported, and the one that is not refreshed is the one that reports.

**The signal for "about to need it" already exists.** A seat going quiet while holding an uncompleted card is the turn-end signal, and it is already computed — `42c31413` shipped it, and `PlanIngestionEngine` already gathers the seat liveness and the card state it needs. A coder in that state has either just finished or is stuck; both want the reporting recipe.

## Metadata

- **Complexity:** 3
- **Tags:** teams, prompts, standing-orders, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. Re-deliver the completion instruction at turn-end, to the seat

When a member seat goes quiet holding a card with no completion posted, send that seat its completion fragment. It is the moment the instruction is about to be used.

The trigger and the recipient resolution both already exist; this is a delivery that does not happen, not a mechanism that must be built.

### 2. Send the recipe, not the whole block

Context exhaustion is the reported cause, so re-delivering the entire standing-orders block makes the problem worse. Send the completion fragment alone — the verb, the endpoint, the payload — and nothing else.

There is precedent for the block being too heavy on a relay path: `989e5de5` records one coder callback delivering four prompts to the lead, three carrying the whole standing-orders block.

### 3. Once per quiet period, not per tick

A seat that stays quiet gets one re-delivery, not a stream. If it produces output and goes quiet again, that is a new quiet period and a fresh re-delivery is correct.

### 4. Do not re-deliver to a seat that has already reported

The card carries the answer — a posted completion means the instruction was followed and nothing needs saying.

## Edge-Case & Dependency Audit

1. **This does not replace the stall nudge.** `3993f420` tells the *lead* that a card has been out too long. This tells the *coder* how to report. Same family of trigger, different addressee, and neither covers the other — a coder that has forgotten the recipe is not helped by its lead being told, and a dead coder is not helped by being sent instructions.
2. **A re-delivery is a prompt and will consume a turn.** On a seat that was merely thinking, this interrupts. Keep it small (change 2) and gate it on genuine quiet, not on a pause.
3. **The `!isMessage` exclusion is deliberate** — a message relay should not carry the full block. This change does not alter that; it adds a separate, targeted delivery.
4. **External-head members report by writing a file**, not by POST (`externalMemberCallback`). Their fragment is different and must be the one re-delivered for those seats.
5. **Both hosts.**
6. **Does not apply to heads**, which are already refreshed on every turn-end notification.

## Verification Plan

1. A coder that goes quiet holding an uncompleted card receives its completion fragment.
2. What it receives is the fragment alone, not the full standing-orders block.
3. A coder that has already posted its completion receives nothing.
4. A seat that goes quiet, is re-delivered to, produces output and goes quiet again receives a second re-delivery.
5. A seat that stays quiet receives one, not a stream.
6. An external-head member receives its file-report fragment, not the POST recipe.
7. Both hosts behave identically.
