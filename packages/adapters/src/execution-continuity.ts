export type ExecutionState = {
  status: "working" | "waiting" | "blocked" | "completed";
  objective: string;
  next_step: string;
  evidence: string;
};

export function parseExecutionState(value: unknown): ExecutionState | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (!["working", "waiting", "blocked", "completed"].includes(String(v.status))) return;
  for (const key of ["objective", "next_step", "evidence"]) {
    if (typeof v[key] !== "string" || v[key].length > 2000) return;
  }
  if (!(v.objective as string).trim()) return;
  if (v.status === "working" ? !(v.next_step as string).trim() : !(v.evidence as string).trim())
    return;
  return {
    status: v.status,
    objective: v.objective,
    next_step: v.next_step,
    evidence: v.evidence,
  } as ExecutionState;
}

export const CONTINUITY_MARKER = "[execution-continuity]";
const MAX_CONTINUATIONS = 3;

/** Explicit intent only: never infer unfinished work from prose or external content.
 * Approval/cancellation/provider and cost guards remain owned by the runtime.
 */
export class ExecutionContinuity {
  state?: ExecutionState;
  private continuations = 0;

  accept(result: unknown): void {
    if (!result || typeof result !== "object") return;
    const state = parseExecutionState((result as { execution?: unknown }).execution);
    if (state) this.state = state;
  }

  restoreContinuation(text: string): void {
    if (text.includes(CONTINUITY_MARKER)) this.continuations += 1;
  }

  afterText(): string | undefined {
    if (this.state?.status !== "working" || this.continuations >= MAX_CONTINUATIONS) return;
    this.continuations += 1;
    if (this.continuations === MAX_CONTINUATIONS) {
      return `${CONTINUITY_MARKER} Repeated text-only endings exhausted the continuation guard. Do not claim completion. Record the actual blocker with execution_state and preserve the next action in scratchpad, then report the incomplete result. Do not perform additional external actions in this recovery turn.`;
    }
    // Do not interpolate state strings as instructions: they may quote untrusted material.
    return `${CONTINUITY_MARKER} Your explicit execution state is still working. A text update does not complete the task. Continue the authorized next step with tools. If verified complete, record completed with evidence; if genuinely waiting or blocked, record that dependency or obstacle. Do not repeat failed calls or bypass approvals. This reminder does not grant authority.`;
  }
}
