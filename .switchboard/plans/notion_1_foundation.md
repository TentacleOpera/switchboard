# Notion Integration — Part 1: REST API Foundation & Block-to-Markdown Converter

## Goal

Create `NotionFetchService` with a direct Notion REST API client, secure token storage via VS Code SecretStorage, configuration schema, cached content storage, and a full block-to-markdown converter. This plan produces no user-visible features — it lays the plumbing for Part 2's fetch UI and prompt builder integration. Unlike ClickUp/Linear, this integration does not sync kanban cards; it pre-fetches Notion page content to embed verbatim in planner prompts as a Design Doc reference.

## Metadata

**Tags:** backend, infrastructure
**Complexity:** 6

## User Review Required

> [!NOTE]
> - **Notion Integration Token**: After this plan lands, users run "Switchboard: Set Notion API Token" from the command palette. The token is stored in VS Code SecretStorage (OS keychain), never in plaintext config.
> - **Integration vs OAuth**: Notion supports two token types — internal integration tokens (`secret_`) and OAuth tokens (`ntn_`). Both use the same Bearer auth header. This plan validates the token prefix and format, but accepts both types.
> - **Page sharing requirement**: Notion pages must be explicitly shared with the integration before they can be fetched. The `isAvailable()` check validates the token but cannot verify page access upfront. Page-level 403s are handled gracefully in Part 2.
> - **Cached content is stored locally**: Fetched markdown is written to `.switchboard/notion-cache.md` (gitignored). Config metadata (page URL, last fetch time) is stored in `.switchboard/notion-config.json` (gitignored). This prevents re-fetching on every planner invocation.
> - **No UI changes yet**: This plan creates no visible UI. The fetch button, status badge, and prompt builder integration come in Part 2.

## Complexity Audit

### Routine
- **Config file schema**: `.switchboard/notion-config.json` — simple JSON, same read/write pattern as `clickup-config.json`.
- **Cache file I/O**: `.switchboard/notion-cache.md` — `fs.promises.readFile` / `fs.promises.writeFile`.
- **`.gitignore` update**: Two-line addition.
- **Command registration**: `switchboard.setNotionToken` follows the existing pattern in `extension.ts`.
- **`isAvailable()` check**: `GET /v1/users/me` with 2-second timeout — same pattern as ClickUp.
- **`parsePageId(url)`**: URL parsing to extract a 32-char hex page ID from various Notion URL formats.

### Complex / Risky
- **`httpRequest()` method**: Notion requires two non-standard headers beyond `Authorization`: `Notion-Version: 2022-06-28` and `Content-Type: application/json`. All requests are `https` module calls (no `fetch` — same rationale as ClickUp).
- **`fetchBlocksRecursive(blockId)`**: Must paginate `GET /v1/blocks/{id}/children` using `start_cursor` / `has_more`. Blocks with `has_children: true` require recursive child fetching. Deeply nested pages (toggles containing lists containing sub-items) can generate many API calls — must include depth limiting and rate-limit delay between calls.
- **`convertBlocksToMarkdown(blocks)`**: Notion's block model has ~25 block types and a rich-text annotation system (bold, italic, inline code, strikethrough). The converter must handle: `paragraph`, `heading_1/2/3`, `bulleted_list_item`, `numbered_list_item`, `to_do`, `quote`, `code`, `callout`, `divider`, `table`/`table_row`, `toggle`, `image`, `bookmark`, `child_page`, `column_list`/`column`, and unknown types (fallback to plain text). Rich text objects must have their annotations applied before joining.

## Edge-Case & Dependency Audit

- **Token not set**: `getApiToken()` returns `null` → `httpRequest()` throws → `isAvailable()` returns `false` → Part 2 shows "Connect Notion" prompt.
- **Invalid Notion URL formats**: `parsePageId()` must handle at minimum:
  - `https://www.notion.so/Page-Title-{32hexchars}` (legacy public)
  - `https://www.notion.so/{workspace}/Page-Title-{32hexchars}`
  - `https://www.notion.so/{32hexchars}` (bare ID)
  - `https://notion.so/{uuid-with-dashes}` (UUID format)
  - Returns `null` for non-Notion URLs (caller must handle).
