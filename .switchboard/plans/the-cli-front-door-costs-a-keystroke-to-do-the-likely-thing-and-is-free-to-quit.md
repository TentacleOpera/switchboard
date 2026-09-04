# The CLI Front Door Costs a Keystroke to Do the Likely Thing, and Is Free to Quit

kanbanColumn: CREATED

## Goal

Running `switchboard` and pressing Enter does the thing you almost certainly wanted. Every other key means the same thing every time.

### Problem analysis

The front-door menu (`cli.ts:1993-2080`) is a flat numeric picker whose bindings move under the operator. Three specific frictions, all visible in the code:

**Enter quits.** `if (answer === null || answer === '' || answer === 'q')` exits. So the least likely intent — leaving — is the free one, and starting the board or opening the console costs a deliberate keystroke every time. The default action is the escape hatch.

**Numbers change meaning with server state.** Offline, `[3]` is the Setup wizard; online, `[3]` is Help. The prompt itself shifts from `Select an option [1-5/q]` to `[1-4/q]`. An operator who learns "3 is setup" is wrong half the time, and the half depends on whether a server happens to be running.

**Nothing is remembered.** The offline menu's real question is local or tailnet. On a headless remote box the answer is tailnet, every time, forever — and it is asked every time.

Together these mean the most common session is: read a five-item list, find the number that means what you wanted today, type it. On a phone terminal over a jittery link, that is the whole interaction.

**Relationship to `759c05b5`.** That card splits the menu into a GUI branch and a CLI branch, which is the right separation of server lifecycle from board navigation. But it fixes clutter by adding depth — `[G]`, then `[1]` or `[2]` — so reaching the leaf you always pick becomes two keystrokes instead of one. This card is the ergonomics half and it should land with or before that split, or the split makes the reported problem worse.

## Metadata

- **Complexity:** 3
- **Feature:** The /switchboard front door
- **Tags:** cli, ux

## User Review Required

None.

## Proposed Changes

### 1. Enter does the likely thing

Bind Enter to the primary action for the current state: open the board console when a server is running, start the board when one is not. Print what Enter will do, on the prompt line, so it is never a guess.

Quitting keeps `q`. Making the exit cost one deliberate character and the common action cost none is the correct way round.

### 2. Stable letters, not shifting numbers

Give every option a mnemonic key that means the same thing regardless of server state — setup, help, diagnostics, console, board. An option that is unavailable in the current state is shown greyed with its key, not renumbered away.

Accept the existing numbers as aliases so nothing that currently works stops working, but stop printing them as the primary affordance.

### 3. Remember the last serve mode

The offline menu's real question is local or tailnet, and on any given machine the answer rarely changes. Remember the last choice and make it what Enter does, showing which one it will use.

This is a genuine default, not a silent one: it is displayed before it is taken, and the other mode stays one keystroke away. It must record which source answered — remembered value, explicit flag, or first-run — so "why did it start tailnet?" is answerable.

### 4. Do not add a level to reach the common leaf

Whatever structure the front door ends up with, starting the board on a machine that always starts it the same way must remain one keystroke. If `759c05b5`'s branch lands, its GUI arm must honour the remembered mode so `[G]` then Enter is the whole interaction — not `[G]` then a second pick.

## Edge-Case & Dependency Audit

1. **Non-TTY is untouched.** `cli.ts:1975` already bails when stdin is not a TTY; none of this applies to scripted invocation.
2. **A remembered mode that cannot run.** If tailnet is remembered and Tailscale is down, say so and offer local — do not silently fall back, and do not fail with the tailnet error alone.
3. **First run has nothing remembered.** Enter must still have a defined meaning; pick the safe one (local) and say so.
4. **Overlaps `759c05b5` and `5cc038b6`.** All three touch the same menu. This is the ergonomics of it, `759c05b5` is the structure, `5cc038b6` is the exit codes and the dead setup handler. Sequence them rather than editing the same function three times.
5. **The keys must not collide with the board console's own keys** once the console is the thing Enter opens.

## Verification Plan

1. `switchboard` with a server running, then Enter, opens the board console.
2. `switchboard` with no server, then Enter, starts the board in the remembered mode, having said which.
3. The prompt line states what Enter will do, in both states.
4. A given letter means the same thing whether or not a server is running.
5. The existing numeric choices still work.
6. `q` exits, and Enter no longer does.
7. A remembered tailnet mode with Tailscale down reports that and offers local rather than falling back silently.
8. Non-TTY invocation is unchanged.
