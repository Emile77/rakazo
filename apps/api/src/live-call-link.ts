import { ORPCError } from "@orpc/server";
import type { LiveMediaEvent, LiveMediaOptions, LiveMediaSession } from "@rakazo/adapter-kit";

/** Only server-validated scope and configuration may reach this boundary. */
export interface LiveCallScope {
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  callId: string;
}

type ClientEvent = Exclude<LiveMediaEvent, { type: "tool-call" } | { type: "tool-cancelled" }>;
type ToolCall = Extract<LiveMediaEvent, { type: "tool-call" }>;

/**
 * A bounded, process-owned media link. The route must authorize the thread and load
 * credentials/settings before opening it. Tool calls never go to the client for execution.
 * The executor must use the ordinary server tool/approval path, not trust model arguments.
 */
export async function openLiveCallLink(input: {
  scope: LiveCallScope;
  options: Omit<LiveMediaOptions, "onEvent" | "signal" | "tools">;
  open(options: LiveMediaOptions): Promise<LiveMediaSession>;
  onEvent(event: ClientEvent): void;
  tools?: {
    declarations: NonNullable<LiveMediaOptions["tools"]>;
    execute(
      call: ToolCall,
      scope: LiveCallScope,
      signal: AbortSignal,
    ): Promise<Record<string, unknown>>;
  };
  signal?: AbortSignal;
  capabilities?: { audioInput: boolean; imageInput: boolean };
}) {
  const controller = new AbortController();
  const pending = new Map<string, AbortController>();
  const seen = new Set<string>();
  const scope = Object.freeze({ ...input.scope });
  let session: LiveMediaSession | undefined;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", finish);
    controller.abort();
    for (const task of pending.values()) task.abort();
    pending.clear();
    session?.close();
  };
  const timer = setTimeout(finish, 2 * 60 * 60 * 1000);
  input.signal?.addEventListener("abort", finish, { once: true });
  const allowed = new Set(input.tools?.declarations.map((tool) => tool.name));
  const handleTool = async (event: ToolCall) => {
    // Duplicate IDs, unknown tools and flooding are protocol failures, not authorization.
    if (
      !session ||
      !input.tools ||
      !allowed.has(event.name) ||
      seen.has(event.id) ||
      pending.size >= 4 ||
      seen.size >= 256
    ) {
      finish();
      return;
    }
    seen.add(event.id);
    const task = new AbortController();
    pending.set(event.id, task);
    try {
      let result: Record<string, unknown>;
      try {
        result = await input.tools.execute(event, scope, task.signal);
      } catch {
        result = { error: "Tool request could not be completed." };
      }
      if (!ended && !task.signal.aborted) session.toolResult(event.id, result);
    } catch {
      finish();
    } finally {
      pending.delete(event.id);
    }
  };
  const onEvent = (event: LiveMediaEvent) => {
    if (ended) return;
    if (event.type === "tool-call") {
      void handleTool(event);
    } else if (event.type === "tool-cancelled") {
      for (const id of event.ids) pending.get(id)?.abort();
    } else {
      try {
        input.onEvent(event);
      } finally {
        if (event.type === "closed") finish();
      }
    }
  };
  try {
    if (input.signal?.aborted) throw new Error("aborted");
    session = await input.open({
      ...input.options,
      ...(input.tools ? { tools: input.tools.declarations } : {}),
      signal: controller.signal,
      onEvent,
    });
    if (ended) {
      session.close();
      throw new Error("closed");
    }
  } catch {
    finish();
    throw new ORPCError("BAD_GATEWAY", { message: "Could not open live call." });
  }
  const connected = session;
  const own = (candidate: LiveCallScope) => {
    if (
      Object.keys(scope).some(
        (key) => scope[key as keyof LiveCallScope] !== candidate[key as keyof LiveCallScope],
      )
    ) {
      throw new ORPCError("NOT_FOUND");
    }
    if (ended) throw new ORPCError("NOT_FOUND");
  };
  return {
    audio(candidate: LiveCallScope, data: string) {
      own(candidate);
      if (!input.capabilities?.audioInput) throw new ORPCError("PRECONDITION_FAILED");
      connected.sendAudio(data);
    },
    frame(candidate: LiveCallScope, data: string, mimeType: "image/jpeg" | "image/png") {
      own(candidate);
      if (!input.capabilities?.imageInput) throw new ORPCError("PRECONDITION_FAILED");
      connected.sendFrame(data, mimeType);
    },
    text(candidate: LiveCallScope, text: string) {
      own(candidate);
      connected.sendText(text);
    },
    close(candidate: LiveCallScope) {
      own(candidate);
      finish();
    },
  };
}
