import { ORPCError } from "@orpc/server";
import { createLiveMediaProvider, parseModelSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { RouterDeps } from "./router.js";

/** Read-only discovery for call settings; it does not turn calls on or change text models. */
export async function listLiveModels(
  deps: Pick<RouterDeps, "prisma" | "secrets">,
  actor: Pick<Actor, "userId">,
  credentialId: string,
  signal?: AbortSignal,
) {
  const target = await loadLiveMediaConnection(deps, actor, credentialId);
  if (!target) return [];
  const { provider, apiKey } = target;
  try {
    return await provider.listModels(apiKey, signal);
  } catch {
    throw new ORPCError("BAD_GATEWAY", { message: "Could not load live call models." });
  }
}

/** Internal only: neither the credential nor this result may be serialized to clients. */
export async function loadLiveMediaConnection(
  deps: Pick<RouterDeps, "prisma" | "secrets">,
  actor: Pick<Actor, "userId">,
  credentialId: string,
) {
  const credential = await deps.prisma.userModelCredential.findFirst({
    where: { id: credentialId, userId: actor.userId },
  });
  if (!credential) throw new ORPCError("NOT_FOUND");
  const provider = await createLiveMediaProvider(credential.provider);
  if (!provider) return null;
  const secret = await deps.prisma.secret.findFirst({
    where: { id: credential.secretId, userId: actor.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!secret) throw new ORPCError("NOT_FOUND");
  const auth = parseModelSecret(await deps.secrets.load(secret.ciphertext, secret.id));
  // Subscription sign-ins cannot silently be reused as metered API credentials.
  if (auth.kind !== "api_key") return null;
  return { provider, apiKey: auth.key };
}
