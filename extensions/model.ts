import { complete, getModel, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderToolCall } from "./render-call.js";
import { scheduleDeferred } from "./command-actions.js";
import { withToolOutputContract } from "./tool-output.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function scopedModels(ctx: any, available: any[]): any[] {
	return ctx.scopedModels.length > 0
		? ctx.scopedModels.map((entry: any) => entry.model)
		: available;
}

/**
 * Resolve a model by id (and optional provider), preferring scoped models.
 *
 * If `provider` is given, looks up directly via the registry.
 * If not, prefers a scoped match (matching settings.json `enabledModels`),
 * then falls back to any available model with the same id.
 *
 * `includeUnregistered` (only for consult) lets callers fall back to
 * `getModel(provider, modelId)` so consult can hit a model the registry
 * doesn't yet know but that does have an API key configured.
 */
async function resolveModel(
	ctx: any,
	provider: string | undefined,
	modelId: string,
	opts?: { includeUnregistered?: boolean },
): Promise<{ model: any | null; error?: string }> {
	const available = await ctx.modelRegistry.getAvailable();
	const providerMap = new Map<string, string>();
	for (const m of available) providerMap.set(m.provider.toLowerCase(), m.provider);

	let resolvedProvider = provider ? (providerMap.get(provider.toLowerCase()) ?? provider) : undefined;
	let resolvedModelId = modelId;

	const slashIndex = modelId.indexOf("/");
	if (slashIndex !== -1) {
		const maybeProvider = modelId.substring(0, slashIndex);
		const rest = modelId.substring(slashIndex + 1);
		const canonical = providerMap.get(maybeProvider.toLowerCase());
		if (canonical) {
			if (resolvedProvider && resolvedProvider !== canonical) {
				return { model: null, error: `Provider mismatch: provider=${resolvedProvider}, modelId=${modelId}.` };
			}
			resolvedProvider = canonical;
			resolvedModelId = rest;
		}
	}

	if (resolvedProvider) {
		const found = ctx.modelRegistry.find(resolvedProvider, resolvedModelId);
		if (found) return { model: found };
		if (opts?.includeUnregistered) return { model: getModel(resolvedProvider as any, resolvedModelId) };
		return { model: null };
	}

	const findMatches = (models: any[]) => models.filter((m: any) => m.id === resolvedModelId || `${m.provider}/${m.id}` === resolvedModelId);
	if (ctx.scopedModels.length > 0) {
		const scopedMatches = findMatches(scopedModels(ctx, available));
		if (scopedMatches.length === 1) return { model: scopedMatches[0] };
		if (scopedMatches.length > 1) {
			return { model: null, error: `Ambiguous modelId "${modelId}" in scoped models. Use provider/modelId or pass provider.` };
		}
	}

	const matches = findMatches(available);
	if (matches.length === 1) return { model: matches[0] };
	if (matches.length > 1) {
		return { model: null, error: `Ambiguous modelId "${modelId}". Use provider/modelId or pass provider.` };
	}
	return { model: null };
}

