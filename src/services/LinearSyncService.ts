import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as crypto from 'crypto';
import { hostInlineImages } from './ImageHostingHelper';
import { CANONICAL_COLUMNS } from './ClickUpSyncService';
import { KanbanDatabase } from './KanbanDatabase';
import type { AutoPullIntervalMinutes } from './IntegrationAutoPullService';
import { DEFAULT_LIVE_SYNC_CONFIG } from '../models/LiveSyncTypes';
import {
  type LinearAutomationRule,
  normalizeLinearAutomationRules
} from '../models/PipelineDefinition';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import { stampMarker, truncateForComment } from './commentMarker';
import { localizeHttpError } from './errorMessages';


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
  deleteSyncEnabled?: boolean;  // default: false — archive Linear issue when plan is deleted (opt-in)
  completeSyncEnabled?: boolean;  // default: true — sync completed status to Linear
  excludeBacklog?: boolean;  // default: true — exclude backlog issues from sync
  selectedProjectName: string;  // Persisted project picker value for sidebar filter
  ticketSaveLocation?: string;  // base dir for local ticket .md files (set via Setup / migration)
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
  parentId: string | null;
}

export interface LinearComment {
  id: string;
  body: string;
  user: { id?: string; name: string; email?: string } | null;
  createdAt: string;
  parentId?: string | null;
  mentions?: Array<{ id: string; name: string }>;
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
  updatedAt?: { gt: string };
};

