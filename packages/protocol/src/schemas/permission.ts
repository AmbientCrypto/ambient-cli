import { z } from "zod";
import { EffectSchema } from "./tool.js";

/** Permission mode ladder. */
export const ModeSchema = z.enum(["plan", "ask", "accept-edits", "bypass"]);
export type Mode = z.infer<typeof ModeSchema>;

export const GrantScopeSchema = z.enum(["once", "session", "project", "resource"]);
export type GrantScope = z.infer<typeof GrantScopeSchema>;

export const PermissionEffectSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionEffect = z.infer<typeof PermissionEffectSchema>;

export const GrantSchema = z.object({
  scope: GrantScopeSchema,
  toolName: z.string(),
  resource: z.string().optional(),
});
export type Grant = z.infer<typeof GrantSchema>;

/** Everything the permission engine needs to decide. Evaluated deny-first. */
export const PermissionInputSchema = z.object({
  principal: z.string(),
  mode: ModeSchema,
  toolName: z.string(),
  effects: z.array(EffectSchema),
  normalizedArgs: z.record(z.string(), z.unknown()).default({}),
  resolvedResources: z.array(z.string()).default([]),
  workspaceRoot: z.string(),
  grants: z.array(GrantSchema).default([]),
  /** Consecutive auto-approved mutations so far this run — feeds the accept-edits checkpoint cap. */
  autoApprovalStreak: z.number().int().nonnegative().optional(),
  /** The model's earned per-model auto-approve cap (overrides the default). Absent ⇒ the base cap. */
  autoApprovalCap: z.number().int().positive().optional(),
});
export type PermissionInput = z.infer<typeof PermissionInputSchema>;

export const PermissionDecisionSchema = z.object({
  effect: PermissionEffectSchema,
  reason: z.string(),
  grantScope: GrantScopeSchema.optional(),
});
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;
