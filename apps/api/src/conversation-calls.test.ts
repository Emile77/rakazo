import type { VoiceConversationEvent, VoiceConversationLink } from "@rakazo/adapter-kit";
import type { Actor, ConversationCallEvent } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationCalls } from "./conversation-calls.js";
import type { VoiceDeps } from "./voice.js";

const voice = vi.hoisted(() => ({
  provider: null as unknown,
}));

vi.mock("./voice.js", () => ({
  resolveVoiceTarget: vi.fn(async () => ({
    cred: { provider: "test" },
    apiKey: "test-key",
    voiceId: "cedar",
    linked: false,
  })),
  voiceProviderFor: vi.fn(async () => voice.provider),
  withVoiceConnection: (_provider: string, _linked: boolean, run: () => unknown) => run(),
  voiceContext: (_actor: unknown, signal?: AbortSignal) => ({
    operationId: "voice",
    traceId: "voice",
    spaceId: "space",
    userId: "user",
    signal: signal ?? new AbortController().signal,
  }),
}));

const actor = { userId: "user", spaceId: "space" } as Actor;

function fakeLink() {
  const queue: VoiceConversationEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const said: Array<{ text: string; handoffId?: string }> = [];
  const listening: boolean[] = [];
  const emit = (event: VoiceConversationEvent) => {
    queue.push(event);
    wake?.();
  };
  const link: VoiceConversationLink = {
    events: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const event = queue.shift();
          if (event) {
            yield event;
            if (event.type === "ended") return;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    say: (text, handoffId) => said.push({ text, handoffId }),
    note: () => undefined,
    setListening: (value) => listening.push(value),
    close: async () => {
      closed = true;
      emit({ type: "ended", reason: "closed" });
    },
  };
  return { link, emit, said, listening };
}

function setup(capable = true) {
  const fake = fakeLink();
  const openConversation = vi.fn(async () => ({ sessionId: "s1", answerSdp: "answer" }));
  voice.provider = {
    describe: () => ({ capabilities: { conversation: capable } }),
    openConversation,
    attachConversation: vi.fn(async () => fake.link),
  };
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ name: "Ada", description: "Helps." })) },
    user: { findUnique: vi.fn(async () => ({ timezone: "America/Toronto" })) },
    message: {
      findMany: vi.fn(async () => [
        { role: "bot", blocks: [{ kind: "text", text: "Hello again." }] },
        { role: "user", blocks: [{ kind: "text", text: "Earlier question" }] },
      ]),
    },
  };
  const calls = createConversationCalls({ prisma, secrets: {} } as unknown as VoiceDeps);
  return { calls, fake, openConversation };
}

const input = { botId: "bot", threadId: "thread", callId: "call1", offerSdp: "offer" };

/** Reads `count` events and leaves the feed open for more. */
async function take(events: AsyncGenerator<ConversationCallEvent>, count: number) {
  const out: ConversationCallEvent[] = [];
  while (out.length < count) {
    const next = await events.next();
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

afterEach(() => vi.useRealTimers());

describe("createConversationCalls", () => {
  it("opens with the bot's talker instructions and the thread's history, oldest first", async () => {
    const { calls, openConversation } = setup();
    await expect(calls.connect(actor, input)).resolves.toEqual({ answerSdp: "answer" });
    const [request] = openConversation.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(request.instructions).toContain("You are Ada");
    expect(request.history).toEqual([
      { role: "user", text: "Earlier question" },
      { role: "bot", text: "Hello again." },
    ]);
    expect(request.offerSdp).toBe("offer");
    await calls.end(actor, "call1");
  });

  it("refuses a voice that cannot converse", async () => {
    const { calls } = setup(false);
    await expect(calls.connect(actor, input)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("turns a handoff into the caller's request once the voice acknowledges it", async () => {
    const { calls, fake } = setup();
    await calls.connect(actor, input);
    const events = calls.events(actor, { botId: "bot", callId: "call1" });
    fake.emit({ type: "transcript", role: "user", delta: "How much disk " });
    fake.emit({ type: "transcript", role: "user", delta: "is left?" });
    fake.emit({ type: "handoff", handoffId: "d1" });
    fake.emit({ type: "transcript", role: "bot", delta: "Checking." });
    expect(await take(events, 4)).toEqual([
      { type: "caption", role: "user", text: "How much disk " },
      { type: "caption", role: "user", text: "is left?" },
      { type: "handoff", handoffId: "d1", text: "How much disk is left?" },
      { type: "caption", role: "bot", text: "Checking." },
    ]);
    await calls.end(actor, "call1");
  });

  it("starts the work itself when the voice promises it without a handoff", async () => {
    vi.useFakeTimers();
    const { calls, fake } = setup();
    await calls.connect(actor, input);
    const events = calls.events(actor, { botId: "bot", callId: "call1" });
    fake.emit({ type: "transcript", role: "user", delta: "Check the backups." });
    fake.emit({ type: "transcript", role: "bot", delta: "OK, let me check." });
    const first = await take(events, 2);
    expect(first).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await take(events, 1)).toEqual([{ type: "handoff", text: "Check the backups." }]);
    await calls.end(actor, "call1");
  });

  it("frames replies for the voice, holds audio on request, and ends on hang-up", async () => {
    const { calls, fake } = setup();
    await calls.connect(actor, input);
    calls.update(actor, {
      botId: "bot",
      callId: "call1",
      say: { text: "1.5 TB free.", handoffId: "d1" },
    });
    calls.update(actor, { botId: "bot", callId: "call1", listening: false });
    expect(fake.said).toEqual([
      {
        text: "The bot finished. Relay its reply in its meaning, adding nothing it does not say:\n1.5 TB free.",
        handoffId: "d1",
      },
    ]);
    expect(fake.listening).toEqual([false]);
    const events = calls.events(actor, { botId: "bot", callId: "call1" });
    await calls.end(actor, "call1");
    expect(await take(events, 1)).toEqual([{ type: "ended" }]);
    expect(() => calls.update(actor, { botId: "bot", callId: "call1", listening: true })).toThrow(
      "This call is no longer live.",
    );
  });

  it("keeps one caller's call from another user", async () => {
    const { calls } = setup();
    await calls.connect(actor, input);
    const other = { userId: "other", spaceId: "space" } as Actor;
    expect(() =>
      calls.update(other, { botId: "bot", callId: "call1", listening: false }),
    ).toThrow();
    await calls.end(actor, "call1");
  });
});
