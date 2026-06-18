# Push Local Inline Images as Ticket Attachments

## Goal
When a ticket is pushed to ClickUp or Linear from the planning.html Tickets tab, any **local inline images** in the ticket markdown (e.g. `![alt](/Users/.../design.png)` or relative `![alt](./images/design.png)`) must be uploaded to the provider as attachments, and the markdown rewritten to the resulting hosted CDN URL — both in the pushed payload **and** in the local `.md` file. This makes locally-authored images render for everyone in ClickUp/Linear and in the webview's source/ClickUp/Linear tabs, instead of silently breaking.

### Core Problems
1. **Local images push verbatim and break for everyone**: `TaskViewerProvider.pushTicketEdits` ships the ticket description to the provider unchanged. A line like `![home card](/Users/patrickvuleta/.../parentcheckin1.png)` is sent as-is; the absolute path is meaningless on the provider's servers, so the image is broken in ClickUp/Linear and in the webview's remote tabs.
2. **Rendering symptom masks a push-side gap**: The webview cannot load `<img src="/Users/...">` (VS Code webview origin + CSP), so the bug first appears as "local images don't render." But the real defect is that the bytes were never uploaded anywhere reachable. Fixing only the webview render would still leave the remote ticket broken.
3. **Inconsistent with attachment-sourced images**: Images that were first attached in ClickUp arrive as `https://…clickup-attachments.com/…` URLs and work everywhere. Locally-authored images get no equivalent treatment.

### Background Context
- Push entrypoint: `switchboard.pushTicketEdits` command (`src/extension.ts:1463`) → `TaskViewerProvider.pushTicketEdits` (`src/services/TaskViewerProvider.ts:17674`). The bulk-push path (`PlanningPanelProvider.ts:3510`) loops over the same command, so fixing `pushTicketEdits` covers single and bulk push.
- `pushTicketEdits` reads the local `.md`, strips frontmatter, slices the description (everything before `## Subtasks`), and pushes:
  - ClickUp: `clickUp.updateTask(id, { markdown_content: description, name })`
  - Linear: `linear.updateIssueDescription(id, description, titleFromHeading)`
- Upload primitives already exist:
  - `ClickUpSyncService.attachFile(taskId, fileName, buffer, comment?)` → `{ url, fileName }` (`src/services/ClickUpSyncService.ts:1582`). `url` is the `clickup-attachments.com` CDN URL.
  - `LinearSyncService.uploadAttachment(issueId, buffer, fileName)` → `{ url }` (the `assetUrl`) (`src/services/LinearSyncService.ts:1070`).
- Rendering side (context only, not the fix here): `renderMarkdown` / `sanitizeUrl` in `src/webview/sharedUtils.js:8,90,215`. `sanitizeUrl` passes leading-`/` paths through verbatim, producing an `<img>` the webview can't load. Once the local file is rewritten to a CDN URL by this feature, the render bug disappears at the source.

## Metadata

**Tags:** api, bugfix, backend

**Complexity:** 6

> Complexity nudged 5 → 6 (Mixed). Majority routine (parse/upload/rewrite helper reuses existing primitives), but two moderate, well-scoped risks push it up: (a) in-place rewrite of user `.md` files is a data-consistency risk, and (b) the create-flow touches multiple call sites that must each route through the shared tail helper without duplicating logic.

## User Review Required
- **Create-flow call-site scope**: Confirm which create surfaces actually carry local-image markdown and therefore need hosting. Verified create surfaces are `TaskViewerProvider.handleClickupCreateTask` (`src/services/TaskViewerProvider.ts:4178`), two calls in `src/services/LocalApiServer.ts:227,243`, the public `ClickUpSyncService.createTask` (`src/services/ClickUpSyncService.ts:1276`), and Linear's `createIssue` (`src/services/LinearSyncService.ts:1647`) / `createIssueSimple` (`:1720`). The earlier `PlanningPanelProvider.ts:3746`/`:3510` references in this plan are NOT create paths and should be treated as unverified — re-confirm during implementation.
- **Markdown render field**: Confirm the create-flow follow-up update uses ClickUp's WRITE field `markdown_content` (not `markdown_description`, which is silently ignored on PUT — see push-path comment at `TaskViewerProvider.ts:17729`).
- **Regex limitations acceptable?**: Confirm it is acceptable to skip-and-warn (rather than fully support) two uncommon markdown forms: image paths containing literal `)` and the title syntax `![alt](url "title")`. See Edge Cases #11–12.

