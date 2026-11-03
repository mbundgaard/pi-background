import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PAUSE_REQUEST_EVENT, PAUSE_RESULT_EVENT } from "../src/pause.ts";
import { registerRuntime } from "../src/runtime.ts";
import { createSchedule, type Schedule } from "../src/schedules.ts";

function harness(child = false) {
  const handlers = new Map<string, Function[]>(), tools = new Map<string, any>();
  const schedules: Schedule[] = [], tasks: any[] = [], notifications: any[] = [], dispatched: any[] = [], started: any[] = [];
  let owner = "session-a", idle = true, pending = false;
  let beforeTasks: (() => Promise<void>) | undefined;
  let beforeResult: (() => Promise<void>) | undefined;
  let beforeSpawn: (() => Promise<void>) | undefined;
  const events = new EventEmitter();
  const ctx: any = { cwd: "project", sessionManager: { getSessionId: () => owner },
    isIdle: () => idle, hasPendingMessages: () => pending, ui: { notify() {} } };
  const pi: any = {
    events: { on(name: string, fn: (...args: any[]) => void) { events.on(name, fn); return () => events.off(name, fn); }, emit(name: string, value: unknown) { events.emit(name, value); } },
    on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    sendUserMessage(text: string, options: any) { dispatched.push({ text, options }); },
    sendMessage(message: any, options: any) { notifications.push({ message, options }); },
  };
  const runtime = registerRuntime(pi, {
    child,
    async ownedTasks(_cwd, sessionId) { if (beforeTasks) await beforeTasks(); return structuredClone(tasks.filter(t => t.origin.sessionId === sessionId)); },
    async readTaskResult() { if (beforeResult) await beforeResult(); return { status: "completed", finalAnswer: "answer", exitCode: 0, signal: null }; },
    async acknowledgeTask(_cwd, sessionId, id) {
      const t = tasks.find(t => t.id === id && t.origin.sessionId === sessionId);
      if (!t) throw new Error("Not owned");
      t.acknowledgedAtUtc = "now";
    },
    async changeSchedules(_cwd, fn) { return fn(schedules); },
    async startBackgroundPi(p, _ctx, alive, scheduleId) {
      if (beforeSpawn) await beforeSpawn();
      assert.ok(alive?.());
      const task: any = { id: `task-${started.length}`, name: p.name, state: "running", scheduleId,
        origin: { sessionId: owner } };
      started.push(task); tasks.push(task); return task;
    },
  });
  const emit = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
  const call = (name: string, args: any) => tools.get(name).execute("id", args, undefined, undefined, ctx);
  const addDue = (target = "main") => {
    const s = createSchedule({ name: "check", prompt: "do work", target, when: "+1h" }, owner);
    s.nextAt = Date.now() - 10; schedules.push(s); return s;
  };
  return { runtime, ctx, schedules, tasks, notifications, dispatched, started, emit, call, addDue, events,
    setBeforeResult(fn: () => Promise<void>) { beforeResult = fn; },
    setBeforeSpawn(fn: () => Promise<void>) { beforeSpawn = fn; },
    setIdle(value: boolean) { idle = value; }, setPending(value: boolean) { pending = value; },
    setOwner(value: string) { owner = value; }, setBeforeTasks(fn: () => Promise<void>) { beforeTasks = fn; } };
}

test("busy main consumes trigger and never queues it later", async () => {
  const h = harness(); await h.emit("session_start");
  try {
    const s = h.addDue(); h.setIdle(false);
    await h.runtime.poll();
    assert.equal(h.dispatched.length, 0);
    assert.equal(s.lastRun?.outcome, "skipped-busy");
    h.setIdle(true); await h.runtime.poll();
    assert.equal(h.dispatched.length, 0);
  } finally { await h.emit("session_shutdown"); }
});

test("a trigger observed while busy cannot wait for main to become idle during IO", async () => {
  const h = harness(); await h.emit("session_start");
  try {
    h.addDue(); h.setIdle(false);
    h.setBeforeTasks(async () => { h.setIdle(true); });
    await h.runtime.poll();
    assert.equal(h.dispatched.length, 0);
  } finally { await h.emit("session_shutdown"); }
});

