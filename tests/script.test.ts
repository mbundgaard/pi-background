import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runScript } from "../src/script.ts";
import { createSchedule, readSchedules, type Schedule } from "../src/schedules.ts";
import { registerRuntime } from "../src/runtime.ts";

const python = spawnSync("python3", ["--version"]).status === 0;
async function fixture(fn: (dir: string, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-script-"));
  try { await fn(dir, join(dir, "test.py")); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await sleep(10); }
  assert.fail("Timed out waiting for Python execution");
}

test("script schedules validate paths, args, envFiles and reject target-specific options", async () => {
  await fixture(async (dir, scriptPath) => {
    const base = { name: "python", target: "script", when: "+1m", scriptPath };
    const s = createSchedule(base, "owner");
    assert.equal(s.prompt, "");
    for (const bad of [{ scriptPath: "relative.py" }, { envFiles: { TOKEN: "relative" } }, { envFiles: { "BAD=NAME": scriptPath } },
      { args: [1] }, { args: ["\0"] }, { model: "model" }, { prompt: "ignored" }]) {
      assert.throws(() => createSchedule({ ...base, ...bad } as any, "owner"));
    }
    assert.throws(() => createSchedule({ ...base, target: "main", prompt: "x" }, "owner"));
    const file = join(dir, "schedules.json");
    await writeFile(file, JSON.stringify({ version: 1, schedules: [s] }));
    assert.deepEqual(await readSchedules(file), [JSON.parse(JSON.stringify(s))]);
    s.scriptPath = "relative.py";
    await writeFile(file, JSON.stringify({ version: 1, schedules: [s] }));
    await assert.rejects(readSchedules(file));
  });
});

test("real Python captures exact stdout including whitespace, nonzero/stderr, empty and large UTF-8 output", { skip: !python }, async () => {
  await fixture(async (dir, scriptPath) => {
    for (const text of ["", " \t\r\n", "hello\r\n\n", "λ🙂".repeat(20000)]) {
      await writeFile(scriptPath, `import sys\nsys.stdout.reconfigure(encoding='utf-8', newline='')\nsys.stdout.write(${JSON.stringify(text)})\nsys.stderr.write('secret diagnostic')\nsys.exit(7)\n`);
      const result = await runScript({ scriptPath }, dir, () => true);
      assert.equal(result.stdout, text);
      assert.match(result.diagnostic!, /code 7/);
      assert.ok(!result.diagnostic!.includes("secret diagnostic"));
    }
  });
});

test("envFiles rotate each run, preserve all but one trailing newline, stay child-only; args use no shell and cwd is project", { skip: !python }, async () => {
  await fixture(async (dir, scriptPath) => {
    const key = "PI_BACKGROUND_SCRIPT_TEST_SECRET", file = join(dir, "secret");
    const old = process.env[key];
    await writeFile(scriptPath, `import os, sys, json\nprint(json.dumps([os.environ[${JSON.stringify(key)}], sys.argv[1:], os.getcwd()]), end='')\n`);
    const args = ["; echo injected", "$(echo injected)", " spaced "];
    for (const [input, expected] of [["first\r\n", "first"], [" second \n\n", " second \n"], ["third\r", "third\r"], ["", ""]]) {
      await writeFile(file, input);
      const value = await runScript({ scriptPath, args, envFiles: { [key]: file } }, dir, () => true);
      assert.deepEqual(JSON.parse(value.stdout), [expected, args, dir]);
      assert.equal(process.env[key], old);
    }
    const missing = await runScript({ scriptPath, envFiles: { [key]: join(dir, "missing") } }, dir, () => true);
    assert.equal(missing.stdout, ""); assert.match(missing.diagnostic!, /environment file/);
    await writeFile(file, "secret\0value");
    const invalid = await runScript({ scriptPath, envFiles: { [key]: file } }, dir, () => true);
    assert.equal(invalid.stdout, ""); assert.equal(invalid.diagnostic, "Unable to spawn python3 script");
    assert.deepEqual(await runScript({ scriptPath }, dir, () => false), { stdout: "", skipped: true });
    const failedSpawn = await runScript({ scriptPath }, join(dir, "missing-cwd"), () => true);
    assert.equal(failedSpawn.stdout, "");
    assert.equal(failedSpawn.diagnostic, "Unable to spawn or run python3 script");
  });
});

test("timeout retains stdout already emitted", { skip: !python }, async () => {
  await fixture(async (dir, scriptPath) => {
    await writeFile(scriptPath, "import sys, time\nsys.stdout.reconfigure(newline='')\nsys.stdout.write('before timeout\\n')\nsys.stdout.flush()\ntime.sleep(10)\n");
    const value = await runScript({ scriptPath, timeoutSeconds: 1 }, dir, () => true);
    assert.equal(value.stdout, "before timeout\n");
    assert.match(value.diagnostic!, /timed out/);
  });
});

function harness(cwd: string) {
  const handlers = new Map<string, Function>(), tools = new Map<string, any>();
  const schedules: Schedule[] = [], sent: any[] = [], warnings: string[] = [];
  let idle = true;
  const ctx: any = { cwd, sessionManager: { getSessionId: () => "owner" }, isIdle: () => idle,
    hasPendingMessages: () => false, ui: { notify: (text: string) => warnings.push(text) } };
  const pi: any = { on: (name: string, fn: Function) => handlers.set(name, fn), events: { on() {} },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }), sendMessage() {} };
  const runtime = registerRuntime(pi, { child: false, ownedTasks: async () => [],
    changeSchedules: async (_cwd, fn) => fn(schedules),
    readTaskResult: async () => { throw new Error("Unexpected inbox read"); },
    acknowledgeTask: async () => {}, startBackgroundPi: async () => { throw new Error("Unexpected worker"); } });
  return { runtime, schedules, sent, warnings, setIdle: (value: boolean) => { idle = value; },
    emit: async (name: string) => { await handlers.get(name)?.({}, ctx); },
    call: (name: string, p: any) => tools.get(name).execute("id", p, undefined, undefined, ctx) };
}