## Resolved Decisions (confirmed with user)
- **Write-back to local file: YES.** After a successful push, the local `.md` is rewritten in place so its image references become the hosted CDN URLs. Keeps local and remote identical and fixes local rendering.
- **Failure policy: SKIP AND WARN.** A missing/unreadable local image (or a failed individual upload) is skipped with a warning; the push still proceeds for the rest of the content. The push is never aborted because of an image problem.
- **Create-task flow: IN SCOPE.** Newly-created tickets must also upload their local inline images. Because the upload primitives require a task/issue ID, the create flow uploads + rewrites + writes back *after* the task is created (see the `createTask` section below). No two-step "create then push" requirement for the user.
- **De-duplication**: Same local path used multiple times in one ticket uploads once and reuses the URL. Cross-push dedup happens naturally via write-back (already-hosted URLs are skipped on the next push).
- **Relative path base**: Relative image paths resolve against the ticket `.md` file's directory, not the workspace root.

## Complexity Audit

### Routine
- Add a private helper `_uploadInlineImagesAndRewrite` to `TaskViewerProvider` that parses `![alt](src)`, filters to local paths, uploads each via a provider callback, and returns rewritten markdown + a list of replacements.
- Add a shared tail helper `_hostInlineImages(provider, id, description, sourceFilePath?)` used by both push and create flows (upload → rewrite → optional write-back).
- Wire the helper into both branches of `pushTicketEdits` before the `updateTask` / `updateIssueDescription` calls.
- Wire the create flow: after `createTask`/issue-create, run hosting against the new ID and issue a follow-up body update.
- Write the rewritten markdown back into the original `.md` file (replacing only the image references, preserving frontmatter, title, and `## Subtasks` tail).

### Complex / Risky
- The upload is an outbound network call per image and can be slow / fail independently. Must not leave the local file half-rewritten or the remote partially pushed in an inconsistent state.
- Write-back must surgically replace the original image reference substrings inside the **full file content** (frontmatter + title + description + subtasks), not just the sliced description, or the slicing offsets will corrupt the file.
- Path resolution and security: local image paths could be absolute anywhere on disk, relative to the ticket dir, `~`-prefixed, or `file://` URLs. Each needs normalizing; reads must be guarded.

## Edge-Case & Dependency Audit

### Race Conditions
- Two concurrent pushes of the same ticket (single + bulk) could both upload and both write-back. Mitigation: read file content once at handler entry; the existing per-ticket push is already user-initiated and serial in practice. No new locking added unless requested.
- Local file edited between read and write-back: write-back operates on the exact content read at entry; if the file changed underneath, the write-back overwrites with the rewritten version of the read snapshot. Acceptable — matches how `pushTicketEdits` already reads once and pushes.

### Security
- Resolved image paths must be read from disk regardless of location (designs commonly live outside the workspace, e.g. `/Users/patrickvuleta/Documents/GitHub/patrickwork/designs/...`). Therefore do **not** restrict reads to the workspace root — but do reject non-file schemes and surface read failures. Only the ticket `.md` write-back is constrained to the resolved ticket file path returned by `_findTicketDocument`.
- No tokens are exposed; uploads use the existing authenticated sync services.

### Side Effects
- Each push uploads any still-local images, creating attachments on the remote. After the first successful push the local file references CDN URLs, so subsequent pushes upload nothing new (natural dedup via write-back). This is the desired behavior.
- Write-back changes the local `.md` mtime; the existing post-push `registerImportedTicket` call already records sync time, so the ticket should still read "synced." Verify ordering: write-back must happen **before** the `registerImportedTicket` sync-time stamp so mtime ≤ sync time.

### Dependencies & Conflicts
- Closely related to `upload-plan-as-ticket-attachment.md` (same `attachFile` / `uploadAttachment` primitives) but distinct: that feature uploads the whole plan file as one attachment from the Project panel; this feature uploads individual inline images during ticket push from the Tickets tab. No code conflict — different call sites.

