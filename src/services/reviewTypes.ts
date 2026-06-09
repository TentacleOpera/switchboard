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
    complexity: string;
    planText: string;
    renderedHtml?: string;
    planMtimeMs: number;
    actionLog: ReviewTicketLogEntry[];
    columns: ReviewTicketColumnOption[];
    canEditMetadata: boolean;
};

export type ReviewTicketUpdateRequest = {
    type: 'setColumn' | 'setComplexity' | 'setTopic' | 'savePlanText';
    sessionId?: string;
    column?: string;
    complexity?: string;
    topic?: string;
    content?: string;
    expectedMtimeMs?: number;
};

export type ReviewTicketUpdateResult = {
    ok: boolean;
    message: string;
    data?: ReviewTicketData;
};
