import type { LiveMediaEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createLiveMediaProvider } from "./live-media-factory.js";

// Exercise the public factory and open boundary, not just adapter attachment helpers.
// Both external boundaries are replaced: no credentials or network are required.
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class MockSocket extends EventEmitter {
      static OPEN = 1;
      static instances: unknown[] = [];
      readyState = 1;
      bufferedAmount = 0;
      sent: unknown[] = [];
      constructor(
        public url: string,
        public options: unknown,
      ) {
        super();
        MockSocket.instances.push(this);
      }
      send(text: string, callback?: (error?: Error) => void) {
        this.sent.push(JSON.parse(text));
        callback?.();
      }
      terminate() {
        this.readyState = 3;
        this.emit("close", 1000);
      }
    },
  };
});

type Socket = {
  readyState: number;
  sent: unknown[];
  emit(name: string, ...args: unknown[]): boolean;
};
const sockets = (WebSocket as unknown as { instances: Socket[] }).instances;
const pcm = Buffer.alloc(32).toString("base64");
const key = "offline-placeholder-key";
const cases = [
  { provider: "google", model: "gemini-live-fixture", images: true },
  { provider: "openai", model: "gpt-realtime", images: true },
  { provider: "xai", model: "grok-voice-latest", images: false },
];
function receive(socket: Socket, message: unknown) {
  socket.emit("message", Buffer.from(JSON.stringify(message)));
}
function requestTool(socket: Socket, provider: string, name = "lookup") {
  const call = {
    type: "function_call",
    call_id: "call-1",
    name,
    arguments: JSON.stringify({ query: "hello" }),
  };
  if (provider === "google") {
    receive(socket, {
      toolCall: { functionCalls: [{ id: "call-1", name, args: { query: "hello" } }] },
    });
  } else {
    // This protocol stages completed arguments separately from turn completion.
    if (provider === "xai")
      receive(socket, { ...call, type: "response.function_call_arguments.done" });
    receive(socket, { type: "response.done", response: { status: "completed", output: [call] } });
  }
}
afterEach(() => {
  for (const socket of sockets) if (socket.readyState !== 3) socket.emit("close", 1000);
  sockets.length = 0;
  vi.unstubAllGlobals();
});

describe.each(cases)(
  "$provider shared live-media conformance",
  ({ provider: id, model, images }) => {
    async function fixture() {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                { name: `models/${model}`, supportedGenerationMethods: ["bidiGenerateContent"] },
              ],
              data: [{ id: model }],
              voices: [],
            }),
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const provider = await createLiveMediaProvider(id);
      expect(provider).not.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sockets).toHaveLength(0);
      if (!provider) throw new Error("Missing provider");
      const models = await provider.listModels(key);
      const advertised = models.find((candidate) => candidate.id === model);
      expect(advertised?.capabilities).toEqual({
        audioInput: true,
        audioOutput: true,
        imageInput: images,
        toolCalls: true,
      });
      const events: LiveMediaEvent[] = [];
      const controller = new AbortController();
      const opening = provider.open(key, {
        model,
        instructions: "Keep it brief",
        signal: controller.signal,
        tools: [{ name: "lookup", description: "Look up data", parameters: { type: "object" } }],
        onEvent: (event) => events.push(event),
      });
      const socket = sockets[0];
      expect(socket).toBeDefined();
      if (!socket) throw new Error("Provider did not create a WebSocket");
      socket.emit("open");
      let settled = false;
      void opening.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(events).toEqual([]);
      receive(socket, id === "google" ? { setupComplete: {} } : { type: "session.updated" });
      const session = await opening;
      expect(events).toEqual([{ type: "ready" }]);
      return { provider, session, socket, events, controller };
    }

    it("honors discovered media capabilities through the factory", async () => {
      const { session, socket, events } = await fixture();
      const before = socket.sent.length;
      session.sendAudio(pcm);
      session.sendText("hello");
      expect(socket.sent.length).toBeGreaterThan(before);
      if (images) {
        const count = socket.sent.length;
        session.sendFrame("AAAA", "image/jpeg");
        expect(socket.sent.length).toBeGreaterThan(count);
      } else {
        const count = socket.sent.length;
        expect(() => session.sendFrame("AAAA", "image/jpeg")).toThrow();
        expect(socket.sent).toHaveLength(count);
      }
      receive(
        socket,
        id === "google"
          ? {
              serverContent: {
                modelTurn: {
                  parts: [{ inlineData: { data: pcm, mimeType: "audio/pcm;rate=24000" } }],
                },
              },
            }
          : {
              type: id === "openai" ? "response.output_audio.delta" : "response.audio.delta",
              delta: pcm,
            },
      );
      expect(events).toContainEqual(expect.objectContaining({ type: "audio", data: pcm }));
      expect(JSON.stringify(events)).not.toContain(key);
      session.close();
      session.close();
      expect(events.filter((event) => event.type === "closed")).toEqual([
        { type: "closed", failed: false },
      ]);
      expect(() => session.sendText("after close")).toThrow();
    });

    it("correlates declared tools and rejects unknown or replayed results", async () => {
      const { session, socket, events } = await fixture();
      expect(() => session.toolResult("unknown", {})).toThrow();
      requestTool(socket, id);
      expect(events).toContainEqual({
        type: "tool-call",
        id: "call-1",
        name: "lookup",
        args: { query: "hello" },
      });
      const before = socket.sent.length;
      session.toolResult("call-1", { found: true });
      expect(socket.sent.length).toBeGreaterThan(before);
      expect(JSON.stringify(socket.sent.slice(before))).toContain("call-1");
      expect(() => session.toolResult("call-1", {})).toThrow();
      session.close();
    });

    it("fails closed on an undeclared tool without emitting an executable request", async () => {
      const { socket, events } = await fixture();
      requestTool(socket, id, "not-declared");
      expect(events.some((event) => event.type === "tool-call")).toBe(false);
      expect(events.at(-1)).toEqual({ type: "closed", failed: true });
      expect(socket.readyState).toBe(3);
    });

    it("aborts a ready session once and rejects pre-aborted opens before socket creation", async () => {
      const { provider, controller, events, session } = await fixture();
      controller.abort();
      session.close();
      expect(events.filter((event) => event.type === "closed")).toEqual([
        { type: "closed", failed: false },
      ]);
      const count = sockets.length;
      await expect(
        provider.open(key, { model, instructions: "", signal: controller.signal, onEvent() {} }),
      ).rejects.toThrow(/aborted/);
      expect(sockets).toHaveLength(count);
    });
  },
);

it("does not substitute a live provider for an unknown factory selection", async () => {
  const fetchMock = vi.fn(() => {
    throw new Error("Unexpected network");
  });
  vi.stubGlobal("fetch", fetchMock);
  for (const id of ["", "unsupported", "OpenAI", "__proto__"]) {
    expect(await createLiveMediaProvider(id)).toBeNull();
  }
  expect(fetchMock).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(0);
});
