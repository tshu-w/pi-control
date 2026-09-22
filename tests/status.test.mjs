import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const register = await jiti.import("../extensions/index.ts", { default: true });
const modelA = { provider: "provider-a", id: "model-a" };
const modelB = { provider: "provider-b", id: "model-b" };

function setup() {
	const handlers = new Map();
	const forbidPersistence = () => assert.fail("Status must not persist messages or entries");
	register({
		registerTool() {},
		on(event, handler) {
			const callbacks = handlers.get(event) ?? [];
			callbacks.push(handler);
			handlers.set(event, callbacks);
		},
		appendEntry: forbidPersistence,
		sendMessage: forbidPersistence,
		sendUserMessage: forbidPersistence,
	});
	const ctx = {
		model: modelA,
		getContextUsage: () => ({ percent: 20 }),
		sessionManager: {
			appendMessage: forbidPersistence,
			appendCustomEntry: forbidPersistence,
			appendCustomMessageEntry: forbidPersistence,
		},
	};
	return {
		async observe(model = modelA, percent = 20, messages = [{ role: "user", content: "Hello", timestamp: 1 }]) {
			ctx.model = model;
			ctx.getContextUsage = () => ({ percent });
			const original = structuredClone(messages);
			const result = await handlers.get("context")[0]({ type: "context", messages }, ctx);
			const statuses = messages.filter(message => message.customType === "pi-status");
			assert.deepEqual(messages.filter(message => message.customType !== "pi-status"), original);
			assert.ok(statuses.length <= 1);
			if (statuses.length) {
				assert.equal(result.messages, messages);
				assert.equal(statuses[0].role, "custom");
				assert.equal(statuses[0].display, false);
				assert.equal(typeof statuses[0].timestamp, "number");
			} else {
				assert.equal(result, undefined);
			}
			return { status: statuses[0], messages };
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
	const { status, messages: updated } = await observe(modelB, 20, messages);
	assert.equal(status.content, "[pi-control] Switched from model provider-a/model-a to model provider-b/model-b.");
	assert.equal(updated[3], status, "insert immediately after the last user message");
	assert.equal((await observe({ ...modelB })).status, undefined);
	assert.equal((await observe()).status.content, "[pi-control] Switched from model provider-b/model-b to model provider-a/model-a.");
	const sameId = { provider: "provider-b", id: modelA.id };
	assert.equal((await observe(sameId)).status.content, "[pi-control] Switched from model provider-a/model-a to model provider-b/model-a.");
});

test("context thresholds retain rounding, buckets, deduplication and re-entry behavior", async () => {
	const { observe } = setup();
	for (const [percent, expected] of [
		[69.4, undefined],
		[69.5, "Context usage: 70%."],
		[84.4, undefined],
		[84.5, "Context usage: 85%."],
		[94.4, undefined],
		[94.5, "Context usage: 95%."],
		[110, undefined],
		[90, "Context usage: 90%."],
		[75, "Context usage: 75%."],
		[69, undefined],
		[70, "Context usage: 70%."],
		[20, undefined],
		[110, "Context usage: 100%."],
	]) {
		assert.equal((await observe(modelA, percent)).status?.content,
			expected === undefined ? undefined : `[pi-control] ${expected}`, `usage=${percent}`);
	}
});

test("initial high usage still notifies and a simultaneous switch preserves threshold text", async () => {
	const { observe } = setup();
	assert.equal((await observe(modelA, 70)).status.content, "[pi-control] Context usage: 70%.");
	assert.equal((await observe(modelB, 85)).status.content,
		"[pi-control] Switched from model provider-a/model-a to model provider-b/model-b. | Context usage: 85%.");
	assert.equal((await observe(modelB, 90)).status, undefined);
});

test("switch status appends when there is no user message", async () => {
	const { observe } = setup();
	await observe();
	const { status, messages } = await observe(modelB, 20, [{ role: "assistant", content: [], timestamp: 1 }]);
	assert.ok(status);
	assert.equal(messages.at(-1), status);
});

test("empty context and missing model do not initialize model tracking", async () => {
	const { observe } = setup();
	assert.equal((await observe(modelA, 20, [])).status, undefined);
	assert.equal((await observe(null)).status, undefined);
	assert.equal((await observe(modelB)).status, undefined);
	assert.equal((await observe(modelA)).status.content, "[pi-control] Switched from model provider-b/model-b to model provider-a/model-a.");
});

test("shutdown resets model and threshold tracking without persistence", async () => {
	const { observe, shutdown } = setup();
	await observe(modelA, 85);
	await observe(modelB, 85);
	await shutdown();
	assert.equal((await observe(modelA, 85)).status.content, "[pi-control] Context usage: 85%.");
	assert.equal((await observe(modelA, 85)).status, undefined);
});
