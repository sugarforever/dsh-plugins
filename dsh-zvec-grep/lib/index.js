import z from "@deepseek-ai/schemastery";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync, watch } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/engine.ts
/** Default `engineModule` value: install the engine as an ordinary dependency. */
const DEFAULT_ENGINE_MODULE = "@zvec/zvec-grep";
/** Mirrors `optionalDependencies` in package.json; asserted by tests/package-metadata.test.ts. */
const ENGINE_RANGE = "^0.2.1";
const ENGINE_INSTALL_COMMAND = "npm install -g @zvec/zvec-grep";
/** How long a failed resolution is reused before another probe is allowed. */
const ENGINE_RETRY_INTERVAL_MS = 3e4;
var EngineUnavailableError = class extends Error {
	constructor(attempts) {
		super([
			"dsh-zvec-grep: the optional zvec-grep engine is not installed, so semantic search is unavailable.",
			`Run: ${ENGINE_INSTALL_COMMAND}`,
			"Then call zvec_search again. Do not retry zvec_search before the engine is installed.",
			`If the engine is installed elsewhere, point the plugin option "engineModule" at its entry file, for example: ${DEFAULT_ENGINE_MODULE}`,
			...attempts.length === 0 ? [] : [`Failed attempts: ${attempts.join("; ")}`]
		].join("\n"));
		this.attempts = attempts;
		this.name = "EngineUnavailableError";
	}
};
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const NPM_ROOT_TIMEOUT_MS = 1e4;
function errorMessage$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/** True for anything the plugin should treat as a filesystem location rather than a package name. */
function isPathLike(specifier) {
	return specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("\\") || specifier.startsWith("file:") || WINDOWS_DRIVE.test(specifier);
}
function pickCondition(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const picked = pickCondition(item);
			if (picked !== void 0) return picked;
		}
		return;
	}
	if (value === null || typeof value !== "object") return void 0;
	const conditions = value;
	for (const key of [
		"import",
		"module",
		"default",
		"require",
		"node"
	]) {
		const picked = pickCondition(conditions[key]);
		if (picked !== void 0) return picked;
	}
}
/** Reads a package directory's declared entry point and version, mirroring Node's ESM conditions. */
async function readPackageEntry(directory) {
	let manifest;
	try {
		manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	} catch {
		return;
	}
	const exports = manifest.exports;
	const entry = pickCondition(exports !== null && typeof exports === "object" && !Array.isArray(exports) ? exports["."] ?? exports : exports) ?? (typeof manifest.main === "string" ? manifest.main : void 0);
	if (entry === void 0) return void 0;
	return {
		url: pathToFileURL(resolve(directory, entry)).href,
		...typeof manifest.version === "string" ? { version: manifest.version } : {}
	};
}
/** Extracts the install directory of a package specifier inside a node_modules root. */
function packageDirectory(root, specifier) {
	const [first, second] = specifier.split("/");
	if (first === void 0 || first === "") return void 0;
	if (!first.startsWith("@")) return join(root, first);
	if (second === void 0 || second === "") return void 0;
	return join(root, first, second);
}
/** Resolves the global npm root once, walking past any wrapper banner lines npm may print. */
async function readGlobalNpmRoot(run) {
	try {
		return (await run("npm", ["root", "-g"])).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "").at(-1);
	} catch {
		return;
	}
}
function defaultRunner(command, args) {
	const windows = process.platform === "win32";
	const file = windows ? process.env.ComSpec ?? "cmd.exe" : command;
	const argv = windows ? [
		"/d",
		"/c",
		command,
		...args
	] : [...args];
	return new Promise((resolveOutput, rejectOutput) => {
		execFile(file, argv, {
			windowsHide: true,
			timeout: NPM_ROOT_TIMEOUT_MS,
			encoding: "utf8"
		}, (error, stdout) => {
			if (error) {
				rejectOutput(error);
				return;
			}
			resolveOutput(String(stdout));
		});
	});
}
function engineFactory(module) {
	if (module === null || typeof module !== "object") return void 0;
	const namespace = module;
	if (typeof namespace.createZvecGrep === "function") return namespace.createZvecGrep;
	const defaultExport = namespace.default;
	if (defaultExport !== null && typeof defaultExport === "object") {
		const nested = defaultExport.createZvecGrep;
		if (typeof nested === "function") return nested;
	}
}
/**
* Resolves the optional engine package lazily, so a missing or broken engine never prevents
* the plugin from loading. Resolution order: an explicit path, the bare specifier (which covers
* the engine installed next to the plugin), then the global npm root.
*/
var EngineLoader = class {
	specifier;
	retryIntervalMs;
	importModule;
	readGlobalRoot;
	onWarning;
	now;
	globalRoot;
	loaded;
	inflight;
	failure;
	constructor(options) {
		this.specifier = options.specifier;
		this.retryIntervalMs = options.retryIntervalMs ?? ENGINE_RETRY_INTERVAL_MS;
		this.importModule = options.importModule ?? ((specifier) => import(specifier));
		this.readGlobalRoot = options.readGlobalRoot ?? (() => readGlobalNpmRoot(defaultRunner));
		this.onWarning = options.onWarning;
		this.now = options.now ?? Date.now;
	}
	load() {
		if (this.loaded !== void 0) return this.loaded;
		if (this.inflight !== void 0) return this.inflight;
		if (this.failure !== void 0 && this.now() < this.failure.retryAt) return Promise.reject(this.failure.error);
		const attempt = this.resolve();
		this.inflight = attempt;
		attempt.then(() => {
			this.loaded = attempt;
			this.failure = void 0;
		}, (error) => {
			this.failure = {
				retryAt: this.now() + this.retryIntervalMs,
				error: error instanceof EngineUnavailableError ? error : new EngineUnavailableError([errorMessage$1(error)])
			};
		}).finally(() => {
			if (this.inflight === attempt) this.inflight = void 0;
		});
		return attempt;
	}
	async resolve() {
		const attempts = [];
		const explicit = isPathLike(this.specifier);
		const primary = await this.primaryCandidates(explicit).catch((error) => {
			attempts.push(`the configured engine location could not be read (${errorMessage$1(error)})`);
			return [];
		});
		for (const candidate of primary) {
			const loaded = await this.attempt(candidate, attempts);
			if (loaded !== void 0) return loaded;
		}
		if (explicit) throw new EngineUnavailableError(attempts);
		const global = await this.globalCandidates().catch((error) => {
			attempts.push(`the global npm root could not be read (${errorMessage$1(error)})`);
			return [];
		});
		for (const candidate of global) {
			const loaded = await this.attempt(candidate, attempts);
			if (loaded !== void 0) return loaded;
		}
		throw new EngineUnavailableError(attempts);
	}
	/** Loads one candidate, recording why it failed instead of aborting the remaining candidates. */
	async attempt(candidate, attempts) {
		try {
			const factory = engineFactory(await this.importModule(candidate.specifier));
			if (factory === void 0) throw new Error("module does not export createZvecGrep");
			this.checkVersion(candidate);
			return { createZvecGrep: async (options) => await factory(options) };
		} catch (error) {
			attempts.push(`${candidate.label} (${errorMessage$1(error)})`);
			return;
		}
	}
	async primaryCandidates(explicit) {
		if (!explicit) return [{
			label: this.specifier,
			specifier: this.specifier
		}];
		const target = this.specifier.startsWith("file:") ? fileURLToPath(this.specifier) : resolve(this.specifier);
		const entry = await readPackageEntry(target);
		return entry === void 0 ? [{
			label: this.specifier,
			specifier: pathToFileURL(target).href
		}] : [{
			label: this.specifier,
			specifier: entry.url,
			...entry.version === void 0 ? {} : { version: entry.version }
		}];
	}
	async globalCandidates() {
		const root = await this.globalNpmRoot();
		if (root === void 0) return [];
		const directory = packageDirectory(root, this.specifier);
		if (directory === void 0) return [];
		const entry = await readPackageEntry(directory);
		if (entry === void 0) return [];
		return [{
			label: `${this.specifier} from ${root}`,
			specifier: entry.url,
			...entry.version === void 0 ? {} : { version: entry.version }
		}];
	}
	globalNpmRoot() {
		this.globalRoot ??= this.readGlobalRoot();
		return this.globalRoot;
	}
	checkVersion(candidate) {
		if (candidate.version === void 0 || this.onWarning === void 0) return;
		const expected = ENGINE_RANGE.replace(/^[^\d]*/, "").split(".")[0];
		if (expected === void 0 || expected === "" || candidate.version.split(".")[0] === expected) return;
		this.onWarning(`dsh-zvec-grep: resolved @zvec/zvec-grep ${candidate.version} from ${candidate.label}, which is outside the tested range ${ENGINE_RANGE}`);
	}
};

