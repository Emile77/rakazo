import type { LiveMediaEvent } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createLiveMediaSessions } from "./live-media-sessions.js";

const actor = { userId: "u", spaceId: "s" } as Actor;
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const sessions = createLiveMediaSessions();
  let emit!: (
    event: Exclude<LiveMediaEvent, { type: "tool-call" } | { type: "tool-cancelled" }>,
  ) => void;
  let signal!: AbortSignal;
  const persist = vi.fn(async () => undefined);
  const audio = vi.fn();
  const open = vi.fn(async (s: AbortSignal, e: typeof emit) => {
    emit = e;
    signal = s;
    return {
      scope: { userId: "u", spaceId: "s", botId: "b", threadId: "t", callId: "c" },
      link: { audio, frame: vi.fn(), text: vi.fn(), close: vi.fn() },
    };
  });
  return {
    sessions,
    open,
    persist,
    audio,
    emit: (event: Parameters<typeof emit>[0]) => emit(event),
    aborted: () => signal.aborted,
  };
}
it("scopes input and replay to user, space and bot; end is idempotent", async () => {
  const f = fixture();
  const { sessionId: id } = await f.sessions.connect(actor, "b", "c", f.open, f.persist);
  f.emit({ type: "ready" });
  for (const candidate of [
    { ...actor, userId: "other" },
    { ...actor, spaceId: "other" },
  ]) {
    expect(() => f.sessions.events(candidate, "b", id, 0)).toThrow();
    expect(() => f.sessions.input(candidate, "b", id, { type: "audio", data: "AA==" })).toThrow();
  }
  expect(() => f.sessions.events(actor, "other", id, 0)).toThrow();
  f.sessions.input(actor, "b", id, { type: "audio", data: "AA==" });
  expect(f.audio).toHaveBeenCalledTimes(1);
  expect(f.sessions.events(actor, "b", id, 0).events[0].event.type).toBe("ready");
  await f.sessions.end(actor, "b", id);
  await f.sessions.end(actor, "b", id);
  expect(f.aborted()).toBe(true);
  expect(() => f.sessions.input(actor, "b", id, { type: "text", text: "x" })).toThrow();
});
it("coalesces transcript deltas and flushes before end resolves", async () => {
  const f = fixture();
  const { sessionId: id } = await f.sessions.connect(actor, "b", "c", f.open, f.persist);
  f.emit({ type: "transcript", role: "bot", text: "Hello " });
  f.emit({ type: "transcript", role: "bot", text: "world" });
  await f.sessions.end(actor, "b", id);
  expect(f.persist).toHaveBeenCalledExactlyOnceWith(
    { type: "transcript", role: "bot", text: "Hello world" },
    1,
  );
});
it("rejects stale replay instead of silently dropping audio; closes on reconnect", async () => {
  const f = fixture();
  const { sessionId: id } = await f.sessions.connect(actor, "b", "c", f.open, f.persist);
  for (let i = 0; i < 600; i++) f.emit({ type: "audio", data: "AA==", mimeType: "audio/pcm" });
  expect(() => f.sessions.events(actor, "b", id, 0)).toThrow();
  expect(f.sessions.events(actor, "b", id, 599).events).toHaveLength(1);
  f.emit({ type: "reconnect-needed" });
  expect(f.aborted()).toBe(true);
  await f.sessions.connect(actor, "b", "c", f.open, f.persist);
});
it("bounds simultaneous opens and expires handles", async () => {
  const f = fixture();
  const first = await f.sessions.connect(actor, "b", "c", f.open, f.persist);
  await expect(f.sessions.connect(actor, "b", "c", f.open, f.persist)).rejects.toThrow();
  await f.sessions.connect(actor, "b", "c2", f.open, f.persist);
  await f.sessions.connect(actor, "b", "c3", f.open, f.persist);
  await expect(f.sessions.connect(actor, "b", "c4", f.open, f.persist)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(() => f.sessions.events(actor, "b", first.sessionId, 0)).toThrow();
});
it("reports persistence failures and closes the upstream", async () => {
  const f = fixture();
  f.persist.mockRejectedValueOnce(new Error("offline"));
  const { sessionId: id } = await f.sessions.connect(actor, "b", "c", f.open, f.persist);
  f.emit({ type: "transcript", role: "user", text: "hello" });
  await expect(f.sessions.end(actor, "b", id)).rejects.toThrow();
  expect(f.aborted()).toBe(true);
});
