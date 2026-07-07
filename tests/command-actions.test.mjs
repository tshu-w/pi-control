// State machine tests for the deferred-action layer, driven with recording
// fakes in place of pi's real session-transition closures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import {
	patchBindCommandContext, scheduleAction, scheduleRawOp, isPendingRawOp, clearPendingRawOp,
	runPending, clearPending, hasPending, isArmed,
} from "../extensions/command-actions.ts";

const calls = [];
const notes = [];
const notify = (msg, level) => notes.push([level, msg]);
const fakeRunner = { runtime: { sendUserMessage: (msg, opts) => calls.push(["sendUserMessage", msg, opts]) } };

let behavior = { cancelled: false, throwError: null, gate: null };
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
	waitForIdle: async () => {},
};

const reset = () => { calls.length = 0; notes.length = 0; behavior = { cancelled: false, throwError: null, gate: null }; clearPending(); };
const schedule = (action) => scheduleAction({ fallbackHint: "Use built-in `/x` instead.", action, successText: "scheduled", details: {} });

test("unarmed scheduling falls back to built-in hint", () => {
	assert.equal(isArmed(), false);
	const r = schedule({ kind: "resume", file: "/tmp/a.jsonl" });
	assert.match(r.content[0].text, /Command context not captured/);
	assert.equal(hasPending(), false);
});

test("single pending slot: second schedule is rejected", () => {
	patchBindCommandContext();
	ExtensionRunner.prototype.bindCommandContext.call(fakeRunner, actions);
	assert.equal(isArmed(), true);

	assert.equal(schedule({ kind: "resume", file: "/tmp/a.jsonl" }).content[0].text, "scheduled");
	assert.equal(hasPending(), true);
	assert.match(schedule({ kind: "reload" }).content[0].text, /already scheduled/);
	clearPending();
});

test("runPending dispatches and consumes", async () => {
	reset();
	schedule({ kind: "resume", file: "/tmp/a.jsonl" });
	await runPending(notify);
	assert.deepEqual(calls[0].slice(0, 2), ["switchSession", "/tmp/a.jsonl"]);
	assert.equal(hasPending(), false);
	assert.equal(notes.length, 0, "no notifications on success");
});

test("consume-before-await: scheduling works while an action is in flight", async () => {
	reset();
	let release;
	behavior.gate = new Promise((r) => { release = r; });
	schedule({ kind: "resume", file: "/tmp/a.jsonl" });
	const running = runPending(notify);

	// The in-flight action must not hold the slot.
	assert.equal(hasPending(), false);
	assert.equal(schedule({ kind: "reload" }).content[0].text, "scheduled");

	release();
	await running;
	assert.equal(hasPending(), true, "the newly scheduled action must survive the finished run");
	clearPending();
});

test("cancelled transitions notify as warning", async () => {
	reset();
	behavior.cancelled = true;
	schedule({ kind: "fork", id: "abc" });
	await runPending(notify);
	assert.deepEqual(notes, [["warning", "Fork cancelled"]]);
});

test("failures notify as error", async () => {
	reset();
	behavior.throwError = new Error("boom");
	schedule({ kind: "new" });
	await runPending(notify);
	assert.equal(notes[0][0], "error");
	assert.match(notes[0][1], /New session failed/);
});

test("nav delivers follow-up message through the runtime", async () => {
	reset();
	schedule({ kind: "nav", targetId: "t1", message: "continue here" });
	await runPending(notify, { sendFollowUp: async (msg) => calls.push(["followUp", msg]) });
	assert.deepEqual(calls.at(-1), ["followUp", "continue here"]);
});

test("reload delivers message via the fresh runner runtime", async () => {
	reset();
	schedule({ kind: "reload", message: "verify things" });
	await runPending(notify);
	assert.deepEqual(calls, [["reload"], ["sendUserMessage", "verify things", { deliverAs: "followUp" }]]);
});

test("rawOp: token lifecycle and execution", async () => {
	reset();
	const r = scheduleRawOp("test-op", async () => calls.push(["exec"]));
	assert.equal(r.ok, true);
	assert.equal(isPendingRawOp(r.token), true);
	assert.equal(scheduleRawOp("second", async () => {}).ok, false, "slot must be exclusive");

	assert.equal(clearPendingRawOp(r.token), true);
	assert.equal(hasPending(), false);

	const r2 = scheduleRawOp("test-op-2", async () => calls.push(["exec2"]));
	await runPending(notify);
	assert.deepEqual(calls, [["exec2"]]);
	assert.equal(isPendingRawOp(r2.token), false);
});
