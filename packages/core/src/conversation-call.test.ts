import { describe, expect, it } from "vitest";
import {
  conversationCallInstructions,
  conversationHistory,
  conversationResult,
  createConversationTranscript,
  isWorkPromise,
} from "./conversation-call.js";

describe("conversationCallInstructions", () => {
  it("names the bot and states the delegation policy", () => {
    const text = conversationCallInstructions({
      botName: "Ada",
      botDescription: "Helps with daily tasks.",
      timeZone: "America/Toronto",
      now: new Date("2026-01-02T15:00:00Z"),
    });
    expect(text).toContain(
      "You are Ada, on a live voice call with your user. Helps with daily tasks.",
    );
    expect(text).toContain("Generate when:");
    expect(text).toContain("Never announce a result");
    expect(text).toContain("10:00");
  });
});

describe("conversationHistory", () => {
  it("keeps the newest non-empty lines, trimmed", () => {
    const lines = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? ("bot" as const) : ("user" as const),
      text: ` line ${index} `,
    }));
    const history = conversationHistory([...lines, { role: "bot", text: "  " }], 3);
    expect(history).toEqual([
      { role: "bot", text: "line 17" },
      { role: "user", text: "line 18" },
      { role: "bot", text: "line 19" },
    ]);
  });
});

describe("createConversationTranscript", () => {
  it("joins fragments into lines and claims only the user's newest request", () => {
    const transcript = createConversationTranscript();
    transcript.hear("user", "Hi, ");
    transcript.hear("user", "how are you?");
    transcript.hear("bot", "Fine, thanks.");
    transcript.hear("user", "How much disk is left?");
    expect(transcript.claimRequest()).toBe("Hi, how are you? How much disk is left?");
    transcript.hear("bot", "OK, I'm checking.");
    transcript.hear("user", "Actually, the memory.");
    expect(transcript.claimRequest()).toBe("Actually, the memory.");
  });

  it("falls back to the newest user line when a handoff arrives before new words", () => {
    const transcript = createConversationTranscript();
    transcript.hear("user", "Check the backups.");
    expect(transcript.claimRequest()).toBe("Check the backups.");
    transcript.hear("bot", "Checking.");
    expect(transcript.claimRequest()).toBe("Check the backups.");
  });

  it("spots a promise of work that no handoff claimed", () => {
    const transcript = createConversationTranscript();
    transcript.hear("user", "Combien d'espace reste-t-il?");
    transcript.hear("bot", "OK, je regarde ça.");
    expect(transcript.promisedWork()).toBe(true);
    transcript.claimRequest();
    expect(transcript.promisedWork()).toBe(false);
  });

  it("does not take small talk for a promise", () => {
    const transcript = createConversationTranscript();
    transcript.hear("user", "Salut!");
    transcript.hear("bot", "Salut, ça va bien.");
    expect(transcript.promisedWork()).toBe(false);
  });
});

describe("isWorkPromise", () => {
  it.each([
    ["Je vérifie tout de suite.", true],
    ["Je vais regarder l'état du nœud.", true],
    ["Let me check that.", true],
    ["I'm on it.", true],
    ["The disk has 1.5 TB free.", false],
    ["Bonne question.", false],
  ])("%s", (text, expected) => {
    expect(isWorkPromise(text)).toBe(expected);
  });
});

describe("conversationResult", () => {
  it("frames the reply so the talker relays it without adding facts", () => {
    expect(conversationResult(" 1.5 TB free. ")).toBe(
      "The bot finished. Relay its reply in its meaning, adding nothing it does not say:\n1.5 TB free.",
    );
  });
});
