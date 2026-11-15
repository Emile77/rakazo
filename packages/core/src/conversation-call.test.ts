import { describe, expect, it } from "vitest";
import {
  conversationCallInstructions,
  conversationGreeting,
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
    expect(text).toContain("Generate by default.");
    expect(text).toContain("even if you think you know it");
    expect(text).toContain("unless a result from the bot said so");
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

describe("conversationGreeting", () => {
  it("asks the voice to greet as the bot and ask a short question, then listen", () => {
    const text = conversationGreeting("Ada");
    expect(text).toContain("Greet the user now as Ada");
    expect(text).toContain("ask one short question");
    expect(text).toContain("Then stop and listen.");
  });
});

describe("createConversationTranscript", () => {
  it("keeps a speaker's line whole when the other speaker cuts in", () => {
    const transcript = createConversationTranscript();
    transcript.hear("user", "Change the voice.", { startMs: 0, endMs: 1_000 });
    transcript.hear("bot", "I'll ask the bot to ver", { startMs: 1_600, endMs: 2_400 });
    expect(transcript.hear("user", "Yeah", { startMs: 2_300, endMs: 2_500 })).toEqual({ line: 2 });
    expect(transcript.hear("bot", "ify.", { startMs: 2_450, endMs: 2_700 })).toEqual({ line: 1 });
    expect(transcript.lines()).toEqual([
      { role: "user", text: "Change the voice." },
      { role: "bot", text: "I'll ask the bot to verify." },
      { role: "user", text: "Yeah" },
    ]);
  });

  it("starts a new line after a real pause", () => {
    const transcript = createConversationTranscript();
    transcript.hear("bot", "Hello.", { startMs: 0, endMs: 500 });
    transcript.hear("user", "Hi.", { startMs: 900, endMs: 1_200 });
    expect(transcript.hear("bot", "How can I help?", { startMs: 2_000, endMs: 2_800 })).toEqual({
      line: 2,
    });
  });

  it("never extends a user line a handoff already claimed", () => {
    const transcript = createConversationTranscript();
    transcript.hear("user", "Check the disk.", { startMs: 0, endMs: 1_000 });
    transcript.claimRequest();
    transcript.hear("bot", "Checking.", { startMs: 1_100, endMs: 1_500 });
    expect(transcript.hear("user", "And memory.", { startMs: 1_400, endMs: 2_000 })).toEqual({
      line: 2,
    });
    expect(transcript.claimRequest()).toBe("And memory.");
  });

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

  it("gives the chat only small talk, once, and keeps it out of later requests", () => {
    const transcript = createConversationTranscript();
    transcript.hear("user", "Salut!");
    transcript.hear("bot", "Salut, ça va?");
    transcript.hear("user", "Check");
    expect(transcript.takeSmallTalk()).toEqual([
      { role: "user", text: "Salut!" },
      { role: "bot", text: "Salut, ça va?" },
    ]);
    expect(transcript.takeSmallTalk()).toEqual([]);
    transcript.hear("user", " the disk.");
    expect(transcript.claimRequest()).toBe("Check the disk.");
    transcript.hear("bot", "Je regarde.");
    transcript.relaying();
    transcript.hear("bot", "Il reste 1,5 To.");
    transcript.hear("user", "Hm?");
    transcript.hear("bot", "Je disais: 1,5 To.");
    transcript.hear("user", "Merci.");
    transcript.hear("bot", "De rien.");
    expect(transcript.takeSmallTalk({ final: true })).toEqual([
      { role: "user", text: "Hm?" },
      { role: "bot", text: "Je disais: 1,5 To." },
      { role: "user", text: "Merci." },
      { role: "bot", text: "De rien." },
    ]);
  });

  it("counts a late handoff's spoken promise as its acknowledgement", () => {
    const transcript = createConversationTranscript();
    transcript.hear("user", "Check the backups.");
    transcript.hear("bot", "OK, let me check.");
    expect(transcript.claimRequest()).toBe("Check the backups.");
    expect(transcript.takeSmallTalk({ final: true })).toEqual([]);
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
