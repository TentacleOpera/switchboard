# Replace embedded subtask content with file references in parent ticket docs

## Goal

### Problem

When tickets are imported, subtask content (title + full description) is appended to the parent ticket's `## Subtasks` section via `_buildSubtaskEntry` in `TaskViewerProvider.ts`. This duplicates content that already exists in the subtask's own `.md` file — subtasks are written as separate files with `parentId:` frontmatter in the bulk import path (`importAllTasks`), yet their full description is ALSO inlined into the parent.

The user's analogy is apt: "when you write code, do you append the modules imported to the end of the file so we don't have to open other files? NO YOU DO NOT." The parent ticket should reference subtask files by name (like imports), not inline their content.

### Root Cause

`_buildSubtaskEntry` (TaskViewerProvider.ts:24195) produces a checklist line **plus an indented description block** (`  > full description...`), embedding up to 1500 chars of the subtask's description directly into the parent file. This is the sole producer of embedded subtask content. The subtask's own file (written separately by `_writeTaskDocument`) already contains this description in full.

The duplication exists because the `## Subtasks` section was originally the ONLY way subtasks were surfaced — separate subtask files were added later (the bulk import path writes them with `parentId:` frontmatter), but the embedding was never removed.

### Background Context

- **Bulk import** (`importAllTasks`): writes each subtask as a separate `.md` file AND embeds full content in the parent's `## Subtasks` section → duplication.
- **Single-ticket import** (`importTaskAsDocument`): only embeds subtask content in the parent — does NOT create separate subtask files. This path needs subtask file creation added.
- **Display**: `stripImportedSubtasksBlock` (ticketDisplayContent.ts:14) strips the `## Subtasks` section from the detail pane, so the embedded content is not visible in the Tickets panel UI — but it IS visible in the raw `.md` file, which is what agents and users read.
- **Push**: `stripAppendedBlocksForPush` (ticketDisplayContent.ts:61) strips the section before pushing to the remote, so embedded content never reaches ClickUp/Linear.
- **Merge**: `_mergeSubtasksSection` (TaskViewerProvider.ts:24334) preserves entries the payload lacks (cross-list subtasks invisible to the list fetch). This never-delete rule must be preserved.

## Metadata

**Complexity:** 6
**Tags:** refactor, backend, ui
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Removing the description embedding from `_buildSubtaskEntry` — one code block deletion.
- Updating `_parseSubtaskLine` to handle the new link format.
- Updating test assertions in `tickets-subtask-embedding.test.js`.

**Complex/Risky:**
- **Migration of existing files**: ~4,000 installs have parent ticket files with embedded subtask descriptions. The `_mergeSubtasksSection` merge runs on every import and preserves entries the payload lacks — so old embedded lines would persist alongside new file-reference lines unless explicitly migrated. The migration must strip description blocks from legacy entries during the merge, converting them to the new format.
- **Single-ticket import path**: `importTaskAsDocument` does not currently create subtask files. Adding subtask file creation here is new behavior that must match the bulk path's file naming (`${provider}_${id}_${slug}.md`) and frontmatter (`parentId:`).
- **File link correctness**: the markdown link in the `## Subtasks` section must point to the correct subtask filename. The filename is deterministic (`${provider}_${id}_${slug}.md` where slug = `_slugify(title)`), so it can be computed in `_buildSubtaskEntry` without filesystem access. But a subtask whose title changes between imports would produce a different slug, and the link would break until the next import. This is acceptable — the link is regenerated on every import.
- **Shape detection in `stripAppendedBlocksForPush`**: the legacy shape detector checks for `- [ ]` checklist lines + `  >` description blocks. The new format has `- [ ] [title](filename.md)` lines with no `  >` blocks. The detector must still recognize the new format as generated (via the marker, which is unchanged).

## Edge-Case & Dependency Audit

