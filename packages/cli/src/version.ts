// Build-time-injected package version (tsup `define` replaces __AMB_VERSION__); "dev" when run un-bundled.
declare const __AMB_VERSION__: string;

/** The installed CLI version, e.g. "0.4.0" (or "dev" for an un-bundled local run). */
export const CURRENT_VERSION: string =
  typeof __AMB_VERSION__ === "string" ? __AMB_VERSION__ : "dev";
