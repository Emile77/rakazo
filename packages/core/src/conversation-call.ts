import type { CallExchange } from "./call-session.js";

/**
 * A conversation call: a live voice model talks with the caller and hands real work to
 * the bot, which runs it as an ordinary call turn. These helpers are the provider-neutral
 * part of that: the talker's instructions, the transcript it builds, and the updates it
 * receives.
 */

/** Recent thread lines the talker starts from, so it can pick up the topic. */
export const CONVERSATION_HISTORY_LINES = 12;
/** Longest history line; the talker only needs the gist. */
const HISTORY_LINE_CHARS = 600;
/** How long a promise of work may go without a handoff before the API starts the work itself. */
export const CONVERSATION_PROMISE_GRACE_MS = 2_500;

export function conversationCallInstructions(input: {
  botName: string;
  botDescription?: string | null;
  timeZone?: string | null;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const when = now.toLocaleString("en-CA", {
    timeZone: input.timeZone || "UTC",
    dateStyle: "full",
    timeStyle: "short",
  });
  const about = input.botDescription?.trim();
  return [
    `You are ${input.botName}, on a live voice call with your user.${about ? ` ${about}` : ""}`,
    `It is ${when} for the user.`,
    "Reply in the language the user is speaking right now. If they switch languages, switch with them. Use short, natural spoken sentences, never lists or markdown.",
    "",
    "Backchannel policy: Few backchannels. Never talk over the user.",
    "Interruption policy: Stop as soon as the user speaks, and listen.",
    "",
    "Delegation policy:",
    "Backend: the bot behind you is you, with all your tools: its computer, files, the web, its memory, settings, connected apps, other bots and routines, and the full chat history. You only hear and speak; you know nothing else about the user, their bots, settings, servers or past work.",
    "Generate by default. Generate whenever the user asks for anything that is not pure small talk, including:",
    "- Any fact about the user, their bots, settings, voice, servers, files, schedules, messages or earlier chats, even if you think you know it.",
    "- Any check, action, change, message to someone, current information or something remembered.",
    "- What you or the bot can or cannot do.",
    "- Corrections, additions or cancellations of work in progress, and answers to a question the work asked.",
    "- The user wants to hang up.",
    "Do not generate only for:",
    "- Greetings, thanks and small talk.",
    "- A short clarification you need to understand the request.",
    "- Repeating a result the bot already gave in this call.",
    "Never say that something is or is not set, saved, running, possible or available unless a result from the bot said so. If unsure, generate.",
    "",
    "When you delegate, first confirm in one short sentence what you understood, for example 'OK, I'm checking the disk space.'",
    "Never announce a result, a success or a finished action before a result arrives. Never guess facts the result does not state.",
    "When a result arrives, relay it in one or two sentences. If it says more is in the chat, say so.",
    "When an update arrives while the bot keeps working, say it in one or two short sentences, without presenting the work as done. Never describe the bot's plan yourself.",
    "Approvals, codes and passwords are only ever entered on screen; never ask the user to say them.",
  ].join("\n");
}

/** What the talker says when the call opens, before the caller speaks. */
export function conversationGreeting(botName: string): string {
  return `The call just connected. Greet the user now as ${botName}, in one short sentence, in the language of the conversation so far (the user's usual language if there is none), and ask one short question such as how you can help. Then stop and listen.`;
}

/** The thread's latest readable lines, oldest first, trimmed for the talker. */
export function conversationHistory(
  lines: readonly CallExchange[],
  limit = CONVERSATION_HISTORY_LINES,
): CallExchange[] {
  return lines
    .map((line) => ({ role: line.role, text: line.text.trim().slice(0, HISTORY_LINE_CHARS) }))
    .filter((line) => line.text)
    .slice(-limit);
}

/** What the talker hears back when the bot's turn ends. */
export function conversationResult(reply: string): string {
  return `The bot finished. Relay its reply in its meaning, adding nothing it does not say:\n${reply.trim()}`;
}

/** What the talker hears when the bot sends an update while it keeps working. */
export function conversationProgress(update: string): string {
  return `The bot is still working and sent this update. Tell the user in its meaning, adding nothing it does not say, and do not present the work as done:\n${update.trim()}`;
}

/**
 * What a heard line is for. `talk` is the voice and the caller chatting; the other parts
 * belong to a handoff, which the bot's own call turn already keeps in the chat.
 */
type HeardPart = "talk" | "request" | "ack" | "relay";
type HeardLine = CallExchange & { part: HeardPart; endMs?: number };

/**
 * A fragment that starts within this long of its speaker's previous one still belongs to that
 * line, even when the other speaker's words arrived in between: the call is full duplex, so
 * overlapping speech interleaves the two speakers' fragments.
 */
export const CONVERSATION_LINE_GAP_MS = 800;

/** Where a heard fragment went: the index of its line in the transcript. */
export type HeardAt = { line: number };

/**
 * The call's transcript as the API hears it: fragments joined into lines, the requests
 * each handoff stands for, and the small talk the chat should keep.
 */
export function createConversationTranscript() {
  const lines: HeardLine[] = [];
  /** Index of the first line a new handoff may claim. */
  let claimedTo = 0;
  /** Lines before this were already given to the chat as small talk, or left out of it. */
  let keptTo = 0;
  /** What the talker's next line will be, when a handoff or a result already decided it. */
  let nextBotPart: "ack" | "relay" | null = null;
  return {
    hear(
      role: CallExchange["role"],
      delta: string,
      timing: { startMs?: number; endMs?: number } = {},
    ): HeardAt {
      const extend = (index: number): HeardAt => {
        const line = lines[index]!;
        line.text += delta;
        if (timing.endMs !== undefined) line.endMs = timing.endMs;
        return { line: index };
      };
      // A result the talker relays is a new line, even right after its acknowledgement.
      const fresh = role === "bot" && nextBotPart;
      const last = lines.at(-1);
      if (!fresh && last?.role === role) return extend(lines.length - 1);
      // The other speaker cut in: this speaker's line goes on if their words are continuous,
      // unless that line was already given to the chat or claimed by a handoff.
      const own = lines.findLastIndex((line) => line.role === role);
      const ownLine = lines[own];
      if (
        !fresh &&
        ownLine &&
        own >= keptTo &&
        (role === "bot" || own >= claimedTo) &&
        ownLine.endMs !== undefined &&
        timing.startMs !== undefined &&
        timing.startMs - ownLine.endMs <= CONVERSATION_LINE_GAP_MS
      ) {
        return extend(own);
      }
      let part: HeardPart = "talk";
      if (role === "bot" && nextBotPart) {
        part = nextBotPart;
        nextBotPart = null;
      }
      lines.push({ role, text: delta, part, endMs: timing.endMs });
      return { line: lines.length - 1 };
    },
    /**
     * The user's words since the previous handoff, leaving out small talk the chat already
     * kept; the newest user line when none are new.
     */
    claimRequest(): string {
      const from = Math.max(claimedTo, keptTo);
      const fresh = lines.slice(from).filter((line) => line.role === "user");
      for (const line of fresh) line.part = "request";
      // The talker's acknowledgement belongs to the handoff: already said when the
      // handoff came late, else its next line.
      const last = lines.at(-1);
      if (last?.role === "bot" && fresh.length > 0 && last.part === "talk") last.part = "ack";
      else nextBotPart = "ack";
      claimedTo = lines.length;
      const words = fresh.map((line) => line.text.trim()).filter(Boolean);
      if (words.length > 0) return words.join(" ");
      return lines.findLast((line) => line.role === "user")?.text.trim() ?? "";
    },
    /** The talker is about to say the bot's result, which the bot's reply already holds. */
    relaying() {
      nextBotPart = "relay";
    },
    /** The talker promised work in its newest line and no handoff has claimed the request. */
    promisedWork(): boolean {
      const last = lines.at(-1);
      const from = Math.max(claimedTo, keptTo);
      if (last?.role !== "bot" || from >= lines.length) return false;
      const asked = lines.slice(from).some((line) => line.role === "user" && line.text.trim());
      return asked && isWorkPromise(last.text);
    },
    /**
     * Small talk heard since the last call, for the chat to keep. The newest line may still
     * be growing, so it waits unless the call is over.
     */
    takeSmallTalk(options: { final?: boolean } = {}): CallExchange[] {
      const end = options.final ? lines.length : lines.length - 1;
      if (end <= keptTo) return [];
      const settled = lines.slice(keptTo, end);
      keptTo = end;
      return settled
        .filter((line) => line.part === "talk")
        .map((line) => ({ role: line.role, text: line.text.trim() }))
        .filter((line) => line.text);
    },
    lines(): CallExchange[] {
      return lines.map((line) => ({ role: line.role, text: line.text.trim() }));
    },
  };
}

const WORK_PROMISES = [
  /\bje (regarde|vérifie|verifie|m'en occupe|m’en occupe|lance|cherche|check)\b/i,
  /\bje vais (regarder|vérifier|verifier|voir|lancer|chercher|m'en occuper|m’en occuper)\b/i,
  /\b(let me|i'll|i will|i’ll) (check|look|find|take care|handle|run|search)\b/i,
  /\bi'?m (checking|looking|on it)\b/i,
  /\bon it\b/i,
];

/** A spoken line that commits to doing work, in the languages the talker most often uses. */
export function isWorkPromise(text: string): boolean {
  return WORK_PROMISES.some((pattern) => pattern.test(text));
}
