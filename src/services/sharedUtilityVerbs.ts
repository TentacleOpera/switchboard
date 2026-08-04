import * as fs from 'fs';
import * as path from 'path';
import { HostSeams } from './hostSeams';

/**
 * Verb arms shared by PlanningPanelProvider and TicketsPanelProvider.
 *
 * These five verbs are genuinely SHARED, not moved. The ticket UI needs them
 * (copy ticket link, open ticket in browser, live markdown preview in the edit
 * pane, the Diagram button, the Linear automation catalog) and Planning's DOCS
 * and HTML tabs need them too, so neither side can give them up. Three of the
 * five already appear in more than one verb set (`openExternalUrl` in PLANNING
 * and TASKVIEWER, `renderMarkdownLive` in PLANNING and DESIGN,
 * `linearLoadAutomationCatalog` in PLANNING and TASKVIEWER), so a verb name in
 * two sets is an established, accepted pattern here — it is only a defect when
 * the two implementations would disagree.
 *
 * Which is exactly why these live in one module rather than being copied into
 * the second provider: duplicating them would create two divergent copies of
 * clipboard, external-URL and markdown-render logic, the same defect class the
 * shared-helper lift earlier in this feature exists to close.
 *
 * `TICKETS_VERBS` and `PLANNING_VERBS` are generated from each provider's
 * `switch` arms, so both providers must still carry an arm per verb — the arm
 * is a one-line delegation into this module.
 */
export interface SharedUtilityVerbDeps {
    /** The provider's host seams bundle (clipboard, ui, commands). */
    seams(): HostSeams;
    /**
     * The provider's workspace-root resolution, including its fallback rules.
     * Returns null or undefined when nothing resolves; the two providers differ
     * on which, so both are accepted.
     */
    resolveWorkspaceRoot(given?: string): string | null | undefined;
    /**
     * The provider's own push. Each provider pushes to its own surface, so this
     * must be the provider's method rather than a surface string — passing
     * Planning's push here would deliver ticket updates to the planning surface.
     */
    push(message: any): void;
    /** Prefix-scan lookup for a ticket file; both providers implement it. */
    findTicketFilePath(root: string, provider: string, id: string): Promise<string | null>;
    /** Rewrites relative image paths in ticket markdown to webview URIs. */
    rewriteLocalImagePaths(content: string, dir: string): string;
    /** Ticket document directories for a provider. */
    getTicketDocumentDirs(root: string, provider: any): string[];
    /** Linear sync service factory. */
    getLinearSyncService(root: string): any;
    /** Last-resort root when `resolveWorkspaceRoot` yields nothing. */
    fallbackWorkspaceRoot?: string;
}

export async function handleOpenExternalUrl(
    deps: SharedUtilityVerbDeps,
    msg: any
): Promise<{ success: boolean; error?: string }> {
    const url = msg.url as string;
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
        deps.seams().ui.openExternal(url);
        return { success: true };
    }
    return { success: false, error: 'Only http:// and https:// URLs may be opened externally.' };
}

export async function handleCopyDiagramPrompt(
    deps: SharedUtilityVerbDeps,
    msg: any
): Promise<{ success: boolean; error?: string }> {
    try {
        const { prompt } = msg;
        if (typeof prompt !== 'string' || !prompt.trim()) {
            deps.seams().ui.showErrorMessage('Diagram prompt is empty.');
            return { success: false, error: 'Diagram prompt is empty.' };
        }
        await deps.seams().clipboard.writeText(prompt);
        deps.seams().ui.showTemporaryNotification('Diagram prompt copied to clipboard');
        return { success: true };
    } catch (err) {
        const error = `Failed to copy diagram prompt: ${String(err)}`;
        deps.seams().ui.showErrorMessage(error);
        return { success: false, error };
    }
}

