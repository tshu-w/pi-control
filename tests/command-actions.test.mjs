// State machine tests for the deferred-action layer, driven with recording
// fakes in place of pi's real session-transition closures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import {
	patchBindCommandContext, scheduleAction, scheduleRawOp, scheduleDeferred, isPendingRawOp, clearPendingRawOp,
	runPending, runPendingDeferredInline, clearPending, hasPending, hasQueuedAction, isArmed, getOps, getRunner,
} from "../extensions/command-actions.ts";

const calls = [];
const notes = [];
const notify = (msg, level) => notes.push([level, msg]);
const owner = {};
const fakeRunner = { sessionManager: owner, runtime: { sendUserMessage: (msg, opts) => calls.push(["sendUserMessage", msg, opts]) } };

let behavior = { cancelled: false, throwError: null, gate: null, idleGate: null };
const record = (name) => async (...args) => {
	calls.push([name, ...args]);
	if (behavior.gate) await behavior.gate;
	if (behavior.throwError) throw behavior.throwError;
	return { cancelled: behavior.cancelled };
};
const actions = {
	switchSession: record("switchSession"),
	newSession: record("newSession"),
	navigateTree: record("navigateTree"),
	fork: record("fork"),
	reload: async () => { calls.push(["reload"]); },
	waitForIdle: async () => { if (behavior.idleGate) await behavior.idleGate; },
};

const reset = () => { calls.length = 0; notes.length = 0; behavior = { cancelled: false, throwError: null, gate: null, idleGate: null }; clearPending(owner); };
const schedule = (action) => scheduleAction(owner, { fallbackHint: "Use built-in `/x` instead.", action, successText: "scheduled", details: {} });

test("unarmed scheduling falls back to built-in hint", () => {
	assert.equal(isArmed(owner), false);
	const r = schedule({ kind: "resume", file: "/tmp/a.jsonl" });
	assert.match(r.content[0].text, /Command context not captured/);
	assert.equal(hasPending(owner), false);
});

test("deferred: runs unarmed, last wins, blocked by other kinds", async () => {
	assert.equal(isArmed(owner), false, "deferred tests must run before the patch arms ops");
	assert.equal(scheduleDeferred(owner, "switch-a", async () => calls.push(["deferred-a"])).ok, true, "deferred needs no command context");
	assert.equal(scheduleDeferred(owner, "switch-b", async () => calls.push(["deferred-b"])).ok, true, "a later deferred replaces the pending one");
	await runPending(owner, notify);
	assert.deepEqual(calls, [["deferred-b"]], "only the last deferred runs, without ops");
	assert.equal(hasPending(owner), false);

	calls.length = 0;
	behavior.throwError = null;
	const failing = scheduleDeferred(owner, "switch-fail", async () => { throw new Error("boom"); });
	assert.equal(failing.ok, true);
	await runPending(owner, notify);
	assert.equal(notes[0][0], "error");
	assert.match(notes[0][1], /Deferred switch-fail failed/);
	notes.length = 0;
});

test("deferred inline: switch completes inside the settled emit, before external listeners", async () => {
	// Mirrors core _emitAgentSettled ordering (agent-session.js:314-321):
	// `await extensionRunner.emit(agent_settled)` runs our handler to
	// completion, THEN external SDK/RPC/UI listeners hear settled and may
	// prompt immediately. The switch must be done by that point.
	let model = "old";
	const events = [];
	assert.equal(scheduleDeferred(owner, "model switch", async () => {
		await Promise.resolve();
		model = "new";
	}).ok, true);
	const extensionEmit = async () => {
		assert.equal(await runPendingDeferredInline(owner, notify), true, "inline path must consume the deferred action");
	};
	await extensionEmit();
	events.push(["external-listener-prompt", model]);
	assert.deepEqual(events, [["external-listener-prompt", "new"]], "a prompt racing the settled event must already see the new model");
	assert.equal(hasPending(owner), false);

	// Inline failure notifies instead of throwing into the emit.
	scheduleDeferred(owner, "bad switch", async () => { throw new Error("boom"); });
	assert.equal(await runPendingDeferredInline(owner, notify), true);
	assert.match(notes.at(-1)[1], /Deferred bad switch failed/);
	notes.length = 0;

	// Session-transition kinds are not consumed inline; they need the timer.
	patchBindCommandContext();
	ExtensionRunner.prototype.bindCommandContext.call(fakeRunner, actions);
	schedule({ kind: "reload" });
	assert.equal(await runPendingDeferredInline(owner, notify), false, "session transitions stay pending for the timer path");
	assert.equal(hasPending(owner), true);
	clearPending(owner);
});