## Dependencies
- Existing `ClickUpSyncService.attachFile()` and `LinearSyncService.uploadAttachment()`.
- Existing `TaskViewerProvider._findTicketDocument`, `_stripFrontmatter`, `_getClickUpService`, `_getLinearService`, `_getCacheService`.

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) corrupting local `.md` files via the in-place image-ref rewrite, (2) the create-flow follow-up update silently no-op'ing if it uses ClickUp's read-only `markdown_description` instead of `markdown_content`, and (3) the image regex mis-parsing paths-with-parens and `title`-syntax images. Mitigations: substitute only within the strict `![..](src)` pattern against full file content; pin `markdown_content` on all ClickUp writes; skip-and-warn on unparseable/unreadable images so the push never aborts; write back only after a successful push.

**Detailed risk analysis:** (1) **File corruption on write-back** — the description is a *slice* of the file; naively writing the rewritten description back over the whole file would drop frontmatter/title/subtasks. Mitigation: perform replacements as targeted string substitutions of each original `![..](origSrc)` → `![..](newUrl)` against the **full original file content**, then write that. (2) **Partial upload failures** leaving some images uploaded and some not — acceptable as long as each successful upload's URL is written back (so retries only re-upload the failures) and failures are reported, not swallowed. (3) **Pushing the rewritten markdown but failing to write the file back** (or vice-versa) — order matters: upload → build rewritten content → push to remote → on push success, write file back → stamp sync time. If push fails, do **not** write back (local stays as authored so the user can retry). If write-back fails after a successful push, report it but treat the push as succeeded. (4) **Double-encoding / spaces in paths** — local paths and the resulting markdown must preserve exact original substring for replacement; use the captured raw `src` for matching, not a normalized form.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
**Context:** `pushTicketEdits` (line 17674) is the single push path; bulk push reuses it. It already computes `content` (full file), `description` (sliced body), `titleFromHeading`, and `filePath`.

**Logic:**

1. **Add a shared helper** (private method on `TaskViewerProvider`) that does parse → upload → rewrite:
   ```typescript
   /**
    * Finds local inline image references in `markdown`, uploads each via `upload`,
    * and returns the markdown with those references rewritten to the hosted URLs.
    * Remote (http/https) images are left untouched. Unreadable local files are
    * skipped and reported in `warnings`. De-dupes by raw src within one call.
    */
   private async _uploadInlineImagesAndRewrite(
       markdown: string,
       ticketFilePath: string,
       upload: (fileName: string, buffer: Buffer) => Promise<{ url: string }>
   ): Promise<{ rewritten: string; replacements: Array<{ from: string; to: string }>; warnings: string[] }> {
       const IMG_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
       const warnings: string[] = [];
       const replacements: Array<{ from: string; to: string }> = [];
       const uploadedByRaw = new Map<string, string>(); // raw src -> hosted url

       const matches = [...markdown.matchAll(IMG_RE)];
       for (const m of matches) {
           const rawSrc = m[1].trim();
           // Skip already-hosted images and non-file schemes.
           if (/^(https?:)?\/\//i.test(rawSrc) || /^data:/i.test(rawSrc)) { continue; }
           if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawSrc) && !/^file:/i.test(rawSrc)) { continue; }

           if (uploadedByRaw.has(rawSrc)) { continue; } // dedup; replacement applied below

           const localPath = this._resolveLocalImagePath(rawSrc, ticketFilePath);
           if (!localPath || !fs.existsSync(localPath)) {
               warnings.push(`Inline image not found, left as-is: ${rawSrc}`);
               continue;
           }
           try {
               const buffer = await fs.promises.readFile(localPath);
               const fileName = path.basename(localPath);
               const { url } = await upload(fileName, buffer);
               if (url) {
                   uploadedByRaw.set(rawSrc, url);
                   replacements.push({ from: rawSrc, to: url });
               } else {
                   warnings.push(`Upload returned no URL for: ${rawSrc}`);
               }
           } catch (err) {
               warnings.push(`Failed to upload ${rawSrc}: ${err instanceof Error ? err.message : String(err)}`);
           }
       }

       // Rewrite: replace each occurrence of the raw src inside its image reference.
       let rewritten = markdown;
       for (const [rawSrc, url] of uploadedByRaw) {
           rewritten = rewritten.replace(
               new RegExp(`(!\\[[^\\]]*\\]\\()${this._escapeRegExp(rawSrc)}(\\))`, 'g'),
               `$1${url}$2`
           );
       }
       return { rewritten, replacements, warnings };
   }

   private _resolveLocalImagePath(rawSrc: string, ticketFilePath: string): string | null {
       let p = rawSrc;
       if (/^file:/i.test(p)) {
           try { p = decodeURIComponent(new URL(p).pathname); } catch { return null; }
       }
       if (p.startsWith('~/')) { p = path.join(os.homedir(), p.slice(2)); }
       if (path.isAbsolute(p)) { return path.normalize(p); }
       // Relative paths resolve against the ticket .md file's directory.
       return path.normalize(path.join(path.dirname(ticketFilePath), p));
   }

   private _escapeRegExp(s: string): string {
       return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   }
   ```
   > Ensure `os` is imported at the top of the file (it likely already is; confirm during implementation).

