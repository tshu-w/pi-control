import { AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

interface Request {
	customInstructions?: string;
	signal?: AbortSignal;
}

interface CompactionRegistry {
	pending: WeakMap<object, Request>;
	inFlight: WeakSet<object>;
	patched: boolean;
}

const key = Symbol.for("pi-control:in-turn-compaction");
const registry: CompactionRegistry = ((globalThis as any)[key] ??= {
	pending: new WeakMap(),
	inFlight: new WeakSet(),
	patched: false,
});

function installCompactionBoundary(): boolean {
	if (registry.patched) return true;
	const prototype = AgentSession.prototype as any;
	const prepare = prototype._compactBeforeNextAssistantResponse;
	const compact = prototype.compact;
	if (typeof prepare !== "function" || typeof compact !== "function" ||
		typeof prototype._clearManualCompactionState !== "function") return false;

	prototype._compactBeforeNextAssistantResponse = async function (context: any) {
		const owner = this.sessionManager;
		const request = registry.pending.get(owner);
		if (!request) return prepare.call(this, context);
		registry.pending.delete(owner);
		request.signal?.throwIfAborted();
		registry.inFlight.add(owner);
		try {
			// This boundary is already between model requests, after tool results
			// are persisted. Reuse native manual compaction without its initial
			// abort-and-wait. Only this invocation sees the facade; external aborts
			// still reach the real session and cancel its compaction controller.
			const session = new Proxy(this, {
				get(target, property) {
					if (property === "abort") return async () => {};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
				set: (target, property, value) => Reflect.set(target, property, value, target),
			});
			await compact.call(session, request.customInstructions);
			request.signal?.throwIfAborted();
			return { ...context, messages: this.agent.state.messages.slice() };
		} finally {
			registry.inFlight.delete(owner);
		}
	};
	registry.patched = true;
	return true;
}

export function registerCompaction(pi: ExtensionAPI): void {
	installCompactionBoundary();
	// An aborted run or a replaced session may never reach another request.
	pi.on("agent_settled", (_event, ctx) => { registry.pending.delete(ctx.sessionManager); });
	pi.on("session_shutdown", (_event, ctx) => { registry.pending.delete(ctx.sessionManager); });
}

export function scheduleCompaction(ctx: ExtensionContext, request: Request): void {
	if (!installCompactionBoundary()) {
		throw new Error("In-turn compaction is unavailable in this Pi version. Upgrade Pi or use built-in `/compact` outside the active run.");
	}
	request.signal?.throwIfAborted();
	const owner = ctx.sessionManager;
	if (registry.pending.has(owner) || registry.inFlight.has(owner)) {
		throw new Error("Compaction is already scheduled or running for this session. Wait for it to finish.");
	}
	registry.pending.set(owner, request);
}
