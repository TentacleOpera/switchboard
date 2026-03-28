import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export type ReviewPlanContext = {
    sessionId?: string;
    topic?: string;
    planFileAbsolute: string;
    workspaceRoot?: string;
    initialMode?: 'edit' | 'review';
};

export type ReviewCommentRequest = {
    sessionId?: string;
    topic?: string;
    planFileAbsolute: string;
    selectedText: string;
    comment: string;
};

export type ReviewCommentResult = {
    ok: boolean;
    message: string;
    targetAgent?: string;
    preferredRole?: string;
};

export type ReviewTicketColumnOption = {
    id: string;
    label: string;
};

export type ReviewTicketLogEntry = {
    timestamp: string;
    workflow: string;
    details: string;
};

export type ReviewOpenPlanOption = {
    sessionId: string;
    topic: string;
    column: string;
    planFileAbsolute: string;
};

export type ReviewTicketData = {
    sessionId?: string;
    topic: string;
    planFileAbsolute: string;
    column: string;
    isCompleted: boolean;
    complexity: 'Unknown' | 'Low' | 'High';
    dependencies: string[];
    planText: string;
    renderedHtml?: string;
    planMtimeMs: number;
    actionLog: ReviewTicketLogEntry[];
    columns: ReviewTicketColumnOption[];
    canEditMetadata: boolean;
};

export type ReviewTicketUpdateRequest = {
    type: 'setColumn' | 'setComplexity' | 'setDependencies' | 'setTopic' | 'savePlanText';
    sessionId?: string;
    column?: string;
    complexity?: 'Unknown' | 'Low' | 'High';
    dependencies?: string[];
    topic?: string;
    content?: string;
    expectedMtimeMs?: number;
};

export type ReviewTicketUpdateResult = {
    ok: boolean;
    message: string;
    data?: ReviewTicketData;
};

/**
 * Provides a dedicated Review webview panel for contextual comments on plan markdown.
 */
export class ReviewProvider implements vscode.Disposable {
    private _panel?: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _currentPlan?: ReviewPlanContext;
    private _lastSelection: { selectedText: string; selectionRect?: { top: number; left: number; width: number; height: number } } | undefined;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public dispose(): void {
        this._panel?.dispose();
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables = [];
    }