2. **Wire into `pushTicketEdits`** — run the upload/rewrite on `description` before pushing, per provider, then write the rewritten references back into the **full file content** and push the rewritten description:
   ```typescript
   const warningsAll: string[] = [];
   let descriptionToPush = description;
   let replacements: Array<{ from: string; to: string }> = [];

   if (provider === 'linear') {
       const linear = this._getLinearService(resolvedRoot);
       const res = await this._uploadInlineImagesAndRewrite(
           description, filePath,
           (fileName, buffer) => linear.uploadAttachment(id, buffer, fileName)
       );
       descriptionToPush = res.rewritten;
       replacements = res.replacements;
       warningsAll.push(...res.warnings);
       await linear.updateIssueDescription(id, descriptionToPush, titleFromHeading);
   } else {
       const clickUp = this._getClickUpService(resolvedRoot);
       const res = await this._uploadInlineImagesAndRewrite(
           description, filePath,
           (fileName, buffer) => clickUp.attachFile(id, fileName, buffer)
       );
       descriptionToPush = res.rewritten;
       replacements = res.replacements;
       warningsAll.push(...res.warnings);
       const name = titleFromHeading;
       await clickUp.updateTask(id, {
           markdown_content: descriptionToPush,
           ...(name ? { name } : {})
       });
   }

   // Push succeeded — write the rewritten image refs back into the local file so
   // local and remote match and the images render locally too. Replace against the
   // FULL original file content (not the sliced description) to preserve frontmatter,
   // title, and the ## Subtasks tail.
   if (replacements.length > 0) {
       try {
           let updatedContent = content;
           for (const { from, to } of replacements) {
               updatedContent = updatedContent.replace(
                   new RegExp(`(!\\[[^\\]]*\\]\\()${this._escapeRegExp(from)}(\\))`, 'g'),
                   `$1${to}$2`
               );
           }
           if (updatedContent !== content) {
               fs.writeFileSync(filePath, updatedContent, 'utf8');
           }
       } catch (wbErr) {
           warningsAll.push(`Pushed, but failed to update local file with hosted image URLs: ${wbErr instanceof Error ? wbErr.message : String(wbErr)}`);
       }
   }
   ```

3. **Stamp sync time after write-back** (existing `registerImportedTicket` block stays, but must run *after* the file write-back so the recorded sync time is ≥ the new file mtime — otherwise the ticket would read "modified" immediately after push).

4. **Surface warnings** in the return message so skipped/failed images aren't silent:
   ```typescript
   const baseMsg = `Pushed edits to remote ticket ${id}.`;
   const message = warningsAll.length
       ? `${baseMsg} (${warningsAll.length} image issue(s): ${warningsAll.join('; ')})`
       : baseMsg;
   return { success: true, message };
   ```

**Edge Cases:**
- Description with no images → helper returns markdown unchanged, no uploads, no write-back. Zero behavior change for text-only tickets.
- Image already a `clickup-attachments.com` / Linear asset URL → skipped (already hosted).
- Same local path referenced N times → uploaded once, all N references rewritten.
- Relative path (`./designs/x.png`) → resolved against ticket dir.
- `~/` and `file://` paths → normalized before read.
- Missing local file → warning, left as-is, push still proceeds.
- Push fails → no write-back (local file untouched so user can fix and retry).

