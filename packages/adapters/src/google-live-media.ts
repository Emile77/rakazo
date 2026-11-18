import type {
  LiveMediaModel,
  LiveMediaOptions,
  LiveMediaProvider,
  LiveMediaSession,
} from "@rakazo/adapter-kit";
import WebSocket from "ws";
import { readBodyCapped } from "./web-ssrf.js";

const ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/** Server-owned connection: the reusable key and tool results never cross a client socket. */
export function openGoogleLiveMedia(
  apiKey: string,
  options: LiveMediaOptions,
): Promise<LiveMediaSession> {
  if (options.signal?.aborted) return Promise.reject(new Error("Live connection aborted"));
  if (!/^(?:models\/)?[a-zA-Z0-9._-]+$/.test(options.model)) {
    return Promise.reject(new Error("Invalid live model"));
  }
  const socket = new WebSocket(ENDPOINT, {
    headers: { "x-goog-api-key": apiKey },
    maxPayload: 8 * 1024 * 1024,
  });
  return attachGoogleLiveMedia(socket, options);
}

/** Separate socket attachment enables deterministic offline protocol tests. */
export function attachGoogleLiveMedia(
  socket: WebSocket,
  options: LiveMediaOptions,
): Promise<LiveMediaSession> {
  return new Promise((resolve, reject) => {
    let ready = false;
    let ended = false;
    const pending = new Map<string, string>();
    const declared = new Set(options.tools?.map((tool) => tool.name) ?? []);
    const send = (message: unknown) => {
      if (socket.readyState !== WebSocket.OPEN || ended) throw new Error("Live connection closed");
      // Do not let a slow provider accumulate unbounded screen/audio data in memory.
      if (socket.bufferedAmount > 4 * 1024 * 1024) throw new Error("Live connection congested");
      socket.send(JSON.stringify(message));
    };
    const finish = (failed: boolean) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      pending.clear();
      if (!ready) reject(new Error(failed ? "Live connection failed" : "Live connection closed"));
      options.onEvent({ type: "closed", failed });
    };
    const abort = () => {
      finish(false);
      socket.terminate();
    };
    const timer = setTimeout(() => {
      finish(true);
      socket.terminate();
    }, 20_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const media = (data: string, mimeType: string) => {
      if (!ready || ended) throw new Error("Live connection not ready");
      if (
        !data ||
        data.length % 4 !== 0 ||
        data.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
      ) {
        throw new Error("Invalid live media payload");
      }
      send({
        realtimeInput: { [mimeType.startsWith("audio/") ? "audio" : "video"]: { data, mimeType } },
      });
    };
    const session: LiveMediaSession = {
      sendAudio: (data) => media(data, "audio/pcm;rate=16000"),
      sendFrame: (data, mimeType) => {
        if (mimeType !== "image/jpeg" && mimeType !== "image/png")
          throw new Error("Invalid frame type");
        media(data, mimeType);
      },
      sendText: (text) => {
        if (!ready || ended) throw new Error("Live connection not ready");
        if (!text.trim() || text.length > 32_000) throw new Error("Invalid live text");
        send({
          clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
        });
      },
      toolResult: (id, result) => {
        const name = pending.get(id);
        if (!name) throw new Error("Unknown or cancelled live tool request");
        send({ toolResponse: { functionResponses: [{ id, name, response: result }] } });
        pending.delete(id);
      },
      close: abort,
    };
    socket.once("open", () => {
      if (ended) return;
      send({
        setup: {
          model: options.model.startsWith("models/") ? options.model : `models/${options.model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            ...(options.voice
              ? {
                  speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } },
                  },
                }
              : {}),
          },
          systemInstruction: { parts: [{ text: options.instructions }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          ...(options.tools?.length ? { tools: [{ functionDeclarations: options.tools }] } : {}),
        },
      });
    });
    socket.on("message", (raw) => {
      if (ended) return;
      try {
        const message = JSON.parse(raw.toString());
        if (!message || typeof message !== "object" || Array.isArray(message))
          throw new Error("Invalid live message");
        if (!ready && !message.setupComplete) throw new Error("Live connection not ready");
        if (message.error) throw new Error("Provider rejected session");
        if (message.setupComplete && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(session);
          options.onEvent({ type: "ready" });
        }
        const content = message.serverContent;
        if (content?.interrupted) options.onEvent({ type: "interrupted" });
        for (const [field, role] of [
          ["inputTranscription", "user"],
          ["outputTranscription", "bot"],
        ] as const) {
          if (typeof content?.[field]?.text === "string")
            options.onEvent({ type: "transcript", role, text: content[field].text });
        }
        for (const part of content?.modelTurn?.parts ?? []) {
          const data = part.inlineData;
          if (
            typeof data?.data === "string" &&
            typeof data.mimeType === "string" &&
            data.mimeType.startsWith("audio/")
          ) {
            options.onEvent({ type: "audio", data: data.data, mimeType: data.mimeType });
          }
        }
        if (content?.turnComplete) options.onEvent({ type: "turn-complete" });
        for (const call of message.toolCall?.functionCalls ?? []) {
          if (
            typeof call.id !== "string" ||
            typeof call.name !== "string" ||
            !declared.has(call.name) ||
            pending.has(call.id) ||
            !call.args ||
            typeof call.args !== "object" ||
            Array.isArray(call.args)
          ) {
            throw new Error("Invalid live tool request");
          }
          if (pending.size >= 64) throw new Error("Too many live tool requests");
          pending.set(call.id, call.name);
          options.onEvent({ type: "tool-call", id: call.id, name: call.name, args: call.args });
        }
        if (message.toolCallCancellation) {
          const ids = message.toolCallCancellation.ids;
          if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
            throw new Error("Invalid cancellation");
          for (const id of ids) pending.delete(id);
          options.onEvent({ type: "tool-cancelled", ids });
        }
        if (message.goAway) options.onEvent({ type: "reconnect-needed" });
      } catch {
        finish(true);
        socket.terminate();
      }
    });
    socket.on("error", () => {
      finish(true);
      socket.terminate();
    });
    socket.once("close", (code) => finish(code !== 1000 && code !== 1005));
  });
}

/** Only models explicitly advertising streaming support may be offered for live calls. */
export class GoogleLiveMediaProvider implements LiveMediaProvider {
  open = openGoogleLiveMedia;

  async listModels(apiKey: string, signal?: AbortSignal): Promise<LiveMediaModel[]> {
    const models = new Map<string, LiveMediaModel>();
    const seen = new Set<string>();
    let token = "";
    do {
      if (seen.has(token) || seen.size >= 100) throw new Error("Invalid live model pagination");
      seen.add(token);
      const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
      url.searchParams.set("pageSize", "1000");
      if (token) url.searchParams.set("pageToken", token);
      const timeout = AbortSignal.timeout(20_000);
      const response = await fetch(url, {
        headers: { "x-goog-api-key": apiKey },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      // Do not surface upstream bodies, which can echo credentials or private requests.
      if (!response.ok) throw new Error(`Live model discovery failed (${response.status})`);
      const text = new TextDecoder().decode(
        await readBodyCapped(response, 4 * 1024 * 1024, signal),
      );
      const page = JSON.parse(text);
      if (
        !page ||
        typeof page !== "object" ||
        (page.models !== undefined && !Array.isArray(page.models))
      ) {
        throw new Error("Invalid live model catalog");
      }
      for (const model of page.models ?? []) {
        if (
          !model ||
          typeof model.name !== "string" ||
          !/^models\/[a-zA-Z0-9._-]+$/.test(model.name) ||
          !Array.isArray(model.supportedGenerationMethods) ||
          !model.supportedGenerationMethods.includes("bidiGenerateContent")
        )
          continue;
        const id = model.name.slice("models/".length);
        models.set(id, {
          id,
          capabilities: { audioInput: true, audioOutput: true, imageInput: true, toolCalls: true },
          name: typeof model.displayName === "string" ? model.displayName : id,
        });
      }
      if (page.nextPageToken !== undefined && typeof page.nextPageToken !== "string") {
        throw new Error("Invalid live model pagination");
      }
      token = page.nextPageToken ?? "";
    } while (token);
    return [...models.values()];
  }
}
