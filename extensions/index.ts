/**
 * Pi Control — self-control layer for pi.
 *
 * 4 router tools, always active:
 *   sessions  — session management (info, search, resume, new, name, queue_message, reload)
 *   tree      — session entry operations (list, search, labels, set_label, navigate, fork, compact)
 *   models    — model listing, switching, and consultation
 *   commands  — dispatch arbitrary third-party slash commands (e.g. /ssh, /uv) as tool calls
 *
 * Tells the model when the active model changed since its previous request.
 * The notice is appended to history to preserve prompt caches.
 *
 * Session actions run on agent_settled through an internal bridge command
 * (see command-actions.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { patchBindCommandContext, runPendingDeferredInline, dispatchPending, registerBridge, clearPending, getRunner, hasQueuedAction } from "./command-actions.js";
import { registerSessionsRouter } from "./session.js";
import { registerTreeRouter } from "./tree.js";
import { registerModelsRouter } from "./model.js";
import { registerCommandsRouter } from "./commands.js";

export default function (pi: ExtensionAPI) {
	let lastModel: string | null = null;

	// Patch ExtensionRunner to capture it for commands(action='run').
	const patchOk = patchBindCommandContext();

	registerBridge(pi);

	registerSessionsRouter(pi);
	registerTreeRouter(pi);
	registerModelsRouter(pi);
	registerCommandsRouter(pi);

	// ── Model-switch notice ──
	pi.on("context", async (event, ctx) => {
		if (event.messages.length === 0 || !ctx.model) return;
		const modelId = `${ctx.model.provider}/${ctx.model.id}`;
		const previous = lastModel;
		lastModel = modelId;
		if (previous === null || previous === modelId) return;
		// Pi appends this after pending tool results, without starting another turn.
		pi.sendMessage({
			customType: "pi-status",
			content: `[pi-control] Switched from model ${previous} to model ${modelId}.`,
			display: false,
		}, { triggerTurn: false });
	});

	// ── Execute pending actions after agent fully settles ──
	// agent_settled fires only when no auto-retry, compaction retry, or queued
	// follow-up remains.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!hasQueuedAction(ctx)) return;
		const notify = ctx.hasUI
			? (msg: string, level: "info" | "warning" | "error") => ctx.ui.notify(msg, level)
			: undefined;
		// Deferred public-API work (model switch) completes inside this emit:
		// core publishes settled to external listeners and resolves idle only
		// after extension handlers return, so an external prompt racing the
		// settled event already sees the new model.
		if (await runPendingDeferredInline(ctx, notify)) return;
		dispatchPending(pi, ctx);
	});

	// Warn once if commands(action='run') cannot reach Pi's command runner.
	let warnedOnce = false;
	pi.on("session_start", async (_event, ctx) => {
		if (warnedOnce || (patchOk && getRunner(ctx))) return;
		warnedOnce = true;
		if (ctx.hasUI) ctx.ui.notify("pi-control: commands(action='run') is unavailable in this Pi version.", "warning");
	});

	// Clear stale pending state on session shutdown. Only unclaimed queued
	// actions are stale: a transition in flight fires session_shutdown itself
	// (core emits it before switchSession/reload resolve) and is released by
	// the bridge command's finally, not here.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (hasQueuedAction(ctx)) {
			console.warn("[pi-control] session_shutdown fired while a transition was pending; dropping it.");
		}
		clearPending(ctx);
		lastModel = null;
	});
}
