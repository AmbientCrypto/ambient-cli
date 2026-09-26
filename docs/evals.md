# Eval harness — the project-local ship gate

> "Evals over vibes." (Karpathy A5) A vibe-check tells you an answer *felt* right once. An eval tells you a
> real task still passes after you switched from Kimi to GLM, edited a prompt, or bumped a dependency — as a
> number, tracked over time. `amb eval` is that gate.

## What it is

Each **task** is a prompt plus **deterministic checks** that define success. A task passes only when *every*
check passes — never on the model's say-so. "Done" is coupled to verification.

Tasks live in `.ambient/evals/<suite>.json`:

```json
{
  "name": "smoke",
  "tasks": [
    {
      "id": "adds-a-function",
      "prompt": "Create util.ts exporting `add(a, b)` that returns a + b.",
      "checks": [
        { "kind": "completed" },
        { "kind": "file_exists", "path": "util.ts" },
        { "kind": "file_contains", "path": "util.ts", "text": "export" }
      ]
    },
    {
      "id": "fixes-a-failing-test",
      "prompt": "The test in sum.test.js fails. Make it pass without changing the test.",
      "setup": {
        "files": [
          { "path": "sum.js", "content": "export const sum = (a, b) => a - b;\n" },
          { "path": "sum.test.js", "content": "import { sum } from './sum.js'; if (sum(2,2)!==4) { process.exit(1); }\n" }
        ]
      },
      "checks": [
        { "kind": "completed" },
        { "kind": "command_succeeds", "command": "node sum.test.js" }
      ]
    }
  ]
}
```

Each task runs the agent in an **isolated scratch workspace** (seeded with its `setup.files`), then the checks
read that workspace. The scratch dir is always torn down, even if a check throws.

## Trust model (important)

`amb eval` **executes code** — the same trust model as `npm test` or CI. A `command_succeeds` check runs a
command, and a task's whole point is often for the agent to *write* a file that the command then executes. Run
only suites you trust, from repos you trust.

What the harness *does* constrain: the eval agent runs with a **file-only tool allowlist** (read/list/glob/
grep/write/edit/apply_patch/plan/remember/read_artifact). Its file edits are path-firewalled to the scratch dir,
and it has **no `bash`, no network, no subagents**, so the model can't directly shell out or reach the network.
The eval prompt is **hermetic** — instructions come from the scratch dir only, and no global skills are loaded
— so results don't depend on your host `~/.claude` setup.

It is **not** an OS sandbox, though: a check command still runs on your machine, and the run writes its session
log + checkpoint/artifact blobs under `~/.ambient/` like any `ambient` run (not inside the scratch dir). A real
OS sandbox (rooted at the scratch dir) that would make running *untrusted* suites safe is a planned follow-up.

## Check kinds

| kind | passes when |
|---|---|
| `completed` | the run ends `complete` (not blocked/looping/error/max_turns) |
| `file_exists` | `path` exists in the workspace after the run |
| `file_contains` | `path` exists and contains the substring `text` |
| `command_succeeds` | `command` exits 0 in the workspace |
| `output_contains` | the agent's final answer contains `text` |

## Running it

```bash
amb eval smoke                       # run the "smoke" suite on the auto model
amb eval smoke --model z-ai/glm-5.2  # evaluate a specific model
amb eval smoke --min-pass-rate 0.8   # exit 1 if fewer than 80% pass
amb eval smoke --save-baseline       # record this run as the baseline
amb eval smoke --baseline            # exit 1 on ANY regression vs the saved baseline
amb eval smoke --json                # emit the full EvalReport as JSON (for CI)
```

If only one suite exists in `.ambient/evals/`, the name is optional: `amb eval`.

## The gate

`amb eval` exits **non-zero** when:

- `--min-pass-rate <r>` is set and the pass rate is below `r`, or
- `--baseline` is set and any task that passed in the baseline now fails (a **regression**).

A regression blocks even when the overall pass rate is unchanged — a swap that fixes one task and breaks
another is not a wash. Wire `amb eval <suite> --baseline` into CI to catch model/prompt drift before it ships.