test("single pending slot: second schedule is rejected", () => {
	patchBindCommandContext();
	ExtensionRunner.prototype.bindCommandContext.call(fakeRunner, actions);
	assert.equal(isArmed(owner), true);

	assert.equal(schedule({ kind: "resume", file: "/tmp/a.jsonl" }).content[0].text, "scheduled");
	assert.equal(hasPending(owner), true);
	assert.match(schedule({ kind: "reload" }).content[0].text, /already scheduled/);
	clearPending(owner);
});

test("session bindings and pending slots are isolated", async () => {
	reset();
	const otherOwner = {};
	const otherRunner = { sessionManager: otherOwner };
	ExtensionRunner.prototype.bindCommandContext.call(otherRunner, undefined);
	assert.equal(isArmed(owner), true, "binding another session must not disarm the first");
	assert.equal(isArmed(otherOwner), false);

	schedule({ kind: "resume", file: "/tmp/a.jsonl" });
	await runPending(otherOwner, notify);
	assert.equal(hasPending(owner), true, "another session cannot consume this session's action");
	await runPending(owner, notify);
	assert.equal(hasPending(owner), false);
});

test("runPending dispatches and consumes", async () => {
	reset();
	schedule({ kind: "resume", file: "/tmp/a.jsonl" });
	await runPending(owner, notify);
	assert.deepEqual(calls[0].slice(0, 2), ["switchSession", "/tmp/a.jsonl"]);
	assert.equal(hasPending(owner), false);
	assert.equal(notes.length, 0, "no notifications on success");
});

test("single slot covers in-flight execution: no scheduling while a transition runs", async () => {
	reset();
	let release;
	behavior.gate = new Promise((r) => { release = r; });
	schedule({ kind: "resume", file: "/tmp/a.jsonl" });
	const running = runPending(owner, notify);

	// The in-flight action must keep the slot occupied.
	assert.equal(hasPending(owner), true, "in-flight transition must occupy the slot");
	assert.match(schedule({ kind: "reload" }).content[0].text, /in-flight resume/);
	assert.equal(scheduleRawOp(owner, "op", async () => {}).ok, false, "rawOp must be rejected while in flight");
	assert.equal(scheduleDeferred(owner, "switch", async () => {}).ok, false, "deferred must be rejected while in flight");

	release();
	await running;
	assert.equal(hasPending(owner), false, "slot must be free after completion");
	assert.equal(schedule({ kind: "reload" }).content[0].text, "scheduled", "scheduling must work again after completion");
	clearPending(owner);
});

test("shutdown cleanup distinguishes queued actions from in-flight execution", async () => {
	reset();
	// A transition in flight triggers session_shutdown itself (core emits it
	// before switchSession/reload resolve). The shutdown handler must not see
	// it as a stale queued action, and clearPending must not release the slot.
	let release;
	behavior.gate = new Promise((r) => { release = r; });
	schedule({ kind: "resume", file: "/tmp/a.jsonl" });
	const running = runPending(owner, notify);

	assert.equal(hasQueuedAction(owner), false, "in-flight transition is not a stale queued action");
	clearPending(owner);
	assert.equal(hasPending(owner), true, "shutdown cleanup must not release the in-flight slot");

	release();
	await running;
	assert.deepEqual(calls[0].slice(0, 2), ["switchSession", "/tmp/a.jsonl"], "the in-flight transition still completes");
	assert.equal(hasPending(owner), false);

	// A genuinely queued (unclaimed) action is stale and must be cleared.
	schedule({ kind: "reload" });
	assert.equal(hasQueuedAction(owner), true);
	clearPending(owner);
	assert.equal(hasQueuedAction(owner), false);
	assert.equal(hasPending(owner), false);
});

