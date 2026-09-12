import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Structural subset of the public `@zvec/zvec-grep` API that this plugin consumes.
 *
 * The engine is an optional dependency, so neither the runtime bundle nor the published
 * declarations may reference it. These declarations are mirrored from
 * `@zvec/zvec-grep/dist/engine/service/types.d.ts` and deliberately describe only what this
 * plugin reads.
 */
export type ZvecItemRange =
  | { kind: 'text'; startLine: number; endLine: number }
  | { kind: 'page' | 'page_text'; page: number }
  | { kind: 'file' | 'byte' | 'page_region' }

export interface ZvecContextItem {
  file: { relativePath: string }
  range: ZvecItemRange
  excerptRange?: ZvecItemRange
  content: string
  status: 'fresh' | 'possibly_stale'
  matchedBy: string | readonly string[]
  score?: number
}

export interface ZvecContextResult {
  query: string
  root: string
  source: 'index' | 'rg'
  coverage: 'ranked_sample' | 'rg_exhaustive' | 'rg_truncated'
  items: ZvecContextItem[]
}

export interface ZvecIndexOptions {
  root?: string
  changedPaths?: readonly string[]
  signal?: AbortSignal
}

export interface ZvecContextOptions {
  query?: string
  limit?: number
  root?: string
  autoUpdate?: boolean
}

export interface ZvecEngineOptions {
  root: string
  embedding: string
  device: 'auto' | 'cpu' | 'metal' | 'vulkan' | 'cuda'
}

export interface SearchEngine {
  index(options?: ZvecIndexOptions): Promise<unknown>
  context(options: ZvecContextOptions): Promise<ZvecContextResult>
  close(): Promise<void>
}

/** The engine package surface this plugin resolves, without depending on the package itself. */
export interface ZvecGrepModule {
  createZvecGrep(options: ZvecEngineOptions): Promise<SearchEngine>
}

/** Default `engineModule` value: install the engine as an ordinary dependency. */
export const DEFAULT_ENGINE_MODULE = '@zvec/zvec-grep'

/** Mirrors `optionalDependencies` in package.json; asserted by tests/package-metadata.test.ts. */
export const ENGINE_RANGE = '^0.2.1'

export const ENGINE_INSTALL_COMMAND = 'npm install -g @zvec/zvec-grep'

/** How long a failed resolution is reused before another probe is allowed. */
export const ENGINE_RETRY_INTERVAL_MS = 30_000

export class EngineUnavailableError extends Error {
  constructor(readonly attempts: readonly string[]) {
    super([
      'dsh-zvec-grep: the optional zvec-grep engine is not installed, so semantic search is unavailable.',
      `Run: ${ENGINE_INSTALL_COMMAND}`,
      'Then call zvec_search again. Do not retry zvec_search before the engine is installed.',
      `If the engine is installed elsewhere, point the plugin option "engineModule" at its entry file, for example: ${DEFAULT_ENGINE_MODULE}`,
      ...(attempts.length === 0 ? [] : [`Failed attempts: ${attempts.join('; ')}`]),
    ].join('\n'))
    this.name = 'EngineUnavailableError'
  }
}

