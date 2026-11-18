import type { LiveMediaOptions, LiveMediaSession } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openConfiguredLiveCall } from "./configured-live-call.js";
import * as settings from "./live-model-settings.js";
import * as teaching from "./taught-skills.js";
import * as targets from "./thread-target.js";

function fixture() {
  const session: LiveMediaSession = {
    sendAudio: vi.fn(),
    sendFrame: vi.fn(),
    sendText: vi.fn(),
    close: vi.fn(),
    toolResult: vi.fn(),
  };
  const provider = {
    listModels: vi.fn(async () => [
      {
        id: "live",
        name: "Live",
        capabilities: { audioInput: true, audioOutput: true, imageInput: true, toolCalls: true },
      },
    ]),
    open: vi.fn(async (_key: string, _options: LiveMediaOptions) => session),
  };
  const target = vi.spyOn(targets, "resolveThreadTarget").mockResolvedValue({
    kind: "bot",
    botId: "b",
    threadId: "t",
    bot: {},
  } as never);
  const gate = vi.spyOn(teaching, "assertTeachingSendAllowed").mockResolvedValue();
  const connection = vi
    .spyOn(settings, "loadLiveMediaConnection")
    .mockResolvedValue({ provider, apiKey: "fake-key" });
  const deps = {} as Parameters<typeof openConfiguredLiveCall>[0];
  const actor = { userId: "u", spaceId: "s" } as Actor;
  const selection = {
    botId: "b",
    threadId: "t",
    callId: "c",
    credentialId: "cred",
    model: "live",
    voice: "voice",
  };
  const controller = new AbortController();
  const policy = {
    enabled: true,
    instructions: "server instructions",
    onEvent: vi.fn(),
    signal: controller.signal,
  };
  return {
    session,
    provider,
    target,
    gate,
    connection,
    deps,
    actor,
    selection,
    policy,
    controller,
    run: () => openConfiguredLiveCall(deps, actor, selection, policy),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("configured media call composition", () => {
  it("allows an audio-only model but denies frames server-side", async () => {
    const f = fixture();
    f.provider.listModels.mockResolvedValueOnce([
      {
        id: "live",
        name: "Audio",
        capabilities: { audioInput: true, audioOutput: true, imageInput: false, toolCalls: true },
      },
    ]);
    const call = await f.run();
    try {
      call.link.audio(call.scope, "sample");
      expect(() => call.link.frame(call.scope, "frame", "image/jpeg")).toThrow();
      expect(f.session.sendFrame).not.toHaveBeenCalled();
    } finally {
      call.link.close(call.scope);
    }
  });
  it("does not treat unknown capabilities as support", async () => {
    const f = fixture();
    f.provider.listModels.mockResolvedValueOnce([{ id: "live", name: "Unknown" }] as never);
    await expect(f.run()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.provider.open).not.toHaveBeenCalled();
  });
  it("accepts frames for a model advertising image support", async () => {
    const f = fixture();
    const call = await f.run();
    try {
      call.link.frame(call.scope, "frame", "image/png");
      expect(f.session.sendFrame).toHaveBeenCalledWith("frame", "image/png");
    } finally {
      call.link.close(call.scope);
    }
  });
  it("authorizes the bot/thread before loading an owned API connection", async () => {
    const f = fixture();
    const call = await f.run();
    try {
      expect(f.target).toHaveBeenCalledWith(f.deps.prisma, f.actor, { botId: "b" });
      expect(f.gate).toHaveBeenCalledWith(f.deps.prisma, "s", "b");
      expect(f.connection).toHaveBeenCalledWith(f.deps, f.actor, "cred");
      expect(f.provider.listModels).toHaveBeenCalledWith("fake-key", f.policy.signal);
      expect(f.provider.open).toHaveBeenCalledWith(
        "fake-key",
        expect.objectContaining({
          model: "live",
          voice: "voice",
          instructions: "server instructions",
        }),
      );
      expect(Object.keys(call)).toEqual(["scope", "link"]);
      call.link.audio(call.scope, "sample");
      expect(f.session.sendAudio).toHaveBeenCalledWith("sample");
    } finally {
      call.link.close(call.scope);
    }
  });
  it("does not load credentials when calls are disabled", async () => {
    const f = fixture();
    f.policy.enabled = false;
    await expect(f.run()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(f.connection).not.toHaveBeenCalled();
  });
  it("does not read credentials for an inaccessible bot", async () => {
    const f = fixture();
    f.target.mockRejectedValueOnce(new Error("denied"));
    await expect(f.run()).rejects.toThrow("denied");
    expect(f.connection).not.toHaveBeenCalled();
  });
  it("rejects a mismatched thread", async () => {
    const f = fixture();
    f.selection.threadId = "other";
    await expect(f.run()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.connection).not.toHaveBeenCalled();
  });
  it("rejects group targets", async () => {
    const f = fixture();
    f.target.mockResolvedValueOnce({ kind: "group" } as never);
    await expect(f.run()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.connection).not.toHaveBeenCalled();
  });
  it("honors the ordinary teaching gate", async () => {
    const f = fixture();
    f.gate.mockRejectedValueOnce(new Error("teaching"));
    await expect(f.run()).rejects.toThrow("teaching");
    expect(f.connection).not.toHaveBeenCalled();
  });
  it("rejects unsupported/subscription connections", async () => {
    const f = fixture();
    f.connection.mockResolvedValueOnce(null);
    await expect(f.run()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(f.provider.open).not.toHaveBeenCalled();
  });
  it("rejects a model not advertised by the selected connection", async () => {
    const f = fixture();
    f.selection.model = "not-live";
    await expect(f.run()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.provider.open).not.toHaveBeenCalled();
  });
  it("does not leak discovery failures", async () => {
    const f = fixture();
    f.provider.listModels.mockRejectedValueOnce(new Error("private key details"));
    await expect(f.run()).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "Could not load live call models.",
    });
    expect(f.provider.open).not.toHaveBeenCalled();
  });
  it("aborts the session when its transport disconnects", async () => {
    const f = fixture();
    await f.run();
    f.controller.abort();
    expect(f.session.close).toHaveBeenCalledOnce();
    expect(f.provider.open.mock.calls[0][1].signal?.aborted).toBe(true);
  });
  it("rejects an already disconnected transport before loading credentials", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(f.run()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.target).not.toHaveBeenCalled();
    expect(f.connection).not.toHaveBeenCalled();
  });
  it("does not open a session after disconnecting during discovery", async () => {
    const f = fixture();
    f.provider.listModels.mockImplementationOnce(async () => {
      f.controller.abort();
      return [
        {
          id: "live",
          name: "Live",
          capabilities: { audioInput: true, audioOutput: true, imageInput: true, toolCalls: true },
        },
      ];
    });
    await expect(f.run()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.provider.open).not.toHaveBeenCalled();
  });
  it("rejects malformed call identifiers before authorization", async () => {
    const f = fixture();
    f.selection.callId = "";
    await expect(f.run()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.target).not.toHaveBeenCalled();
  });
});