    public reveal(): void {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
        }
    }

    public async open(plan: ReviewPlanContext): Promise<void> {
        this._currentPlan = plan;

        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            await this._renderCurrentPlan();
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-review',
            'Plan Review',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._extensionUri]
            }
        );

        this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
        this._panel.webview.html = await this._getHtml(this._panel.webview);

        this._panel.webview.onDidReceiveMessage(
            async (msg) => this._handleMessage(msg),
            undefined,
            this._disposables
        );

        this._panel.onDidDispose(() => {
            this._panel = undefined;
            this._lastSelection = undefined;
        }, null, this._disposables);

        await this._renderCurrentPlan();
    }

    private async _handleMessage(msg: any): Promise<void> {
        if (!this._panel) return;

        switch (msg?.type) {
            case 'ready':
                await this._renderCurrentPlan();
                break;
            case 'planShown': {
                // Sync the sidebar selection with the plan currently being viewed
                const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId.trim() : '';
                if (sessionId) {
                    vscode.commands.executeCommand('switchboard.selectSession', sessionId);
                }
                break;
            }
            case 'selectionChanged': {
                if (typeof msg?.selectedText === 'string' && msg.selectedText.trim().length > 0) {
                    this._lastSelection = {
                        selectedText: msg.selectedText,
                        selectionRect: msg.selectionRect
                    };
                } else {
                    this._lastSelection = undefined;
                }
                break;
            }
            case 'setColumn':
            case 'setComplexity':
            case 'setDependencies':
            case 'setTopic':
            case 'savePlanText':
                await this._applyTicketUpdate(msg as ReviewTicketUpdateRequest);
                break;
            case 'submitComment': {
                try {
                    if (!this._currentPlan) {
                        throw new Error('No plan loaded in review panel.');
                    }

                    const selectedText = typeof msg?.selectedText === 'string'
                        ? msg.selectedText.trim()
                        : (this._lastSelection?.selectedText || '').trim();
                    const comment = typeof msg?.comment === 'string' ? msg.comment.trim() : '';

                    if (!selectedText) {
                        throw new Error('Please select text before submitting a comment.');
                    }
                    if (!comment) {
                        throw new Error('Please enter a comment before submitting.');
                    }

                    const request: ReviewCommentRequest = {
                        sessionId: this._currentPlan.sessionId,
                        topic: this._currentPlan.topic,
                        planFileAbsolute: this._currentPlan.planFileAbsolute,
                        selectedText,
                        comment
                    };

                    const result = await vscode.commands.executeCommand<ReviewCommentResult>(
                        'switchboard.sendReviewComment',
                        request
                    );

                    const normalizedResult: ReviewCommentResult = result && typeof result.ok === 'boolean'
                        ? result
                        : { ok: false, message: 'Review comment dispatch failed (no response).' };

                    this._panel.webview.postMessage({ type: 'commentResult', ...normalizedResult });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this._panel.webview.postMessage({ type: 'commentResult', ok: false, message });
                }
                break;
            }
            case 'copyPlanLink': {
                try {
                    if (!this._currentPlan?.planFileAbsolute) {
                        throw new Error('No plan loaded in review panel.');
                    }
                    await vscode.env.clipboard.writeText(this._currentPlan.planFileAbsolute);
                    this._panel.webview.postMessage({ type: 'copyPlanLinkResult', ok: true, message: 'Plan path copied.' });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this._panel.webview.postMessage({ type: 'copyPlanLinkResult', ok: false, message });
                }
                break;
            }
            case 'getOpenPlans': {
                try {
                    if (!this._currentPlan?.sessionId) {
                        this._panel.webview.postMessage({ type: 'openPlansData', plans: [] });
                        break;
                    }
                    const plans = await vscode.commands.executeCommand<ReviewOpenPlanOption[]>(
                        'switchboard.getReviewOpenPlans',
                        this._currentPlan.sessionId
                    );
                    this._panel.webview.postMessage({ type: 'openPlansData', plans: Array.isArray(plans) ? plans : [] });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this._panel.webview.postMessage({ type: 'openPlansData', plans: [], error: message });
                }
                break;
            }
            // NOTE: UI button removed from review.html; handler retained for API compatibility
            case 'sendToAgent': {
                try {
                    if (!this._currentPlan?.sessionId) {
                        throw new Error('This ticket is not associated with a session.');
                    }
                    const result = await vscode.commands.executeCommand<{ ok: boolean; message: string }>(
                        'switchboard.reviewSendToAgent',
                        this._currentPlan.sessionId
                    );
                    if (!result?.ok) {
                        throw new Error(result?.message || 'Failed to send plan to the next agent.');
                    }
                    await this._renderCurrentPlan();
                    this._panel.webview.postMessage({ type: 'ticketActionResult', ok: true, message: result.message });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this._panel.webview.postMessage({ type: 'ticketActionResult', ok: false, message });
                }
                break;
            }
            case 'completePlan': {
                try {
                    if (!this._currentPlan?.sessionId) {
                        throw new Error('This ticket is not associated with a session.');
                    }
                    const ok = await vscode.commands.executeCommand<boolean>(
                        'switchboard.completePlanFromKanban',
                        this._currentPlan.sessionId,
                        this._currentPlan.workspaceRoot
                    );
                    if (!ok) {
                        throw new Error('Failed to complete plan.');
                    }
                    vscode.window.showInformationMessage('Plan completed.');
                    this._panel.dispose();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this._panel.webview.postMessage({ type: 'ticketActionResult', ok: false, message });
                }
                break;
            }
            case 'deletePlan': {
                try {
                    if (!this._currentPlan?.sessionId) {
                        throw new Error('This ticket is not associated with a session.');
                    }
                    const ok = await vscode.commands.executeCommand<boolean>(
                        'switchboard.deletePlanFromReview',
                        this._currentPlan.sessionId,
                        this._currentPlan.workspaceRoot
                    );
                    if (ok) {
                        vscode.window.showInformationMessage('Plan deleted.');
                        this._panel.dispose();
                    } else {
                        // User cancelled the confirmation dialog — just reset the UI
                        this._panel.webview.postMessage({ type: 'ticketActionResult', ok: true, message: '' });
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this._panel.webview.postMessage({ type: 'ticketActionResult', ok: false, message });
                }
                break;
            }
        }
    }

    private async _renderCurrentPlan(): Promise<void> {
        if (!this._panel || !this._currentPlan) return;

        const ticketData = await this._loadCurrentTicketData();
        await this._renderTicketData(ticketData);
    }

    private async _loadCurrentTicketData(): Promise<ReviewTicketData> {
        if (!this._currentPlan) {
            throw new Error('No plan loaded in review panel.');
        }

        if (this._currentPlan.sessionId) {
            const data = await vscode.commands.executeCommand<ReviewTicketData>(
                'switchboard.getReviewTicketData',
                this._currentPlan.sessionId
            );
            if (!data) {
                throw new Error('Failed to load ticket data.');
            }
            return data;
        }

        const planText = await fs.promises.readFile(this._currentPlan.planFileAbsolute, 'utf8');
        const stats = await fs.promises.stat(this._currentPlan.planFileAbsolute);
        
        // Render markdown
        const renderedHtml = await vscode.commands.executeCommand<string>('markdown.api.render', planText) || '';

        return {
            sessionId: this._currentPlan.sessionId,
            topic: this._currentPlan.topic?.trim() || path.basename(this._currentPlan.planFileAbsolute),
            planFileAbsolute: this._currentPlan.planFileAbsolute,
            column: '',
            isCompleted: false,
            complexity: 'Unknown',
            dependencies: [],
            planText,
            renderedHtml,
            planMtimeMs: stats.mtimeMs,
            actionLog: [],
            columns: [],
            canEditMetadata: false
        };
    }

    private async _renderTicketData(ticketData: ReviewTicketData): Promise<void> {
        if (!this._panel || !this._currentPlan) return;

        this._currentPlan = {
            ...this._currentPlan,
            sessionId: ticketData.sessionId || this._currentPlan.sessionId,
            topic: ticketData.topic,
            planFileAbsolute: ticketData.planFileAbsolute
        };

        if (ticketData.planText && !ticketData.renderedHtml) {
            try {
                ticketData.renderedHtml = await vscode.commands.executeCommand<string>('markdown.api.render', ticketData.planText) || '';
            } catch (e) {
                ticketData.renderedHtml = `<pre>${ticketData.planText}</pre>`;
            }
        }

        const title = ticketData.topic?.trim() || path.basename(ticketData.planFileAbsolute);
        this._panel.title = `Ticket: ${title}`;
        this._panel.webview.postMessage({
            type: 'ticketData',
            ...ticketData,
            initialMode: this._currentPlan.initialMode
        });
        this._currentPlan.initialMode = undefined;
    }

    private async _applyTicketUpdate(msg: ReviewTicketUpdateRequest): Promise<void> {
        if (!this._panel || !this._currentPlan) return;

        try {
            if (msg.type === 'savePlanText' && !this._currentPlan.sessionId) {
                const content = typeof msg.content === 'string' ? msg.content : '';
                const expectedMtimeMs = Number(msg.expectedMtimeMs);
                const currentStats = await fs.promises.stat(this._currentPlan.planFileAbsolute);
                if (Number.isFinite(expectedMtimeMs) && Math.abs(currentStats.mtimeMs - expectedMtimeMs) > 1) {
                    throw new Error('Plan file changed on disk since this ticket was opened. Reload the ticket and try again.');
                }
                await fs.promises.writeFile(this._currentPlan.planFileAbsolute, content, 'utf8');
                const ticketData = await this._loadCurrentTicketData();
                await this._renderTicketData(ticketData);
                this._panel.webview.postMessage({ type: 'ticketUpdateResult', ok: true, message: 'Plan saved.' });
                return;
            }

            if (!this._currentPlan.sessionId) {
                throw new Error('Ticket metadata is only available for session-backed plans.');
            }

            const result = await vscode.commands.executeCommand<ReviewTicketUpdateResult>(
                'switchboard.updateReviewTicket',
                {
                    ...msg,
                    sessionId: this._currentPlan.sessionId
                } as ReviewTicketUpdateRequest
            );

            const normalizedResult: ReviewTicketUpdateResult = result && typeof result.ok === 'boolean'
                ? result
                : { ok: false, message: 'Ticket update failed (no response).' };

            if (!normalizedResult.ok || !normalizedResult.data) {
                this._panel.webview.postMessage({
                    type: 'ticketUpdateResult',
                    ok: false,
                    message: normalizedResult.message || 'Ticket update failed.'
                });
                return;
            }

            await this._renderTicketData(normalizedResult.data);
            this._panel.webview.postMessage({
                type: 'ticketUpdateResult',
                ok: true,
                message: normalizedResult.message || 'Ticket updated.'
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this._panel.webview.postMessage({ type: 'ticketUpdateResult', ok: false, message });
        }
    }

    private async _getHtml(webview: vscode.Webview): Promise<string> {
        const paths = [
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'review.html'),
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'review.html'),
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'review.html')
        ];

        let htmlUri: vscode.Uri | undefined;
        for (const candidate of paths) {
            try {
                await vscode.workspace.fs.stat(candidate);
                htmlUri = candidate;
                break;
            } catch {
                // Continue to next candidate.
            }
        }

        if (!htmlUri) {
            return `<html><body style="padding:20px;font-family:sans-serif;">Review webview HTML not found.</body></html>`;
        }

        const contentBuffer = await vscode.workspace.fs.readFile(htmlUri);
        let content = Buffer.from(contentBuffer).toString('utf8');

        const nonce = crypto.randomBytes(16).toString('base64');
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">`;
        content = content.replace('<head>', `<head>\n    ${csp}`);
        content = content.replace(/<script>/g, `<script nonce="${nonce}">`);

        return content;
    }
}
