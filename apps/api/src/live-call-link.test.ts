import type { LiveMediaEvent, LiveMediaOptions, LiveMediaSession } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveCallScope } from "./live-call-link.js";
import { openLiveCallLink } from "./live-call-link.js";

const scope = { userId: "u", spaceId: "s", botId: "b", threadId: "t", callId: "c" };
async function fixture() {
  let emit: (event: LiveMediaEvent) => void = () => {};
  let signal: AbortSignal | undefined;
  const session: LiveMediaSession = {
    sendAudio: vi.fn(),
    sendFrame: vi.fn(),
    sendText: vi.fn(),
    toolResult: vi.fn(),
    close: vi.fn(),
  };
  const execute = vi.fn(
    async (
      _call: Extract<LiveMediaEvent, { type: "tool-call" }>,
      _scope: LiveCallScope,
      _signal: AbortSignal,
    ) => ({ ok: true }),
  );
  const onEvent = vi.fn();
  const controller = new AbortController();
  const link = await openLiveCallLink({
    scope,
    capabilities: { audioInput: true, imageInput: true },
    options: { model: "live", instructions: "test" },
    signal: controller.signal,
    tools: { declarations: [{ name: "work", description: "test", parameters: {} }], execute },
    open: async (options: LiveMediaOptions) => {
      emit = options.onEvent;
      signal = options.signal;
      return session;
    },
    onEvent,
  });
  return {
    link,
    emit: (event: LiveMediaEvent) => emit(event),
    session,
    execute,
    onEvent,
    signal,
    controller,
  };
}
afterEach(() => vi.useRealTimers());
describe("server-owned live call link", () => {
  it("checks every scope dimension before accepting media or closing", async () => {
    const f = await fixture();
    for (const field of Object.keys(scope)) {
      const wrong = { ...scope, [field]: "other" };
      expect(() => f.link.audio(wrong, "AAAA")).toThrow();
      expect(() => f.link.frame(wrong, "AAAA", "image/jpeg")).toThrow();
      expect(() => f.link.text(wrong, "hello")).toThrow();
      expect(() => f.link.close(wrong)).toThrow();
    }
    expect(f.session.sendAudio).not.toHaveBeenCalled();
    f.link.audio(scope, "AAAA");
    f.link.frame(scope, "AAAA", "image/png");
    f.link.text(scope, "hello");
    expect(f.session.sendAudio).toHaveBeenCalledWith("AAAA");
    expect(f.session.sendFrame).toHaveBeenCalledWith("AAAA", "image/png");
    expect(f.session.sendText).toHaveBeenCalledWith("hello");
    f.link.close(scope);
  });
  it("keeps tool execution server-side, with immutable scope", async () => {
    const f = await fixture();
    const call = { type: "tool-call" as const, id: "1", name: "work", args: {} };
    f.emit(call);
    await vi.waitFor(() => expect(f.session.toolResult).toHaveBeenCalledWith("1", { ok: true }));
    expect(f.execute).toHaveBeenCalledWith(call, scope, expect.any(AbortSignal));
    expect(Object.isFrozen(f.execute.mock.calls[0]?.[1])).toBe(true);
    expect(f.onEvent).not.toHaveBeenCalled();
    f.link.close(scope);
  });
  it("rejects undeclared tools and replayed IDs", async () => {
    const f = await fixture();
    const event = { type: "tool-call" as const, id: "1", name: "work", args: {} };
    f.emit(event);
    await Promise.resolve();
    f.emit(event);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.session.close).toHaveBeenCalledTimes(1);
    const g = await fixture();
    g.emit({ ...event, name: "undeclared" });
    expect(g.execute).not.toHaveBeenCalled();
    expect(g.session.close).toHaveBeenCalledOnce();
  });
  it("suppresses cancelled results and aborts work on disconnect", async () => {
    const f = await fixture();
    let resolve: (value: { ok: boolean }) => void = () => {};
    f.execute.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.emit({ type: "tool-call", id: "1", name: "work", args: {} });
    f.emit({ type: "tool-cancelled", ids: ["1"] });
    resolve({ ok: true });
    await Promise.resolve();
    expect(f.session.toolResult).not.toHaveBeenCalled();
    f.controller.abort();
    expect(f.signal?.aborted).toBe(true);
    expect(f.session.close).toHaveBeenCalledOnce();
    expect(() => f.link.audio(scope, "AAAA")).toThrow();
  });
  it("limits parallel tools", async () => {
    const f = await fixture();
    f.execute.mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < 5; i++)
      f.emit({ type: "tool-call", id: String(i), name: "work", args: {} });
    expect(f.execute).toHaveBeenCalledTimes(4);
    expect(f.session.close).toHaveBeenCalledOnce();
  });
  it("closes on provider disconnect and ignores late events", async () => {
    const f = await fixture();
    f.emit({ type: "closed", failed: true });
    f.emit({ type: "audio", data: "AAAA", mimeType: "audio/pcm" });
    expect(f.onEvent).toHaveBeenCalledTimes(1);
    expect(f.session.close).toHaveBeenCalledOnce();
  });
  it("expires abandoned sessions", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(f.signal?.aborted).toBe(true);
    expect(f.session.close).toHaveBeenCalledOnce();
  });
  it("sanitizes provider open errors and refuses pre-aborted opens", async () => {
    const open = vi.fn(async (): Promise<LiveMediaSession> => {
      throw new Error("private details");
    });
    const input = { scope, options: { model: "live", instructions: "" }, open, onEvent: vi.fn() };
    await expect(openLiveCallLink(input)).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "Could not open live call.",
    });
    await expect(openLiveCallLink({ ...input, signal: AbortSignal.abort() })).rejects.toMatchObject(
      { code: "BAD_GATEWAY" },
    );
    expect(open).toHaveBeenCalledTimes(1);
  });
});
