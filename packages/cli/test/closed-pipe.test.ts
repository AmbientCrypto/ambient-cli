import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { exitQuietlyOnClosedPipe } from "../src/closed-pipe.js";

describe("a terminal that goes away", () => {
  it.each(["EIO", "ENXIO", "EBADF"])("%s on stdout is not a crash", (code) => {
    const stream = new EventEmitter() as unknown as NodeJS.WriteStream;
    exitQuietlyOnClosedPipe(stream);
    expect(() => stream.emit("error", Object.assign(new Error(code), { code }))).not.toThrow();
  });
  it("any other write error still surfaces", () => {
    const stream = new EventEmitter() as unknown as NodeJS.WriteStream;
    exitQuietlyOnClosedPipe(stream);
    expect(() => stream.emit("error", Object.assign(new Error("x"), { code: "ENOSPC" }))).toThrow();
  });
});
