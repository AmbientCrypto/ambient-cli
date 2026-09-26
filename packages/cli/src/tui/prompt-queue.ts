/**
 * One prompt on screen at a time. The agent, its subagents and background waves can all ask for an approval
 * or an answer at once, but the overlay holds a single answer slot — so prompts wait their turn here.
 * `settleWaiting()` (a cancelled or finished run) makes every prompt still waiting resolve with its
 * fallback instead of being shown.
 */
export class PromptQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private generation = 0;

  run<T>(show: () => Promise<T>, fallback: T): Promise<T> {
    const gen = this.generation;
    const turn = this.chain.then(() => (this.generation === gen ? show() : fallback));
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  settleWaiting(): void {
    this.generation += 1;
  }
}
