import type { MessageBlock } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock } from "../runs/action-approval.js";
import { ACTIVE_RUN_STATUSES } from "../runs/run-state.js";
import { speechFromBlocks } from "./speech-text.js";

/**
 * What happens in the chat during a live call, told to the voice as quiet notes, so the caller
 * can ask about anything the bot does while they talk: its messages, its steps, the cards it
 * waits on (an approval in full), and its errors. Only what the thread shows becomes a note,
 * so the voice never learns anything the caller could not read on screen.
 */

/** Longest note; a card's details beyond this are cut, and the note says so. */
export const CALL_NOTE_MAX_CHARS = 3_500;
/** Longest piece of one message in a note; the chat keeps the rest. */
const NOTE_TEXT_CHARS = 1_200;

export type CallActivityMessage = {
  id: string;
  role: string;
  runId?: string;
  /** Set on a call's own turns, which the voice already heard. */
  callId?: string;
  blocks: readonly MessageBlock[];
};

export type CallActivityThread = {
  run: { id: string; status: string; error?: string | null } | null;
  activeRuns?: readonly { id: string; status: string; error?: string | null }[];
  messages: readonly CallActivityMessage[];
};

/**
 * Remembers what the voice was already told. `start` records the chat as it was when the call
 * connected, so only later activity becomes a note, except a card still waiting then, which the
 * voice must know about to discuss it.
 */
export function createCallActivity() {
  /** Each message's last noted form, by message id. */
  const noted = new Map<string, string>();
  /** Runs whose failure was already noted. */
  const failed = new Set<string>();
  let started = false;
  /** The chat as it was at the start is recorded; a call can start before the chat loads. */
  let baselined = false;
  const baseline = (thread: CallActivityThread) => {
    baselined = true;
    for (const message of thread.messages) {
      if (pendingAsk(message)) continue;
      noted.set(message.id, signature(message, thread));
    }
    for (const run of runsOf(thread)) if (run.status === "failed") failed.add(run.id);
  };
  return {
    get started() {
      return started;
    },
    start(thread: CallActivityThread | null) {
      started = true;
      if (thread) baseline(thread);
    },
    /**
     * Notes for what changed since the last call. `skip` holds messages the voice already says in
     * full as a reply, which need no note; `callId` is this call, whose own turns it heard.
     */
    notes(
      thread: CallActivityThread | null,
      options: { callId?: string; skip?: ReadonlySet<string> } = {},
    ): string[] {
      if (!started || !thread) return [];
      if (!baselined) baseline(thread);
      const out: string[] = [];
      for (const message of thread.messages) {
        if (message.callId && message.callId === options.callId) continue;
        const form = signature(message, thread);
        if (noted.get(message.id) === form) continue;
        // A message the run is still writing is noted once it stops changing, except its live
        // status line and a card, which are what the caller sees right now.
        const working = runWorking(thread, message.runId);
        const live = message.id.startsWith("progress:");
        if (working && !live && !pendingAsk(message)) continue;
        noted.set(message.id, form);
        if (options.skip?.has(message.id)) continue;
        const note = describeMessage(message, { finished: !working });
        if (note) out.push(note);
      }
      for (const run of runsOf(thread)) {
        if (run.status !== "failed" || failed.has(run.id)) continue;
        failed.add(run.id);
        out.push(
          clip(
            `Call activity: the bot's work stopped with an error${run.error ? `: ${run.error}` : "."}`,
          ),
        );
      }
      return out;
    },
  };
}

export type CallActivity = ReturnType<typeof createCallActivity>;

/** The note for one message, or "" when it says nothing the voice could use. */
export function describeMessage(
  message: CallActivityMessage,
  options: { finished?: boolean } = {},
): string {
  const ask = pendingAsk(message);
  if (ask) return clip(describeAsk(ask));
  if (message.id.startsWith("progress:")) {
    const status = speechFromBlocks([...message.blocks]).trim();
    return status ? clip(`Call activity: the bot is working. Its status: ${status}`) : "";
  }
  const steps = message.blocks.flatMap((block) => (block.kind === "steps" ? block.steps : []));
  const text = speechFromBlocks(
    message.blocks.filter((block) => block.kind !== "ask") as MessageBlock[],
  ).trim();
  const parts: string[] = [];
  if (steps.length) parts.push(`Steps it took: ${steps.map(stepText).join("; ")}.`);
  if (text) {
    const who =
      message.role === "user" ? "The user wrote in the chat" : "The bot wrote in the chat";
    parts.push(`${who}: ${cut(text, NOTE_TEXT_CHARS)}`);
  }
  if (parts.length === 0) return "";
  const lead = options.finished === false ? "Call activity (still working)" : "Call activity";
  return clip(`${lead}: ${parts.join(" ")}`);
}