//#endregion
//#region src/runtime.ts
const statusMessages = {
	indexing: "The workspace index is still being built.",
	refreshing: "The workspace index is being refreshed in the background."
};
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function canonicalizeRoot(root) {
	const absolute = resolve(root);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}
var WorkspaceSearchRuntime = class {
	workspaces = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
	}
	activate(root) {
		root = canonicalizeRoot(root);
		const existing = this.workspaces.get(root);
		if (existing) return existing.initialIndex;
		const state = {
			root,
			engine: this.options.create(root),
			initialIndex: Promise.resolve(),
			controller: new AbortController(),
			phase: "indexing",
			updatedAt: Date.now(),
			changedPaths: /* @__PURE__ */ new Set(),
			fullReconcile: false,
			engineFailed: false
		};
		this.workspaces.set(root, state);
		this.startWatcher(state);
		state.initialIndex = this.indexInitially(state);
		return state.initialIndex;
	}
	settled(root) {
		root = canonicalizeRoot(root);
		const state = this.workspaces.get(root);
		if (!state) throw new Error(`Workspace is not active: ${root}`);
		return state.initialIndex;
	}
	status() {
		return [...this.workspaces.values()].map((state) => ({
			root: state.root,
			status: state.phase,
			pendingChanges: state.changedPaths.size + (state.fullReconcile ? 1 : 0),
			updatedAt: state.updatedAt,
			...state.phase === "error" ? { message: errorMessage(state.error) } : {}
		}));
	}
	statusFor(root) {
		root = canonicalizeRoot(root);
		return this.status().find((status) => status.root === root);
	}
	async search(root, options) {
		root = canonicalizeRoot(root);
		let state = this.workspaces.get(root);
		if (!state) {
			this.activate(root).catch(() => void 0);
			state = this.workspaces.get(root);
		}
		if (state.phase === "error" && state.engineFailed) await this.reactivate(state);
		if (state.phase === "indexing") return {
			status: "indexing",
			root,
			message: statusMessages.indexing
		};
		if (state.phase === "refreshing") return {
			status: "refreshing",
			root,
			message: statusMessages.refreshing
		};
		if (state.phase === "error") return {
			status: "error",
			root,
			message: errorMessage(state.error)
		};
		return {
			status: "ready",
			result: await (await state.engine).context({
				...options,
				root,
				autoUpdate: false
			})
		};
	}
	/**
	* Re-attempts engine resolution for a workspace whose engine never loaded. The engine loader
	* decides whether another probe is allowed yet, so repeated searches stay cheap. Indexing is
	* restarted in the background; the caller still returns immediately.
	*/
	async reactivate(state) {
		const engine = this.options.create(state.root);
		state.engine = engine;
		try {
			await engine;
		} catch {
			return;
		}
		state.engineFailed = false;
		state.error = void 0;
		this.setPhase(state, "indexing");
		state.initialIndex = this.indexInitially(state);
		state.initialIndex.catch(() => void 0);
	}
	async close() {
		const states = [...this.workspaces.values()];
		this.workspaces.clear();
		for (const state of states) {
			state.controller.abort(/* @__PURE__ */ new Error("dsh-zvec-grep disposed"));
			if (state.debounceTimer) clearTimeout(state.debounceTimer);
			if (state.reconcileTimer) clearInterval(state.reconcileTimer);
		}
		await Promise.allSettled(states.map((state) => Promise.resolve(state.watcher?.close())));
		await Promise.allSettled(states.flatMap((state) => [state.initialIndex, state.refresh].filter((task) => Boolean(task))));
		await Promise.allSettled(states.map(async (state) => (await state.engine).close()));
	}
	startWatcher(state) {
		if (this.options.watch) state.watcher = this.options.watch(state.root, {
			change: (path) => this.queuePath(state, path),
			error: () => this.queueReconcile(state)
		});
		const intervalMs = this.options.reconcileIntervalMs ?? 60 * 6e4;
		if (intervalMs > 0) {
			state.reconcileTimer = setInterval(() => this.queueReconcile(state), intervalMs);
			state.reconcileTimer.unref?.();
		}
	}
	async indexInitially(state) {
		try {
			await state.watcher?.ready;
			state.controller.signal.throwIfAborted();
			await (await state.engine).index({
				root: state.root,
				signal: state.controller.signal
			});
			this.setPhase(state, state.changedPaths.size > 0 || state.fullReconcile ? "refreshing" : "ready");
			state.error = void 0;
			state.engineFailed = false;
			if (state.phase === "refreshing") this.scheduleRefresh(state);
		} catch (error) {
			await this.failWorkspace(state, error);
			throw error;
		}
	}
	async failWorkspace(state, error) {
		this.setPhase(state, "error");
		state.error = error;
		state.engineFailed = await state.engine.then(() => false, () => true);
	}
	queuePath(state, path) {
		if (state.controller.signal.aborted || state.engineFailed) return;
		state.changedPaths.add(path);
		if (state.phase !== "indexing") this.setPhase(state, "refreshing");
		this.scheduleRefresh(state);
	}
	queueReconcile(state) {
		if (state.controller.signal.aborted || state.engineFailed) return;
		state.fullReconcile = true;
		if (state.phase !== "indexing") this.setPhase(state, "refreshing");
		this.scheduleRefresh(state);
	}
	scheduleRefresh(state) {
		if (state.phase === "indexing" || state.refresh || state.controller.signal.aborted) return;
		if (state.debounceTimer) clearTimeout(state.debounceTimer);
		state.debounceTimer = setTimeout(() => {
			state.debounceTimer = void 0;
			state.refresh = this.refresh(state).finally(() => {
				state.refresh = void 0;
				if (state.changedPaths.size > 0 || state.fullReconcile) this.scheduleRefresh(state);
			});
		}, this.options.debounceMs ?? 750);
		state.debounceTimer.unref?.();
	}
	async refresh(state) {
		const fullReconcile = state.fullReconcile;
		const changedPaths = [...state.changedPaths];
		state.fullReconcile = false;
		state.changedPaths.clear();
		try {
			await (await state.engine).index({
				root: state.root,
				signal: state.controller.signal,
				...fullReconcile ? {} : { changedPaths }
			});
			this.setPhase(state, state.changedPaths.size > 0 || state.fullReconcile ? "refreshing" : "ready");
			state.error = void 0;
		} catch (error) {
			if (!state.controller.signal.aborted) await this.failWorkspace(state, error);
		}
	}
	setPhase(state, phase) {
		if (state.phase === phase) return;
		state.phase = phase;
		state.updatedAt = Date.now();
	}
};

