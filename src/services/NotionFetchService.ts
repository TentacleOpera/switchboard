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
  /** Alias for pageUrl — used by extension.ts command handler. */
  designDocUrl?: string;
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
   *
   * 429 handling:
   *   - Max 3 attempts total (2 retries). Worst-case without server guidance: ~1.5s.
   *   - Honours the `Retry-After` response header (seconds) when present, capped at 5s
   *     per retry to avoid UI stalls. Falls back to exponential backoff otherwise.
   */
  async httpRequest(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    apiPath: string,
    body?: Record<string, unknown>,
    timeoutMs = 10000,
    signal?: AbortSignal
  ): Promise<{ status: number; data: any }> {
    const token = await this.getApiToken();
    if (!token) { throw new Error('Notion API token not configured'); }

    const maxAttempts = 3;
    const baseDelayMs = 500;
    const retryAfterCapMs = 5000;
    let attempt = 0;

    while (attempt < maxAttempts) {
      const result = await this._makeRequest(method, apiPath, body, timeoutMs, signal, token);

      // If not a 429 error, return immediately
      if (result.status !== 429) {
        return { status: result.status, data: result.data };
      }

      attempt++;
      if (attempt >= maxAttempts) {
        return { status: result.status, data: result.data }; // Give up after max attempts
      }

      // Prefer server-suggested delay when present & parseable as seconds, else exponential backoff.
      let delayMs: number;
      const serverHintSec = result.retryAfterSec;
      if (typeof serverHintSec === 'number' && isFinite(serverHintSec) && serverHintSec > 0) {
        delayMs = Math.min(serverHintSec * 1000, retryAfterCapMs);
      } else {
        delayMs = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 250;
      }
      await this._delay(delayMs);
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('Max retry attempts exceeded');
  }

  private async _makeRequest(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    apiPath: string,
    body: Record<string, unknown> | undefined,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    token: string
  ): Promise<{ status: number; data: any; retryAfterSec?: number }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = (value: { status: number; data: any; retryAfterSec?: number }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const safeReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

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
        // Notion returns Retry-After as delta-seconds on 429 responses. Parse once per response.
        const retryHeader = res.headers?.['retry-after'];
        const retryHeaderStr = Array.isArray(retryHeader) ? retryHeader[0] : retryHeader;
        const retryAfterSec = typeof retryHeaderStr === 'string' ? Number(retryHeaderStr) : undefined;
        const retryAfter = typeof retryAfterSec === 'number' && isFinite(retryAfterSec) && retryAfterSec >= 0
          ? retryAfterSec
          : undefined;

        res.on('error', (err) => safeReject(new Error(`Notion response stream error: ${err.message}`)));
        res.on('aborted', () => safeReject(new Error('Notion response aborted by server')));
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            safeResolve({ status: res.statusCode || 0, data: JSON.parse(raw), retryAfterSec: retryAfter });
          } catch {
            safeResolve({ status: res.statusCode || 0, data: raw, retryAfterSec: retryAfter });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); safeReject(new Error('Notion request timed out')); });
      req.on('error', (err) => safeReject(err));

      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('AbortError'));
          return safeReject(new Error('AbortError'));
        }
        const abortHandler = () => {
          req.destroy(new Error('AbortError'));
          safeReject(new Error('AbortError'));
        };
        signal.addEventListener('abort', abortHandler);
        req.on('close', () => signal.removeEventListener('abort', abortHandler));
      }

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
   * Extract a Notion page ID from various URL formats.
   * Accepts notion.so and notion.site hostnames.
   * Returns null for non-Notion URLs or unrecognisable formats.
   */
  parsePageId(url: string): string | null {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      if (!host.includes('notion.so') && !host.includes('notion.site')) { return null; }

      const segments = parsed.pathname.split('/').filter(Boolean);
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        const uuidMatch = seg.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (uuidMatch) { return uuidMatch[1].replace(/-/g, ''); }
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
    const titleProp = Object.values(props).find((p: any) => p.type === 'title') as any;
    return titleProp?.title?.[0]?.plain_text || result.data?.title?.[0]?.plain_text || 'Untitled';
  }

  // ── Block Fetching ──────────────────────────────────────────

  /**
   * Recursively fetch all blocks for a page or block container.
   * Paginates via start_cursor / has_more. Depth limit of 5 prevents runaway recursion.
   * Rate-limited: 200ms delay between calls.
   */
  async fetchBlocksRecursive(blockId: string, depth = 0): Promise<any[]> {
    if (depth > 5) { return []; }

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
          const mediaUrl = data.external?.url || data.file?.url || (data as any)?.url || '';
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
          break;
        case 'child_page':
          lines.push(`*[Child page: ${data.title}]*`);
          break;
        case 'table': {
          const rows = block._children || [];
          const mdRows = rows.map((row: any) => {
            const cells = (row.table_row?.cells || []).map((cell: any) => rt(cell));
            return `| ${cells.join(' | ')} |`;
          });
          if (mdRows.length > 0) {
            lines.push(mdRows[0]);
            const colCount = (rows[0]?.table_row?.cells?.length || 1);
            lines.push(`| ${Array(colCount).fill('---').join(' | ')} |`);
            lines.push(...mdRows.slice(1));
          }
          break;
        }
        case 'column_list':
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
          text = rt.plain_text || '';
          break;
        case 'equation':
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
      return text;
    }).join('');
  }

  // ── Fetch and Cache (Part 2) ─────────────────────────────────

  /**
   * Full fetch flow: validate token, parse URL, fetch page content,
   * convert to markdown, save config and cache.
   */
  async fetchAndCache(url: string): Promise<{ success: boolean; pageTitle?: string; charCount?: number; error?: string }> {
    // 0. Ensure token
    let token = await this.getApiToken();
    if (!token) {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter your Notion integration token — find it at notion.so/profile/integrations',
        password: true,
        placeHolder: 'secret_...',
        ignoreFocusOut: true,
        validateInput: (v) => {
          if (!v || v.trim().length < 10) { return 'Token too short'; }
          if (!v.trim().startsWith('secret_') && !v.trim().startsWith('ntn_')) {
            return 'Notion tokens start with "secret_" or "ntn_"';
          }
          return null;
        }
      });
      if (!input) { return { success: false, error: 'No token provided' }; }
      await this._secretStorage.store('switchboard.notion.apiToken', input.trim());
      token = input.trim();
    }

    // 1. Validate token
    if (!(await this.isAvailable())) {
      vscode.window.showErrorMessage(
        'Notion token is invalid or expired.',
        'Open notion.so/profile/integrations'
      ).then(choice => {
        if (choice) { vscode.env.openExternal(vscode.Uri.parse('https://notion.so/profile/integrations')); }
      });
      return { success: false, error: 'Token validation failed' };
    }

    // 2. Parse page ID
    const pageId = this.parsePageId(url);
    if (!pageId) {
      return { success: false, error: 'Could not parse a Notion page ID from the provided URL' };
    }

    // 3. Fetch page title
    let pageTitle = 'Untitled';
    try {
      pageTitle = await this.fetchPageTitle(pageId);
    } catch { /* non-fatal */ }

    // 4. Fetch all blocks recursively
    let blocks: any[];
    try {
      blocks = await this.fetchBlocksRecursive(pageId);
    } catch (err: any) {
      const msg = String(err);
      if (msg.includes('403') || msg.includes('Forbidden')) {
        return {
          success: false,
          error: 'Page not accessible. Share this page with your Notion integration at notion.so/profile/integrations.'
        };
      }
      return { success: false, error: `Fetch failed: ${msg}` };
    }

    // 5. Convert to markdown
    let markdown = this.convertBlocksToMarkdown(blocks);

    // 6. Truncate at heading boundary if over 50,000 chars
    const CHAR_LIMIT = 50000;
    let truncated = false;
    if (markdown.length > CHAR_LIMIT) {
      const cutRegion = markdown.substring(0, CHAR_LIMIT);
      const lastHeading = cutRegion.lastIndexOf('\n#');
      const cutPoint = lastHeading > 0 ? lastHeading : CHAR_LIMIT;
      markdown = markdown.substring(0, cutPoint) + `\n\n*[Content truncated at ${cutPoint.toLocaleString()} chars. View full page: ${url}]*`;
      truncated = true;
    }

    const header = `# ${pageTitle}\n\n> Fetched from Notion: ${url}\n\n`;
    const fullContent = header + markdown;

    // 7. Save config and cache
    await this.saveConfig({
      pageUrl: url,
      pageId,
      pageTitle,
      setupComplete: true,
      lastFetchAt: new Date().toISOString(),
      designDocUrl: url
    });
    await this.saveCachedContent(fullContent);

    if (truncated) {
      vscode.window.showWarningMessage(`Notion content truncated — page was too large. Planner will use the first portion.`);
    }

    return { success: true, pageTitle, charCount: fullContent.length };
  }

  // ── Utilities ───────────────────────────────────────────────

  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Update a Notion page content by replacing its block children.
   * This is used for sync-to-source functionality.
   */
  async updatePageContent(pageId: string, content: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Size guard
      const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB
      if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_SIZE) {
        return { success: false, error: 'Content exceeds 1MB size limit for sync' };
      }

      // For v1, we'll use a simple approach: delete all existing blocks and append new ones
      // In a more sophisticated implementation, we would parse markdown and convert to Notion blocks
      
      // First, delete existing block children
      const deleteResult = await this.httpRequest('DELETE', `/blocks/${pageId}/children`);
      if (deleteResult.status !== 200) {
        return { success: false, error: `Failed to clear page blocks (HTTP ${deleteResult.status})` };
      }

      // For v1, we'll append the content as a single paragraph block
      // This is a simplification - a full implementation would parse markdown to blocks
      const blockPayload = {
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'text',
                  text: {
                    content: content.substring(0, 2000) // Notion has limits on block size
                  }
                }
              ]
            }
          }
        ]
      };

      const appendResult = await this.httpRequest('PATCH', `/blocks/${pageId}/children`, blockPayload);
      if (appendResult.status >= 200 && appendResult.status < 300) {
        return { success: true };
      }
      return { success: false, error: `Failed to append content (HTTP ${appendResult.status})` };
    } catch (err: any) {
      return { success: false, error: String(err) };
    }
  }

  get configPath(): string { return this._configPath; }
  get cachePath(): string { return this._cachePath; }
  get workspaceRoot(): string { return this._workspaceRoot; }
}
