import * as vscode from 'vscode';

/**
 * Disposes a restored webview panel without firing any handlers on it,
 * then invokes the provider's creation callback targeting the restored panel's view column.
 * This guarantees every revived panel has retainContextWhenHidden set at creation time.
 */
export async function reviveWithRetention(
    restoredPanel: vscode.WebviewPanel,
    openFn: (column?: vscode.ViewColumn) => Promise<void>
): Promise<void> {
    const targetColumn = restoredPanel.viewColumn ?? vscode.ViewColumn.One;
    // Dispose the restored panel cleanly without attaching listeners to it.
    restoredPanel.dispose();
    // Delegate to the provider's creation path with the target column.
    await openFn(targetColumn);
}