test("cancelled transitions notify as warning", async () => {
	reset();
	behavior.cancelled = true;
	schedule({ kind: "fork", id: "abc" });
	await runPending(owner, notify);
	assert.deepEqual(notes, [["warning", "Fork cancelled"]]);
	assert.equal(hasPending(owner), false, "slot must be released after cancellation");
});

test("failures notify as error", async () => {
	reset();
	behavior.throwError = new Error("boom");
	schedule({ kind: "new" });
	await runPending(owner, notify);
	assert.equal(notes[0][0], "error");
	assert.match(notes[0][1], /New session failed/);
	assert.equal(hasPending(owner), false, "slot must be released after failure");
	assert.equal(schedule({ kind: "reload" }).content[0].text, "scheduled", "next action must be schedulable after a failure");
	clearPending(owner);
});

test("nav delivers follow-up message through the runtime", async () => {
	reset();
	schedule({ kind: "nav", targetId: "t1", message: "continue here" });
	await runPending(owner, notify, { sendFollowUp: async (msg) => calls.push(["followUp", msg]) });
	assert.deepEqual(calls.at(-1), ["followUp", "continue here"]);
});

test("reload delivers message via the fresh runner runtime", async () => {
	reset();
	schedule({ kind: "reload", message: "verify things" });
	await runPending(owner, notify);
	assert.deepEqual(calls, [["reload"], ["sendUserMessage", "verify things", { deliverAs: "followUp" }]]);
});

test("rawOp: token lifecycle and execution", async () => {
	reset();
	const r = scheduleRawOp(owner, "test-op", async () => calls.push(["exec"]));
	assert.equal(r.ok, true);
	assert.equal(isPendingRawOp(owner, r.token), true);
	assert.equal(scheduleRawOp(owner, "second", async () => {}).ok, false, "slot must be exclusive");
	assert.equal(scheduleDeferred(owner, "switch", async () => {}).ok, false, "deferred must not replace a pending rawOp");

	assert.equal(clearPendingRawOp(owner, r.token), true);
	assert.equal(hasPending(owner), false);

	const r2 = scheduleRawOp(owner, "test-op-2", async () => calls.push(["exec2"]));
	await runPending(owner, notify);
	assert.deepEqual(calls, [["exec2"]]);
	assert.equal(isPendingRawOp(owner, r2.token), false);
});

test("waitForIdle gates transitions: a turn racing the settled window finishes first", async () => {
	reset();
	// Simulates an external prompt that raced the public settled event and
	// started a turn in the settled→timer window: waitForIdle stays pending
	// until that turn ends, and the transition must not start before it.
	let releaseIdle;
	behavior.idleGate = new Promise((r) => { releaseIdle = r; });
	schedule({ kind: "resume", file: "/tmp/a.jsonl" });
	const running = runPending(owner, notify);
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(calls, [], "transition must wait for the racing turn to finish");

	// The racing turn must not be able to schedule a second transition that
	// would resume concurrently on the same idle edge (the reviewer's repro:
	// start:A start:B end:A end:B).
	assert.match(schedule({ kind: "resume", file: "/tmp/b.jsonl" }).content[0].text, /in-flight resume/);
	const second = runPending(owner, notify);

	releaseIdle();
	await Promise.all([running, second]);
	assert.deepEqual(calls.map((c) => c[0]), ["switchSession"], "exactly one transition must execute");
	assert.deepEqual(calls[0].slice(0, 2), ["switchSession", "/tmp/a.jsonl"]);
});

test("rawOp: cancelled result surfaces as a warning, also headless", async () => {
	reset();
	scheduleRawOp(owner, "op-cancelled", async () => ({ cancelled: true }));
	await runPending(owner, notify);
	assert.deepEqual(notes, [["warning", "Command-triggered op-cancelled cancelled"]]);

	notes.length = 0;
	const warns = [];
	const origWarn = console.warn;
	console.warn = (...args) => warns.push(args.join(" "));
	try {
		scheduleRawOp(owner, "op-headless", async () => ({ cancelled: true }));
		await runPending(owner, undefined);
	} finally { console.warn = origWarn; }
	assert.ok(warns.some((w) => w.includes("op-headless cancelled")), "headless cancellation must reach console.warn");
});

