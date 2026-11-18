import type { LiveMediaProvider } from "@rakazo/adapter-kit";

/** Optional live transports load only after the selected connection needs one. */
export async function createLiveMediaProvider(provider: string): Promise<LiveMediaProvider | null> {
  switch (provider) {
    case "google": {
      const { GoogleLiveMediaProvider } = await import("./google-live-media.js");
      return new GoogleLiveMediaProvider();
    }
    case "openai": {
      const { OpenAILiveMediaProvider } = await import("./openai-live-media.js");
      return new OpenAILiveMediaProvider();
    }
    case "xai": {
      const { XaiLiveMediaProvider } = await import("./xai-live-media.js");
      return new XaiLiveMediaProvider();
    }
    default:
      return null;
  }
}
