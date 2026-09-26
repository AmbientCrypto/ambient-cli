import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRules } from "@amb/permissions";
import type { NewEvent } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandSlashCommand } from "../src/agent/command-expand.js";
import { HeadlessOutput } from "../src/agent/headless-output.js";
import { RUN_VALUE_FLAGS, parseRunArgs } from "../src/commands/run-args.js";
import { expandTaskCommand, withFlagRules } from "../src/commands/run.js";

describe("run flags", () => {
  it("reads Claude Code's headless flags", () => {
    const a = parseRunArgs([
      "-p",
      "fix the build",
      "--output-format",
      "stream-json",
      "--allowedTools",
      "Bash(npm test:*) Edit,Read",
      "--disallowedTools",
      "Bash(git push:*)",
      "--append-system-prompt",
      "Answer tersely.",
      "--permission-mode",
      "acceptEdits",
      "-c",
      "--mcp-config",
      "extra.json",
      "--strict-mcp-config",
    ]);
    expect(a.error).toBeUndefined();
    expect(a.print).toBe(true);
    expect(a.task).toBe("fix the build");
    expect(a.outputFormat).toBe("stream-json");
    expect(a.allowedTools).toEqual(["Bash(npm test:*)", "Edit", "Read"]);
    expect(a.disallowedTools).toEqual(["Bash(git push:*)"]);
    expect(a.appendSystemPrompt).toBe("Answer tersely.");
    expect(a.mode).toBe("accept-edits");
    expect(a.resume).toEqual({ from: "latest", here: true });
    expect(a.mcpConfigs).toEqual(["extra.json"]);
    expect(a.strictMcp).toBe(true);
  });

  it("rejects bad values and unknown flags, but a task may start with a dash", () => {
    expect(parseRunArgs(["--output-format", "xml", "x"]).error).toContain(
      "text, json or stream-json",
    );
    expect(parseRunArgs(["--permission-mode", "yolo", "x"]).error).toContain("--permission-mode");
    expect(parseRunArgs(["--resume"]).error).toBe("--resume needs a value");
    expect(parseRunArgs(["-z", "x"]).error).toContain('unknown flag "-z"');
    expect(parseRunArgs(["- fix the list rendering"]).task).toBe("- fix the list rendering");
    expect(parseRunArgs(["-r", "ses_abc", "go on"]).resume).toEqual({
      from: "ses_abc",
      here: false,
    });
    expect(RUN_VALUE_FLAGS.has("--resume")).toBe(true);
    expect(parseRunArgs(["--disallowedTools", "Bash(rm:* Edit", "x"]).error).toContain(
      "not a valid permission rule",
    );
    expect(parseRunArgs(["--allowedTools", "not a rule!", "x"]).error).toContain(
      "not a valid permission rule",
    );
  });

  it("adds --allowedTools / --disallowedTools to the configured rules", () => {
    const r = withFlagRules({ allow: parseRules(["Read"]), deny: [], ask: [] }, ["Edit"], ["Bash"]);
    expect(r?.allow.map((x) => x.text)).toEqual(["Read", "Edit"]);
    expect(r?.deny.map((x) => x.text)).toEqual(["Bash"]);
    expect(withFlagRules(undefined, [], [])).toBeUndefined();
  });
});

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "amb-headless-"));
  mkdirSync(join(ws, ".claude", "commands"), { recursive: true });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("commands in a headless task", () => {
  it("expands /command args; an unknown one is an error; a real path is a task", () => {
    writeFileSync(join(ws, ".claude", "commands", "fix.md"), "Fix issue $1 carefully: $ARGUMENTS");
    expect(expandTaskCommand('/fix 42 "the parser"', ws, undefined)).toEqual({
      task: "Fix issue 42 carefully: 42 the parser",
    });
    expect(expandTaskCommand("/nope", ws, undefined)).toEqual({ error: "unknown command /nope" });
    // A real folder at the root is a task about it, not a mistyped command (POSIX: Windows has no single root).
    if (process.platform !== "win32") {
      expect(expandTaskCommand("/tmp is full", ws, undefined)).toEqual({ task: "/tmp is full" });
    }
    expect(expandTaskCommand("explain /fix", ws, undefined)).toEqual({ task: "explain /fix" });
  });

  it("runs !`cmd` only when the command's allowed-tools allows it and no deny rule refuses it", () => {
    const ran: string[] = [];
    const runShell = (c: string) => {
      ran.push(c);
      return `out:${c}`;
    };
    const cmd = {
      name: "status",
      source: "user" as const,
      allowedTools: ["Bash(git status:*)", "Bash(git diff:*)"],
      body: "Status: !`git status --short`\nDiff: !`git diff`\nPush: !`git push`",
    };
    const text = expandSlashCommand(cmd, [], { workspaceRoot: ws, home: ws, runShell });
    expect(text).toContain("Status: out:git status --short");
    expect(text).toContain("Diff: out:git diff");
    expect(text).toContain("!`git push` (not run: the command's allowed-tools doesn't include it)");
    expect(ran).toEqual(["git status --short", "git diff"]);

    const denied = expandSlashCommand(cmd, [], {
      workspaceRoot: ws,
      home: ws,
      runShell,
      rules: { allow: [], ask: [], deny: parseRules(["Bash(git diff:*)"]) },
    });
    expect(denied).toContain("!`git diff` (not run: one of your deny rules refuses it)");
    expect(
      expandSlashCommand({ ...cmd, body: "!`git status && rm -rf ~`" }, [], {
        workspaceRoot: ws,
        home: ws,
        runShell,
      }),
    ).toContain("(not run");
    // A shell line only counts where the command file has one — never one built from what was typed.
    const sneaky = {
      name: "build",
      source: "project" as const,
      allowedTools: ["Bash"],
      body: "!$ARGUMENTS`echo PWNED`",
    };
    expect(
      expandSlashCommand(sneaky, [], {
        workspaceRoot: ws,
        home: ws,
        runShell,
        projectTrusted: true,
      }),
    ).toBe("!`echo PWNED`");
    expect(ran).not.toContain("echo PWNED");
    // A project's own command waits for the project to be trusted.
    const project = { ...cmd, source: "project" as const };
    expect(expandSlashCommand(project, [], { workspaceRoot: ws, home: ws, runShell })).toContain(
      "(not run: this project's commands run shell lines once you trust it — /trust)",
    );
    expect(
      expandSlashCommand(project, [], {
        workspaceRoot: ws,
        home: ws,
        runShell,
        projectTrusted: true,
      }),
    ).toContain("Status: out:git status --short");
  });

  it("attaches @files from the project, never from outside it", () => {
    writeFileSync(join(ws, "notes.md"), "PROJECT-NOTES");
    const text = expandSlashCommand(
      {
        name: "r",
        source: "project",
        body: "Review @notes.md and @../../etc/passwd and @missing.md",
      },
      [],
      { workspaceRoot: ws, home: ws },
    );
    expect(text).toContain("## @notes.md\n```\nPROJECT-NOTES\n```");
    expect(text).not.toContain("root:");
    expect(text.match(/## @/g)).toHaveLength(1);
    const denied = expandSlashCommand(
      { name: "r", source: "project", body: "Review @notes.md" },
      [],
      {
        workspaceRoot: ws,
        home: ws,
        rules: { allow: [], ask: [], deny: parseRules(["Read(./notes.md)"]) },
      },
    );
    expect(denied).not.toContain("PROJECT-NOTES");
  });
});

describe("machine-readable output", () => {
  const ev = (e: Record<string, unknown>) => e as unknown as NewEvent;
  it("stream-json: init, assistant text and tool use, tool result, then the result with token counts", () => {
    const lines: string[] = [];
    const out = new HeadlessOutput("stream-json", "ses_1", (l) => lines.push(l));
    out.init({ cwd: "/w", model: "auto", permissionMode: "ask", tools: ["read"] });
    out.handle(ev({ kind: "inference.request" }));
    out.handle(
      ev({ kind: "inference.response", promptTokens: 100, completionTokens: 20, cachedTokens: 60 }),
    );
    out.handle(
      ev({ kind: "tool.proposed", toolCallId: "tc_1", toolName: "read", args: { path: "a" } }),
    );
    out.handle(ev({ kind: "tool.result", toolCallId: "tc_1", ok: true, preview: "file text" }));
    out.handle(ev({ kind: "assistant.final", text: "Done." }));
    out.result({ stopReason: "complete", turns: 2, finalText: "Done." });
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.type)).toEqual([
      "system",
      "assistant",
      "user",
      "assistant",
      "result",
    ]);
    expect(parsed[1].message.content[0]).toEqual({
      type: "tool_use",
      id: "tc_1",
      name: "read",
      input: { path: "a" },
    });
    expect(parsed[2].message.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tc_1",
      is_error: false,
    });
    expect(parsed[4]).toMatchObject({
      subtype: "success",
      is_error: false,
      result: "Done.",
      num_turns: 2,
      session_id: "ses_1",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60 },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/cost|usd/i);
  });

  it("json: only the result; a turn limit and a failure are errors", () => {
    const lines: string[] = [];
    const out = new HeadlessOutput("json", "s", (l) => lines.push(l));
    out.handle(ev({ kind: "assistant.final", text: "x" }));
    out.result({ stopReason: "max_turns", turns: 9, finalText: "partial" });
    out.result({ stopReason: "error", turns: 0, finalText: "" }, "boom");
    expect(lines.map((l) => JSON.parse(l)).map((p) => [p.subtype, p.is_error, p.result])).toEqual([
      ["error_max_turns", true, "partial"],
      ["error_during_execution", true, "boom"],
    ]);
  });
});
