import { afterEach, describe, expect, it, vi } from "vitest";
import { startLiveConversation } from "./live-conversation.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  events: vi.fn(),
  input: vi.fn(),
  end: vi.fn(),
}));
vi.mock("./rpc.js", () => ({ rpc: { liveMedia: mocks } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("live conversation lifecycle", () => {
  it.each([false, true, "exhaust"])(
    "releases hardware on abort (reconnect: %s)",
    async (reconnect) => {
      const stop = vi.fn();
      const disconnect = vi.fn();
      const close = vi.fn().mockResolvedValue(undefined);
      const track = { stop, enabled: true };
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: vi
            .fn()
            .mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] }),
        },
      });
      vi.stubGlobal(
        "AudioContext",
        class {
          sampleRate = 48000;
          destination = {};
          close = close;
          resume = vi.fn().mockResolvedValue(undefined);
          createMediaStreamSource = () => ({ connect: vi.fn() });
          createScriptProcessor = () => ({ connect: vi.fn(), disconnect, onaudioprocess: null });
        },
      );
      mocks.connect.mockResolvedValue({ sessionId: "session-test" });
      mocks.events.mockReturnValue(new Promise(() => {}));
      if (reconnect) {
        mocks.connect.mockResolvedValueOnce({ sessionId: "session-old" });
        mocks.events.mockResolvedValueOnce({
          cursor: 1,
          closed: true,
          events: [{ seq: 1, event: { type: "reconnect-needed" } }],
        });
      }
      mocks.end.mockResolvedValue({ ok: true });
      mocks.input.mockResolvedValue({ ok: true });
      if (reconnect === "exhaust") {
        for (let n = 0; n < 2; n++)
          mocks.events.mockResolvedValueOnce({
            cursor: 1,
            closed: true,
            events: [{ seq: 1, event: { type: "reconnect-needed" } }],
          });
      }
      const onLost = vi.fn();
      const controller = new AbortController();
      const audio = await startLiveConversation({
        botId: "bot-test",
        callId: "call-test",
        greet: false,
        signal: controller.signal,
        onEvent: vi.fn(),
        onSpeaking: vi.fn(),
        onLost,
      });
      if (reconnect === "exhaust") {
        await vi.waitFor(() => expect(onLost).toHaveBeenCalledOnce());
        expect(mocks.connect).toHaveBeenCalledTimes(3);
        expect(mocks.input).not.toHaveBeenCalled();
        expect(stop).toHaveBeenCalledOnce();
        controller.abort();
        return;
      }
      if (reconnect) {
        await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(2));
        expect(mocks.end).toHaveBeenCalledWith(
          { botId: "bot-test", sessionId: "session-old" },
          { signal: expect.any(AbortSignal) },
        );
        expect(mocks.end.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.connect.mock.invocationCallOrder[1] ?? 0,
        );
        expect(mocks.input).not.toHaveBeenCalled();
      }
      expect(audio.shareVisual).toBeUndefined();
      audio.setMuted(true);
      expect(track.enabled).toBe(false);
      await audio.sendText?.("Thread reply");
      expect(mocks.input).toHaveBeenCalledWith(
        {
          botId: "bot-test",
          sessionId: "session-test",
          input: { type: "text", text: "Thread reply" },
        },
        { signal: controller.signal },
      );
      controller.abort();
      audio.close();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(mocks.end).toHaveBeenCalledWith({ botId: "bot-test", sessionId: "session-test" });
    },
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flushAudio() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function microphoneHarness() {
  mocks.connect.mockReset().mockResolvedValue({ sessionId: "old" });
  mocks.events.mockReset();
  mocks.input.mockReset();
  mocks.end.mockReset().mockResolvedValue({ ok: true });
  const events = deferred<{
    cursor: number;
    events: { seq: number; event: { type: "reconnect-needed" } }[];
  }>();
  mocks.events.mockReturnValue(new Promise(() => {})).mockReturnValueOnce(events.promise);
  const requests: ReturnType<typeof deferred<{ ok: boolean }>>[] = [];
  mocks.input.mockImplementation(() => {
    const request = deferred<{ ok: boolean }>();
    requests.push(request);
    return request.promise;
  });
  const processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
  };
  const track = { stop: vi.fn(), enabled: true };
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] }),
    },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = 48000;
      destination = {};
      close = close;
      resume = vi.fn().mockResolvedValue(undefined);
      createMediaStreamSource = () => ({ connect: vi.fn() });
      createScriptProcessor = () => processor;
    },
  );
  const controller = new AbortController();
  const onLost = vi.fn();
  const audio = await startLiveConversation({
    botId: "bot-test",
    callId: "call-test",
    greet: false,
    signal: controller.signal,
    onEvent: vi.fn(),
    onSpeaking: vi.fn(),
    onLost,
  });
  const frame = (value: number) => {
    const samples = new Float32Array(4096).fill(value);
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => samples },
    } as unknown as AudioProcessingEvent);
    samples.fill(0); // Browser input buffers may be reused after the callback.
  };
  return { audio, controller, onLost, frame, requests, events, track, processor, close };
}

