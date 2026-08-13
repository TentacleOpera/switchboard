---
name: delegates
description: "Child-side delegate contract — how a delegate child terminal reports its result to the head agent that dispatched it: POST /delegates/result with your correlationId and agent instance id, the result size cap and resultRef pointer, --max-time on every curl, and why terminal output is never a result channel (the 256 KB scrollback ring drops early output)."
allowed-tools: Bash
user-invokable: false
---

# Skill: Delegate Contract (child-side)

You are running inside a **delegate child terminal** launched by a Switchboard head agent.
Your parent dispatched work to you over localhost HTTP and is now blocked on a join,
waiting for your result. This skill is the complete contract for reporting back.

> **Read this once at the start of your turn.** The protocol is small, and getting it
> wrong is silent: a child that never reports is not a failure the parent can diagnose
> without inspecting the work, so a misshapen POST just looks like "no answer".

> **Scope.** `/delegates/*` is for **short parallel fan-out**: 90 s per join, 30 min per
> batch hard ceiling. Attended, long-running, review-gated single-coder work — dispatch a
> subtask, get called back, review the diff, resend a fix — belongs in the
> **`terminal-coder-dispatch`** skill, not here. Use this skill when your parent dispatched
> you through `/delegates/dispatch`; use that one when the driving agent sends prompts to a
> named coder terminal and reviews the result.

---

## 1. Bootstrap — who you are

Your `agentInstanceId` is interpolated into your prompt text by the host at dispatch
time. It is **not** in your environment, and you cannot discover it at runtime — the
host bakes it into the prompt because a worktree CWD cannot read the fleet registry.
Scan your prompt for a line of the form:

```
DELEGATE ID: <agentInstanceId>
```

That UUID is your identity for every callback. If you cannot find it, you are not a
delegate child and this skill does not apply — stop reading and do your normal work.

The API port is in `.switchboard/api-server-port.txt` (relative to the workspace root,
which is your CWD). The session token, if one is set, is in your environment as
`SWITCHBOARD_API_TOKEN`. Every `curl` below carries both.

---

## 2. The three endpoints

All three live on `http://127.0.0.1:${PORT}` (loopback only — never use `localhost`,
which can resolve to `::1` and bypass a v4-only listener).

| Endpoint | Method | Purpose |
|---|---|---|
| `/delegates/dispatch` | POST | Parent-only — dispatches work to children. **You do not call this.** |
| `/delegates/await` | GET | Parent-only — the blocking join. **You do not call this.** |
| `/delegates/result` | POST | **You call this exactly once when your work is done.** |

You only ever call `/delegates/result`. The other two are documented here so you know
what your parent is doing on the other end of the join — do not call them.

---

## 3. Reporting your result — `POST /delegates/result`

Call this **exactly once**, at the end of your turn, whether you succeeded or failed.
The body is JSON:

### Completion

```bash
PORT=$(cat .switchboard/api-server-port.txt)
TOKEN="${SWITCHBOARD_API_TOKEN:-}"
curl -s --max-time 30 -X POST "http://127.0.0.1:${PORT}/delegates/result" \
  -H "Content-Type: application/json" \
  ${TOKEN:+-H "Authorization: Bearer ${TOKEN}"} \
  -d "{
    \"correlationId\": \"<CORRELATION_ID from your prompt>\",
    \"childInstanceId\": \"<your agentInstanceId>\",
    \"status\": \"reported\",
    \"result\": \"<your result summary>\"
  }"
```

### Failure

```bash
curl -s --max-time 30 -X POST "http://127.0.0.1:${PORT}/delegates/result" \
  -H "Content-Type: application/json" \
  ${TOKEN:+-H "Authorization: Bearer ${TOKEN}"} \
  -d "{
    \"correlationId\": \"<CORRELATION_ID from your prompt>\",
    \"childInstanceId\": \"<your agentInstanceId>\",
    \"status\": \"error\",
    \"error\": \"<what went wrong>\"
  }"
```

### Field reference

| Field | Required | Type | Notes |
|---|---|---|---|
| `correlationId` | yes | string | From your prompt (`CORRELATION_ID:` line). Identifies the batch. |
| `childInstanceId` | yes | string | Your `agentInstanceId` (`DELEGATE ID:` line). |
| `status` | no | `"reported"` \| `"error"` | Defaults to `"reported"`. Use `"error"` only for a real failure. |
| `result` | no | string | Your result summary. **Capped at 64 KB.** See below. |
| `error` | no | string | The failure reason. Required when `status` is `"error"`. |

### Response envelope

```json
{ "success": true }
```

On error (unknown `correlationId`, missing fields, etc.):

```json
{ "success": false, "error": "<reason>" }
```

A `success:false` means your parent no longer has a join open for this batch — either
the batch lifetime elapsed, the parent's turn ended, or the correlation id is wrong.
You cannot fix this by retrying; report it to the user if anyone is watching.

---

## 4. The 64 KB result cap and `resultRef`

Your `result` string is capped at **64 KB**. If you exceed that, the host spills the
full text to `.switchboard/delegate-results/<batchId>-<childInstanceId>.txt` and
replaces `result` in the join payload with a pointer:

```
[Result stored at <absolute path>]
```

Your parent reads the pointer path and opens the file itself. **Do not try to outsmart
this by chunking** — one POST, one result. If your result is large, write a concise
summary (a few paragraphs of what you did, which files you touched, anything the
parent should review) and let the cap handle the rest. The parent reviews the diff
either way; the result is a claim, not the work.

---

## 5. Terminal output is NOT a result channel

Your terminal scrollback is a **256 KB ring buffer**. A coding agent produces that in
well under a minute, so anything you printed more than a minute ago is already gone —
evicted, not recoverable. The parent cannot read your terminal bytes while detached,
and even when attached it sees only the tail.

**The result endpoint is the contract.** Print whatever helps a human watching your
terminal, but never rely on terminal output to carry your answer to the parent. If
you only print your result and never POST it, the parent's join resolves on evidence
(file changes + quiescence) with `status:"inferred"` and no result text — your
account of what you did is lost.

---

## 6. Every `curl` carries `--max-time`

Every `curl` in this skill carries `--max-time`. This is a correctness requirement,
not a nicety: an orphaned client (your shell timed out, the parent died, the network
hiccupped) without a max-time holds a wait slot on the server forever, and the
delegate join has a bounded concurrent-wait cap. A single hung curl can pin the
whole join surface. `--max-time 30` is the default; use whatever fits inside your
own tool timeout, but never omit it.

---

## 7. You do not need to do anything else

- Do not poll `/delegates/await`. That is the parent's job.
- Do not call `/delegates/dispatch`. You are not a parent (and depth is capped at 3
  anyway — a grandchild dispatch is allowed but a great-grandchild is rejected).
- Do not POST `/delegates/result` more than once per batch. A second POST for the
  same `correlationId` + `childInstanceId` is a no-op (the first result wins); it is
  not an error, but it is wasted work.
- If your work is done and you POST the result, you are finished. The parent's join
  returns your result inside its own turn; you do not need to wait for anything.

---

## 8. What your parent sees

When you POST `/delegates/result`, your parent's next (or current) `GET /delegates/await`
returns your entry with `status:"reported"` and your `result` text. If you never
POST, the parent's join still resolves — on evidence of completion (files under your
assigned scope changed, then you went quiet) — but with `status:"inferred"`,
`changedFiles` listed, and no `result`. Both are successful joins; only "nothing
happened at all, and it went quiet" is a timeout.

Reporting is strictly better than not reporting: the parent gets your account of the
work instead of having to infer it from the diff, and the join resolves immediately
rather than after a quiescence window.