/** A waiting card, told in full so the voice can explain it and take a spoken answer. */
export function describeAsk(ask: Extract<MessageBlock, { kind: "ask" }>): string {
  if (isSecretAskBlock(ask)) {
    return `Call activity: a card is waiting on screen for a code or password: ${ask.text.trim()}. It is only typed on screen, never said aloud; the caller's audio is paused while it waits.`;
  }
  const lines: string[] = [];
  if (isApprovalAskBlock(ask)) {
    lines.push(`Call activity: an approval card is waiting on screen. It asks: ${ask.text.trim()}`);
  } else {
    lines.push(
      `Call activity: the bot asked a question and waits for the answer: ${ask.text.trim()}`,
    );
  }
  if (ask.detail?.trim()) lines.push(`Its details: ${ask.detail.trim()}`);
  if (ask.receipt) lines.push(`Its order: ${JSON.stringify(ask.receipt)}`);
  if (ask.site) lines.push(`Site: ${ask.site}`);
  if (ask.settingsUpdate) {
    lines.push(
      `Settings change: from ${JSON.stringify(ask.settingsUpdate.before)} to ${JSON.stringify(ask.settingsUpdate.after)}`,
    );
  }
  if (ask.instructionUpdate) {
    const update = ask.instructionUpdate;
    if (update.reason.trim()) lines.push(`Why: ${update.reason.trim()}`);
    lines.push(`Instructions now: ${cut(update.before, 900)}`);
    lines.push(`Instructions after: ${cut(update.after, 1_400)}`);
  }
  const choices = ask.actions?.map((action) => action.label).filter(Boolean) ?? [];
  if (isApprovalAskBlock(ask)) {
    lines.push(
      "Tell the user what it asks in plain words and answer their questions about it from these details only. They may approve or deny it out loud: when they clearly decide, delegate their decision in their words. Never decide for them; if their answer is unclear, ask again.",
    );
  } else if (choices.length) {
    lines.push(`Choices: ${choices.join(", ")}. Delegate the user's answer in their words.`);
  } else {
    lines.push("Delegate the user's answer in their words.");
  }
  return lines.join("\n");
}

function stepText(step: Extract<MessageBlock, { kind: "steps" }>["steps"][number]) {
  const failed = step.outcomes?.failed;
  const stopped = step.outcomes?.stopped;
  return [
    step.count > 1 ? `${step.label} (${step.count} times)` : step.label,
    failed ? `${failed} failed` : "",
    stopped ? `${stopped} stopped` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function pendingAsk(message: CallActivityMessage) {
  if (message.role !== "bot") return undefined;
  return message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "ask" }> =>
      block.kind === "ask" && block.status !== "answered",
  );
}

function signature(message: CallActivityMessage, thread: CallActivityThread | null): string {
  const ask = pendingAsk(message);
  return `${runWorking(thread, message.runId) ? "w" : "f"}:${ask ? "ask" : ""}:${JSON.stringify(message.blocks)}`;
}

function runsOf(thread: CallActivityThread | null) {
  const runs = [thread?.run, ...(thread?.activeRuns ?? [])].filter(
    (run): run is NonNullable<typeof run> => Boolean(run),
  );
  return [...new Map(runs.map((run) => [run.id, run])).values()];
}

const WORKING = new Set<string>(ACTIVE_RUN_STATUSES.filter((status) => status !== "waiting_input"));

function runWorking(thread: CallActivityThread | null, runId: string | undefined): boolean {
  if (!runId) return false;
  const run = runsOf(thread).find((candidate) => candidate.id === runId);
  return Boolean(run && WORKING.has(run.status));
}

function cut(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}… (cut; the rest is on screen)`;
}

function clip(text: string): string {
  return cut(text, CALL_NOTE_MAX_CHARS);
}
