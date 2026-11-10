/**
 * Deferred runtime actions.
 *
 * Tools only receive ExtensionContext, but session changes need the
 * ExtensionCommandContext of a slash command. Tools record the action and end
 * the turn; on agent_settled pi-control dispatches its internal bridge command,
 * whose handler performs the action with its command context.
 *
 * Private API: the commands router needs the ExtensionRunner to call
 * third-party handlers, so ExtensionRunner.prototype.bindCommandContext is
 * patched to capture it.
 */

import { randomUUID } from "node:crypto";
import { ExtensionRunner, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const BRIDGE_COMMAND = "pi-control-internal";

// ── Types ───────────────────────────────────────────────────

/** At most one action is pending per session; see scheduleAction(). */
export type PendingAction =
	| { kind: "resume"; file: string; message?: string }
	| { kind: "new"; parentSession?: string; message?: string }
	| { kind: "nav"; targetId: string; summarize?: boolean; customInstructions?: string; message?: string }
	| { kind: "fork"; id: string; message?: string }
	| { kind: "reload"; message?: string }
	/** Requested by a third-party handler run through the commands router. */
	| { kind: "rawOp"; token: symbol; label: string; exec: (ctx: ExtensionCommandContext) => Promise<{ cancelled?: boolean } | void> }
	/** Public-API work run inline on agent_settled (model switch). */
	| { kind: "deferred"; label: string; exec: () => Promise<void> };

// ── Session-scoped state ────────────────────────────────────

interface CommandState {
	pending: PendingAction | null;
	/** Set while an action executes. Occupies the single slot so nothing
	 *  schedules a second transition while the first is mid-teardown. */
	inFlight: { kind: string; label: string } | null;
	/** Token the bridge command must receive; set when it is dispatched. */
	dispatchToken: string | null;
	/** Follow-up queued behind the bridge command for navigate and reload.
	 *  It is the first extension input after the command finishes (`ready`),
	 *  and the input handler drops it when the action did not happen. */
	followUp: { ready: boolean; drop: boolean } | null;
	runner: any;
}

interface CommandRegistry {
	states: WeakMap<object, CommandState>;
	patched: boolean;
}

const REGISTRY_KEY = Symbol.for("pi-control:command-actions");
const registry = ((globalThis as any)[REGISTRY_KEY] ??= {
	states: new WeakMap<object, CommandState>(),
	patched: false,
}) as CommandRegistry;

export type CommandOwner = object;

function ownerKey(owner: CommandOwner): object {
	const sessionManager = (owner as any)?.sessionManager;
	return sessionManager && typeof sessionManager === "object" ? sessionManager : owner;
}

function stateFor(owner: CommandOwner, create = false): CommandState | undefined {
	const key = ownerKey(owner);
	let state = registry.states.get(key);
	if (!state && create) {
		state = { pending: null, inFlight: null, dispatchToken: null, followUp: null, runner: null };
		registry.states.set(key, state);
	}
	return state;
}

// ── Accessors ───────────────────────────────────────────────

/** True while the session's single slot is occupied — by a scheduled action or
 *  one currently executing. */
export function hasPending(owner: CommandOwner): boolean {
	const state = stateFor(owner);
	return state?.pending != null || state?.inFlight != null;
}
/** True only when an action is scheduled but not yet claimed. */
export function hasQueuedAction(owner: CommandOwner): boolean { return stateFor(owner)?.pending != null; }
const KIND_LABELS: Record<string, string> = {
	resume: "session switch",
	new: "new session",
	nav: "tree navigation",
	fork: "fork",
	reload: "reload",
};
function actionLabel(action: PendingAction): string {
	return "label" in action ? action.label : KIND_LABELS[action.kind]!;
}
/** Why the session's single slot is taken, e.g. "a fork is already scheduled". */
function busyReason(state: CommandState): string | undefined {
	if (state.inFlight) return `a ${state.inFlight.label} is in progress`;
	if (state.pending) return `a ${actionLabel(state.pending)} is already scheduled`;
	return undefined;
}
/** The ExtensionRunner instance captured for this session. */
export function getRunner(owner: CommandOwner): any { return stateFor(owner)?.runner ?? null; }

export function clearPending(owner: CommandOwner): void {
	const state = stateFor(owner);
	if (state) state.pending = null;
}

export interface ScheduleParams {
	/** The action to schedule. */
	action: PendingAction;
	/** Success text shown to the model when the action was scheduled. */
	successText: string;
	/** Persisted metadata for rendering, state, or follow-up location. */
	details?: Record<string, any>;
}

/** Router-facing helper: validate the slot, store the action, end the turn. */
export function scheduleAction(owner: CommandOwner, params: ScheduleParams): { content: Array<{ type: "text"; text: string }>; details: Record<string, any>; terminate: true } {
	const state = stateFor(owner, true)!;
	const busy = busyReason(state);
	if (busy) {
		throw new Error(`Cannot schedule this change: ${busy}. Try again after it takes effect.`);
	}
	state.pending = params.action;
	return {
		content: [{ type: "text", text: params.successText }],
		details: params.details ?? {},
		terminate: true,
	};
}

/** Schedule public-API work for agent_settled. Any pending action rejects the request. */
export function scheduleDeferred(owner: CommandOwner, label: string, exec: () => Promise<void>): { ok: true } | { ok: false; reason: string } {
	const state = stateFor(owner, true)!;
	const busy = busyReason(state);
	if (busy) return { ok: false, reason: busy };
	state.pending = { kind: "deferred", label, exec };
	return { ok: true };
}

/** Lower-level helper for the commands router. Returns the reason if busy. */
export function scheduleRawOp(owner: CommandOwner, label: string, exec: (ctx: ExtensionCommandContext) => Promise<{ cancelled?: boolean } | void>): { ok: true; token: symbol } | { ok: false; reason: string } {
	const state = stateFor(owner, true)!;
	const busy = busyReason(state);
	if (busy) return { ok: false, reason: busy };
	const token = Symbol(label);
	state.pending = { kind: "rawOp", token, label, exec };
	return { ok: true, token };
}

export function isPendingRawOp(owner: CommandOwner, token: symbol): boolean {
	const pending = stateFor(owner)?.pending;
	return pending?.kind === "rawOp" && pending.token === token;
}

export function clearPendingRawOp(owner: CommandOwner, token: symbol): boolean {
	if (!isPendingRawOp(owner, token)) return false;
	clearPending(owner);
	return true;
}

// ── Patch ───────────────────────────────────────────────────

export function patchBindCommandContext(): boolean {
	if (registry.patched) return true;
	try {
		const current = ExtensionRunner.prototype.bindCommandContext;
		if (typeof current !== "function") return false;

		ExtensionRunner.prototype.bindCommandContext = function (actions: any) {
			// Capture the runner so the commands router can call getCommand() /
			// createCommandContext().
			stateFor(this, true)!.runner = actions ? this : null;
			return current.call(this, actions);
		};
		registry.patched = true;
		return true;
	} catch {
		return false;
	}
}

// ── Execute pending actions ─────────────────────────────────

type Notify = (msg: string, level: "info" | "warning" | "error") => void;

/** Run a pending "deferred" action inline, inside the agent_settled emit.
 *  Core publishes settled to SDK/RPC/UI listeners and resolves idle only
 *  after extension handlers return, so awaiting the model switch here closes
 *  the race where an external prompt starts the next turn on the old model.
 *  Returns true when a deferred action was consumed. */
export async function runPendingDeferredInline(owner: CommandOwner, notify?: Notify): Promise<boolean> {
	const state = stateFor(owner);
	if (state?.pending?.kind !== "deferred") return false;
	const action = state.pending;
	state.pending = null;
	state.inFlight = { kind: action.kind, label: action.label };
	try {
		await action.exec();
	} catch (e) {
		const message = `Deferred ${action.label} failed: ${e}`;
		if (notify) notify(message, "error");
		else console.error(`[pi-control] ${message}`);
	} finally {
		state.inFlight = null;
	}
	return true;
}

/** Called from agent_settled: dispatch the bridge command for a pending
 *  session action. Messages sent during agent_settled run in order after all
 *  settled handlers finish, and single-shot modes wait for them, so a
 *  navigate or reload follow-up is queued right behind the command. */
export function dispatchPending(pi: ExtensionAPI, owner: CommandOwner): void {
	const state = stateFor(owner);
	const action = state?.pending;
	if (!state || !action || action.kind === "deferred") return;
	state.dispatchToken = randomUUID();
	pi.sendUserMessage(`/${BRIDGE_COMMAND} ${state.dispatchToken}`, { expandPromptTemplates: true });
	if ((action.kind === "nav" || action.kind === "reload") && action.message) {
		state.followUp = { ready: false, drop: false };
		pi.sendUserMessage(action.message);
	}
}

export function registerBridge(pi: ExtensionAPI): void {
	pi.registerCommand(BRIDGE_COMMAND, {
		description: "Internal step of pi-control tools; does nothing when run by hand",
		handler: async (args, ctx) => {
			const state = stateFor(ctx);
			if (!state?.dispatchToken || args.trim() !== state.dispatchToken) return;
			state.dispatchToken = null;
			const action = state.pending;
			if (!action || action.kind === "deferred") return;
			state.pending = null;
			state.inFlight = { kind: action.kind, label: actionLabel(action) };
			const notify: Notify | undefined = ctx.hasUI ? (msg, level) => ctx.ui.notify(msg, level) : undefined;
			let done = false;
			try {
				// A prompt that raced the settled event finishes before the
				// session is replaced.
				await ctx.waitForIdle();
				done = await runAction(ctx, action, notify);
			} finally {
				state.inFlight = null;
				if (state.followUp) state.followUp = { ready: true, drop: !done };
			}
		},
	});

	// Drop the queued navigate/reload follow-up when the action did not happen.
	// Match by position: earlier input handlers may have transformed its text.
	pi.on("input", (event, ctx) => {
		if (event.source !== "extension") return;
		const state = stateFor(ctx);
		const followUp = state?.followUp;
		if (!followUp?.ready) return;
		state.followUp = null;
		if (followUp.drop) return { action: "handled" };
	});
	// An earlier input handler may have consumed the follow-up; any later run
	// means its turn has passed.
	pi.on("agent_start", (_event, ctx) => {
		const state = stateFor(ctx);
		if (state?.followUp?.ready) state.followUp = null;
	});
}

/** Returns true when the action took effect. */
async function runAction(ctx: ExtensionCommandContext, action: Exclude<PendingAction, { kind: "deferred" }>, notify?: Notify): Promise<boolean> {
	const reportError = (message: string, error: unknown) => {
		if (notify) notify(`${message}: ${error}`, "error");
		else console.error(`[pi-control] ${message}:`, error);
	};
	// Cancellations must stay observable in headless (RPC/SDK) runs too, where
	// notify is undefined — fall back to console instead of dropping them.
	const reportWarning = (message: string) => {
		if (notify) notify(message, "warning");
		else console.warn(`[pi-control] ${message}`);
	};
	const done = (result: { cancelled?: boolean } | void, cancelledMessage: string) => {
		if (result && result.cancelled) {
			reportWarning(cancelledMessage);
			return false;
		}
		return true;
	};
	// Sends `message` in the replaced session.
	const withMessage = (message: string | undefined) => {
		if (!message) return undefined;
		return async (newCtx: any) => {
			await newCtx.sendUserMessage(message);
		};
	};

	try {
		switch (action.kind) {
			case "resume":
				return done(await ctx.switchSession(action.file, { withSession: withMessage(action.message) }), "Session switch cancelled");
			case "new":
				return done(await ctx.newSession({ parentSession: action.parentSession, withSession: withMessage(action.message) }), "New session cancelled");
			case "nav":
				return done(await ctx.navigateTree(action.targetId, {
					summarize: action.summarize,
					customInstructions: action.customInstructions,
				}), "Navigation cancelled");
			case "fork":
				return done(await ctx.fork(action.id, { withSession: withMessage(action.message) }), "Fork cancelled");
			case "reload":
				await ctx.reload();
				return true;
			case "rawOp":
				return done(await action.exec(ctx), `Command-triggered ${action.label} cancelled`);
			default: {
				const _exhaustive: never = action;
				return _exhaustive;
			}
		}
	} catch (e) {
		const label = actionLabel(action);
		reportError(action.kind === "rawOp" ? `Command-triggered ${label} failed` : `${label[0]!.toUpperCase()}${label.slice(1)} failed`, e);
		return false;
	}
}