test("idle main sends without queue options and only one main schedule per tick", async () => {
  const h = harness(); await h.emit("session_start");
  try {
    h.addDue(); const second = h.addDue(); await h.runtime.poll();
    assert.equal(h.dispatched.length, 1);
    assert.equal(h.dispatched[0].options, undefined);
    assert.equal(second.lastRun?.outcome, "skipped-busy");
    await h.runtime.poll(); assert.equal(h.dispatched.length, 1);
  } finally { await h.emit("session_shutdown"); }
});

test("pending messages and UI prompts block main execution", async () => {
  const h = harness(); await h.emit("session_start");
  try {
    h.addDue(); h.setPending(true); await h.runtime.poll();
    h.setPending(false); h.addDue(); await h.emit("ui_prompt_start"); await h.runtime.poll();
    assert.equal(h.dispatched.length, 0);
    await h.emit("ui_prompt_end");
  } finally { await h.emit("session_shutdown"); }
});

test("background can run while main busy, but same schedule cannot overlap", async () => {
  const h = harness(); await h.emit("session_start");
  try {
    h.setIdle(false); const s = h.addDue("background"); s.intervalMs = 60000;
    await h.runtime.poll(); assert.equal(h.started.length, 1);
    s.nextAt = Date.now() - 10;
    await h.runtime.poll(); assert.equal(h.started.length, 1);
    assert.equal(s.lastRun?.outcome, "skipped-overlap");
    h.tasks[0].state = "completed"; s.nextAt = Date.now() - 10;
    await h.runtime.poll(); assert.equal(h.started.length, 2);
  } finally { await h.emit("session_shutdown"); }
});

test("resume skips missed schedules and only dispatches the owning session", async () => {
  const h = harness(); const missed = h.addDue();
  await h.emit("session_start");
  try {
    assert.equal(missed.lastRun?.outcome, "skipped-missed");
    const other = h.addDue(); other.ownerSessionId = "other";
    await h.runtime.poll(); assert.equal(h.dispatched.length, 0);
    assert.equal(other.enabled, true);
  } finally { await h.emit("session_shutdown"); }
});

test("shutdown invalidates work suspended on IO and creates no new notifications", async () => {
  const h = harness(); await h.emit("session_start"); h.addDue();
  let release!: () => void;
  h.setBeforeTasks(() => new Promise<void>(r => { release = r; }));
  const guard = h.runtime.guard(h.ctx), poll = h.runtime.poll();
  await h.emit("session_shutdown"); release(); await poll;
  assert.equal(guard(), false);
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.notifications.length, 0);
});

test("inbox waits for idle; stable results notify once per activation and ack persists", async () => {
  const h = harness(); await h.emit("session_start");
  try {
    h.tasks.push({ id: "done", name: "done", state: "completed", origin: { sessionId: "session-a" }, resultPath: "result" });
    h.setIdle(false); await h.runtime.poll(); assert.equal(h.notifications.length, 0);
    h.setIdle(true); await h.runtime.poll(); await h.runtime.poll();
    assert.equal(h.notifications.length, 1);
    await h.call("bg_inbox", { action: "get", taskId: "done" });
    assert.equal(h.tasks[0].acknowledgedAtUtc, undefined);
    await h.emit("session_shutdown"); await h.emit("session_start"); await h.runtime.poll();
    assert.equal(h.notifications.length, 2);
    await h.call("bg_inbox", { action: "ack", taskId: "done" });
    await h.emit("session_shutdown"); await h.emit("session_start"); await h.runtime.poll();
    assert.equal(h.notifications.length, 2);
  } finally { await h.emit("session_shutdown"); }
});

