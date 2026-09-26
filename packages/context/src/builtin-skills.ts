import type { SkillMeta } from "./skills.js";

/**
 * Built-in skills that SHIP with amb (embedded in code, since the CLI bundles to a single file — a
 * filesystem skill dir wouldn't travel with the binary). They behave exactly like user skills: only
 * name+description load into the prompt catalog; the body is pulled on demand via the `skill` tool. A user
 * skill of the SAME name overrides the built-in (user roots are resolved first).
 */
export interface BuiltinSkill {
  name: string;
  description: string;
  body: string;
}

/** Sentinel path prefix marking a SkillMeta as built-in (body comes from code, not the filesystem). */
export const BUILTIN_SKILL_PATH_PREFIX = "builtin:";

const GITHUB_SKILL: BuiltinSkill = {
  name: "github",
  description:
    "Clean GitHub workflow: check auth, branch, small conventional commits, push, open a PR, and merge safely (use for any git push / PR / merge / GitHub work).",
  body: `# GitHub workflow (do it cleanly, every time)

Follow these steps for any commit / push / pull-request / merge work. Prefer the \`gh\` CLI; fall back to plain \`git\` when \`gh\` isn't available.

## 0. Auth first
- Check sign-in with \`gh auth status\`. If it reports "not logged in", STOP and tell the user to run \`amb github login\` (or \`gh auth login\`) — never try to authenticate for them, and never write a token to a file or the repo.
- Confirm the remote before pushing: \`git remote -v\`. Push only where the user intends.

## 1. Never commit straight to a protected branch
- If you're on \`main\`/\`master\`, create a feature branch first: \`git switch -c <type>/<short-desc>\` (e.g. \`fix/login-race\`, \`feat/csv-export\`).
- Branch names: lowercase, hyphenated, prefixed by type (feat/fix/docs/refactor/test/chore).

## 2. Small, reviewable, conventional commits
- One logical change per commit. Don't bundle unrelated edits.
- Message format: \`<type>: <imperative summary>\` (e.g. \`fix: guard against empty catalog\`). Types: feat, fix, docs, refactor, test, chore, perf, ci.
- Body (optional): WHY the change, not a restatement of the diff.
- BEFORE committing: review \`git diff\`, run the project's tests/build, and make sure no secret (key, token, .env) is staged. Stage explicit paths (\`git add <paths>\`), not \`git add -A\` blindly.

## 3. Push
- First push of a branch: \`git push -u origin <branch>\`.
- If the push is rejected because the branch moved, \`git fetch\` then **rebase** (\`git rebase origin/<branch>\`) to keep history linear — do NOT merge the remote back in, and do NOT force-push a branch other people use. A solo feature branch may use \`git push --force-with-lease\` (never plain \`--force\`).

## 4. Open a pull request
- \`gh pr create --title "<type>: <summary>" --body "<summary + test plan>"\`. Keep PRs small and focused.
- The body should say what changed, why, and how it was verified (tests run, manual checks). Link any issue (\`Closes #123\`).
- Check CI: \`gh pr checks\`. Fix red checks before asking for review.

## 5. Review + merge safely
- Address review comments with follow-up commits; resolve threads once handled.
- Merge with a clean history — prefer squash: \`gh pr merge --squash --delete-branch\`. Use a merge commit only when the project's convention says so.
- After merge, delete the branch and \`git switch main && git pull\`.

## Hard don'ts
- Never \`git push --force\` (or \`--force-with-lease\`) to \`main\`/\`master\` or a shared branch.
- Never \`gh repo delete\`, rewrite public history, or push to a remote the user didn't ask for.
- Never commit secrets. If one was committed, tell the user immediately — it must be rotated, not just reverted.
- If anything is ambiguous (which branch, which remote, force vs rebase), ASK the user rather than guessing.`,
};

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [GITHUB_SKILL];

/** Catalog entries for the built-in skills (name + description + sentinel path). */
export function builtinSkillMetas(): SkillMeta[] {
  return BUILTIN_SKILLS.map((s) => ({
    name: s.name,
    description: s.description,
    path: `${BUILTIN_SKILL_PATH_PREFIX}${s.name}`,
  }));
}

/** The full body of a built-in skill by name, or undefined if there's no such built-in. */
export function builtinSkillBody(name: string): string | undefined {
  return BUILTIN_SKILLS.find((s) => s.name === name)?.body;
}

/** True iff a discovered skill's path is the built-in sentinel. */
export function isBuiltinSkillPath(path: string): boolean {
  return path.startsWith(BUILTIN_SKILL_PATH_PREFIX);
}
