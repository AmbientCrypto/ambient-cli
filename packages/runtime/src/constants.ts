/** Agent-loop tuning constants — single source, shared by the turn loop and the failover sub-machine. */
// The `auto` model sentinel lives in @amb/reliability (beside resolveRequestedModel), the single home for
// model-resolution logic — import it from there, not here.

/** Upper bound on distinct models tried in one turn's failover chain. */
export const MAX_FAILOVERS = 4;
/** Times we retry the SAME worker (with backoff) on a transient blip before failing over. */
export const MAX_SAME_MODEL_RETRIES = 2;
/** Upper bound on compactions per turn (a no-op-true compaction must never spin forever). */
export const MAX_COMPACTIONS = 4;
/** How many times the verify gate re-asks the model to fix a failing verification before giving up. */
export const MAX_VERIFY_ATTEMPTS = 3;
/** How many times Stop hooks may send the agent back to work in one run. */
export const MAX_STOP_HOOK_CONTINUES = 3;

/** Identical tool-call batches in a row before the doom-loop guard stops the run (going in circles). */
export const MAX_IDENTICAL_TOOL_BATCHES = 3;

/** Repo-map budgeting: a small share of the ACTIVE model's window, hard-capped, with a floor below which a
 *  map isn't worth injecting (a tiny model spends its budget on the task, not a truncated map). */
export const REPO_MAP_FRACTION = 0.08;
export const REPO_MAP_MIN_TOKENS = 300;

/** Skills-catalog budgeting: the auto-injected `name: description` catalog scales with the SERVED model's
 *  window so it never clobbers a mini model (a 33k model gets a handful; a 262k flagship gets the full ~40)
 *  and whole entries are picked to fit — the rest stay evocable by name. Below the floor, no catalog loads. */
export const SKILLS_FRACTION = 0.03;
export const SKILLS_MIN_TOKENS = 150;

/** The share of the SERVED model's window ALL injected system context (instructions + memory + skills +
 *  repo-map + resume) may occupy — the rest is for tools + the conversation + the output reserve. Keeps a
 * small-window model from being blocked before turn 1 by an over-large anchor. */
export const INJECTED_CONTEXT_FRACTION = 0.4;

/** Consecutive turns with malformed native tool-call JSON before a model is demoted to the assisted lane. */
export const MALFORMED_STRIKES_TO_DEMOTE = 3;

/** Consecutive turns where every tool call failed before `auto` effort escalates to max. */
export const FAILED_BATCHES_TO_ESCALATE = 2;

/** How many times a prose answer cut off at the output limit is continued and stitched. */
export const MAX_FINAL_CONTINUATIONS = 2;
