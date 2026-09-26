/**
 * Bounded output capture that keeps a HEAD and a rolling TAIL. Command output is capped to avoid
 * context/memory blowups, but — unlike a naive head-only cut — the TAIL is preserved because the
 * real error message usually lives at the end (error-biased truncation). Text is joined on a UTF-8
 * character boundary via string slicing (we accumulate decoded strings, never split a code point).
 */
export class BoundedCapture {
  private head = "";
  private tail = "";
  private dropped = 0;
  private readonly halfMax: number;

  constructor(private readonly max: number) {
    this.halfMax = Math.floor(max / 2);
  }

  write(chunk: string): void {
    if (this.head.length < this.halfMax) {
      const room = this.halfMax - this.head.length;
      this.head += chunk.slice(0, room);
      const overflow = chunk.slice(room);
      if (overflow) this.pushTail(overflow);
    } else {
      this.pushTail(chunk);
    }
  }

  private pushTail(chunk: string): void {
    this.tail += chunk;
    if (this.tail.length > this.halfMax) {
      const over = this.tail.length - this.halfMax;
      this.tail = this.tail.slice(over);
      this.dropped += over;
    }
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  text(): string {
    if (!this.truncated) return this.head + this.tail;
    return `${this.head}\n…[${this.dropped} bytes truncated]…\n${this.tail}`;
  }
}
