import { CustomAgentConfig } from './agentConfig';

export type KanbanDerivedColumn = 'CREATED' | 'PLAN REVIEWED' | 'CODED' | 'CODE REVIEWED' | string;

type WorkflowEvent = {
    workflow?: string | null;
};

const { deriveKanbanColumn: deriveKanbanColumnImpl } = require('./kanbanColumnDerivation.js') as {
    deriveKanbanColumn: (events?: WorkflowEvent[], customAgents?: CustomAgentConfig[]) => KanbanDerivedColumn;
};

export const deriveKanbanColumn = deriveKanbanColumnImpl;