export function registerModelsRouter(pi: ExtensionAPI) {
	pi.registerTool(withToolOutputContract({
		name: "models",
		label: "Models",
		description: [
			"Model listing, switching, and consultation.",
			"list: show available models (scoped or all).",
			"switch: schedule a model change that applies when the current turn ends; include `message` to drive the next turn on the new model.",
			"consult: one-shot call to another model (no tool access, result inline).",
		].join(" "),
		promptSnippet: "List, switch, or consult pi models",
		promptGuidelines: [
			"Use models(action='list') to discover available scoped models when the target is uncertain.",
			"Use models(action='switch', modelId=..., message=...) to hand off: the switch applies when the current turn ends and the message starts the next turn on the new model \u2014 finish your turn right after calling it.",
			"Use models(action='consult', prompt=...) for a one-shot second opinion or review without changing the active model.",
			"Prefer scoped models; use scope='all' only when the user asks or scoped results are insufficient.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "switch", "consult"] as const, {
				description: "Action to perform",
			}),
			// list params
			scope: Type.Optional(StringEnum(["scoped", "all"] as const, { description: '"scoped" (default) or "all". For list.' })),
			filter: Type.Optional(Type.String({ description: "Filter by provider or model name substring. For list." })),
			// switch / consult params
			provider: Type.Optional(Type.String({ description: "Model provider. Optional if modelId uses provider/modelId or is unambiguous. For switch/consult." })),
			modelId: Type.Optional(Type.String({ description: 'Model ID or provider/modelId, e.g. "gpt-5.5" or "openai-codex/gpt-5.5". For switch/consult.' })),
			thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level. For switch or consult." })),
			message: Type.Optional(Type.String({ description: "Directive for the next turn, delivered as a user message after the switch applies at end of the current turn. For switch." })),
			// consult params
			prompt: Type.Optional(Type.String({ description: "Prompt to send. For consult." })),
			systemPrompt: Type.Optional(Type.String({ description: "Optional system prompt. For consult." })),
		}),
		renderCall(args, theme, context) {
			return renderToolCall("models", args, theme, !context.isPartial);
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			switch (params.action) {
				// ── list ─────────────────────────────────────────────
				case "list": {
					const scope = params.scope ?? "scoped";
					const available = await ctx.modelRegistry.getAvailable();

					let candidates = available;
					if (scope === "scoped") {
						candidates = scopedModels(ctx, available);
					}

					const filter = params.filter?.toLowerCase();
					const filtered = filter
						? candidates.filter(m =>
							`${m.provider}/${m.id}`.toLowerCase().includes(filter)
							|| (m.name ?? "").toLowerCase().includes(filter)
						)
						: candidates;

					const header = scope === "scoped" && ctx.scopedModels.length > 0
						? `scoped models (${ctx.scopedModels.length} configured)`
						: scope === "scoped"
							? "no scoped models configured, showing all:"
							: "all available models:";

					if (filtered.length === 0) {
						return {
							content: [{ type: "text", text: `${header}\nNo models found${filter ? ` matching "${params.filter}"` : ""}. Check API keys.` }],
							details: { scope, models: [] },
						};
					}

					const lines = filtered.map(m =>
						`- \`${m.provider}/${m.id}\`  ctx:${m.contextWindow}  reasoning:${m.reasoning ?? false}`
					);

					return {
						content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
						details: { scope, models: filtered.map(m => ({ provider: m.provider, id: m.id })) },
					};
				}

				// ── switch ──────────────────────────────────────────
				case "switch": {
					if (!params.modelId) {
						return { content: [{ type: "text", text: "`modelId` is required for switch." }], details: {} };
					}

					const resolved = await resolveModel(ctx, params.provider, params.modelId);
					if (!resolved.model) {
						return {
							content: [{ type: "text", text: resolved.error ?? `Model not found: ${params.provider ?? "(auto)"}/${params.modelId}. Use models(action='list') to find valid models.` }],
							details: {},
						};
					}
					const model = resolved.model;

					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok || !auth.apiKey) {
						return { content: [{ type: "text", text: `No API key for ${model.provider}/${model.id}.` }], details: {} };
					}

					// Deferred switch: the model change (and thinking level) applies on
					// agent_settled, so each turn belongs to exactly one model and the
					// message reliably starts the next turn. Mid-turn switching relied
					// on the new model choosing to end the turn, which newer models
					// no longer do: queued follow-ups accumulated instead.
					const scheduled = scheduleDeferred(ctx, `model switch to ${model.provider}/${model.id}`, async () => {
						const ok = await pi.setModel(model);
						if (!ok) throw new Error(`setModel failed for ${model.provider}/${model.id}`);
						if (params.thinkingLevel) pi.setThinkingLevel(params.thinkingLevel);
						// Upstream limit: ExtensionAPI.sendUserMessage returns void, so
						// delivery cannot be awaited; failures surface as extension errors.
						if (params.message) pi.sendUserMessage(params.message, { deliverAs: "followUp" });
					});
					if (!scheduled.ok) {
						return { content: [{ type: "text", text: `Cannot schedule switch: ${scheduled.reason}.` }], details: {} };
					}

					return {
						content: [{ type: "text", text: `switch to ${model.provider}/${model.id} scheduled at end of this turn${params.message ? "; your message will start the next turn as a user message" : ""}. Finish your turn now.` }],
						details: { provider: model.provider, modelId: model.id, thinkingLevel: params.thinkingLevel, scheduled: true, messageScheduled: params.message !== undefined },
					};
				}

				// ── consult ─────────────────────────────────────────
				case "consult": {
					if (!params.modelId || !params.prompt) {
						return { content: [{ type: "text", text: "`modelId` and `prompt` are required for consult." }], details: {} };
					}

					const resolved = await resolveModel(ctx, params.provider, params.modelId, { includeUnregistered: true });
					if (!resolved.model) {
						return { content: [{ type: "text", text: resolved.error ?? `Model not found: ${params.provider ?? "(auto)"}/${params.modelId}` }], details: {} };
					}
					const model = resolved.model;

					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok || !auth.apiKey) {
						return { content: [{ type: "text", text: `No API key for ${model.provider}/${model.id}` }], details: {} };
					}

					const thinkingLevel = params.thinkingLevel;
					const useReasoning = !!(model.reasoning && thinkingLevel && thinkingLevel !== "off");
					const completeOpts: any = { apiKey: auth.apiKey, headers: auth.headers, signal };
					if (useReasoning) completeOpts.reasoning = thinkingLevel;

					onUpdate?.({ content: [{ type: "text", text: `Consulting ${model.provider}/${model.id}${useReasoning ? ` (thinking: ${thinkingLevel})` : ""}...` }], details: {} });

					const response = await complete(
						model,
						{
							systemPrompt: params.systemPrompt ?? "You are a helpful assistant. Be concise and precise.",
							messages: [{ role: "user", content: [{ type: "text", text: params.prompt }], timestamp: Date.now() }],
						},
						completeOpts,
					);

					if (response.stopReason === "aborted") {
						return { content: [{ type: "text", text: "Consultation aborted." }], details: {}, usage: response.usage };
					}

					const text = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map(c => c.text).join("\n");

					const usage = response.usage;
					const stats = [
						usage ? `↑${usage.input} ↓${usage.output}` : "",
						usage?.cost?.total ? `$${usage.cost.total.toFixed(4)}` : "",
					].filter(Boolean).join(" ");

					return {
						content: [{ type: "text", text: `response from ${model.provider}/${model.id}${useReasoning ? ` (thinking: ${thinkingLevel})` : ""} ${stats}\n\n${text}` }],
						details: { provider: model.provider, modelId: model.id, thinkingLevel: useReasoning ? thinkingLevel : undefined },
						usage,
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: "${params.action}"` }], details: {} };
			}
		},
	}, {
		preserveFullOutput: (params) => params.action === "consult",
		tempPrefix: "pi-control-consult",
	}));
}
