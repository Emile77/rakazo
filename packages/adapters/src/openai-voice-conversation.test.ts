import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { OpenAIVoiceProvider } from "./openai-voice.js";
import {
  attachConversationSocket,
  conversationEventFromWire,
  conversationVoice,
} from "./openai-voice-conversation.js";

const context = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};

afterEach(() => vi.unstubAllGlobals());

describe("openConversation", () => {
  it("starts a client-delegated session with the history and the caller's offer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ session: { id: "live_1" }, transport: { sdp: "answer" } }, { status: 201 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const session = await new OpenAIVoiceProvider().openConversation(
      {
        apiKey: "test-key",
        voiceId: "cedar",
        instructions: "Be brief.",
        history: [
          { role: "user", text: "Hi" },
          { role: "bot", text: "Hello" },
        ],
        offerSdp: "offer",
      },
      context,
    );

    expect(session).toEqual({ sessionId: "live_1", answerSdp: "answer" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect(init.headers.authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body)).toEqual({
      session: {
        model: "gpt-live-1",
        instructions: "Be brief.",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
        ],
        audio: { output: { voice: "cedar" } },
        delegation: { type: "client", acknowledgement_delay_ms: 400 },
      },
      transport: { type: "webrtc", sdp: "offer" },
    });
  });

  it("refuses a rejected key as an account error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: { message: "bad key" } }, { status: 401 })),
    );
    await expect(
      new OpenAIVoiceProvider().openConversation(
        { apiKey: "k", voiceId: "marin", instructions: "", history: [], offerSdp: "o" },
        context,
      ),
    ).rejects.toThrow();
  });
});

describe("conversationVoice", () => {
  it("keeps a voice that speaks live and falls back for one that cannot", () => {
    expect(conversationVoice("cedar")).toBe("cedar");
    expect(conversationVoice("sillage")).toBe("sillage");
    expect(conversationVoice("nova")).toBe("marin");
  });
});

describe("conversationEventFromWire", () => {
  it.each([
    [{ type: "session.started" }, { type: "started" }],
    [
      { type: "session.input_transcript.delta", delta: "Hi" },
      { type: "transcript", role: "user", delta: "Hi" },
    ],
    [
      { type: "session.output_transcript.delta", delta: "Hey" },
      { type: "transcript", role: "bot", delta: "Hey" },
    ],
    [
      { type: "session.delegation.created", delegation: { id: "item_1", target: "client" } },
      { type: "handoff", handoffId: "item_1" },
    ],
    [
      { type: "session.usage.updated", usage: { seconds: 12 } },
      { type: "usage", seconds: 12 },
    ],
    [
      { type: "session.closed", reason: "close_requested" },
      { type: "ended", reason: "closed" },
    ],
    [{ type: "session.output_audio.delta" }, null],
    [{ type: "session.input_transcript.delta", delta: "" }, null],
  ])("translates %o", (wire, event) => {
    expect(conversationEventFromWire(wire)).toEqual(event);
  });
});

describe("attachConversationSocket", () => {
  let server: WebSocketServer | undefined;
  afterEach(() => server?.close());

  it("follows events once each, sends updates, and closes gracefully", async () => {
    server = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => server!.once("listening", resolve));
    const received: Array<Record<string, unknown>> = [];
    let authorization: string | undefined;
    server.on("connection", (socket, request) => {
      authorization = request.headers.authorization;
      const delta = { type: "session.input_transcript.delta", event_id: "e1", delta: "Hi" };
      // The side channel replays recent events on attach; the replay must not repeat.
      socket.send(JSON.stringify(delta));
      socket.send(JSON.stringify(delta));
      socket.send(
        JSON.stringify({
          type: "session.delegation.created",
          event_id: "e2",
          delegation: { id: "d1" },
        }),
      );
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(event);
        if (event.type === "session.close") {
          socket.send(JSON.stringify({ type: "session.closed", event_id: "e3" }));
          socket.close();
        }
      });
    });
    const { port } = server.address() as AddressInfo;
    const link = await attachConversationSocket(
      `ws://127.0.0.1:${port}`,
      { apiKey: "test-key", sessionId: "live_1" },
      context,
    );
    const events: unknown[] = [];
    const reading = (async () => {
      for await (const event of link.events) events.push(event);
    })();
    await vi.waitFor(() => expect(events).toHaveLength(2));
    link.say("Disk is fine.", "d1");
    link.note("Quiet context.");
    link.setListening(false);
    await link.close();
    await reading;

    expect(authorization).toBe("Bearer test-key");
    expect(events).toEqual([
      { type: "transcript", role: "user", delta: "Hi" },
      { type: "handoff", handoffId: "d1" },
      { type: "ended", reason: "closed" },
    ]);
    expect(received.map(({ event_id: _id, ...event }) => event)).toEqual([
      { type: "session.commentary.append", content: "Disk is fine.", delegation_id: "d1" },
      { type: "session.thinking.append", content: "Quiet context.", delegation_id: null },
      { type: "session.input_audio.mute" },
      { type: "session.close" },
    ]);
  });
});
