/** Optional in-process API. No caller-specific integrations or persistent state. */
export const PAUSE_REQUEST_EVENT = "pi-background:pause";
export const PAUSE_RESULT_EVENT = "pi-background:pause:result";
export interface PauseRequest { requestId: string; sessionId: string; pausedUntil: string | null }
export interface PauseResult { requestId: string; sessionId: string; ok: boolean; pausedUntil?: string | null; error?: string }

/** Absolute ISO timestamp with timezone, or null/empty to clear. Never accepts durations. */
export function parsePausedUntil(value: unknown): number | undefined {
  if (value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("pausedUntil must be an absolute ISO timestamp with timezone, or null/empty to clear");
  }
  const timestamp = Date.parse(value);
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10) || value.trim() !== value) throw new Error("Invalid pausedUntil timestamp");
  return timestamp;
}
