/** Fixed renderer documents are the only documents allowed to receive desktop capabilities. */
export const RENDERER_ENTRY_ARGUMENT = '--aervox-renderer-entry='

function documentUrl(value: string): string | null {
    try {
        const url = new URL(value)
        if (!['file:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
        url.search = ''
        url.hash = ''
        return url.href
    } catch {
        return null
    }
}

/** Queries select UI surfaces; hashes and reloads do not change the trusted document. */
export function rendererEntryMatches(candidate: string, entry: string): boolean {
    const expected = documentUrl(entry)
    return expected !== null && documentUrl(candidate) === expected
}

export function rendererEntryArgument(entry: string): string {
    if (!documentUrl(entry)) throw new Error('invalid desktop renderer entry')
    return `${RENDERER_ENTRY_ARGUMENT}${encodeURIComponent(entry)}`
}

/** The sandbox preload receives its entry from BrowserWindow, never from page content. */
export function trustedPreloadEntry(argv: readonly string[], locationUrl: string, isMainFrame: boolean): boolean {
    if (!isMainFrame) return false
    const entries = argv.filter(value => value.startsWith(RENDERER_ENTRY_ARGUMENT))
    if (entries.length !== 1) return false
    try {
        return rendererEntryMatches(locationUrl, decodeURIComponent(entries[0].slice(RENDERER_ENTRY_ARGUMENT.length)))
    } catch {
        return false
    }
}
