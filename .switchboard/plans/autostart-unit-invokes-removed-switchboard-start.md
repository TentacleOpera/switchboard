# Every Shipped Autostart Template on All Three Platforms Invokes `switchboard start`, Which Was Removed and Exits 1

kanbanColumn: BACKLOG

**Found reviewing:** [A Raspberry Pi Installs Switchboard With `apt`](raspberry-pi-installs-switchboard-with-apt.md) — 179c1a28

## What is wrong

`docs/autostart/switchboard.systemd.service` is the documented way to run the standalone host as a
service. Its `ExecStart` calls `switchboard start`, a subcommand that no longer exists — the CLI
now prints *"'start' has been replaced"* and exits 1, directing the reader to `local` or `tailnet`.

So an operator who follows the autostart docs gets a unit that fails on every activation. With the
template's own `Restart=on-failure` and `RestartSec=5`, systemd retries until the default start
limit trips and then parks the unit in `failed`. The board never comes up, and nothing in the
template hints at the cause — the operator is looking at a file whose three `YOUR_USERNAME`
placeholders they just edited, so the natural conclusion is that they got a path wrong.

**All three platform templates carry it**, so there is no OS on which the documented autostart
path works. This is not a Linux-only slip.

## Evidence

`src/standalone/cli.ts:2616`:

```ts
if (firstArg === 'start') {
    console.error('[switchboard] \'start\' has been replaced.');
    console.error('  Use \'switchboard local\'  — serve the board on this machine (loopback).');
    console.error('  Use \'switchboard tailnet\' — serve the board on this machine AND your tailnet.');
    process.exit(1);
}
```

Every template in `docs/autostart/`, grepped for the removed subcommand:

```
switchboard.systemd.service:54  ExecStart=/usr/bin/npx switchboard start --port 7777 --no-open --workspace ...
switchboard.launchd.plist:46            <string>start</string>
switchboard-windows.xml:57      <Arguments>switchboard start --no-open --port 7777 --workspace "C:\Users\..."
README.md                       0 occurrences
```

The README is clean, which is why this survives a skim: the prose page a reader checks first says
nothing wrong, and the defect is in all three files they copy from.

`start` is also absent from the CLI's own usage block, which lists `local` and `tailnet` as the two
serve modes. The `usage()` text and the autostart docs disagree, and the docs are the stale side.

## Fix

Replace `start` with `local` in **all three** templates, and note in each that `tailnet` is the
substitution for a board that should be reachable across a tailnet. The rest of each file is
correct and well commented — `Type=simple`, the explanation of why `--detach` must not be passed to systemd,
`Restart=on-failure` — and should not be touched.

Add `TimeoutStopSec` while there: `switchboard stop` is known to free the port and log
*"Server stopped"* without the process exiting, so a unit with no stop timeout hangs on restart.

## Metadata

- **Complexity:** 2
- **Tags:** standalone, docs, devops, bugfix

## Review Findings

All three templates now invoke `switchboard local` and each carries a comment naming `tailnet` as
the substitution and stating that `start` was removed — verified against `cli.ts:2908`, which still
prints the replacement notice and exits 1, and against the `KNOWN_SUBCOMMANDS` set, which accepts
`local` and `tailnet`. `TimeoutStopSec=15` was added to the systemd template only; launchd's
`ExitTimeOut` and the Windows Task Scheduler `ExecutionTimeLimit` have no equivalent stop-hang
failure and were left alone. Files changed by this review: none — the implementation was correct as
delivered. Validated with `npx tsc -p tsconfig.test.json --noEmit` (clean), `npm test` (green after
regenerating `protocol-catalog.json`, which the implementation commit left stale), and the two new
contract suites.

## Deferred Findings

- NIT `docs/autostart/switchboard.launchd.plist:39` — launchd has no stop timeout set. `ExitTimeOut` defaults to 20s and SIGKILLs after, so the systemd hang mode does not apply; not worth a change.
- NIT `docs/autostart/switchboard-windows.xml:53` — the comment block sits above `<Command>` rather than above `<Arguments>`, where the verb actually is. Cosmetic.
