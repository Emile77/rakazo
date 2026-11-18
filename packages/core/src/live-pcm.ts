/** Convert mono microphone samples to PCM16LE at the transport's 16 kHz rate. */
export function encodeLivePcm(samples: Float32Array, rate: number): Uint8Array {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Invalid sample rate");
  const count = Math.floor((samples.length * 16000) / rate);
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * rate) / 16000);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor(((i + 1) * rate) / 16000)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j] ?? 0;
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
export function livePcmRate(mime: string): number {
  if (!/^audio\/(pcm|l16)(?:;|$)/i.test(mime)) throw new Error("Unsupported live audio format");
  const rate = Number(/(?:^|;)\s*rate=(\d+)/i.exec(mime)?.[1]);
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000)
    throw new Error("Missing live audio rate");
  return rate;
}
export function decodeLivePcm(bytes: Uint8Array): Float32Array {
  if (bytes.length % 2) throw new Error("Incomplete PCM sample");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from(
    { length: bytes.length / 2 },
    (_, i) => view.getInt16(i * 2, true) / 32768,
  );
}
