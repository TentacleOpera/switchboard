# Process Memo Clears the Whole File but Only Ever Read the Panel's Copy of It

## Goal

Make memo consumption read the file server-side and clear only the bytes it actually consumed, so entries appended between the panel's last load and the click survive the clear instead of being destroyed unread.

### The problem

Clicking **Copy Prompt** or **Send to Planner** in the Memo tab builds the planner prompt from the *webview's* text and then truncates the *file*. Those are two different pieces of state, and the gap between them is silent data loss.

**Root cause: the read and the write target different sources.**

```ts
// src/services/TaskViewerProvider.ts:14954
const content = typeof data.content === 'string' ? data.content : '';   // ← webview copy
const issues = this._parseMemoEntries(content);
…
// :14999-15000
const memoPath = this._getMemoPath(workspaceRoot);
await fs.promises.writeFile(memoPath, '', 'utf8');                       // ← whole file
```

`src/standalone/bootstrap.ts:2513-2557` is the same shape, twice (the `send` arm and the `copy` arm each write `''`).

Anything that reached `memo.md` after the panel last loaded is inside that gap. That is not a hypothetical window — it is the normal case for the reviewer risks-to-memo feature, which is on by default (`src/webview/sharedDefaults.js:177`) and appends while the user is doing something else. Worse, the panel *deliberately* refuses to refresh a focused or dirty textarea (`src/webview/memo.js:126-135`), so the staler the user's session, the wider the gap. A risk a reviewer recorded ten minutes ago is parsed into no plan, echoed into no transcript, and then deleted.

**The agent path already knows this is dangerous.** `.claude/skills/switchboard-memo/SKILL.md:51-52` makes the agent echo every entry into the conversation *before* clearing, explicitly so nothing is lost if a later step fails. The panel path — the one the CLAUDE.md notes call "backend-driven, immune to host system prompt overrides" — has no equivalent. It is the weaker of the two.

**Second defect, same file: the entry parser shreds multi-line entries.** `_parseMemoEntries` (`TaskViewerProvider.ts:6966-6988`) splits on blank lines when there is more than one paragraph; otherwise it falls back to a per-line heuristic that starts a new entry on *any line beginning with a capital letter*:

```ts
const isNewEntry = ENTRY_PREFIXES.test(line) ||
    (line.length > 0 && line[0] === line[0].toUpperCase() && line[0] !== line[0].toLowerCase());
```

A single reviewer risk written as three sentences across three lines becomes three "entries", each a fragment, each becoming its own bogus plan. The directive asks reviewers for 1-3 sentences per risk (`agentPromptBuilder.ts:1051`), so this fires on well-behaved input, not just malformed input.

**Third defect: the parser exists twice and has already diverged.** `bootstrap.ts:2438-2456` is a copy. The prompt builders beside them have drifted for real — the extension resolves and validates a PROJECT PIN against the projects table (`TaskViewerProvider.ts:14966-14978`), the standalone copy has no pin concept at all (`bootstrap.ts:2457-2490`). Fixing the consumption logic in one place and not the other repeats exactly the divergence `CLAUDE.md` forbids.

**Not this plan:** the write side (`memo-append-seam-reviewer-risks-are-prompt-only.md`) and the panel's overwrite-on-save (`memo-panel-dirty-guard-overwrites-agent-appends.md`).

## Metadata

- **Complexity:** 6
- **Tags:** backend, bugfix, reliability

## User Review Required

One decision, stated as an assumption rather than a blocker: **the explicit Clear button stays destructive.** It is a direct user action on a deliberately hard-to-misclick button, and per `CLAUDE.md` it must not grow a confirm gate. Only *implicit* clearing — the truncate that happens as a side effect of processing — becomes consume-only. If you want Clear to also spare concurrent appends, say so and it moves into scope.

## Complexity Audit

### Routine

- Extracting the shared parser into a module and deleting both copies.
- Replacing `data.content` with a server-side read.

### Complex / Risky

- **Consume-prefix arithmetic.** The clear must remove exactly the bytes that were parsed and preserve the tail that arrived during the run. Compute against the string that was read, not against a re-parse: `remainder = fresh.slice(consumed.length)` guarded by `fresh.startsWith(consumed)`. If the guard fails (the file was rewritten, not appended to), preserve the whole file and report it — never fall back to `writeFile('')`.
- **Parser heuristic change.** The capital-letter rule is load-bearing for legacy one-line-per-thought memos typed by hand. Narrowing it must not turn a 20-line hand-typed memo into one entry. Split on `ENTRY_PREFIXES` matches when any are present; only when none are present treat a single paragraph as a single entry.
- **Standalone parity, both arms.** `bootstrap.ts` writes `''` in two places. Missing either leaves half the bug.

## Edge-Case & Dependency Audit

### Race Conditions

- Append lands *between* the server read and the truncate: covered — the truncate writes back the remainder computed from a fresh re-read at write time, not from the earlier snapshot.
- Append lands *during* the `writeFile` of the remainder: a whole-file write versus an `O_APPEND` write is still a lost-update window, narrowed from minutes to milliseconds. Closing it fully needs a lock and is out of scope; record it in the plan rather than claiming it is gone.
- Two panels (editor sidebar and browser) processing simultaneously: the second sees an empty or short file and reports "No entries to process." Acceptable and already the current behaviour.

### Security

- No change to path resolution; `workspaceRoot` still flows through the existing resolver.

### Side Effects

