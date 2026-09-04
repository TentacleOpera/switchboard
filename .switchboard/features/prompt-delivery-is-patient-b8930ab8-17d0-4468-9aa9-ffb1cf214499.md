# Prompt delivery is patient

**Complexity:** 5

## Goal

A prompt must not land in a CLI that is not accepting input. Four loose plans converge on one rule: an unrecognised seat waits on the longest known ceiling rather than the shortest, that floor applies to every delivery and not just the first, and a configured delay is a floor rather than a replacement for readiness detection. Prerequisite outside the feature: the startup-command provenance plan, which supplies the command each seat actually ran.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Explain the seat-clear session-restart toll where seat CLIs are configured](../plans/devin-clear-reauth-toll-visibility.md) — **CREATED** — ID: fe5daf69-426e-4b5a-92b0-da1df24fe6cd
- [ ] [A delay setting must not be able to defeat known-CLI readiness detection](../plans/a-delay-setting-must-not-be-able-to-defeat-known-cli-readiness.md) — **CREATED** — ID: 4570333b-0cce-4e40-b8a0-8da118d86191
- [ ] [A seat's CLI family is derived once at spawn and frozen, so every Devin readiness fix silently misses any seat not classified as Devin](../plans/a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it.md) — **CREATED** — ID: d8f86774-a517-4040-b9aa-513decfaae17
- [ ] [Prompt delivery should be patient, not precise — an unknown seat gets the fastest profile and deliveries 2..N get no gate at all](../plans/prompt-delivery-should-be-patient-not-precise.md) — **CREATED** — ID: c11ab0cd-0370-44d8-a33d-58a875d2cd18
<!-- END SUBTASKS -->

## Dependencies & sequencing (2026-09-04, Board Collapse 08)

**Prerequisite outside this feature:** *Two stores hold agent startup commands, they currently
disagree, and a spawned seat records no evidence of which one it read*. It stamps each seat with the
command it actually ran and which store answered, which is what makes a family re-derivation
possible. Land it first.

1. **A seat's CLI family is derived once at spawn and frozen** — owns the `clearReadiness.ts`
   unknown-arm change: an unrecognised family takes the **longest** known ceiling, not the shortest,
   because guessing short breaks delivery while guessing long costs seconds.
2. **Prompt delivery should be patient, not precise** — the per-delivery floor and the awaitable
   orientation relay. **Its duplicate edit of the same unknown arm is removed**; step 1 owns it.
   Both plans proposed the identical change to the same lines.
3. **A delay setting must not be able to defeat known-CLI readiness detection** — a configured delay
   is a floor, never a replacement.
4. **Explain the seat-clear session-restart toll where seat CLIs are configured** — static copy only,
   independent, land any time.
