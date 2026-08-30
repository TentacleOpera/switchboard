# The Memo File Is a Shared Append Target, Not One Panel's Buffer

**Complexity:** 6

## Goal

Make .switchboard/memo.md safe for two writers - an agent appending entries and an operator typing in the panel - because today each one destroys the other's work.

Three defects share one cause: the memo file is treated as one panel's buffer rather than a shared append target. Processing clears the whole file while having read only the panel's copy, so anything appended since the panel loaded is destroyed unread. The panel's dirty-guard protects the operator's typing by discarding everything an agent appended. And a reviewer's risks reach the memo through prompt text asking an agent to write the file, rather than through an append seam that cannot lose a concurrent write.

The fix is one real append path that both writers use, so neither has to win.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Memo Panel Protects Your Typing by Throwing Away Everything an Agent Appended](../plans/memo-panel-dirty-guard-overwrites-agent-appends.md) — **CREATED** — ID: c8a614e1-6da4-4dfd-b70b-accc769c6377
- [ ] [Reviewer Risks Reach the Memo Through a Sentence, Not a Seam — Give `memo.md` a Real Append Verb](../plans/memo-append-seam-reviewer-risks-are-prompt-only.md) — **CREATED** — ID: 5e5c91b3-acde-450b-9009-75859ddabf3e
- [ ] [Process Memo Clears the Whole File but Only Ever Read the Panel's Copy of It](../plans/process-memo-clears-entries-it-never-read.md) — **CREATED** — ID: a34b851d-c8e7-4380-8e33-3d6f0ee932fc
<!-- END SUBTASKS -->
