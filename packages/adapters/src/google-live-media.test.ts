import { EventEmitter, once } from "node:events";
import type { LiveMediaEvent, LiveMediaOptions } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  attachGoogleLiveMedia,
  GoogleLiveMediaProvider,
  openGoogleLiveMedia,
} from "./google-live-media.js";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.emit("close", 1000);
  }
  terminate() {
    this.close();
  }
  receive(message: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}
function fixture() {
  const socket = new Socket();
  const events: LiveMediaEvent[] = [];
  const options: LiveMediaOptions = {
    model: "test-live",
    instructions: "Be brief",
    voice: "test-voice",
    tools: [{ name: "delegate", description: "Request work", parameters: { type: "object" } }],
    onEvent: (event) => events.push(event),
  };
  const promise = attachGoogleLiveMedia(socket as unknown as WebSocket, options);
  socket.emit("open");
  return { socket, events, promise };
}

describe("live media transport", () => {
  it("waits for setup and sends audio, frames, text and correlated results", async () => {
    const { socket, promise } = fixture();
    expect(socket.sent[0]?.setup.model).toBe("models/test-live");
    expect(socket.sent[0]?.setup.outputAudioTranscription).toEqual({});
    socket.receive({ setupComplete: {} });
    const session = await promise;
    session.sendAudio("AAAA");
    session.sendFrame("AAAA", "image/jpeg");
    session.sendText("Hello");
    expect(socket.sent[1]).toEqual({
      realtimeInput: { audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" } },
    });
    expect(socket.sent[2]).toEqual({
      realtimeInput: { video: { data: "AAAA", mimeType: "image/jpeg" } },
    });
    socket.receive({
      toolCall: { functionCalls: [{ id: "one", name: "delegate", args: { text: "check" } }] },
    });
    session.toolResult("one", { status: "awaiting-approval" });
    expect(socket.sent[4]).toEqual({
      toolResponse: {
        functionResponses: [
          { id: "one", name: "delegate", response: { status: "awaiting-approval" } },
        ],
      },
    });
    expect(() => session.toolResult("one", {})).toThrow("Unknown");
    session.close();
  });
  it("normalizes transcripts, audio, interruption and end of turn", async () => {
    const { socket, events, promise } = fixture();
    socket.receive({ setupComplete: {} });
    const session = await promise;
    socket.receive({
      serverContent: {
        inputTranscription: { text: "hello" },
        outputTranscription: { text: "hi" },
        interrupted: true,
        turnComplete: true,
        modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }] },
      },
    });
    expect(events).toContainEqual({ type: "transcript", role: "user", text: "hello" });
    expect(events).toContainEqual({ type: "transcript", role: "bot", text: "hi" });
    expect(events).toContainEqual({ type: "interrupted" });
    expect(events).toContainEqual({
      type: "audio",
      data: "AAAA",
      mimeType: "audio/pcm;rate=24000",
    });
    expect(events).toContainEqual({ type: "turn-complete" });
    session.close();
  });
  it("does not execute tools and rejects late results after cancellation", async () => {
    const { socket, events, promise } = fixture();
    socket.receive({ setupComplete: {} });
    const session = await promise;
    socket.receive({ toolCall: { functionCalls: [{ id: "one", name: "delegate", args: {} }] } });
    expect(events).toContainEqual({ type: "tool-call", id: "one", name: "delegate", args: {} });
    socket.receive({ toolCallCancellation: { ids: ["one"] } });
    expect(() => session.toolResult("one", {})).toThrow("Unknown");
    session.close();
  });
  it("closes on undeclared tool requests without exposing provider errors", async () => {
    const { socket, events, promise } = fixture();
    socket.receive({ setupComplete: {} });
    await promise;
    socket.receive({
      toolCall: { functionCalls: [{ id: "one", name: "arbitrary_shell", args: {} }] },
    });
    expect(events.at(-1)).toEqual({ type: "closed", failed: true });
    expect(events.some((event) => event.type === "tool-call")).toBe(false);
  });
  it("bounds media and backpressure", async () => {
    const { socket, promise } = fixture();
    socket.receive({ setupComplete: {} });
    const session = await promise;
    expect(() => session.sendAudio("not base64!")).toThrow("Invalid");
    expect(() => session.sendFrame("A".repeat(4_000_000), "image/jpeg")).toThrow("Invalid");
    socket.bufferedAmount = 5 * 1024 * 1024;
    expect(() => session.sendAudio("AAAA")).toThrow("congested");
    session.close();
  });
  it("rejects early closure and pre-aborted connections", async () => {
    const { socket, promise } = fixture();
    socket.close();
    await expect(promise).rejects.toThrow("closed");
    await expect(
      openGoogleLiveMedia("fake", {
        model: "test",
        instructions: "",
        signal: AbortSignal.abort(),
        onEvent: () => {},
      }),
    ).rejects.toThrow("aborted");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("live model discovery", () => {
  it("lists only explicitly compatible models across pages without credentials in URLs", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          models: [
            { name: "models/text-only", supportedGenerationMethods: ["generateContent"] },
            {
              name: "models/live-one",
              displayName: "Live one",
              supportedGenerationMethods: ["bidiGenerateContent"],
            },
          ],
          nextPageToken: "opaque page",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          models: [
            { name: "models/live-two", supportedGenerationMethods: ["bidiGenerateContent"] },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    expect(await new GoogleLiveMediaProvider().listModels("fake-key")).toEqual([
      {
        id: "live-one",
        name: "Live one",
        capabilities: { audioInput: true, audioOutput: true, imageInput: true, toolCalls: true },
      },
      {
        id: "live-two",
        name: "live-two",
        capabilities: { audioInput: true, audioOutput: true, imageInput: true, toolCalls: true },
      },
    ]);
    expect(fetcher.mock.calls[1]?.[0].searchParams.get("pageToken")).toBe("opaque page");
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("fake-key");
    expect(fetcher.mock.calls[0]?.[1].headers).toEqual({ "x-goog-api-key": "fake-key" });
  });
  it("does not leak upstream error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private echo", { status: 403 })),
    );
    await expect(new GoogleLiveMediaProvider().listModels("fake-key")).rejects.toThrow(
      "Live model discovery failed (403)",
    );
  });
  it("rejects looping pagination", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => Response.json({ nextPageToken: "repeat" })),
    );
    await expect(new GoogleLiveMediaProvider().listModels("fake-key")).rejects.toThrow(
      "pagination",
    );
  });
  it("returns no compatible models rather than guessing from model names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ models: [{ name: "models/live-sounding-name" }] })),
    );
    expect(await new GoogleLiveMediaProvider().listModels("fake-key")).toEqual([]);
  });
});

