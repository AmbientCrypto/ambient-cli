import { z } from "zod";

/** Autonomy lane a model can run in, derived from capability evidence (never hardcoded). */
export const LaneSchema = z.enum(["direct", "assisted", "unknown", "unavailable"]);
export type Lane = z.infer<typeof LaneSchema>;

/** Where a capability fact came from. Precedence when combining: learned > probed > declared > assumed. */
export const CapabilityProvenanceSchema = z.enum(["declared", "probed", "learned", "assumed"]);
export type CapabilityProvenance = z.infer<typeof CapabilityProvenanceSchema>;
