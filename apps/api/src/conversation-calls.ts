import { ORPCError } from "@orpc/server";
import type { VoiceConversationLink } from "@rakazo/adapter-kit";
import type { Actor, ConversationCallEvent, MessageBlock } from "@rakazo/contracts";
import type { CallExchange } from "@rakazo/core";
import {
  CONVERSATION_PROMISE_GRACE_MS,
  callClientNonce,
  conversationCallInstructions,
  conversationGreeting,
  conversationHistory,
  conversationProgress,
  conversationResult,
  createConversationTranscript,
  speechFromBlocks,
} from "@rakazo/core";
import type { ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  loadMessageAuthor,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { VoiceDeps } from "./voice.js";
import {
  resolveVoiceTarget,
  voiceContext,
  voiceLiveCallsEnabled,
  voiceProviderFor,
  withVoiceConnection,
} from "./voice.js";

/** A handoff waits this long for the talker's acknowledgement, so the request is complete. */
const HANDOFF_SETTLE_MS = 400;
/** A live conversation never outlasts this, even if its client vanished without hanging up. */
const MAX_CONVERSATION_MS = 2 * 60 * 60 * 1000;

interface ConversationCall {
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  callId: string;
  link: VoiceConversationLink;
  transcript: ReturnType<typeof createConversationTranscript>;
  /** Small talk already handed to the chat, written in order. */
  kept: Promise<void>;
  /** Settles once the side channel is done and its small talk is in the chat. */
  followed: Promise<void>;
  /** Ends the provider link and every timer when the call closes. */
  controller: AbortController;
  /** Events not yet read by the call's client. */
  backlog: ConversationCallEvent[];
  wake: (() => void) | null;
  ended: boolean;
  /** What the talker says first; cleared once said or once the caller speaks first. */
  greeting: string | null;
}

/**
 * Live conversation calls this API process holds. The caller's audio flows between the
 * device and the voice provider; the API follows the conversation on a side channel,
 * turns each handoff into an ordinary call turn sent by the client, and gives the voice the
 * bot's replies to say.
 */
export type ConversationCallDeps = VoiceDeps & { events: Pick<ThreadEvents, "notify"> };

export function createConversationCalls(deps: ConversationCallDeps) {
  const calls = new Map<string, ConversationCall>();
  const keyOf = (actor: Pick<Actor, "userId">, callId: string) => `${actor.userId}:${callId}`;

  const own = (actor: Actor, botId: string, callId: string) => {
    const call = calls.get(keyOf(actor, callId));
    if (!call || call.botId !== botId) {
      throw new ORPCError("NOT_FOUND", { message: "This call is no longer live." });
    }
    return call;
  };

  const push = (call: ConversationCall, event: ConversationCallEvent) => {
    if (call.ended) return;
    call.backlog.push(event);
    call.wake?.();
  };

  const finish = (key: string, call: ConversationCall) => {
    if (call.ended) return;
    call.backlog.push({ type: "ended" });
    call.ended = true;
    call.wake?.();
    call.controller.abort();
    if (calls.get(key) === call) calls.delete(key);
  };

  /** Hands the small talk heard so far to the chat, after what it already holds. */
  const keep = (call: ConversationCall, options: { final?: boolean } = {}) => {
    const lines = call.transcript.takeSmallTalk(options);
    if (lines.length === 0) return;
    call.kept = call.kept
      .then(() => keepSmallTalk(deps, call, lines))
      .catch((error) => getLogger().error("conversation call small talk", error));
  };

  /** Reads the provider's events until the conversation ends. */
  const follow = async (key: string, call: ConversationCall) => {
    const { transcript } = call;
    let settle: { handoffId: string; timer: ReturnType<typeof setTimeout> } | null = null;
    let promiseTimer: ReturnType<typeof setTimeout> | null = null;
    let seconds = 0;
    const handOff = (handoffId?: string) => {
      const text = transcript.claimRequest();
      if (text) push(call, { type: "handoff", ...(handoffId ? { handoffId } : {}), text });
    };
    const releaseHandoff = () => {
      if (!settle) return;
      clearTimeout(settle.timer);
      const { handoffId } = settle;
      settle = null;
      handOff(handoffId);
    };
    try {
      for await (const event of call.link.events) {
        if (event.type === "transcript") {
          // The voice's acknowledgement has started, so the request it answers is complete.
          if (event.role === "bot") releaseHandoff();
          // The caller speaks again: what came before is settled, so the chat keeps its small talk.
          if (event.role === "user" && transcript.lines().at(-1)?.role !== "user") {
            releaseHandoff();
            keep(call);
          }
          if (event.role === "user") call.greeting = null;
          const heard = transcript.hear(event.role, event.delta, {
            startMs: event.startMs,
            endMs: event.endMs,
          });
          push(call, { type: "caption", role: event.role, text: event.delta, line: heard.line });
          if (event.role !== "bot") continue;
          if (promiseTimer) clearTimeout(promiseTimer);
          promiseTimer = setTimeout(() => {
            promiseTimer = null;
            // The voice said it would do something but handed nothing over: do it anyway.
            if (!settle && transcript.promisedWork()) handOff();
          }, CONVERSATION_PROMISE_GRACE_MS);
        } else if (event.type === "handoff") {
          releaseHandoff();
          const timer = setTimeout(releaseHandoff, HANDOFF_SETTLE_MS);
          settle = { handoffId: event.handoffId, timer };
        } else if (event.type === "started") {
          getLogger().info("conversation call started", {
            model: event.model ?? "unknown",
            voice: event.voice ?? "unknown",
          });
          if (call.greeting) call.link.say(call.greeting);
          call.greeting = null;
        } else if (event.type === "usage") {
          seconds = event.seconds;
        } else if (event.type === "ended") {
          break;
        }
      }
    } catch (error) {
      getLogger().warn("conversation call side channel failed", {
        reason: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      if (settle) clearTimeout(settle.timer);
      if (promiseTimer) clearTimeout(promiseTimer);
      getLogger().info("conversation call ended", { seconds });
      keep(call, { final: true });
      await call.kept;
      finish(key, call);
    }
  };

  return {
    /** Opens the conversation and returns the provider's answer for the caller's offer. */
    async connect(
      actor: Actor,
      input: {
        botId: string;
        threadId: string;
        callId: string;
        offerSdp: string;
        /** The voice greets the caller first. */
        greet?: boolean;
      },
    ) {
      if (!voiceLiveCallsEnabled(deps)) {
        throw new ORPCError("PRECONDITION_FAILED", {
          message: "Live calls are off on this server.",
        });
      }
      const bot = await deps.prisma.bot.findFirst({
        where: { id: input.botId, spaceId: actor.spaceId },
        select: { name: true, description: true },
      });
      if (!bot) throw new IsolationError();
      const target = await resolveVoiceTarget(deps, actor, { botId: input.botId });
      if (!target.cred.liveCalls) {
        throw new ORPCError("PRECONDITION_FAILED", {
          message: "Live calls are off for this voice.",
        });
      }
      const provider = await voiceProviderFor(deps, target.cred.provider);
      const { openConversation, attachConversation } = provider;
      if (
        !provider.describe().capabilities.conversation ||
        !openConversation ||
        !attachConversation
      ) {
        throw new ORPCError("PRECONDITION_FAILED", {
          message: "This voice can't hold a live conversation.",
        });
      }
      const [user, history] = await Promise.all([
        deps.prisma.user.findUnique({ where: { id: actor.userId }, select: { timezone: true } }),
        recentHistory(deps, input.threadId),
      ]);
      const key = keyOf(actor, input.callId);
      const previous = calls.get(key);
      if (previous) {
        finish(key, previous);
        await previous.link.close().catch(() => undefined);
      }
      const controller = new AbortController();
      const context = voiceContext(actor, controller.signal);
      const session = await withVoiceConnection(target.cred.provider, target.linked, () =>
        openConversation.call(
          provider,
          {
            apiKey: target.apiKey,
            voiceId: target.voiceId,
            instructions: conversationCallInstructions({
              botName: bot.name,
              botDescription: bot.description,
              timeZone: user?.timezone,
              greeted: input.greet !== false,
            }),
            history,
            ...(input.greet === false ? {} : { greeting: conversationGreeting(bot.name) }),
            offerSdp: input.offerSdp,
          },
          context,
        ),
      );
      const link = await attachConversation.call(
        provider,
        { apiKey: target.apiKey, sessionId: session.sessionId, signal: controller.signal },
        context,
      );
      const call: ConversationCall = {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: input.botId,
        threadId: input.threadId,
        callId: input.callId,
        link,
        transcript: createConversationTranscript(),
        kept: Promise.resolve(),
        followed: Promise.resolve(),
        controller,
        backlog: [],
        wake: null,
        ended: false,
        greeting: input.greet === false ? null : conversationGreeting(bot.name),
      };
      calls.set(key, call);
      const deadline = setTimeout(() => void link.close(), MAX_CONVERSATION_MS);
      controller.signal.addEventListener("abort", () => clearTimeout(deadline), { once: true });
      call.followed = follow(key, call);
      return { answerSdp: session.answerSdp };
    },

    /** The conversation's events for its client, until it ends or the client stops reading. */
    events(
      actor: Actor,
      input: { botId: string; callId: string },
      signal?: AbortSignal,
    ): AsyncGenerator<ConversationCallEvent> {
      return readEvents(own(actor, input.botId, input.callId), signal);
    },

    update(
      actor: Actor,
      input: {
        botId: string;
        callId: string;
        say?: { text: string; handoffId?: string; progress?: boolean };
        listening?: boolean;
      },
    ) {
      const call = own(actor, input.botId, input.callId);
      if (input.listening !== undefined) call.link.setListening(input.listening);
      if (input.say) {
        call.transcript.relaying();
        // An update leaves the handoff open for its result.
        if (input.say.progress) call.link.say(conversationProgress(input.say.text));
        else call.link.say(conversationResult(input.say.text), input.say.handoffId);
      }
    },

    /**
     * Closes the caller's conversation, if this process holds one, once its small talk is in
     * the chat.
     */
    async end(actor: Pick<Actor, "userId">, callId: string) {
      const key = keyOf(actor, callId);
      const call = calls.get(key);
      if (!call) return;
      await call.link.close().catch(() => undefined);
      await call.followed;
      finish(key, call);
    },
  };
}

export type ConversationCalls = ReturnType<typeof createConversationCalls>;

async function* readEvents(
  call: ConversationCall,
  signal?: AbortSignal,
): AsyncGenerator<ConversationCallEvent> {
  const abandoned = () => call.wake?.();
  signal?.addEventListener("abort", abandoned, { once: true });
  try {
    while (!signal?.aborted) {
      const event = call.backlog.shift();
      if (event) {
        yield event;
        if (event.type === "ended") return;
        continue;
      }
      await new Promise<void>((resolve) => {
        call.wake = resolve;
      });
      call.wake = null;
    }
  } finally {
    signal?.removeEventListener("abort", abandoned);
  }
}

/**
 * Writes small talk into the call's card as call turns, so the bot reads it in its history
 * and the hang-up turn sees the whole call. Neither side starts a run.
 */
async function keepSmallTalk(
  deps: ConversationCallDeps,
  call: ConversationCall,
  lines: readonly CallExchange[],
) {
  const eventSeq = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const author = await loadMessageAuthor(tx, call.userId);
      let seq = 0;
      for (const line of lines) {
        const blocks: MessageBlock[] = [{ kind: "text", text: line.text }];
        const message = await createThreadMessageInTransaction(tx, {
          threadId: call.threadId,
          role: line.role,
          ...(line.role === "bot" ? { botId: call.botId } : { authorUserId: call.userId }),
          blocks,
          // The caller is on the call, reading its card.
          markUnread: false,
          clientNonce: callClientNonce(call.callId),
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: call.spaceId,
          threadId: call.threadId,
          botId: call.botId,
          type: "thread.message.created",
          payload: {
            messageId: message.id,
            role: line.role,
            blocks,
            ...(line.role === "user" ? { author } : {}),
            callId: call.callId,
          },
        });
        seq = event.seq;
      }
      return seq;
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  await deps.events.notify(call.threadId, eventSeq).catch((error) => {
    getLogger().error("conversation call small talk realtime notification", error);
  });
}

/** The thread's latest readable lines, which the voice starts from. */
async function recentHistory(deps: VoiceDeps, threadId: string) {
  const messages = await deps.prisma.message.findMany({
    where: { threadId, role: { in: ["user", "bot"] } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { role: true, blocks: true },
  });
  return conversationHistory(
    messages.reverse().map((message) => ({
      role: message.role === "user" ? ("user" as const) : ("bot" as const),
      text: speechFromBlocks(message.blocks as MessageBlock[]),
    })),
  );
}
