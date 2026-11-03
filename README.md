# Pi Background

Run background [Pi coding-agent](https://github.com/earendil-works/pi-mono) tasks, review their results in a durable session inbox, and schedule main or background work without execution backlogs.

**Version 0.3.0:** adds session-owned Python script schedules and an optional in-memory session pause. Durable result inbox and main/background scheduling remain available; npm `0.1.0` provides the original `bg_start` behavior.

## Install

Install the published version:

```bash
pi install npm:@comput/pi-background
```

Alternatively, install the committed source from GitHub:

```bash
pi install git:github.com/mbundgaard/pi-background
```

Start a new Pi session or run `/reload` after installation. Pi must be installed and authenticated. Workers launch the resolved Pi package's CLI directly through the current Node.js executable, without a shell. Node.js 20.3 or newer is required; development checks use Node.js 22 or 24. Development validation uses Pi 1.4.0.

The package ships TypeScript source, loaded directly by Pi; there is no build step or standalone executable.

## Usage

Ask Pi to delegate a focused task, for example:

> Start a background task named "review-tests" to review the test coverage. Do not change files. Return gaps and suggested tests.

The `bg_start` tool accepts:

| Parameter | Purpose |
| --- | --- |
| `name` | Required short task name; normalized to a project-wide scope |
| `prompt` | Required complete task brief, including limits and validation |
| `timeoutSeconds` | Optional positive timeout |
| `provider` | Optional child Pi provider |
| `model` | Optional child Pi model |
| `thinking` | Optional child Pi thinking level |

The tool returns immediately with the task ID, PID, origin, and output/metadata paths. A second running task with the same normalized name in the project is rejected. Dead tasks are marked stale when the registry is next accessed.

When a task finishes, its final assistant text and outcome are saved separately from diagnostic logs. The owning main session receives a review notification only when idle. Main reviews the result, acknowledges it, and decides whether to respond. Origin metadata records supported request markers, including Telegram, WhatsApp, and scheduler requests; it is not authorization or a guarantee of delayed message delivery.

## Result inbox

The inbox retains **completed results**, not jobs waiting to execute. It is scoped to the persistent main-session ID and project directory.

| Tool call | Purpose |
| --- | --- |
| `bg_inbox` with `action: "list"` | List unacknowledged completions; `includeAcknowledged` includes reviewed results |
| `bg_inbox` with `action: "get", taskId` | Read a structured outcome and final answer, with paths to logs |
| `bg_inbox` with `action: "ack", taskId` | Mark a reviewed result acknowledged; does not delete it or send a reply |

Lists and final answers support `offset` and `limit` pagination. Tool responses are bounded to 10,000 characters; use smaller pages if necessary. Logs are not injected into the result inbox. The JSON event log can include thinking and tool traffic; treat it as sensitive local diagnostic data.

- Reading is not acknowledgment. Acknowledgment is explicit and idempotent.
- Each task has one stable result ID (its task ID). Spawn error and close events cannot create duplicate results.
- Notifications are best-effort and emitted once per activation. Unacknowledged results can be announced again on reload/resume; the durable inbox, not the notification, is authoritative.
- No notification interrupts a busy main session. Main retains responsibility for outward communication.
- Switching to a different session or forking does not inherit inbox ownership. Resume the original session to review its results.
- Existing registry entries with an owner session ID remain accessible; legacy tasks without one are not assigned to the currently open session.

## Session-owned schedules

Ask Pi, for example:

> In one minute, then every five minutes, check the test status in the background. Do not change files.

Pi can call:

```json
{
  "name": "test-status",
  "prompt": "Check test status without changing files; return a concise result.",
  "target": "background",
  "when": "+1m",
  "intervalSeconds": 300,
  "timeoutSeconds": 120
}
```

Use `bg_schedule_create` with these arguments. Omit `intervalSeconds` for a one-shot. `when` accepts a future ISO timestamp with an explicit timezone or `+30s`, `+10m`, `+1h`, `+1d`. This version supports fixed intervals, **not cron**. Intervals range from one second to one year; at most 100 schedules are stored per session.

| Tool | Purpose |
| --- | --- |
| `bg_schedule_create` | Create a one-shot or recurring schedule owned by this session |
| `bg_schedule_list` | List schedules and their latest dispatch/skip outcome |
| `bg_schedule_enable` | Pause or enable using `scheduleId` and `enabled` |
| `bg_schedule_delete` | Delete a schedule; already-started tasks and saved results remain |

### Python script target

Use `target: "script"` to run `python3` directly, without a shell or Pi worker:

```json
{
  "name": "check-alerts",
  "target": "script",
  "scriptPath": "/home/me/project/check_alerts.py",
  "args": ["--mode", "scheduled"],
  "envFiles": { "API_TOKEN": "/home/me/.secrets/api-token" },
  "when": "+1m",
  "intervalSeconds": 300
}
```

`scriptPath` must be absolute. `args` is an optional string array; `envFiles` maps environment variable names to absolute file paths. Each execution rereads those files into a copy of the parent environment for that child only. Exactly one trailing LF or CRLF is removed; all other contents are preserved. File rotation takes effect on the next run. The working directory is the project directory. `python3` must be on PATH. Omit `prompt`, `model`, `provider`, and `thinking`; an optional `timeoutSeconds` requests child termination.

**Output contract:** nonempty captured stdout is sent as exactly one unchanged user message to the owning session: ordinary delivery when idle, `deliverAs: "steer"` when busy. Whitespace-only output counts. Empty stdout sends nothing. There is no trimming, wrapping, filtering, truncation, retry or exit-code condition. Nonzero exit, stderr, disabling/deleting the schedule, or a pause applied after execution begins do not suppress stdout. A pause can still prevent execution before spawn, including during environment-file reads.

Scripts from the same schedule do not overlap within the runtime; overlapping triggers are consumed and skipped. Scripts do not enter `bg_inbox`. Read/spawn failures and exit/stderr diagnostics produce generic local warnings, never environment file or stderr contents. Stdout is deliberately unrestricted: scripts must not print secrets unless those secrets are intended for the model/session transcript. Output is held in memory until process close, so keep it appropriately sized and UTF-8 encoded. Scripts have the user's permissions and inherited environment; this is not a sandbox.

Delivery is live-session-only: closing/replacing/reloading the owning runtime prevents stale callbacks from injecting into another session, and there is no durable script-output replay. Finish scripts before reload to retain delivery and overlap tracking. Running scripts are not cancelled by a schedule deletion or session pause.

### No queueing or catch-up

- Schedules run only while their owning main session is open in this project. No daemon or independent scheduler process is started.
- **Main target:** runs only when main is idle, with no pending messages or blocking UI prompt. Otherwise that trigger is skipped. Main uses its current model and settings; worker-specific options are rejected.
- **Background target:** may start while main is busy, but a running worker from the same schedule prevents overlap. Background options include `timeoutSeconds`, `provider`, `model`, and `thinking`.
- Triggers missed while closed, paused, reloading, or asleep are discarded. Recurring schedules advance to their next future deadline; expired one-shots are consumed, not replayed.
- A one-second polling timer allows up to 1.5 seconds of scheduling jitter. Longer delays skip the trigger. Multiple simultaneously due main jobs do not become a queue.
- Triggers are durably consumed before dispatch. A crash between consumption and execution can lose that run; it will **not** be replayed.
- Main history records dispatch requests, not proof of model execution or success. Background task IDs link to actual outcomes in `bg_inbox`.
- Only resume an owning session in one process at a time. Separate sessions can each have their own schedules.

These tools are provided by Pi Background itself and do not depend on other scheduling or inter-agent extensions.

## Optional temporary pause

`bg_pause` sets one **in-memory, session-local** `pausedUntil` timestamp. It is unset by default; users who never request a pause get unchanged behavior. No other integration is required.

```json
{ "pausedUntil": "2030-01-01T12:30:00Z" }
```

- `null` or `""`: clear the pause; fire normally.
- Timestamp in the past or exactly now: fire normally.
- Timestamp in the future: skip automatic activity.

Use an absolute ISO timestamp with an explicit timezone, not a duration. Each valid request **replaces** the value. There is no default duration, pause file, deferred queue or automatic early resume. Session shutdown/start, reload and restart clear it.

The pause applies to scheduled launches targeting **main, background, and script**, and automatic background-worker completion notifications. It never gates stdout delivery from an already-started script. Due schedules observed while paused are consumed as `skipped-paused`, not replayed when the pause expires. Script history records dispatch rather than confirmed process execution: a pause during environment-file reads can prevent spawning after history records `started`. Completion notifications observed during a paused poll are dropped for that activation, not queued for later delivery. Their results remain unacknowledged in `bg_inbox`; normal reload behavior can announce unread results again. Already-running workers continue. Explicit manual tools (`bg_start`, inbox access and schedule management) remain available.

### Direct extension interface

Another extension in the same Pi session can request the same operation through `pi.events`, without a model turn or conversation message. Register the response listener **before emitting**; the acknowledgment can be synchronous.

Request channel: **`pi-background:pause`**

```ts
{
  requestId: "unique-correlation-id",
  sessionId: ctx.sessionManager.getSessionId(),
  pausedUntil: "2030-01-01T12:30:00Z" // or null / "" to clear
}
```

Response channel: **`pi-background:pause:result`**

```ts
{
  requestId: "unique-correlation-id",
  sessionId: "the-matching-session-id",
  ok: true,
  pausedUntil: "2030-01-01T12:30:00.000Z" // normalized UTC, or null
}
```

Invalid timestamps produce `ok: false` with a generic `error`, without changing the previous pause. Requests with a missing/blank/oversized request ID, a different session ID, no active main owner, or a child runtime are ignored. Correlate both IDs and require an acknowledgment; emitting alone does not prove a compatible background extension is installed. An acknowledgment means the timestamp was applied, not that existing workers were cancelled.

This is a small cooperative in-process API, not an access-control boundary. The background extension knows only the supplied timestamp, never the requesting extension's reason. No changes to its normal scheduling behavior occur unless a future pause is set.

## Local data and limitations

Task prompts, JSON event logs, separate stderr logs, structured results, metadata, the registry, and schedule definitions live under:

```text
<project>/.pi/background/
```

Add `.pi/background/` to your project's `.gitignore`. These files may contain sensitive prompts, outputs, and request identifiers; they are not automatically cleaned up.

- Workers share the project's working directory. They are not separate worktrees, containers, or security sandboxes and may modify the same files.
- Workers inherit most environment variables and may access local Pi configuration and credentials. Known messaging environment variables and outward/recursive tools are filtered, and some bridge-send shell patterns are blocked. These are best-effort guardrails, not a security boundary.
- The parent owns outward communication. Workers must not send Telegram/WhatsApp messages or start nested background tasks.
- Reloading the parent does not discard saved results. A still-running worker can complete into the inbox through its original process callbacks without using a stale Pi API. Closing/killing the parent process can interrupt capture; missing worker completions become stale rather than being reported as successful.
- Timeouts request termination of the immediate child; full process-tree termination is not guaranteed. The task stays running until process close, preventing premature overlapping runs.
- Registry and schedule updates use a shared heartbeat lock and atomic replacement. Abandoned locks become recoverable after two minutes. Do not manually remove live locks.
- Before upgrading from npm `0.1.0`, finish existing workers and close/reload all old extension instances. Old and new versions use different lock protocols and must not write the same registry concurrently.
- The result parser bounds individual event lines to 4 MiB of text; oversized events are omitted from structured results and retained in the log. Incomplete/aborted/error final responses are failures even if the child exits with code zero.

## Development

```bash
npm ci
npm run validate
npm audit --audit-level=low
npm run pack:check
```

Try the checkout in Pi:

```bash
pi -e .
```

CI checks type safety, unit/integration tests, and package contents on Windows and Linux with Node.js 22 and 24. Tests cover result parsing, spawn failures, timeouts, inbox recovery/ownership, concurrent storage updates, scheduler lifecycle/skip behavior, session pauses, and Python script output/delivery without making model calls. Real-Python tests require `python3` on PATH and are skipped when it is unavailable. Only source, package metadata, this README, and the license are published.

## Publishing

Releases of `@comput/pi-background` publish automatically **only when a version tag is pushed**. Ordinary commits and GitHub Release publication do not publish; manual dispatch is disabled. Obtain explicit authorization before committing, pushing, tagging, or publishing.

### Trusted Publishing setup

In npm's Trusted Publisher settings, configure GitHub Actions with owner `mbundgaard`, repository `pi-background`, and workflow filename `publish.yml` (no GitHub environment). Existing configuration may already match. The workflow uses GitHub OIDC and provenance with `contents: read` and `id-token: write`, not a stored npm token.

### Release procedure

1. Review changes. Update `package.json`, both version fields in `package-lock.json` (for example, `npm version minor --no-git-tag-version`), and the changelog/release notes. Only stable `x.y.z` versions are supported.
2. Run `npm ci`, `npm run validate` (typecheck and tests), `npm audit --audit-level=low`, and `npm run pack:check`. Review package contents: only package metadata, README, LICENSE, and TypeScript source should ship.
3. Confirm the proposed version is unused on npm and its tag is absent locally and remotely. Check `npm view @comput/pi-background versions --json`, `git tag --list`, and `git ls-remote --tags origin`. Authentication or network errors are not proof of absence.
4. With authorization, commit and push to `main`; verify CI passes for that exact release commit.
5. Create an annotated tag pointing to that commit and push only that tag (replace the example values):

   ```bash
   git tag -a v1.2.3 <release-commit> -m "Release v1.2.3"
   git push origin refs/tags/v1.2.3
   ```

The tag push starts `.github/workflows/publish.yml`. It checks out the triggering commit, verifies the tag exactly equals `v${package.json.version}` and both lockfile versions match, then runs a clean install, typecheck, tests, security audit, and package-content checks before publishing. Do not trigger a second publication.

### Verify publication

- Verify the publishing workflow succeeded for the tag's exact commit and npm exposes the expected version and dist-tag.
- Download the published package into a temporary directory. Check its file list and compare extracted file hashes against the release commit, excluding nothing silently. Verify the downloaded tarball against npm's `dist.integrity` as well.
- Inspect npm's provenance attestation and verify its repository, publishing workflow, and source commit match the release. Workflow success alone is not proof of artifact or provenance verification.
- If status is uncertain, inspect the workflow and registry first; registry visibility may lag. Never blindly retry publication, move a release tag, or reuse a published version.

Publishing does not install the extension or reload running Pi sessions. Installation and reload remain separate actions.

## License

[MIT](LICENSE)