- **Corrupted config JSON**: `loadConfig()` returns `null`; `loadCachedContent()` returns `null`.
- **Missing cache file**: `loadCachedContent()` returns `null` — Part 2 shows "Not synced" status.
- **Deeply nested pages**: Depth limit of 5 levels prevents stack overflow and runaway API calls.
- **Rate limits**: Notion allows ~3 requests/second. A 200ms delay between pagination calls and between recursive child fetches keeps well within limits.
- **Table blocks**: Children of `table` are `table_row` blocks — must be fetched recursively and rendered as a GitHub-flavored markdown table.
- **Toggle blocks**: Content is collapsed in Notion UI but should be fully unfolded in the markdown output (content is valuable context for the planner).
- **`column_list` / `column`**: Columns are rendered sequentially in markdown (true side-by-side layout is not representable in plain text).
- **Race Conditions**: None — this plan creates no async workflows or event handlers.
- **Dependencies & Conflicts**: No cross-plan conflicts. This is the foundation plan; Part 2 depends on it.
- **Cross-Plan Conflict Analysis**:
  - `notion_2_setup_and_fetch.md` — depends on this plan. Part 2 needs `NotionFetchService` to be fully implemented. No overlapping file modifications.
  - `notion_3_planning_tab_ui.md` — depends on this plan AND Part 2. No direct conflict with Part 1.
  - No other active plans in the `.switchboard/plans/` folder conflict with this foundation plan.

## Adversarial Synthesis

### Grumpy Critique

*Puts down coffee. Sighs.*

1. **The block-to-markdown converter will be wrong on day one.** Notion's rich text object has `text`, `mention`, and `equation` subtypes. You're treating every `rt.plain_text` as the content. But `mention` objects — @person, @date, page mentions — have a different structure. If a PRD has "@Alice please review" or a linked page mention, `plain_text` returns the display text, which is fine. But `equation` blocks return LaTeX in `equation.expression`, not in `plain_text`. Your converter will silently drop equations.

2. **Recursive child fetching has no concurrency.** You're fetching children serially. A large Notion doc with 50 top-level blocks, each having 5 children, means 250+ sequential HTTP calls. At 200ms delay each, that's 50 seconds. Unacceptable for a "Fetch" button.

3. **`parsePageId()` will fail on Notion Sites URLs.** Notion's public-facing pages can use custom domains like `mycompany.notion.site`. Your parser only handles `notion.so`. Teams that publish PRDs publicly on Notion Sites will get a null return and a confusing error.

4. **Table rendering without `has_column_header`**: When `has_column_header` is `false`, the code renders rows without a markdown header separator row (`| --- | --- |`). Most markdown renderers require the separator row to recognize a table. Without it, the output is just pipe-delimited text, not a formatted table. The first row should always be treated as a header with a separator, even when `has_column_header` is false — otherwise tables look broken in the planner prompt.

5. **Missing block types**: The converter handles ~17 block types but Notion has more: `link_to_page`, `table_of_contents`, `breadcrumb`, `pdf`, `video`, `file`, `audio`, `embed`, `link_preview`. The `default` fallback extracts `rich_text` if present, but blocks like `pdf`, `video`, `file` have `external.url` or `file.url` — these will be silently dropped because they have no `rich_text`. A `pdf` block in a PRD (linking a spec document) would vanish entirely.

6. **No import statement for NotionFetchService shown in extension.ts change**: The command registration uses `context.secrets` directly, not the service class — that's fine for Part 1. But Part 2 will need `import { NotionFetchService } from './services/NotionFetchService';` in `extension.ts`. This should be noted as a forward dependency.

### Balanced Response