---

### Create-task path (new tickets) — IN SCOPE
**Context:** New tickets are created via `createTask`/`createIssue`. Verified create surfaces (Clarification — corrected from earlier stale refs):
- ClickUp: public `ClickUpSyncService.createTask` (`src/services/ClickUpSyncService.ts:1276`), reached from `TaskViewerProvider.handleClickupCreateTask` (`src/services/TaskViewerProvider.ts:4178`) and from `src/services/LocalApiServer.ts:227,243`. Note `createTask` sends the body via the plain `description` field (`ClickUpSyncService.ts:1304`), NOT `markdown_content` — so the post-create hosting update is also what converts the body to rendered markdown.
- Linear: `createIssue` (`src/services/LinearSyncService.ts:1647`) and `createIssueSimple` (`:1720`, returns `{ id, identifier }`).

The earlier `PlanningPanelProvider.ts:3746`/`:3510` references are unverified and are not the create path; re-confirm before relying on them. Inline images can only be uploaded **after** the task exists, since `attachFile` / `uploadAttachment` require a task/issue ID.

**Logic:**
1. Locate every create call site that accepts a `description`/`markdown_content` originating from local markdown (a `.md` ticket/plan or pasted body that may contain local image refs).
2. Create the task/issue first (as today) to obtain the new ID.
3. Run the same `_uploadInlineImagesAndRewrite` against the description using the new ID's provider upload callback.
4. If any images were rewritten, issue a follow-up `updateTask(newId, { markdown_content: rewritten })` (ClickUp) / `updateIssueDescription(newId, rewritten, title)` (Linear) so the created ticket's body points at hosted URLs. **Critical: ClickUp must use `markdown_content`, not `markdown_description`** — the latter is read-only on PUT and is silently ignored, which would leave the created ticket with broken local paths and no error. (Do NOT reuse `handleClickupUpdateTask` at `TaskViewerProvider.ts:4206`, which passes `markdown_description`.)
5. If the source was a local `.md` file, write the rewritten image refs back into that file (same full-content substitution as the push path).
6. Apply the same **skip-and-warn** policy; surface warnings to the caller/UX.

To avoid duplicating the upload→push→write-back sequence in two places, factor the shared tail into a small private method (e.g. `_hostInlineImages(provider, id, description, sourceFilePath?)` returning `{ rewritten, warnings }`) that both `pushTicketEdits` and the create flow call. The create flow passes the freshly-created ID; `pushTicketEdits` passes the existing ID.

**Edge Cases:**
- Create succeeds but the follow-up image-hosting update fails → ticket exists with original local refs; report a warning (skip-and-warn) rather than failing the create. The user can re-push to host them.
- Create itself fails before an ID exists → no upload attempted.
- Create from a non-file source (pasted body, no backing `.md`) → upload + body update still run; write-back is skipped (no file to update).
- Same helper reused → no duplicated parsing/upload logic across create and push.

---

### `src/webview/sharedUtils.js` — render side (optional hardening, not the core fix)
**Context:** `sanitizeUrl` (line 8) passes local absolute paths through, yielding an unloadable `<img>`.

**Logic (optional):**
- Once tickets are pushed with this feature, freshly authored-but-not-yet-pushed tickets still show broken local images in the webview. Optionally, render a clear placeholder/affordance for `<img>` srcs that are local filesystem paths (e.g. an italic "local image — push to ClickUp/Linear to upload" note) instead of a broken image icon.
- This is cosmetic and can be deferred; the write-back in `pushTicketEdits` resolves the rendering for pushed tickets.

**Edge Cases:**
- Do not break existing http/https/relative/data rendering.

## Edge Cases

