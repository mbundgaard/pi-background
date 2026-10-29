# Changelog

## 0.2.1

- Publish automatically from stable version-tag pushes, with exact-commit checkout and matching package/lockfile version checks.
- Require security audit and package-content validation before npm Trusted Publishing with provenance.
- Document authorized release and artifact/provenance verification procedures.
- Update the development Pi dependency to 1.4.0 and override Undici to patched 8.12.3 for this repository's dependency tree. npm overrides do not propagate to downstream consumers; this does not upgrade users' Pi installations.

## 0.2.0

- Add durable result inbox and session-owned one-shot and fixed-interval scheduling.
- Improve worker result collection, lifecycle handling, and recovery.
