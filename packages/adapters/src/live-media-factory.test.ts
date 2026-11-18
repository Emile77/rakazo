import { describe, expect, it } from "vitest";
import { createLiveMediaProvider } from "./live-media-factory.js";

describe("optional live media providers", () => {
  it("resolves the selected connection's live transport without a session or network request", async () => {
    const provider = await createLiveMediaProvider("google");
    expect(provider).not.toBeNull();
    expect(typeof provider?.listModels).toBe("function");
    expect(typeof provider?.open).toBe("function");
  });
  it("does not silently substitute another provider", async () => {
    expect(await createLiveMediaProvider("unsupported")).toBeNull();
    expect(await createLiveMediaProvider("openai")).not.toBeNull();
    expect(await createLiveMediaProvider("xai")).not.toBeNull();
  });
});
