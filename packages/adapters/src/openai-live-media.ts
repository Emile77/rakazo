import type {
  LiveMediaModel,
  LiveMediaOptions,
  LiveMediaProvider,
  LiveMediaSession,
} from "@rakazo/adapter-kit";
import WebSocket from "ws";
import { readBodyCapped } from "./web-ssrf.js";

const MAX = 4 * 1024 * 1024;
// Explicit documented GA snapshots only; never infer image support from "realtime".
// https://developers.openai.com/api/docs/models/gpt-realtime
// https://developers.openai.com/api/docs/models/gpt-realtime-mini
const MODELS = new Set([
  "gpt-realtime",
  "gpt-realtime-2025-08-28",
  "gpt-realtime-mini",
  "gpt-realtime-mini-2025-12-15",
]);

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

/** Streaming linear 16→24 kHz interpolation; retains phase across arbitrary chunks.
 * One sample of lookahead is retained rather than inventing a chunk-edge sample. */
function resampler() {
  let previous: number | undefined;
  let phase = 2;
  return (input: Buffer) => {
    const output: number[] = [];
    for (let i = 0; i < input.length; i += 2) {
      const sample = input.readInt16LE(i);
      if (previous === undefined) output.push(sample);
      else {
        while (phase <= 3) {
          output.push(Math.round(previous + ((sample - previous) * phase) / 3));
          phase += 2;
        }
        phase -= 3;
      }
      previous = sample;
    }
    const result = Buffer.alloc(output.length * 2);
    output.forEach((sample, i) => {
      result.writeInt16LE(sample, i * 2);
    });
    return result.toString("base64");
  };
}

export function openOpenAILiveMedia(
  apiKey: string,
  options: LiveMediaOptions,
): Promise<LiveMediaSession> {
  if (options.signal?.aborted) return Promise.reject(new Error("Live connection aborted"));
  if (!MODELS.has(options.model)) return Promise.reject(new Error("Unsupported live model"));
  try {
    return attachOpenAILiveMedia(
      new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        maxPayload: MAX,
      }),
      options,
    );
  } catch {
    return Promise.reject(new Error("Live connection failed"));
  }
}

/** GA Realtime JSON protocol, not the separate Live API or the beta protocol.
 * https://developers.openai.com/api/docs/guides/realtime-conversations */
export function attachOpenAILiveMedia(
  socket: WebSocket,
  options: LiveMediaOptions,
): Promise<LiveMediaSession> {
  return new Promise((resolve, reject) => {
    let ready = false;
    let ended = false;
    const pending = new Set<string>();
    const declared = new Set(options.tools?.map((tool) => tool.name));
    const resample = resampler();
    const finish = (failed: boolean) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      pending.clear();
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
        // Check before advancing the resampler's state.
        if (socket.bufferedAmount + input.length * 2 + 128 > MAX)
          throw new Error("Live connection congested");
        const audio = resample(input);
        if (audio) send({ type: "input_audio_buffer.append", audio });
      },
      sendFrame(data, mimeType) {
        checkReady();
        if (!MODELS.has(options.model)) throw new Error("Live model does not support images");
        if (mimeType !== "image/jpeg" && mimeType !== "image/png")
          throw new Error("Invalid frame type");
        bytes(data, 2 * 1024 * 1024);
        item([{ type: "input_image", image_url: `data:${mimeType};base64,${data}` }]);
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
            type: "realtime",
            instructions: options.instructions,
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: { model: "whisper-1" },
                turn_detection: {
                  type: "server_vad",
                  create_response: true,
                  interrupt_response: true,
                },
              },
              output: {
                format: { type: "audio/pcm", rate: 24000 },
                voice: options.voice ?? "marin",
              },
            },
            tools: (options.tools ?? []).map((tool) => ({ type: "function", ...tool })),
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
        if (event.type === "session.created") return;
        if (event.type === "session.updated" && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(session);
          options.onEvent({ type: "ready" });
          return;
        }
        if (!ready) throw new Error();
        switch (event.type) {
          case "response.output_audio.delta":
            bytes(event.delta, 2 * 1024 * 1024);
            options.onEvent({ type: "audio", data: event.delta, mimeType: "audio/pcm;rate=24000" });
            break;
          case "conversation.item.input_audio_transcription.completed":
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
            options.onEvent({ type: "interrupted" });
            break;
          case "response.done": {
            if (event.response?.status === "failed") throw new Error();
            const calls = (
              event.response?.status === "completed" ? (event.response.output ?? []) : []
            ).filter((entry: { type: string }) => entry.type === "function_call");
            const parsed = calls.map(
              (call: { call_id: string; name: string; arguments: string }) => {
                if (
                  typeof call.call_id !== "string" ||
                  !call.call_id ||
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

export class OpenAILiveMediaProvider implements LiveMediaProvider {
  open = openOpenAILiveMedia;
  async listModels(apiKey: string, signal?: AbortSignal): Promise<LiveMediaModel[]> {
    try {
      const timeout = AbortSignal.timeout(20_000);
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error();
      const page = JSON.parse(
        new TextDecoder().decode(await readBodyCapped(response, MAX, signal)),
      );
      if (!Array.isArray(page.data) || page.has_more === true) throw new Error();
      return [
        ...new Set<string>(
          page.data
            .map((entry: { id?: string }) => entry?.id)
            .filter((id: string) => MODELS.has(id)),
        ),
      ].map((id) => ({
        id,
        name: id,
        capabilities: { audioInput: true, audioOutput: true, imageInput: true, toolCalls: true },
      }));
    } catch {
      throw new Error("Live model discovery failed");
    }
  }
}