test("real scheduled Python: exact idle/steer delivery, pause during run never gates stdout, overlap skipped without replay", { skip: !python }, async () => {
  await fixture(async (dir, scriptPath) => {
    const ready = join(dir, "ready"), release = join(dir, "release");
    await writeFile(scriptPath, "import pathlib, time, sys\nsys.stdout.reconfigure(newline='')\npathlib.Path('ready').touch()\nwhile not pathlib.Path('release').exists(): time.sleep(.01)\nsys.stdout.write(' \\t\\n')\nsys.stderr.write('not logged')\nsys.exit(4)\n");
    const h = harness(dir); await h.emit("session_start");
    try {
      await h.call("bg_schedule_create", { name: "check", target: "script", scriptPath, when: "+1m", intervalSeconds: 60 });
      const s = h.schedules[0];
      s.nextAt = Date.now(); await h.runtime.poll();
      await until(async () => { try { await access(ready); return true; } catch { return false; } });
      s.nextAt = Date.now(); await h.runtime.poll(); assert.equal(s.lastRun?.outcome, "skipped-overlap");
      h.setIdle(false);
      await h.call("bg_pause", { pausedUntil: new Date(Date.now() + 60000).toISOString() });
      await writeFile(release, ""); await until(() => h.sent.length === 1);
      assert.deepEqual(h.sent, [{ text: " \t\n", options: { deliverAs: "steer" } }]);
      await h.runtime.poll(); assert.equal(h.sent.length, 1);
      s.nextAt = Date.now(); await h.runtime.poll(); assert.equal(s.lastRun?.outcome, "skipped-paused");
      await h.call("bg_pause", { pausedUntil: null }); await h.runtime.poll(); assert.equal(h.sent.length, 1);
      h.setIdle(true); s.nextAt = Date.now(); await h.runtime.poll(); await until(() => h.sent.length === 2);
      assert.deepEqual(h.sent[1], { text: " \t\n", options: undefined });
    } finally { await writeFile(release, ""); await h.emit("session_shutdown"); }
  });
});

test("empty stdout never sends even on stderr/failure; shutdown cannot deliver into a different session", { skip: !python }, async () => {
  await fixture(async (dir, scriptPath) => {
    await writeFile(scriptPath, "import sys\nsys.stderr.write('hidden')\nsys.exit(2)\n");
    const h = harness(dir); await h.emit("session_start");
    try {
      const s = createSchedule({ name: "empty", target: "script", scriptPath, when: "+1m" }, "owner");
      h.schedules.push(s); s.nextAt = Date.now(); await h.runtime.poll();
      await until(() => h.warnings.length === 1); assert.deepEqual(h.sent, []);
      await writeFile(scriptPath, "import time\ntime.sleep(.15)\nprint('old session')\n");
      s.enabled = true; s.nextAt = Date.now(); await h.runtime.poll();
      await h.emit("session_shutdown"); await h.emit("session_start");
      await sleep(300); assert.deepEqual(h.sent, []);
    } finally { await h.emit("session_shutdown"); }
  });
});
