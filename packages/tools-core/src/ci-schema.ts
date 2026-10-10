import { z } from "zod";

export const CiTarget = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/),
  runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const CiJob = z.object({
  databaseId: z.number().int().positive(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable().default(""),
});
export const CiSnapshot = z.object({
  status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]),
  conclusion: z.string().nullable(),
  url: z.string().url(),
  jobs: z.array(CiJob),
});
export const CiResult = CiTarget.extend({
  running: z.boolean(),
  reason: z.enum(["failure", "complete", "steered", "cancelled", "timeout", "error"]),
  snapshot: CiSnapshot.optional(),
  failedJobs: z.array(CiJob),
  logs: z.string(),
  error: z.string().optional(),
});
export type CiTarget = z.infer<typeof CiTarget>;
export type CiSnapshot = z.infer<typeof CiSnapshot>;
export type CiResult = z.infer<typeof CiResult>;
export const CI_LOG_LIMIT = 30_000;
export const CI_POLL_DELAYS = [10_000, 20_000, 40_000, 60_000] as const;
export const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);
