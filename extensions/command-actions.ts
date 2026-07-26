/**
 * Private API hack: auto-capture command-only closures from ExtensionRunner.
 *
 * pi's public API only exposes switchSession/newSession/navigateTree/fork/reload
 * on ExtensionCommandContext (command handlers), not on ExtensionContext (tools/events).
 * We patch ExtensionRunner.prototype.bindCommandContext to capture these closures
 * when the runtime binds them, then execute pending actions on agent_settled.
 *
 * This is the userland polyfill for the session-transition APIs missing from
 * ExtensionContext (upstream pi#2023).
 */

import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

// ── Types ───────────────────────────────────────────────────

/**
 * A pending deferred action. Discriminated on `kind`.
 *
 * At most one action can be pending at a time — enforced by `setPending()`.
 * The exhaustive switch in `runPending()` guarantees every kind is handled.
 */
export type PendingAction =
	| { kind: "resume"; file: string; message?: string }
	| { kind: "new"; parentSession?: string; message?: string }
	| { kind: "nav"; targetId: string; summarize?: boolean; customInstructions?: string; message?: string }
	| { kind: "fork"; id: string; message?: string }
	| { kind: "reload"; message?: string }
	/** Raw op scheduled by the `commands` router when a third-party handler
	 *  invoked one of the session-transition closures via mediated ctx.
	 *  The exec closure calls _state.ops.* directly; a `cancelled` result is
	 *  surfaced as a warning by runPending. */
	| { kind: "rawOp"; token: symbol; label: string; exec: () => Promise<{ cancelled?: boolean } | void> }
	/** Public-API work deferred to agent_settled (e.g. model switch). Needs no
	 *  captured command context; a later deferred replaces a pending one. */
	| { kind: "deferred"; label: string; exec: () => Promise<void> };

export interface RuntimeContext {
	sendFollowUp: (msg: string) => Promise<void>;
}

