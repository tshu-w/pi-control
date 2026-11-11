// Deferred-action layer: scheduling, the agent_settled bridge command, and
// the queued navigate/reload follow-up, driven with recording fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import {
	BRIDGE_COMMAND, patchBindCommandContext, registerBridge, dispatchPending, scheduleAction, scheduleRawOp, scheduleDeferred,
	runPendingDeferredInline, clearPending, hasPending, hasQueuedAction, getRunner,
} from "../extensions/command-actions.ts";

const owner = {};
const schedule = (action, target = owner) => scheduleAction(target, { action, successText: "scheduled", details: {} });

function bridge() {
	const handlers = {};
	const commands = {};
	const sent = [];
	const pi = {
		on: (event, handler) => { (handlers[event] ??= []).push(handler); },
		registerCommand: (name, options) => { commands[name] = options; },
		sendUserMessage: (text, options) => { sent.push([text, options]); },
	};
	registerBridge(pi);
	const calls = [];
	const notes = [];
	let behavior = {};
	const record = (name) => async (...args) => {
		calls.push([name, ...args]);
		if (behavior.gate) await behavior.gate;
		if (behavior.throwError) throw behavior.throwError;
		return { cancelled: !!behavior.cancelled };
	};
	const ctx = (sessionManager = owner, hasUI = false) => ({
		sessionManager,
		hasUI,
		ui: { notify: (message, level) => notes.push([level, message]) },
		waitForIdle: async () => { calls.push(["waitForIdle"]); },
		switchSession: record("switchSession"),
		newSession: record("newSession"),
		navigateTree: record("navigateTree"),
		fork: record("fork"),
		reload: async () => { calls.push(["reload"]); if (behavior.throwError) throw behavior.throwError; },
	});
	const settle = (sessionManager = owner) => {
		const start = sent.length;
		dispatchPending(pi, { sessionManager });
		return sent.slice(start);
	};
	const run = (args, commandCtx = ctx()) => commands[BRIDGE_COMMAND].handler(args, commandCtx);
	const input = (text, source = "extension", sessionManager = owner) => handlers.input[0]({ type: "input", text, source }, { sessionManager });
	const agentStart = (sessionManager = owner) => handlers.agent_start[0]({ type: "agent_start" }, { sessionManager });
	return { commands, calls, notes, ctx, settle, run, input, agentStart, set: (value) => { behavior = value; } };
}

const tokenOf = ([[text]]) => text.split(" ")[1];

test("scheduled actions end the turn; a second schedule is rejected", () => {
	const result = schedule({ kind: "resume", file: "/tmp/a.jsonl" });
	assert.equal(result.terminate, true);
	assert.throws(() => schedule({ kind: "reload" }), /Cannot schedule this change: a session switch is already scheduled\. Try again after it takes effect\./);
	assert.deepEqual(scheduleDeferred(owner, "model switch to a/b", async () => {}), { ok: false, reason: "a session switch is already scheduled" });
	assert.equal(scheduleRawOp(owner, "reload", async () => {}).ok, false);
	clearPending(owner);
});

test("settle dispatches the bridge command, which runs the action once", async () => {
	const b = bridge();
	assert.match(b.commands[BRIDGE_COMMAND].description, /Internal.*does nothing when run by hand/);
	schedule({ kind: "resume", file: "/tmp/a.jsonl", message: "next" });
	const sent = b.settle();
	assert.equal(sent.length, 1, "resume sends its follow-up inside the replaced session");
	assert.match(sent[0][0], new RegExp(`^/${BRIDGE_COMMAND} [0-9a-f-]{36}$`));
	assert.deepEqual(sent[0][1], { expandPromptTemplates: true });

	await b.run(tokenOf(sent));
	assert.deepEqual(b.calls.map(([name]) => name), ["waitForIdle", "switchSession"]);
	assert.equal(b.calls[1][1], "/tmp/a.jsonl");
	const replaced = [];
	await b.calls[1][2].withSession({ sendUserMessage: async (text) => replaced.push(text) });
	assert.deepEqual(replaced, ["next"]);
	assert.equal(hasPending(owner), false);

	await b.run(tokenOf(sent));
	assert.equal(b.calls.length, 2, "a used token runs nothing");
});

test("typed by hand, the bridge command does nothing", async () => {
	const b = bridge();
	schedule({ kind: "reload" });
	await b.run("");
	b.settle();
	await b.run("00000000-0000-0000-0000-000000000000");
	assert.deepEqual(b.calls, []);
	assert.equal(hasQueuedAction(owner), true);
	clearPending(owner);
});

