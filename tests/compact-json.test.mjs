import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function run(t, scenario) {
	const directory = mkdtempSync(path.join(tmpdir(), "pi-control-compact-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const tracePath = path.join(directory, "trace.jsonl");
	writeFileSync(tracePath, "");
	writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } }));
	const env = { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: directory, COMPACT_TEST_TRACE: tracePath, COMPACT_TEST_SCENARIO: scenario };
	for (const key of Object.keys(env)) if (/_API_KEY$|_TOKEN$|^PI_SESSION_|^PI_CODING_AGENT_SESSION_DIR$/.test(key)) delete env[key];
	const child = spawn("pi", ["--mode", "json", "--offline", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-themes", "-e", fileURLToPath(new URL("./fixtures/compact.ts", import.meta.url)), "--model", "compact-test/fake", "--thinking", "off"], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "", buffer = "";
	const events = [];
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let end;
		while ((end = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			if (!line) continue;
			const event = JSON.parse(line);
			events.push(event);
			if (scenario === "stop" && event.type === "compaction_start") child.kill("SIGTERM");
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.stdin.end("Compact the history and continue the task");
	const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
	const [code, signal] = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (...args) => resolve(args)); });
	clearTimeout(timer);
	const trace = readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
	return { code, signal, events, trace, stderr: stderr.split("\n").filter((line) => line.length < 2000).join("\n") };
}

for (const scenario of ["normal", "message"]) {
	test(`JSON compact finishes before the next model request (${scenario})`, { timeout: 15000 }, async (t) => {
		const result = await run(t, scenario);
		assert.equal(result.signal, null, result.stderr);
		assert.equal(result.code, 0, result.stderr);
		assert.doesNotMatch(result.stderr, /stale|Compaction cancelled/);
		const start = result.trace.find((entry) => entry.type === "summary_start");
		assert.equal(start?.instructions, "Retain the test marker");
		assert.equal(start?.reason, "manual");
		const complete = result.trace.findIndex((entry) => entry.type === "summary_complete");
		const requests = result.trace.flatMap((entry, index) => entry.type === "request" ? [{ ...entry, index }] : []);
		assert.ok(complete >= 0 && complete < requests[1]?.index, "summary must finish before the next model request");
		assert.match(JSON.stringify(requests[1].messages), /Compacted test marker/);
		assert.equal(result.events.filter((event) => event.type === "agent_settled").length, 1);
		const compactEnd = result.events.findIndex((event) => event.type === "compaction_end");
		assert.ok(compactEnd >= 0 && compactEnd < result.events.findIndex((event) => event.type === "agent_settled"));
		assert.deepEqual(result.events.filter((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error").map((event) => event.message.errorMessage), []);
		if (scenario === "message") {
			const delivered = result.events.filter((event) => event.type === "message_end" && event.message.role === "user" && JSON.stringify(event.message.content).includes("Post-compaction task"));
			assert.equal(delivered.length, 1);
			assert.ok(result.events.indexOf(delivered[0]) > result.events.findIndex((event) => event.type === "compaction_end"));
		}
	});
}

test("cancelled compaction never delivers its success message or crashes with a stale context", { timeout: 15000 }, async (t) => {
	const result = await run(t, "failure");
	assert.equal(result.signal, null, result.stderr);
	assert.doesNotMatch(result.stderr, /stale/);
	assert.ok(result.events.some((event) => event.type === "compaction_end" && event.aborted));
	assert.ok(!result.events.some((event) => event.type === "message_end" && event.message.role === "user" && JSON.stringify(event.message.content).includes("Post-compaction task")));
});

test("summary provider failure is observable without delivering the success message", { timeout: 15000 }, async (t) => {
	const result = await run(t, "provider-error");
	assert.equal(result.signal, null, result.stderr);
	assert.doesNotMatch(result.stderr, /stale/);
	assert.ok(result.trace.some((entry) => entry.type === "summary_request"), "must exercise native summary generation");
	const failure = result.events.find((event) => event.type === "compaction_end" && event.errorMessage);
	assert.match(failure?.errorMessage ?? "", /Summary provider unavailable/);
	assert.equal(failure.aborted, false);
	assert.ok(!result.events.some((event) => event.type === "message_end" && event.message.role === "user" && JSON.stringify(event.message.content).includes("Post-compaction task")));
});

test("stopping JSON during compaction exits without a stale completion callback", { timeout: 15000 }, async (t) => {
	const result = await run(t, "stop");
	assert.equal(result.code, 143, result.stderr);
	assert.equal(result.signal, null, result.stderr);
	assert.doesNotMatch(result.stderr, /stale/);
	assert.ok(result.events.some((event) => event.type === "compaction_start"));
	assert.ok(!result.trace.some((entry) => entry.type === "summary_complete"));
});