export interface CommandOps {
	switchSession: (sessionPath: string, options?: {
		withSession?: (ctx: any) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	newSession: (options?: {
		parentSession?: string;
		setup?: any;
		withSession?: (ctx: any) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	navigateTree: (targetId: string, options?: {
		summarize?: boolean;
		customInstructions?: string;
		replaceInstructions?: boolean;
		label?: string;
	}) => Promise<{ cancelled: boolean }>;
	fork: (entryId: string, options?: {
		position?: "before" | "at";
		withSession?: (ctx: any) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
	/** Resolves when the agent is idle; used to avoid tearing down a turn that
	 *  raced the public settled event into the settled→timer window. */
	waitForIdle?: () => Promise<void>;
}

// ── State ───────────────────────────────────────────────────

// Process-wide singleton. Pi's /reload clears the extension module cache and
// re-executes this module as a fresh instance; module-local state would leave
// the prototype patch re-wrapping bindCommandContext once per reload (a
// growing wrapper chain pinning every old module instance) and would split
// ops/pending/runner between the instance that patched and the instance the
// routers now call. Symbol.for + globalThis gives every instance the same
// state and makes the patch idempotent across reloads.
interface SharedState {
	ops: CommandOps | null;
	pending: PendingAction | null;
	/** Set while runPending / runPendingDeferredInline executes an action.
	 *  Occupies the single slot so nothing schedules a second transition while
	 *  the first waits for idle or is mid-teardown. */
	inFlight: { kind: string; label: string } | null;
	runner: any;
	patched: boolean;
}

const STATE_KEY = Symbol.for("pi-control:command-actions-state");
const _state: SharedState = ((globalThis as any)[STATE_KEY] ??= {
	ops: null,
	pending: null,
	inFlight: null,
	runner: null,
	patched: false,
});

// ── Accessors ───────────────────────────────────────────────

export function isArmed(): boolean { return _state.ops !== null; }
/** True while the single slot is occupied — by a scheduled action or by one
 *  currently executing (waiting for idle / mid-transition). Both must block
 *  new scheduling: a second transition racing an in-flight one would tear
 *  down the session underneath it. */
export function hasPending(): boolean { return _state.pending !== null || _state.inFlight !== null; }
/** True only when an action is scheduled but not yet claimed by runPending.
 *  session_shutdown cleanup uses this: an in-flight transition legitimately
 *  triggers session_shutdown itself (core emits it before switchSession /
 *  reload resolve) and must not be reported as a stale pending action. */
export function hasQueuedAction(): boolean { return _state.pending !== null; }
function busyKind(): string | undefined {
	return _state.pending?.kind ?? (_state.inFlight ? `in-flight ${_state.inFlight.kind}` : undefined);
}
/** The ExtensionRunner instance, captured opportunistically inside bindCommandContext.
 *  Used by the `commands` router to enumerate/run third-party slash commands. */
export function getRunner(): any { return _state.runner; }

export function clearPending(): void {
	_state.pending = null;
}

/**
 * Router-facing helper: dispatch a pending action.
 *
 * Callers do action-specific validation first, then hand off to scheduleAction
 * which handles the isArmed / hasPending / set / response boilerplate.
 */
export interface ScheduleParams {
	/** Short hint pointing at the built-in fallback command, e.g. "Use built-in `/resume` instead." */
	fallbackHint: string;
	/** The action to schedule. */
	action: PendingAction;
	/** Success text shown to the model when the action was scheduled. */
	successText: string;
	/** Persisted metadata for rendering, state, or follow-up location. */
	details?: Record<string, any>;
}

export function scheduleAction(params: ScheduleParams): { content: Array<{ type: "text"; text: string }>; details: Record<string, any> } {
	if (!isArmed()) {
		return {
			content: [{ type: "text", text: `Command context not captured. ${params.fallbackHint}` }],
			details: {},
		};
	}
	if (hasPending()) {
		return {
			content: [{ type: "text", text: `Another pending action (${busyKind()}) is already scheduled. Wait for the current turn to finish.` }],
			details: {},
		};
	}
	_state.pending = params.action;
	return {
		content: [{ type: "text", text: params.successText }],
		details: params.details ?? {},
	};
}

/** Schedule public-API work for agent_settled. Unlike scheduleAction this
 *  needs no captured command context. A pending "deferred" is replaced
 *  (last wins); any other pending kind rejects the request. */
export function scheduleDeferred(label: string, exec: () => Promise<void>): { ok: true } | { ok: false; reason: string } {
	if (_state.inFlight) {
		return { ok: false, reason: `another action (in-flight ${_state.inFlight.kind}) is already executing` };
	}
	if (_state.pending && _state.pending.kind !== "deferred") {
		return { ok: false, reason: `another pending action (${_state.pending.kind}) is already queued` };
	}
	_state.pending = { kind: "deferred", label, exec };
	return { ok: true };
}

/** Lower-level helper for the commands router: schedule a raw op without the
 *  scheduleAction success-text plumbing. Returns the reason if not armed or busy. */
export function scheduleRawOp(label: string, exec: () => Promise<{ cancelled?: boolean } | void>): { ok: true; token: symbol } | { ok: false; reason: string } {
	if (!isArmed()) return { ok: false, reason: "command context not captured (pi-control patch inactive)" };
	if (hasPending()) return { ok: false, reason: `another pending action (${busyKind()}) is already queued` };
	const token = Symbol(label);
	_state.pending = { kind: "rawOp", token, label, exec };
	return { ok: true, token };
}

export function isPendingRawOp(token: symbol): boolean {
	return _state.pending?.kind === "rawOp" && _state.pending.token === token;
}

export function clearPendingRawOp(token: symbol): boolean {
	if (!isPendingRawOp(token)) return false;
	clearPending();
	return true;
}

/** Access to the captured ops for the commands router. Prefer scheduleRawOp
 *  in normal flows; this exists for the rare case where a handler needs to
 *  invoke an op synchronously with bespoke wiring. */
export function getOps(): CommandOps | null { return _state.ops; }

// ── Patch ───────────────────────────────────────────────────

export function patchBindCommandContext(): boolean {
	if (_state.patched) return true;
	try {
		const orig = ExtensionRunner.prototype.bindCommandContext;
		if (typeof orig !== "function") return false;

		ExtensionRunner.prototype.bindCommandContext = function (actions: any) {
			_state.ops = actions ? {
				switchSession: actions.switchSession,
				newSession: actions.newSession,
				navigateTree: actions.navigateTree,
				fork: actions.fork,
				reload: actions.reload,
				waitForIdle: actions.waitForIdle,
			} : null;
			// Capture runner instance so the commands router can call
			// getRegisteredCommands() / createCommandContext() without a separate hook.
			_state.runner = this;
			return orig.call(this, actions);
		};

		_state.patched = true;
		return true;
	} catch {
		return false;
	}
}

// ── Execute pending actions ─────────────────────────────────

/** Run a pending "deferred" action inline, inside the agent_settled emit.
 *  Core publishes settled to SDK/RPC/UI listeners and resolves idle only
 *  after extension handlers return, so awaiting the model switch here closes
 *  the race where an external prompt starts the next turn on the old model.
 *  Session-transition kinds are left pending for the timer path (they must
 *  escape the emit stack). Returns true when a deferred action was consumed. */
export async function runPendingDeferredInline(
	notify?: (msg: string, level: "info" | "warning" | "error") => void,
): Promise<boolean> {
	if (_state.pending?.kind !== "deferred") return false;
	const action = _state.pending;
	_state.pending = null;
	_state.inFlight = { kind: action.kind, label: action.label };
	try {
		await action.exec();
	} catch (e) {
		const message = `Deferred ${action.label} failed: ${e}`;
		if (notify) notify(message, "error");
		else console.error(`[pi-control] ${message}`);
	} finally {
		_state.inFlight = null;
	}
	return true;
}

export async function runPending(
	notify?: (msg: string, level: "info" | "warning" | "error") => void,
	runtime?: RuntimeContext,
): Promise<void> {
	// Claim the action into inFlight: the single slot stays occupied for the
	// whole execution (idle wait included), so a turn racing the settled event
	// cannot schedule a second transition that would run concurrently with
	// this one. Released in the finally below — also on cancellation/error.
	const action = _state.pending;
	_state.pending = null;
	if (!action) return;
	_state.inFlight = { kind: action.kind, label: "label" in action && action.label ? action.label : action.kind };
	try {
		await dispatchPending(action, notify, runtime);
	} finally {
		_state.inFlight = null;
	}
}

async function dispatchPending(
	action: PendingAction,
	notify?: (msg: string, level: "info" | "warning" | "error") => void,
	runtime?: RuntimeContext,
): Promise<void> {
	const reportError = (message: string, error?: unknown) => {
		if (notify) {
			notify(error === undefined ? message : `${message}: ${error}`, "error");
			return;
		}
		if (error === undefined) console.error(`[pi-control] ${message}`);
		else console.error(`[pi-control] ${message}:`, error);
	};
	// Cancellations must stay observable in headless (RPC/SDK) runs too, where
	// notify is undefined — fall back to console instead of dropping them.
	const reportWarning = (message: string) => {
		if (notify) notify(message, "warning");
		else console.warn(`[pi-control] ${message}`);
	};

	// "deferred" uses only public pi APIs; every other kind needs captured ops.
	if (action.kind === "deferred") {
		try {
			await action.exec();
		} catch (e) { reportError(`Deferred ${action.label} failed`, e); }
		return;
	}
	const ops = _state.ops;
	if (!ops) return;

	// A prompt may have raced the public settled event into the settled→timer
	// window and started a new turn. Wait for the agent to go idle again so the
	// transition lands on a turn boundary instead of tearing down a running
	// turn (dispose/abort) mid-flight. A TOCTOU window remains between this
	// resolve and the transition's first await — closing it fully needs an
	// upstream pre-publication seam; this is the best a pure extension can do.
	try {
		await ops.waitForIdle?.();
	} catch { /* proceed: transition handles its own errors */ }

	// Builds a withSession option that injects `message` into the replaced session.
	// Pass deliverAs: "followUp" defensively in case the target session happens to be
	// streaming; non-streaming sessions ignore deliverAs so it is a no-op otherwise.
	const withMessage = (message: string | undefined) => {
		if (!message) return undefined;
		return async (newCtx: any) => {
			await newCtx.sendUserMessage(message, { deliverAs: "followUp" });
		};
	};

	switch (action.kind) {
		case "resume": {
			try {
				const opts: any = {};
				const ws = withMessage(action.message);
				if (ws) opts.withSession = ws;
				const r = await ops.switchSession(action.file, opts);
				if (r.cancelled) reportWarning("Session switch cancelled");
			} catch (e) { reportError("Session switch failed", e); }
			return;
		}

		case "new": {
			try {
				const opts: any = { parentSession: action.parentSession };
				const ws = withMessage(action.message);
				if (ws) opts.withSession = ws;
				const r = await ops.newSession(opts);
				if (r.cancelled) reportWarning("New session cancelled");
			} catch (e) { reportError("New session failed", e); }
			return;
		}

		case "nav": {
			try {
				const r = await ops.navigateTree(action.targetId, {
					summarize: action.summarize,
					customInstructions: action.customInstructions,
				});
				if (r.cancelled) reportWarning("Navigation cancelled");
				else if (action.message && runtime) await runtime.sendFollowUp(action.message);
			} catch (e) { reportError("Navigation failed", e); }
			return;
		}

		case "fork": {
			try {
				const opts: any = {};
				const ws = withMessage(action.message);
				if (ws) opts.withSession = ws;
				const r = await ops.fork(action.id, opts);
				if (r.cancelled) reportWarning("Fork cancelled");
			} catch (e) { reportError("Fork failed", e); }
			return;
		}

		case "reload": {
			try {
				await ops.reload();
				if (action.message) {
					// After reload, the shared runner slot is re-captured by the
					// prototype patch during _buildRuntime. Use the fresh extension
					// runtime so the message goes through the new session, not the
					// stale pre-reload pi closure. createCommandContext() intentionally
					// does not expose sendUserMessage except for replaced-session callbacks.
					try {
						const sendUserMessage = _state.runner?.runtime?.sendUserMessage;
						if (typeof sendUserMessage !== "function") throw new Error("fresh runtime has no sendUserMessage");
						await Promise.resolve(sendUserMessage(action.message, { deliverAs: "followUp" }));
					} catch (e) {
						reportError("Post-reload message delivery failed", e);
					}
				}
			} catch (e) { reportError("Reload failed", e); }
			return;
		}

		case "rawOp": {
			try {
				const r = await action.exec();
				if (r && typeof r === "object" && (r as { cancelled?: boolean }).cancelled) {
					reportWarning(`Command-triggered ${action.label} cancelled`);
				}
			} catch (e) { reportError(`Command-triggered ${action.label} failed`, e); }
			return;
		}

		default: {
			// Exhaustiveness: if a new kind is added without a case, TS surfaces it here.
			const _exhaustive: never = action;
			return _exhaustive;
		}
	}
}
