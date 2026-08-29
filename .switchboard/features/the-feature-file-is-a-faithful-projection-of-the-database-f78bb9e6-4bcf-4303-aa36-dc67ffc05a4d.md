# The Feature File Is a Faithful Projection of the Database

**Complexity:** 6

## Goal

Make what is on disk agree with what is in the database, in both directions, for the two things a feature file carries: its subtask list and its title.

Three defects share one fault line. A feature subtask block is a lossy write-time snapshot rather than a projection, so a feature can hold linked subtasks in the DB that the file never shows - and every agent reading that file sees them as absent. Concurrent regenerations of the same block are not serialised, so one can silently drop what another just wrote. And a card rename is a DB-only write that the next file re-import overwrites from the plan H1, so a renamed card does not stay renamed.

These are not column-containment bugs - that concern is owned by Board State Integrity. These three are about the file being an honest mirror of the rows: written completely, written safely under concurrency, and not silently reverted on the next watcher pass.


## How the Subtasks Achieve This

- **Feature Subtask Block Goes Invisible on Stale Feature File Read**: fixes the case where a subtask is correctly linked in the DB but absent from the file's `<!-- BEGIN SUBTASKS -->` block — which every agent reading that file sees as absent. Keeps the file to DB direction rather than deleting it.
- **Serialize feature-file subtask-block regeneration**: makes the block a self-healing projection of the `plans` table instead of a lossy write-time snapshot, and serialises concurrent regenerations so one pass cannot silently drop what another just wrote.
- **Renaming a card is a supported operation**: one verb that writes the card's topic and the plan file's `# H1` together, so a rename survives `UPSERT_PLAN_SQL` overwriting `topic` from the file on the next re-import.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Serialize feature-file subtask-block regeneration so the file can't silently lose subtasks the DB has](../plans/feature_plan_20260803170350_serialize-feature-subtask-block-regeneration.md) — **PLAN REVIEWED** — ID: 9a9b104e-5005-47f1-a730-c62326b214cb
- [ ] [Feature Subtask Block Goes Invisible on Stale Feature File Read](../plans/feature-subtask-block-goes-invisible-on-stale-file-read.md) — **PLAN REVIEWED** — ID: 432a2fe8-285c-46ab-8fb9-1a7c02f08034
- [ ] [Renaming a card is a supported operation](../plans/renaming-a-card-is-a-supported-operation.md) — **PLAN REVIEWED** — ID: 513bd63b-13a3-4c50-b8b9-f1e812b818c9
<!-- END SUBTASKS -->

## Dependencies & sequencing

Serialisation lands **first**. The invisible-subtask fix repairs one symptom of a block that is written unsafely; making the block a properly serialised projection is the mechanism that stops it recurring, and fixing the symptom first risks a repair that the next concurrent regeneration undoes.

The rename subtask is independent of the other two and can land at any point — it touches `topic`, not the subtask block. It is grouped here because it is the same fault line: a DB write that the file silently reverts.

**Not in scope: column containment.** A subtask's column following its feature, and a feature move carrying its subtasks, are owned by *Board State Integrity and the Agent Instructions That Describe It*. That is about which column a row is in; this feature is about whether the file on disk honestly mirrors the rows at all. Keep the two separate — a fix that conflates them will reach for the column writer when the defect is in the file writer.

**Blocked-on note.** `Renaming a card is a supported operation` is currently load-bearing for other work: a feature whose title has drifted from its contents cannot be corrected durably until it lands, because a DB topic write reverts on the next watcher pass. *Reaching the API Server From a Sandbox* carries exactly that problem today.
