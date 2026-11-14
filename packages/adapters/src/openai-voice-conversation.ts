import type {
  AdapterContext,
  VoiceConversationAttachRequest,
  VoiceConversationEvent,
  VoiceConversationLink,
  VoiceConversationOpenRequest,
  VoiceConversationSession,
} from "@rakazo/adapter-kit";
import WebSocket from "ws";
import { readVoiceJson, voiceDeadline, voiceRequestError } from "./voice-http.js";

const API = "https://api.openai.com/v1";
const SIDEBAND = "wss://api.openai.com/v1/live/sessions";
const MODEL = "gpt-live-1";
/** Speech voices that also speak live; any other bot voice falls back to the default. */
const CONVERSATION_VOICES = new Set(["marin", "cedar", "brise", "sillage"]);
const DEFAULT_CONVERSATION_VOICE = "marin";
/** Gives the API time to note the handoff before the talker acknowledges it. */
const ACKNOWLEDGEMENT_DELAY_MS = 400;
/** One appended update; the provider rejects longer ones. */
const MAX_APPEND_CHARS = 1800;
const CLOSE_TIMEOUT_MS = 5_000;

export function conversationVoice(voiceId: string): string {
  return CONVERSATION_VOICES.has(voiceId) ? voiceId : DEFAULT_CONVERSATION_VOICE;
}

export async function openOpenAIConversation(
  request: VoiceConversationOpenRequest,
  context: AdapterContext,
): Promise<VoiceConversationSession> {
  const res = await fetch(`${API}/live/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${request.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session: {
        model: MODEL,
        instructions: request.instructions,
        input: request.history.map((line) =>
          line.role === "user"
            ? { type: "message", role: "user", content: [{ type: "input_text", text: line.text }] }
            : {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: line.text }],
              },
        ),
        audio: { output: { voice: conversationVoice(request.voiceId) } },
        delegation: { type: "client", acknowledgement_delay_ms: ACKNOWLEDGEMENT_DELAY_MS },
      },
      transport: { type: "webrtc", sdp: request.offerSdp },
    }),
    signal: voiceDeadline(request.signal ?? context.signal, 30_000),
  });
  const body = (await readVoiceJson(res, { requireValid: res.ok })) as {
    session?: { id?: unknown };
    transport?: { sdp?: unknown };
  } | null;
  if (!res.ok) throw voiceRequestError(res.status, "OpenAI", "starting the call", body);
  const sessionId = body?.session?.id;
  const answerSdp = body?.transport?.sdp;
  if (typeof sessionId !== "string" || typeof answerSdp !== "string") {
    throw new Error("OpenAI returned no live session.");
  }
  return { sessionId, answerSdp };
}

/** Translates one sideband event; null for events the API does not follow. */
export function conversationEventFromWire(raw: unknown): VoiceConversationEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;
  switch (event.type) {
    case "session.started":
      return { type: "started" };
    case "session.input_transcript.delta":
    case "session.output_transcript.delta": {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!delta) return null;
      return {
        type: "transcript",
        role: event.type === "session.input_transcript.delta" ? "user" : "bot",
        delta,
      };
    }
    case "session.delegation.created": {
      const delegation = event.delegation as { id?: unknown } | undefined;
      return typeof delegation?.id === "string"
        ? { type: "handoff", handoffId: delegation.id }
        : null;
    }
    case "session.usage.updated": {
      const seconds = (event.usage as { seconds?: unknown } | undefined)?.seconds;
      return typeof seconds === "number" ? { type: "usage", seconds } : null;
    }
    case "session.closed":
      return { type: "ended", reason: "closed" };
    default:
      return null;
  }
}

class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T) {
    if (this.done) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end() {
    if (this.done) return;
    this.done = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

export function attachOpenAIConversation(
  request: VoiceConversationAttachRequest,
  context: AdapterContext,
): Promise<VoiceConversationLink> {
  return attachConversationSocket(
    `${SIDEBAND}/${encodeURIComponent(request.sessionId)}/attach`,
    request,
    context,
  );
}

/** Joins the session's side channel at `url`; split out so tests can serve one locally. */
export async function attachConversationSocket(
  url: string,
  request: VoiceConversationAttachRequest,
  context: AdapterContext,
): Promise<VoiceConversationLink> {
  const signal = request.signal ?? context.signal;
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${request.apiKey}` } });
  const events = new EventQueue<VoiceConversationEvent>();
  /** The sideband replays the last few seconds on attach; replays keep their event id. */
  const seen = new Set<string>();
  let sent = 0;
  let ended = false;
  let settle = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = (reason: "closed" | "failed") => {
    if (ended) return;
    ended = true;
    settle();
    events.push({ type: "ended", reason });
    events.end();
  };

  ws.on("message", (data) => {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return;
    }
    const id = (raw as { event_id?: unknown } | null)?.event_id;
    if (typeof id === "string") {
      if (seen.has(id)) return;
      seen.add(id);
    }
    const event = conversationEventFromWire(raw);
    if (!event) return;
    if (event.type === "ended") finish("closed");
    else events.push(event);
  });
  ws.on("close", () => finish("failed"));
  ws.on("error", () => finish("failed"));

  await new Promise<void>((resolve, reject) => {
    const deadline = voiceDeadline(signal, 15_000);
    const onAbort = () => {
      ws.terminate();
      reject(new Error("Timed out joining the call."));
    };
    deadline.addEventListener("abort", onAbort, { once: true });
    ws.once("open", () => {
      deadline.removeEventListener("abort", onAbort);
      resolve();
    });
    ws.once("error", (error) => {
      deadline.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
  signal?.addEventListener("abort", () => ws.close(), { once: true });

  const send = (event: Record<string, unknown>) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    sent += 1;
    ws.send(JSON.stringify({ ...event, event_id: `rakazo_${sent}` }));
  };
  const append = (type: string, text: string, handoffId?: string) => {
    const content = text.trim().slice(0, MAX_APPEND_CHARS);
    if (content) send({ type, content, delegation_id: handoffId ?? null });
  };

  return {
    events,
    say: (text, handoffId) => append("session.commentary.append", text, handoffId),
    note: (text, handoffId) => append("session.thinking.append", text, handoffId),
    setListening: (listening) =>
      send({ type: listening ? "session.input_audio.unmute" : "session.input_audio.mute" }),
    close: async () => {
      if (ended || ws.readyState !== WebSocket.OPEN) {
        ws.close();
        return;
      }
      send({ type: "session.close" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
      ws.close();
    },
  };
}