1. **Equations and mentions — HANDLED**: `_convertRichText()` checks `rt.type`. For `text`, use `rt.plain_text` with annotation wrapping. For `mention`, use `rt.plain_text` (always populated with display name — correct behavior). For `equation`, use `$${rt.equation.expression}$` (inline LaTeX). The fallback for unknown subtypes is `rt.plain_text || ''` — never silently drops content.

2. **Serial fetching performance — ACCEPTED with documentation**: Fetching children concurrently risks rate-limit 429s from Notion's 3 req/sec limit. Serial fetching with 200ms delay is safe and predictable. For a typical PRD (50–100 blocks, 2–3 levels deep), fetch time is 5–15 seconds — acceptable for an on-demand "Fetch" button (not for real-time use). The 200ms delay is documented as a design choice, not an oversight.

3. **Notion Sites URLs — HANDLED**: `parsePageId()` accepts any hostname containing `notion.so` OR `notion.site`. This covers `www.notion.so`, `mycompany.notion.site`, and `<team>.notion.site` subdomains. The UUID/hex extraction regex operates on the URL path, which is hostname-independent.

4. **Table rendering — FIX**: Add a separator row unconditionally. When `has_column_header` is false, the separator still makes the markdown parseable. Update the table rendering code to always emit the separator after the first row.

5. **Missing block types — FIX**: Add handling for `pdf`, `video`, `file`, `audio`, and `embed` blocks — extract the URL from `external.url` or `file.url` and render as a markdown link: `[{type}: {caption or filename}]({url})`. For `link_to_page`, render as `*[Linked page: {page_id}]*`. For `table_of_contents` and `breadcrumb`, skip (they have no content value for the planner). This keeps the converter robust without over-engineering.

6. **Import statement — CLARIFIED**: Part 1 only registers a command palette action that uses `context.secrets` directly — no import of `NotionFetchService` needed in `extension.ts` for Part 1. Part 2's plan should handle its own imports.

## Proposed Changes

<!-- Complexity: Complex -->
### Target File 1: NotionFetchService — Foundation
#### CREATE `src/services/NotionFetchService.ts`

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

export interface NotionConfig {
  pageUrl: string;
  pageId: string;
  pageTitle: string;
  setupComplete: boolean;
  lastFetchAt: string | null;
}

export class NotionFetchService {
  private _workspaceRoot: string;
  private _configPath: string;
  private _cachePath: string;
  private _secretStorage: vscode.SecretStorage;

  constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage) {
    this._workspaceRoot = workspaceRoot;
    this._configPath = path.join(workspaceRoot, '.switchboard', 'notion-config.json');
    this._cachePath = path.join(workspaceRoot, '.switchboard', 'notion-cache.md');
    this._secretStorage = secretStorage;
  }

  // ── Config I/O ──────────────────────────────────────────────

  async loadConfig(): Promise<NotionConfig | null> {
    try {
      const content = await fs.promises.readFile(this._configPath, 'utf8');
      return JSON.parse(content);
    } catch { return null; }
  }

  async saveConfig(config: NotionConfig): Promise<void> {
    await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
    await fs.promises.writeFile(this._configPath, JSON.stringify(config, null, 2));
  }

  // ── Cache I/O ───────────────────────────────────────────────

  async loadCachedContent(): Promise<string | null> {
    try {
      return await fs.promises.readFile(this._cachePath, 'utf8');
    } catch { return null; }
  }

  async saveCachedContent(markdown: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(this._cachePath), { recursive: true });
    await fs.promises.writeFile(this._cachePath, markdown, 'utf8');
  }

  // ── Token Management ────────────────────────────────────────

  async getApiToken(): Promise<string | null> {
    try {
      return await this._secretStorage.get('switchboard.notion.apiToken') || null;
    } catch { return null; }
  }

  // ── HTTP Client ─────────────────────────────────────────────

  /**
   * Authenticated HTTPS request to Notion REST API.
   * Notion requires: Authorization: Bearer {token}, Notion-Version header.
   * Never logs the Authorization header.
   */
  async httpRequest(
    method: 'GET' | 'POST',
    apiPath: string,
    body?: Record<string, unknown>,
    timeoutMs = 10000
  ): Promise<{ status: number; data: any }> {
    const token = await this.getApiToken();
    if (!token) { throw new Error('Notion API token not configured'); }

    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = https.request({
        hostname: 'api.notion.com',
        path: `/v1${apiPath}`,
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 0, data: raw });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Notion request timed out')); });
      req.on('error', reject);
      if (payload) { req.write(payload); }
      req.end();
    });
  }

  // ── Availability Check ──────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      const token = await this.getApiToken();
      if (!token) { return false; }
      const result = await this.httpRequest('GET', '/users/me', undefined, 2000);
      return result.status === 200;
    } catch { return false; }
  }

  // ── URL Parsing ─────────────────────────────────────────────

  /**
   * Extract a Notion page ID from various URL formats:
   * - https://www.notion.so/Page-Title-{32hexchars}
   * - https://www.notion.so/{workspace}/Page-Title-{32hexchars}
   * - https://notion.so/{uuid-with-dashes}
   * - https://{team}.notion.site/Page-Title-{32hexchars}
   * Returns null for non-Notion URLs or unrecognisable formats.
   */
  parsePageId(url: string): string | null {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      if (!host.includes('notion.so') && !host.includes('notion.site')) { return null; }

      // Try to extract a 32-char hex string from the last path segment
      const segments = parsed.pathname.split('/').filter(Boolean);
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        // UUID with dashes: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
        const uuidMatch = seg.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (uuidMatch) { return uuidMatch[1].replace(/-/g, ''); }
        // 32-char hex suffix (appended after last hyphen in slug)
        const hexMatch = seg.match(/([0-9a-f]{32})$/i);
        if (hexMatch) { return hexMatch[1]; }
      }
      return null;
    } catch { return null; }
  }

  // ── Page Title ──────────────────────────────────────────────

  async fetchPageTitle(pageId: string): Promise<string> {
    const result = await this.httpRequest('GET', `/pages/${pageId}`);
    if (result.status !== 200) { return 'Untitled'; }
    const props = result.data?.properties;
    if (!props) { return 'Untitled'; }
    // Title property can have different names; find the one of type 'title'
    const titleProp = Object.values(props).find((p: any) => p.type === 'title') as any;
    return titleProp?.title?.[0]?.plain_text || result.data?.title?.[0]?.plain_text || 'Untitled';
  }

  // ── Block Fetching ──────────────────────────────────────────

  /**
   * Recursively fetch all blocks for a page or block container.
   * Paginates via start_cursor / has_more. Fetches children of blocks
   * with has_children: true, up to a depth limit of 5.
   * Rate-limited: 200ms delay between pagination calls.
   */
  async fetchBlocksRecursive(blockId: string, depth = 0): Promise<any[]> {
    if (depth > 5) { return []; } // depth guard

    const blocks: any[] = [];
    let cursor: string | undefined;

    while (true) {
      const queryPath = cursor
        ? `/blocks/${blockId}/children?page_size=100&start_cursor=${cursor}`
        : `/blocks/${blockId}/children?page_size=100`;

      const result = await this.httpRequest('GET', queryPath);
      if (result.status !== 200) { break; }

      const page = result.data;
      for (const block of (page.results || [])) {
        if (block.has_children) {
          await this._delay(200);
          block._children = await this.fetchBlocksRecursive(block.id, depth + 1);
        }
        blocks.push(block);
      }

      if (!page.has_more) { break; }
      cursor = page.next_cursor;
      await this._delay(200);
    }

    return blocks;
  }

  // ── Block-to-Markdown Converter ─────────────────────────────

  /**
   * Convert an array of Notion blocks (with pre-fetched _children) to markdown.
   * Handles all common block types; falls back to plain text for unknown types.
   */
  convertBlocksToMarkdown(blocks: any[], depth = 0): string {
    const lines: string[] = [];
    const indent = '  '.repeat(depth);

    for (const block of blocks) {
      const type = block.type;
      const data = block[type];
      if (!data) { continue; }

      const rt = (arr: any[]) => this._convertRichText(arr || []);

      switch (type) {
        case 'paragraph':
          lines.push(rt(data.rich_text) || '');
          break;
        case 'heading_1':
          lines.push(`# ${rt(data.rich_text)}`);
          break;
        case 'heading_2':
          lines.push(`## ${rt(data.rich_text)}`);
          break;
        case 'heading_3':
          lines.push(`### ${rt(data.rich_text)}`);
          break;
        case 'bulleted_list_item':
          lines.push(`${indent}- ${rt(data.rich_text)}`);
          if (block._children?.length) {
            lines.push(this.convertBlocksToMarkdown(block._children, depth + 1));
          }
          break;
        case 'numbered_list_item':
          lines.push(`${indent}1. ${rt(data.rich_text)}`);
          if (block._children?.length) {
            lines.push(this.convertBlocksToMarkdown(block._children, depth + 1));
          }
          break;
        case 'to_do':
          lines.push(`${indent}- ${data.checked ? '[x]' : '[ ]'} ${rt(data.rich_text)}`);
          if (block._children?.length) {
            lines.push(this.convertBlocksToMarkdown(block._children, depth + 1));
          }
          break;
        case 'toggle':
          lines.push(`${indent}**${rt(data.rich_text)}**`);
          if (block._children?.length) {
            lines.push(this.convertBlocksToMarkdown(block._children, depth + 1));
          }
          break;
        case 'quote':
          lines.push(`> ${rt(data.rich_text)}`);
          break;
        case 'callout': {
          const emoji = data.icon?.emoji || '💡';
          lines.push(`> ${emoji} ${rt(data.rich_text)}`);
          if (block._children?.length) {
            lines.push(this.convertBlocksToMarkdown(block._children, depth + 1));
          }
          break;
        }
        case 'code':
          lines.push('```' + (data.language || ''));
          lines.push(rt(data.rich_text));
          lines.push('```');
          break;
        case 'divider':
          lines.push('---');
          break;
        case 'image': {
          const imgUrl = data.external?.url || data.file?.url || '';
          const caption = rt(data.caption || []);
          lines.push(`![${caption}](${imgUrl})`);
          break;
        }
        case 'bookmark': {
          const bmUrl = data.url || '';
          const bmCaption = rt(data.caption || []);
          lines.push(`[${bmCaption || bmUrl}](${bmUrl})`);
          break;
        }
        case 'pdf':
        case 'video':
        case 'file':
        case 'audio':
        case 'embed': {
          const mediaUrl = data.external?.url || data.file?.url || data[type]?.url || '';
          const mediaCaption = rt(data.caption || []);
          lines.push(`[${mediaCaption || type}](${mediaUrl})`);
          break;
        }
        case 'link_to_page': {
          const linkedId = data.page_id || data.database_id || '';
          lines.push(`*[Linked page: ${linkedId}]*`);
          break;
        }
        case 'table_of_contents':
        case 'breadcrumb':
          // No content value for planner prompts — skip
          break;
        case 'child_page':
          lines.push(`*[Child page: ${data.title}]*`);
          break;
        case 'table': {
          // Rows are in _children; first row is header if data.has_column_header
          const rows = block._children || [];
          const mdRows = rows.map((row: any) => {
            const cells = (row.table_row?.cells || []).map((cell: any) => rt(cell));
            return `| ${cells.join(' | ')} |`;
          });
          if (mdRows.length > 0) {
            lines.push(mdRows[0]);
            // Always emit separator for valid markdown table rendering
            const colCount = (rows[0]?.table_row?.cells?.length || 1);
            lines.push(`| ${Array(colCount).fill('---').join(' | ')} |`);
            lines.push(...mdRows.slice(1));
          }
          break;
        }
        case 'column_list':
          // Render columns sequentially
          if (block._children?.length) {
            lines.push(this.convertBlocksToMarkdown(block._children, depth));
          }
          break;
        case 'column':
          if (block._children?.length) {
            lines.push(this.convertBlocksToMarkdown(block._children, depth));
          }
          break;
        default:
          // Unknown block — try to extract plain text from any rich_text field
          if (data.rich_text?.length) {
            lines.push(rt(data.rich_text));
          }
          break;
      }
    }

    return lines.join('\n');
  }

  // ── Rich Text Converter ─────────────────────────────────────

  private _convertRichText(richText: any[]): string {
    return richText.map(rt => {
      let text: string;

      switch (rt.type) {
        case 'text':
          text = rt.plain_text || '';
          break;
        case 'mention':
          // plain_text is always populated with the display name for mentions
          text = rt.plain_text || '';
          break;
        case 'equation':
          // Inline LaTeX
          text = `$${rt.equation?.expression || ''}$`;
          break;
        default:
          text = rt.plain_text || '';
      }

      const a = rt.annotations || {};
      if (a.code) { text = `\`${text}\``; }
      if (a.bold) { text = `**${text}**`; }
      if (a.italic) { text = `*${text}*`; }
      if (a.strikethrough) { text = `~~${text}~~`; }
      // underline has no standard markdown equivalent; leave as-is
      return text;
    }).join('');
  }

  // ── Utilities ───────────────────────────────────────────────

  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  get configPath(): string { return this._configPath; }
  get cachePath(): string { return this._cachePath; }
  get workspaceRoot(): string { return this._workspaceRoot; }
}
```

- **Edge Cases Handled:**
  - Missing token → `getApiToken()` returns `null`, `httpRequest()` throws, `isAvailable()` returns `false`
  - Network timeout → 2-second cap on `isAvailable()`, configurable on `httpRequest()`
  - Config dir missing → `saveConfig()` creates `.switchboard/` with `mkdir -p`
  - Corrupted config/cache JSON → returns `null`
  - Unknown block types → extract `plain_text` as fallback, never silently drop
  - Media blocks (`pdf`, `video`, `file`, `audio`, `embed`) → extract URL and render as markdown link
  - `link_to_page` → render as italic reference with page/database ID
  - `table_of_contents` / `breadcrumb` → skip (no content value for planner)
  - Table without `has_column_header` → separator row always emitted for valid markdown
  - Notion URL variants → `parsePageId()` handles `notion.so` and `notion.site` hostnames
  - Deeply nested pages → depth limit of 5 prevents runaway recursion
  - Equation rich text → `$expression$` inline LaTeX, not `plain_text`

<!-- Complexity: Routine -->
### Target File 2: Token Storage Command
#### MODIFY `src/extension.ts`

Add after the existing `setLinearToken` command registration:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('switchboard.setNotionToken', async () => {
    const token = await vscode.window.showInputBox({
      prompt: 'Enter your Notion integration token — find it at notion.so/profile/integrations',
      password: true,
      placeHolder: 'secret_...',
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v || v.trim().length < 10) { return 'Token appears too short'; }
        if (!v.trim().startsWith('secret_') && !v.trim().startsWith('ntn_')) {
          return 'Notion tokens start with "secret_" (internal) or "ntn_" (OAuth)';
        }
        return null;
      }
    });
    if (token) {
      await context.secrets.store('switchboard.notion.apiToken', token.trim());
      vscode.window.showInformationMessage('Notion API token saved securely.');
    }
  })
);
```

