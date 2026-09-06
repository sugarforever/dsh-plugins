import z from "@deepseek-ai/schemastery";
import { createZvecGrep } from "@zvec/zvec-grep";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { watch } from "chokidar";

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
			fullReconcile: false
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
			if (state.phase === "refreshing") this.scheduleRefresh(state);
		} catch (error) {
			this.setPhase(state, "error");
			state.error = error;
			throw error;
		}
	}
	queuePath(state, path) {
		if (state.controller.signal.aborted) return;
		state.changedPaths.add(path);
		if (state.phase !== "indexing") this.setPhase(state, "refreshing");
		this.scheduleRefresh(state);
	}
	queueReconcile(state) {
		if (state.controller.signal.aborted) return;
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
			if (!state.controller.signal.aborted) {
				this.setPhase(state, "error");
				state.error = error;
			}
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
		description: "Search the current workspace by meaning, concepts, architecture, relationships, and data flow. Returns indexing or refreshing status immediately when the background index is not ready. Use exact grep for known literals or exhaustive matches.",
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
function createWorkspaceWatcher(root, callbacks) {
	const watcher = watch(root, {
		ignoreInitial: true,
		ignored: /(^|[/\\])(?:\.git|\.zvec-grep|node_modules)(?:[/\\]|$)/
	});
	let settleReady;
	const ready = new Promise((resolve$1) => {
		settleReady = resolve$1;
	});
	watcher.once("ready", settleReady);
	watcher.on("add", (path) => callbacks.change(path));
	watcher.on("change", (path) => callbacks.change(path));
	watcher.on("unlink", (path) => callbacks.change(path));
	watcher.on("addDir", (path) => callbacks.change(path));
	watcher.on("unlinkDir", (path) => callbacks.change(path));
	watcher.on("error", (error) => {
		settleReady();
		callbacks.error(error);
	});
	return {
		ready,
		close: () => {
			settleReady();
			return watcher.close();
		}
	};
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
			if (internal === void 0) return new Response("not found", { status: 404 });
			const status = {
				status: internal.status,
				pendingChanges: internal.pendingChanges,
				updatedAt: internal.updatedAt,
				...internal.status === "error" ? { errorCode: "index_failed" } : {}
			};
			return new Response(JSON.stringify({
				version: 1,
				pollIntervalMs,
				status
			}), { headers: {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store"
			} });
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
	const runtime = new WorkspaceSearchRuntime({
		create: (root) => createZvecGrep({
			root,
			embedding: config.embedding ?? "local/potion-code-16m-v2",
			device: config.device ?? "auto"
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