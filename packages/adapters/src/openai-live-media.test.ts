import { EventEmitter } from "node:events";
import type { LiveMediaEvent, LiveMediaOptions } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import {
  attachOpenAILiveMedia,
  OpenAILiveMediaProvider,
  openOpenAILiveMedia,
} from "./openai-live-media.js";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  send(text: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(text));
    callback?.();
  }
  terminate() {
    this.readyState = 3;
    this.emit("close", 1000);
  }
  receive(event: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
}
function fixture(extra: Partial<LiveMediaOptions> = {}) {
  const socket = new Socket();
  const events: LiveMediaEvent[] = [];
  const promise = attachOpenAILiveMedia(socket as unknown as WebSocket, {
    model: "gpt-realtime",
    instructions: "Be brief",
    tools: [{ name: "delegate", description: "Request work", parameters: { type: "object" } }],
    onEvent: (e) => events.push(e),
    ...extra,
  });
  socket.emit("open");
  return { socket, events, promise };
}
function pcm(samples: number[]) {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((n, i) => {
    b.writeInt16LE(n, i * 2);
  });
  return b.toString("base64");
}
async function ready(extra: Partial<LiveMediaOptions> = {}) {
  const f = fixture(extra);
  f.socket.receive({ type: "session.updated" });
  return { ...f, session: await f.promise };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("OpenAI GA live media", () => {
  it("waits for acknowledgement and configures PCM24k and functions", async () => {
    const { socket, promise, events } = fixture();
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    socket.receive({ type: "session.created" });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(socket.sent[0].session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24000 });
    expect(socket.sent[0].session.tools[0].type).toBe("function");
    socket.receive({ type: "session.updated" });
    (await promise).close();
    expect(events).toEqual([{ type: "ready" }, { type: "closed", failed: false }]);
    expect(socket.listenerCount("message")).toBe(0);
  });
  it("resamples signed PCM identically across arbitrary chunks", async () => {
    const a = await ready();
    const b = await ready();
    a.session.sendAudio(pcm([-30000, 0, 30000, 0, -30000]));
    for (const n of [-30000, 0, 30000, 0, -30000]) b.session.sendAudio(pcm([n]));
    const audio = (s: Socket) =>
      Buffer.concat(
        s.sent
          .filter((e) => e.type === "input_audio_buffer.append")
          .map((e) => Buffer.from(e.audio, "base64")),
      );
    expect(audio(a.socket)).toEqual(audio(b.socket));
    expect(audio(a.socket).length).toBe(14);
    expect(audio(a.socket).readInt16LE(2)).toBe(-10000);
    a.session.close();
    b.session.close();
  });
  it("sends sampled image and text items and normalizes events", async () => {
    const { socket, session, events } = await ready();
    session.sendFrame("AAAA", "image/png");
    session.sendText("hello");
    expect(socket.sent[1].item.content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,AAAA",
    });
    expect(socket.sent[3]).toEqual({ type: "response.create" });
    socket.receive({ type: "response.output_audio.delta", delta: pcm([0]) });
    socket.receive({ type: "response.output_audio_transcript.delta", delta: "hi" });
    socket.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "hello",
    });
    socket.receive({ type: "input_audio_buffer.speech_started" });
    expect(events).toContainEqual({
      type: "audio",
      data: pcm([0]),
      mimeType: "audio/pcm;rate=24000",
    });
    expect(events).toContainEqual({ type: "transcript", role: "user", text: "hello" });
    expect(events).toContainEqual({ type: "transcript", role: "bot", text: "hi" });
    expect(events).toContainEqual({ type: "interrupted" });
    session.close();
  });
  it("emits function data and correlates authorized results, waiting for all", async () => {
    const { socket, session, events } = await ready();
    socket.receive({
      type: "response.done",
      response: {
        status: "completed",
        output: ["a", "b"].map((call_id) => ({
          type: "function_call",
          call_id,
          name: "delegate",
          arguments: '{"text":"check"}',
        })),
      },
    });
    expect(events).toContainEqual({
      type: "tool-call",
      id: "a",
      name: "delegate",
      args: { text: "check" },
    });
    session.toolResult("a", { status: "pending" });
    expect(socket.sent.at(-1)?.item.type).toBe("function_call_output");
    session.toolResult("b", {});
    expect(socket.sent.at(-1)?.type).toBe("response.create");
    expect(() => session.toolResult("a", {})).toThrow("Unknown");
    session.close();
  });
  it.each(["undeclared", "bad-json", "array", "duplicate"])(
    "fails closed on %s tool data",
    async (kind) => {
      const { socket, events } = await ready();
      const call = {
        type: "function_call",
        call_id: "a",
        name: kind === "undeclared" ? "execute" : "delegate",
        arguments: kind === "bad-json" ? "{" : kind === "array" ? "[]" : "{}",
      };
      socket.receive({
        type: "response.done",
        response: { status: "completed", output: kind === "duplicate" ? [call, call] : [call] },
      });
      expect(events).toContainEqual({ type: "closed", failed: true });
      expect(events.some((e) => e.type === "tool-call")).toBe(false);
    },
  );
  it("does not execute cancelled calls", async () => {
    const { socket, session, events } = await ready();
    socket.receive({
      type: "response.done",
      response: {
        status: "cancelled",
        output: [{ type: "function_call", call_id: "a", name: "delegate", arguments: "{}" }],
      },
    });
    expect(events.some((e) => e.type === "tool-call")).toBe(false);
    session.close();
  });
  it("bounds invalid PCM, image/text payloads and backpressure", async () => {
    const { socket, session } = await ready();
    for (const data of ["bad", "AB==", "AAAA", "A".repeat(800000)])
      expect(() => session.sendAudio(data)).toThrow();
    expect(() => session.sendFrame("A".repeat(3000000), "image/png")).toThrow();
    expect(() => session.sendText(" ")).toThrow();
    expect(() => session.sendText("x".repeat(32001))).toThrow();
    socket.bufferedAmount = 4 * 1024 * 1024;
    expect(() => session.sendAudio(pcm([1]))).toThrow("congested");
    expect(() => session.sendText("hi")).toThrow("congested");
    session.close();
    expect(() => session.sendAudio(pcm([1]))).toThrow("not ready");
  });
  it("times out setup and sanitizes credential-bearing errors", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const rejected = expect(f.promise).rejects.toThrow("Live connection failed");
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expect(f.socket.readyState).toBe(3);
    const g = fixture();
    const failed = expect(g.promise).rejects.toThrow(/^Live connection failed$/);
    g.socket.emit("error", new Error("secret-fake-key"));
    await failed;
  });
  it("aborts during/after setup with one closed event", async () => {
    const c = new AbortController();
    const f = fixture({ signal: c.signal });
    const rejected = expect(f.promise).rejects.toThrow("closed");
    c.abort();
    await rejected;
    const d = new AbortController();
    const g = await ready({ signal: d.signal });
    d.abort();
    g.session.close();
    expect(g.events.filter((e) => e.type === "closed")).toHaveLength(1);
    await expect(
      openOpenAILiveMedia("fake", {
        model: "gpt-realtime",
        instructions: "",
        signal: c.signal,
        onEvent() {},
      }),
    ).rejects.toThrow("aborted");
  });
  it("discovers verified GA models only, excluding preview and unknown variants", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                "gpt-realtime",
                "gpt-realtime-mini-2025-12-15",
                "gpt-4o-realtime-preview",
                "unknown-realtime",
                "gpt-realtime-future",
              ].map((id) => ({ id })),
            }),
          ),
      ),
    );
    const models = await new OpenAILiveMediaProvider().listModels("fake");
    expect(models.map((m) => m.id)).toEqual(["gpt-realtime", "gpt-realtime-mini-2025-12-15"]);
    expect(models[0]).toMatchObject({
      capabilities: { audioInput: true, audioOutput: true, imageInput: true, toolCalls: true },
    });
    await expect(
      openOpenAILiveMedia("fake", {
        model: "gpt-4o-realtime-preview",
        instructions: "",
        onEvent() {},
      }),
    ).rejects.toThrow("Unsupported");
  });
  it("sanitizes discovery network and HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("secret-fake-key");
      }),
    );
    await expect(new OpenAILiveMediaProvider().listModels("fake")).rejects.toThrow(
      /^Live model discovery failed$/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret-fake-key", { status: 401 })),
    );
    await expect(new OpenAILiveMediaProvider().listModels("fake")).rejects.toThrow(
      /^Live model discovery failed$/,
    );
  });

  it("closes on malformed, oversized and provider-error messages without echoing bodies", async () => {
    for (const raw of [
      "{",
      "x".repeat(4 * 1024 * 1024 + 1),
      JSON.stringify({ type: "error", error: { message: "secret-fake-key" } }),
    ]) {
      const f = await ready();
      f.socket.emit("message", Buffer.from(raw));
      expect(f.events.at(-1)).toEqual({ type: "closed", failed: true });
      expect(f.socket.readyState).toBe(3);
      expect(JSON.stringify(f.events)).not.toContain("secret-fake-key");
    }
  });
  it("bounds pending tool calls before emitting any tool events", async () => {
    const f = await ready();
    f.socket.receive({
      type: "response.done",
      response: {
        status: "completed",
        output: Array.from({ length: 65 }, (_, i) => ({
          type: "function_call",
          call_id: String(i),
          name: "delegate",
          arguments: "{}",
        })),
      },
    });
    expect(f.events.at(-1)).toEqual({ type: "closed", failed: true });
    expect(f.events.some((e) => e.type === "tool-call")).toBe(false);
  });
});