test("new session cannot read or acknowledge another session's inbox or schedules", async () => {
  const h = harness(); await h.emit("session_start");
  const s = h.addDue();
  h.tasks.push({ id: "done", state: "completed", origin: { sessionId: "session-a" } });
  await h.emit("session_shutdown"); h.setOwner("session-b"); await h.emit("session_start");
  try {
    await assert.rejects(h.call("bg_inbox", { action: "get", taskId: "done" }));
    await assert.rejects(h.call("bg_inbox", { action: "ack", taskId: "done" }));
    await assert.rejects(h.call("bg_schedule_delete", { scheduleId: s.id }));
    await h.runtime.poll(); assert.equal(h.notifications.length, 0);
  } finally { await h.emit("session_shutdown"); }
});

test("child runtime never starts timers or executes scheduler/inbox tools", async () => {
  const h = harness(true); await h.emit("session_start"); h.addDue();
  await h.runtime.poll(); assert.equal(h.dispatched.length, 0);
  await assert.rejects(h.call("bg_schedule_list", {}));
  await assert.rejects(h.call("bg_inbox", { action: "list" }));
});

test("schedule create, pause, enable, list and delete stay session scoped", async () => {
  const h = harness(); await h.emit("session_start");
  try {
    await h.call("bg_schedule_create", { name: "test", prompt: "check", target: "background", when: "+1m", intervalSeconds: 30 });
    const s = h.schedules[0];
    await h.call("bg_schedule_enable", { scheduleId: s.id, enabled: false });
    assert.equal(s.enabled, false);
    s.nextAt = Date.now() - 60000;
    await h.call("bg_schedule_enable", { scheduleId: s.id, enabled: true });
    assert.ok(s.nextAt > Date.now());
    const list = await h.call("bg_schedule_list", {});
    assert.match(list.content[0].text, /test/);
    await h.call("bg_schedule_delete", { scheduleId: s.id });
    assert.equal(h.schedules.length, 0);
  } finally { await h.emit("session_shutdown"); }
});

test("pause rule: null, empty, past and exactly now fire; future skips both targets", async t => {
  const now = Date.parse("2030-01-01T12:00:00Z"); t.mock.method(Date, "now", () => now);
  for (const pausedUntil of [null, "", new Date(now - 1).toISOString(), new Date(now).toISOString(), new Date(now + 1800000).toISOString()]) {
    const h = harness(); await h.emit("session_start");
    try {
      await h.call("bg_pause", { pausedUntil }); const main = h.addDue(), worker = h.addDue("background");
      await h.runtime.poll(); const future = typeof pausedUntil === "string" && Date.parse(pausedUntil) > now;
      assert.equal(h.dispatched.length, future ? 0 : 1); assert.equal(h.started.length, future ? 0 : 1);
      if (future) {
        assert.equal(main.lastRun?.outcome, "skipped-paused"); assert.equal(worker.lastRun?.outcome, "skipped-paused");
        await h.call("bg_pause", { pausedUntil: null }); await h.runtime.poll();
        assert.equal(h.dispatched.length, 0); assert.equal(h.started.length, 0);
      }
    } finally { await h.emit("session_shutdown"); }
  }
});

test("paused completion notifications are dropped, results/manual inbox and running workers preserved", async () => {
  const h = harness(); await h.emit("session_start");
  try {
    h.tasks.push({ id: "done", name: "done", state: "completed", origin: { sessionId: "session-a" }, resultPath: "result" },
      { id: "running", name: "running", state: "running", origin: { sessionId: "session-a" } });
    await h.call("bg_pause", { pausedUntil: new Date(Date.now() + 60000).toISOString() });
    await h.runtime.poll(); assert.equal(h.notifications.length, 0); assert.equal(h.tasks[1].state, "running");
    const read = await h.call("bg_inbox", { action: "get", taskId: "done" }); assert.match(read.content[0].text, /answer/);
    assert.equal(h.tasks[0].acknowledgedAtUtc, undefined);
    await h.call("bg_pause", { pausedUntil: null }); await h.runtime.poll(); assert.equal(h.notifications.length, 0);
    h.tasks[1].state = "completed"; await h.runtime.poll(); assert.equal(h.notifications.length, 1);
  } finally { await h.emit("session_shutdown"); }
});

