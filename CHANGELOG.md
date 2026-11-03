# Changelog

## 0.3.0

- Refresh locked dependencies to resolve the minimatch security advisory; dependency audit passes with no known vulnerabilities.

- Add session-owned one-shot/recurring `script` schedules using `python3`, absolute script paths, argument arrays and per-execution child-only `envFiles` injection, without a shell.
- Deliver nonempty script stdout unchanged to the live owning session (steer while busy), including whitespace and nonzero exits, regardless of stderr or pauses applied during execution. Empty stdout sends nothing; no retries/catch-up or same-schedule overlap.
- Add real-Python coverage for output fidelity, env-file rotation, diagnostics, pause behavior, overlap and idle/busy delivery. Script output is live-only and held in memory; no durable inbox or reload replay.
- Add optional session-local, memory-only `pausedUntil` through `bg_pause` and acknowledged `pi-background:pause` events. Accept an absolute ISO timestamp with timezone, or null/empty to clear; no default duration or persistence.
- Skip scheduled main/background/script launches and drop automatic completion notifications while paused, without catch-up. Preserve running workers and inbox results. Manual tools remain available; reload/restart clears the pause.
- Cover timestamp boundaries, expiry/reset, event scope/acknowledgment, invalid input, skipped notifications and pause changes during asynchronous preparation.

## 0.2.2

- Support both array and package-keyed object output from npm pack in the release content check.
- Includes the 0.2.1 changes; 0.2.1 publication stopped before publishing because of this check.

## 0.2.1

- Publish automatically from stable version-tag pushes, with exact-commit checkout and matching package/lockfile version checks.
- Require security audit and package-content validation before npm Trusted Publishing with provenance.
- Document authorized release and artifact/provenance verification procedures.
- Update the development Pi dependency to 1.4.0 and override Undici to patched 8.12.3 for this repository's dependency tree. npm overrides do not propagate to downstream consumers; this does not upgrade users' Pi installations.

## 0.2.0

- Add durable result inbox and session-owned one-shot and fixed-interval scheduling.
- Improve worker result collection, lifecycle handling, and recovery.
