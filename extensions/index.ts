/**
 * Pi Control — self-control layer for pi.
 *
 * 4 router tools, always active:
 *   sessions  — session management (info, search, resume, new, name, queue_message, reload)
 *   tree      — session entry operations (list, search, labels, set_label, navigate, fork, compact)
 *   models    — model listing, switching, and consultation
 *   commands  — dispatch arbitrary third-party slash commands (e.g. /ssh, /uv) as tool calls
 *
 * Records runtime status only on model switches and context threshold
 * crossings. Messages are appended to history to preserve prompt caches.
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

// ── Event-driven status injection state ──
function contextBucket(pct: number): string | null {
	if (pct >= 95) return "critical";
	if (pct >= 85) return "very-high";
	if (pct >= 70) return "high";
	return null;
}

export default function (pi: ExtensionAPI) {
	let lastModel: string | null = null;
	let lastContextBucket: string | null = null;

	// Patch ExtensionRunner to capture it for commands(action='run').
	const patchOk = patchBindCommandContext();

	registerBridge(pi);

	registerSessionsRouter(pi);
	registerTreeRouter(pi);
	registerModelsRouter(pi);
	registerCommandsRouter(pi);

	// ── Record runtime status only on state changes ──
	pi.on("context", async (event, ctx) => {
		const messages = event.messages;
		if (!messages || messages.length === 0) return;

		const currentModel = ctx.model;
		if (!currentModel) return;

		const modelId = `${currentModel.provider}/${currentModel.id}`;
		const usage = ctx.getContextUsage?.();
		const ctxPct = (usage && typeof usage.percent === "number") ? Math.min(100, Math.round(usage.percent)) : 0;

		// ── Determine what changed ──
		const reasons: string[] = [];

		if (lastModel !== null && modelId !== lastModel) {
			reasons.push(`Switched from model ${lastModel} to model ${modelId}.`);
		}
		lastModel = modelId;

		const cb = contextBucket(ctxPct);
		if (cb && cb !== lastContextBucket) {
			reasons.push(`Context usage: ${ctxPct}%.`);
		}
		lastContextBucket = cb;

		// Nothing changed — skip injection entirely.
		if (reasons.length === 0) return;

		// Pi appends this after pending tool results, without starting another turn.
		pi.sendMessage({
			customType: "pi-status",
			content: `[pi-control] ${reasons.join(" | ")}`,
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
		lastContextBucket = null;
	});
}
