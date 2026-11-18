import { describe, expect, it } from "vitest";
import { decodeLivePcm, encodeLivePcm, livePcmRate } from "./live-pcm.js";

describe("live PCM", () => {
  it("encodes signed little endian and clips peaks", () => {
    expect([...encodeLivePcm(new Float32Array([-2, 0, 2]), 16000)]).toEqual([
      0, 128, 0, 0, 255, 127,
    ]);
  });
  it("averages downsampled mono audio at 16 kHz", () => {
    expect([
      ...decodeLivePcm(encodeLivePcm(new Float32Array([1, -1, 1, -1, 1, -1]), 48000)),
    ]).toEqual([10922 / 32768, -10923 / 32768]);
    expect(encodeLivePcm(new Float32Array(4800), 48000)).toHaveLength(3200);
  });
  it("honors output rate rather than assuming the microphone rate", () => {
    expect(livePcmRate("audio/pcm;rate=24000")).toBe(24000);
    expect(livePcmRate("audio/pcm; rate=48000")).toBe(48000);
    expect(() => livePcmRate("audio/pcm")).toThrow();
    expect(() => livePcmRate("audio/mpeg;rate=24000")).toThrow();
    expect(() => decodeLivePcm(new Uint8Array(1))).toThrow();
    expect(() => encodeLivePcm(new Float32Array(1), 0)).toThrow();
  });
});
