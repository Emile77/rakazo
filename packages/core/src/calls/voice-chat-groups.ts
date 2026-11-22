import type { MessageBlock } from "@rakazo/contracts";
import { sliceWellFormed } from "../primitives/utf8.js";
import { speechFromBlocks } from "./speech-text.js";

/** The fields grouping reads; web `ThreadMessage` and mobile `MobileMessage` both satisfy it. */
export type VoiceChatMessage = {
  id: string;
  role: string;
  runId?: string;
  callId?: string;
  createdAt?: string;
  blocks: MessageBlock[];
};

export type VoiceChatGroup<T extends VoiceChatMessage = VoiceChatMessage> = {
  kind: "voiceChat";
  /**
   * List key: `call:<callId>` for a call's first group, `call:<callId>:<n>` for the
   * later segments a typed message split it into. Keying off the first message would
   * change when an older page extends a segment, remounting the card.
   */
  key: string;
  callId: string;
  messages: T[];
  /** The `voice_call` message the bot left when it hung up; it closes the group. */
  marker?: T;
};
/** Who said a card line: the caller, the live voice model, or the bot answering in the thread. */
export type VoiceChatSpeaker = "user" | "voice" | "bot";

/**
 * A spoken line the live voice model wrote carries the call's nonce and no run; the
 * bot's own replies come from a run. Turn-by-turn calls have no voice lines.
 */
export function voiceChatSpeaker(message: VoiceChatMessage): VoiceChatSpeaker {
  if (message.role === "user") return "user";
  return message.callId && !message.runId ? "voice" : "bot";
}

export type ThreadItem<T extends VoiceChatMessage = VoiceChatMessage> =
  | { kind: "message"; message: T }
  | VoiceChatGroup<T>;

const SUMMARY_MAX = 120;

/**
 * Collapses each run of consecutive call messages into one group: a user
 * message carrying the call's `callId`, or a bot reply to a run already in the
 * group. Anything else ends the run — a typed user message breaks the group
 * even when it reuses the run of a call turn. The bot's `voice_call` marker
 * closes the group, so the work it does after hanging up renders as chat.
 *
 * A reply that lands after the hang-up still joins its card when it answers a spoken
 * turn: the caller may hang up while the bot is still working on a question. The run
 * that wrote the marker is excluded (its later work is wrap-up), and so is a run a
 * typed message reused after the hang-up.
 */
export function groupVoiceChats<T extends VoiceChatMessage>(messages: T[]): ThreadItem<T>[] {
  const items: ThreadItem<T>[] = [];
  let open: VoiceChatGroup<T> | undefined;
  let openRunIds = new Set<string>();
  const segments = new Map<string, number>();
  /** Spoken-turn runs of cards a marker closed, mapped to the card a late reply joins. */
  const lateRuns = new Map<string, VoiceChatGroup<T>>();
  const closeWithMarker = (group: VoiceChatGroup<T>, marker: T, runIds: Set<string>) => {
    group.marker = marker;
    for (const runId of runIds) {
      if (runId !== marker.runId) lateRuns.set(runId, group);
    }
  };
  for (const message of messages) {
    if (message.runId && !message.callId) {
      const late = lateRuns.get(message.runId);
      if (late && message.role === "bot") {
        // Keep the marker last: it is the card's closing line.
        late.messages.splice(late.messages.length - 1, 0, message);
        continue;
      }
      if (late) lateRuns.delete(message.runId);
    }
    if (open) {
      const joinsByRun = Boolean(
        message.role === "bot" && message.runId && openRunIds.has(message.runId),
      );
      if (message.callId === open.callId || joinsByRun) {
        open.messages.push(message);
        if (isCallMarker(message)) {
          closeWithMarker(open, message, openRunIds);
          open = undefined;
          continue;
        }
        if (
          message.callId === open.callId &&
          message.runId &&
          message.blocks[0]?.kind !== "call_request"
        )
          openRunIds.add(message.runId);
        continue;
      }
      open = undefined;
    }
    if (message.callId) {
      const segment = (segments.get(message.callId) ?? 0) + 1;
      segments.set(message.callId, segment);
      open = {
        kind: "voiceChat",
        key: segment === 1 ? `call:${message.callId}` : `call:${message.callId}:${segment}`,
        callId: message.callId,
        messages: [message],
      };
      // A request belongs to the calling run, not to a spoken turn.
      openRunIds = new Set(
        message.runId && message.blocks[0]?.kind !== "call_request" ? [message.runId] : [],
      );
      items.push(open);
      if (isCallMarker(message)) {
        closeWithMarker(open, message, openRunIds);
        open = undefined;
      }
      continue;
    }
    items.push({ kind: "message", message });
  }
  return items;
}

/** Newest bot turn still inside this call's open card. Typed turns and wrap-up sit outside. */
export function latestSpokenCallReply<T extends VoiceChatMessage>(
  messages: T[],
  callId: string,
): T | undefined {
  const groups = groupVoiceChats(messages).filter(
    (item): item is VoiceChatGroup<T> => item.kind === "voiceChat" && item.callId === callId,
  );
  const group = groups.at(-1);
  if (!group || group.marker) return undefined;
  for (let index = group.messages.length - 1; index >= 0; index -= 1) {
    const message = group.messages[index];
    if (message?.role === "bot") return message;
  }
  return undefined;
}

function isCallMarker(message: VoiceChatMessage): boolean {
  return message.role === "bot" && message.blocks[0]?.kind === "voice_call";
}

/** The title the bot hung up with, else the first sentence of its first spoken reply. */
export function voiceChatSummary(group: VoiceChatGroup): string {
  const marker = group.marker?.blocks[0];
  const title = marker?.kind === "voice_call" ? marker.title.trim() : "";
  if (title) return title;
  let spoken = "";
  for (const message of group.messages) {
    if (message.role !== "bot" || message === group.marker) continue;
    spoken = speechFromBlocks(message.blocks).trim();
    if (spoken) break;
  }
  if (!spoken) return "";
  const end = spoken.search(/[.!?](\s|$)/u);
  const sentence = end === -1 ? spoken : spoken.slice(0, end + 1);
  return sentence.length > SUMMARY_MAX
    ? `${sliceWellFormed(sentence, SUMMARY_MAX - 1).trimEnd()}…`
    : sentence;
}

/** The connected time the caller recorded, else whole seconds between the first and last message. */
export function voiceChatDuration(group: VoiceChatGroup): number {
  const marker = group.marker?.blocks[0];
  if (marker?.kind === "voice_call" && marker.durationSeconds !== undefined) {
    return marker.durationSeconds;
  }
  const request = group.messages[0]?.blocks[0];
  if (request?.kind === "call_request" && request.durationSeconds !== undefined) {
    return request.durationSeconds;
  }
  const first = group.messages[0];
  const last = group.messages[group.messages.length - 1];
  if (!first || !last) return 0;
  const seconds = (Date.parse(last.createdAt ?? "") - Date.parse(first.createdAt ?? "")) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
}
