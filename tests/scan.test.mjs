// Session scanning: keyword matching, scope filtering, and exclusion of
// pi-control's own tool results from searchable text.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanSessions } from "../extensions/utils.ts";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-control-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

let fileSeq = 0;
function writeSession({ cwd, name, entries }) {
	const dir = path.join(agentDir, "sessions", "--fixture--");
	fs.mkdirSync(dir, { recursive: true });
	const id = `s${fileSeq++}`;
	const file = path.join(dir, `${id}.jsonl`);
	const lines = [{ type: "session", id, timestamp: `2026-07-0${fileSeq}T00:00:00.000Z`, cwd }];
	if (name) lines.push({ type: "session_info", name });
	lines.push(...entries);
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
	// Keep mtime ordering deterministic (newest = last written).
	fs.utimesSync(file, new Date(), new Date(Date.now() + fileSeq * 1000));
	return file;
}

const userMsg = (text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const ownToolResult = (text) => ({ type: "message", message: { role: "toolResult", toolName: "sessions", content: [{ type: "text", text }] } });

const fileA = writeSession({ cwd: "/proj/a", name: "alpha", entries: [userMsg("deploy the zeppelin service")] });
writeSession({ cwd: "/proj/b", name: "beta", entries: [userMsg("unrelated work"), ownToolResult("zeppelin mentioned only in own tool output")] });
writeSession({ cwd: "/proj/a", name: "gamma", entries: [userMsg("another project-a session")] });

test("keyword match returns snippets from real content", async () => {
	const results = await scanSessions("zeppelin", 10, undefined, { scope: "all" });
	assert.equal(results.length, 1);
	assert.equal(results[0].file, fileA);
	assert.match(results[0].matchSnippets[0], /\[user\].*zeppelin/);
});

test("own tool results are not searchable", async () => {
	// Session B contains the keyword only inside a pi-control toolResult; it
	// must not surface (fix 5bb84eb).
	const results = await scanSessions("zeppelin", 10, undefined, { scope: "all" });
	assert.ok(results.every((r) => !r.name || r.name !== "beta"));
});

test("scope=cwd filters by session header", async () => {
	const results = await scanSessions(undefined, 10, undefined, { scope: "cwd", cwd: "/proj/a" });
	assert.equal(results.length, 2);
	assert.ok(results.every((r) => r.cwd === "/proj/a"));
});

test("metadata hits (session name) count without snippets", async () => {
	const results = await scanSessions("gamma", 10, undefined, { scope: "all" });
	assert.equal(results.length, 1);
	assert.equal(results[0].name, "gamma");
	assert.equal(results[0].matchSnippets, undefined);
});

test("limit stops the scan early, newest first", async () => {
	const results = await scanSessions(undefined, 2, undefined, { scope: "all" });
	assert.equal(results.length, 2);
	assert.equal(results[0].name, "gamma", "newest session must come first");
});

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