//#endregion
//#region src/tool.ts
function lineRange(item) {
	const range = item.excerptRange ?? item.range;
	if ("startLine" in range && "endLine" in range) return {
		startLine: range.startLine,
		endLine: range.endLine
	};
	if ("page" in range) return {
		startLine: range.page,
		endLine: range.page
	};
	return {};
}
function projectResult(result) {
	return {
		status: "ready",
		query: result.query,
		root: result.root,
		source: result.source,
		coverage: result.coverage,
		results: result.items.map((item) => ({
			path: item.file.relativePath,
			...lineRange(item),
			content: item.content,
			status: item.status,
			matchedBy: Array.isArray(item.matchedBy) ? item.matchedBy.join(",") : String(item.matchedBy),
			...item.score === void 0 ? {} : { score: item.score }
		}))
	};
}
function project(outcome) {
	return outcome.status === "ready" ? projectResult(outcome.result) : outcome;
}
function createSearchTool(runtime, config) {
	return defineTool({
		name: "zvec_search",
		description: "Search the current workspace by meaning, concepts, architecture, relationships, and data flow. Returns indexing or refreshing status immediately when the background index is not ready, and an error status carrying the install command when the optional zvec-grep engine is not available. Use exact grep for known literals or exhaustive matches.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "Natural-language search intent."
			},
			limit: {
				type: "integer",
				description: `Maximum results, from 1 to ${config.maxLimit}. Defaults to ${config.defaultLimit}.`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: {
						type: "string",
						required: true
					},
					root: {
						type: "string",
						required: true
					},
					message: { type: "string" },
					query: { type: "string" },
					source: { type: "string" },
					coverage: { type: "string" },
					results: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: {
									type: "string",
									required: true
								},
								startLine: { type: "integer" },
								endLine: { type: "integer" },
								content: {
									type: "string",
									required: true
								},
								status: {
									type: "string",
									required: true
								},
								matchedBy: {
									type: "string",
									required: true
								},
								score: { type: "number" }
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		async execute(args, exec) {
			const root = exec.agent?.session.header.cwd;
			if (!root) throw new Error("zvec_search requires a session workspace");
			const limit = args.limit ?? config.defaultLimit;
			if (limit < 1 || limit > config.maxLimit) throw new Error(`zvec_search limit must be between 1 and ${config.maxLimit}`);
			return project(await runtime.search(root, {
				query: args.query,
				limit
			}));
		}
	});
}

