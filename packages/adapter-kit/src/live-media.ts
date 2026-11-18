/** Provider-neutral streaming boundary. Tool requests are data, never authorization. */
export type LiveMediaEvent =
  | { type: "ready" }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "transcript"; role: "user" | "bot"; text: string }
  | { type: "interrupted" }
  | { type: "turn-complete" }
  | { type: "tool-call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool-cancelled"; ids: string[] }
  | { type: "reconnect-needed" }
  | { type: "closed"; failed: boolean };

export interface LiveMediaOptions {
  model: string;
  voice?: string;
  instructions: string;
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
  signal?: AbortSignal;
  onEvent(event: LiveMediaEvent): void;
}

export interface LiveMediaSession {
  /** Signed 16-bit little-endian mono PCM, 16 kHz, base64 encoded. */
  sendAudio(data: string): void;
  /** A sampled frame from camera OR screen, never captured implicitly. */
  sendFrame(data: string, mimeType: "image/jpeg" | "image/png"): void;
  sendText(text: string): void;
  /** Only the server's authorized tool executor may supply results. */
  toolResult(id: string, result: Record<string, unknown>): void;
  close(): void;
}

/** Independent capabilities: images enable sampled camera/screen, not native video. */
export interface LiveMediaCapabilities {
  audioInput: boolean;
  audioOutput: boolean;
  imageInput: boolean;
  toolCalls: boolean;
}

/** A live model is discoverable independently from ordinary text models. */
export interface LiveMediaModel {
  id: string;
  name: string;
  capabilities?: LiveMediaCapabilities;
}

/** Vendor-neutral boundary used by call configuration and orchestration. */
export interface LiveMediaProvider {
  listModels(apiKey: string, signal?: AbortSignal): Promise<LiveMediaModel[]>;
  open(apiKey: string, options: LiveMediaOptions): Promise<LiveMediaSession>;
}
