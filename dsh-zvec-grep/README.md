# dsh-zvec-grep

Automatic semantic workspace search for DeepSeek Harness, powered by Alibaba [zvec](https://github.com/alibaba/zvec) and the public [zvec-grep](https://github.com/zvec-ai/zvec-grep) engine API.

## Installation

```bash
npx @deepseek-ai/dsh plugin --profile web add @sugarforever/dsh-zvec-grep
```

Start DeepSeek Harness as usual, for example:

```bash
npx @deepseek-ai/dsh web
```

That is the complete setup. No need to run `zg install`, `zg index`, or start an MCP server.

The search engine `@zvec/zvec-grep` is an **optional** dependency of the plugin, so a failed engine download never fails the plugin installation. On a normal network both arrive together and nothing changes for you.

### Preinstalled engines and restricted networks

If the engine download is blocked, slow, or already installed elsewhere, install it once by itself:

```bash
npm install -g @zvec/zvec-grep
```

The default `engineModule` is the bare specifier `@zvec/zvec-grep`, and resolution also covers the global npm root, so an engine installed that way is picked up without further configuration. Until then, `zvec_search` returns `status: error` with the exact command above and the status pill shows `Error`; a missing engine is re-probed at most once every 30 seconds, so installing it while Harness is running recovers on the next search without a restart.

To keep the engine out of the profile tree, add the npm/pnpm escape hatch to the profile `.npmrc`:

```ini
optional=false      # pnpm
omit=optional       # npm
```

pnpm still resolves the engine's package graph, so this removes the link and install steps rather than every registry request.

pnpm 10 and newer refuse to run the engine chain's install scripts (`@zvec/zvec`, `onnxruntime-node`, `sharp`, `@vscode/ripgrep`) and reports `ERR_PNPM_IGNORED_BUILDS`. The Harness plugin command treats any non-zero pnpm exit as a failed install and then skips wiring the plugin into `dsh.profile.bundles`, which leaves the plugin installed but never loaded. Set the escape hatch above before adding the plugin, or approve those builds, so pnpm exits cleanly.

Do not run `zg --server` for a workspace while the plugin is active: both would own the same `.zvec-grep/` index.

## How it works

When Harness creates or resumes a session, the plugin reads the workspace from the immutable `session.header.cwd`, starts a file watcher, and builds the initial index in the background. Search never waits for indexing and never triggers an update. If the index is busy or unavailable, `zvec_search` returns a structured `indexing`, `refreshing`, or `error` status so the Agent or user can decide whether to retry later or use exact grep.

Added, changed, and deleted paths are debounced and submitted to zvec-grep's incremental index API in the background. An hourly full reconciliation repairs drift if the operating-system watcher missed an event.

The Harness workspace also gets a **Zvec index** status pill. It reports `Indexing`, `Refreshing`, `Ready`, or `Error` without blocking search. Select the pill to see the active workspace and pending change count. The UI is installed with the plugin; there is no separate frontend setup.

The first workspace may download the default local embedding model. Indexes are stored under `<workspace>/.zvec-grep/` and are excluded from their own scans. Add `.zvec-grep/` to the repository ignore rules if the project does not already ignore local tool state.

## Tool for agents

`zvec_search` searches the calling session's workspace. A successful call returns `status: ready` plus bounded source excerpts with relative paths, line ranges, freshness, match routes, and scores. Non-ready calls return immediately without partial or silently stale results.

Use it when wording or location is unknown, or when the question requires architecture, relationships, control flow, design rationale, or synthesis across files. Use Harness' exact grep for known identifiers, literals, regular expressions, configuration keys, error messages, and exhaustive occurrence lists.

## Lifecycle

```text
DSH bundle installation
  -> mounts @sugarforever/dsh-zvec-grep
  -> the optional engine module is resolved lazily, on first workspace activation
  -> session/created supplies session.header.cwd
  -> file watcher and background initial index start automatically
  -> watcher events are coalesced into index({ changedPaths }) calls
  -> hourly index() reconciliation compensates for missed events
  -> zvec_search uses the calling Agent's session cwd
  -> context(autoUpdate: false) searches only when the index is ready
  -> plugin disposal closes every workspace engine
```

Sessions sharing a workspace reuse one in-process engine, watcher, and indexing coordinator. A failed background operation is reported as `status: error`; searches do not retry it. The one exception is a missing engine module, which is re-probed after the retry interval so a fresh `npm install -g @zvec/zvec-grep` is picked up without restarting Harness.

## Configuration

The bundled defaults work without configuration:

```yaml
- id: zvec-grep
  name: '@sugarforever/dsh-zvec-grep'
  config:
    engineModule: '@zvec/zvec-grep'
    embedding: local/potion-code-16m-v2
    device: auto
    defaultLimit: 10
    maxLimit: 30
    watchDebounceMs: 750
    reconcileIntervalMs: 3600000
    statusPollIntervalMs: 2000
```

Node.js 22 or newer is required. `engineModule` accepts a package specifier, an absolute or relative filesystem path, or a `file:` URL; it is resolved lazily, in the order explicit location, bare specifier, then the global npm root. `device` accepts `auto`, `cpu`, `metal`, `vulkan`, or `cuda`. `reconcileIntervalMs: 0` disables periodic reconciliation; the default is one hour. `statusPollIntervalMs` controls the lightweight workspace-status UI refresh interval and defaults to two seconds.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

## License

MIT. [zvec-grep](https://github.com/zvec-ai/zvec-grep) and [zvec](https://github.com/alibaba/zvec) are separate Apache-2.0 projects distributed by their respective maintainers.
