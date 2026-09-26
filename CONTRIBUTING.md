# Contributing — engineering standards (HARD RULES)

These are non-negotiable. The goal: the Ambient CLI stays **small, reviewable, debuggable, and easy to
change** as features grow — it must never rot into a bloated monolith no one can safely touch.

## The hard rules

1. **Many small, focused files.** 200–400 lines typical, **800 hard max**. A file does one thing. If it
   grows past that, extract a module. High cohesion, low coupling.
   - *One documented exception:* `packages/runtime/src/agent.ts` — the core agent state machine. It is a single
     cohesive intake→resolve→stream→tool→verify→compact loop; fragmenting it purely to hit a line count would
     hurt readability more than help. Genuinely separable concerns HAVE been extracted (`agent-support.ts`,
     `failover.ts`, `compaction-runner.ts`, `execute-tools.ts`); the residual (~940 lines) is the irreducible
     loop. New concerns still get their own module — the loop itself does not grow unbounded.

2. **Respect the package boundaries — never glue the harness to the shell.**
   - Harness (pure logic, no UI): `protocol` · `ambient-api` · `reliability` · `capabilities` · `context` ·
     `permissions` · `tools-core` · `sessions` · `runtime`.
   - Shell (the terminal UI): `cli` (`tui/`, `commands/`, `agent/`, `render/`).
   - The runtime is a **pure event producer**; the TUI is a **pure event consumer** over a **pure reducer**.
     No React in `state.ts`; no agent logic in components; no `fs`/network in policy modules (state in →
     decision out). Ports (`ports.ts`) are the only seam between them.

3. **Validate at every boundary with Zod.** Provider responses, the catalog, events, tool args, permissions,
   persistence — all parsed, never trusted. Fail fast with a clear message.

4. **Immutable data only.** New objects, never mutation (the reducer especially). This is what keeps state
   trustworthy and bugs shallow.

5. **Small stable tool set.** Ship a lean built-in core; add power via MCP/skills/plugins later — never a
   wall of 40 built-in tools. A new tool must justify its place in the core or live behind discovery.

6. **Every change ships with tests, and the gate stays green.** `pnpm -r exec tsc --noEmit` clean across all
   packages, `biome check` clean, the full `pnpm test` green, `pnpm -r build` OK — before every commit.
   A test must be able to FAIL if the behavior it guards regresses (no tautologies).

7. **Commit in small, reviewable slices** with a message that says *what changed and why*. One concern per
   commit. Never mix a big reformat with a behavior change.

8. **Review after every ship.** A careful review pass on the diff; fix real findings with tests. Green ≠
   correct until it's been reviewed.

9. **No dead code, no built-but-not-wired seams.** If it's in the codebase it's reachable and tested, or it's
   deleted. If a capability is deferred, say so clearly in the PR — don't leave it half-wired.

10. **Ambient-native, clean-room, own code.** Ambient-only (host-pinned `*.ambient.xyz`, live catalog — never
    a hardcoded model list). Reuse *patterns* from other agents with attribution; never copy proprietary or
    unlicensed code. The differentiator is the living multi-model fleet, not a clone of anyone.

11. **Agent-readable CLI.** Structured `--jsonl` output, stable exit codes, good `--help`, idempotent commands.
    Agents are half the users.

## Before you commit (the checklist)

```
pnpm -r exec tsc --noEmit   # clean, all packages
pnpm biome check .          # clean (use --write to auto-fix)
pnpm test                   # green
pnpm -r build               # ok
```

Then a small, well-described commit. If the change is non-trivial, run a careful review on the diff and
fix what's real before moving on.