1. **Text-only ticket**: No images → identical behavior to today.
2. **Mixed images**: Some hosted, some local → only locals uploaded; hosted untouched.
3. **Duplicate local path**: Upload once, rewrite all.
4. **Missing local file**: Skip + warn, push proceeds.
5. **Relative vs absolute vs `~` vs `file://`**: All normalized; relative resolves to ticket dir.
6. **Push failure**: No write-back; local file unchanged for retry.
7. **Write-back failure after successful push**: Push reported success; warning notes local file not updated.
8. **Large images**: Uploaded as raw buffers; provider API limits apply and surface as warnings.
9. **Bulk push**: Each ticket runs the helper independently (bulk path calls the same command).
10. **Sync-time ordering**: Write-back precedes `registerImportedTicket` so the ticket reads "synced." Verify the sync-vs-mtime comparison treats `mtime <= syncTime` (not strict `<`) as "synced", since write-back and the stamp happen within the same millisecond.
11. **Path contains literal `)`** (e.g. `![a](/Users/x/Screen Shot (2).png)`): the `\(([^)]+)\)` capture stops at the first `)`, so the resolved path is wrong → `existsSync` fails → skip-and-warn, ref left as-is. Known limitation; not handled.
12. **Title syntax `![alt](url "title")`**: the captured src includes ` "title"`, so resolution fails → skip-and-warn. Known limitation; not handled. (The webview render regex at `sharedUtils.js:215` has the same shape, so render and push agree on what counts as an image.)

## Risks

1. **File-corruption regression**: Incorrect substring replacement could damage `.md` files. Mitigation: replace within the strict `![..](src)` pattern against full content; add a unit test asserting frontmatter/title/subtasks are preserved.
2. **Partial uploads**: Some images upload, others fail. Mitigation: per-image try/catch; successful URLs written back so retry only re-uploads failures.
3. **Token scope**: Provider tokens must allow attachment upload; failures surface as warnings, not silent.
4. **Performance**: Sequential uploads add latency proportional to image count. Acceptable for typical tickets (a handful of images); could parallelize later if needed.
5. **Create-flow follow-up update failure**: Create succeeds but the post-create body update fails, leaving the new ticket with local refs. Mitigation: skip-and-warn; a re-push hosts them. No data loss.

## Verification Plan

### Automated Tests
- Per the Jest bulk-test workflow: add focused tests for `_uploadInlineImagesAndRewrite` and the write-back substitution.
  - Parses absolute, relative, `~`, and `file://` local paths; skips http/https/data.
  - De-dupes repeated paths (one upload, all refs rewritten).
  - Missing file → warning, ref left as-is.
  - Write-back preserves frontmatter, `# Title`, and `## Subtasks` while rewriting only image refs.
  - Mock `attachFile` / `uploadAttachment` to return a known URL.
  - Create flow: after a mocked create, the follow-up body update receives the rewritten (hosted-URL) description; a mocked follow-up failure still yields a successful create with a warning.
  - Skip-and-warn: a missing file and a single failed upload both produce warnings without aborting the overall push/create.
- Run with `--forceExit`; user runs Jest, fix only failures.

### Manual Verification
1. Open `clickup_86d3cz53f_epic-parent-check-in.md` (local-image ticket) in the Tickets tab. Push edits to ClickUp.
2. Verify the ClickUp task description now shows the images (hosted on `clickup-attachments.com`).
3. Re-open the local `.md`; verify the `![...](/Users/...)` paths were rewritten to `https://…clickup-attachments.com/…` URLs.
4. Re-render the ticket in the webview; verify images now display.
5. Push again; verify no new attachments are created (already hosted → skipped).
6. Repeat 1–5 for a Linear issue with a local image; verify Linear asset URLs.
7. Reference a non-existent local image; push; verify a warning is reported and the rest of the push succeeds.
8. Push a text-only ticket; verify unchanged behavior.
9. Bulk-push multiple tickets including local images; verify each ticket's images upload independently.
10. Confirm the ticket reads "synced" (not "modified") immediately after push despite the write-back.
11. **Create flow (ClickUp)**: Create a brand-new ticket from local markdown containing a local image. Verify the created ClickUp task shows the hosted image, and the source `.md` (if any) was rewritten — with no separate push required.
12. **Create flow (Linear)**: Same as 11 for a new Linear issue.
13. **Create flow, follow-up update failure**: Simulate the post-create body update failing; verify the ticket is still created and a warning is surfaced (skip-and-warn), and a subsequent push hosts the images.

## Recommendation
- **Send to Coder.**
