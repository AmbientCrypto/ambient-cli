import type { ToolDefinition } from "@amb/protocol";
import { ToolRegistry } from "../registry.js";
import { applyPatchTool } from "./apply-patch.js";
import { askUserTool } from "./ask-user.js";
import { bashOutputTool, killShellTool } from "./background-tools.js";
import { bashTool } from "./bash.js";
import { diagnosticsTool } from "./diagnostics.js";
import { editTool } from "./edit.js";
import { globToRegExp, globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { listTool } from "./list.js";
import { notebookEditTool } from "./notebook-edit.js";
import { planTool } from "./plan.js";
import { proposeGoalUpdateTool } from "./propose-goal-update.js";
import { readArtifactTool } from "./read-artifact.js";
import { readTool } from "./read.js";
import { rememberTool } from "./remember.js";
import { searchSkillsTool } from "./search-skills.js";
import { skillTool } from "./skill.js";
import { makeWebFetchTool, webFetchTool } from "./web-fetch.js";
import { makeWebSearchTool, webSearchTool } from "./web-search.js";
import { writeTool } from "./write.js";

export {
  readTool,
  listTool,
  globTool,
  globToRegExp,
  grepTool,
  writeTool,
  editTool,
  applyPatchTool,
  notebookEditTool,
  diagnosticsTool,
  bashTool,
  bashOutputTool,
  killShellTool,
  planTool,
  skillTool,
  searchSkillsTool,
  rememberTool,
  readArtifactTool,
  webFetchTool,
  makeWebFetchTool,
  webSearchTool,
  makeWebSearchTool,
  askUserTool,
  proposeGoalUpdateTool,
};

/** All built-in tools. */
export const builtinTools: ToolDefinition[] = [
  readTool,
  listTool,
  globTool,
  grepTool,
  writeTool,
  editTool,
  applyPatchTool,
  notebookEditTool,
  diagnosticsTool,
  bashTool,
  bashOutputTool,
  killShellTool,
  planTool,
  skillTool,
  searchSkillsTool,
  rememberTool,
  readArtifactTool,
  webFetchTool,
  webSearchTool,
  askUserTool,
  proposeGoalUpdateTool,
];

/** Build a registry containing all built-in tools. */
export function createBuiltinRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of builtinTools) reg.register(t);
  return reg;
}
