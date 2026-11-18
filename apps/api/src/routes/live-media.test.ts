import type { Actor } from "@rakazo/contracts";
import * as db from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import * as configured from "../configured-live-call.js";
import * as models from "../live-model-settings.js";
import * as targets from "../thread-target.js";
import type { RouterContext } from "./context.js";
import { liveMediaRoutes } from "./live-media.js";

const actor = { userId: "u", spaceId: "s" } as Actor;
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const procedures = Object.fromEntries(
    ["clear", "settings", "select", "connect", "events", "input", "end"].map((name) => [
      name,
      { handler: (fn: unknown) => fn },
    ]),
  );
  let saved: { credentialId: string; modelId: string } | null = null;
  const upsert = vi.fn(async ({ create }) => {
    saved = create;
  });
  const deps = {
    env: { voiceLiveCalls: true },
    events: { notify: vi.fn(async () => undefined) },
    prisma: {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
      userModelRoleChoice: { findUnique: vi.fn(async () => saved), upsert },
      userModelCredential: { findFirst: vi.fn(async () => ({ id: "cred", provider: "fake" })) },
    },
  };
  const ctx = { deps, authed: { liveMedia: procedures } } as unknown as RouterContext;
  const send = vi.fn(async () => ({ runId: "ordinary-run" }));
  const routes = liveMediaRoutes(ctx, send).liveMedia;
  const invoke = (name: keyof typeof routes, input?: unknown, who = actor): Promise<any> =>
    (routes[name] as unknown as (args: unknown) => Promise<unknown>)({
      context: { actor: who },
      input,
    });
  const target = vi
    .spyOn(targets, "resolveThreadTarget")
    .mockResolvedValue({ kind: "bot", botId: "b", threadId: "t" } as never);
  const list = vi.spyOn(models, "listLiveModels").mockResolvedValue([
    {
      id: "live",
      name: "Live",
      capabilities: { audioInput: true, audioOutput: true, imageInput: true, toolCalls: true },
    },
  ]);
  const audio = vi.fn();
  const opened = vi
    .spyOn(configured, "openConfiguredLiveCall")
    .mockImplementation(async (_deps, owner, selection, _policy) => ({
      scope: {
        ...owner,
        botId: selection.botId,
        threadId: selection.threadId,
        callId: selection.callId,
      },
      link: { audio, text: vi.fn(), frame: vi.fn(), close: vi.fn() },
    }));
  return { invoke, deps, send, target, list, opened, audio, upsert, routes };
}
it("persists and reloads live-only selection, then opens only server-owned settings and tools", async () => {
  const f = fixture();
  expect(await f.invoke("settings")).toBeNull();
  await f.invoke("select", { credentialId: "cred", model: "live" });
  expect(f.list).toHaveBeenCalledWith(f.deps, actor, "cred");
  expect(f.upsert.mock.calls[0][0].create).toMatchObject({
    role: "live-media",
    userId: "u",
    credentialId: "cred",
    modelId: "live",
  });
  expect(await f.invoke("settings")).toEqual({ credentialId: "cred", model: "live" });
  const { sessionId } = await f.invoke("connect", { botId: "b", callId: "c" });
  const policy = f.opened.mock.calls[0][3];
  expect(f.opened.mock.calls[0][2]).toMatchObject({
    credentialId: "cred",
    model: "live",
    threadId: "t",
  });
  const scope = { ...actor, botId: "b", threadId: "t", callId: "c" };
  expect(
    await policy.tools!.execute(
      { type: "tool-call", id: "tool1", name: "delegate_request", args: { request: "Do work" } },
      scope,
      new AbortController().signal,
    ),
  ).toMatchObject({ queued: true });
  expect(f.send).toHaveBeenCalledWith(
    actor,
    expect.objectContaining({
      botId: "b",
      text: "Do work",
      clientNonce: expect.stringContaining("call:c:delegate-"),
    }),
  );
  await f.invoke("input", { botId: "b", sessionId, input: { type: "audio", data: "AA==" } });
  expect(f.audio).toHaveBeenCalledOnce();
  await expect(
    f.invoke(
      "input",
      { botId: "b", sessionId, input: { type: "text", text: "x" } },
      { ...actor, userId: "other" },
    ),
  ).rejects.toThrow();
  await f.invoke("end", { botId: "b", sessionId });
});
it("rejects unavailable selections, unauthorized bots and disabled calls before opening", async () => {
  const f = fixture();
  await expect(f.invoke("select", { credentialId: "cred", model: "missing" })).rejects.toThrow();
  expect(f.upsert).not.toHaveBeenCalled();
  f.target.mockRejectedValueOnce(new Error("not authorized"));
  await expect(f.invoke("connect", { botId: "b", callId: "c" })).rejects.toThrow();
  expect(f.opened).not.toHaveBeenCalled();
  f.deps.env.voiceLiveCalls = false;
  await expect(f.invoke("connect", { botId: "b", callId: "c" })).rejects.toThrow();
  expect(f.opened).not.toHaveBeenCalled();
});

it("persists coalesced call transcripts transactionally and publishes thread events", async () => {
  const f = fixture();
  const message = vi
    .spyOn(db, "createThreadMessageInTransaction")
    .mockResolvedValue({ id: "message" } as never);
  const event = vi.spyOn(db, "appendEventInTransaction").mockResolvedValue({ seq: 42 } as never);
  await f.invoke("select", { credentialId: "cred", model: "live" });
  const { sessionId } = await f.invoke("connect", { botId: "b", callId: "c" });
  const emit = f.opened.mock.calls[0][3].onEvent;
  emit({ type: "transcript", role: "user", text: "Hello " });
  emit({ type: "transcript", role: "user", text: "bot" });
  await f.invoke("end", { botId: "b", sessionId });
  expect(message).toHaveBeenCalledExactlyOnceWith(
    {},
    expect.objectContaining({
      threadId: "t",
      role: "user",
      authorUserId: "u",
      blocks: [{ kind: "text", text: "Hello bot" }],
      clientNonce: expect.stringContaining("call:c:live-"),
    }),
  );
  expect(event).toHaveBeenCalledWith(
    {},
    expect.objectContaining({
      spaceId: "s",
      threadId: "t",
      botId: "b",
      type: "thread.message.created",
    }),
  );
  expect(f.deps.events.notify).toHaveBeenCalledWith("t", 42);
});