- After a successful consume the server pushes `memoContent` with the *remainder*, not `''` (`TaskViewerProvider.ts:15001`). The webview's `memoCleared` handling (`memo.js:139-170`) assumes a clear-to-empty; it must accept a non-empty post-consume content without treating it as a mismatch.
- `_lastServedMemoContent` must be updated to the remainder on the server write, or the watcher fires a redundant push.

### Dependencies & Conflicts

- Shares `src/services/memoFile.ts` with the append-seam plan. Whichever lands first creates the module.
- Touches the same `TaskViewerProvider.ts` / `bootstrap.ts` regions as both sibling plans — land sequentially, never concurrently.

## Dependencies

None blocking. Reads better after the append seam lands, since the consume logic can then assume appends are atomic.

## Proposed Changes

### `src/services/memoFile.ts` — one parser, both roots

Move `_parseMemoEntries` here as `parseMemoEntries`, with the fallback narrowed:

```ts
export function parseMemoEntries(content: string): string[] {
    const trimmed = content.trim();
    if (!trimmed) { return []; }
    const paragraphs = trimmed.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    if (paragraphs.length > 1) { return paragraphs; }

    const ENTRY_PREFIXES = /^(bug|thought|issue|todo|note|fix|idea)[:\s]/i;
    const lines = trimmed.split('\n').map(s => s.trim()).filter(Boolean);
    // Only split a single paragraph when it is explicitly prefix-marked. The old
    // capital-letter rule shredded any multi-sentence entry into fragments — and the
    // reviewer directive asks for 1-3 sentences per risk, so it fired on good input.
    if (!lines.some(l => ENTRY_PREFIXES.test(l))) { return [trimmed]; }
    const entries: string[] = [];
    for (const line of lines) {
        if (entries.length === 0 || ENTRY_PREFIXES.test(line)) { entries.push(line); }
        else { entries[entries.length - 1] += '\n' + line; }
    }
    return entries;
}
```

Delete `TaskViewerProvider._parseMemoEntries` (`:6966`) and the copy at `bootstrap.ts:2438`; both import from here.

### `src/services/memoFile.ts` — the consume primitive

```ts
/** Remove exactly `consumed` from the head of the memo, preserving anything appended since. */
export async function consumeMemoPrefix(workspaceRoot: string, consumed: string): Promise<string> {
    const mp = memoPathFor(workspaceRoot);
    let fresh = '';
    try { fresh = await fs.promises.readFile(mp, 'utf8'); } catch { return ''; }
    const remainder = fresh.startsWith(consumed)
        ? fresh.slice(consumed.length).replace(/^\s*\n/, '')
        : fresh;   // rewritten, not appended — preserve everything, clear nothing
    await fs.promises.writeFile(mp, remainder, 'utf8');
    return remainder;
}
```

### `src/services/TaskViewerProvider.ts:14943-15005` — read the file, consume the prefix

- Replace `const content = data.content …` with a server-side read of `memoPathFor(workspaceRoot)`. Keep accepting `data.content` only to detect the "panel had unsaved local text" case, which belongs to the sibling dirty-guard plan — do not build the prompt from it.
- Replace `await fs.promises.writeFile(memoPath, '', 'utf8')` with `const remainder = await consumeMemoPrefix(workspaceRoot, content);`, set `this._lastServedMemoContent = remainder`, and post `{ type: 'memoContent', content: remainder }`.
- Extend the success message when `remainder` is non-empty: `` `Sent N issue(s) to planner. M entry(ies) arrived during processing and were kept.` `` — the user must be able to see that something was retained, or a preserved entry looks like a failed clear.

### `src/standalone/bootstrap.ts:2513-2560` — the same change, in both arms

Both the `send` arm (`:2528-2531`) and the `copy` arm (`:2552-2554`) call `consumeMemoPrefix`. Import `parseMemoEntries` from the shared module and delete the local copy. Leave the PROJECT PIN divergence alone here — it is real but is its own plan, and widening this one hides the fix.

### `src/webview/memo.js:139-170` — accept a non-empty post-consume push

The `memoCleared` branch currently clears the textarea only when its value matches the submitted batch or is already empty. Add the remainder case: when the reply carries a `content` string, set the textarea to that value under the same dirty/focus guard, instead of `''`.

## Verification Plan

### Automated Tests

New `src/test/memo-consume-prefix-contract.test.js`:

1. **The gap case.** Seed `memo.md` with entry A. Call `memoGeneratePrompt` with a *stale* `data.content` containing only A while the file on disk holds A **and** B (B simulating a reviewer append). Assert: the prompt contains A **and** B (built from the file), and after the call the file is empty. Today this test fails twice — B is missing from the prompt and B is deleted.
2. **Append during the run.** Read-then-append-then-consume: assert the appended entry survives and is the only remaining content.
3. **Rewrite guard.** If the file no longer starts with the consumed text, assert nothing is deleted.
4. **Parser: no shredding.** A single three-line, three-sentence risk parses to exactly one entry. A `bug: … / todo: …` hand-typed memo still parses to one entry per prefixed line. Blank-line-separated input is unchanged.
5. **Parser: single implementation.** Assert both roots import from `memoFile.ts` and no second `parseMemoEntries` body exists in `src/`.
6. **Both standalone arms.** Exercise `memoGeneratePrompt` with `action: 'send'` and `action: 'copy'` against the standalone dispatcher; neither may write `''` when a remainder exists.

### Manual

- Memo tab open with two entries. From a terminal, append a third to `memo.md`. Without touching the panel, click **Copy Prompt**. The pasted prompt must contain all three.
- Repeat, but append the third entry *after* clicking. It must still be in `memo.md` afterwards, and the status line must say an entry was kept.
- Both checks again in a standalone/npx host.
