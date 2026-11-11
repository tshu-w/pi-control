import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const register = await jiti.import("../extensions/index.ts", { default: true });
const modelA = { provider: "provider-a", id: "model-a" };
const modelB = { provider: "provider-b", id: "model-b" };

function setup() {
	const handlers = new Map();
	const forbidPersistence = () => assert.fail("Status must use sendMessage");
	const sent = [];
	register({
		registerTool() {},
		registerCommand() {},
		on(event, handler) {
			const callbacks = handlers.get(event) ?? [];
			callbacks.push(handler);
			handlers.set(event, callbacks);
		},
		appendEntry: forbidPersistence,
		sendMessage(message, options) {
			assert.deepEqual(options, { triggerTurn: false });
			sent.push({ role: "custom", ...message, timestamp: Date.now() });
		},
		sendUserMessage: forbidPersistence,
	});
	const ctx = {
		model: modelA,
		sessionManager: {
			appendMessage: forbidPersistence,
			appendCustomEntry: forbidPersistence,
			appendCustomMessageEntry: forbidPersistence,
		},
	};
	return {
		async observe(model = modelA, messages = [{ role: "user", content: "Hello", timestamp: 1 }]) {
			ctx.model = model;
			const original = structuredClone(messages);
			const start = sent.length;
			const result = await handlers.get("context")[0]({ type: "context", messages }, ctx);
			assert.deepEqual(messages, original, "request history must remain unchanged");
			assert.equal(result, undefined);
			const statuses = sent.slice(start);
			assert.ok(statuses.length <= 1);
			if (statuses.length) {
				assert.equal(statuses[0].role, "custom");
				assert.equal(statuses[0].display, false);
				assert.equal(typeof statuses[0].timestamp, "number");
			} else {
				assert.equal(result, undefined);
			}
			return { status: statuses[0], messages: [...messages, ...statuses] };
		},
		async shutdown() {
			for (const handler of handlers.get("session_shutdown")) {
				await handler({ type: "session_shutdown" }, ctx);
			}
		},
	};
}

test("initial model observation and repeated observations are silent", async () => {
	const { observe } = setup();
	assert.equal((await observe()).status, undefined);
	assert.equal((await observe({ ...modelA })).status, undefined);
});

test("actual switches name the previous and current models exactly and do not repeat", async () => {
	const { observe } = setup();
	await observe();
	const messages = [
		{ role: "user", content: "First", timestamp: 1 },
		{ role: "assistant", content: [], timestamp: 2 },
		{ role: "user", content: "Next", timestamp: 3 },
		{ role: "assistant", content: [], timestamp: 4 },
	];
	const { status, messages: updated } = await observe(modelB, messages);
	assert.equal(status.content, "[pi-control] Switched from model provider-a/model-a to model provider-b/model-b.");
	assert.equal(updated.at(-1), status, "append after existing history");
	assert.equal((await observe({ ...modelB })).status, undefined);
	assert.equal((await observe()).status.content, "[pi-control] Switched from model provider-b/model-b to model provider-a/model-a.");
	const sameId = { provider: "provider-b", id: modelA.id };
	assert.equal((await observe(sameId)).status.content, "[pi-control] Switched from model provider-a/model-a to model provider-b/model-a.");
});

test("successive tool turns retain status messages without changing the cached prefix", async () => {
	const { observe } = setup();
	let history = [{ role: "user", content: "Work", timestamp: 1 }];
	await observe(modelA, history);
	for (const [index, model] of [modelB, modelB, modelA].entries()) {
		const prefix = structuredClone(history);
		history.push(
			{ role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} }], timestamp: index + 2 },
			{ role: "toolResult", toolCallId: `call-${index}`, content: [{ type: "text", text: "result" }], timestamp: index + 2 },
		);
		const result = await observe(model, history);
		history = result.messages;
		assert.deepEqual(history.slice(0, prefix.length), prefix);
	}
	assert.equal(history.filter(message => message.customType === "pi-status").length, 2);
});

test("switch status appends when there is no user message", async () => {
	const { observe } = setup();
	await observe();
	const { status, messages } = await observe(modelB, [{ role: "assistant", content: [], timestamp: 1 }]);
	assert.ok(status);
	assert.equal(messages.at(-1), status);
});

test("empty context and missing model do not initialize model tracking", async () => {
	const { observe } = setup();
	assert.equal((await observe(modelA, [])).status, undefined);
	assert.equal((await observe(null)).status, undefined);
	assert.equal((await observe(modelB)).status, undefined);
	assert.equal((await observe(modelA)).status.content, "[pi-control] Switched from model provider-b/model-b to model provider-a/model-a.");
});

test("shutdown resets model tracking", async () => {
	const { observe, shutdown } = setup();
	await observe(modelA);
	await shutdown();
	assert.equal((await observe(modelB)).status, undefined);
	assert.equal((await observe(modelA)).status.content, "[pi-control] Switched from model provider-b/model-b to model provider-a/model-a.");
});
