import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { CallActivityThread } from "./call-activity.js";
import { createCallActivity } from "./call-activity.js";
import { createConversationTranscript } from "./conversation-call.js";

const approval = {
  kind: "ask",
  text: "Save a note to memory?",
  detail: "Next Rakazo version: show an approval card with the exact change.",
  approvalEffectId: "effect-1",
  actions: [
    { id: "allow", label: "Approve" },
    { id: "deny", label: "Deny" },
  ],
} as MessageBlock;

const text = (value: string) => ({ kind: "text", text: value }) as MessageBlock;

function thread(
  messages: CallActivityThread["messages"],
  run: CallActivityThread["run"] = null,
): CallActivityThread {
  return { run, messages };
}

describe("createCallActivity", () => {
  it("tells a card already waiting when the call connects, in full, and nothing older", () => {
    const activity = createCallActivity();
    activity.start(
      thread(
        [
          { id: "old", role: "bot", blocks: [text("Yesterday's answer.")] },
          { id: "card", role: "bot", runId: "run-1", blocks: [approval] },
        ],
        { id: "run-1", status: "waiting_input" },
      ),
    );
    const notes = activity.notes(
      thread(
        [
          { id: "old", role: "bot", blocks: [text("Yesterday's answer.")] },
          { id: "card", role: "bot", runId: "run-1", blocks: [approval] },
        ],
        { id: "run-1", status: "waiting_input" },
      ),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(
      "an approval card is waiting on screen. It asks: Save a note to memory?",
    );
    expect(notes[0]).toContain("Its details: Next Rakazo version");
    expect(notes[0]).toContain("approve or deny it out loud");
  });

  it("waits for the chat when the call starts before it loads", () => {
    const activity = createCallActivity();
    activity.start(null);
    const loaded = thread([{ id: "old", role: "bot", blocks: [text("Before the call.")] }]);
    expect(activity.notes(loaded)).toEqual([]);
  });

  it("notes finished messages, steps, typed messages and errors once, but not the call's own turns or spoken replies", () => {
    const activity = createCallActivity();
    activity.start(thread([]));
    const steps = {
      kind: "steps",
      steps: [{ label: "Search history", count: 2, outcomes: { failed: 1 } }],
    } as MessageBlock;
    const working = thread(
      [{ id: "reply", role: "bot", runId: "run-2", blocks: [steps, text("Half")] }],
      { id: "run-2", status: "running" },
    );
    // Still being written: not yet.
    expect(activity.notes(working)).toEqual([]);
    const done = thread(
      [
        { id: "turn", role: "user", callId: "call-1", blocks: [text("Check it")] },
        { id: "typed", role: "user", blocks: [text("Also the NUC")] },
        { id: "reply", role: "bot", runId: "run-2", blocks: [steps, text("Found it.")] },
        { id: "spoken", role: "bot", runId: "run-3", blocks: [text("Said by voice.")] },
      ],
      { id: "run-2", status: "failed", error: "Tool crashed" },
    );
    const notes = activity.notes(done, { callId: "call-1", skip: new Set(["spoken"]) });
    expect(notes).toEqual([
      "Call activity: The user wrote in the chat: Also the NUC",
      "Call activity: Steps it took: Search history (2 times), 1 failed. The bot wrote in the chat: Found it.",
      "Call activity: the bot's work stopped with an error: Tool crashed",
    ]);
    expect(activity.notes(done, { callId: "call-1", skip: new Set(["spoken"]) })).toEqual([]);
  });
});

describe("conversation transcript release", () => {
  it("gives back a handoff the bot never took, so the chat keeps those words", () => {
    const transcript = createConversationTranscript();
    transcript.hear("user", "What does that card do?");
    expect(transcript.claimRequest()).toBe("What does that card do?");
    transcript.hear("bot", "Let me check.");
    expect(transcript.release()).toEqual([]);
    expect(transcript.takeSmallTalk({ final: true })).toEqual([
      { role: "user", text: "What does that card do?" },
      { role: "bot", text: "Let me check." },
    ]);
  });

  it("returns lines already past the kept mark for the chat to write at once", () => {
    const transcript = createConversationTranscript();
    transcript.hear("user", "Approve, I guess? Wait.");
    transcript.claimRequest();
    transcript.hear("bot", "OK.");
    transcript.hear("user", "Hello?");
    // The chat took the settled lines, leaving out the claimed request.
    expect(transcript.takeSmallTalk()).toEqual([]);
    expect(transcript.release()).toEqual([
      { role: "user", text: "Approve, I guess? Wait." },
      { role: "bot", text: "OK." },
    ]);
  });
});
