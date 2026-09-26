import { tmpdir } from "node:os";
import type { CatalogModel, PermissionDecision } from "@amb/protocol";
import type { ChatClient, TurnCompletion } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../src/tui/App.js";
import {
  APPROVAL_SETTLE_MS,
  Approval,
  type ApprovalRequest,
  defaultApprovalSel,
  resolveApprovalKey,
} from "../src/tui/components/Approval.js";

const stubWriter = () => ({ append() {} }) as unknown as SessionWriter;

const decision = (reason = ""): PermissionDecision => ({ effect: "ask", reason });

const writeReq: ApprovalRequest = {
  toolName: "write",
  args: { path: "src/util.ts", content: "export const A = 1;\nexport const B = 2;\n" },
  effects: ["write", "read"],
  decision: decision(),
};
const bashRiskReq: ApprovalRequest = {
  toolName: "bash",
  args: { command: "rm -rf node_modules" },
  effects: ["process"],
  decision: decision("risk: recursive delete of node_modules"),
};

// ── the interaction contract: BOTH arrow+Enter AND letter hotkeys reach the same four outcomes ──
describe("keys typed as a prompt appears don't answer it", () => {
  const noKey = {};
  it("ignores letters, Enter and space right after it appears; Esc still denies", () => {
    for (const ch of ["a", "b", "y", " "]) {
      expect(resolveApprovalKey(ch, noKey, 0, 50)).toEqual({ t: "none" });
    }
    expect(resolveApprovalKey("", { return: true }, 0, 50)).toEqual({ t: "none" });
    expect(resolveApprovalKey("", { escape: true }, 0, 50)).toEqual({
      t: "confirm",
      decision: "deny",
    });
    expect(resolveApprovalKey("a", noKey, 0, APPROVAL_SETTLE_MS + 1)).toEqual({
      t: "confirm",
      decision: "allow-session",
    });
  });
  it("a burst of characters (typing or a paste) never answers", () => {
    expect(resolveApprovalKey("a b", noKey, 0, 5_000)).toEqual({ t: "none" });
  });
});

describe("resolveApprovalKey (arrow + hotkey parity)", () => {
  const noKey = {};
  it("↑/↓ move the cursor and CLAMP at the ends (never wrap) across all FOUR rows", () => {
    expect(resolveApprovalKey("", { downArrow: true }, 0)).toEqual({ t: "move", sel: 1 });
    expect(resolveApprovalKey("", { downArrow: true }, 2)).toEqual({ t: "move", sel: 3 });
    expect(resolveApprovalKey("", { downArrow: true }, 3)).toEqual({ t: "move", sel: 3 }); // clamp bottom
    expect(resolveApprovalKey("", { upArrow: true }, 0)).toEqual({ t: "move", sel: 0 }); // clamp top
    expect(resolveApprovalKey("", { upArrow: true }, 3)).toEqual({ t: "move", sel: 2 });
  });
  it("Enter and Space confirm the CURRENTLY-SELECTED row (arrow path)", () => {
    expect(resolveApprovalKey("", { return: true }, 0)).toEqual({
      t: "confirm",
      decision: "allow-once",
    });
    expect(resolveApprovalKey("", { return: true }, 1)).toEqual({
      t: "confirm",
      decision: "allow-session",
    });
    expect(resolveApprovalKey("", { return: true }, 2)).toEqual({
      t: "confirm",
      decision: "bypass",
    });
    expect(resolveApprovalKey("", { return: true }, 3)).toEqual({ t: "confirm", decision: "deny" });
    expect(resolveApprovalKey(" ", noKey, 1)).toEqual({ t: "confirm", decision: "allow-session" });
  });
  it("y/a/b/n jump-and-confirm in one keystroke, regardless of the cursor (hotkey path)", () => {
    expect(resolveApprovalKey("y", noKey, 3)).toEqual({ t: "confirm", decision: "allow-once" });
    expect(resolveApprovalKey("a", noKey, 0)).toEqual({ t: "confirm", decision: "allow-session" });
    expect(resolveApprovalKey("b", noKey, 0)).toEqual({ t: "confirm", decision: "bypass" });
    expect(resolveApprovalKey("n", noKey, 0)).toEqual({ t: "confirm", decision: "deny" });
  });
  it("Esc denies (safe cancel); Ctrl+C aborts the whole run; other keys are ignored", () => {
    expect(resolveApprovalKey("", { escape: true }, 0)).toEqual({ t: "confirm", decision: "deny" });
    expect(resolveApprovalKey("c", { ctrl: true }, 0)).toEqual({ t: "abort" });
    expect(resolveApprovalKey("z", noKey, 1)).toEqual({ t: "none" });
  });
  it("a MODIFIED key never approves — Ctrl+A / Ctrl+Y / Meta+letter are ignored", () => {
    // Ink reports Ctrl+A as ch:"a" + ctrl — it must NOT reach the allow-session branch.
    expect(resolveApprovalKey("a", { ctrl: true }, 3)).toEqual({ t: "none" });
    expect(resolveApprovalKey("y", { ctrl: true }, 3)).toEqual({ t: "none" });
    expect(resolveApprovalKey("b", { meta: true }, 3)).toEqual({ t: "none" });
    expect(resolveApprovalKey(" ", { meta: true }, 0)).toEqual({ t: "none" }); // Meta+Space can't confirm
    // but Ctrl+C still aborts (handled before the guard)
    expect(resolveApprovalKey("c", { ctrl: true }, 0)).toEqual({ t: "abort" });
  });
  it("normalizes a corrupted selection to the safe row before arrow math", () => {
    expect(resolveApprovalKey("", { downArrow: true }, -5)).toEqual({ t: "move", sel: 3 }); // → deny, then clamp
    expect(resolveApprovalKey("", { upArrow: true }, 10)).toEqual({ t: "move", sel: 2 }); // → deny(3), up → 2
    expect(resolveApprovalKey("", { return: true }, Number.NaN)).toEqual({
      t: "confirm",
      decision: "deny", // a NaN selection confirms the SAFE choice, never a random allow
    });
  });
});