//#endregion
//#region src/watcher.ts
const HARD_EXCLUDED = /(^|[/\\])(?:\.git|\.zvec-grep|node_modules)(?:[/\\]|$)/;
function changedPath(root, filename) {
	if (filename === null) return void 0;
	const name$1 = filename.toString();
	if (!name$1 || HARD_EXCLUDED.test(name$1)) return void 0;
	const absolutePath = isAbsolute(name$1) ? resolve(name$1) : resolve(root, name$1);
	const pathFromRoot = relative(root, absolutePath);
	if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) return void 0;
	return absolutePath;
}
function createWorkspaceWatcherWith(root, callbacks, nativeWatch) {
	const watcher = nativeWatch(root, { recursive: true }, (_eventType, filename) => {
		const path = changedPath(root, filename);
		if (path !== void 0) callbacks.change(path);
	});
	watcher.on("error", callbacks.error);
	return {
		ready: Promise.resolve(),
		close: () => watcher.close()
	};
}
function createWorkspaceWatcher(root, callbacks) {
	return createWorkspaceWatcherWith(root, callbacks, watch);
}

//#endregion
//#region src/status-route.ts
const STATUS_PATH = "/api/dsh-zvec-grep/status";
function registerStatusRoute(connection, runtime, sessions, pollIntervalMs) {
	return connection.register({
		path: STATUS_PATH,
		methods: ["GET"],
		async fetch(request) {
			const sessionId = new URL(request.url).searchParams.get("sessionId");
			if (!sessionId) return new Response("missing sessionId", { status: 400 });
			const root = sessions.list().find((item) => String(item.id) === sessionId)?.header.cwd;
			if (!root) return new Response("not found", { status: 404 });
			const internal = runtime.statusFor(root);
			const status = internal === void 0 ? {
				status: "indexing",
				pendingChanges: 0,
				updatedAt: 0
			} : {
				status: internal.status,
				pendingChanges: internal.pendingChanges,
				updatedAt: internal.updatedAt,
				...internal.status === "error" ? { errorCode: "index_failed" } : {}
			};
			return new Response(JSON.stringify({
				version: 1,
				pollIntervalMs,
				status
			}), {
				status: internal === void 0 ? 202 : 200,
				headers: {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store"
				}
			});
		}
	});
}