export interface EngineLoaderOptions {
  /** Plugin option `engineModule`: a bare specifier, a path, or a `file:` URL. */
  specifier: string
  retryIntervalMs?: number
  importModule?: (specifier: string) => Promise<unknown>
  /** Resolves the global npm root. Cached for the lifetime of the loader. */
  readGlobalRoot?: () => Promise<string | undefined>
  onWarning?: (message: string) => void
  now?: () => number
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>

type EngineFactory = (options: ZvecEngineOptions) => unknown

interface Candidate {
  label: string
  specifier: string
  version?: string
}

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/
const NPM_ROOT_TIMEOUT_MS = 10_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True for anything the plugin should treat as a filesystem location rather than a package name. */
export function isPathLike(specifier: string): boolean {
  return specifier.startsWith('.')
    || specifier.startsWith('/')
    || specifier.startsWith('\\')
    || specifier.startsWith('file:')
    || WINDOWS_DRIVE.test(specifier)
}

function pickCondition(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const picked = pickCondition(item)
      if (picked !== undefined) return picked
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const conditions = value as Record<string, unknown>
  for (const key of ['import', 'module', 'default', 'require', 'node']) {
    const picked = pickCondition(conditions[key])
    if (picked !== undefined) return picked
  }
  return undefined
}

/** Reads a package directory's declared entry point and version, mirroring Node's ESM conditions. */
async function readPackageEntry(directory: string): Promise<{ url: string; version?: string } | undefined> {
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
  const exports = manifest.exports
  const root = exports !== null && typeof exports === 'object' && !Array.isArray(exports)
    ? (exports as Record<string, unknown>)['.'] ?? exports
    : exports
  const entry = pickCondition(root) ?? (typeof manifest.main === 'string' ? manifest.main : undefined)
  if (entry === undefined) return undefined
  return {
    url: pathToFileURL(resolve(directory, entry)).href,
    ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
  }
}

/** Extracts the install directory of a package specifier inside a node_modules root. */
export function packageDirectory(root: string, specifier: string): string | undefined {
  const [first, second] = specifier.split('/')
  if (first === undefined || first === '') return undefined
  if (!first.startsWith('@')) return join(root, first)
  if (second === undefined || second === '') return undefined
  return join(root, first, second)
}

/** Resolves the global npm root once, walking past any wrapper banner lines npm may print. */
export async function readGlobalNpmRoot(run: CommandRunner): Promise<string | undefined> {
  try {
    const output = await run('npm', ['root', '-g'])
    const lines = output.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
    return lines.at(-1)
  } catch {
    return undefined
  }
}

function defaultRunner(command: string, args: readonly string[]): Promise<string> {
  // Windows resolves `npm` through npm.cmd, which Node refuses to spawn without a shell. Calling
  // cmd.exe explicitly keeps `shell` off and never concatenates caller-provided text.
  const windows = process.platform === 'win32'
  const file = windows ? process.env.ComSpec ?? 'cmd.exe' : command
  const argv = windows ? ['/d', '/c', command, ...args] : [...args]
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(file, argv, {
      windowsHide: true,
      timeout: NPM_ROOT_TIMEOUT_MS,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (error) {
        rejectOutput(error)
        return
      }
      resolveOutput(String(stdout))
    })
  })
}

function engineFactory(module: unknown): EngineFactory | undefined {
  if (module === null || typeof module !== 'object') return undefined
  const namespace = module as Record<string, unknown>
  if (typeof namespace.createZvecGrep === 'function') return namespace.createZvecGrep as EngineFactory
  const defaultExport = namespace.default
  if (defaultExport !== null && typeof defaultExport === 'object') {
    const nested = (defaultExport as Record<string, unknown>).createZvecGrep
    if (typeof nested === 'function') return nested as EngineFactory
  }
  return undefined
}

/**
 * Resolves the optional engine package lazily, so a missing or broken engine never prevents
 * the plugin from loading. Resolution order: an explicit path, the bare specifier (which covers
 * the engine installed next to the plugin), then the global npm root.
 */
export class EngineLoader {
  private readonly specifier: string
  private readonly retryIntervalMs: number
  private readonly importModule: (specifier: string) => Promise<unknown>
  private readonly readGlobalRoot: () => Promise<string | undefined>
  private readonly onWarning?: (message: string) => void
  private readonly now: () => number
  private globalRoot?: Promise<string | undefined>
  private loaded?: Promise<ZvecGrepModule>
  private inflight?: Promise<ZvecGrepModule>
  private failure?: { retryAt: number; error: EngineUnavailableError }

  constructor(options: EngineLoaderOptions) {
    this.specifier = options.specifier
    this.retryIntervalMs = options.retryIntervalMs ?? ENGINE_RETRY_INTERVAL_MS
    this.importModule = options.importModule ?? (specifier => import(specifier) as Promise<unknown>)
    this.readGlobalRoot = options.readGlobalRoot ?? (() => readGlobalNpmRoot(defaultRunner))
    this.onWarning = options.onWarning
    this.now = options.now ?? Date.now
  }