export async function handleRenderMarkdownLive(
    deps: SharedUtilityVerbDeps,
    msg: any
): Promise<any> {
    try {
        let content = msg.content || '';
        // Tickets edit-preview: resolve the ticket file's directory and rewrite
        // relative image paths to webview URIs (mirrors the view-mode path).
        // Non-ticket editor mounts send no provider/id → no rewrite.
        if (msg.provider && msg.id) {
            const wsRoot = deps.resolveWorkspaceRoot(msg.workspaceRoot) || deps.fallbackWorkspaceRoot || '';
            const ticketFilePath = wsRoot ? await deps.findTicketFilePath(wsRoot, msg.provider, msg.id) : null;
            if (ticketFilePath) {
                content = deps.rewriteLocalImagePaths(content, path.dirname(ticketFilePath));
            }
        }
        const html = await deps.seams().commands.executeCommand<string>('markdown.api.render', content);
        const okRes = {
            type: 'markdownLiveRendered',
            requestId: msg.requestId,
            html: html,
            htmlContent: html
        };
        deps.push(okRes);
        return { ...okRes, success: true };
    } catch (err) {
        const errRes = {
            type: 'markdownLiveRendered',
            requestId: msg.requestId,
            html: '',
            htmlContent: '',
            error: String(err)
        };
        deps.push(errRes);
        return { ...errRes, success: false };
    }
}

export async function handleCopyToClipboard(
    deps: SharedUtilityVerbDeps,
    msg: any
): Promise<{ success: boolean; count?: number; error?: string }> {
    const workspaceRoot = deps.resolveWorkspaceRoot(msg.workspaceRoot);
    const provider = msg.provider;
    const paths: string[] = [];
    const missingIds: string[] = [];
    if (workspaceRoot) {
        if (Array.isArray(msg.ticketIds) && msg.ticketIds.length > 0) {
            const providerDir = provider === 'clickup' ? 'clickup' : 'linear';
            for (const id of msg.ticketIds) {
                if (typeof id === 'string' && id && !id.includes('/') && !id.includes('\\') && !id.includes('..')) {
                    // Local-file-only lookup: "Link all"/"Link to ticket" copies paths
                    // for tickets already imported. It does NOT make API calls — the
                    // import happens during the sidebar load (importAllTickets document
                    // mode). Missing tickets are reported so the user can Refetch.
                    // Ticket files are named `${provider}_${id}_<slug>.md` and live in
                    // nested hierarchies (team/project/sprint), so resolve the real path
                    // by prefix scan rather than reconstructing a flat path.
                    const filePath = await deps.findTicketFilePath(workspaceRoot, providerDir, id);
                    if (filePath) {
                        paths.push(filePath);
                    } else {
                        missingIds.push(id);
                    }
                }
            }
        } else {
            for (const dir of deps.getTicketDocumentDirs(workspaceRoot, provider)) {
                if (!fs.existsSync(dir)) { continue; }
                paths.push(dir);
            }
        }
    }
    if (Array.isArray(msg.ticketIds) && msg.ticketIds.length > 0) {
        if (paths.length === 0) {
            const error = missingIds.length > 0
                ? `No local files found for ${missingIds.length} ticket(s). Click "Refetch" to import them first.`
                : 'Could not locate local files for these tickets.';
            deps.push({ type: 'ticketLinkFailed', error });
            return { success: false, error };
        }
        await deps.seams().clipboard.writeText(paths.join('\n'));
        deps.push({
            type: 'ticketLinkCopied',
            count: paths.length,
            requestedCount: msg.ticketIds.length,
            missingCount: missingIds.length
        });
        return { success: true, count: paths.length };
    }
    await deps.seams().clipboard.writeText(paths.join('\n'));
    return { success: true, count: paths.length };
}

export async function handleLinearLoadAutomationCatalog(
    deps: SharedUtilityVerbDeps,
    msg: any
): Promise<any> {
    const workspaceRoot = deps.resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { return { success: false, error: 'No workspace folder found' }; }
    try {
        const linear = deps.getLinearSyncService(workspaceRoot);
        const catalog = await linear.getAutomationCatalog();
        const res = {
            type: 'linearAutomationCatalogLoaded',
            labels: catalog.labels,
            states: catalog.states,
            workspaceRoot
        };
        deps.push(res);
        return { ...res, success: true };
    } catch (error) {
        const res = {
            type: 'linearError',
            scope: 'task',
            error: error instanceof Error ? error.message : String(error),
            workspaceRoot
        };
        deps.push(res);
        return { ...res, success: false };
    }
}