test("event pause has explicit acknowledgment, exact session scope and invalid-input safety", async () => {
  const h = harness(); await h.emit("session_start"); const replies: any[] = [];
  h.events.on(PAUSE_RESULT_EVENT, value => replies.push(value));
  try {
    const pausedUntil = new Date(Date.now() + 60000).toISOString();
    h.events.emit(PAUSE_REQUEST_EVENT, { requestId: "one", sessionId: "session-a", pausedUntil });
    assert.deepEqual(replies[0], { requestId: "one", sessionId: "session-a", ok: true, pausedUntil });
    h.events.emit(PAUSE_REQUEST_EVENT, { requestId: "foreign", sessionId: "session-b", pausedUntil: null }); assert.equal(replies.length, 1);
    h.events.emit(PAUSE_REQUEST_EVENT, { requestId: "bad", sessionId: "session-a", pausedUntil: "+30m" }); assert.equal(replies[1].ok, false);
    await assert.rejects(h.call("bg_pause", { pausedUntil: "tomorrow" }));
    const due = h.addDue(); await h.runtime.poll(); assert.equal(due.lastRun?.outcome, "skipped-paused");
    h.events.emit(PAUSE_REQUEST_EVENT, { requestId: "clear", sessionId: "session-a", pausedUntil: "" }); assert.equal(replies[2].pausedUntil, null);
    h.addDue(); await h.runtime.poll(); assert.equal(h.dispatched.length, 1);
  } finally { await h.emit("session_shutdown"); }
});

test("expiry resumes fresh triggers without backlog and reload clears pause", async t => {
  let now = Date.parse("2030-01-01T12:00:00Z"); t.mock.method(Date, "now", () => now);
  const h = harness(); await h.emit("session_start");
  try {
    await h.call("bg_pause", { pausedUntil: new Date(now + 1000).toISOString() });
    const s = h.addDue(); s.intervalMs = 10000; await h.runtime.poll(); assert.equal(s.lastRun?.outcome, "skipped-paused");
    now += 1000; await h.runtime.poll(); assert.equal(h.dispatched.length, 0);
    now = s.nextAt; await h.runtime.poll(); assert.equal(h.dispatched.length, 1);
    await h.call("bg_pause", { pausedUntil: new Date(now + 60000).toISOString() });
    await h.emit("session_shutdown"); await h.emit("session_start"); h.addDue(); await h.runtime.poll(); assert.equal(h.dispatched.length, 2);
  } finally { await h.emit("session_shutdown"); }
});

test("pause is rechecked after IO and before background spawn or notification", async () => {
  for (const phase of ["tasks", "result", "spawn"]) {
    const h = harness(); await h.emit("session_start");
    try {
      const pause = async () => { await h.call("bg_pause", { pausedUntil: new Date(Date.now() + 60000).toISOString() }); };
      if (phase === "tasks") { h.addDue(); h.setBeforeTasks(pause); }
      if (phase === "spawn") { h.addDue("background"); h.setBeforeSpawn(pause); }
      if (phase === "result") { h.tasks.push({ id: "done", state: "completed", origin: { sessionId: "session-a" }, resultPath: "result", name: "done" }); h.setBeforeResult(pause); }
      await h.runtime.poll(); assert.equal(h.dispatched.length, 0); assert.equal(h.started.length, 0); assert.equal(h.notifications.length, 0);
      if (phase === "spawn") assert.equal(h.schedules[0].lastRun?.outcome, "skipped-paused");
    } finally { await h.emit("session_shutdown"); }
  }
});

test("children cannot pause and no event reply is emitted without a matching active owner", async () => {
  for (const child of [false, true]) {
    const h = harness(child); const replies: unknown[] = []; h.events.on(PAUSE_RESULT_EVENT, x => replies.push(x));
    if (child) await h.emit("session_start");
    h.events.emit(PAUSE_REQUEST_EVENT, { requestId: "x", sessionId: "session-a", pausedUntil: null });
    assert.equal(replies.length, 0); await assert.rejects(h.call("bg_pause", { pausedUntil: null }));
    await h.emit("session_shutdown");
  }
});
