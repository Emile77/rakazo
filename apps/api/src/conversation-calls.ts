import { ORPCError } from "@orpc/server";
import type { VoiceConversationLink } from "@rakazo/adapter-kit";
import type { Actor, ConversationCallEvent, MessageBlock } from "@rakazo/contracts";
import {
  CONVERSATION_PROMISE_GRACE_MS,
  conversationCallInstructions,
  conversationHistory,
  conversationResult,
  createConversationTranscript,
  speechFromBlocks,
} from "@rakazo/core";
import { IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { VoiceDeps } from "./voice.js";
import {
  resolveVoiceTarget,
  voiceContext,
  voiceProviderFor,
  withVoiceConnection,
} from "./voice.js";

/** A handoff waits this long for the talker's acknowledgement, so the request is complete. */
const HANDOFF_SETTLE_MS = 400;
/** A live conversation never outlasts this, even if its client vanished without hanging up. */
const MAX_CONVERSATION_MS = 2 * 60 * 60 * 1000;

interface ConversationCall {
  userId: string;
  botId: string;
  link: VoiceConversationLink;
  /** Ends the provider link and every timer when the call closes. */
  controller: AbortController;
  /** Events not yet read by the call's client. */
  backlog: ConversationCallEvent[];
  wake: (() => void) | null;
  ended: boolean;
}

/**
 * Live conversation calls this API process holds. The caller's audio flows between the
 * device and the voice provider; the API follows the conversation on a side channel,
 * turns each handoff into an ordinary call turn sent by the client, and gives the voice the
 * bot's replies to say.
 */
export function createConversationCalls(deps: VoiceDeps) {
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

  /** Reads the provider's events until the conversation ends. */
  const follow = async (key: string, call: ConversationCall) => {
    const transcript = createConversationTranscript();
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
          transcript.hear(event.role, event.delta);
          push(call, { type: "caption", role: event.role, text: event.delta });
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
      finish(key, call);
    }
  };

  return {
    /** Opens the conversation and returns the provider's answer for the caller's offer. */
    async connect(
      actor: Actor,
      input: { botId: string; threadId: string; callId: string; offerSdp: string },
    ) {
      const bot = await deps.prisma.bot.findFirst({
        where: { id: input.botId, spaceId: actor.spaceId },
        select: { name: true, description: true },
      });
      if (!bot) throw new IsolationError();
      const target = await resolveVoiceTarget(deps, actor, { botId: input.botId });
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
            }),
            history,
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
        userId: actor.userId,
        botId: input.botId,
        link,
        controller,
        backlog: [],
        wake: null,
        ended: false,
      };
      calls.set(key, call);
      const deadline = setTimeout(() => void link.close(), MAX_CONVERSATION_MS);
      controller.signal.addEventListener("abort", () => clearTimeout(deadline), { once: true });
      void follow(key, call);
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
        say?: { text: string; handoffId?: string };
        listening?: boolean;
      },
    ) {
      const call = own(actor, input.botId, input.callId);
      if (input.listening !== undefined) call.link.setListening(input.listening);
      if (input.say) call.link.say(conversationResult(input.say.text), input.say.handoffId);
    },

    /** Closes the caller's conversation, if this process holds one. */
    async end(actor: Pick<Actor, "userId">, callId: string) {
      const key = keyOf(actor, callId);
      const call = calls.get(key);
      if (!call) return;
      await call.link.close().catch(() => undefined);
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
