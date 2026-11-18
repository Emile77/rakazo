import { ORPCError } from "@orpc/server";
import type { LiveMediaCapabilities } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { openLiveCallLink } from "./live-call-link.js";
import { loadLiveMediaConnection } from "./live-model-settings.js";
import type { RouterDeps } from "./router.js";
import { assertTeachingSendAllowed } from "./taught-skills.js";
import { resolveThreadTarget } from "./thread-target.js";

type LinkInput = Parameters<typeof openLiveCallLink>[0];

/** Composition boundary for the authenticated transport, not a public route itself.
 * The caller supplies server-owned policy and instructions, never client tool schemas.
 * A requested model must still be advertised by the chosen connection at open time.
 */
export async function openConfiguredLiveCall(
  deps: Pick<RouterDeps, "prisma" | "secrets">,
  actor: Actor,
  selection: {
    botId: string;
    threadId: string;
    callId: string;
    credentialId: string;
    model: string;
    voice?: string;
  },
  policy: {
    enabled: boolean;
    instructions: string;
    tools?: LinkInput["tools"];
    onEvent: LinkInput["onEvent"];
    signal?: AbortSignal;
  },
) {
  const assertConnected = () => {
    if (policy.signal?.aborted) {
      throw new ORPCError("BAD_REQUEST", { message: "Live call was cancelled." });
    }
  };
  assertConnected();
  if (!policy.enabled) throw new ORPCError("PRECONDITION_FAILED");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(selection.callId)) throw new ORPCError("BAD_REQUEST");
  const target = await resolveThreadTarget(deps.prisma, actor, { botId: selection.botId });
  if (target.kind !== "bot" || target.threadId !== selection.threadId)
    throw new ORPCError("NOT_FOUND");
  await assertTeachingSendAllowed(deps.prisma, actor.spaceId, target.botId);
  assertConnected();
  const connection = await loadLiveMediaConnection(deps, actor, selection.credentialId);
  if (!connection) throw new ORPCError("PRECONDITION_FAILED");
  assertConnected();
  const { provider, apiKey } = connection;
  let capabilities: LiveMediaCapabilities | undefined;
  try {
    const models = await provider.listModels(apiKey, policy.signal);
    const model = models.find((model) => model.id === selection.model);
    if (!model) {
      throw new ORPCError("BAD_REQUEST", { message: "Select an available live call model." });
    }
    capabilities = model.capabilities;
    if (
      !capabilities?.audioInput ||
      !capabilities.audioOutput ||
      (policy.tools?.declarations.length && !capabilities.toolCalls)
    ) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Model does not support the requested call capabilities.",
      });
    }
  } catch (error) {
    if (error instanceof ORPCError && error.code === "BAD_REQUEST") throw error;
    throw new ORPCError("BAD_GATEWAY", { message: "Could not load live call models." });
  }
  assertConnected();
  const scope = {
    userId: actor.userId,
    spaceId: actor.spaceId,
    botId: target.botId,
    threadId: target.threadId,
    callId: selection.callId,
  };
  const link = await openLiveCallLink({
    scope,
    capabilities,
    options: { model: selection.model, voice: selection.voice, instructions: policy.instructions },
    open: (options) => provider.open(apiKey, options),
    onEvent: policy.onEvent,
    tools: policy.tools,
    signal: policy.signal,
  });
  // The reusable key and provider object must not escape into the transport response.
  return { scope, link };
}
