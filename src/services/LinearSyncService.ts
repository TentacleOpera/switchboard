import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { CANONICAL_COLUMNS } from './ClickUpSyncService';
import { KanbanDatabase } from './KanbanDatabase';
import type { AutoPullIntervalMinutes } from './IntegrationAutoPullService';
import { DEFAULT_LIVE_SYNC_CONFIG } from '../models/LiveSyncTypes';
import {
  type LinearAutomationRule,
  normalizeLinearAutomationRules
} from '../models/PipelineDefinition';

export interface LinearConfig {
  teamId: string;
  teamName: string;
  includeProjectNames?: string[];
  excludeProjectNames?: string[];
  columnToStateId: Record<string, string>;
  switchboardLabelId: string;
  setupComplete: boolean;
  lastSync: string | null;
  realTimeSyncEnabled: boolean;
  autoPullEnabled: boolean;
  pullIntervalMinutes: AutoPullIntervalMinutes;
  automationRules: LinearAutomationRule[];
  deleteSyncEnabled?: boolean;  // default: true — archive Linear issue when plan is deleted
  completeSyncEnabled?: boolean;  // default: true — sync completed status to Linear
  excludeBacklog?: boolean;  // default: true — exclude backlog issues from sync
  selectedProjectName: string;  // Persisted project picker value for sidebar filter
}

export interface LinearApplyOptions {
  mapColumns: boolean;
  createLabel: boolean;
  includeProjectNames?: string[];
  excludeProjectNames?: string[];
  enableRealtimeSync: boolean;
  enableAutoPull: boolean;
  deleteSyncEnabled?: boolean;
  enableCompleteSync?: boolean;
  excludeBacklog?: boolean;  // NEW: exclude backlog issues from sync
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: { id: string; name: string; type: string } | null;
  priority: number | null;
  assignee: { id: string; name: string; email: string } | null;
  project: { id: string; name: string } | null;
  labels: Array<{ id: string; name: string }>;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface LinearComment {
  id: string;
  body: string;
  user: { name: string; email?: string } | null;
  createdAt: string;
}

export interface LinearAttachment {
  id: string;
  title: string;
  url: string;
  filename?: string;
  filesize?: number;
  mimeType?: string;
}

export type LinearIssueFilter = {
  team: { id: { eq: string } };
  project?: { id: { eq: string } };
};

export function buildLinearIssueFilter(teamId: string, projectId?: string): LinearIssueFilter {
  const normalizedTeamId = String(teamId || '').trim();
  if (!normalizedTeamId) {
    throw new Error('Linear issue list queries require a team ID.');
  }

  const normalizedProjectId = String(projectId || '').trim();
  const filter: LinearIssueFilter = {
    team: { id: { eq: normalizedTeamId } }
  };

  if (normalizedProjectId) {
    filter.project = { id: { eq: normalizedProjectId } };
  }

  return filter;
}

export { CANONICAL_COLUMNS };

const LINEAR_API_HOST = 'api.linear.app';
const LINEAR_API_PATH = '/graphql';

export class LinearSyncService {
  private _workspaceRoot: string;
  private _configPath: string;
  private _syncMapPath: string;
  private _config: LinearConfig | null = null;
  private _secretStorage: vscode.SecretStorage;
  private _setupInProgress = false;
  private _isSyncInProgress = false;
  private _consecutiveFailures = 0;
  private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly _maxRetries = 3;
  private _lastRequestTime = 0;
  private readonly _minDelayMs = 50;

  private static readonly _transientMarkers = [
    'socket hang up',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'EAI_AGAIN',
    'timeout',
    'network error',
    '429',
    'rate limit',
    'too many requests'
  ];

  private _isTransientError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return LinearSyncService._transientMarkers.some(marker => message.includes(marker.toLowerCase()));
  }