1. **Cross-list subtasks (ClickUp)**: `GET /list/{id}/task` only returns records whose home list is that list. The merge preserves entries the payload lacks. File-reference links to cross-list subtask files must still be preserved — the merge rule is unchanged, only the entry format changes.
2. **Legacy lines without ids**: the shipped per-open enrich wrote ClickUp subtasks as `- [ ] ${name}` with no id. `_parseSubtaskLine` keys these by title. The new format includes a file link, but legacy lines won't have one. The migration in `_mergeSubtasksSection` must convert legacy lines to the new format (add the link) when a matching payload subtask arrives, and preserve them as-is when no payload match arrives (the never-delete rule).
3. **Subtask files not yet created (single-ticket import)**: if `importTaskAsDocument` writes the parent before the subtask files, the links point to non-existent files. Fix: write subtask files BEFORE the parent file in `importTaskAsDocument`.
4. **Subtask title with parentheses**: `_parseSubtaskLine` anchors the id at the END of the line (before the ` — status` suffix). The new format adds a markdown link `[title](filename.md)` which contains parentheses. The parser must be updated to handle link parentheses vs id parentheses — the id is still the last `(...)` group before the status suffix, but the link's `(filename.md)` must not be mistaken for the id. Solution: place the id AFTER the link, or use a different id format. The cleanest approach: `- [ ] [title](filename.md) — status` with the id embedded in the filename (which already contains `${provider}_${id}_`).
5. **`stripImportedSubtasksBlock` display strip**: the marker `<!-- generated by import -->` is unchanged, so the display strip continues to work. The section is still stripped from the detail pane.
6. **`stripAppendedBlocksForPush` legacy detection**: the legacy shape detector checks for `^- \[[ xX]\]` lines + `^[ \t]{2,}>(?:[ \t].*)?$` description lines. The new format has no `  >` lines. Legacy files (pre-marker) with the new format would not be detected as generated by the shape rule. But the marker is always present in new writes, so the marker-first detection path covers them. Legacy files with old embedded content are still detected by the shape rule. No change needed.
7. **Test ratchet (assertion #14 in `tickets-subtask-embedding.test.js`)**: the strip-call count ratchet and the `_readTicketFilePayload` choke point are unaffected — the display strip still runs.
8. **Description demotion (assertion #11)**: `_buildSubtaskEntry` currently demotes line-leading headings in the embedded description. With the description removed, this logic is dead and should be removed. The test assertion checking for `#{1,6}` demotion must be updated.
9. **`markdownDescription` field (assertion #12)**: with no description embedding, reading `st?.markdownDescription` is no longer needed. The test assertion must be updated.
10. **Orphan-subtask upsert (assertion #8)**: the orphan-subtask upsert in `importAllTasks` (line 25007) checks for an existing `## Subtasks` section by looking for `_SUBTASKS_HEADING`. This is unchanged — the heading is still present, only the entry format changes.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — `_buildSubtaskEntry` (line 24195)

Replace the description embedding with a file-reference link. Remove the `rawDesc` reading, heading demotion, truncation, and indented description block. Add a computed filename for the markdown link.

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
    const slug = this._slugify(title);
    const filename = `${provider}_${idStr}_${slug}.md`;
    const text = `- [${done ? 'x' : ' '}] [${title}](${filename})${statusPart}`;
    return { id: idStr, text };
}
```

Key changes:
- Removed `rawDesc` reading (both provider branches).
- Removed heading demotion, truncation, and indented `  >` description block.
- Added computed `filename` and markdown link `[title](filename.md)`.
- The `id` is still returned for the merge key, but is no longer in the checklist line text — it's embedded in the filename. The merge key logic in `_parseSubtaskLine` must extract it from the filename.

### 2. `src/services/TaskViewerProvider.ts` — `_parseSubtaskLine` (line 24273)

Update to extract the id from the markdown link's filename instead of a trailing `(id)` group. The new line format is: `- [ ] [title](provider_id_slug.md) — status`.

```typescript
private _parseSubtaskLine(line: string): { id: string; titleKey: string } {
    let rest = line.trim().replace(/^- \[[ xX]\]\s*/, '');
    const statusMatch = rest.match(/\s+—\s+[^—]*$/);
    if (statusMatch && statusMatch.index !== undefined) {
        rest = rest.slice(0, statusMatch.index).trimEnd();
    }
    // New format: [title](provider_id_slug.md) — extract id from filename.
    // Legacy format: title (id) — extract id from trailing parens.
    let id = '';
    const linkMatch = rest.match(/\]\((\w+)_(\w+?)_.+\.md\)$/);
    if (linkMatch && linkMatch[2]) {
        id = linkMatch[2];
        rest = rest.replace(/\]\(.+\.md\)$/, '').replace(/^\[/, '');
    } else {
        const idMatch = rest.match(/\(([^()]*)\)$/);
        if (idMatch && idMatch.index !== undefined) {
            id = idMatch[1].trim();
            rest = rest.slice(0, idMatch.index).trimEnd();
        }
    }
    return { id, titleKey: `__title:${rest.replace(/\s+/g, ' ').toLowerCase()}` };
}
```

### 3. `src/services/TaskViewerProvider.ts` — `_mergeSubtasksSection` (line 24334)

Add migration: when parsing existing entries, strip any legacy `  >` description blocks from the entry text. This converts old embedded-content entries to the new file-reference format on the next merge. The never-delete rule is preserved — entries the payload lacks are kept, just with their description blocks stripped.

```typescript
private _mergeSubtasksSection(
    provider: 'linear' | 'clickup',
    existingSection: string,
    subtasks: any[]
): string {
    const merged = this._parseSubtaskEntries(existingSection);
    // Migration: strip legacy description blocks (  > lines) from existing
    // entries. The new format uses file-reference links, not embedded content.
    for (const [key, text] of merged) {
        const lines = text.split('\n');
        const checklistLine = lines[0];
        const hasDescBlock = lines.length > 1 && lines.slice(1).some(l => /^[ \t]{2,}>/.test(l));
        if (hasDescBlock) {
            // Convert legacy line to file-reference format if it has an id,
            // otherwise just strip the description block.
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

### 4. `src/services/TaskViewerProvider.ts` — `importTaskAsDocument` (line 23174)

Add subtask file creation so the single-ticket import path also produces separate subtask files (not just embedded content in the parent). Write subtask files BEFORE the parent file so the file-reference links resolve.

After building `content` and before `fs.writeFileSync(filePath, content, 'utf8')` (line 23311), add:

```typescript
// Write subtask files BEFORE the parent so file-reference links resolve.
// Mirrors the bulk import path's subtask file creation (importAllTasks).
if (includeSubtasks && provider === 'linear' && node.subtasks) {
    for (const stNode of node.subtasks) {
        const stIssue = stNode.issue;
        if (!stIssue?.id) { continue; }
        const stContent = this._buildLinearImportPlanContent(
            { issue: stIssue, subtasks: [] }, undefined, new Date().toISOString()
        );
        const stSlug = this._slugify(stIssue.title || stIssue.id);
        const stFilename = `${provider}_${stIssue.id}_${stSlug}.md`;
        fs.writeFileSync(path.join(targetDir, stFilename), stContent, 'utf8');
    }
}
if (includeSubtasks && provider === 'clickup' && subtasks.length > 0) {
    for (const st of subtasks) {
        if (!st?.id) { continue; }
        const stContent = this._buildClickUpImportPlanContent(st, new Date().toISOString());
        const stSlug = this._slugify(st.name || st.id);
        const stFilename = `${provider}_${st.id}_${stSlug}.md`;
        fs.writeFileSync(path.join(targetDir, stFilename), stContent, 'utf8');
    }
}
```

Note: `_buildLinearImportPlanContent` and `_buildClickUpImportPlanContent` already write `parentId:` frontmatter when the task has a `parentId` field (lines 8342, 8616). The subtask objects from `linear.getSubtasks()` and `details.subtasks` carry `parentId`, so the frontmatter will be correct.

### 5. `src/services/ticketDisplayContent.ts` — `stripAppendedBlocksForPush` (line 61)

No change needed. The marker-first detection path (`<!-- generated by import -->`) is unchanged and covers all new writes. The legacy shape detector still handles old files with `  >` description blocks. New files without `  >` blocks but with the marker are caught by the marker path.

### 6. `src/test/tickets-subtask-embedding.test.js` — Update assertions

Update the following assertions to reflect the new file-reference format:

- **Assertion #11** (line 141): remove the heading-demotion check (`#{1,6}`) — no description is embedded.
- **Assertion #12** (line 155): remove the `markdownDescription` check — no description is read.
- **Assertion #13** (line 165): update `_parseSubtaskLine` test — the id is now extracted from the filename in the markdown link, not from trailing parens. The regex `\\\(\(\[\^\(\)\]\*\)\\\)\$` must be updated to match the new link format.
- **Add new assertion**: `_buildSubtaskEntry` must produce a markdown link to the subtask file, not an embedded description block. Verify the output contains `](` and `.md)` and does NOT contain `\n  >`.
- **Add new assertion**: `_mergeSubtasksSection` must strip legacy `  >` description blocks from existing entries during merge (migration test).

## Verification Plan

1. **Unit tests**: run `node src/test/tickets-subtask-embedding.test.js` — all assertions pass with the updated format.
2. **Bulk import test**: import a ClickUp list with subtasks → verify:
   - Each subtask has its own `.md` file with `parentId:` frontmatter.
   - The parent's `## Subtasks` section contains file-reference links (`- [ ] [title](filename.md) — status`), NOT embedded description blocks.
   - No `  >` lines in the `## Subtasks` section.
3. **Single-ticket import test**: import a single Linear issue with subtasks → verify:
   - Subtask files are created (previously they were not).
   - The parent's `## Subtasks` section contains file-reference links.
4. **Migration test**: take an existing parent file with embedded `  >` description blocks, run a bulk import → verify the `## Subtasks` section is migrated to file-reference links (description blocks stripped).
5. **Push test**: edit a parent ticket and push → verify the `## Subtasks` section is stripped by `stripAppendedBlocksForPush` and does not reach the remote.
6. **Display test**: open a parent ticket in the Tickets panel → verify the `## Subtasks` section is stripped by `stripImportedSubtasksBlock` and not shown in the detail pane.
7. **Cross-list subtask preservation**: import a ClickUp list where a subtask's home list is different → verify the subtask's file-reference link is preserved in the parent's `## Subtasks` section (never-delete merge rule).
8. **Legacy line compatibility**: take a parent file with legacy `- [ ] title` lines (no id, no link) → run an import → verify the legacy line is preserved (never-delete rule) and a matching payload subtask replaces it with a file-reference line.
