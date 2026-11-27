/**
 * Shared Content-Security-Policy injection for the Web and Desktop renderers.
 *
 * Both apps bundle every script they run (Vue, Element Plus, Pixi, Live2D Core), so
 * `script-src 'self'` is the whole allowlist. The plugin is build-only
 * (`apply: 'build'`): the Vite dev server needs its HMR websocket and inline
 * bootstrap, and a policy that silently breaks HMR is worse than none.
 *
 * `'wasm-unsafe-eval'` is required because Live2D Cubism Core instantiates
 * WebAssembly while loading. It does not grant `new Function`, which is why the
 * renderers install `@pixi/unsafe-eval` (Pixi 7 otherwise compiles uniform
 * synchronizers with `new Function`). Mobile already ships this exact combination;
 * see apps/mobile/android/.../NativeAssetPolicy.java.
 *
 * `'unsafe-inline'` stays on `style-src` only: Vue scoped styles and Element Plus
 * inject style elements at runtime, and style injection cannot execute script.
 *
 * Deliberately dependency-free (like vendor-chunks.ts): this file is imported by
 * both Vite configs but must not drag a Vite version into the root workspace.
 */

export interface CspOptions {
    /**
     * Desktop renderers load from `file://`, where `'self'` does not reliably cover
     * every resource type. Listing the scheme explicitly keeps local assets loading
     * without loosening anything a network page can reach.
     */
    allowFileScheme?: boolean
    /** Extra `connect-src` origins, e.g. the API base a split deployment fetches. */
    extraConnect?: string[]
    /** Extra `frame-src` origins, e.g. plugin Pages served from another origin. */
    extraFrame?: string[]
}

/**
 * The API is a loopback single-user instance on an arbitrary port (see the
 * api-client default `http://127.0.0.1:3000`). The port is not knowable at build
 * time, so the policy pins the loopback hosts rather than the exact origin.
 * Anything off-loopback stays blocked, which is the boundary that actually matters.
 *
 * IPv6 literals are omitted on purpose: Chromium rejects `http://[::1]:*` as an
 * invalid source and drops the whole directive, which is silently looser than
 * intended. The API is not bound to a v6 literal in the supported deployment.
 */
export const LOOPBACK_ORIGINS: readonly string[] = Object.freeze([
    'http://127.0.0.1:*',
    'http://localhost:*',
])

const unique = (values: readonly string[]): string =>
    [...new Set(values.map(value => value.trim()).filter(Boolean))].join(' ')

export function buildCsp(options: CspOptions = {}): string {
    const fileScheme = options.allowFileScheme ? ' file:' : ''
    const directives: Array<[string, string]> = [
        ['default-src', "'none'"],
        ['script-src', `'self' 'wasm-unsafe-eval'${fileScheme}`],
        ['style-src', "'self' 'unsafe-inline'"],
        ['img-src', `'self' data: blob:${fileScheme}`],
        ['media-src', `'self' data: blob:${fileScheme}`],
        ['font-src', `'self' data:${fileScheme}`],
        ['connect-src', unique(["'self'", ...(options.extraConnect ?? []), ...(options.allowFileScheme ? ['file:'] : [])])],
        ['frame-src', unique(["'self'", ...(options.extraFrame ?? []), ...(options.extraConnect ?? [])])],
        ['worker-src', "'self'"],
        ['object-src', "'none'"],
        ['base-uri', "'none'"],
        ['form-action', "'none'"],
    ]
    return directives.map(([name, value]) => `${name} ${value}`).join('; ')
}

/** Structural Vite plugin shape; keeps this module free of a Vite dependency. */
export interface HtmlTransformPlugin {
    readonly name: string
    readonly apply: 'build'
    transformIndexHtml(html: string): string
}

/** Injects the policy as the first child of `<head>` so it precedes every script tag. */
export function cspMetaPlugin(options: CspOptions = {}): HtmlTransformPlugin {
    const tag = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(options)}">`
    return {
        name: 'aervox-csp-meta',
        apply: 'build',
        transformIndexHtml: (html: string) => html.replace(/<head>/i, `<head>\n    ${tag}`),
    }
}