test("navigate and reload queue the follow-up behind the command and drop it when the action fails", async () => {
	const b = bridge();
	schedule({ kind: "nav", targetId: "entry-1", message: "go on" });
	let sent = b.settle();
	assert.deepEqual(sent[1], ["go on", undefined]);
	await b.run(tokenOf(sent));
	assert.deepEqual(b.calls[1].slice(0, 2), ["navigateTree", "entry-1"]);
	assert.equal(b.input("go on"), undefined, "the follow-up passes after a successful navigation");

	b.set({ cancelled: true });
	schedule({ kind: "nav", targetId: "entry-1", message: "go on" });
	sent = b.settle();
	const run = b.run(tokenOf(sent));
	assert.equal(b.input("sent while navigating"), undefined, "input before the command finishes is untouched");
	await run;
	assert.equal(b.input("go on", "rpc"), undefined, "other sources are untouched");
	assert.deepEqual(b.input("prefix: go on"), { action: "handled" }, "the follow-up is dropped after a cancelled navigation, even if transformed");
	assert.equal(b.input("go on"), undefined, "only the queued follow-up is dropped");

	schedule({ kind: "nav", targetId: "entry-1", message: "go on" });
	await b.run(tokenOf(b.settle()));
	b.agentStart();
	assert.equal(b.input("unrelated"), undefined, "a follow-up consumed by an earlier input handler leaves no state behind");

	b.set({ throwError: new Error("boom") });
	schedule({ kind: "reload", message: "after reload" });
	sent = b.settle();
	assert.deepEqual(sent[1], ["after reload", undefined]);
	await b.run(tokenOf(sent));
	assert.deepEqual(b.input("after reload"), { action: "handled" }, "the follow-up is dropped after a failed reload");
	assert.equal(hasPending(owner), false);
});

test("the slot stays occupied while the action runs, and shutdown cleanup keeps it", async () => {
	const b = bridge();
	let release;
	b.set({ gate: new Promise((resolve) => { release = resolve; }) });
	schedule({ kind: "fork", id: "entry-1" });
	const running = b.run(tokenOf(b.settle()));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(hasQueuedAction(owner), false, "an in-flight action is not a stale queued action");
	clearPending(owner);
	assert.throws(() => schedule({ kind: "reload" }), /a fork is in progress/);
	release();
	await running;
	assert.equal(hasPending(owner), false);
});

test("cancellations and failures are reported", async () => {
	const b = bridge();
	b.set({ cancelled: true });
	schedule({ kind: "new" });
	await b.run(tokenOf(b.settle()), b.ctx(owner, true));
	b.set({ throwError: new Error("boom") });
	schedule({ kind: "fork", id: "entry-1" });
	await b.run(tokenOf(b.settle()), b.ctx(owner, true));
	assert.deepEqual(b.notes, [["warning", "New session cancelled"], ["error", "Fork failed: Error: boom"]]);

	const warns = [];
	const origWarn = console.warn;
	console.warn = (...args) => warns.push(args.join(" "));
	try {
		b.set({ cancelled: true });
		schedule({ kind: "resume", file: "/tmp/a.jsonl" });
		await b.run(tokenOf(b.settle()));
	} finally { console.warn = origWarn; }
	assert.deepEqual(warns, ["[pi-control] Session switch cancelled"], "headless runs report on the console");
});

test("command-requested transitions run with the bridge command context", async () => {
	const b = bridge();
	const commandCtx = b.ctx();
	let received;
	assert.equal(scheduleRawOp(owner, "new session", async (c) => { received = c; return { cancelled: false }; }).ok, true);
	await b.run(tokenOf(b.settle()), commandCtx);
	assert.equal(received, commandCtx);
	assert.equal(hasPending(owner), false);
});

test("sessions are isolated", async () => {
	const b = bridge();
	const other = {};
	schedule({ kind: "reload" });
	assert.deepEqual(b.settle(other), [], "another session has nothing to dispatch");
	assert.equal(schedule({ kind: "reload" }, other).terminate, true);
	clearPending(other);
	assert.equal(hasPending(owner), true);
	clearPending(owner);
});

test("deferred actions run inline on agent_settled, before external listeners", async () => {
	// Core awaits extension agent_settled handlers before external SDK/RPC/UI
	// listeners hear settled and may prompt, so the switch must be done by then.
	let model = "old";
	assert.equal(scheduleDeferred(owner, "model switch", async () => { await Promise.resolve(); model = "new"; }).ok, true);
	assert.deepEqual(bridge().settle(), [], "deferred actions are not dispatched to the bridge");
	assert.equal(await runPendingDeferredInline(owner), true);
	assert.equal(model, "new");
	assert.equal(hasPending(owner), false);

	const notes = [];
	scheduleDeferred(owner, "model switch", async () => { throw new Error("boom"); });
	assert.equal(await runPendingDeferredInline(owner, (msg, level) => notes.push([level, msg])), true);
	assert.deepEqual(notes, [["error", "Model switch failed: boom"]]);

	schedule({ kind: "reload" });
	assert.equal(await runPendingDeferredInline(owner), false, "session actions are left for the bridge");
	clearPending(owner);
});

test("reload-refreshed module instances share one patch and one state", async () => {
	// Pi's /reload re-executes extension modules as fresh instances. A second
	// instance must not re-wrap the prototype and must see the same state.
	assert.equal(patchBindCommandContext(), true);
	const before = ExtensionRunner.prototype.bindCommandContext;
	const mod2 = await import(new URL("../extensions/command-actions.ts?reload=2", import.meta.url).href);
	assert.equal(mod2.patchBindCommandContext(), true);
	assert.equal(ExtensionRunner.prototype.bindCommandContext, before, "second patch call must not re-wrap bindCommandContext");

	schedule({ kind: "reload" });
	assert.equal(mod2.hasPending(owner), true, "pending state must be shared across module instances");
	mod2.clearPending(owner);
	assert.equal(hasPending(owner), false);

	const runner = { sessionManager: owner };
	ExtensionRunner.prototype.bindCommandContext.call(runner, {});
	assert.equal(mod2.getRunner(owner), runner, "runner capture must be shared");
	assert.equal(getRunner(owner), runner);
});
