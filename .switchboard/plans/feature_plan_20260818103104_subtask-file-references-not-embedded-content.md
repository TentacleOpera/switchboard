# Replace embedded subtask content with file references in parent ticket docs

## Goal

### Problem

When tickets are imported, subtask content (title + full description) is appended to the parent ticket's `## Subtasks` section via `_buildSubtaskEntry` in `TaskViewerProvider.ts`. This duplicates content that already exists in the subtask's own `.md` file — subtasks are written as separate files with `parentId:` frontmatter in the bulk import path (`importAllTasks`), yet their full description is ALSO inlined into the parent.

The user's analogy is apt: "when you write code, do you append the modules imported to the end of the file so we don't have to open other files? NO YOU DO NOT." The parent ticket should reference subtask files by name (like imports), not inline their content.

### Root Cause

`_buildSubtaskEntry` (TaskViewerProvider.ts:24329) produces a checklist line **plus an indented description block** (`  > full description...`), embedding up to 1500 chars of the subtask's description directly into the parent file. This is the sole producer of embedded subtask content. The subtask's own file (written separately by `_writeTaskDocument`) already contains this description in full.

The duplication exists because the `## Subtasks` section was originally the ONLY way subtasks were surfaced — separate subtask files were added later (the bulk import path writes them with `parentId:` frontmatter), but the embedding was never removed.

### Background Context

- **Bulk import** (`importAllTasks`, line 24825): writes each subtask as a separate `.md` file via `_writeTaskDocument` (lines 25056–25082, 25108–25135) AND embeds full content in the parent's `## Subtasks` section via `_buildSubtasksSection` → `_buildSubtaskEntry` → duplication.
- **Single-ticket import** (`importTaskAsDocument`, line 23308): only embeds subtask content in the parent via `_buildSubtasksSection` (lines 23368, 23397) — does NOT create separate subtask files. This path needs subtask file creation added.
- **Display**: `stripImportedSubtasksBlock` (ticketDisplayContent.ts:14) strips the `## Subtasks` section from the detail pane, so the embedded content is not visible in the Tickets panel UI — but it IS visible in the raw `.md` file, which is what agents and users read.
- **Push**: `stripAppendedBlocksForPush` (ticketDisplayContent.ts:61) strips the section before pushing to the remote, so embedded content never reaches ClickUp/Linear.
- **Merge**: `_mergeSubtasksSection` (TaskViewerProvider.ts:24468) preserves entries the payload lacks (cross-list subtasks invisible to the list fetch). This never-delete rule must be preserved.

## Metadata

**Complexity:** 6
**Tags:** refactor, backend, ui
**Project:** Browser Switchboard

## User Review Required

The approach change (id-in-line-text vs id-in-filename) is a design correction made during the improve pass. The original plan proposed encoding the id only in the filename and extracting it via regex; this was superseded because the regex fails for Linear IDs (which contain hyphens). The corrected approach keeps the id in the line text as trailing parens, making the file link purely additive. No user decision is needed — the correction is strictly an improvement — but the user should be aware that the line format is `- [ ] [title](filename.md) (id) — status`, not `- [ ] [title](filename.md) — status` as originally proposed.

## Complexity Audit