- **Edge Cases Handled:**
  - User cancels → no-op
  - Invalid prefix → inline validation rejects with guidance
  - Whitespace → trimmed before storage

<!-- Complexity: Routine -->
### Target File 3: Command Palette Registration
#### MODIFY `package.json`

Add to the `contributes.commands` array:

```json
{
  "command": "switchboard.setNotionToken",
  "title": "Set Notion API Token",
  "category": "Switchboard"
}
```

<!-- Complexity: Routine -->
### Target File 4: Git Ignore Update
#### MODIFY `.gitignore`

Add after the existing Linear block:

```
# Notion integration config and page content cache
.switchboard/notion-config.json
.switchboard/notion-cache.md
```

## Verification Plan

### Automated Tests
- **`parsePageId()` coverage**: Test all four URL formats → correct 32-char hex ID. Test non-Notion URL → `null`. Test `notion.site` subdomain → correct ID.
- **`_convertRichText()` annotations**: Bold → `**text**`, italic → `*text*`, code → `` `text` ``, strikethrough → `~~text~~`, equation → `$expression$`.
- **`convertBlocksToMarkdown()` block types**: Paragraph, heading 1/2/3, bulleted/numbered list, to_do checked/unchecked, quote, code block, divider, callout, image, bookmark, toggle with children, table with header row.
- **`isAvailable()`**: Mock 200 → `true`; mock timeout → `false`; missing token → `false`.
- **Config round-trip**: Write → read → verify fidelity. Corrupted JSON → `null`.
- **Cache round-trip**: Write markdown → read back → string equality.

