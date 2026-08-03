(function () {
    const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;

    let ticketsWorkspaceRoot = '';
    let selectedTicketId = null;
    let selectedTicketProvider = null;

    function getTicketsTabElements() {
        return {
            listView: document.getElementById('tree-pane-tickets'),
            previewPane: document.getElementById('preview-pane-tickets'),
            emptyPreview: document.getElementById('tickets-empty-preview'),
            searchInput: document.getElementById('tickets-search'),
            workspaceFilter: document.getElementById('tickets-workspace-filter'),
            workspaceLabel: document.getElementById('tickets-workspace-label')
        };
    }

    function initTicketsTab() {
        if (typeof initOverflowMenus === 'function') {
            initOverflowMenus();
        }
        const searchInput = document.getElementById('tickets-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const query = e.target.value.toLowerCase();
                // Filter ticket nodes
            });
        }
    }

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message) return;
        switch (message.type) {
            case 'workspaceRootChanged':
                ticketsWorkspaceRoot = message.workspaceRoot || '';
                break;
            case 'rootsFetched':
                if (message.items && typeof populateWorkspaceDropdown === 'function') {
                    populateWorkspaceDropdown('tickets-workspace-filter', message.items, ticketsWorkspaceRoot);
                }
                break;
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTicketsTab);
    } else {
        initTicketsTab();
    }
})();