test("headless cancelled transitions reach console.warn", async () => {
	reset();
	behavior.cancelled = true;
	const warns = [];
	const origWarn = console.warn;
	console.warn = (...args) => warns.push(args.join(" "));
	try {
		schedule({ kind: "fork", id: "abc" });
		await runPending(owner, undefined);
	} finally { console.warn = origWarn; }
	assert.ok(warns.some((w) => w.includes("Fork cancelled")), "headless veto must not vanish silently");
});

test("reload-refreshed module instances share one patch and one state", async () => {
	reset();
	// Pi's /reload re-executes extension modules as fresh instances (module
	// cache cleared). A second instance must not re-wrap the same prototype and
	// must see the same ops/pending/runner state.
	const before = ExtensionRunner.prototype.bindCommandContext;
	const mod2 = await import(new URL("../extensions/command-actions.ts?reload=2", import.meta.url).href);
	assert.equal(mod2.patchBindCommandContext(), true, "second instance must recognize the marked prototype");
	assert.equal(ExtensionRunner.prototype.bindCommandContext, before, "second patch call must not re-wrap bindCommandContext");

	schedule({ kind: "reload" });
	assert.equal(mod2.hasPending(owner), true, "pending state must be shared across module instances");
	mod2.clearPending(owner);
	assert.equal(hasPending(owner), false, "clearing via the second instance must clear the shared slot");

	ExtensionRunner.prototype.bindCommandContext.call(fakeRunner, actions);
	assert.equal(mod2.isArmed(owner), true, "re-binding must arm every instance");
	assert.equal(mod2.getRunner(owner), fakeRunner, "runner capture must be shared");
});

test("a new ExtensionRunner prototype identity invalidates stale session captures", () => {
	reset();
	const originalCalls = [];
	const prototypeA = {
		bindCommandContext(actions) { originalCalls.push(["a", this, actions]); },
	};
	const prototypeB = {
		bindCommandContext(actions) { originalCalls.push(["b", this, actions]); },
	};
	const ownerA = {};
	const ownerB = {};
	const runnerA = { sessionManager: ownerA };
	const runnerB = { sessionManager: ownerB };

	assert.equal(patchBindCommandContext(prototypeA), true);
	const wrappedA = prototypeA.bindCommandContext;
	prototypeA.bindCommandContext.call(runnerA, actions);
	assert.equal(getRunner(ownerA), runnerA);
	assert.equal(isArmed(ownerA), true);
	assert.equal(patchBindCommandContext(prototypeA), true);
	assert.equal(prototypeA.bindCommandContext, wrappedA, "same identity must not be wrapped twice");

	assert.equal(patchBindCommandContext(prototypeB), true);
	assert.equal(isArmed(ownerA), false, "new identity must invalidate all old session closures");
	assert.equal(getRunner(ownerA), null);
	const wrappedB = prototypeB.bindCommandContext;
	prototypeB.bindCommandContext.call(runnerB, actions);
	assert.equal(getRunner(ownerB), runnerB);
	assert.equal(getOps(ownerB).reload, actions.reload);
	assert.equal(patchBindCommandContext(prototypeB), true);
	assert.equal(prototypeB.bindCommandContext, wrappedB, "new identity must remain idempotent");

	const replacement = function (actions) { originalCalls.push(["replacement", this, actions]); };
	prototypeB.bindCommandContext = replacement;
	assert.equal(patchBindCommandContext(prototypeB), true);
	assert.notEqual(prototypeB.bindCommandContext, replacement, "a replaced method on a known prototype must be wrapped again");
	prototypeB.bindCommandContext.call(runnerB, actions);
	assert.deepEqual(originalCalls.map(([name]) => name), ["a", "b", "replacement"]);

	// Restore the real prototype and primary fixture for later imports/tests.
	patchBindCommandContext();
	ExtensionRunner.prototype.bindCommandContext.call(fakeRunner, actions);
});