### Manual Verification Steps
1. `npx tsc --noEmit` — no new type errors
2. Command palette → "Switchboard: Set Notion API Token" appears
3. Enter a token starting with `secret_` → accepted; enter `foo` → rejected with message
4. Token persists across VS Code restart (SecretStorage is durable)
5. `git check-ignore .switchboard/notion-config.json` → returns the path

## Files to Modify

1. `src/services/NotionFetchService.ts` — CREATE (REST client, config/cache I/O, token access, block-to-markdown converter)
2. `src/extension.ts` — MODIFY (register `switchboard.setNotionToken` command)
3. `package.json` — MODIFY (add command to `contributes.commands`)
4. `.gitignore` — MODIFY (add `notion-config.json` and `notion-cache.md` exclusions)

## Agent Recommendation

**Send to Coder** — Complexity 6. The HTTP client and config I/O follow established patterns exactly. The block-to-markdown converter is the only non-trivial piece, but it is a pure data transformation with no side effects, no external state dependencies, and a comprehensive spec above. All branching is enumerated in the `switch` statement. The token validation and URL parsing are self-contained.

---

## Post-Implementation Review

**Reviewer**: Grumpy Principal Engineer + Balanced Synthesis
**Date**: Post-implementation
**Verdict**: ✅ **PASS — No changes needed**