export function buildLinearIssueFilter(teamId: string, projectId?: string, updatedAfter?: string): LinearIssueFilter {
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

  // Delta filter: Linear's GraphQL IssueFilter accepts updatedAt as a
  // DateComparator with gt operator. Value is ISO 8601 (DateTimeOrDuration).
  if (updatedAfter) {
    filter.updatedAt = { gt: updatedAfter };
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

  // Cache service for issue caching
  private _cacheService: import('./PlanningPanelCacheService').PlanningPanelCacheService | null = null;
  private _tokenPresentCache: boolean | null = null;

  // Reverse map: issueId -> projectId for efficient cache invalidation
  private _issueProjectIndex: Map<string, string> = new Map();
  private _cachedProjects: { id: string; name: string }[] | null = null;
  /**
   * Cached team members for the mention picker.
   * 5-minute TTL (matches _cachedProjects pattern).
   */
  private _cachedMembers: { data: Array<{ id: string; name: string; email: string }>; fetchedAt: number } | null = null;
  private static readonly MEMBERS_TTL_MS = 5 * 60 * 1000;

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

  /**
   * Inject the cache service for issue caching.
   */
  public setCacheService(cacheService: import('./PlanningPanelCacheService').PlanningPanelCacheService): void {
    this._cacheService = cacheService;
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
      deleteSyncEnabled: false,  // default false — require explicit opt-in
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
        ? false  // Changed from (raw.setupComplete === true) — require explicit opt-in for ALL users
        : raw.deleteSyncEnabled === true,
      completeSyncEnabled: raw.completeSyncEnabled !== false,  // default true
      excludeBacklog: raw.excludeBacklog !== false,  // default true — exclude backlog issues
      selectedProjectName: raw.selectedProjectName || '',  // normalize missing/undefined to empty string
      ticketSaveLocation: raw.ticketSaveLocation || '',
    };
  }

  async loadConfig(): Promise<LinearConfig | null> {
    try {
      const raw = await GlobalIntegrationConfigService.loadConfig('linear') as (LinearConfig & { projectId?: string }) | null;
      if (!raw) return null;

      // Migration: legacy projectId → includeProjectNames
      if (raw.projectId && (!raw.includeProjectNames || raw.includeProjectNames.length === 0)) {
        try {
          const resolvedName = await this._resolveProjectIdToName(raw.projectId);
          if (resolvedName) {
            console.log(`[LinearSync] Migrating legacy projectId to includeProjectNames: ${resolvedName}`);
            raw.includeProjectNames = [resolvedName];
            delete raw.projectId;
            // Save migrated config
            await GlobalIntegrationConfigService.saveConfig('linear', raw);
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

  public getTeamName(): string {
    return this._config?.teamName || '_unknown';
  }

  public getSelectedProjectName(): string {
    return this._config?.selectedProjectName || '';
  }

  async saveConfig(config: LinearConfig): Promise<void> {
    const normalized = this._normalizeConfig(config);
    if (!normalized) {
      throw new Error('Linear config normalization failed');
    }
    await GlobalIntegrationConfigService.saveConfig('linear', normalized);
    this._config = normalized;
    this._cachedProjects = null;
    this._cachedMembers = null;
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
      url: String(raw?.url || '').trim(),
      parentId: String(raw?.parent?.id || '').trim() || null
    };
  }

  private _normalizeLinearComment(raw: any): LinearComment {
    // Parse Linear mention syntax from body: <@uuid> tokens
    const body = String(raw?.body || '');
    const mentions: Array<{ id: string; name: string }> = [];
    const mentionRegex = /<@([a-f0-9-]+)>/gi;
    let m: RegExpExecArray | null;
    while ((m = mentionRegex.exec(body)) !== null) {
      mentions.push({ id: m[1], name: '' });
    }

    return {
      id: String(raw?.id || '').trim(),
      body,
      user: raw?.user
        ? {
          id: String(raw.user.id || '').trim() || undefined,
          name: String(raw.user.name || '').trim(),
          email: String(raw.user.email || '').trim() || undefined
        }
        : null,
      createdAt: String(raw?.createdAt || '').trim(),
      parentId: raw?.parent?.id ? String(raw.parent.id).trim() : null,
      mentions
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
            parent { id }
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
  public _stripH1Header(markdownContent: string): string {
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
    if (this._cachedProjects) {
      return this._cachedProjects;
    }
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
    const mapped = projects.map((project: any) => ({
      id: String(project?.id || '').trim(),
      name: String(project?.name || '').trim()
    })).filter((project: { id: string; name: string }) => project.id.length > 0 && project.name.length > 0);
    this._cachedProjects = mapped;
    return mapped;
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

  /**
   * Generate a fingerprint for issue filter options to use in cache keys.
   */
  private _fingerprintIssueFilter(options: {
    search?: string;
    stateId?: string;
    assigneeId?: string;
    projectId?: string;
    limit?: number;
    updatedAfter?: string;
  }): string {
    const parts: string[] = [];
    if (options.search) {
      parts.push(`search:${options.search}`);
    }
    if (options.stateId) {
      parts.push(`state:${options.stateId}`);
    }
    if (options.assigneeId) {
      parts.push(`assignee:${options.assigneeId}`);
    }
    if (options.projectId) {
      parts.push(`project:${options.projectId}`);
    }
    if (options.limit !== undefined) {
      parts.push(`limit:${options.limit}`);
    }
    if (options.updatedAfter) {
      parts.push(`updatedAfter:${options.updatedAfter}`);
    }
    return parts.length > 0 ? parts.join('|') : 'default';
  }

  /**
   * Generate a fingerprint for the LinearConfig filter inputs (include/exclude
   * project names and team) so that cache keys do not collide across config
   * changes. Without this, two callers with the same options but different
   * include/exclude lists would share a cache entry and serve cross-config
   * data.
   */
  private _fingerprintLinearFilterConfig(config: LinearConfig): string {
    const inc = (config.includeProjectNames || []).slice().sort().join(',');
    const exc = (config.excludeProjectNames || []).slice().sort().join(',');
    const team = String(config.teamId || '').trim();
    return `inc=${inc}|exc=${exc}|team=${team}`;
  }

  /**
   * Clear the issueId → projectId reverse index. Used by manual cache
   * refresh to avoid stale invalidation hints after the cache is wiped.
   */
  public clearIssueProjectIndex(): void {
    this._issueProjectIndex.clear();
  }

  public async queryIssues(options: {
    search?: string;
    stateId?: string;
    stateName?: string;
    assigneeId?: string;
    projectId?: string;
    limit?: number;
    updatedAfter?: string;
    projectScoped?: boolean;
  }): Promise<LinearIssue[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const normalizedSearch = String(options.search || '').trim().toLowerCase();
    const normalizedStateId = String(options.stateId || '').trim();
    const normalizedStateName = String(options.stateName || '').trim().toLowerCase();
    const normalizedAssigneeId = String(options.assigneeId || '').trim();
    const normalizedProjectId = String(options.projectId || '').trim();
    const requestedLimit = Number(options.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 100)
      : 50;
    const updatedAfter = options.updatedAfter ? String(options.updatedAfter).trim() : '';

    // Determine if this is a "simple" query that can use cache
    // Simple: no search, stateId, stateName, assigneeId, or updatedAfter filters
    // (project comes from config). Delta queries (updatedAfter set) bypass cache.
    const isSimpleQuery = !options.projectScoped && !normalizedSearch && !normalizedStateId && !normalizedStateName && !normalizedAssigneeId && !updatedAfter;
    // Cache key MUST include the filter-config fingerprint so that include/
    // exclude project name changes invalidate the cache via key divergence.
    const configFingerprint = this._fingerprintLinearFilterConfig(config);
    const cacheKey = isSimpleQuery && normalizedProjectId
      ? `project:${normalizedProjectId}:${this._fingerprintIssueFilter(options)}|cfg=${configFingerprint}`
      : `linear:${this._fingerprintIssueFilter(options)}|cfg=${configFingerprint}`;

    // Try cache first for simple queries
    if (isSimpleQuery && this._cacheService) {
      try {
        const cached = this._cacheService.getCachedTasks<LinearIssue>('linear', cacheKey);
        if (cached) {
          return cached;
        }
      } catch (e) {
        // Fail-open: continue to API fetch
        console.warn('[LinearSync] Cache read failed, falling back to API:', e);
      }
    }

    // Resolve project for scoped queries, else hybrid optimization
    let resolvedProjectId: string | undefined = undefined;
    let resolutionFailed = false;
    if (options.projectScoped) {
      if (normalizedProjectId) {
        const projects = await this.getAvailableProjects();
        const byId = projects.find(p => p.id === normalizedProjectId);
        if (byId) {
          resolvedProjectId = byId.id;
        } else {
          const byName = projects.find(p => p.name.toLowerCase() === normalizedProjectId.toLowerCase());
          if (byName) {
            resolvedProjectId = byName.id;
          } else {
            resolutionFailed = true;
          }
        }
      } else {
        resolutionFailed = true;
      }
      if (resolutionFailed) {
        const res = [] as LinearIssue[];
        (res as any).resolutionFailed = true;
        return res;
      }
    } else {
      resolvedProjectId = await this._resolveSingleIncludeProjectId(config) || undefined;
    }

    const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || undefined, updatedAfter || undefined);

    const issues: LinearIssue[] = [];
    let cursor: string | null = null;
    const query = this._buildIssueListQuery();
    let pageCount = 0;
    const maxPages = options.projectScoped ? 40 : 10; // Hard cap to prevent runaway pagination

    while ((options.projectScoped ? true : issues.length < limit) && pageCount < maxPages) {
      const result = await this.graphqlRequest(query, {
        filter,
        after: cursor,
        first: options.projectScoped ? 50 : Math.min(50, limit - issues.length)
      });

      const page = result.data?.issues;
      const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
      for (const node of nodes) {
        const issue = this._normalizeLinearIssue(node);
        if (normalizedStateId && issue.state?.id !== normalizedStateId) {
          continue;
        }
        if (normalizedStateName && String(issue.state?.name || '').toLowerCase() !== normalizedStateName) {
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
        if (!options.projectScoped && issues.length >= limit) {
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
    const filteredIssues = options.projectScoped ? issues : this._applyProjectNameFilters(issues, config);

    // Update cache and reverse map for simple queries
    if (isSimpleQuery && this._cacheService) {
      try {
        this._cacheService.cacheTasks('linear', cacheKey, filteredIssues);
        // Update reverse map: issueId -> projectId
        for (const issue of filteredIssues) {
          if (issue.id && normalizedProjectId) {
            this._issueProjectIndex.set(issue.id, normalizedProjectId);
          }
        }
      } catch (e) {
        // Fail-open: cache errors are non-fatal
        console.warn('[LinearSync] Cache write failed:', e);
      }
    }

    return filteredIssues;
  }

  /**
   * Fetch ALL issue IDs for a project, paginating through the complete set
   * without the 100-issue limit cap that queryIssues enforces. Used by the
   * deletion sweep to get the full remote ID set — a naive queryIssues call
   * with limit:100 would return an incomplete set for projects with >100
   * issues, causing the sweep to delete local files for issues 101+ that
   * still exist remotely (a data-loss bug). Returns only IDs to minimize
   * payload size. Bypasses the cache (the sweep needs current live state,
   * not a potentially stale snapshot).
   */
  public async fetchAllIssueIds(projectId: string): Promise<Set<string>> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }
    const resolvedProjectId = await this._resolveSingleIncludeProjectId(config);
    const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || projectId);

    const ids = new Set<string>();
    let cursor: string | null = null;
    const query = this._buildIssueListQuery();
    let pageCount = 0;
    const maxPages = 50; // Safety cap: 50 pages × 50/page = 2500 issues max

    while (pageCount < maxPages) {
      const result = await this.graphqlRequest(query, {
        filter,
        after: cursor,
        first: 50
      });
      const page = result.data?.issues;
      const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
      for (const node of nodes) {
        if (node.id) ids.add(String(node.id));
      }
      if (!page?.pageInfo?.hasNextPage) break;
      cursor = String(page.pageInfo.endCursor || '').trim() || null;
      if (!cursor) break;
      pageCount++;
      await this.delay(200);
    }
    if (pageCount >= maxPages) {
      console.warn(`[LinearSync] fetchAllIssueIds reached page cap (${maxPages}). Some issues may be omitted.`);
    }
    return ids;
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
            parent { id }
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
              user { id name email }
              parent { id }
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

    // Invalidate cache for the project containing this issue
    if (this._cacheService) {
      const projectId = this._issueProjectIndex.get(normalizedIssueId);
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        // Fallback: invalidate all Linear cache if project unknown
        this._cacheService.invalidateTaskCache('linear');
      }
    }
  }

  public async updateIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear label updates require an issue ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $labelIds: [String!]!) {
        issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
      }
    `, { id: normalizedIssueId, labelIds });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested label update.`);
    }

    // Invalidate cache
    if (this._cacheService) {
      const projectId = this._issueProjectIndex.get(normalizedIssueId);
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        this._cacheService.invalidateTaskCache('linear');
      }
    }
  }

  public async updateIssueParent(issueId: string, parentId: string | null): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear parent updates require an issue ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $parentId: String) {
        issueUpdate(id: $id, input: { parentId: $parentId }) { success }
      }
    `, { id: normalizedIssueId, parentId: parentId || null });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested parent update.`);
    }

    if (this._cacheService) {
      const projectId = this._issueProjectIndex.get(normalizedIssueId);
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        this._cacheService.invalidateTaskCache('linear');
      }
    }
  }

  public async updateIssueProject(issueId: string, projectId: string | null): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear project updates require an issue ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $projectId: String) {
        issueUpdate(id: $id, input: { projectId: $projectId }) { success }
      }
    `, { id: normalizedIssueId, projectId: projectId || null });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the project update.`);
    }

    // Invalidate cache for BOTH the old project and the new project
    if (this._cacheService) {
      const oldProjectId = this._issueProjectIndex.get(normalizedIssueId);
      if (oldProjectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${oldProjectId}`);
      }
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        // If moving to no project, invalidate all Linear cache as fallback
        this._cacheService.invalidateTaskCache('linear');
      }
      // Update the reverse map
      if (projectId) {
        this._issueProjectIndex.set(normalizedIssueId, projectId);
      } else {
        this._issueProjectIndex.delete(normalizedIssueId);
      }
    }
  }

  public async addIssueComment(issueId: string, comment: string, options?: { parentId?: string; mentions?: Array<{ id: string; name: string }> }): Promise<{ success: boolean; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    const normalizedComment = String(comment || '').trim();
    if (!normalizedIssueId || !normalizedComment) {
      throw new Error('Linear comments require both an issue ID and non-empty comment text.');
    }

    // Encode mentions into the body using Linear's <@uuid> syntax.
    // Verification gate: if Linear doesn't parse <@uuid>, the text is still
    // visible (safe fallback — no notification, but readable).
    let body = normalizedComment;
    const mentions = Array.isArray(options?.mentions) ? options!.mentions : [];
    if (mentions.length > 0) {
      for (const mention of mentions) {
        // UI inserts @{id} tokens; replace with <@uuid> for Linear
        body = body.replace(new RegExp(`@\\{${mention.id}\\}`, 'g'), `<@${mention.id}>`);
      }
    }

    const parentId = String(options?.parentId || '').trim() || undefined;
    const inputFields = parentId
      ? 'issueId: $issueId, body: $body, parentId: $parentId'
      : 'issueId: $issueId, body: $body';
    const vars: Record<string, string> = { issueId: normalizedIssueId, body };
    if (parentId) { vars.parentId = parentId; }

    try {
      const result = await this.graphqlRequest(`
        mutation($issueId: String!, $body: String!${parentId ? ', $parentId: String!' : ''}) {
          commentCreate(input: { ${inputFields} }) {
            success
          }
        }
      `, vars);

      if (!result.data?.commentCreate?.success) {
        // If parentId was rejected, retry without it (flat comment fallback)
        if (parentId) {
          console.warn('[LinearSync] Linear commentCreate with parentId failed, retrying as flat comment.');
          const fallbackResult = await this.graphqlRequest(`
            mutation($issueId: String!, $body: String!) {
              commentCreate(input: { issueId: $issueId, body: $body }) { success }
            }
          `, { issueId: normalizedIssueId, body });
          if (!fallbackResult.data?.commentCreate?.success) {
            return { success: false, error: `Linear issue ${normalizedIssueId} rejected the comment.` };
          }
          return { success: true };
        }
        return { success: false, error: `Linear issue ${normalizedIssueId} rejected the comment.` };
      }
      return { success: true };
    } catch (e) {
      // If parentId caused a GraphQL error, retry as flat comment
      if (parentId) {
        console.warn('[LinearSync] Linear commentCreate with parentId threw, retrying as flat comment:', e);
        const fallbackResult = await this.graphqlRequest(`
          mutation($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) { success }
          }
        `, { issueId: normalizedIssueId, body });
        if (!fallbackResult.data?.commentCreate?.success) {
          return { success: false, error: `Linear issue ${normalizedIssueId} rejected the comment.` };
        }
        return { success: true };
      }
      throw e;
    }
  }

  /**
   * §8 — host-side shared comment write-back primitive.
   *
   * Runs in the extension host (which holds the SecretStorage token), stamps the
   * self-marker, and truncates to Linear's comment size limit. Used by triage
   * write-back (§6), agent replies (§7/§9), and the sync-mode question directive
   * (§11). Agents reach it through the LocalApiServer `/comment` route — they never
   * call the provider API directly and never touch the marker, so they cannot break
   * the feedback-loop guard.
   */
  public async postManagedComment(issueId: string, body: string): Promise<{ success: boolean; error?: string }> {
    // Linear has no hard documented comment cap; 64k is a generous safety bound.
    const truncated = truncateForComment(body, 64000);
    const stamped = stampMarker(truncated);
    return this.addIssueComment(issueId, stamped);
  }

  /**
   * §7/§9 — Remote Control poll. Fetch current state + recent comments for a set of
   * synced issues in one batched query. Returns a map keyed by issue UUID. Comments
   * include their author flag so the caller can skip Switchboard's own comments via
   * the marker (the body is returned verbatim; marker filtering happens in the caller).
   */
  public async fetchIssueUpdates(issueIds: string[]): Promise<Record<string, {
    stateId: string;
    stateName: string;
    stateType: string;
    comments: Array<{ id: string; body: string; createdAt: string; author: string }>;
  }>> {
    const result: Record<string, { stateId: string; stateName: string; stateType: string; comments: Array<{ id: string; body: string; createdAt: string; author: string }> }> = {};
    const ids = (issueIds || []).map((s) => String(s || '').trim()).filter(Boolean);
    if (ids.length === 0) { return result; }

    const config = await this.loadConfig();
    if (!config?.setupComplete) { return result; }

    const QUERY = `
      query($ids: [ID!]) {
        issues(filter: { id: { in: $ids } }, first: 100) {
          nodes {
            id
            state { id name type }
            comments(first: 50) { nodes { id body createdAt user { name } } }
          }
        }
      }
    `;
    try {
      const resp = await this.graphqlRequest(QUERY, { ids });
      const nodes = resp?.data?.issues?.nodes || [];
      for (const node of nodes) {
        result[node.id] = {
          stateId: node.state?.id || '',
          stateName: node.state?.name || '',
          stateType: (node.state?.type || '').toLowerCase(),
          comments: (node.comments?.nodes || []).map((c: any) => ({
            id: String(c.id || ''),
            body: String(c.body || ''),
            createdAt: String(c.createdAt || ''),
            author: String(c.user?.name || '')
          }))
        };
      }
    } catch (e) {
      console.warn('[LinearSync] fetchIssueUpdates failed:', e);
    }
    return result;
  }

  // ── Comment Manager: threading + members ──────────────────────────

  /**
   * Fetch comments for an issue and rebuild threads client-side.
   * Linear returns comments flat with optional parent { id }.
   * Replies whose parent isn't in the batch go into an orphan bucket
   * (console.warn) — they are NOT dropped.
   */
  public async getCommentThreads(issueId: string): Promise<{
    threads: Array<{
      id: string;
      author: { id: string; name: string; email: string };
      body: string;
      date: string;
      mentions: Array<{ id: string; name: string }>;
      replies: Array<{
        id: string;
        author: { id: string; name: string; email: string };
        body: string;
        date: string;
        mentions: Array<{ id: string; name: string }>;
      }>;
    }>;
    threadingSupported: boolean;
  }> {
    const comments = await this.getComments(issueId);

    const topLevel = comments.filter(c => !c.parentId);
    const repliesByParent = new Map<string, typeof comments>();
    const orphans: typeof comments = [];

    for (const comment of comments) {
      if (comment.parentId) {
        const hasParent = comments.some(c => c.id === comment.parentId);
        if (hasParent) {
          const bucket = repliesByParent.get(comment.parentId) || [];
          bucket.push(comment);
          repliesByParent.set(comment.parentId, bucket);
        } else {
          console.warn(`[LinearSync] Orphan reply ${comment.id} — parent ${comment.parentId} not in batch.`);
          orphans.push(comment);
        }
      }
    }

    const toThread = (c: typeof comments[0]) => ({
      id: c.id,
      author: {
        id: String(c.user?.id || '').trim(),
        name: String(c.user?.name || '').trim(),
        email: String(c.user?.email || '').trim()
      },
      body: c.body,
      date: c.createdAt,
      mentions: c.mentions || [],
      replies: (repliesByParent.get(c.id) || []).map(r => ({
        id: r.id,
        author: {
          id: String(r.user?.id || '').trim(),
          name: String(r.user?.name || '').trim(),
          email: String(r.user?.email || '').trim()
        },
        body: r.body,
        date: r.createdAt,
        mentions: r.mentions || []
      }))
    });

    const threads = topLevel.map(toThread);
    // Orphans (replies whose parent isn't in this batch) are surfaced as
    // top-level threads so they're visible rather than dropped.
    for (const orphan of orphans) {
      threads.push(toThread(orphan));
    }

    return { threads, threadingSupported: true };
  }

  /**
   * Reply to an existing Linear comment.
   * Uses addIssueComment with parentId — Linear's commentCreate accepts parentId
   * for threaded replies (verification gate — falls back to flat on failure).
   */
  public async replyToComment(commentId: string, params: { commentText: string; mentions?: Array<{ id: string; name: string }> }): Promise<{ success: boolean; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }
    const normalizedCommentId = String(commentId || '').trim();
    if (!normalizedCommentId) { throw new Error('Linear reply requires a comment ID.'); }
    const normalizedComment = String(params?.commentText || '').trim();
    if (!normalizedComment) { throw new Error('Linear reply requires non-empty text.'); }

    // Linear replies are created via commentCreate with parentId.
    // We need the issueId — but replyToComment only has the commentId.
    // Linear's commentCreate requires issueId. We'll fetch the comment's issue
    // via a lightweight query, then call addIssueComment with parentId.
    let issueId: string | undefined;
    try {
      const result = await this.graphqlRequest(`
        query($commentId: String!) {
          comment(id: $commentId) { issue { id } }
        }
      `, { commentId: normalizedCommentId });
      issueId = String(result.data?.comment?.issue?.id || '').trim() || undefined;
    } catch (e) {
      console.warn('[LinearSync] Failed to resolve issueId for comment reply:', e);
    }

    if (!issueId) {
      // Can't determine issueId — post as a flat comment on the issue is not
      // possible without the issueId. Return error so UI can roll back.
      return { success: false, error: 'Could not resolve the issue for this comment reply.' };
    }

    return this.addIssueComment(issueId, normalizedComment, {
      parentId: normalizedCommentId,
      mentions: params.mentions
    });
  }

  /**
   * Fetch team members for the mention picker.
   * Uses the team's users query. Cached with 5-minute TTL.
   */
  public async getTeamMembers(): Promise<Array<{ id: string; name: string; email: string }>> {
    if (this._cachedMembers && (Date.now() - this._cachedMembers.fetchedAt) < LinearSyncService.MEMBERS_TTL_MS) {
      return this._cachedMembers.data;
    }

    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    try {
      const result = await this.graphqlRequest(`
        query($teamId: String!) {
          team(id: $teamId) {
            members {
              nodes {
                id
                name
                email
              }
            }
          }
        }
      `, { teamId: config.teamId });

      const members = Array.isArray(result.data?.team?.members?.nodes)
        ? result.data.team.members.nodes.map((m: any) => ({
            id: String(m?.id || '').trim(),
            name: String(m?.name || '').trim(),
            email: String(m?.email || '').trim()
          })).filter((m: { id: string }) => m.id.length > 0)
        : [];
      this._cachedMembers = { data: members, fetchedAt: Date.now() };
      return members;
    } catch (e) {
      console.warn('[LinearSync] Failed to fetch team members:', e);
      return [];
    }
  }

  public async uploadAttachment(issueId: string, buffer: Buffer, fileName: string): Promise<{ url: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    // 1. Request upload URL
    const uploadRequestResult = await this.graphqlRequest(`
      mutation($filename: String!, $contentType: String!, $size: Int!) {
        fileUpload(filename: $filename, contentType: $contentType, size: $size) {
          uploadPageResponse {
            headers { key value }
            uploadUrl
          }
          assetUrl
        }
      }
    `, {
      filename: fileName,
      contentType: 'application/octet-stream',
      size: buffer.length
    });

    const uploadData = uploadRequestResult.data?.fileUpload;
    if (!uploadData?.uploadPageResponse) {
      throw new Error('Failed to request Linear upload URL');
    }

    const { uploadUrl, headers } = uploadData.uploadPageResponse;
    const assetUrl = uploadData.assetUrl;

    // 2. Upload file
    await new Promise((resolve, reject) => {
      const parsedUrl = new URL(uploadUrl);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': buffer.length
        }
      };

      // Add custom headers from Linear
      if (Array.isArray(headers)) {
        for (const { key, value } of headers) {
          (options.headers as any)[key] = value;
        }
      }

      const req = https.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          let raw = '';
          res.on('data', chunk => raw += chunk);
          res.on('end', () => reject(new Error(`File upload failed with status ${res.statusCode}: ${raw}`)));
        }
      });

      req.on('error', reject);
      req.write(buffer);
      req.end();
    });

    // 3. Create attachment
    const attachmentCreateResult = await this.graphqlRequest(`
      mutation($issueId: String!, $url: String!, $title: String!) {
        attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) {
          success
          attachment { id url }
        }
      }
    `, {
      issueId,
      url: assetUrl,
      title: fileName
    });

    if (!attachmentCreateResult.data?.attachmentCreate?.success) {
      throw new Error('Failed to create Linear attachment link');
    }

    return { url: assetUrl };
  }

  public async updateIssueDescription(issueId: string, description: string, title?: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    const normalizedDescription = String(description || '').trim();
    if (!normalizedIssueId || !normalizedDescription) {
      throw new Error('Linear description updates require both an issue ID and non-empty content.');
    }
    const normalizedTitle = title ? String(title).trim() : '';

    const result = await this.graphqlRequest(`
      mutation($id: String!, $description: String!${normalizedTitle ? ', $title: String!' : ''}) {
        issueUpdate(id: $id, input: { description: $description${normalizedTitle ? ', title: $title' : ''} }) { success }
      }
    `, { id: normalizedIssueId, description: normalizedDescription, ...(normalizedTitle ? { title: normalizedTitle } : {}) });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested description update.`);
    }

    // Invalidate cache for the project containing this issue
    if (this._cacheService) {
      const projectId = this._issueProjectIndex.get(normalizedIssueId);
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        // Fallback: invalidate all Linear cache if project unknown
        this._cacheService.invalidateTaskCache('linear');
      }
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
      // Use the dedicated issueArchive mutation (idempotent on already-archived
      // issues). The prior issueUpdate(input:{archivedAt}) form fails on
      // archived issues (they become read-only) and is the wrong API for this
      // operation.
      const result = await this.graphqlRequest(`
        mutation($id: String!) {
          issueArchive(id: $id) {
            success
          }
        }
      `, {
        id: normalizedIssueId
      });

      if (result.data?.issueArchive?.success) {
        console.log(`[LinearSync] Archived Linear issue ${normalizedIssueId}`);
        return { success: true };
      } else {
        return { success: false, error: `Linear issue ${normalizedIssueId} rejected the archive request.` };
      }
    } catch (error) {
      return { success: false, error: `Failed to archive Linear issue: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Unarchive a Linear issue. Archived issues are read-only — `issueUpdate`
   * fails on them. To push late content edits to an archived issue, unarchive
   * first, push, then re-archive. Uses the dedicated `issueUnarchive` mutation.
   */
  async unarchiveIssue(issueId: string): Promise<{ success: boolean; error?: string }> {
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
        mutation($id: String!) {
          issueUnarchive(id: $id) {
            success
          }
        }
      `, {
        id: normalizedIssueId
      });

      if (result.data?.issueUnarchive?.success) {
        console.log(`[LinearSync] Unarchived Linear issue ${normalizedIssueId}`);
        return { success: true };
      } else {
        return { success: false, error: `Linear issue ${normalizedIssueId} rejected the unarchive request.` };
      }
    } catch (error) {
      return { success: false, error: `Failed to unarchive Linear issue: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // ── Local Sync Map (planFile → Linear issueId) ──────────────

  async loadSyncMap(): Promise<Record<string, string>> {
    const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
    return db.getAllLinearIssueLinks();
  }

  async saveSyncMap(map: Record<string, string>): Promise<void> {
    const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
    // Full replace, not upsert: callers delete temp `creating_*` markers from
    // the map and those deletions must reach the table.
    await db.replaceAllLinearIssueLinks(map);
  }

  async getIssueIdForPlan(planFile: string): Promise<string | null> {
    const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
    const link = await db.getLinearIssueLinkByPlan(planFile);
    return link ? link.issueId : null;
  }

  async setIssueIdForPlan(planFile: string, issueId: string): Promise<void> {
    const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
    await db.setLinearIssueLink(issueId, planFile);
  }

  // ── Token Management ─────────────────────────────────────────

  async getApiToken(): Promise<string | null> {
    try {
      return await this._secretStorage.get('switchboard.linear.apiToken') || null;
    } catch { return null; }
  }

  async hasApiToken(): Promise<boolean> {
    if (this._tokenPresentCache !== null) { return this._tokenPresentCache; }
    const token = await this.getApiToken();
    this._tokenPresentCache = !!token;
    return this._tokenPresentCache;
  }

  clearApiTokenCache(): void {
    this._tokenPresentCache = null;
  }

  // ── GraphQL Client ───────────────────────────────────────────

  /**
   * Generic GraphQL request wrapper for LocalApiServer proxy.
   */
  async makeGraphQLRequest(query: string, variables?: Record<string, unknown>): Promise<any> {
    const result = await this.graphqlRequest(query, variables);
    return result;
  }

  /**
   * Resolve an issue title or identifier to its ID.
   */
  async resolveNameToId(name: string): Promise<string | null> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedName = name.trim().toLowerCase();

    // 1. Check if it's an identifier (e.g., LIN-123)
    if (this._isIssueIdentifier(name)) {
      const issue = await this.getIssue(name);
      return issue ? issue.id : null;
    }

    // 2. Search for issues by title
    const issues = await this.queryIssues({ search: name });
    if (issues.length > 0) {
      const exactMatch = issues.find(i => i.title.toLowerCase() === normalizedName);
      return exactMatch ? exactMatch.id : issues[0].id;
    }

    return null;
  }

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
            const status = res.statusCode ?? 0;
            const err: any = new Error(localizeHttpError(status, 'linear', 'fetch from Linear'));
            err.statusCode = status;
            return safeReject(err);
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
        this._tokenPresentCache = true;
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
      config.deleteSyncEnabled = options.deleteSyncEnabled === true;
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

  async syncPlan(plan: { planFile: string; topic: string; complexity: string }, newColumn: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) { return; }
    if (!(await this.hasApiToken())) { return; }

    const stateId = config.columnToStateId[newColumn];
    if (!stateId) {
      console.warn(`[LinearSync] No Linear state mapped for column "${newColumn}" - skipping sync for plan ${plan.planFile}`);
      return;
    } // column not mapped

    // §4 — completeSyncEnabled gate. When the user disables "sync completed status",
    // automatic DONE/COMPLETED/ARCHIVED transitions are NOT pushed to Linear.
    // Manual dispatch (updateIssueState) is intentionally left untouched.
    const terminalColumn = ['DONE', 'COMPLETED', 'ARCHIVED'].includes((newColumn || '').toUpperCase());
    if (config.completeSyncEnabled === false && terminalColumn) {
      console.log(`[LinearSync] completeSyncEnabled is off — skipping ${newColumn} sync for plan ${plan.planFile}`);
      return;
    }

    const existingIssueId = await this.getIssueIdForPlan(plan.planFile);
    const priority = this._complexityToPriority(plan.complexity);

    try {
      if (existingIssueId) {
        console.log(`[LinearSync] Updating existing Linear issue ${existingIssueId} for plan ${plan.planFile} to state ${stateId}`);
        const result = await this.retry(() => this.graphqlRequest(`
          mutation($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
          }
        `, { id: existingIssueId, stateId }));

        if (!result.data.issueUpdate.success) {
          console.warn(`[LinearSync] Issue update failed for ${existingIssueId}, attempting to recreate`);
          await this.createIssue(plan, stateId, priority, config);
        } else {
          console.log(`[LinearSync] Successfully updated Linear issue ${existingIssueId} for plan ${plan.planFile}`);
        }
      } else {
        await this.createIssue(plan, stateId, priority, config);
      }
    } catch (error) {
      console.warn(`[LinearSync] Failed to sync plan ${plan.planFile}:`, error);
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
      if (!(await this.hasApiToken())) {
        return { success: false, error: 'Linear API token not configured' };
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

  /**
   * Internal implementation for creating a Linear issue.
   * Public to match ClickUpSyncService.createTask().
   */
  public async createIssue(
    plan: { planFile: string; topic: string },
    stateId: string,
    priority: number,
    config: LinearConfig
  ): Promise<void> {
    console.log(`[LinearSync] Creating Linear issue for plan ${plan.planFile} with title "${plan.topic}"`);
    const description = await this._buildInitialIssueDescription(plan.planFile);

    // Pre-mark in sync map BEFORE GraphQL call to prevent automation race condition.
    // Marker format: `creating_${planFile}_${timestamp}`. The timestamp is used by the
    // stale-marker sweep in importIssuesFromLinear to age out abandoned markers.
    const tempMarker = `creating_${plan.planFile}_${Date.now()}`;
    await this.setIssueIdForPlan(plan.planFile, tempMarker);

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
        
        if (description) {
          try {
            const resolvedPlanPath = path.isAbsolute(plan.planFile)
              ? plan.planFile
              : path.join(this._workspaceRoot, plan.planFile);
            const { rewritten } = await hostInlineImages(
              (fileName, buffer) => this.uploadAttachment(issueId, buffer, fileName),
              description,
              resolvedPlanPath
            );
            if (rewritten !== description) {
              await this.updateIssueDescription(issueId, rewritten);
            }
          } catch (hostErr) {
            console.warn(`[LinearSync] Created Linear issue ${issueId}, but inline image hosting failed:`, hostErr);
          }
        }

        // Overwrite the temp marker with the real issue ID — this is the race-free handoff.
        await this.setIssueIdForPlan(plan.planFile, issueId);
        issueCreated = true;
        const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
        const ready = await db.ensureReady();
        if (!ready) {
          throw new Error(`Kanban database unavailable while linking Linear issue ${issueId} to plan ${plan.planFile}.`);
        }
        const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
        const persisted = await db.updateLinearIssueIdByPlanFile(plan.planFile, workspaceId, issueId);
        if (!persisted) {
          throw new Error(`Failed to persist Linear issue ${issueId} for plan ${plan.planFile}.`);
        }
        console.log(`[LinearSync] Created Linear issue ${identifier} (ID: ${issueId}) for plan ${plan.planFile}`);
      } else {
        console.error(`[LinearSync] Failed to create Linear issue for plan ${plan.planFile}`);
        throw new Error(`Failed to create Linear issue for plan ${plan.planFile}.`);
      }
    } finally {
      // Guaranteed cleanup: if the temp marker is still present (we never replaced it
      // with the real issue ID), remove it. Covers success-that-failed-to-link,
      // GraphQL mutation returning success=false, and retry() exhaustion throws.
      if (!issueCreated) {
        try {
          const map = await this.loadSyncMap();
          if (map[plan.planFile] === tempMarker) {
            delete map[plan.planFile];
            await this.saveSyncMap(map);
          }
        } catch (cleanupErr) {
          console.warn(`[LinearSync] Failed to clean up temp marker for ${plan.planFile}:`, cleanupErr);
        }
      }
    }
  }

  public async createIssueSimple(params: {
    title: string;
    description?: string;
    projectId?: string;
    stateId?: string;
    parentId?: string;
  }): Promise<{ id: string; identifier: string }> {
    const config = await this.loadConfig();
    if (!config || !config.setupComplete || !config.teamId) {
      throw new Error("Linear integration not configured. Complete setup in the Setup panel first.");
    }
    const result = await this.retry(() => this.graphqlRequest(`
      mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
          }
        }
      }
    `, {
      input: {
        teamId: config.teamId,
        title: params.title,
        description: params.description || '',
        labelIds: config.switchboardLabelId ? [config.switchboardLabelId] : [],
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.stateId ? { stateId: params.stateId } : {}),
        ...(params.parentId ? { parentId: params.parentId } : {})
      }
    }));

    if (result.data?.issueCreate?.success) {
      const issueId = result.data.issueCreate.issue.id;
      const identifier = result.data.issueCreate.issue.identifier;
      if (params.description) {
        try {
          const { rewritten } = await hostInlineImages(
            (fileName, buffer) => this.uploadAttachment(issueId, buffer, fileName),
            params.description
          );
          if (rewritten !== params.description) {
            await this.updateIssueDescription(issueId, rewritten);
          }
        } catch (hostErr) {
          console.warn(`[LinearSync] Created issue ${issueId}, but inline image hosting failed:`, hostErr);
        }
      }
      return {
        id: issueId,
        identifier
      };
    } else {
      throw new Error("Failed to create Linear issue.");
    }
  }

  // ── Debounced Sync ───────────────────────────────────────────

  debouncedSync(planFile: string, plan: any, column: string): void {
    const existing = this._debounceTimers.get(planFile);
    if (existing) { clearTimeout(existing); }
    this._debounceTimers.set(planFile, setTimeout(async () => {
      this._debounceTimers.delete(planFile);
      try {
        await this.syncPlan(plan, column);
        this._consecutiveFailures = 0;
      } catch (error) {
        console.error(`[LinearSync] Failed to sync plan ${planFile} to column ${column}:`, error);
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

  /**
   * Two-pass import: parent issues with children ALWAYS become Switchboard features
   * (written to .switchboard/features/), children are linked via direct DB writes
   * (feature_id). Deeply nested hierarchies are flattened to one level. The GraphQL
   * query fetches the full hierarchy recursively (5 levels deep). Insert-before-
   * write ordering prevents the child-planId race (watcher would mint a random
   * planId if it fires between file write and DB insert).
   */
  async importIssuesFromLinear(plansDir: string): Promise<{ success: boolean; imported: number; skipped: number; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      return { success: false, imported: 0, skipped: 0, error: 'Linear not set up' };
    }

    try {
      // --- Stale marker sweep (TTL = 60s) ------------------------------------
      // A `creating_${planFile}_${timestamp}` marker older than 60s is assumed
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

      // Plans with a live (non-stale) creating_* marker. An inbound issue
      // whose title matches one of these plans is our own outbound create
      // still in flight — skip it to avoid a duplicate.
      const planFilesBeingCreated = new Set<string>(
        Object.entries(syncMap)
          .filter(([, v]) => typeof v === 'string' && v.startsWith('creating_'))
          .map(([pf]) => pf)
      );

      // Resolve DB handle + workspaceId once for the scoped title fallback.
      const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
      const ready = await db.ensureReady();
      const workspaceId = ready ? (await db.getWorkspaceId()) || '' : '';

      const allIssues: any[] = [];
      let cursor: string | null = null;

      const resolvedProjectId = await this._resolveSingleIncludeProjectId(config);
      const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || undefined);

      // Recursive GraphQL query: fetches the full hierarchy 5 levels deep.
      // Each level nests children { nodes { ... children { nodes { ... } } } }.
      // Comments/attachments/project/cycle are only on top-level issues to keep
      // the query size manageable. Children at all levels get core fields + parent.
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
              children { nodes {
                id identifier title description url priority
                state { name type }
                assignee { name email }
                labels { nodes { name } }
                dueDate createdAt estimate
                parent { id }
                children { nodes {
                  id identifier title description url priority
                  state { name type }
                  assignee { name email }
                  labels { nodes { name } }
                  dueDate createdAt estimate
                  parent { id }
                  children { nodes {
                    id identifier title description url priority
                    state { name type }
                    assignee { name email }
                    labels { nodes { name } }
                    dueDate createdAt estimate
                    parent { id }
                    children { nodes {
                      id identifier title description url priority
                      state { name type }
                      assignee { name email }
                      labels { nodes { name } }
                      dueDate createdAt estimate
                      parent { id }
                    } }
                  } }
                } }
              } }
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

      // Recursively flatten: top-level issues + all their descendants (any depth).
      const allTasks: any[] = [];
      const seenIds = new Set<string>();
      const collectIssue = (issue: any) => {
        if (!issue || seenIds.has(issue.id)) { return; }
        seenIds.add(issue.id);
        allTasks.push(issue);
        if (issue.children?.nodes) {
          for (const child of issue.children.nodes) {
            collectIssue(child);
          }
        }
      };
      for (const issue of filteredIssues) {
        collectIssue(issue);
      }

      const issueNameById = new Map<string, string>(allTasks.map((t: any) => [t.id, `${t.title} (${t.identifier})`]));

      await fs.promises.mkdir(plansDir, { recursive: true });
      const featureDir = path.join(this._workspaceRoot, '.switchboard', 'features');
      await fs.promises.mkdir(featureDir, { recursive: true });
      let imported = 0;
      let skipped = 0;

      // ── Pass 0: Filter ──────────────────────────────────────────
      // Run all dedup/filter checks. Collect survivors into filteredTasks.
      const filteredTasks: any[] = [];

      for (const issue of allTasks) {
        if (syncMapIssueIds.has(issue.id)) { skipped++; continue; }

        // Scoped title fallback: only suppress if a local session is actively
        // being created AND its topic matches this issue's title. Global title
        // matching is explicitly avoided to prevent silent import loss.
        if (planFilesBeingCreated.size > 0 && ready && workspaceId) {
          const localPlan = await db.getPlanByTopic(issue.title || '', workspaceId);
          if (localPlan && planFilesBeingCreated.has(localPlan.planFile)) {
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

        // Issue survived all filters — collect it.
        filteredTasks.push(issue);
      }

      // ── Group: Build parent/child maps from filtered tasks ──────
      const tasksById = new Map<string, any>(filteredTasks.map((t: any) => [t.id, t]));
      const childrenByParentId = new Map<string, any[]>();
      for (const task of filteredTasks) {
        const parentId = task.parent?.id;
        if (parentId && tasksById.has(parentId)) {
          if (!childrenByParentId.has(parentId)) {
            childrenByParentId.set(parentId, []);
          }
          childrenByParentId.get(parentId)!.push(task);
        }
      }

      // A top-level parent has children in the batch AND no in-batch parent.
      // An intermediate parent has children AND an in-batch parent — it's a subtask, not an feature.
      const isParent = (taskId: string) => childrenByParentId.has(taskId);
      const isChild = (task: any) => {
        const parentId = task.parent?.id;
        return !!parentId && tasksById.has(parentId);
      };
      const isTopLevelParent = (task: any) => isParent(task.id) && !isChild(task);

      // ── Pass 1: Insert DB records + write files (insert BEFORE write) ──
      // Insert-before-write ordering prevents the child-planId race: if the
      // watcher fires between file write and DB insert, ON CONFLICT preserves
      // the import's planId (not the watcher's random one).
      const uuidByIssueId = new Map<string, string>();

      for (const issue of filteredTasks) {
        const stateType = (issue.state?.type || '').toLowerCase();
        const kanbanColumn = stateType === 'backlog' ? 'BACKLOG' : 'CREATED';
        const priority = ['', 'urgent', 'high', 'normal', 'low'][issue.priority] || '';
        const dueDate = issue.dueDate || '';
        const assignee = issue.assignee ? (issue.assignee.name || issue.assignee.email) : '';
        const labels = (issue.labels?.nodes || []).map((l: any) => l.name).filter((n: string) => n !== 'switchboard').join(', ');
        const description = (issue.description || '').trim();
        const parentRef = issue.parent?.id ? (issueNameById.get(issue.parent.id) || issue.parent.id) : '';

        const metaLines = [
          `> Imported from Linear issue \`${issue.identifier}\``,
          `> **Linear Issue ID:** ${issue.id}`,
          issue.url         ? `> **URL:** ${issue.url}`              : '',
          parentRef         ? `> **Parent Issue:** ${parentRef}`     : '',
          priority          ? `> **Priority:** ${priority}`          : '',
          dueDate           ? `> **Due:** ${dueDate}`                : '',
          assignee          ? `> **Assignee:** ${assignee}`          : '',
          labels            ? `> **Tags:** ${labels}`                : '',
          issue.state?.name ? `> **State:** ${issue.state.name}`    : '',
        ].filter(Boolean).join('\n');

        // §2 — capture comments and attachments (top-level issues only).
        const COMMENT_CAP = 20;
        const COMMENT_CHAR_CAP = 2000;
        const commentNodes = (issue.comments?.nodes || []).slice(-COMMENT_CAP);
        const commentsSection = commentNodes.length
          ? '\n## Comments\n\n' + commentNodes.map((c: any) => {
              const author = c.user?.name || 'Unknown';
              const when = c.createdAt || '';
              let body = String(c.body || '').trim();
              if (body.length > COMMENT_CHAR_CAP) {
                body = body.slice(0, COMMENT_CHAR_CAP) + ' *[truncated]*';
              }
              return `**${author}**${when ? ` — ${when}` : ''}\n\n${body}`;
            }).join('\n\n---\n\n') + '\n'
          : '';

        const attachmentNodes = (issue.attachments?.nodes || []).filter((a: any) => a?.url);
        const attachmentsSection = attachmentNodes.length
          ? '\n## Attachments\n\n' + attachmentNodes.map((a: any) =>
              `- [${a.title || a.url}](${a.url})`
            ).join('\n') + '\n'
          : '';

        const stub = [
          `# ${issue.title || `Linear Issue ${issue.identifier}`}`,
          '',
          `kanbanColumn: ${kanbanColumn}`,
          '',
          metaLines,
          '',
          description || '',
          commentsSection,
          attachmentsSection,
        ].join('\n');

        if (isTopLevelParent(issue)) {
          // Top-level parent → feature: insert DB, mark feature, persist linear_issue_id,
          // THEN write to .switchboard/features/ (insert-before-write).
          const uuid = crypto.randomUUID();
          uuidByIssueId.set(issue.id, uuid);
          const featurePlanFile = path.join('.switchboard', 'features', `linear_import_${issue.id}_${uuid}.md`);

          if (ready && workspaceId) {
            try {
              await db.insertFileDerivedPlan({
                planId: uuid,
                sessionId: '',
                topic: issue.title || `Linear Issue ${issue.identifier}`,
                planFile: featurePlanFile,
                kanbanColumn,
                status: 'active' as any,
                complexity: 'Unknown',
                tags: '',
                repoScope: '',
                workspaceId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastAction: '',
                sourceType: 'linear-import',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: '',
                isFeature: 1,
                featureId: ''
              } as any);
              await db.updateFeatureStatus(uuid, 1, '');
              await db.updateLinearIssueIdByPlanFile(featurePlanFile, workspaceId, issue.id);
            } catch (dbErr) {
              console.warn(`[LinearSync] import: DB insert failed for feature ${issue.id}, file will be written (watcher will ingest):`, dbErr);
            }
          }

          const featurePath = path.join(this._workspaceRoot, featurePlanFile);
          await fs.promises.writeFile(featurePath, stub, 'utf8');
          imported++;
        } else if (isChild(issue)) {
          // Child (including intermediate parents) → subtask: insert DB, persist
          // linear_issue_id, THEN write to .switchboard/plans/ (insert-before-write).
          const childUuid = crypto.randomUUID();
          uuidByIssueId.set(issue.id, childUuid);
          const childPlanFile = path.join(plansDir, `linear_import_${issue.id}.md`);
          const childRelPath = path.relative(this._workspaceRoot, childPlanFile);

          // Add Feature Plan ID metadata line for debugging (if parent UUID is known).
          const parentIssueId = issue.parent?.id;
          const parentUuid = parentIssueId ? uuidByIssueId.get(parentIssueId) || '' : '';
          const childStub = parentUuid
            ? stub.replace(metaLines, `${metaLines}\n> **Feature Plan ID:** ${parentUuid}`)
            : stub;

          if (ready && workspaceId) {
            try {
              await db.insertFileDerivedPlan({
                planId: childUuid,
                sessionId: '',
                topic: issue.title || `Linear Issue ${issue.identifier}`,
                planFile: childRelPath,
                kanbanColumn,
                status: 'active' as any,
                complexity: 'Unknown',
                tags: '',
                repoScope: '',
                workspaceId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastAction: '',
                sourceType: 'linear-import',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: ''
              } as any);
              await db.updateLinearIssueIdByPlanFile(childRelPath, workspaceId, issue.id);
            } catch (dbErr) {
              console.warn(`[LinearSync] import: DB insert failed for child ${issue.id}, file will be written (watcher will ingest):`, dbErr);
            }
          }

          await fs.promises.writeFile(childPlanFile, childStub, 'utf8');
          imported++;
        } else {
          // Standalone: write file only (same as today — watcher ingests).
          const planFile = path.join(plansDir, `linear_import_${issue.id}.md`);
          await fs.promises.writeFile(planFile, stub, 'utf8');
          imported++;
        }
      }

      // ── Pass 2: Link children to top-level parents (flatten) ────
      // For each child, walk up the parentId chain to find the top-level
      // in-batch parent (a task that has no in-batch parent itself). Link
      // the child to that feature's planId via updateFeatureStatus.
      if (ready) {
        for (const issue of filteredTasks) {
          if (!isChild(issue)) { continue; }
          const childUuid = uuidByIssueId.get(issue.id);
          if (!childUuid) { continue; }

          // Walk up the parent chain to find the top-level parent.
          const visited = new Set<string>();
          let currentIssueId: string | null = issue.id;
          let topParentIssueId: string | null = null;

          while (currentIssueId) {
            if (visited.has(currentIssueId)) {
              console.warn(`[LinearSync] import: cycle detected in parentId chain at ${currentIssueId}, treating as standalone`);
              break;
            }
            visited.add(currentIssueId);

            const currentIssue = tasksById.get(currentIssueId);
            if (!currentIssue) { break; }

            const currentParentId = currentIssue.parent?.id;
            if (!currentParentId || !tasksById.has(currentParentId)) {
              // Current issue has no in-batch parent — it's the top-level parent.
              if (isParent(currentIssueId)) {
                topParentIssueId = currentIssueId;
              }
              break;
            }
            currentIssueId = currentParentId;
          }

          if (topParentIssueId) {
            const topParentUuid = uuidByIssueId.get(topParentIssueId);
            if (topParentUuid) {
              try {
                await db.updateFeatureStatus(childUuid, 0, topParentUuid);
              } catch (linkErr) {
                console.warn(`[LinearSync] import: failed to link child ${issue.id} to feature ${topParentIssueId}:`, linkErr);
              }
            }
          }
        }
      }

      return { success: true, imported, skipped };
    } catch (error) {
      return { success: false, imported: 0, skipped: 0, error: `Import failed: ${error}` };
    }
  }

  // ── Feature Outbound Sync ───────────────────────────────────────

  /**
   * Sync a Switchboard feature + its subtasks to Linear as a parent issue with
   * child issues linked via parentId. Creates/updates the feature issue first
   * (await, not debounce), then links each subtask's existing Linear issue
   * as a child. Subtasks without an existing Linear issue are skipped (added
   * to `failed`) — they will be linked on a future feature-sync trigger once
   * their individual sync creates an issue.
   */
  public async syncFeatureWithSubtasks(params: {
    featurePlanFile: string;
    featureTopic: string;
    featureColumn: string;
    subtasks: Array<{ planFile: string; topic: string; complexity: string }>;
  }): Promise<{ featureIssueId?: string; linked: string[]; failed: string[] }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || config.realTimeSyncEnabled !== true) {
      return { linked: [], failed: params.subtasks.map(s => s.planFile) };
    }
    if (!(await this.hasApiToken())) {
      return { linked: [], failed: params.subtasks.map(s => s.planFile) };
    }

    const linked: string[] = [];
    const failed: string[] = [];
    let featureIssueId: string | null = null;

    try {
      // 1. Create/update the feature issue first (await, bypass debounce).
      await this.syncPlan(
        { planFile: params.featurePlanFile, topic: params.featureTopic, complexity: 'Unknown' },
        params.featureColumn
      );

      // 2. Look up the feature's issue ID. If still a creating_* temp marker, retry once.
      featureIssueId = await this.getIssueIdForPlan(params.featurePlanFile);
      if (featureIssueId && featureIssueId.startsWith('creating_')) {
        await new Promise(resolve => setTimeout(resolve, 200));
        featureIssueId = await this.getIssueIdForPlan(params.featurePlanFile);
      }
      if (!featureIssueId || featureIssueId.startsWith('creating_')) {
        console.warn(`[LinearSync] syncFeatureWithSubtasks: feature issue ID not resolved for ${params.featurePlanFile} — all subtasks failed`);
        return { linked: [], failed: params.subtasks.map(s => s.planFile) };
      }

      // 3. Link each subtask's existing Linear issue as a child of the feature.
      for (const sub of params.subtasks) {
        try {
          const subIssueId = await this.getIssueIdForPlan(sub.planFile);
          if (subIssueId && !subIssueId.startsWith('creating_')) {
            await this.updateIssueParent(subIssueId, featureIssueId);
            linked.push(sub.planFile);
          } else {
            failed.push(sub.planFile);
          }
        } catch (linkErr) {
          console.warn(`[LinearSync] syncFeatureWithSubtasks: failed to link subtask ${sub.planFile}:`, linkErr);
          failed.push(sub.planFile);
        }
      }
    } catch (featureErr) {
      console.warn(`[LinearSync] syncFeatureWithSubtasks: feature sync failed:`, featureErr);
      return { linked: [], failed: params.subtasks.map(s => s.planFile) };
    }

    return { featureIssueId: featureIssueId ?? undefined, linked, failed };
  }

  /**
   * Unlink subtasks from their feature in Linear — set each subtask's parent to null.
   * Used when a subtask is removed from an feature or reassigned.
   */
  public async unlinkSubtasksFromFeature(subtaskPlanFiles: string[]): Promise<{ unlinked: string[]; failed: string[] }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || config.realTimeSyncEnabled !== true) {
      return { unlinked: [], failed: subtaskPlanFiles };
    }
    if (!(await this.hasApiToken())) {
      return { unlinked: [], failed: subtaskPlanFiles };
    }

    const unlinked: string[] = [];
    const failed: string[] = [];

    for (const planFile of subtaskPlanFiles) {
      try {
        const issueId = await this.getIssueIdForPlan(planFile);
        if (issueId && !issueId.startsWith('creating_')) {
          await this.updateIssueParent(issueId, null);
          unlinked.push(planFile);
        } else {
          // No external issue — nothing to unlink. Not a failure.
          unlinked.push(planFile);
        }
      } catch (err) {
        console.warn(`[LinearSync] unlinkSubtasksFromFeature: failed for ${planFile}:`, err);
        failed.push(planFile);
      }
    }

    return { unlinked, failed };
  }
}
