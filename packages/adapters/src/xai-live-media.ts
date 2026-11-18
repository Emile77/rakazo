import type {
  LiveMediaModel,
  LiveMediaOptions,
  LiveMediaProvider,
  LiveMediaSession,
} from "@rakazo/adapter-kit";
import WebSocket from "ws";
import { readBodyCapped } from "./web-ssrf.js";

const MAX = 4 * 1024 * 1024;
// https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech
// Fixed documented speech models; image input is not documented.
const MODELS = new Set(["grok-voice-latest", "grok-voice-3.0"]);

function bytes(data: string, limit: number): Buffer {
  if (
    !data ||
    data.length > Math.ceil(limit / 3) * 4 ||
    data.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new Error("Invalid live media payload");
  const result = Buffer.from(data, "base64");
  if (result.length > limit || result.toString("base64") !== data)
    throw new Error("Invalid live media payload");
  return result;
}

export function openXaiLiveMedia(
  apiKey: string,
  options: LiveMediaOptions,
): Promise<LiveMediaSession> {
  if (options.signal?.aborted) return Promise.reject(new Error("Live connection aborted"));
  if (!MODELS.has(options.model)) return Promise.reject(new Error("Unsupported live model"));
  try {
    return attachXaiLiveMedia(
      new WebSocket(`wss://api.x.ai/v1/realtime?model=${encodeURIComponent(options.model)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        maxPayload: MAX,
      }),
      options,
    );
  } catch {
    return Promise.reject(new Error("Live connection failed"));
  }
}

/** Direct xAI WebSocket protocol; attachment enables offline tests. */
export function attachXaiLiveMedia(
  socket: WebSocket,
  options: LiveMediaOptions,
): Promise<LiveMediaSession> {
  return new Promise((resolve, reject) => {
    let ready = false;
    let ended = false;
    let staged: { type: string; call_id: string; name: string; arguments: string }[] = [];
    let stagedBytes = 0;
    const pending = new Set<string>();
    const declared = new Set(options.tools?.map((tool) => tool.name));

    const finish = (failed: boolean) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      pending.clear();
      staged = [];
      stagedBytes = 0;
      socket.removeAllListeners("open");
      socket.removeAllListeners("message");
      socket.removeAllListeners("close");
      if (!ready) reject(new Error(failed ? "Live connection failed" : "Live connection closed"));
      options.onEvent({ type: "closed", failed });
    };
    const stop = (failed: boolean) => {
      finish(failed);
      socket.terminate();
    };
    const abort = () => stop(false);
    const timer = setTimeout(() => stop(true), 20_000);
    const send = (message: unknown) => {
      if (ended || socket.readyState !== WebSocket.OPEN) throw new Error("Live connection closed");
      const text = JSON.stringify(message);
      if (Buffer.byteLength(text) > MAX) throw new Error("Live payload too large");
      if (socket.bufferedAmount + Buffer.byteLength(text) > MAX)
        throw new Error("Live connection congested");
      try {
        socket.send(text, (error) => {
          if (error) stop(true);
        });
      } catch {
        stop(true);
        throw new Error("Live connection failed");
      }
    };
    const checkReady = () => {
      if (!ready || ended) throw new Error("Live connection not ready");
    };
    const item = (content: unknown[]) =>
      send({ type: "conversation.item.create", item: { type: "message", role: "user", content } });
    const session: LiveMediaSession = {
      sendAudio(data) {
        checkReady();
        const input = bytes(data, 512 * 1024);
        if (input.length % 2) throw new Error("Invalid PCM16 payload");
        send({ type: "input_audio_buffer.append", audio: data });
      },
      sendFrame() {
        checkReady();
        throw new Error("Live model does not support images");
      },
      sendText(text) {
        checkReady();
        if (!text.trim() || text.length > 32_000) throw new Error("Invalid live text");
        item([{ type: "input_text", text }]);
        send({ type: "response.create" });
      },
      toolResult(id, result) {
        checkReady();
        if (!pending.has(id)) throw new Error("Unknown or cancelled live tool request");
        send({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: id, output: JSON.stringify(result) },
        });
        pending.delete(id);
        if (!pending.size) send({ type: "response.create" });
      },
      close: abort,
    };
    socket.once("open", () => {
      if (ended) return;
      try {
        send({
          type: "session.update",
          session: {
            instructions: options.instructions,
            voice: options.voice ?? "eve",
            turn_detection: { type: "server_vad" },
            audio: {
              input: { format: { type: "audio/pcm", rate: 16000 } },
              output: { format: { type: "audio/pcm", rate: 16000 } },
            },
            tools: (options.tools ?? []).map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          },
        });
      } catch {
        stop(true);
      }
    });
    socket.on("message", (raw) => {
      if (ended) return;
      try {
        if (Buffer.byteLength(raw.toString()) > MAX) throw new Error();
        const event = JSON.parse(raw.toString());
        if (!event || typeof event !== "object" || typeof event.type !== "string")
          throw new Error();
        if (event.type === "error") throw new Error();
        if (event.type === "session.created" || event.type === "conversation.created") return;
        if (event.type === "session.updated" && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(session);
          options.onEvent({ type: "ready" });
          return;
        }
        if (!ready) throw new Error();
        switch (event.type) {
          case "response.audio.delta":
          case "response.output_audio.delta":
            if (bytes(event.delta, 2 * 1024 * 1024).length % 2) throw new Error();
            options.onEvent({ type: "audio", data: event.delta, mimeType: "audio/pcm;rate=16000" });
            break;
          case "conversation.item.input_audio_transcription.completed":
          case "response.audio_transcript.delta":
          case "response.output_audio_transcript.delta":
          case "response.output_text.delta": {
            const text =
              event.type === "conversation.item.input_audio_transcription.completed"
                ? event.transcript
                : event.delta;
            if (typeof text !== "string") throw new Error();
            options.onEvent({
              type: "transcript",
              role:
                event.type === "conversation.item.input_audio_transcription.completed"
                  ? "user"
                  : "bot",
              text,
            });
            break;
          }
          case "input_audio_buffer.speech_started":
            staged = [];
            stagedBytes = 0;
            if (pending.size) {
              const ids = [...pending];
              pending.clear();
              options.onEvent({ type: "tool-cancelled", ids });
            }
            options.onEvent({ type: "interrupted" });
            break;
          case "response.function_call_arguments.done": {
            stagedBytes += Buffer.byteLength(raw.toString());
            if (staged.length >= 64 || stagedBytes > MAX) throw new Error();
            staged.push({ ...event, type: "function_call" });
            break;
          }
          case "response.done": {
            if (event.response?.status === "failed") throw new Error();
            const calls = (event.response?.status === "completed" ? staged : []).filter(
              (entry: { type: string }) => entry.type === "function_call",
            );
            const parsed = calls.map(
              (call: { call_id: string; name: string; arguments: string }) => {
                if (
                  typeof call.call_id !== "string" ||
                  !call.call_id ||
                  call.call_id.length > 1024 ||
                  !declared.has(call.name) ||
                  pending.has(call.call_id)
                )
                  throw new Error();
                const args = JSON.parse(call.arguments);
                if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
                pending.add(call.call_id);
                if (pending.size > 64) throw new Error();
                return { type: "tool-call" as const, id: call.call_id, name: call.name, args };
              },
            );
            staged = [];
            stagedBytes = 0;
            for (const call of parsed) options.onEvent(call);
            options.onEvent({ type: "turn-complete" });
            break;
          }
        }
      } catch {
        stop(true);
      }
    });
    socket.on("error", () => stop(true));
    socket.once("close", (code) => finish(code !== 1000 && code !== 1005));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export class XaiLiveMediaProvider implements LiveMediaProvider {
  open = openXaiLiveMedia;
  async listModels(apiKey: string, signal?: AbortSignal): Promise<LiveMediaModel[]> {
    try {
      const timeout = AbortSignal.timeout(20_000);
      // No speech-model listing is documented; validate credentials first.
      const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch("https://api.x.ai/v1/tts/voices", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: deadline,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      const body = JSON.parse(
        new TextDecoder().decode(await readBodyCapped(response, MAX, deadline)),
      );
      if (!body || !Array.isArray(body.voices)) throw new Error();
      return [...MODELS].map((id) => ({
        id,
        name: id,
        capabilities: { audioInput: true, audioOutput: true, imageInput: false, toolCalls: true },
      }));
    } catch {
      throw new Error("Live model discovery failed");
    }
  }
}
