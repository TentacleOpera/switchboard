# A Half-Delivered Dispatch Has No Safe Recovery — Retry Is the Only Lever, and It Destroys State

kanbanColumn: CREATED

## Goal

When a dispatch moves the card but the prompt does not land, the operator must be able to see that it did not land, and re-deliver it without clearing the seat.

### Problem analysis

A dispatch is two effects: the card moves, and a prompt is delivered. They can separate, and when they do there is no way to tell and no safe way to act.

**Observed 2026-09-04.** A feature was dispatched to the team lead from the mobile command surface. The card moved — `plan_events` records LEAD CODED at `04:35:38Z` — but the prompt was written faster than the seat could clear its input buffer, so it never landed. That delivery defect is *Prompt delivery should be patient, not precise* (Planned, in **Prompt delivery is patient**), and it is the root cause.

What followed is this card:

- **Nothing distinguished the two states.** A card sitting in LEAD CODED with a silent seat looks identical whether the prompt landed and the agent is thinking, or the prompt never arrived. The operator had no signal either way.
- **Retry was the only available action.** There is no "re-deliver the prompt" — only dispatch again.
- **Retry was destructive.** The card was already in the column so nothing moved, but the delivery fired and cleared the lead mid-feature, losing its orchestration state. That is `a29bed0f`.

So the operator's only recovery from a benign half-failure was the action that turned it into a real one. The feature stalled.

**This is not the delivery bug.** Fixing patience stops *this* prompt from being dropped. It does not give the operator a way to recover the next time one is, for any reason — a seat that was busy, a CLI that was still booting, a pty that died between the move and the write. Half-delivery is a permanent possibility; recovery from it is currently absent.

**What already exists.** `ptySendPrompt returns no delivery evidence, and promptCount is a latch wearing a counter's name` has been through review, so the underlying evidence may be available. Confirm what it actually reports before building anything new — this card is about surfacing and acting on that evidence, not re-deriving it.

## Metadata

- **Complexity:** 4
- **Tags:** dispatch, recovery, teams, command-surface, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. A dispatch says whether the prompt landed, not just whether the card moved

The two effects must be reported separately. A dispatch that moves the card and fails to deliver is not a success, and must not be presented as one — nor as a bare failure, which invites a retry that re-moves nothing and re-delivers everything.

Start from what the delivery-evidence work already returns. If it distinguishes "written" from "landed", surface that. If it only counts writes, say so plainly rather than inferring arrival from a write.

### 2. Re-deliver must exist as its own action, and must not clear

The recovery gesture is "send that prompt again to that seat". It must be reachable without a second dispatch, and it must never clear the destination — the seat is being *repaired*, not handed new work.

This is distinct from `a29bed0f`, which stops a redispatch clearing a seat that already holds the work. That fix makes retry non-destructive; this one means the operator does not have to reach for retry at all.

### 3. The command surface reports the delivery, not the request

The mobile surface is where this started, and it is the surface most likely to be used over a link that drops. Whatever signal change 1 produces has to reach it. A phone showing "dispatched" for a prompt that never arrived is the specific failure this card exists to end.

Note that `f824db44` covers the adjacent defect — an unknown outcome re-arming the control so a retry can fire twice. Different failure, same surface: coordinate rather than duplicate.

## Edge-Case & Dependency Audit

1. **Do not infer arrival from a write.** A write that returns cleanly is not a prompt that landed — that assumption is what produced the silent half-failure. If arrival cannot be observed, report it as unobserved rather than substituting the write.
2. **Re-delivery must be safe to repeat.** An operator who cannot tell whether it worked will press it twice. Two re-deliveries of the same prompt to the same seat must not compound.
3. **Depends on `a29bed0f` for the retry path.** Until the team branch compares the work context, any redispatch still clears. Both are in flight; neither blocks the other.
4. **The root cause is `Prompt delivery should be patient, not precise`.** This card must not restate or re-fix it. Recovery exists because delivery can fail, not because it usually does.
5. **Both hosts.** Whatever evidence and re-deliver path is added must be wired in the extension host and the standalone host, and the seam checked in each composition root.

## Verification Plan

1. A dispatch whose prompt does not land is reported as delivered-card / undelivered-prompt, not as a success and not as a plain failure.
2. That state is visible from the mobile command surface, not only in the extension.
3. Re-delivering a prompt to a seat does not clear it.
4. Two identical re-deliveries do not compound.
5. Simulating the 2026-09-04 sequence — move succeeds, delivery drops, operator recovers — leaves the lead holding its context and the prompt delivered once.
6. Both hosts behave identically for the same sequence.

## Review Findings

**Nothing was implemented for this plan and there is nothing to review.** The feature's own Completion Summary records it as held: it carried no Team Dispatch Instructions and no acceptance criteria in the feature file, so no seat was given it. The report the summary says was filed does not exist — `.switchboard/orchestrator/reports/` is not present in the working tree, so that claim is unverifiable and the plan has no written record outside this note. Confirmed by inspection: `bd036e49` (the feature's implementation commit) touches none of the three proposed changes — a dispatch still reports one outcome for card-move and prompt-delivery combined, there is no re-deliver action distinct from redispatch, and the command surface still reports the request rather than the delivery. Its stated root cause (*Prompt delivery should be patient, not precise*) HAS landed, which reduces how often half-delivery happens but leaves recovery from it exactly as absent as before. No files were changed. No validation applies. This card is in CODE REVIEWED with no code behind it; it needs dispatch instructions and a seat, not a review.

## Deferred Findings

- CRITICAL — the entire plan is unimplemented while its card sits in a post-implementation column, so the board asserts work that does not exist (`.switchboard/features/prompt-delivery-is-patient-b8930ab8-17d0-4468-9aa9-ffb1cf214499.md:1`).
- MAJOR — the feature file cites a question report at `.switchboard/orchestrator/reports/2026-09-05-half-delivered-dispatch-no-seat.md`; that path does not exist, so the reason this subtask was held survives only in the summary sentence.
- MAJOR — proposed change 1 depends on what `ptySendPrompt`'s delivery evidence actually reports. `PromptDeliveryReceipt` now carries `bytesWritten`, `deliveredAt`, `promptSeq` and `readiness` — all evidence of a WRITE, none of arrival — so the plan's own rule 1 ("do not infer arrival from a write") means this card must surface "unobserved", and that decision has not been made (`src/standalone/ptyPromptDelivery.ts:146`).