describe("live lifecycle", () => {
  it("times out setup and closes exactly once", async () => {
    vi.useFakeTimers();
    const { socket, events, promise } = fixture();
    const rejection = expect(promise).rejects.toThrow("failed");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    expect(socket.readyState).toBe(3);
    expect(events.filter((e) => e.type === "closed")).toHaveLength(1);
  });
  it("rejects premature provider content", async () => {
    const { socket, events, promise } = fixture();
    socket.receive({ serverContent: { outputTranscription: { text: "early" } } });
    await expect(promise).rejects.toThrow("failed");
    expect(events.some((e) => e.type === "transcript")).toBe(false);
  });
  it("rejects truncated base64 and blank or oversized text", async () => {
    const { socket, promise } = fixture();
    socket.receive({ setupComplete: {} });
    const session = await promise;
    expect(() => session.sendAudio("A")).toThrow("Invalid");
    expect(() => session.sendText(" ")).toThrow("Invalid");
    expect(() => session.sendText("a".repeat(32_001))).toThrow("Invalid");
    session.close();
  });
  it("exchanges protocol frames over a real local WebSocket", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const events: LiveMediaEvent[] = [];
    const peerPromise = once(server, "connection");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    try {
      const sessionPromise = attachGoogleLiveMedia(socket, {
        model: "test",
        instructions: "test",
        onEvent: (e) => events.push(e),
      });
      const [peer] = await peerPromise;
      const [setup] = await once(peer, "message");
      expect(JSON.parse(setup.toString()).setup.model).toBe("models/test");
      peer.send(JSON.stringify({ setupComplete: {} }));
      const session = await sessionPromise;
      const audioPromise = once(peer, "message");
      session.sendAudio("AAAA");
      const [audio] = await audioPromise;
      expect(JSON.parse(audio.toString()).realtimeInput.audio.mimeType).toBe(
        "audio/pcm;rate=16000",
      );
      const closed = once(socket, "close");
      session.close();
      await closed;
      expect(events.filter((e) => e.type === "closed")).toHaveLength(1);
    } finally {
      socket.terminate();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
