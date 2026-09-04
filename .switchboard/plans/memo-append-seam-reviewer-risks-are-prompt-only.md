# Reviewer Risks Reach the Memo Through a Sentence, Not a Seam — Give `memo.md` a Real Append Verb

<!-- board-collapse-08 -->
> **MERGE TARGET 2026-09-04 (Board Collapse 08).** *Process Memo Clears the Whole File but Only Ever Read the Panel's Copy of It* has been **merged into this plan and deleted**. All three memo subtasks proposed creating `src/services/memoFile.ts` under a "whichever lands first creates it" rule, which is a merge hazard, not a plan. **This plan creates that module**, and it carries both operations:
> 
> 1. **`memoAppend`** — an `O_APPEND` write server-side through one shared helper wired in both composition roots, with the separator computed on a single `a+` handle (stat, read the last two bytes, write) so the whole file is never read. `REVIEWER_RISKS_TO_MEMO_DIRECTIVE` is repointed at it, HTTP primary with a shell `>>` fallback, and whole-file writes are forbidden.
> 2. **Prefix-consume** — memo processing reads the file server-side and clears only the consumed prefix: `remainder = fresh.slice(consumed.length)` guarded by `fresh.startsWith(consumed)`. On guard failure preserve the whole file and report; never `writeFile('')`. The duplicated `_parseMemoEntries` in both hosts is unified here, with the capital-letter entry heuristic narrowed to `ENTRY_PREFIXES` where present and one paragraph otherwise.
> 
> The explicit Clear button stays destructive with no confirm gate. Also carried: the note that the standalone prompt builder has drifted from the extension's project-pin resolution, and that `.claude/skills/switchboard-memo/SKILL.md` documents echo-before-clear as the stronger path.


## Goal

Add a `memoAppend` verb that performs an `O_APPEND` write server-side, wire it into both composition roots through one shared helper, and repoint the reviewer's risks-to-memo directive at it so appends stop being a read-modify-write performed by an LLM with generic file tools.

### The problem

`REVIEWER_RISKS_TO_MEMO_DIRECTIVE` (`src/services/agentPromptBuilder.ts:1051`) ends with *"Do NOT clear or truncate existing memo content — append only."* That sentence is the entire enforcement. There is no memo-append endpoint, no lock, no advisory write, and no test that asserts preservation — the only coverage (`src/services/__tests__/agentPromptBuilder.test.ts:232`) asserts that the `MEMO FILE:` line *renders*, not that anything survives.

**Root cause: the write path is the agent's own file tools.** The reviewer is handed an absolute path and told to be careful. Whether that becomes an `O_APPEND` write, a `cat >>`, or a read-whole-file-then-write-whole-file round trip is entirely up to the model on the day. Three consequences, all live because the feature is on by default (`src/webview/sharedDefaults.js:177`, `reviewerRisksToMemo: true`):

* **Lost update between reviewers.** Two reviewers finishing near-simultaneously each read, then each write. Whoever writes second wins; the other's risks are gone with no error anywhere.
* **Lost update against the panel.** The memo panel's `memoSave` is an unconditional whole-file write (`src/services/TaskViewerProvider.ts:14924-14930`, `src/standalone/bootstrap.ts:2501-2508`). A reviewer's read-then-write straddling a panel save discards the user's text, and vice versa.
* **Malformed entry boundaries.** The directive asks for a blank-line separator so the parser can split entries. A model appending without checking whether the file already ends in a newline produces `…last risk.Next risk begins` — one fused entry, silently.

The existing worktree guard shows the shape of the right fix and its limits: the absolute `MEMO FILE:` path is rendered at build time (`agentPromptBuilder.ts:2060-2071`) precisely because a bare relative path would resolve against a worktree whose `.switchboard/` is discarded on cleanup. That hazard was closed by *not trusting the agent to resolve a path*. The same reasoning applies to the write itself, and has not been applied yet.

**The seam already exists and is already reachable.** `POST /memo/verb/<verb>` routes to `_handlePlanningVerb` (`src/services/LocalApiServer.ts:8080-8082`), which delegates memo verbs to `TaskViewerProvider.handleServiceVerb` via an explicit allow-list in `PlanningPanelProvider.ts:199-205`. Reviewer prompts already carry a resolved `portRef` — `http://127.0.0.1:<apiPort>` with a `.switchboard/api-server-port.txt` fallback (`agentPromptBuilder.ts:1976-1978`) — and already instruct reviewers to POST to other verbs (`ptySendPrompt`, same block). Nothing new needs inventing; one verb needs adding.

