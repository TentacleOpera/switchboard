import * as vscode from 'vscode';

export function showTemporaryNotification(message: string, durationMs: number = 2500): void {
    void vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: message,
            cancellable: false
        },
        async () => {
            await new Promise(resolve => setTimeout(resolve, durationMs));
        }
    );
}