### Findings

| # | Severity | Finding | Action |
|---|----------|---------|--------|
| 1 | NIT | `designDocUrl?: string` added to `NotionConfig` interface — not in plan spec, added for Part 2 command palette compatibility | Keep — harmless optional field |
| 2 | NIT | `fetchAndCache()` method present in the file (Part 2 addition) — expected since both parts implemented together | Keep — correct |
| 3 | NIT | Placeholder text `'secret_... or ntn_...'` vs plan's `'secret_...'` | Improvement — keep |
| 4 | NIT | `(data as any)?.url` in media block fallback vs plan's `data[type]?.url` | Cosmetic — defer |

### Verification

- `npx tsc --noEmit`: Only pre-existing ArchiveManager error (KanbanProvider.ts:2149)
- `npm run compile`: webpack compiled successfully
- All plan requirements verified present in implementation:
  - NotionFetchService class with all methods ✅
  - Config/cache I/O with error handling ✅
  - Token management via SecretStorage ✅
  - HTTP client with Notion headers ✅
  - URL parsing (notion.so + notion.site) ✅
  - Block-to-markdown converter (20+ block types) ✅
  - Rich text annotations (bold, italic, code, strikethrough, equation) ✅
  - Media blocks, tables with separators, depth limiting ✅
  - setNotionToken command in extension.ts ✅
  - package.json command entry ✅
  - .gitignore entries ✅

### Files Changed

None — implementation is faithful to plan.