**Not this plan:** the panel's dirty-textarea overwrite (`memo-panel-dirty-guard-overwrites-agent-appends.md`) and `process memo` clearing entries it never read (`process-memo-clears-entries-it-never-read.md`). Those are separate root causes on the same file. This plan only makes *writing* an append safe.

## Metadata

- **Complexity:** 5
- **Tags:** backend, api, reliability, bugfix

## User Review Required

None.

## Complexity Audit

### Routine

- Adding a verb schema entry and a provider arm — the file has ~100 sibling examples.
- Regenerating the verb catalogue (`npm run catalog:generate`).
- Adding the verb to the `PlanningPanelProvider` memo delegation list.

### Complex / Risky

- **Separator computation on append.** Deciding whether to prefix `\n\n` requires knowing the file's current tail without racing another appender. Do it on a single file handle opened `a+`: `stat` for size, read the last 2 bytes, then write through the same handle. Never read the whole file — that reintroduces exactly the round trip this plan removes.
- **Directive rewrite.** The prompt must give a primary (HTTP) and a fallback (shell `>>`) path, and must explicitly forbid whole-file writes. A vague rewrite leaves the old behaviour reachable.
- **Both composition roots.** Per `CLAUDE.md`, the trap is composition-root wiring, not verb reachability. The standalone host implements its own memo arms inline (`bootstrap.ts:2429-2560`) and its comment there — *"there's no TaskViewerProvider to delegate to"* — is **stale**: `bootstrap.ts:1083` constructs one. Adding the arm to only one root reproduces the queue-seam precedent verbatim.

## Edge-Case & Dependency Audit

### Race Conditions

- Concurrent appends from two reviewers: `O_APPEND` writes under the platform page size are atomic on local filesystems, which is the entire point of the change. The verification plan must actually exercise this with parallel writers, not assume it.
- Append landing between the panel's read and its save: **not fixed here**. That is the dirty-guard plan. Note it in the plan file so the gap is not mistaken for closed.

### Security

- The verb takes `workspaceRoot` from the payload like every sibling memo verb; resolve it through the same `_resolveStateWorkspaceRoot` path so it cannot write outside a known workspace. Do not accept an arbitrary absolute file path.

### Side Effects

- The append must **not** update `_lastServedMemoContent` (`TaskViewerProvider.ts:1420`). That field is the watcher's change detector (`:15572`); setting it on append suppresses the `memoUpdated` push and the open panel never learns anything arrived.

### Dependencies & Conflicts

- Touches the same regions of `TaskViewerProvider.ts` and `bootstrap.ts` as the other two memo plans. Land them sequentially in one worktree; do not run them concurrently.

## Dependencies

None blocking. If `process-memo-clears-entries-it-never-read.md` lands first it will already have created `src/services/memoFile.ts`; otherwise this plan creates it.

## Proposed Changes

### `src/services/memoFile.ts` *(new)* — the one write implementation both roots call

```ts
export function memoPathFor(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.switchboard', 'memo.md');
}

/** Append one entry, guaranteeing a blank-line separator, without ever reading the whole file. */
export async function appendMemoEntry(workspaceRoot: string, text: string): Promise<void> {
    const body = String(text ?? '').replace(/\s+$/, '');
    if (!body) { return; }
    const mp = memoPathFor(workspaceRoot);
    await fs.promises.mkdir(path.dirname(mp), { recursive: true });
    const fh = await fs.promises.open(mp, 'a+');
    try {
        const { size } = await fh.stat();
        let tail = '';
        if (size > 0) {
            const buf = Buffer.alloc(Math.min(2, size));
            await fh.read(buf, 0, buf.length, size - buf.length);
            tail = buf.toString('utf8');
        }
        const sep = size === 0 ? '' : (tail.endsWith('\n\n') ? '' : (tail.endsWith('\n') ? '\n' : '\n\n'));
        await fh.write(sep + body + '\n');   // single O_APPEND write
    } finally {
        await fh.close();
    }
}
```

### `src/services/TaskViewerProvider.ts:14923` — the verb arm, beside `memoSave`

