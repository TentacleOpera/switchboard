# One docs URL, pointed at switchboard.dev

**Complexity:** 4

## Goal

Consolidate the extension's docs URL into a single constant and retire the tutorial prompt, then move the docs site to switchboard.dev. Order matters: consolidating first means the domain move is a one-line change, where doing it the other way round edits every call site twice.

## How the Subtasks Achieve This

- **Consolidate the extension's docs URL and retire the tutorial prompt**: collapses the scattered docs links into a single constant and drops the tutorial prompt that duplicates them.
- **Move the docs site to switchboard.dev**: repoints that constant at the new domain.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Consolidate the extension's docs URL and retire the tutorial prompt](../plans/consolidate-the-docs-url-in-the-extension.md) — **CREATED**
- [ ] [Move the docs site to switchboard.dev](../plans/move-the-docs-site-to-switchboard-dev.md) — **CREATED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Ordered. **Consolidate first, then move.** With one constant in place the domain change is a single edit; done the other way round, every call site is edited twice. The newly imported Mission Control dock plan already expects to read the docs URL from the constant this feature establishes rather than carrying its own literal.