  private async _throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this._lastRequestTime;
    if (elapsed < this._minDelayMs) {
      await this.delay(this._minDelayMs - elapsed);
    }
    this._lastRequestTime = Date.now();
  }

  constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage) {
    this._workspaceRoot = workspaceRoot;
    this._configPath = path.join(workspaceRoot, '.switchboard', 'linear-config.json');
    this._syncMapPath = path.join(workspaceRoot, '.switchboard', 'linear-sync.json');
    this._secretStorage = secretStorage;
  }

  // ── Config I/O ───────────────────────────────────────────────

  private _createEmptyConfig(): LinearConfig {
    return {
      teamId: '',
      teamName: '',
      includeProjectNames: undefined,
      excludeProjectNames: undefined,
      columnToStateId: {},
      switchboardLabelId: '',
      setupComplete: false,
      lastSync: null,
      realTimeSyncEnabled: false,
      autoPullEnabled: false,
      pullIntervalMinutes: 60,
      automationRules: [],
      completeSyncEnabled: true,
      excludeBacklog: true,  // default to excluding backlog for lightweight sync
      selectedProjectName: ''  // default to no project selected
    };
  }

  private _normalizeConfig(raw: Partial<LinearConfig> | null): LinearConfig | null {
    if (!raw) {
      return null;
    }

    const interval = raw.pullIntervalMinutes;
    const normalizedInterval: AutoPullIntervalMinutes =
      interval === 5 || interval === 15 || interval === 30 || interval === 60 ? interval : 60;

    const normalizeNameArray = (arr: unknown): string[] | undefined => {
      if (!Array.isArray(arr)) return undefined;
      const normalized = arr
        .map((item: unknown) => String(item || '').trim())
        .filter((name: string) => name.length > 0);
      return normalized.length > 0 ? normalized : undefined;
    };

    return {
      teamId: raw.teamId || '',
      teamName: raw.teamName || '',
      includeProjectNames: normalizeNameArray(raw.includeProjectNames),
      excludeProjectNames: normalizeNameArray(raw.excludeProjectNames),
      columnToStateId: raw.columnToStateId || {},
      switchboardLabelId: raw.switchboardLabelId || '',
      setupComplete: raw.setupComplete === true,
      lastSync: raw.lastSync || null,
      realTimeSyncEnabled: raw.realTimeSyncEnabled === undefined
        ? raw.setupComplete === true
        : raw.realTimeSyncEnabled === true,
      autoPullEnabled: raw.autoPullEnabled === true,
      pullIntervalMinutes: normalizedInterval,
      automationRules: normalizeLinearAutomationRules(raw.automationRules),
      deleteSyncEnabled: raw.deleteSyncEnabled === undefined
        ? (raw.setupComplete === true)  // default true for existing setups
        : raw.deleteSyncEnabled === true,
      completeSyncEnabled: raw.completeSyncEnabled !== false,  // default true
      excludeBacklog: raw.excludeBacklog !== false,  // default true — exclude backlog issues
      selectedProjectName: raw.selectedProjectName || ''  // normalize missing/undefined to empty string
    };
  }

  async loadConfig(): Promise<LinearConfig | null> {
    try {
      const content = await fs.promises.readFile(this._configPath, 'utf8');
      const raw = JSON.parse(content);

      // Migration: legacy projectId → includeProjectNames
      if (raw.projectId && (!raw.includeProjectNames || raw.includeProjectNames.length === 0)) {
        try {
          const resolvedName = await this._resolveProjectIdToName(raw.projectId);
          if (resolvedName) {
            console.log(`[LinearSync] Migrating legacy projectId to includeProjectNames: ${resolvedName}`);
            raw.includeProjectNames = [resolvedName];
            delete raw.projectId;
            // Save migrated config
            await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
            await fs.promises.writeFile(this._configPath, JSON.stringify(raw, null, 2));
          } else {
            console.warn(`[LinearSync] Failed to resolve legacy projectId to name, deferring migration. API may be unavailable.`);
          }
        } catch (error) {
          console.warn(`[LinearSync] Migration deferred due to error:`, error);
        }
      }

      const normalized = this._normalizeConfig(raw);
      this._config = normalized;
      return normalized;
    } catch { return null; }
  }

  async saveConfig(config: LinearConfig): Promise<void> {
    const normalized = this._normalizeConfig(config);
    if (!normalized) {
      throw new Error('Linear config normalization failed');
    }
    await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
    await fs.promises.writeFile(this._configPath, JSON.stringify(normalized, null, 2));
    this._config = normalized;
  }

  async saveAutomationSettings(
    automationRules: LinearAutomationRule[]
  ): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear must be set up before saving automation settings.');
    }

    await this.saveConfig({
      ...config,
      automationRules: normalizeLinearAutomationRules(automationRules)
    });
  }

  async getAutomationCatalog(): Promise<{
    labels: Array<{ id: string; name: string }>;
    states: Array<{ id: string; name: string; type: string }>;
  }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear must be set up before loading automation labels and states.');
    }

    const result = await this.graphqlRequest(`
      query($teamId: String!) {
        team(id: $teamId) {
          states { nodes { id name type } }
          labels { nodes { id name } }
        }
      }
    `, { teamId: config.teamId });

    const team = result.data?.team;
    if (!team) {
      throw new Error('Failed to load Linear automation catalog.');
    }

    return {
      labels: Array.isArray(team.labels?.nodes)
        ? team.labels.nodes
            .map((label: any) => ({
              id: String(label?.id || '').trim(),
              name: String(label?.name || '').trim()
            }))
            .filter((label: { id: string; name: string }) => label.id && label.name)
        : [],
      states: Array.isArray(team.states?.nodes)
        ? team.states.nodes
            .map((state: any) => ({
              id: String(state?.id || '').trim(),
              name: String(state?.name || '').trim(),
              type: String(state?.type || '').trim()
            }))
            .filter((state: { id: string; name: string; type: string }) => state.id && state.name)
        : []
    };
  }

  private _normalizeLinearIssue(raw: any): LinearIssue {
    return {
      id: String(raw?.id || '').trim(),
      identifier: String(raw?.identifier || '').trim(),
      title: String(raw?.title || '').trim(),
      description: String(raw?.description || ''),
      state: raw?.state
        ? {
          id: String(raw.state.id || '').trim(),
          name: String(raw.state.name || '').trim(),
          type: String(raw.state.type || '').trim()
        }
        : null,
      priority: raw?.priority === undefined || raw?.priority === null ? null : Number(raw.priority),
      assignee: raw?.assignee
        ? {
          id: String(raw.assignee.id || '').trim(),
          name: String(raw.assignee.name || '').trim(),
          email: String(raw.assignee.email || '').trim()
        }
        : null,
      project: raw?.project
        ? {
          id: String(raw.project.id || '').trim(),
          name: String(raw.project.name || '').trim()
        }
        : null,
      labels: Array.isArray(raw?.labels?.nodes)
        ? raw.labels.nodes.map((label: any) => ({
          id: String(label?.id || '').trim(),
          name: String(label?.name || '').trim()
        })).filter((label: { id: string; name: string }) => label.id.length > 0 || label.name.length > 0)
        : [],
      createdAt: String(raw?.createdAt || '').trim(),
      updatedAt: String(raw?.updatedAt || '').trim(),
      url: String(raw?.url || '').trim()
    };
  }

  private _normalizeLinearComment(raw: any): LinearComment {
    return {
      id: String(raw?.id || '').trim(),
      body: String(raw?.body || ''),
      user: raw?.user
        ? {
          name: String(raw.user.name || '').trim(),
          email: String(raw.user.email || '').trim() || undefined
        }
        : null,
      createdAt: String(raw?.createdAt || '').trim()
    };
  }

  private _normalizeLinearAttachment(raw: any): LinearAttachment {
    const title = String(raw?.title || '').trim();
    const url = String(raw?.url || '').trim();
    const metadata = raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
    const subtitle = String(raw?.subtitle || '').trim();
    const derivedFilename = subtitle
      || title
      || (url ? url.split('/').filter(Boolean).pop() || '' : '');
    const filesizeValue = Number(metadata?.size);
    return {
      id: String(raw?.id || '').trim(),
      title,
      url,
      filename: derivedFilename || undefined,
      filesize: Number.isFinite(filesizeValue) && filesizeValue > 0 ? filesizeValue : undefined,
      mimeType: String(metadata?.contentType || metadata?.mimeType || '').trim() || undefined
    };
  }

  private _buildIssueListQuery(): string {
    return `
      query($filter: IssueFilter!, $after: String, $first: Int!) {
        issues(
          filter: $filter
          after: $after
          first: $first
        ) {
          nodes {
            id
            identifier
            title
            description
            state { id name type }
            priority
            assignee { id name email }
            project { id name }
            labels { nodes { id name } }
            createdAt
            updatedAt
            url
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
  }

  private _isIssueIdentifier(value: string): boolean {
    return /^[A-Z][A-Z0-9_]*-\d+$/.test(value);
  }

  private _buildFallbackDescription(planFile: string): string {
    return `Managed by Switchboard.\n\nPlan file: \`${planFile}\`\n\nDo not edit the title — it is synced from Switchboard.`;
  }

  private _truncateInitialDescription(markdownContent: string): string {
    const maxBytes = DEFAULT_LIVE_SYNC_CONFIG.maxContentSizeBytes;
    const suffix = '\n\n... (truncated by Switchboard before Linear issue creation)';

    if (Buffer.byteLength(markdownContent, 'utf8') <= maxBytes) {
      return markdownContent;
    }

    let end = markdownContent.length;
    while (end > 0 && Buffer.byteLength(`${markdownContent.slice(0, end)}${suffix}`, 'utf8') > maxBytes) {
      end--;
    }

    return `${markdownContent.slice(0, end)}${suffix}`;
  }

  /**
   * Strip a leading ATX H1 header from markdown content.
   * Only strips if the first non-blank line starts with '# ' at column 0.
   * Also skips blank lines immediately after the H1 to avoid a leading blank line.
   * Does NOT handle Setext-style H1s (underlined with ===).
   */
  private _stripH1Header(markdownContent: string): string {
    const lines = markdownContent.split(/\r?\n/);

    // Find the first non-blank line
    let h1LineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') {
        continue;
      }
      // Check if this line is an ATX H1: starts with '# ' at column 0
      if (/^# /.test(lines[i])) {
        h1LineIndex = i;
      }
      // Whether or not it's an H1, stop scanning — we only strip if H1 is the very first non-blank line
      break;
    }

    if (h1LineIndex === -1) {
      // No leading H1 found — return content unchanged
      return markdownContent;
    }

    // Skip the H1 line and any blank lines immediately after it
    let startIndex = h1LineIndex + 1;
    while (startIndex < lines.length && lines[startIndex].trim() === '') {
      startIndex++;
    }

    return lines.slice(startIndex).join('\n');
  }

  private async _buildInitialIssueDescription(planFile: string): Promise<string> {
    const fallback = this._buildFallbackDescription(planFile);
    try {
      const planFilePath = path.isAbsolute(planFile)
        ? planFile
        : path.join(this._workspaceRoot, planFile);
      const markdownContent = await fs.promises.readFile(planFilePath, 'utf8');
      const contentWithoutH1 = this._stripH1Header(markdownContent);
      return this._truncateInitialDescription(contentWithoutH1);
    } catch (error) {
      console.warn(`[LinearSync] Failed to read plan file ${planFile}:`, error);
      return fallback;
    }
  }

  // ── Project Filter Helpers ───────────────────────────────────────

  public async getAvailableProjects(): Promise<{ id: string; name: string }[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const result = await this.graphqlRequest(`
      query($teamId: String!) { team(id: $teamId) { projects { nodes { id name } } } }
    `, { teamId: config.teamId });

    const projects = Array.isArray(result.data?.team?.projects?.nodes)
      ? result.data.team.projects.nodes
      : [];
    return projects.map((project: any) => ({
      id: String(project?.id || '').trim(),
      name: String(project?.name || '').trim()
    })).filter((project: { id: string; name: string }) => project.id.length > 0 && project.name.length > 0);
  }

  public async resolveSingleIncludeProjectId(config?: LinearConfig): Promise<string | undefined> {
    const cfg = config || await this.loadConfig();
    if (!cfg) {
      return undefined;
    }
    const includeNames = cfg.includeProjectNames || [];
    const excludeNames = cfg.excludeProjectNames || [];
    if (includeNames.length !== 1 || excludeNames.length > 0) {
      return undefined;
    }
    const projectName = includeNames[0];
    const projects = await this.getAvailableProjects();
    const project = projects.find(p => p.name.toLowerCase() === projectName.toLowerCase());
    return project?.id;
  }

  private async _resolveProjectIdToName(projectId: string): Promise<string | null> {
    try {
      const projects = await this.getAvailableProjects();
      const match = projects.find((p) => p.id === projectId);
      return match?.name || null;
    } catch (error) {
      console.warn(`[LinearSync] Failed to resolve project ID to name:`, error);
      return null;
    }
  }

  private _applyProjectNameFilters(issues: LinearIssue[], config: LinearConfig): LinearIssue[] {
    const includeNames = config.includeProjectNames || [];
    const excludeNames = config.excludeProjectNames || [];

    if (includeNames.length === 0 && excludeNames.length === 0) {
      return issues;
    }

    const includeLower = includeNames.map((n) => n.toLowerCase());
    const excludeLower = excludeNames.map((n) => n.toLowerCase());

    return issues.filter((issue) => {
      const projectName = issue.project?.name || '';

      // Issues with no project: exclude if include filter is set, include otherwise
      if (!projectName) {
        return includeNames.length === 0;
      }

      const projectNameLower = projectName.toLowerCase();

      // Apply exclude filter
      if (excludeLower.includes(projectNameLower)) {
        return false;
      }

      // Apply include filter
      if (includeNames.length > 0) {
        return includeLower.includes(projectNameLower);
      }

      return true;
    });
  }

  private async _resolveSingleIncludeProjectId(config: LinearConfig): Promise<string | undefined> {
    const includeNames = config.includeProjectNames || [];
    const excludeNames = config.excludeProjectNames || [];

    // Only use server-side filter for single include with no excludes
    if (includeNames.length === 1 && excludeNames.length === 0) {
      try {
        const projects = await this.getAvailableProjects();
        const match = projects.find((p) => p.name.toLowerCase() === includeNames[0].toLowerCase());
        return match?.id;
      } catch (error) {
        console.warn(`[LinearSync] Failed to resolve single include project ID, falling back to client-side filtering:`, error);
        return undefined;
      }
    }

    return undefined;
  }

  public async queryIssues(options: {
    search?: string;
    stateId?: string;
    assigneeId?: string;
    projectId?: string;
    limit?: number;
  }): Promise<LinearIssue[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const normalizedSearch = String(options.search || '').trim().toLowerCase();
    const normalizedStateId = String(options.stateId || '').trim();
    const normalizedAssigneeId = String(options.assigneeId || '').trim();
    const requestedLimit = Number(options.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 100)
      : 50;

    // Hybrid optimization: use server-side filter for single include, no excludes
    const resolvedProjectId = await this._resolveSingleIncludeProjectId(config);
    const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || undefined);

    const issues: LinearIssue[] = [];
    let cursor: string | null = null;
    const query = this._buildIssueListQuery();
    let pageCount = 0;
    const maxPages = 10; // Hard cap to prevent runaway pagination

    while (issues.length < limit && pageCount < maxPages) {
      const result = await this.graphqlRequest(query, {
        filter,
        after: cursor,
        first: Math.min(50, limit - issues.length)
      });

      const page = result.data?.issues;
      const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
      for (const node of nodes) {
        const issue = this._normalizeLinearIssue(node);
        if (normalizedStateId && issue.state?.id !== normalizedStateId) {
          continue;
        }
        if (normalizedAssigneeId && issue.assignee?.id !== normalizedAssigneeId) {
          continue;
        }
        if (normalizedSearch) {
          const searchableText = [
            issue.identifier,
            issue.title,
            issue.description
          ].join('\n').toLowerCase();
          if (!searchableText.includes(normalizedSearch)) {
            continue;
          }
        }
        issues.push(issue);
        if (issues.length >= limit) {
          break;
        }
      }

      if (!page?.pageInfo?.hasNextPage) {
        break;
      }
      cursor = String(page.pageInfo.endCursor || '').trim() || null;
      if (!cursor) {
        break;
      }
      pageCount++;
      if (pageCount >= maxPages) {
        console.warn(`[LinearSync] Reached maximum page cap (${maxPages}) for queryIssues. Some issues may be omitted.`);
      }
      await this.delay(200);
    }

    // Apply client-side project name filters
    return this._applyProjectNameFilters(issues, config);
  }

  public async getIssue(issueIdOrIdentifier: string): Promise<LinearIssue | null> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const normalizedLookup = String(issueIdOrIdentifier || '').trim();
    if (!normalizedLookup) {
      throw new Error('Linear issue lookup requires an issue ID or identifier.');
    }

    if (!this._isIssueIdentifier(normalizedLookup)) {
      const result = await this.graphqlRequest(`
        query($issueId: String!) {
          issue(id: $issueId) {
            id
            identifier
            title
            description
            state { id name type }
            priority
            assignee { id name email }
            project { id name }
            labels { nodes { id name } }
            createdAt
            updatedAt
            url
          }
        }
      `, { issueId: normalizedLookup });

      return result.data?.issue ? this._normalizeLinearIssue(result.data.issue) : null;
    }

    const query = this._buildIssueListQuery();
    const resolvedProjectId = await this._resolveSingleIncludeProjectId(config);
    const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || undefined);
    let cursor: string | null = null;
    while (true) {
      const result = await this.graphqlRequest(query, {
        filter,
        after: cursor,
        first: 50
      });

      const page = result.data?.issues;
      const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
      const match = nodes.find((node: any) =>
        String(node?.identifier || '').trim().toUpperCase() === normalizedLookup.toUpperCase()
      );
      if (match) {
        const issue = this._normalizeLinearIssue(match);
        // Apply client-side project name filters
        const filtered = this._applyProjectNameFilters([issue], config);
        return filtered.length > 0 ? filtered[0] : null;
      }

      if (!page?.pageInfo?.hasNextPage) {
        break;
      }
      cursor = String(page.pageInfo.endCursor || '').trim() || null;
      if (!cursor) {
        break;
      }
      await this.delay(200);
    }

    return null;
  }

  public async getSubtasks(issueId: string): Promise<LinearIssue[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear subtasks lookup requires an issue ID.');
    }

    const result = await this.graphqlRequest(`
      query($issueId: String!) {
        issue(id: $issueId) {
          children {
            nodes {
              id
              identifier
              title
              description
              state { id name type }
              priority
              assignee { id name email }
              project { id name }
              labels { nodes { id name } }
              createdAt
              updatedAt
              url
            }
          }
        }
      }
    `, { issueId: normalizedIssueId });

    const children = Array.isArray(result.data?.issue?.children?.nodes)
      ? result.data.issue.children.nodes
      : [];
    return children.map((child: any) => this._normalizeLinearIssue(child));
  }

  public async getComments(issueId: string): Promise<LinearComment[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear comment lookup requires an issue ID.');
    }

    const result = await this.graphqlRequest(`
      query($issueId: String!) {
        issue(id: $issueId) {
          comments {
            nodes {
              id
              body
              createdAt
              user { name email }
            }
          }
        }
      }
    `, { issueId: normalizedIssueId });

    const comments = Array.isArray(result.data?.issue?.comments?.nodes)
      ? result.data.issue.comments.nodes
      : [];
    return comments.map((comment: any) => this._normalizeLinearComment(comment));
  }

  public async getAttachments(issueId: string): Promise<LinearAttachment[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear attachment lookup requires an issue ID.');
    }

    const result = await this.graphqlRequest(`
      query($issueId: String!) {
        issue(id: $issueId) {
          attachments {
            nodes {
              id
              title
              url
            }
          }
        }
      }
    `, { issueId: normalizedIssueId });

    const attachments = Array.isArray(result.data?.issue?.attachments?.nodes)
      ? result.data.issue.attachments.nodes
      : [];
    return attachments.map((attachment: any) => this._normalizeLinearAttachment(attachment));
  }

  public async updateIssueState(issueId: string, stateId: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    const normalizedStateId = String(stateId || '').trim();
    if (!normalizedIssueId || !normalizedStateId) {
      throw new Error('Linear state updates require both an issue ID and a state ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }
    `, { id: normalizedIssueId, stateId: normalizedStateId });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested state update.`);
    }
  }

  public async addIssueComment(issueId: string, comment: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    const normalizedComment = String(comment || '').trim();
    if (!normalizedIssueId || !normalizedComment) {
      throw new Error('Linear comments require both an issue ID and non-empty comment text.');
    }

    const result = await this.graphqlRequest(`
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `, { issueId: normalizedIssueId, body: normalizedComment });

    if (!result.data?.commentCreate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested comment.`);
    }
  }

  public async updateIssueDescription(issueId: string, description: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    const normalizedDescription = String(description || '').trim();
    if (!normalizedIssueId || !normalizedDescription) {
      throw new Error('Linear description updates require both an issue ID and non-empty content.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $description: String!) {
        issueUpdate(id: $id, input: { description: $description }) { success }
      }
    `, { id: normalizedIssueId, description: normalizedDescription });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested description update.`);
    }
  }

  async archiveIssue(issueId: string): Promise<{ success: boolean; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      return { success: false, error: 'Linear not configured' };
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      return { success: false, error: 'Issue ID is required' };
    }

    try {
      const result = await this.graphqlRequest(`
        mutation($id: String!, $archivedAt: DateTime!) {
          issueUpdate(id: $id, input: { archivedAt: $archivedAt }) {
            success
          }
        }
      `, {
        id: normalizedIssueId,
        archivedAt: new Date().toISOString()
      });

      if (result.data?.issueUpdate?.success) {
        console.log(`[LinearSync] Archived Linear issue ${normalizedIssueId}`);
        return { success: true };
      } else {
        return { success: false, error: `Linear issue ${normalizedIssueId} rejected the archive request.` };
      }
    } catch (error) {
      return { success: false, error: `Failed to archive Linear issue: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // ── Local Sync Map (sessionId → Linear issueId) ──────────────

  async loadSyncMap(): Promise<Record<string, string>> {
    try {
      const content = await fs.promises.readFile(this._syncMapPath, 'utf8');
      return JSON.parse(content);
    } catch { return {}; }
  }

  async saveSyncMap(map: Record<string, string>): Promise<void> {
    await fs.promises.mkdir(path.dirname(this._syncMapPath), { recursive: true });
    await fs.promises.writeFile(this._syncMapPath, JSON.stringify(map, null, 2));
  }

  async getIssueIdForPlan(sessionId: string): Promise<string | null> {
    const map = await this.loadSyncMap();
    return map[sessionId] || null;
  }

  async setIssueIdForPlan(sessionId: string, issueId: string): Promise<void> {
    const map = await this.loadSyncMap();
    map[sessionId] = issueId;
    await this.saveSyncMap(map);
  }

  // ── Token Management ─────────────────────────────────────────

  async getApiToken(): Promise<string | null> {
    try {
      return await this._secretStorage.get('switchboard.linear.apiToken') || null;
    } catch { return null; }
  }

  // ── GraphQL Client ───────────────────────────────────────────

  /**
   * Authenticated GraphQL request to Linear API.
   * Linear always returns HTTP 200; errors are in response.errors.
   * Throws if HTTP status != 200 OR if response.errors is non-empty.
   */
  async graphqlRequest(
    query: string,
    variables?: Record<string, unknown>,
    timeoutMs = 30000,
    signal?: AbortSignal
  ): Promise<{ data: any }> {
    await this._throttle();
    const token = await this.getApiToken();
    if (!token) { throw new Error('Linear API token not configured'); }

    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = (value: { data: any }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const safeReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const payload = JSON.stringify({ query, variables });
      const req = https.request({
        hostname: LINEAR_API_HOST,
        path: LINEAR_API_PATH,
        method: 'POST',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        // Node emits socket errors/aborts on `res` (not `req`) once response
        // headers have arrived. Without these listeners the Promise orphans
        // forever on mid-stream failures — the primary hang root cause.
        res.on('error', (err) => safeReject(new Error(`Linear response stream error: ${err.message}`)));
        res.on('aborted', () => safeReject(new Error('Linear response aborted by server')));
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return safeReject(new Error(`Linear API HTTP ${res.statusCode}`));
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.errors?.length) {
              return safeReject(new Error(`Linear GraphQL error: ${parsed.errors[0].message}`));
            }
            safeResolve({ data: parsed.data });
          } catch {
            safeReject(new Error('Failed to parse Linear API response'));
          }
        });
      });
      req.on('timeout', () => { req.destroy(); safeReject(new Error('Linear request timed out')); });
      req.on('error', (err) => safeReject(err));

      // Wire up AbortController cancellation
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

      req.write(payload);
      req.end();
    });
  }

  // ── Availability Check ───────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      const token = await this.getApiToken();
      if (!token) { return false; }
      await this.graphqlRequest('{ viewer { id } }', undefined, 10000);
      return true;
    } catch { return false; }
  }

  // ── Setup Flow ───────────────────────────────────────────────

  private async _promptForApiToken(): Promise<string | null> {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter your Linear API token — find it at linear.app/settings/api',
      password: true,
      placeHolder: 'lin_api_...',
      ignoreFocusOut: true,
      validateInput: (value) => (!value || value.trim().length < 10) ? 'Token appears too short' : null
    });
    return input ? input.trim() : null;
  }

  private async _selectTeam(config: LinearConfig): Promise<{ id: string; label: string }> {
    if (config.teamId && config.teamName) {
      return { id: config.teamId, label: config.teamName };
    }

    const teamsResult = await this.graphqlRequest(`{
      teams { nodes { id name } }
    }`);
    const teams = Array.isArray(teamsResult.data?.teams?.nodes) ? teamsResult.data.teams.nodes : [];
    const teamItems: Array<vscode.QuickPickItem & { id: string }> =
      teams.map((team: any) => ({ label: String(team?.name || ''), id: String(team?.id || '') }))
        .filter((team: vscode.QuickPickItem & { id: string }) => Boolean(team.label) && Boolean(team.id));
    const selectedTeam = await vscode.window.showQuickPick(teamItems, { placeHolder: 'Select your Linear team' });
    if (!selectedTeam) {
      throw new Error('No Linear team selected.');
    }
    config.teamId = selectedTeam.id;
    config.teamName = selectedTeam.label;
    return { id: config.teamId, label: config.teamName };
  }

  private async _mapColumnsToStates(teamId: string): Promise<Record<string, string>> {
    const statesResult = await this.graphqlRequest(`
      query($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }
    `, { teamId });
    const states = Array.isArray(statesResult.data?.team?.states?.nodes)
      ? statesResult.data.team.states.nodes
      : [];
    const stateOptions = [
      { label: '(skip — do not sync)', id: '' },
      ...states.map((state: any) => ({
        label: `${state.name} (${state.type})`,
        id: String(state.id)
      }))
    ];

    const columnToStateId: Record<string, string> = {};
    for (const column of CANONICAL_COLUMNS) {
      const selected = await vscode.window.showQuickPick(stateOptions, {
        placeHolder: `Map Switchboard column "${column}" to a Linear state`
      });
      if (selected === undefined) {
        throw new Error(`No Linear state selected for column "${column}".`);
      }
      if (selected.id) {
        columnToStateId[column] = selected.id;
      }
    }
    return columnToStateId;
  }

  private async _ensureSwitchboardLabel(teamId: string): Promise<string> {
    const labelsResult = await this.graphqlRequest(`
      query($teamId: String!) { team(id: $teamId) { labels { nodes { id name } } } }
    `, { teamId });
    const existingLabel = labelsResult.data?.team?.labels?.nodes?.find((label: any) => label.name === 'switchboard');
    if (existingLabel?.id) {
      return String(existingLabel.id);
    }

    const createResult = await this.graphqlRequest(`
      mutation($teamId: String!, $name: String!, $color: String!) {
        issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
          issueLabel { id }
        }
      }
    `, { teamId, name: 'switchboard', color: '#6366f1' });
    const labelId = String(createResult.data?.issueLabelCreate?.issueLabel?.id || '').trim();
    if (!labelId) {
      throw new Error('Failed to create the Switchboard label in Linear.');
    }
    return labelId;
  }

  async applyConfig(options: LinearApplyOptions): Promise<{ success: boolean; error?: string }> {
    if (this._setupInProgress) {
      return { success: false, error: 'Setup already in progress' };
    }
    this._setupInProgress = true;

    const existingConfig = await this.loadConfig();
    const config = existingConfig
      ? { ...existingConfig, columnToStateId: { ...(existingConfig.columnToStateId || {}) } }
      : this._createEmptyConfig();

    try {
      let token = await this.getApiToken();
      if (!token) {
        token = await this._promptForApiToken();
        if (!token) {
          return { success: false, error: 'Setup cancelled — Linear API token required.' };
        }
        await this._secretStorage.store('switchboard.linear.apiToken', token);
      }

      if (!(await this.isAvailable())) {
        return { success: false, error: 'Linear token is invalid. Get a valid token at linear.app/settings/api' };
      }

      const needsTeamSelection = options.mapColumns || options.createLabel || (options.includeProjectNames && options.includeProjectNames.length > 0) || (options.excludeProjectNames && options.excludeProjectNames.length > 0) || options.enableRealtimeSync || options.enableAutoPull;
      const hasExistingSetup = !!config.teamId || !!config.switchboardLabelId || Object.keys(config.columnToStateId || {}).length > 0 || config.setupComplete;

      if (needsTeamSelection && !config.teamId) {
        await this._selectTeam(config);
      }

      config.includeProjectNames = options.includeProjectNames;
      config.excludeProjectNames = options.excludeProjectNames;

      if (options.mapColumns) {
        config.columnToStateId = await this._mapColumnsToStates(config.teamId);
      }

      if (options.createLabel) {
        config.switchboardLabelId = await this._ensureSwitchboardLabel(config.teamId);
      }

      const hasMappedStates = Object.values(config.columnToStateId || {}).some(
        (stateId) => typeof stateId === 'string' && stateId.trim().length > 0
      );
      if (options.enableRealtimeSync) {
        if (!config.teamId) {
          throw new Error('Realtime sync requires a configured Linear team.');
        }
        if (!hasMappedStates) {
          throw new Error('Realtime sync requires at least one mapped Linear state.');
        }
      }

      if (options.enableAutoPull && !config.teamId) {
        throw new Error('Auto-pull requires a configured Linear team.');
      }

      config.realTimeSyncEnabled = options.enableRealtimeSync === true;
      config.autoPullEnabled = options.enableAutoPull === true;
      config.deleteSyncEnabled = options.deleteSyncEnabled !== false;
      config.completeSyncEnabled = options.enableCompleteSync !== false;
      config.excludeBacklog = options.excludeBacklog !== false;  // default true
      config.setupComplete = true;
      await this.saveConfig(config);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      this._setupInProgress = false;
    }
  }

  // ── Sync Methods (Part 3) ────────────────────────────────────

  private _complexityToPriority(complexity: string): number {
    const n = parseInt(complexity, 10);
    if (isNaN(n)) { return 0; }
    if (n >= 9) { return 1; }
    if (n >= 7) { return 2; }
    if (n >= 5) { return 3; }
    return 4;
  }

  async syncPlan(plan: { sessionId: string; topic: string; planFile: string; complexity: string }, newColumn: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) { return; }

    const stateId = config.columnToStateId[newColumn];
    if (!stateId) {
      console.warn(`[LinearSync] No Linear state mapped for column "${newColumn}" - skipping sync for plan ${plan.sessionId}`);
      return;
    } // column not mapped

    const existingIssueId = await this.getIssueIdForPlan(plan.sessionId);
    const priority = this._complexityToPriority(plan.complexity);

    try {
      if (existingIssueId) {
        console.log(`[LinearSync] Updating existing Linear issue ${existingIssueId} for plan ${plan.sessionId} to state ${stateId}`);
        const result = await this.retry(() => this.graphqlRequest(`
          mutation($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
          }
        `, { id: existingIssueId, stateId }));

        if (!result.data.issueUpdate.success) {
          console.warn(`[LinearSync] Issue update failed for ${existingIssueId}, attempting to recreate`);
          await this._createIssue(plan, stateId, priority, config);
        } else {
          console.log(`[LinearSync] Successfully updated Linear issue ${existingIssueId} for plan ${plan.sessionId}`);
        }
      } else {
        await this._createIssue(plan, stateId, priority, config);
      }
    } catch (error) {
      console.warn(`[LinearSync] Failed to sync plan ${plan.sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Sync plan markdown content to Linear issue description.
   * Used by ContinuousSyncService for live updates.
   * Does NOT change issue state or other fields.
   */
  async syncPlanContent(issueId: string, markdownContent: string, signal?: AbortSignal): Promise<{ success: boolean; error?: string }> {
    try {
      const config = await this.loadConfig();
      if (!config?.setupComplete) {
        return { success: false, error: 'Linear not set up' };
      }

      // Strip H1 header before syncing to description
      const contentWithoutH1 = this._stripH1Header(markdownContent);

      // Use existing graphqlRequest helper (line 192) — handles token, timeouts, error formatting
      const mutation = `
        mutation UpdateIssueDescription($id: String!, $description: String!) {
          issueUpdate(id: $id, input: { description: $description }) {
            success
            issue { id }
          }
        }
      `;

      const result = await this.graphqlRequest(mutation, {
        id: issueId,
        description: contentWithoutH1
      }, 30000, signal);

      if (result.data?.issueUpdate?.success) {
        return { success: true };
      } else {
        return { success: false, error: 'Linear issueUpdate returned success=false' };
      }
    } catch (error) {
      return { success: false, error: `Sync failed: ${error}` };
    }
  }

  private async _createIssue(
    plan: { sessionId: string; topic: string; planFile: string },
    stateId: string,
    priority: number,
    config: LinearConfig
  ): Promise<void> {
    console.log(`[LinearSync] Creating Linear issue for plan ${plan.sessionId} with title "${plan.topic}"`);
    const description = await this._buildInitialIssueDescription(plan.planFile);

    // Pre-mark in sync map BEFORE GraphQL call to prevent automation race condition.
    // Marker format: `creating_${sessionId}_${timestamp}`. The timestamp is used by the
    // stale-marker sweep in importIssuesFromLinear to age out abandoned markers.
    const tempMarker = `creating_${plan.sessionId}_${Date.now()}`;
    await this.setIssueIdForPlan(plan.sessionId, tempMarker);

    const resolvedProjectId = await this._resolveSingleIncludeProjectId(config);
    let issueCreated = false;
    try {
      const result = await this.retry(() => this.graphqlRequest(`
        mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }
      `, {
        input: {
          teamId: config.teamId,
          title: plan.topic,
          stateId,
          priority,
          labelIds: config.switchboardLabelId ? [config.switchboardLabelId] : [],
          description,
          ...(resolvedProjectId ? { projectId: resolvedProjectId } : {})
        }
      }));

      if (result.data.issueCreate.success) {
        const issueId = result.data.issueCreate.issue.id;
        const identifier = result.data.issueCreate.issue.identifier;
        // Overwrite the temp marker with the real issue ID — this is the race-free handoff.
        await this.setIssueIdForPlan(plan.sessionId, issueId);
        issueCreated = true;
        const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
        const ready = await db.ensureReady();
        if (!ready) {
          throw new Error(`Kanban database unavailable while linking Linear issue ${issueId} to plan ${plan.sessionId}.`);
        }
        const persisted = await db.updateLinearIssueId(plan.sessionId, issueId);
        if (!persisted) {
          throw new Error(`Failed to persist Linear issue ${issueId} for plan ${plan.sessionId}.`);
        }
        console.log(`[LinearSync] Created Linear issue ${identifier} (ID: ${issueId}) for plan ${plan.sessionId}`);
      } else {
        console.error(`[LinearSync] Failed to create Linear issue for plan ${plan.sessionId}`);
        throw new Error(`Failed to create Linear issue for plan ${plan.sessionId}.`);
      }
    } finally {
      // Guaranteed cleanup: if the temp marker is still present (we never replaced it
      // with the real issue ID), remove it. Covers success-that-failed-to-link,
      // GraphQL mutation returning success=false, and retry() exhaustion throws.
      if (!issueCreated) {
        try {
          const map = await this.loadSyncMap();
          if (map[plan.sessionId] === tempMarker) {
            delete map[plan.sessionId];
            await this.saveSyncMap(map);
          }
        } catch (cleanupErr) {
          console.warn(`[LinearSync] Failed to clean up temp marker for ${plan.sessionId}:`, cleanupErr);
        }
      }
    }
  }

  // ── Debounced Sync ───────────────────────────────────────────

  debouncedSync(sessionId: string, plan: any, column: string): void {
    const existing = this._debounceTimers.get(sessionId);
    if (existing) { clearTimeout(existing); }
    this._debounceTimers.set(sessionId, setTimeout(async () => {
      this._debounceTimers.delete(sessionId);
      try {
        await this.syncPlan(plan, column);
        this._consecutiveFailures = 0;
      } catch (error) {
        console.error(`[LinearSync] Failed to sync plan ${sessionId} to column ${column}:`, error);
        this._consecutiveFailures++;
      }
    }, 500));
  }

  // ── Utilities ────────────────────────────────────────────────

  get setupInProgress() { return this._setupInProgress; }
  set setupInProgress(v) { this._setupInProgress = v; }
  get isSyncInProgress() { return this._isSyncInProgress; }
  set isSyncInProgress(v) { this._isSyncInProgress = v; }
  get consecutiveFailures(): number { return this._consecutiveFailures; }
  set consecutiveFailures(v: number) { this._consecutiveFailures = v; }
  get debounceTimers() { return this._debounceTimers; }
  get configPath() { return this._configPath; }
  get workspaceRoot() { return this._workspaceRoot; }

  delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) { chunks.push(array.slice(i, i + size)); }
    return chunks;
  }

  async retry<T>(fn: () => Promise<T>, retries = this._maxRetries): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try { return await fn(); }
      catch (error) {
        if (i === retries - 1) { throw error; }
        // Fast-fail on permanent errors (auth, config, GraphQL validation)
        if (!this._isTransientError(error)) { throw error; }
        const jitterMs = Math.floor(Math.random() * 400);
        const backoffMs = Math.min(Math.pow(2, i) * 1000, 5000) + jitterMs;
        await this.delay(backoffMs);
      }
    }
    throw new Error('Max retries exceeded');
  }

  // ── Import Issues (legacy — used by extension.ts) ────────────

  async importIssuesFromLinear(plansDir: string): Promise<{ success: boolean; imported: number; skipped: number; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      return { success: false, imported: 0, skipped: 0, error: 'Linear not set up' };
    }

    try {
      // --- Stale marker sweep (TTL = 60s) ------------------------------------
      // A `creating_${sessionId}_${timestamp}` marker older than 60s is assumed
      // to be abandoned (extension restart mid-create, network stall past retry
      // budget, etc.). Removing it unblocks auto-pull for that session.
      const STALE_MARKER_TTL_MS = 60_000;
      const nowTs = Date.now();
      {
        const map = await this.loadSyncMap();
        let dirty = false;
        for (const [sid, val] of Object.entries(map)) {
          if (typeof val === 'string' && val.startsWith('creating_')) {
            const m = val.match(/^creating_(.+)_(\d+)$/);
            const ts = m ? parseInt(m[2], 10) : NaN;
            if (!Number.isFinite(ts) || (nowTs - ts) > STALE_MARKER_TTL_MS) {
              delete map[sid];
              dirty = true;
            }
          }
        }
        if (dirty) { await this.saveSyncMap(map); }
      }

      const syncMap = await this.loadSyncMap();
      const syncMapIssueIds = new Set(Object.values(syncMap));

      // Sessions with a live (non-stale) creating_* marker. An inbound issue
      // whose title matches one of these sessions is our own outbound create
      // still in flight — skip it to avoid a duplicate.
      const sessionIdsBeingCreated = new Set<string>(
        Object.entries(syncMap)
          .filter(([, v]) => typeof v === 'string' && v.startsWith('creating_'))
          .map(([sid]) => sid)
      );

      // Resolve DB handle + workspaceId once for the scoped title fallback.
      const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
      const ready = await db.ensureReady();
      const workspaceId = ready ? (await db.getWorkspaceId()) || '' : '';

      const allIssues: any[] = [];
      let cursor: string | null = null;

      const resolvedProjectId = await this._resolveSingleIncludeProjectId(config);
      const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || undefined);
      const QUERY = `
        query($filter: IssueFilter!, $after: String) {
          issues(
            filter: $filter
            after: $after
            first: 50
          ) {
            nodes {
              id identifier title description url priority
              state { name type }
              assignee { name email }
              labels { nodes { name } }
              dueDate createdAt estimate
              parent { id title identifier }
              children { nodes { id identifier title description url priority state { name type } assignee { name email } labels { nodes { name } } dueDate createdAt estimate parent { id } } }
              project { name }
              cycle { name number }
              comments { nodes { body user { name } createdAt } }
              attachments { nodes { title url } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `;

      while (true) {
        const result = await this.graphqlRequest(QUERY, {
          filter,
          after: cursor
        });
        const page = result.data.issues;
        allIssues.push(...page.nodes);
        if (!page.pageInfo.hasNextPage) { break; }
        cursor = page.pageInfo.endCursor;
        await this.delay(200);
      }

      // Apply client-side project name filters
      const filteredIssues = this._applyProjectNameFilters(allIssues, config);

      const subIssues = filteredIssues.flatMap((issue: any) => issue.children?.nodes || []);
      const allTasks = [...new Map([...filteredIssues, ...subIssues].map((t: any) => [t.id, t])).values()];

      const issueNameById = new Map<string, string>(allTasks.map((t: any) => [t.id, `${t.title} (${t.identifier})`]));
      const subIssuesByParentId = new Map<string, any[]>();
      for (const task of allTasks) {
        if (task.parent?.id) {
          const siblings = subIssuesByParentId.get(task.parent.id) || [];
          siblings.push(task);
          subIssuesByParentId.set(task.parent.id, siblings);
        }
      }

      await fs.promises.mkdir(plansDir, { recursive: true });
      let imported = 0;
      let skipped = 0;

      for (const issue of allTasks) {
        if (syncMapIssueIds.has(issue.id)) { skipped++; continue; }

        // Scoped title fallback: only suppress if a local session is actively
        // being created AND its topic matches this issue's title. Global title
        // matching is explicitly avoided to prevent silent import loss.
        if (sessionIdsBeingCreated.size > 0 && ready && workspaceId) {
          const localPlan = await db.getPlanByTopic(issue.title || '', workspaceId);
          if (localPlan && sessionIdsBeingCreated.has(localPlan.sessionId)) {
            skipped++;
            continue;
          }
        }

        const stateType = (issue.state?.type || '').toLowerCase();
        // Always filter out completed/cancelled/archived issues
        if (stateType === 'completed' || stateType === 'cancelled' || stateType === 'canceled' || stateType === 'archived') {
          skipped++;
          continue;
        }

        // Filter out backlog if configured (default: true)
        if (config.excludeBacklog !== false && stateType === 'backlog') {
          skipped++;
          continue;
        }

        const planFile = path.join(plansDir, `linear_import_${issue.id}.md`);
        try { await fs.promises.access(planFile); skipped++; continue; } catch { /* proceed */ }

        // Note: backlog issues reach here only when excludeBacklog is explicitly false
        const kanbanColumn = stateType === 'backlog' ? 'BACKLOG' : 'CREATED';
        const priority = ['', 'urgent', 'high', 'normal', 'low'][issue.priority] || '';
        const dueDate = issue.dueDate || '';
        const assignee = issue.assignee ? (issue.assignee.name || issue.assignee.email) : '';
        const labels = (issue.labels?.nodes || []).map((l: any) => l.name).filter((n: string) => n !== 'switchboard').join(', ');
        const description = (issue.description || '').trim();
        const parentRef = issue.parent?.id ? (issueNameById.get(issue.parent.id) || issue.parent.id) : '';

        const metaLines = [
          `> Imported from Linear issue \`${issue.identifier}\``,
          issue.url         ? `> **URL:** ${issue.url}`              : '',
          parentRef         ? `> **Parent Issue:** ${parentRef}`     : '',
          priority          ? `> **Priority:** ${priority}`          : '',
          dueDate           ? `> **Due:** ${dueDate}`                : '',
          assignee          ? `> **Assignee:** ${assignee}`          : '',
          labels            ? `> **Labels:** ${labels}`              : '',
          issue.state?.name ? `> **State:** ${issue.state.name}`    : '',
        ].filter(Boolean).join('\n');

        const subIssuesList = subIssuesByParentId.get(issue.id) || [];
        const subIssueLines = subIssuesList.map((s: any) =>
          `- ${s.title} (\`${s.identifier}\`) — see \`linear_import_${s.id}.md\``
        );

        const commentLines = (issue.comments?.nodes || []).map((c: any) =>
          `- **${c.user?.name || 'Unknown'} (${c.createdAt?.slice(0, 10) || ''}):** ${c.body}`
        );

        const attachmentLines = (issue.attachments?.nodes || []).map((a: any) =>
          `- [${a.title}](${a.url})`
        );

        const notesLines = [
          '## Linear Issue Notes',
          '',
          `**State:** ${issue.state?.name || ''} (${stateType})`,
          issue.estimate !== null && issue.estimate !== undefined ? `**Estimate:** ${issue.estimate} points` : '',
          issue.project?.name ? `**Project:** ${issue.project.name}` : '',
          issue.cycle?.name   ? `**Cycle:** ${issue.cycle.name} (#${issue.cycle.number})` : '',
          `**Created:** ${issue.createdAt?.slice(0, 10) || ''}`,
          ...(subIssueLines.length > 0 ? ['', '**Sub-issues (each imported as a separate plan):**', ...subIssueLines] : []),
          ...(commentLines.length > 0 ? ['', '**Comments:**', ...commentLines] : []),
          ...(attachmentLines.length > 0 ? ['', '**Attachments:**', ...attachmentLines] : []),
        ].filter(s => s !== '').join('\n');

        const stub = [
          `# ${issue.title || `Linear Issue ${issue.identifier}`}`,
          '',
          metaLines,
          '',
          '## Goal',
          '',
          description || 'TODO',
          '',
          '## Proposed Changes',
          '',
          'TODO',
          '',
          notesLines,
          '',
          `## Switchboard State\n\n**Kanban Column:** ${kanbanColumn}\n**Status:** active\n`,
        ].join('\n');

        await fs.promises.writeFile(planFile, stub, 'utf8');
        imported++;
      }

      return { success: true, imported, skipped };
    } catch (error) {
      return { success: false, imported: 0, skipped: 0, error: `Import failed: ${error}` };
    }
  }
}
