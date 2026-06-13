# Worktrees Tab Fixes — Index

This work is split across five plans. Implement them in order.

| Plan | File | Scope | Status |
|------|------|-------|--------|
| Part 1: Foundation | [worktrees-1-foundation.md](worktrees-1-foundation.md) | Control plane enforcement, creation path fix, terminal creation fix, remove radio group | |
| Part 2: Tab UI | [worktrees-2-tab-ui.md](worktrees-2-tab-ui.md) | DB migration V30 (`worktrees` table), git status display, list view with Merge/Abandon | |
| Part 3: Epic Integration | [worktrees-3-epic-integration.md](worktrees-3-epic-integration.md) | Create Worktree button on epic cards, epic focus mode on kanban board | |
| Part 4: Dispatch Routing + Sub-bar | [worktrees-4-dispatch-routing.md](worktrees-4-dispatch-routing.md) | Epic → worktree prompt routing, sub-bar worktree indicator, implementation.html dispatch readiness | Implemented |
| Part 5: Terminal Target Routing | [worktrees-5-terminal-routing.md](worktrees-5-terminal-routing.md) | Fix `_getAgentNameForRole` gap — route the actual VS Code sendText to the worktree terminal | |

## Dependency Order

```
Part 1  →  Part 2  →  Part 3  →  Part 4  →  Part 5
```

Each plan's Dependencies section lists what must be complete before it can begin.
