window.__ModuleLoader__.load({ id: "@sugarforever/dsh-zvec-grep", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/IndexStatusPill.tsx
const labels = {
	indexing: "Indexing",
	refreshing: "Refreshing",
	ready: "Ready",
	error: "Error"
};
const colors = {
	indexing: "var(--dsw-alias-state-warn-primary)",
	refreshing: "var(--dsw-alias-brand-primary)",
	ready: "var(--dsw-alias-state-success-primary)",
	error: "var(--dsw-alias-state-error-primary)"
};
function currentRoot(props) {
	return props.useSessions((state) => {
		const current = state.current;
		return current === void 0 ? void 0 : state.byId[current]?.cwd;
	});
}
function displayStatus(feed) {
	if (feed.connection === "error") return {
		status: "error",
		pendingChanges: 0,
		updatedAt: 0,
		errorCode: "index_failed"
	};
	return feed.status;
}
function IndexStatusPill(props) {
	const [expanded, setExpanded] = (0, react.useState)(false);
	const root = currentRoot(props);
	const feed = props.useIndexStatus((value) => value);
	(0, react.useEffect)(() => {
		props.statusSource.selectWorkspace(root);
	}, [props.statusSource, root]);
	if (root === void 0) return null;
	const status = displayStatus(feed);
	const phase = status?.status ?? "indexing";
	const label = status === void 0 && feed.connection === "loading" ? "Loading" : labels[phase];
	const reason = feed.connection === "error" ? feed.message : void 0;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: styles.anchor,
		"data-zvec-index-status": phase,
		children: [expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: styles.panel,
			role: "status",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
					style: styles.heading,
					children: "Zvec index"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.path,
					children: root
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["Status: ", label] }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["Pending changes: ", status?.pendingChanges ?? 0] }),
				status?.errorCode && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.error,
					children: feed.connection === "error" ? "Status unavailable" : "Index update failed"
				}),
				reason !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.error,
					children: reason
				})
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			"aria-expanded": expanded,
			"aria-label": `Zvec index ${label}`,
			title: reason === void 0 ? `Zvec index: ${label}` : `Zvec index: ${label} — ${reason}`,
			style: styles.button,
			onClick: () => setExpanded((value) => !value),
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					"aria-hidden": "true",
					style: {
						...styles.dot,
						background: colors[phase]
					}
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "Zvec" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.phase,
					children: label
				})
			]
		})]
	});
}
const styles = {
	anchor: {
		position: "absolute",
		right: 16,
		bottom: 16,
		display: "flex",
		alignItems: "flex-end",
		flexDirection: "column",
		gap: 8,
		font: "500 12px/1.4 system-ui, sans-serif",
		color: "var(--dsw-alias-label-primary)",
		pointerEvents: "auto"
	},
	button: {
		display: "flex",
		alignItems: "center",
		gap: 7,
		minHeight: 32,
		padding: "6px 11px",
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: 999,
		color: "var(--dsw-alias-label-primary)",
		background: "var(--dsw-alias-button-floating-fill)",
		boxShadow: "0 6px 20px color-mix(in srgb, black 14%, transparent)",
		cursor: "pointer"
	},
	dot: {
		width: 8,
		height: 8,
		borderRadius: "50%"
	},
	phase: { color: "var(--dsw-alias-label-secondary)" },
	panel: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		width: 280,
		padding: 12,
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: 12,
		background: "var(--dsw-alias-bg-layer-2)",
		boxShadow: "0 12px 32px color-mix(in srgb, black 18%, transparent)"
	},
	heading: { fontSize: 13 },
	path: {
		overflow: "hidden",
		color: "var(--dsw-alias-label-secondary)",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	error: {
		color: "var(--dsw-alias-state-error-primary)",
		overflowWrap: "anywhere"
	}
};