```ts
case 'memoAppend': {
    const workspaceRoot = this._resolveStateWorkspaceRoot(data.workspaceRoot);
    if (!workspaceRoot) { return { success: false, message: 'No workspace folder found for memo.' }; }
    await appendMemoEntry(workspaceRoot, data.text);
    // Deliberately NOT touching _lastServedMemoContent — the watcher must see
    // this as a change and push memoUpdated to any open panel.
    return { success: true, appended: true };
}
```

### `src/services/verbSchemas.ts:1752` — schema entry beside `memoSave`

```ts
memoAppend: { fields: { workspaceRoot: { type: 'string' }, text: { type: 'string' } } },
```

### `src/services/PlanningPanelProvider.ts:199` — extend the memo delegation guard

Add `|| verb === 'memoAppend'` to the condition. Without this the `PLANNING_VERBS` guard below it rejects `POST /memo/verb/memoAppend` with *"Unknown Planning verb"* — the verb is catalogued under `TASKVIEWER_VERBS`.

### `protocol-catalog.json` + `src/generated/verbAllowlist.ts` — regenerate, do not hand-edit

Run `npm run catalog:generate` (`package.json:948`) after the arm exists; both files are generated from the source scan.

### `src/standalone/bootstrap.ts:2501` — the same arm in the standalone root

```ts
if (verb === 'memoAppend') {
    await appendMemoEntry(workspaceRoot, payload.text);
    return { success: true, appended: true };
}
```

Also correct the stale comment at `bootstrap.ts:2431-2434` — a `TaskViewerProvider` *is* constructed in standalone (`:1083`); the inline duplication is a legacy of when it was not, and is the reason standalone's memo behaviour has drifted.

### `src/services/agentPromptBuilder.ts:1051` — rewrite the directive around the seam

Replace the "append only" plea with a mechanism. The reviewer branch already computes `portRef` at `:1976`; reuse it in the block built at `:2067-2071`:

```
REMAINING RISKS TO MEMO: After completing your review, record each remaining risk as a
separate memo entry. Use the append endpoint — POST {portRef}/memo/verb/memoAppend with
{"workspaceRoot":"<root>","text":"<one risk>"} — one call per risk. It appends atomically
and inserts the entry separator for you. If the endpoint is unreachable, append with a
shell redirect to the MEMO FILE path below: printf '\n\n%s\n' "<risk>" >> "<MEMO FILE>".
NEVER read the memo file and write it back — that destroys entries other agents and the
user added while you were reviewing. Never clear or truncate it. Each entry: 1-3 sentences,
concise and actionable. No remaining risks — skip this step entirely.
MEMO FILE: <absolute path>
```

Keep the absolute `MEMO FILE:` line: it is still the fallback path and still the worktree guard.

## Verification Plan

### Automated Tests

New `src/test/memo-append-seam-contract.test.js`:

1. **Atomicity.** Fire 20 `appendMemoEntry` calls with `Promise.all` against one temp memo; assert the file parses to exactly 20 entries and every payload string is present. This is the test that would fail today.
2. **Separator correctness.** Append to (a) an absent file, (b) a file with no trailing newline, (c) one ending `\n`, (d) one ending `\n\n`. Assert every result splits on `/\n\s*\n/` into the expected entry count with no fused entries.
3. **Never truncates.** Seed 5KB of existing content, append once, assert the original bytes are a prefix of the result.
4. **Composition-root parity.** Assert `memoAppend` is answered by both the `TaskViewerProvider` verb surface and the standalone `planningVerb` dispatcher, and that both call the shared helper — the seam audit `CLAUDE.md` asks for, not a verb-reachability check.
5. **Watcher push preserved.** Assert the arm does not assign `_lastServedMemoContent`.
6. **Directive contract.** Assert `REVIEWER_RISKS_TO_MEMO_DIRECTIVE` contains `memoAppend`, contains a `>>` fallback, and contains an explicit prohibition on reading-then-writing the file.

Existing `src/services/__tests__/agentPromptBuilder.test.ts:232` must still pass — the `MEMO FILE:` line stays.

### Manual

- With the extension running and the Memo tab open, `curl -X POST http://127.0.0.1:<port>/memo/verb/memoAppend -d '{"workspaceRoot":"<root>","text":"probe risk"}'`. The entry lands, and the panel updates live (provided the textarea is neither focused nor dirty — the dirty case is the sibling plan).
- Same `curl` against a standalone/npx host — must behave identically.
- Dispatch a real reviewer with **Risks to Memo** enabled from a worktree; confirm entries land in the *main checkout's* `.switchboard/memo.md` and are blank-line separated.