  load(): Promise<ZvecGrepModule> {
    if (this.loaded !== undefined) return this.loaded
    if (this.inflight !== undefined) return this.inflight
    if (this.failure !== undefined && this.now() < this.failure.retryAt) {
      return Promise.reject(this.failure.error)
    }
    const attempt = this.resolve()
    this.inflight = attempt
    void attempt.then(
      () => {
        this.loaded = attempt
        this.failure = undefined
      },
      error => {
        this.failure = {
          retryAt: this.now() + this.retryIntervalMs,
          error: error instanceof EngineUnavailableError ? error : new EngineUnavailableError([errorMessage(error)]),
        }
      },
    ).finally(() => {
      if (this.inflight === attempt) this.inflight = undefined
    })
    return attempt
  }

  private async resolve(): Promise<ZvecGrepModule> {
    const attempts: string[] = []
    const explicit = isPathLike(this.specifier)
    const primary = await this.primaryCandidates(explicit).catch(error => {
      attempts.push(`the configured engine location could not be read (${errorMessage(error)})`)
      return [] as Candidate[]
    })
    for (const candidate of primary) {
      const loaded = await this.attempt(candidate, attempts)
      if (loaded !== undefined) return loaded
    }
    // An explicitly configured location is authoritative: never silently fall back elsewhere.
    if (explicit) throw new EngineUnavailableError(attempts)
    // The global npm root costs an `npm root -g` spawn, so only consult it when the engine is
    // not installed next to the plugin.
    const global = await this.globalCandidates().catch(error => {
      attempts.push(`the global npm root could not be read (${errorMessage(error)})`)
      return [] as Candidate[]
    })
    for (const candidate of global) {
      const loaded = await this.attempt(candidate, attempts)
      if (loaded !== undefined) return loaded
    }
    throw new EngineUnavailableError(attempts)
  }

  /** Loads one candidate, recording why it failed instead of aborting the remaining candidates. */
  private async attempt(candidate: Candidate, attempts: string[]): Promise<ZvecGrepModule | undefined> {
    try {
      const factory = engineFactory(await this.importModule(candidate.specifier))
      if (factory === undefined) throw new Error('module does not export createZvecGrep')
      this.checkVersion(candidate)
      return {
        createZvecGrep: async options => (await factory(options)) as SearchEngine,
      }
    } catch (error) {
      attempts.push(`${candidate.label} (${errorMessage(error)})`)
      return undefined
    }
  }

  private async primaryCandidates(explicit: boolean): Promise<Candidate[]> {
    if (!explicit) return [{ label: this.specifier, specifier: this.specifier }]
    const target = this.specifier.startsWith('file:')
      ? fileURLToPath(this.specifier)
      : resolve(this.specifier)
    const entry = await readPackageEntry(target)
    return entry === undefined
      ? [{ label: this.specifier, specifier: pathToFileURL(target).href }]
      : [{ label: this.specifier, specifier: entry.url, ...(entry.version === undefined ? {} : { version: entry.version }) }]
  }

  private async globalCandidates(): Promise<Candidate[]> {
    const root = await this.globalNpmRoot()
    if (root === undefined) return []
    const directory = packageDirectory(root, this.specifier)
    if (directory === undefined) return []
    const entry = await readPackageEntry(directory)
    if (entry === undefined) return []
    return [{
      label: `${this.specifier} from ${root}`,
      specifier: entry.url,
      ...(entry.version === undefined ? {} : { version: entry.version }),
    }]
  }

  private globalNpmRoot(): Promise<string | undefined> {
    this.globalRoot ??= this.readGlobalRoot()
    return this.globalRoot
  }

  private checkVersion(candidate: Candidate): void {
    if (candidate.version === undefined || this.onWarning === undefined) return
    const expected = ENGINE_RANGE.replace(/^[^\d]*/, '').split('.')[0]
    if (expected === undefined || expected === '' || candidate.version.split('.')[0] === expected) return
    this.onWarning(`dsh-zvec-grep: resolved @zvec/zvec-grep ${candidate.version} from ${candidate.label}, which is outside the tested range ${ENGINE_RANGE}`)
  }
}