describe("defaultApprovalSel (pre-armed selection)", () => {
  it("normal ask → allow-once (0); risk/checkpoint → deny (the last row, 3)", () => {
    expect(defaultApprovalSel("")).toBe(0);
    expect(defaultApprovalSel("risk: recursive delete")).toBe(3);
    expect(defaultApprovalSel("autonomy checkpoint reached")).toBe(3);
  });
});

// ── the visual treatment (Native-calm): plain-English header, selectable list, │-gutter preview ──
describe("Approval modal render", () => {
  it("shows a plain-English header, all three choices with hotkey badges, and the ▸ cursor on the selection", () => {
    const { lastFrame } = render(<Approval req={writeReq} width={92} selected={0} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("Allow"); // plain-English decision header (graft)
    expect(f).toContain("src/util.ts"); // the emphasized target
    expect(f).toContain("[y]"); // hotkey badges fused to each row…
    expect(f).toContain("[a]");
    expect(f).toContain("[b]");
    expect(f).toContain("[n]");
    expect(f).toContain("Allow once");
    expect(f).toContain("Allow session");
    expect(f).toContain("Bypass session"); // the new session-wide bypass choice
    expect(f).toContain("skip all prompts this session");
    expect(f).toContain("Deny");
    expect(f).toContain("▸"); // the selection cursor is present
    expect(f).toContain("│"); // the preview is bound in a │ gutter
    expect(f).toContain("export const A = 1"); // the diff content is shown
    // a preview content line carries BOTH the gutter and the change
    expect(f.split("\n").find((l) => l.includes("export const A = 1"))).toContain("│");
  });

  it("moves the ▸ cursor to the row matching `selected` (0=allow-once, 2=bypass, 3=deny)", () => {
    const at = (n: number) =>
      (render(<Approval req={writeReq} width={92} selected={n} />).lastFrame() ?? "").split("\n");
    // the cursor line contains BOTH ▸ and the label of the selected option
    expect(at(0).find((l) => l.includes("▸"))).toContain("Allow once");
    expect(at(2).find((l) => l.includes("▸"))).toContain("Bypass session");
    expect(at(3).find((l) => l.includes("▸"))).toContain("Deny");
  });

  it("a bash request reads as 'Run <command>?' and a risk request shows the ⚠ callout", () => {
    const f = render(<Approval req={bashRiskReq} width={92} selected={3} />).lastFrame() ?? "";
    expect(f).toContain("Run"); // command header verb
    expect(f).toContain("rm -rf node_modules");
    expect(f).toContain("⚠"); // the risk callout glyph
    expect(f).toContain("recursive delete"); // the reason
    expect(f.split("\n").find((l) => l.includes("▸")) ?? "").toContain("Deny"); // deny pre-selected on risk
  });

  it("selection survives WITHOUT color (▸ cursor + [n] badge carry it, not just cyan)", () => {
    // ink-testing-library emits no ANSI, so this frame is already color-free — the cursor + badges must read.
    const f = render(<Approval req={writeReq} width={92} selected={1} />).lastFrame() ?? "";
    const cursorLine = f.split("\n").find((l) => l.includes("▸")) ?? "";
    expect(cursorLine).toContain("[a]");
    expect(cursorLine).toContain("Allow session"); // the glyph, not color, tells you what's selected
  });

  it("honors maxPreview (bounds the preview) and never drops a choice — the App shrinks it on short terminals", () => {
    const bigDiff: ApprovalRequest = {
      toolName: "write",
      args: {
        path: "big.ts",
        content: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"),
      },
      effects: ["write"],
      decision: decision(),
    };
    const f =
      render(<Approval req={bigDiff} width={92} selected={0} maxPreview={4} />).lastFrame() ?? "";
    // write content renders as "+ line N" inside the │ gutter — match the REAL format, not a phantom.
    const previewLines = f.split("\n").filter((l) => /│ \+ line \d/.test(l));
    expect(previewLines).toHaveLength(4); // EXACTLY the budget (60 lines available, capped at 4)…
    expect(f).toContain("more lines"); // …with an honest overflow marker…
    // …and every choice + hotkey is still present (the App sizes maxPreview so these stay on-screen)
    for (const s of ["Allow once", "Allow session", "Bypass session", "Deny", "[y]", "[b]", "[n]"])
      expect(f).toContain(s);
  });

  it("maxPreview=0 drops the preview entirely (choices win the vertical budget on a tiny terminal)", () => {
    const bigDiff: ApprovalRequest = {
      toolName: "write",
      args: { path: "big.ts", content: Array.from({ length: 40 }, (_, i) => `x${i}`).join("\n") },
      effects: ["write"],
      decision: decision(),
    };
    const f =
      render(<Approval req={bigDiff} width={92} selected={0} maxPreview={0} />).lastFrame() ?? "";
    expect(f.includes("+ x0")).toBe(false); // no preview CONTENT (real format is "+ x0")…
    expect(f.includes("┄")).toBe(false); // …and the preview's dotted rule is gone entirely
    expect(f.includes("more lines")).toBe(false); // …no overflow marker either
    for (const s of ["Allow once", "Bypass session", "Deny"]) expect(f).toContain(s); // choices remain
  });

  it("never emits a line wider than the terminal, even at a narrow width with a long path", () => {
    const longPath: ApprovalRequest = {
      toolName: "apply_patch",
      args: { path: "packages/runtime/src/very/deeply/nested/module/agent-support.ts" },
      effects: ["write", "read"],
      decision: decision(),
    };
    const W = 44;
    const f = render(<Approval req={longPath} width={W} selected={0} />).lastFrame() ?? "";
    for (const l of f.split("\n")) expect(l.length).toBeLessThanOrEqual(W);
    expect(f).toContain("Deny"); // the actionable choices still render
    expect(f).toContain("Allow"); // the header still reads
  });
});

// ── end-to-end: the approval loop actually resolves via a keystroke AND the run reaches its final answer ──
describe("App: approval interaction end to end", () => {
  const readyFleet = [
    {
      avail: "ready" as const,
      id: "vendor/m",
      ctx: "262k",
      lane: "direct" as const,
      vision: "vision:no",
    },
  ];
  const catalog: CatalogModel[] = [
    {
      id: "vendor/m",
      name: "m",
      inputModalities: [],
      outputModalities: [],
      supportedFeatures: ["tools"],
      supportedSamplingParameters: [],
      contextLength: 262_144,
      maxOutputLength: 262_144,
      isReady: true,
    },
  ];
  const bashCall = (id: string, command: string): TurnCompletion => ({
    content: "",
    toolCalls: [{ id, name: "bash", args: { command }, rawArgs: JSON.stringify({ command }) }],
  });
  const client = (chat: ChatClient["chat"]): ChatClient => ({
    fetchCatalog: async () => catalog,
    chat,
  });
  const renderApp = (deps: { client: ChatClient; permission: "ask" | "accept-edits" | "bypass" }) =>
    render(
      <App
        client={deps.client}
        makeWriter={stubWriter}
        agentMode="build"
        permission={deps.permission}
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={6}
        cwd={tmpdir()}
        workspaceRoot={tmpdir()}
        fleet={readyFleet}
        initialTask="do it"
      />,
    );
  // Polls, so it returns as soon as the frame appears; the ceiling only matters on a loaded machine.
  const waitFor = async (fn: () => boolean, ms = 12_000): Promise<void> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("waitFor timed out");
  };

  it("deny: the redesigned modal appears; the deny hotkey resolves it AND the run reaches its final answer", async () => {
    const c = client(
      async (p) =>
        p.messages.some((m) => m.role === "tool")
          ? { content: "ALL-DONE", toolCalls: [] }
          : bashCall("t1", "touch hi.txt"), // a MUTATING command still prompts (read-only bash auto-allows now)
    );
    const { stdin, lastFrame, unmount } = renderApp({ client: c, permission: "ask" });
    await waitFor(() => (lastFrame() ?? "").includes("Permission needed"));
    expect(lastFrame() ?? "").toContain("Run touch hi.txt?"); // the redesigned plain-English header, live
    await new Promise((r) => setTimeout(r, APPROVAL_SETTLE_MS + 50)); // a person reads it first
    stdin.write("n"); // deny via the hotkey
    // reaching the final answer proves resolve("deny") fired and the agent continued (not merely modal-gone)
    await waitFor(() => (lastFrame() ?? "").includes("ALL-DONE"));
    unmount();
  });

  it("bypass: pressing [b] lets a SECOND gated call EXECUTE with NO further prompt (bypass wiring)", async () => {
    let secondExecuted = false;
    let toolOutputs: string[] = [];
    const c = client(async (p) => {
      const toolMsgs = p.messages.filter((m) => m.role === "tool" && typeof m.content === "string");
      // A tee pipeline WRITES (not read-only → it prompts) yet still echoes a detectable marker to stdout.
      if (toolMsgs.length === 0) return bashCall("a", "echo one | tee /dev/null");
      if (toolMsgs.length === 1) return bashCall("b", "echo two | tee /dev/null"); // 2nd gated call — must NOT prompt again
      // both settled: did `echo two` actually RUN (bypass → allow) or get silently DENIED? Its stdout proves it.
      secondExecuted = toolMsgs.some((m) => (m.content as string).includes("two"));
      toolOutputs = toolMsgs.map((m) => String(m.content).slice(0, 300));
      return { content: "ALL-DONE", toolCalls: [] };
    });
    const { stdin, lastFrame, unmount } = renderApp({ client: c, permission: "ask" });
    await waitFor(() => (lastFrame() ?? "").includes("Permission needed"));
    await new Promise((r) => setTimeout(r, APPROVAL_SETTLE_MS + 50));
    stdin.write("b"); // Bypass session — one keystroke, no more input after this
    // If bypass DIDN'T short-circuit the 2nd call, the run would hang on a new modal and this would TIME OUT.
    await waitFor(() => (lastFrame() ?? "").includes("ALL-DONE"));
    // the 2nd gated command EXECUTED (bypass allowed it, not silent-deny); on failure, show what the tools returned
    expect(secondExecuted, JSON.stringify(toolOutputs)).toBe(true);
    expect((lastFrame() ?? "").toLowerCase()).toContain("bypass"); // the session flipped to bypass
    unmount();
  });
});
