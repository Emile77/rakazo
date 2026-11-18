import type { LiveMediaProvider } from "@rakazo/adapter-kit";
import * as adapters from "@rakazo/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listLiveModels } from "./live-model-settings.js";

function fixture() {
  const provider = { listModels: vi.fn(async () => [{ id: "live", name: "Live" }]) };
  vi.spyOn(adapters, "createLiveMediaProvider").mockResolvedValue(
    provider as unknown as LiveMediaProvider,
  );
  const deps = {
    prisma: {
      userModelCredential: { findFirst: vi.fn(async () => ({ provider: "test", secretId: "s" })) },
      secret: { findFirst: vi.fn(async () => ({ id: "s", ciphertext: "encrypted" })) },
    },
    secrets: { load: vi.fn(async () => JSON.stringify({ kind: "api_key", key: "fake-key" })) },
  };
  const run = () =>
    listLiveModels(deps as unknown as Parameters<typeof listLiveModels>[0], { userId: "u" }, "c");
  return { deps, run, provider };
}
afterEach(() => vi.restoreAllMocks());

describe("live call model settings", () => {
  it("uses the chosen user's connection and keeps its key server-side", async () => {
    const { deps, run, provider } = fixture();
    expect(await run()).toEqual([{ id: "live", name: "Live" }]);
    expect(deps.prisma.userModelCredential.findFirst).toHaveBeenCalledWith({
      where: { id: "c", userId: "u" },
    });
    expect(deps.prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "s", userId: "u", spaceId: null },
      select: { id: true, ciphertext: true },
    });
    expect(provider.listModels).toHaveBeenCalledWith("fake-key", undefined);
  });
  it("does not read secrets for someone else's missing connection", async () => {
    const { deps, run } = fixture();
    deps.prisma.userModelCredential.findFirst.mockResolvedValueOnce(null as never);
    await expect(run()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deps.secrets.load).not.toHaveBeenCalled();
  });
  it("does not enable unsupported providers", async () => {
    const { deps, run } = fixture();
    vi.mocked(adapters.createLiveMediaProvider).mockResolvedValueOnce(null);
    expect(await run()).toEqual([]);
    expect(deps.secrets.load).not.toHaveBeenCalled();
  });
  it("does not mistake subscription credentials for API access", async () => {
    const { deps, run, provider } = fixture();
    deps.secrets.load.mockResolvedValueOnce(
      JSON.stringify({ kind: "oauth", reconnectRequired: true }),
    );
    expect(await run()).toEqual([]);
    expect(provider.listModels).not.toHaveBeenCalled();
  });
  it("sanitizes upstream failures", async () => {
    const { run, provider } = fixture();
    provider.listModels.mockRejectedValueOnce(new Error("private provider details"));
    await expect(run()).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "Could not load live call models.",
    });
  });
});
