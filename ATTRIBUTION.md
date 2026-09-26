# Attribution & Reuse

`amb` is an **original** implementation. It is **not** a fork of any coding agent. Where we reuse
logic or borrow patterns, we do so cleanly (re-implemented in TypeScript) and record it here.

## License of this project

**MIT** — see [`LICENSE`](./LICENSE).

## Reused *logic* (re-implemented clean-room from our own repos)

| Source repo | License | What we re-implement | Obligation |
|---|---|---|---|
| `ambient-code-bridge` | MIT | Ambient API contract + reliability policy (output floors, escalate-on-empty, 429 classify, overflow synthesis, ready/cold substitution, learned ceilings) | MIT notice |
| `ambient-codex` | MIT | Live-catalog UX, per-model budgets, structured-output fallback, model-matrix conformance | MIT notice |
| `ambient-agents` | **Apache-2.0** | Catalog DTO/ranking, live probe cases | **Apache-2.0 NOTICE required** for derived probe/catalog logic |
| `ambient-desktop-export` | MIT | Capability-evidence precedence, context-window recovery, compaction-ladder, atomic persistence *patterns* | MIT notice |

## Patterns borrowed (ideas, not code)

- **prime-agent** (PrimeIntellect, MIT) — provider-as-config, compaction retention rules, autonomous budgets + shell gates. Attribute in NOTICE if any snippet is ported.
- **pi** (`@mariozechner`/`@earendil-works`, MIT) — the loop/tool patterns our desktop app builds on. We do **not** depend on pi.
- OSS coding agents (aider Apache-2.0, opencode MIT, Codex Apache-2.0, etc.) — architecture *patterns* only (repo-map, edit-formats, event-core, runtime model discovery). No code copied.
- **Karpathy LLM-Wiki** concept (Karpathy, public gist) + `nanzhipro/Karpathy-llm-wiki-bootstrap-skill` (**no license → all-rights-reserved**) — **pattern-only**, no code copied, for the memory subsystem.

## Rule

Before importing any third-party source verbatim, add the file + its license here and satisfy the
obligation (notice/NOTICE). Default is **re-implement, don't copy**.
