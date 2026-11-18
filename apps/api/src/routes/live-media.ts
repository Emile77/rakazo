import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { spokenDecision } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { openConfiguredLiveCall } from "../configured-live-call.js";
import { createLiveMediaSessions } from "../live-media-sessions.js";
import { listLiveModels } from "../live-model-settings.js";
import { resolveThreadTarget } from "../thread-target.js";
import type { RouterContext } from "./context.js";

const ROLE = "live-media";
/** Uses the same account-wide purpose/connection preference table as ordinary model roles. */
export function liveMediaRoutes(
  ctx: RouterContext,
  send: (
    actor: Actor,
    input: { botId: string; text: string; clientNonce: string },
  ) => Promise<unknown>,
) {
  const { deps, authed } = ctx;
  const sessions = createLiveMediaSessions();
  const settings = async (actor: Actor) => {
    const row = await deps.prisma.userModelRoleChoice.findUnique({
      where: { userId_role_position: { userId: actor.userId, role: ROLE, position: 0 } },
    });
    return row?.credentialId ? { credentialId: row.credentialId, model: row.modelId } : null;
  };
  const authorize = async (actor: Actor, botId: string) => {
    if (!deps.env.voiceLiveCalls) throw new ORPCError("PRECONDITION_FAILED");
    const target = await resolveThreadTarget(deps.prisma, actor, { botId });
    if (target.kind !== "bot") throw new ORPCError("NOT_FOUND");
    return target;
  };
  return {
    liveMedia: {
      clear: authed.liveMedia.clear.handler(async ({ context }) => {
        await deps.prisma.userModelRoleChoice.deleteMany({
          where: { userId: context.actor.userId, role: ROLE },
        });
        return { ok: true as const };
      }),
      settings: authed.liveMedia.settings.handler(({ context }) => settings(context.actor)),
      select: authed.liveMedia.select.handler(async ({ context, input }) => {
        const models = await listLiveModels(deps, context.actor, input.credentialId);
        if (
          !models.some(
            (model) =>
              model.id === input.model &&
              model.capabilities?.audioInput &&
              model.capabilities.audioOutput &&
              model.capabilities.toolCalls,
          )
        )
          throw new ORPCError("BAD_REQUEST");
        const credential = await deps.prisma.userModelCredential.findFirst({
          where: { id: input.credentialId, userId: context.actor.userId },
        });
        if (!credential) throw new ORPCError("NOT_FOUND");
        const data = {
          credentialId: credential.id,
          provider: credential.provider,
          modelId: input.model,
        };
        await deps.prisma.userModelRoleChoice.upsert({
          where: {
            userId_role_position: { userId: context.actor.userId, role: ROLE, position: 0 },
          },
          create: { userId: context.actor.userId, role: ROLE, position: 0, ...data },
          update: data,
        });
        return { ok: true as const };
      }),
      connect: authed.liveMedia.connect.handler(async ({ context, input }) => {
        const actor = context.actor;
        const target = await authorize(actor, input.botId);
        const selection = await settings(actor);
        if (!selection) throw new ORPCError("PRECONDITION_FAILED");
        const nonce = randomUUID();
        return sessions.connect(
          actor,
          input.botId,
          input.callId,
          (signal, onEvent) =>
            openConfiguredLiveCall(
              deps,
              actor,
              {
                ...selection,
                ...input,
                threadId: target.threadId,
              },
              {
                enabled: true,
                signal,
                onEvent,
                instructions:
                  "You are the voice interface to this bot. Converse briefly. Delegate every request requiring actions, tools, or private knowledge to delegate_request. Never claim that queued work has finished. The ordinary bot replies in the thread and handles permissions and approvals. Do not invent results.",
                tools: {
                  declarations: [
                    {
                      name: "delegate_request",
                      description:
                        "Queue the user's request for the bot, with normal permissions and approvals.",
                      parameters: {
                        type: "object",
                        properties: { request: { type: "string" } },
                        required: ["request"],
                        additionalProperties: false,
                      },
                    },
                  ],
                  execute: async (call, scope, signal) => {
                    const request = call.args.request;
                    if (
                      signal.aborted ||
                      typeof request !== "string" ||
                      !request.trim() ||
                      request.length > 20_000
                    )
                      throw new ORPCError("BAD_REQUEST");
                    if (spokenDecision(request))
                      return {
                        queued: false,
                        message:
                          "Approval decisions are handled by the call approval card, not delegated as new requests.",
                      };
                    await send(actor, {
                      botId: scope.botId,
                      text: request,
                      clientNonce: `call:${scope.callId}:delegate-${nonce}-${call.id}`,
                    });
                    return {
                      queued: true,
                      message:
                        "The bot will reply in the thread; approvals remain in the ordinary workflow.",
                    };
                  },
                },
              },
            ),
          async (event, seq) => {
            if (!event.text.trim()) return;
            if (event.text.length > 100_000) throw new Error("Transcript too large");
            const eventSeq = await withTransactionRetry(() =>
              deps.prisma.$transaction(async (tx) => {
                const blocks = [{ kind: "text" as const, text: event.text }];
                const message = await createThreadMessageInTransaction(tx, {
                  threadId: target.threadId,
                  role: event.role,
                  ...(event.role === "bot"
                    ? { botId: target.botId }
                    : { authorUserId: actor.userId }),
                  blocks,
                  markUnread: false,
                  clientNonce: `call:${input.callId}:live-${nonce}-${seq}`,
                });
                const saved = await appendEventInTransaction(tx, {
                  spaceId: actor.spaceId,
                  threadId: target.threadId,
                  botId: target.botId,
                  type: "thread.message.created",
                  payload: {
                    messageId: message.id,
                    role: event.role,
                    blocks,
                    callId: input.callId,
                  },
                });
                return saved.seq;
              }, THREAD_LOCK_TRANSACTION_OPTIONS),
            );
            await deps.events.notify(target.threadId, eventSeq);
          },
        );
      }),
      events: authed.liveMedia.events.handler(async ({ context, input }) => {
        await authorize(context.actor, input.botId);
        return sessions.events(context.actor, input.botId, input.sessionId, input.cursor);
      }),
      input: authed.liveMedia.input.handler(async ({ context, input }) => {
        await authorize(context.actor, input.botId);
        sessions.input(context.actor, input.botId, input.sessionId, input.input);
        return { ok: true as const };
      }),
      end: authed.liveMedia.end.handler(async ({ context, input }) => {
        await authorize(context.actor, input.botId);
        await sessions.end(context.actor, input.botId, input.sessionId);
        return { ok: true as const };
      }),
    },
  };
}
