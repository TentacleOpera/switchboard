<!-- switchboard:agents-protocol:start -->
- Plans reach the board on their own: a `.md` file written to a designated
  plans directory is imported automatically by a watcher. Committing is
  irrelevant — untracked files import too. Never import a plan yourself.
- Memo capture mode: while active, append each user message verbatim — do not
  analyse, plan, or write code. Begin every reply with `[MEMO CAPTURE ACTIVE]`.
- Kanban questions: use the `query-kanban` skill. Displayed column labels differ
  from the stored IDs, so hand-written SQL silently returns nothing.
<!-- switchboard:agents-protocol:end -->