//#endregion
//#region src/index.ts
const name = "dsh-zvec-grep";
const inject = [
	"sessions",
	"tools",
	"systemPrompt"
];
const Config = z.object({
	engineModule: z.string().default(DEFAULT_ENGINE_MODULE),
	embedding: z.string().default("local/potion-code-16m-v2"),
	device: z.union([
		"auto",
		"cpu",
		"metal",
		"vulkan",
		"cuda"
	]).default("auto"),
	defaultLimit: z.number().step(1).min(1).max(30).default(10),
	maxLimit: z.number().step(1).min(1).max(100).default(30),
	watchDebounceMs: z.number().step(1).min(50).max(3e4).default(750),
	reconcileIntervalMs: z.number().step(1).min(0).max(864e5).default(36e5),
	statusPollIntervalMs: z.number().step(1).min(250).max(6e4).default(2e3)
});
function activate(runtime, ctx, root) {
	if (!root) return;
	runtime.activate(root).catch((error) => {
		ctx.logger.warn(`dsh-zvec-grep: automatic indexing failed for ${root}: ${String(error)}`);
	});
}
function mountPlugin(ctx, runtime, config) {
	ctx.systemPrompt.section({
		name: "tool:zvec-search",
		order: 103,
		text: "Use zvec_search for semantic or cross-file workspace discovery when wording or location is unknown. Use exact grep for known identifiers, literals, regular expressions, or exhaustive occurrence lists."
	});
	ctx.tools.register(createSearchTool(runtime, config));
	ctx.on("session/created", (session) => {
		activate(runtime, ctx, session.header.cwd);
	}, { global: true });
	for (const session of ctx.sessions.list()) activate(runtime, ctx, session.header.cwd);
	ctx.effect(() => () => runtime.close());
}
function apply(ctx, config) {
	if ((config.defaultLimit ?? 10) > (config.maxLimit ?? 30)) throw new Error("dsh-zvec-grep: defaultLimit cannot exceed maxLimit");
	const embedding = config.embedding ?? "local/potion-code-16m-v2";
	const device = config.device ?? "auto";
	const engines = new EngineLoader({
		specifier: config.engineModule ?? DEFAULT_ENGINE_MODULE,
		onWarning: (message) => ctx.logger.warn(message)
	});
	const runtime = new WorkspaceSearchRuntime({
		create: async (root) => (await engines.load()).createZvecGrep({
			root,
			embedding,
			device
		}),
		watch: createWorkspaceWatcher,
		debounceMs: config.watchDebounceMs ?? 750,
		reconcileIntervalMs: config.reconcileIntervalMs ?? 36e5
	});
	mountPlugin(ctx, runtime, {
		defaultLimit: config.defaultLimit ?? 10,
		maxLimit: config.maxLimit ?? 30
	});
	const statusFiber = ctx.inject(["connection"], (childCtx) => {
		childCtx.effect(() => registerStatusRoute(childCtx.connection.fetch, runtime, childCtx.sessions, config.statusPollIntervalMs ?? 2e3), "dsh-zvec-grep: status route");
	});
	ctx.effect(() => () => statusFiber.dispose(), "dsh-zvec-grep: optional web status");
}

//#endregion
export { Config, apply, inject, mountPlugin, name };