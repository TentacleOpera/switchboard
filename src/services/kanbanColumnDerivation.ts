import { CustomAgentConfig } from './agentConfig';

export type KanbanDerivedColumn = 'CREATED' | 'PLAN REVIEWED' | 'LEAD CODED' | 'CODER CODED' | 'INTERN CODED' | 'CODE REVIEWED' | 'CODED' | string;

type WorkflowEvent = {
    workflow?: string | null;
};

const { deriveKanbanColumn: deriveKanbanColumnImpl } = require('./kanbanColumnDerivationImpl.js') as {
    deriveKanbanColumn: (events?: WorkflowEvent[], customAgents?: CustomAgentConfig[]) => KanbanDerivedColumn;
};

export const deriveKanbanColumn = deriveKanbanColumnImpl;
