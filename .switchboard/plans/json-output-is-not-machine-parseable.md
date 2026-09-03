# `--json` output is not machine-parseable: an interactive prompt is appended, and stdout truncates on exit

## Goal

Make `switchboard <cmd> --json` emit exactly one JSON document on stdout and nothing else, complete regardless of size, so any agent or script can pipe it straight into a parser.

### Problem Analysis

Two independent defects, both of which make `--json` unusable without a wrapper.

**1. An interactive picker line is appended after the JSON.**

`switchboard ready --json` writes the JSON document, then appends:

```
Select a card to dispatch (1-161) [or Enter to exit]:
```

Every JSON parser fails on this: `json.decoder.JSONDecodeError: Extra data: line 6608 column 1 (char 230116)`. The prompt is emitted even when stdout is not a TTY (verified over ssh, which allocates no TTY). `--json` is an explicit request for machine output and must suppress the picker entirely, not merely skip blocking on it.

**2. stdout truncates past roughly 400KB.**

Measured on `plans "PLAN REVIEWED"`:

| `--limit` | bytes | result |
| :-- | :-- | :-- |
| 100 | 146,757 | valid |
| 300 | 360,448 | valid |
| 500 | 425,984 | truncated mid-document |

425,984 is exactly 416KB — a buffer boundary, not a card count. The cutoff moves with load: an agent session on the same board measured it at roughly 250KB. This is the classic Node pattern where `process.exit()` is called with pending asynchronous writes still queued on a piped stdout; the process dies before the buffer drains. It cannot be worked around reliably by callers, because the threshold is not deterministic.

### Root Cause

1. The picker is invoked on a code path that checks TTY-ness (or does not check at all) rather than checking whether `--json` was requested. `--json` should short-circuit every interactive affordance.
2. `process.exit()` is called while stdout still has buffered data. On a pipe, Node's stdout is asynchronous, so anything unflushed is lost. The fix is to stop calling `process.exit()` on the success path and let the event loop drain naturally, or to await a flush before exiting.

## Metadata

**Complexity:** 3
**Tags:** cli, bugfix, agent-ergonomics
**Project:** Browser Switchboard

## Proposed Changes

1. **Gate the picker on `--json`.** Wherever the "Select a card to dispatch" prompt is emitted, return the JSON and exit before reaching it when `--json` is set. Audit every command for the same pattern, not just `ready`.
2. **Stop truncating stdout.** Remove `process.exit()` from success paths, or replace with a drain-then-exit helper that awaits the `drain` event when `process.stdout.write()` returns `false`. Set exit codes via `process.exitCode` instead.
3. **Send human-readable output to stderr, always.** It already goes there for some commands; make it consistent so stdout carries the JSON document alone.
4. **Add a regression test** that pipes `--json` output of each command to a parser and asserts it parses, including one case above 500KB.

## Verification Plan

1. `switchboard ready --json | python3 -c 'import sys,json;json.load(sys.stdin)'` exits 0.
2. `switchboard plans "PLAN REVIEWED" --limit 500 --json | wc -c` returns the full document, and it parses.
3. Repeat 2 under concurrent board load — byte count is stable across runs.
4. No command emits "Select a card to dispatch" when `--json` is present.
5. `switchboard plans "CREATED" --json 2>/dev/null` yields JSON alone on stdout.