### Routine
- Removing the description embedding from `_buildSubtaskEntry` — deleting the `rawDesc` reading, heading demotion, truncation, and indented `  >` block; adding the file-reference link.
- Adding the markdown link syntax stripping to `_parseSubtaskLine` (one regex match, extracts title from `[title](filename.md)` for the titleKey).
- Updating test assertions in `tickets-subtask-embedding.test.js` (assertions #11, #12; add new assertions for link format and migration).

### Complex / Risky
- **Migration of existing files**: ~4,000 installs have parent ticket files with embedded subtask descriptions. The `_mergeSubtasksSection` merge runs on every import and preserves entries the payload lacks — so old embedded lines would persist alongside new file-reference lines unless explicitly migrated. The migration must strip description blocks from legacy entries during the merge. Entries the payload lacks are kept as stripped checklist lines (no file link); a matching payload subtask replaces the slot with a file-reference line on the next merge.
- **Single-ticket import path**: `importTaskAsDocument` does not currently create subtask files. Adding subtask file creation here is new behavior that must match the bulk path's approach. Using `_writeTaskDocument` (as the bulk path does) ensures asset hydration, relocalisation, and cache registration for parity.
- **File link correctness**: the markdown link in the `## Subtasks` section must point to the correct subtask filename. The filename is deterministic (`${provider}_${id}_${slug}.md` where slug = `_slugify(title)`), so it can be computed in `_buildSubtaskEntry` without filesystem access. But a subtask whose title changes between imports would produce a different slug, and the link would break until the next import. This is acceptable — the link is regenerated on every import.
- **Shape detection in `stripAppendedBlocksForPush`**: the legacy shape detector checks for `- [ ]` checklist lines + `  >` description blocks. The new format has `- [ ] [title](filename.md) (id) — status` lines with no `  >` blocks. The detector must still recognize the new format as generated (via the marker, which is unchanged). No change needed — see Edge-Case #6.

## Edge-Case & Dependency Audit

1. **Cross-list subtasks (ClickUp)**: `GET /list/{id}/task` only returns records whose home list is that list. The merge preserves entries the payload lacks. File-reference links to cross-list subtask files must still be preserved — the merge rule is unchanged, only the entry format changes. A cross-list subtask whose home list hasn't been imported yet will have a file-reference link pointing to a non-existent file. This is acceptable — the file is created when the home list is imported, and the link is regenerated on every import from that list.
2. **Legacy lines without ids**: the shipped per-open enrich wrote ClickUp subtasks as `- [ ] ${name}` with no id. `_parseSubtaskLine` keys these by title. The new format includes a file link AND keeps the id in trailing parens, but legacy lines won't have either. The migration in `_mergeSubtasksSection` strips description blocks from legacy entries but does not add links — the link is added when a matching payload subtask arrives and overwrites the slot. Legacy lines without a payload match are preserved as-is (minus description block) per the never-delete rule.
3. **Subtask files not yet created (single-ticket import)**: if `importTaskAsDocument` writes the parent before the subtask files, the links point to non-existent files. Fix: write subtask files before the parent file, or accept the brief window (subtask files are written in the same import operation, milliseconds apart). The bulk path writes parents first, then subtasks in a separate loop — the ordering is not critical because the links resolve when a human/agent reads the file later, not at write time.
4. **Subtask title with parentheses**: `_parseSubtaskLine` anchors the id at the END of the line (before the ` — status` suffix). The new format `- [ ] [title](filename.md) (id) — status` has two parenthesized groups: `(filename.md)` in the middle and `(id)` at the end. The existing regex `\(([^()]*)\)$` matches only the LAST `(...)` group at the end — `(id)`, not `(filename.md)`. No ambiguity. The titleKey extraction strips the markdown link syntax (`[title](filename.md)` → `title`) AFTER the id is extracted, so the titleKey is clean.
5. **`stripImportedSubtasksBlock` display strip**: the marker `<!-- generated by import -->` is unchanged, so the display strip continues to work. The section is still stripped from the detail pane.
6. **`stripAppendedBlocksForPush` legacy detection**: the legacy shape detector checks for `^- \[[ xX]\]` lines + `^[ \t]{2,}>(?:[ \t].*)?$` description lines. The new format has no `  >` lines. Legacy files (pre-marker) with the new format would not be detected as generated by the shape rule. But the marker is always present in new writes, so the marker-first detection path covers them. Legacy files with old embedded content are still detected by the shape rule. No change needed.
7. **Test ratchet (assertion #14 in `tickets-subtask-embedding.test.js`)**: the strip-call count ratchet and the `_readTicketFilePayload` choke point are unaffected — the display strip still runs.
8. **Description demotion (assertion #11)**: `_buildSubtaskEntry` currently demotes line-leading headings in the embedded description. With the description removed, this logic is dead and should be removed. The test assertion checking for `#{1,6}` demotion must be updated — the regex should no longer be present in the function body.
9. **`markdownDescription` field (assertion #12)**: with no description embedding, reading `st?.markdownDescription` is no longer needed. The test assertion must be updated — `markdownDescription` should no longer be referenced in `_buildSubtaskEntry`'s body.
10. **Orphan-subtask upsert (assertion #8)**: the orphan-subtask upsert in `importAllTasks` (line 25141) checks for an existing `## Subtasks` section by looking for `_SUBTASKS_HEADING`. This is unchanged — the heading is still present, only the entry format changes.
11. **`_slugify` preserves underscores**: `_slugify` uses `[^\w\-]+` to strip non-word, non-hyphen characters. `\w` includes `_`, so underscores in titles survive into the slug. This means filenames like `linear_id_fix_the_bug.md` have multiple `_`-delimited segments. This is why the id MUST stay in the line text — extracting it from the filename by splitting on `_` is ambiguous when the slug contains underscores.
12. **Variable scoping in `importTaskAsDocument`**: `node` (line 23348) and `subtasks` (line 23376) are block-scoped inside the `if/else` branches. Subtask file creation code must either run inside those branches or use outer-scope variables hoisted before the branches. Using `_writeTaskDocument` requires the raw subtask task objects, which must be collected into an outer-scope array.

## Dependencies

- None — this plan modifies only existing code in `TaskViewerProvider.ts`, `ticketDisplayContent.ts`, and `tickets-subtask-embedding.test.js`. No new dependencies, no cross-plan dependencies.

## Adversarial Synthesis

Key risks: (1) the original plan's id-in-filename regex was broken for Linear IDs (hyphens), silently breaking the never-delete merge invariant for an entire provider — corrected by keeping the id in line text; (2) migration strips description blocks but leaves linkless lines for entries without payload matches — acceptable as transient (payload match converts them); (3) subtask files in the single-ticket path must use `_writeTaskDocument` for asset hydration parity with the bulk path. Mitigations: id-in-line-text makes `_parseSubtaskLine`'s existing regex work unchanged (test assertion #13 passes without modification); migration is additive (strip only, never delete); `_writeTaskDocument` reuse ensures full parity with the bulk path's subtask file creation.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — `_buildSubtaskEntry` (line 24329)

Replace the description embedding with a file-reference link. Remove the `rawDesc` reading, heading demotion, truncation, and indented description block. Add a computed filename for the markdown link. **Keep the id in the line text as trailing parens** — do NOT encode it only in the filename.

> **Superseded:** The original plan proposed `- [ ] [title](filename.md) — status` with the id encoded only in the filename, extracted via `\]\((\w+)_(\w+?)_.+\.md\)$`.
> **Reason:** `\w` is `[a-zA-Z0-9_]` — it does not match hyphens. Linear identifiers (`TEAM-123`) and UUIDs (`abc123de-4567-...`) contain hyphens. The regex fails for every Linear subtask, leaving the merge key empty and breaking the never-delete invariant. Additionally, `_slugify` preserves underscores, making `_`-delimited filename parsing ambiguous.
> **Replaced with:** `- [ ] [title](filename.md) (id) — status` — the id stays in trailing parens (its current position), the file link is purely additive. `_parseSubtaskLine`'s existing end-anchored regex `\(([^()]*)\)$` matches `(id)` at the end, not `(filename.md)` in the middle. No ambiguity.

```typescript
private _buildSubtaskEntry(provider: 'linear' | 'clickup', st: any): { id: string; text: string } {
    let done = false;
    let title = '';
    let idStr = '';
    let statusStr = '';

    if (provider === 'clickup') {
        const ty = String(st?.status?.type || '').toLowerCase();
        done = ty === 'closed' || ty === 'done';
        title = String(st?.name || st?.id || '').trim();
        idStr = String(st?.id || '').trim();
        if (st?.status?.status) {
            statusStr = String(st.status.status).trim();
        }
    } else {
        const ty = String(st?.state?.type || '').toLowerCase();
        done = ty === 'completed' || ty === 'canceled';
        title = String(st?.title || st?.id || '').trim();
        idStr = String(st?.identifier || st?.id || '').trim();
        if (st?.state?.name) {
            statusStr = String(st.state.name).trim();
        }
    }

    title = title.replace(/\s+/g, ' ');
    const statusPart = statusStr ? ` — ${statusStr}` : '';
    // File reference instead of embedded content: the subtask's own .md file
    // holds the full description. The link uses the deterministic filename
    // (${provider}_${id}_${slug}.md) so it resolves without filesystem access.
    // The id stays in the line text (trailing parens) so _parseSubtaskLine's
    // existing end-anchored extraction works unchanged — encoding the id only
    // in the filename breaks for Linear ids (hyphens) and ambiguous slugs
    // (_slugify preserves underscores).
    const slug = this._slugify(title);
    const filename = `${provider}_${idStr}_${slug}.md`;
    const text = `- [${done ? 'x' : ' '}] [${title}](${filename}) (${idStr})${statusPart}`;
    return { id: idStr, text };
}
```

Key changes:
- Removed `rawDesc` reading (both provider branches).
- Removed heading demotion (`#{1,6}` regex), truncation (1500-char slice), and indented `  >` description block.
- Added computed `filename` and markdown link `[title](filename.md)`.
- The `id` is still returned in the object AND kept in the line text as `(idStr)` trailing parens — the file link is additive, not a replacement for the id.

### 2. `src/services/TaskViewerProvider.ts` — `_parseSubtaskLine` (line 24407)

Add markdown link syntax stripping for the titleKey. The id extraction from trailing parens is **unchanged** — the existing regex `\(([^()]*)\)$` correctly matches `(id)` at the end of the line, not `(filename.md)` in the middle. The only new logic is stripping `[title](filename.md)` → `title` for the titleKey, so legacy title-keyed matching still works.

> **Superseded:** The original plan proposed replacing the id extraction with a filename-parsing regex `\]\((\w+)_(\w+?)_.+\.md\)$`.
> **Reason:** Broken for Linear IDs (hyphens in `\w` character class). See the Superseded callout in change #1 for details.
> **Replaced with:** Keep the existing id extraction regex unchanged. Add a post-extraction step that strips the markdown link syntax from `rest` for the titleKey only.

```typescript
private _parseSubtaskLine(line: string): { id: string; titleKey: string } {
    let rest = line.trim().replace(/^- \[[ xX]\]\s*/, '');
    const statusMatch = rest.match(/\s+—\s+[^—]*$/);
    if (statusMatch && statusMatch.index !== undefined) {
        rest = rest.slice(0, statusMatch.index).trimEnd();
    }
    let id = '';
    const idMatch = rest.match(/\(([^()]*)\)$/);
    if (idMatch && idMatch.index !== undefined) {
        id = idMatch[1].trim();
        rest = rest.slice(0, idMatch.index).trimEnd();
    }
    // Strip markdown link syntax for titleKey: [title](filename.md) → title.
    // The id is already extracted above from trailing parens; the link's
    // (filename.md) is NOT at the end so it is not mistaken for the id.
    // Greedy .* handles titles containing brackets (e.g. "[FIX] the bug").
    const linkMatch = rest.match(/^\[(.*)\]\([^)]*\.md\)$/);
    if (linkMatch) {
        rest = linkMatch[1];
    }
    return { id, titleKey: `__title:${rest.replace(/\s+/g, ' ').toLowerCase()}` };
}
```

Note: test assertion #13 (which pins the end-anchored id regex `\(([^()]*)\)$`) passes **without modification** — the regex is still present and unchanged. This is a significant advantage over the original plan's approach.

### 3. `src/services/TaskViewerProvider.ts` — `_mergeSubtasksSection` (line 24468)

Add migration: when parsing existing entries, strip any legacy `  >` description blocks from the entry text. This removes old embedded-content from legacy entries. The never-delete rule is preserved — entries the payload lacks are kept, just with their description blocks stripped (as linkless checklist lines). A matching payload subtask replaces the slot with a new file-reference line on the next merge.

> **Superseded:** The original plan's prose said "converting them to the new format" implying legacy entries get file-reference links during migration.
> **Reason:** The migration code only strips description blocks — it does not add file links. The conversion to file-reference format happens when a matching payload subtask arrives and overwrites the slot. The prose overpromised what the code delivers.
> **Replaced with:** Corrected prose: the migration strips description blocks; the payload merge converts matching entries to file-reference lines. Entries without a payload match stay as stripped checklist lines (no link) — acceptable because the subtask file may not exist yet.

```typescript
private _mergeSubtasksSection(
    provider: 'linear' | 'clickup',
    existingSection: string,
    subtasks: any[]
): string {
    const merged = this._parseSubtaskEntries(existingSection);
    // Migration: strip legacy `  >` description blocks from existing entries.
    // The new format uses file-reference links, not embedded content. Entries
    // the payload lacks are kept (never-delete rule) with description blocks
    // removed; a matching payload subtask replaces the slot with a file-
    // reference line on the next merge.
    for (const [key, text] of merged) {
        const lines = text.split('\n');
        const checklistLine = lines[0];
        const hasDescBlock = lines.length > 1 && lines.slice(1).some(l => /^[ \t]{2,}>/.test(l));
        if (hasDescBlock) {
            merged.set(key, checklistLine);
        }
    }
    for (const st of subtasks || []) {
        const entry = this._buildSubtaskEntry(provider, st);
        const parsed = this._parseSubtaskLine(entry.text.split('\n')[0]);
        const idKey = parsed.id || entry.id;
        const slot = (idKey && merged.has(idKey))
            ? idKey
            : (merged.has(parsed.titleKey) ? parsed.titleKey : (idKey || parsed.titleKey));
        merged.set(slot, entry.text);
    }
    if (merged.size === 0) { return ''; }
    let section = TaskViewerProvider._SUBTASKS_HEADER;
    for (const text of merged.values()) {
        section += `\n${text}`;
    }
    return section;
}
```

### 4. `src/services/TaskViewerProvider.ts` — `importTaskAsDocument` (line 23308)

Add subtask file creation so the single-ticket import path also produces separate subtask files (not just embedded content in the parent). Use `_writeTaskDocument` for each subtask — matching the bulk path — to ensure asset hydration, image relocalisation, orphan cleanup, and cache registration for parity.

> **Superseded:** The original plan proposed using bare `fs.writeFileSync` for subtask files, with content built by `_buildLinearImportPlanContent` / `_buildClickUpImportPlanContent`.
> **Reason:** Bare `fs.writeFileSync` skips `_hydrateTicketAssets` and `_relocalizeInlineImages`. The bulk path uses `_writeTaskDocument` which does both. A subtask with inline images would get CDN URLs baked into its file on the single-ticket path but local paths on the bulk path — inconsistent, and the push path would re-upload images that were never relocalised.
> **Replaced with:** Use `_writeTaskDocument(resolvedRoot, provider, subtaskTask, targetDir, [])` for each subtask — exactly what the bulk path does (lines 25075, 25128). This ensures full parity: asset hydration, relocalisation, orphan cleanup, and cache registration.

**Scoping fix:** The original plan's code referenced `node.subtasks` and `subtasks` from outside their `if/else` blocks — both are block-scoped and would be `ReferenceError`s. The corrected approach hoists subtask task objects into an outer-scope array before the branches, then writes subtask files after `targetDir` is computed.

Implementation:

**Step 4a** — Before the `if (provider === 'linear')` block (around line 23322), add:
```typescript
let subtaskTasks: any[] = [];
```

**Step 4b** — Inside the Linear branch, after `content += this._buildSubtasksSection('linear', rawSubtasks)` (line 23368), add:
```typescript
subtaskTasks = rawSubtasks;
```

**Step 4c** — Inside the ClickUp branch, after `content += this._buildSubtasksSection('clickup', subtasks)` (line 23397), add:
```typescript
subtaskTasks = subtasks;
```

**Step 4d** — After `targetDir` is computed and `fs.mkdirSync(targetDir, { recursive: true })` (line 23425), but BEFORE `fs.writeFileSync(filePath, content, 'utf8')` (line 23445), add:
```typescript
// Write subtask files BEFORE the parent so file-reference links resolve.
// Uses _writeTaskDocument for parity with the bulk import path (importAllTasks):
// asset hydration, image relocalisation, orphan cleanup, and cache registration.
for (const stTask of subtaskTasks) {
    if (!stTask?.id) { continue; }
    await this._writeTaskDocument(resolvedRoot, provider, stTask, targetDir, []);
}
```

Note: `_buildLinearImportPlanContent` and `_buildClickUpImportPlanContent` already write `parentId:` frontmatter when the task has a `parentId` field (lines 8288, 8562). The subtask objects from `linear.getSubtasks()` and `details.subtasks` carry `parentId` (LinearSyncService.ts:412, ClickUpSyncService.ts:766), so the frontmatter will be correct.

Note: `_writeTaskDocument` is async and does asset hydration (network calls for subtask attachments). This is acceptable for the single-ticket path because it is user-initiated, not on a repeating background timer like the bulk path. The bulk path also calls `_writeTaskDocument` per subtask (lines 25075, 25128).

### 5. `src/services/ticketDisplayContent.ts` — `stripAppendedBlocksForPush` (line 61)

No change needed. The marker-first detection path (`<!-- generated by import -->`) is unchanged and covers all new writes. The legacy shape detector still handles old files with `  >` description blocks. New files without `  >` blocks but with the marker are caught by the marker path. The legacy shape detector's checklist test `^- \[[ xX]\]` also matches the new format lines (`- [ ] [title](filename.md) (id) — status` starts with `- [ ]`), so even a legacy file somehow getting the new format without a marker would be detected.

### 6. `src/test/tickets-subtask-embedding.test.js` — Update assertions

Update the following assertions to reflect the new file-reference format:

- **Assertion #11** (line 141): the heading-demotion regex `#{1,6}` is no longer present in `_buildSubtaskEntry`'s body. Change the assertion from "must be present" to "must NOT be present" (or remove the assertion and replace with a check that the function produces a markdown link, not an embedded description).
- **Assertion #12** (line 155): `st?.markdownDescription` is no longer referenced in `_buildSubtaskEntry`'s body. Change the assertion from "must be present" to "must NOT be present" (or remove it).
- **Assertion #13** (line 165): the end-anchored id regex `\(([^()]*)\)$` is **still present and unchanged** in `_parseSubtaskLine`. This assertion passes **without modification**. This is a key advantage of the id-in-line-text approach over the original plan's id-in-filename approach.
- **Add new assertion**: `_buildSubtaskEntry` must produce a markdown link to the subtask file. Verify the output contains `](` and `.md)` and does NOT contain `\n  >`.
- **Add new assertion**: `_parseSubtaskLine` must strip the markdown link syntax for the titleKey. Verify that a line `- [ ] [title](filename.md) (id) — status` produces `titleKey: __title:title` (not `__title:[title](filename.md)`).
- **Add new assertion**: `_mergeSubtasksSection` must strip legacy `  >` description blocks from existing entries during merge (migration test). Feed an existing section with a `  >` description block, run a merge with an empty payload, and verify the output has no `  >` lines.

## Verification Plan

### Automated Tests
1. **Unit tests**: run `node src/test/tickets-subtask-embedding.test.js` — all assertions pass with the updated format. (SKIPPED this run per session directive — the checks remain written down for execution later.)
2. **Compilation**: run `npm run compile` — webpack build succeeds with no type errors. (SKIPPED this run per session directive — the checks remain written down for execution later.)

### Manual Tests
3. **Bulk import test**: import a ClickUp list with subtasks → verify:
   - Each subtask has its own `.md` file with `parentId:` frontmatter.
   - The parent's `## Subtasks` section contains file-reference links (`- [ ] [title](filename.md) (id) — status`), NOT embedded description blocks.
   - No `  >` lines in the `## Subtasks` section.
4. **Single-ticket import test**: import a single Linear issue with subtasks → verify:
   - Subtask files are created (previously they were not).
   - Subtask files have `parentId:` frontmatter.
   - The parent's `## Subtasks` section contains file-reference links.
5. **Migration test**: take an existing parent file with embedded `  >` description blocks, run a bulk import → verify the `## Subtasks` section is migrated (description blocks stripped, file-reference links present for matching subtasks).
6. **Push test**: edit a parent ticket and push → verify the `## Subtasks` section is stripped by `stripAppendedBlocksForPush` and does not reach the remote.
7. **Display test**: open a parent ticket in the Tickets panel → verify the `## Subtasks` section is stripped by `stripImportedSubtasksBlock` and not shown in the detail pane.
8. **Cross-list subtask preservation**: import a ClickUp list where a subtask's home list is different → verify the subtask's file-reference link is preserved in the parent's `## Subtasks` section (never-delete merge rule).
9. **Legacy line compatibility**: take a parent file with legacy `- [ ] title` lines (no id, no link) → run an import → verify the legacy line is preserved (never-delete rule) and a matching payload subtask replaces it with a file-reference line.
10. **Linear subtask merge**: import a Linear issue, rename a subtask remotely, re-import → verify the old subtask line is REPLACED (not duplicated) by the new line. This tests that the id-in-line-text extraction works correctly for Linear IDs with hyphens.
11. **Title with underscores**: import a subtask whose title contains underscores (e.g. `fix_the_bug`) → verify the file-reference link is correct and `_parseSubtaskLine` extracts the id from trailing parens (not from the filename).