//#endregion
//#region src/client/status-source.ts
const STATUS_PATH = "/api/dsh-zvec-grep/status";
const ERROR_RETRY_MS = 5e3;
const MISSING_WORKSPACE_RETRY_MS = 250;
const INITIAL_SNAPSHOT = Object.freeze({ connection: "loading" });
function parseWorkspace(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const item = value;
	if (typeof item.root !== "string" || item.root.length === 0 || ![
		"indexing",
		"refreshing",
		"ready",
		"error"
	].includes(String(item.status)) || typeof item.pendingChanges !== "number" || typeof item.updatedAt !== "number") return void 0;
	return Object.freeze({
		root: item.root,
		status: item.status,
		pendingChanges: item.pendingChanges,
		updatedAt: item.updatedAt,
		...item.errorCode === "index_failed" ? { errorCode: "index_failed" } : {}
	});
}
function parsePayload(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid zvec status response");
	const payload = value;
	if (payload.version !== 2 || typeof payload.pollIntervalMs !== "number" || !Array.isArray(payload.workspaces)) throw new Error("Invalid zvec status response");
	const workspaces = payload.workspaces.map(parseWorkspace);
	if (workspaces.some((item) => item === void 0)) throw new Error("Invalid zvec workspace status");
	return {
		pollIntervalMs: payload.pollIntervalMs,
		workspaces
	};
}
var IndexStatusSource = class {
	snapshot = INITIAL_SNAPSHOT;
	listeners = /* @__PURE__ */ new Set();
	timer;
	running = false;
	root;
	generation = 0;
	constructor(fetchStatus = () => fetch(STATUS_PATH, { cache: "no-store" })) {
		this.fetchStatus = fetchStatus;
	}
	getSnapshot = () => this.snapshot;
	subscribe = (listener) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	selectWorkspace(root) {
		if (this.root === root) return;
		const hadRoot = this.root !== void 0;
		this.root = root;
		this.generation += 1;
		if (this.timer) clearTimeout(this.timer);
		this.timer = void 0;
		if (hadRoot || this.snapshot !== INITIAL_SNAPSHOT) this.publish(INITIAL_SNAPSHOT);
		if (this.running && root !== void 0) this.poll();
	}
	start() {
		if (this.running) return;
		this.running = true;
		this.poll();
	}
	stop() {
		this.running = false;
		this.generation += 1;
		if (this.timer) clearTimeout(this.timer);
		this.timer = void 0;
	}
	async poll() {
		const root = this.root;
		if (root === void 0) return;
		const generation = this.generation;
		let nextDelay = ERROR_RETRY_MS;
		try {
			const response = await this.fetchStatus();
			if (response.status === 404) {
				nextDelay = MISSING_WORKSPACE_RETRY_MS;
				if (this.running && this.generation === generation) this.publish(INITIAL_SNAPSHOT);
			} else {
				if (!response.ok) throw new Error(`Zvec status request failed (${response.status}) for GET ${STATUS_PATH}`);
				const payload = parsePayload(await response.json());
				const status = payload.workspaces.find((item) => item.root === root);
				nextDelay = status === void 0 ? MISSING_WORKSPACE_RETRY_MS : Math.max(250, payload.pollIntervalMs);
				if (this.running && this.generation === generation) this.publish(status === void 0 ? INITIAL_SNAPSHOT : Object.freeze({
					connection: "ready",
					status
				}));
			}
		} catch (error) {
			if (this.running && this.generation === generation) this.publish(Object.freeze({
				connection: "error",
				...this.snapshot.status === void 0 ? {} : { status: this.snapshot.status },
				message: error instanceof Error ? error.message : String(error)
			}));
		}
		if (this.running && this.generation === generation) {
			this.timer = setTimeout(() => {
				this.poll();
			}, nextDelay);
			this.timer.unref?.();
		}
	}
	publish(snapshot) {
		this.snapshot = snapshot;
		for (const listener of this.listeners) try {
			listener();
		} catch {}
	}
};

//#endregion
//#region src/client/index.tsx
const inject = ["slots"];
function apply(ctx) {
	const status = new IndexStatusSource();
	ctx.effect(() => {
		status.start();
		return () => status.stop();
	}, "dsh-zvec-grep: status polling");
	ctx.slots.inject("shell.overlay", () => ctx.slots.register({
		name: "shell.overlay",
		id: "zvec-index-status",
		order: 50,
		inject: () => ({
			hooks: { indexStatus: status },
			statusSource: status
		})
	}, IndexStatusPill));
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map