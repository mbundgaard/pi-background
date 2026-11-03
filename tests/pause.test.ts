import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePausedUntil } from "../src/pause.ts";

test("pause timestamp is absolute, timezone-qualified and optional only by null/empty", () => {
  assert.equal(parsePausedUntil(null), undefined);
  assert.equal(parsePausedUntil(""), undefined);
  assert.equal(parsePausedUntil("2030-01-01T13:00:00+01:00"), Date.parse("2030-01-01T12:00:00Z"));
  assert.equal(parsePausedUntil("2030-01-01T12:00:00.123Z"), Date.parse("2030-01-01T12:00:00.123Z"));
  for (const value of [undefined, 0, Infinity, {}, "+30m", "2030-01-01", "2030-01-01T12:00:00", "2030-02-30T12:00:00Z", "2030-01-01T12:00:00Z\n"]) {
    assert.throws(() => parsePausedUntil(value));
  }
});
