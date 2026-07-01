export type ErrorProvider = 'clickup' | 'linear';

export function localizeHttpError(status: number, provider: ErrorProvider, action: string): string {
    const setupHint = provider === 'clickup'
        ? 'Update it in the Setup tab (get a new token at app.clickup.com/settings → Apps).'
        : 'Update it in the Setup tab (get a new token at linear.app/settings/api).';
    switch (status) {
        case 401:
            return `${provider === 'clickup' ? 'ClickUp' : 'Linear'} API token is invalid or expired. ${setupHint}`;
        case 403:
            return `${provider === 'clickup' ? 'ClickUp' : 'Linear'} rejected the request: your token lacks permission to ${action}.`;
        case 404:
            return `This ticket no longer exists on ${provider === 'clickup' ? 'ClickUp' : 'Linear'}. It may have been deleted.`;
        case 429:
            return `${provider === 'clickup' ? 'ClickUp' : 'Linear'} rate limit reached — wait a moment and try again.`;
        case 500: case 502: case 503: case 504:
            return `${provider === 'clickup' ? 'ClickUp' : 'Linear'} server error (HTTP ${status}) — try again in a moment.`;
        case 0:
            return `Network error — could not reach ${provider === 'clickup' ? 'ClickUp' : 'Linear'}. Check your internet connection.`;
        default:
            return `Could not ${action} (HTTP ${status}).`;
    }
}

/** Classify a status code for webview contextualization. */
export function classifyHttpError(status: number): 'deleted' | 'auth' | 'transient' | 'generic' {
    if (status === 404) return 'deleted';
    if (status === 401 || status === 403) return 'auth';
    if (status === 429 || status === 0 || status >= 500) return 'transient';
    return 'generic';
}
