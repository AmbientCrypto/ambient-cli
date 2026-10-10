/** Ink invokes onRender after writing a frame. Defer acknowledgements past React's commit effects. */
export class FrameAcks {
  private frame = 0;
  private callbacks = new Set<() => void>();

  rendered = (): void => {
    this.frame += 1;
    this.flush();
  };

  afterRender = (callback: () => void): (() => void) => {
    this.callbacks = new Set([...this.callbacks, callback]);
    if (this.frame > 0) this.flush();
    return () => {
      this.callbacks = new Set([...this.callbacks].filter((cb) => cb !== callback));
    };
  };

  private flush(): void {
    setImmediate(() => {
      const ready = this.callbacks;
      this.callbacks = new Set();
      for (const callback of ready) callback();
    });
  }
}
