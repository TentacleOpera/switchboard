import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
       files: [
               'out/test/pair-programming-*.test.js',
               'out/services/__tests__/KanbanProvider.test.js',
               'out/test/kanban-complexity.test.js',
               'out/test/kanban-dropdown-workspaces.test.js',
       ],
});
