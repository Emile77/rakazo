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
    "Speak the user's language, as in the conversation so far. Use short, natural spoken sentences, never lists or markdown.",
    "",
    "Backchannel policy: Few backchannels. Never talk over the user.",
    "Interruption policy: Stop as soon as the user speaks, and listen.",
    "",
    "Delegation policy:",
    "Backend: the bot behind you can use its computer, files, the web, its memory, connected apps, other bots and routines, and it keeps the chat history.",
    "Generate when:",
    "- The request needs a tool, a check, an action, current information or something remembered.",
    "- The user corrects, adds to or cancels work in progress.",
    "- The user answers a question the work asked.",
    "- The user asks about what you or the bot can do, or about earlier chats.",
    "- The user wants to hang up.",
    "Do not generate when:",
    "- Greetings, small talk, general knowledge, or repeating a result already given.",
    "- You need a short clarification to understand the request.",
    "",
    "When you delegate, first confirm in one short sentence what you understood, for example 'OK, I'm checking the disk space.'",
    "Never announce a result, a success or a finished action before a result arrives. Never guess facts the result does not state.",
    "When a result arrives, relay it in one or two sentences. If it says more is in the chat, say so.",
    "Approvals, codes and passwords are only ever entered on screen; never ask the user to say them.",
  ].join("\n");
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

/**
 * The call's transcript as the API hears it: fragments joined into lines, and the requests
 * each handoff stands for.
 */
export function createConversationTranscript() {
  const lines: CallExchange[] = [];
  /** Index of the first line a new handoff may claim. */
  let claimedTo = 0;
  return {
    hear(role: CallExchange["role"], delta: string) {
      const last = lines.at(-1);
      if (last?.role === role) last.text += delta;
      else lines.push({ role, text: delta });
    },
    /** The user's words since the previous handoff; the newest user line when none are new. */
    claimRequest(): string {
      const fresh = lines
        .slice(claimedTo)
        .filter((line) => line.role === "user")
        .map((line) => line.text.trim())
        .filter(Boolean);
      claimedTo = lines.length;
      if (fresh.length > 0) return fresh.join(" ");
      return lines.findLast((line) => line.role === "user")?.text.trim() ?? "";
    },
    /** The talker promised work in its newest line and no handoff has claimed the request. */
    promisedWork(): boolean {
      const last = lines.at(-1);
      if (last?.role !== "bot" || claimedTo >= lines.length) return false;
      const asked = lines.slice(claimedTo).some((line) => line.role === "user" && line.text.trim());
      return asked && isWorkPromise(last.text);
    },
    lines(): CallExchange[] {
      return lines.map((line) => ({ ...line, text: line.text.trim() }));
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