describe("microphone PCM queue", () => {
  it("captures pending frames and sends owned PCM sequentially in order", async () => {
    const h = await microphoneHarness();
    h.frame(0.1);
    h.frame(0.2);
    h.frame(0.3);
    expect(mocks.input).toHaveBeenCalledTimes(1);
    h.requests[0]!.resolve({ ok: true });
    await flushAudio();
    expect(mocks.input).toHaveBeenCalledTimes(2);
    h.requests[1]!.resolve({ ok: true });
    await flushAudio();
    expect(mocks.input).toHaveBeenCalledTimes(3);
    const values = mocks.input.mock.calls.map(([request]) => {
      const bytes = Uint8Array.from(atob(request.input.data), (c) => c.charCodeAt(0));
      return new DataView(bytes.buffer).getInt16(0, true);
    });
    expect(values[0]).toBeGreaterThan(0);
    expect(values[1]).toBeGreaterThan(values[0]!);
    expect(values[2]).toBeGreaterThan(values[1]!);
    h.audio.close();
  });
  it("fails visibly at two seconds including in-flight audio, then never drains", async () => {
    const h = await microphoneHarness();
    // Each callback produces 1365 mono samples at 16 kHz.
    for (let i = 0; i < 23; i++) h.frame(0.1);
    expect(h.onLost).not.toHaveBeenCalled();
    h.frame(0.2);
    expect(h.onLost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Live microphone audio overflow" }),
    );
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.processor.disconnect).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    h.requests[0]!.resolve({ ok: true });
    await flushAudio();
    h.frame(0.3);
    expect(mocks.input).toHaveBeenCalledTimes(1);
  });
  it.each(["close", "abort", "mute"])("clears queued frames on %s", async (action) => {
    const h = await microphoneHarness();
    h.frame(0.1);
    h.frame(0.2);
    if (action === "close") h.audio.close();
    else if (action === "abort") h.controller.abort();
    else {
      h.audio.setMuted(true);
      h.frame(0.3);
      h.audio.setMuted(false);
    }
    h.requests[0]!.resolve({ ok: true });
    await flushAudio();
    expect(mocks.input).toHaveBeenCalledTimes(1);
    if (action === "mute") {
      h.frame(0.4);
      expect(mocks.input).toHaveBeenCalledTimes(2);
    }
    expect(h.onLost).not.toHaveBeenCalled();
    h.audio.close();
  });
  it("fails without retrying or draining queued audio", async () => {
    const h = await microphoneHarness();
    h.frame(0.1);
    h.frame(0.2);
    const error = new Error("audio send failed");
    h.requests[0]!.reject(error);
    await flushAudio();
    expect(h.onLost).toHaveBeenCalledExactlyOnceWith(error);
    expect(mocks.input).toHaveBeenCalledTimes(1);
    expect(h.track.stop).toHaveBeenCalledOnce();
  });
  it("discards old queued audio on reconnect and ignores a stale send failure", async () => {
    const h = await microphoneHarness();
    h.frame(0.1);
    h.frame(0.2);
    mocks.connect.mockResolvedValueOnce({ sessionId: "new" });
    h.events.resolve({ cursor: 1, events: [{ seq: 1, event: { type: "reconnect-needed" } }] });
    await flushAudio();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    h.frame(0.3);
    expect(mocks.input).toHaveBeenCalledTimes(1);
    h.requests[0]!.reject(new Error("old session failed"));
    await flushAudio();
    expect(h.onLost).not.toHaveBeenCalled();
    expect(mocks.input).toHaveBeenCalledTimes(2);
    expect(mocks.input.mock.calls[1]![0].sessionId).toBe("new");
    h.requests[1]!.resolve({ ok: true });
    await flushAudio();
    expect(mocks.input).toHaveBeenCalledTimes(2);
    h.audio.close();
  });
});
