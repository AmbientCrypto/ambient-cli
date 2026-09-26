import { createBuiltinRegistry } from "@amb/tools-core";
import { describe, expect, it } from "vitest";
import {
  AssistedDeltaFilter,
  MAX_ACTIONS,
  assistedProtocol,
  parseAssistedResponse,
  renderToolsAsText,
  stripActionBlock,
} from "../src/assisted.js";

const tools = createBuiltinRegistry().list();

describe("renderToolsAsText / assistedProtocol", () => {
  it("lists each tool as a COMPACT signature (name(params): desc) + the action protocol", () => {
    const text = renderToolsAsText(tools);
    expect(text).toContain("read("); // compact signature, not a full JSON-schema blob
    expect(text).toContain("edit(");
    expect(text).toContain("path"); // the param name is present (enough to form a call)
    expect(text).not.toContain("JSON Schema"); // the verbose schema dump is gone
    const proto = assistedProtocol(tools);
    expect(proto).toContain("amb-action");
    expect(proto).toContain('"tool"');
  });
});

describe("parseAssistedResponse", () => {
  it("parses a well-formed action envelope", () => {
    const r = parseAssistedResponse(
      'Let me read it.\n```amb-action\n{"tool":"read","args":{"path":"a.ts"}}\n```',
    );
    expect(r.kind).toBe("action");
    if (r.kind === "action") {
      expect(r.actions).toEqual([
        { tool: "read", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' },
      ]);
    }
  });

  it("parses a SINGLE-LINE fence (some weak models emit the whole envelope on one line)", () => {
    for (const reply of [
      '```amb-action {"tool":"read","args":{"path":"a.ts"}}```',
      '```amb-action{"tool":"read","args":{"path":"a.ts"}}```',
    ]) {
      const r = parseAssistedResponse(reply);
      expect(r.kind).toBe("action");
      if (r.kind === "action") {
        expect(r.actions[0]).toMatchObject({ tool: "read", args: { path: "a.ts" } });
      }
    }
    // …and it's STRIPPED from the visible text (no raw protocol JSON leaks to the user)
    expect(stripActionBlock('done ```amb-action {"tool":"read","args":{}}```')).toBe("done");
    // guard: an extended info string like ```amb-actionable is NEVER parsed as an executable action
    expect(parseAssistedResponse("```amb-actionable\nsome code\n```").kind).not.toBe("action");
  });

  it("treats a plain reply as a final answer", () => {
    const r = parseAssistedResponse("All done — the file compiles.");
    expect(r.kind).toBe("final");
    if (r.kind === "final") expect(r.text).toBe("All done — the file compiles.");
  });

  it("does NOT execute a bare ```json code block (only the explicit amb-action fence acts)", () => {
    // A model showing example code must never be run as a real action.
    const r = parseAssistedResponse(
      'Here is how you would call it:\n```json\n{"tool":"list","args":{"path":"."}}\n```',
    );
    expect(r.kind).toBe("final");
  });

  it("returns an error (for repair) on malformed JSON in the action block", () => {
    const r = parseAssistedResponse("```amb-action\n{tool: read}\n```");
    expect(r.kind).toBe("error");
  });

  it("returns an error (repair) when the model MENTIONS amb-action but the fence is unterminated", () => {
    const r = parseAssistedResponse('I\'ll act now.\n```amb-action\n{"tool":"read","args":{}}');
    expect(r.kind).toBe("error");
  });

  it("returns an error when args is a non-object (string/array)", () => {
    expect(parseAssistedResponse('```amb-action\n{"tool":"read","args":"a.ts"}\n```').kind).toBe(
      "error",
    );
    expect(parseAssistedResponse('```amb-action\n{"tool":"read","args":[1,2]}\n```').kind).toBe(
      "error",
    );
  });

  it("nudges (repair) a BARE unfenced action instead of silently ending the run", () => {
    // A weak model emits the JSON action with no fence — must NOT be treated as a final answer.
    const r = parseAssistedResponse('{"tool":"read","args":{"path":"a.ts"}}');
    expect(r.kind).toBe("error");
    // But a genuine prose answer that merely mentions the word tool is still a final answer.
    expect(parseAssistedResponse("I used the read tool and here is the result.").kind).toBe(
      "final",
    );
    // A JSON object that isn't an action (no string `tool`) is still a final answer.
    expect(parseAssistedResponse('{"result": 42}').kind).toBe("final");
    // A legit final JSON with a `tool` key but NO args object is a final answer, NOT an action (
    // else a model obeying a JSON output format loops to maxTurns).
    expect(parseAssistedResponse('{"tool":"hammer","version":1}').kind).toBe("final");
  });

  it("acts on every block in order when several are present", () => {
    const r = parseAssistedResponse(
      '```amb-action\n{"tool":"read","args":{"path":"a"}}\n```\n```amb-action\n{"tool":"list","args":{}}\n```',
    );
    expect(r.kind).toBe("action");
    if (r.kind === "action") expect(r.actions.map((a) => a.tool)).toEqual(["read", "list"]);
  });

  it("a broken block among several asks for a repair instead of running a partial set", () => {
    const r = parseAssistedResponse(
      '```amb-action\n{"tool":"read","args":{"path":"a"}}\n```\n```amb-action\n{"tool":\n```',
    );
    expect(r.kind).toBe("error");
  });

  it("acts on at most MAX_ACTIONS blocks", () => {
    const block = '```amb-action\n{"tool":"list","args":{}}\n```\n';
    const r = parseAssistedResponse(block.repeat(MAX_ACTIONS + 3));
    if (r.kind === "action") expect(r.actions).toHaveLength(MAX_ACTIONS);
    else throw new Error("expected actions");
  });

  it("returns an error when the tool field is missing", () => {
    const r = parseAssistedResponse('```amb-action\n{"args":{}}\n```');
    expect(r.kind).toBe("error");
  });

  it("defaults args to {} when omitted", () => {
    const r = parseAssistedResponse('```amb-action\n{"tool":"list"}\n```');
    expect(r.kind).toBe("action");
    if (r.kind === "action") expect(r.actions[0]?.args).toEqual({});
  });
});

describe("stripActionBlock", () => {
  it("removes the action envelope leaving the reasoning text", () => {
    const t = stripActionBlock(
      'Reading the file.\n```amb-action\n{"tool":"read","args":{"path":"a"}}\n```',
    );
    expect(t).toBe("Reading the file.");
  });
  it("strips an UNTERMINATED action fence through EOF (no raw scaffolding leaks as an answer)", () => {
    const t = stripActionBlock(
      'Reading the file.\n```amb-action\n{"tool":"read","args":{"path":"a"}}',
    );
    expect(t).toBe("Reading the file.");
    expect(t).not.toContain("amb-action");
    expect(t).not.toContain("{");
  });
  it("does NOT strip a FENCED prefix (```amb-actionable) — the info string must be exactly amb-action", () => {
    // The naive `\`\`\`amb-action[\s\S]*$` would wrongly strip this (amb-action is a prefix of amb-actionable).
    const t = stripActionBlock("Notes below.\n```amb-actionable\n- item one\n- item two\n```");
    expect(t).toContain("item one");
    expect(t).toContain("amb-actionable"); // the block itself is preserved — it isn't our envelope
  });

  it("does NOT strip an INLINE (non-line-start) amb-action mention", () => {
    // The naive unanchored regex would strip from a mid-line ```amb-action to EOF; ours requires a line start.
    const t = stripActionBlock(
      "Use the ```amb-action``` envelope to call a tool, then continue working.",
    );
    expect(t).toContain("then continue working.");
  });

  it("strips a fence indented up to 3 spaces (Markdown allows it)", () => {
    const t = stripActionBlock('Reading.\n   ```amb-action\n{"tool":"read","args":{"path":"a"}}');
    expect(t).toBe("Reading.");
    expect(t).not.toContain("amb-action");
  });

  it('strips a BARE (unfenced) action object that is the whole reply — never leak raw {"tool":…} JSON', () => {
    // A weak model emits its tool call with no fence. parseAssistedResponse nudges it to repair; the display
    // path must not show the raw envelope (the wall of `{"command":…}` the user reported).
    expect(stripActionBlock('{"tool":"bash","args":{"command":"wc -l a.log"}}')).toBe("");
    expect(stripActionBlock('  {"tool":"read","args":{"path":"a"}}  ')).toBe("");
  });

  it("keeps a legitimate final JSON answer that is NOT an action envelope", () => {
    // {tool} without an args OBJECT is a real answer, not a call — must survive (not be blanked).
    const t = stripActionBlock('{"tool":"hammer","version":1}');
    expect(t).toBe('{"tool":"hammer","version":1}');
  });
});

describe("streaming an assisted reply", () => {
  const run = (chunks: string[]) => {
    const f = new AssistedDeltaFilter();
    return chunks.map((c) => f.push(c)).join("");
  };
  it("streams prose and holds back the action block, even split across chunks", () => {
    expect(run(["Let me read ", "the file.\n``", "`amb-", 'action\n{"tool":"read"}\n```'])).toBe(
      "Let me read the file.",
    );
  });
  it("lets ordinary code fences through", () => {
    expect(run(["Use this:\n```ts\nconst a = 1;\n```\nDone."])).toBe(
      "Use this:\n```ts\nconst a = 1;\n```\nDone.",
    );
  });
  it("never streams a reply that starts as bare JSON", () => {
    expect(run(['  {"tool":"read",', '"args":{}}'])).toBe("");
  });
  it("a closing code fence at the very end is flushed, not lost", () => {
    const f = new AssistedDeltaFilter();
    const text = "First.\n\nSecond:\n\n```js\nconst x = 1;\n```";
    const out = [text.slice(0, 20), text.slice(20)].map((c) => f.push(c)).join("") + f.flush();
    expect(out).toBe(text);
  });
  it("`amb-actionable` is an ordinary fence; an unfinished action fence is never flushed", () => {
    const f = new AssistedDeltaFilter();
    const text = "Sure.\n\n```amb-actionable\nexample\n```\n\nMore text";
    expect(f.push(text) + f.flush()).toBe(text);
    const g = new AssistedDeltaFilter();
    expect(g.push("Done.\n```amb-act") + g.flush()).toBe("Done.");
  });
  it("a plain answer streams whole", () => {
    expect(run(["The answer ", "is 42."])).toBe("The answer is 42.");
  });
});
