import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { LiveMediaEvent } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { openConfiguredLiveCall } from "./configured-live-call.js";

type Event = Exclude<LiveMediaEvent, { type: "tool-call" } | { type: "tool-cancelled" }>;
type Link = Awaited<ReturnType<typeof openConfiguredLiveCall>>;
/** Process-local, bounded replay handles. Committed transcripts survive process loss. */
export function createLiveMediaSessions() {
  type Entry = {
    owner: string;
    botId: string;
    callId: string;
    link?: Link;
    closed: boolean;
    seq: number;
    bytes: number;
    events: { seq: number; event: Event }[];
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    pending: Promise<void>;
    failure?: unknown;
    transcript?: { role: "user" | "bot"; text: string; seq: number };
    flush(): void;
    budget: number;
    window: number;
    transcriptBytes: number;
    lastSeen: number;
    created: number;
    closedAt?: number;
  };
  const sessions = new Map<string, Entry>();
  const owner = (actor: Actor) => `${actor.spaceId}:${actor.userId}`;
  const get = (actor: Actor, botId: string, id: string) => {
    const entry = sessions.get(id);
    if (!entry || entry.owner !== owner(actor) || entry.botId !== botId)
      throw new ORPCError("NOT_FOUND");
    return entry;
  };
  const close = (entry: Entry) => {
    if (entry.closed) return;
    entry.flush();
    entry.closed = true;
    entry.closedAt = Date.now();
    entry.controller.abort();
    entry.events.push({
      seq: ++entry.seq,
      event: { type: "closed", failed: Boolean(entry.failure) },
    });
  };
  return {
    async connect(
      actor: Actor,
      botId: string,
      callId: string,
      open: (signal: AbortSignal, emit: (event: Event) => void) => Promise<Link>,
      persist: (event: Extract<Event, { type: "transcript" }>, seq: number) => Promise<void>,
    ) {
      if (
        sessions.size >= 200 ||
        [...sessions.values()].filter((e) => e.owner === owner(actor) && !e.closed).length >= 3
      )
        throw new ORPCError("TOO_MANY_REQUESTS");
      if (
        [...sessions.values()].some(
          (e) => e.owner === owner(actor) && e.callId === callId && !e.closed,
        )
      )
        throw new ORPCError("CONFLICT");
      const id = randomUUID();
      const entry: Entry = {
        owner: owner(actor),
        botId,
        callId,
        closed: false,
        seq: 0,
        bytes: 0,
        events: [],
        controller: new AbortController(),
        timer: setInterval(() => {
          const e = sessions.get(id);
          if (!e) return;
          if (
            !e.closed &&
            (Date.now() - e.lastSeen > 90_000 || Date.now() - e.created >= 30 * 60_000)
          )
            close(e);
          if (e.closedAt !== undefined && Date.now() - e.closedAt >= 90_000) {
            clearInterval(e.timer);
            sessions.delete(id);
          }
        }, 15_000),
        pending: Promise.resolve(),
        budget: 0,
        window: Date.now(),
        transcriptBytes: 0,
        lastSeen: Date.now(),
        created: Date.now(),
        flush() {
          const transcript = entry.transcript;
          if (!transcript) return;
          entry.transcript = undefined;
          entry.pending = entry.pending
            .then(() =>
              persist(
                { type: "transcript", role: transcript.role, text: transcript.text },
                transcript.seq,
              ),
            )
            .catch((error) => {
              entry.failure = error;
              close(entry);
            });
        },
      };
      entry.timer.unref();
      sessions.set(id, entry);
      try {
        entry.link = await open(entry.controller.signal, (event) => {
          if (entry.closed) return;
          const seq = ++entry.seq;
          entry.events.push({ seq, event });
          entry.bytes += JSON.stringify(event).length;
          while (entry.events.length > 512 || entry.bytes > 8_000_000) {
            const removed = entry.events.shift();
            if (!removed) break;
            entry.bytes -= JSON.stringify(removed.event).length;
          }
          if (event.type === "transcript") {
            entry.transcriptBytes += event.text.length;
            if (entry.transcriptBytes > 1_000_000) {
              entry.failure = new Error("Transcript limit");
              close(entry);
              return;
            }
            if (entry.transcript?.role !== event.role) entry.flush();
            if (entry.transcript) entry.transcript.text += event.text;
            else entry.transcript = { role: event.role, text: event.text, seq };
          }
          if (event.type === "turn-complete" || event.type === "interrupted") entry.flush();
          if (event.type === "closed" || event.type === "reconnect-needed") close(entry);
        });
        if (entry.closed) entry.controller.abort();
        return { sessionId: id };
      } catch (error) {
        close(entry);
        clearTimeout(entry.timer);
        sessions.delete(id);
        throw error;
      }
    },
    events(actor: Actor, botId: string, id: string, cursor: number) {
      const entry = get(actor, botId, id);
      entry.lastSeen = Date.now();
      if (cursor > entry.seq || cursor < (entry.events[0]?.seq ?? 1) - 1)
        throw new ORPCError("CONFLICT");
      return {
        cursor: entry.seq,
        closed: entry.closed,
        events: entry.events.filter((e) => e.seq > cursor),
      };
    },
    input(
      actor: Actor,
      botId: string,
      id: string,
      input: {
        type: "audio" | "frame" | "text";
        data?: string;
        text?: string;
        mimeType?: "image/jpeg" | "image/png";
      },
    ) {
      const entry = get(actor, botId, id);
      if (entry.closed || !entry.link) throw new ORPCError("NOT_FOUND");
      if (Date.now() - entry.window >= 1000) {
        entry.budget = 0;
        entry.window = Date.now();
      }
      entry.budget += input.data?.length ?? input.text?.length ?? 0;
      if (entry.budget > 2_000_000) throw new ORPCError("TOO_MANY_REQUESTS");
      entry.lastSeen = Date.now();
      const { scope, link } = entry.link;
      if (input.type === "audio") link.audio(scope, input.data!);
      else if (input.type === "frame") link.frame(scope, input.data!, input.mimeType!);
      else link.text(scope, input.text!);
    },
    async end(actor: Actor, botId: string, id: string) {
      const entry = get(actor, botId, id);
      close(entry);
      await entry.pending;
      if (entry.failure) throw new ORPCError("INTERNAL_SERVER_ERROR");
    },
  };
}
