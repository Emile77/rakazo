import type { ConversationCallEvent } from "@rakazo/contracts";
import { rpc } from "./rpc.js";

/** Output level above which the voice counts as speaking. */
const SPEAKING_LEVEL = 0.02;
const LEVEL_POLL_MS = 120;
/** Pauses between words shorter than this keep the voice speaking. */
const SPEAKING_HANGOVER_MS = 600;

/**
 * The device side of a conversation call: microphone and playback over WebRTC with the
 * voice the API set up, plus the API's event feed. The API owns the provider; this only
 * carries audio and reports what it hears.
 */
export interface ConversationAudio {
  setMuted(muted: boolean): void;
  close(): void;
}

export async function startConversation(input: {
  botId: string;
  callId: string;
  signal: AbortSignal;
  onEvent: (event: ConversationCallEvent) => void;
  onSpeaking: (speaking: boolean) => void;
  /** The feed stopped without the call ending: the API lost the conversation. */
  onLost: (error: unknown) => void;
}): Promise<ConversationAudio> {
  const { botId, callId, signal } = input;
  const microphone = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const peer = new RTCPeerConnection();
  const playback = new Audio();
  playback.autoplay = true;
  let levels: { context: AudioContext; timer: ReturnType<typeof setInterval> } | null = null;
  const close = () => {
    if (levels) {
      clearInterval(levels.timer);
      void levels.context.close().catch(() => undefined);
      levels = null;
    }
    for (const track of microphone.getTracks()) track.stop();
    peer.close();
    playback.srcObject = null;
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    for (const track of microphone.getTracks()) peer.addTrack(track, microphone);
    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      playback.srcObject = stream;
      void playback.play().catch(() => undefined);
      levels = watchLevel(stream, input.onSpeaking);
    };
    await peer.setLocalDescription(await peer.createOffer());
    const offerSdp = peer.localDescription?.sdp;
    if (!offerSdp) throw new Error("No audio offer.");
    const { answerSdp } = await rpc.threads.connectCall({ botId, callId, offerSdp }, { signal });
    await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    const feed = await rpc.threads.callEvents({ botId, callId }, { signal });
    void (async () => {
      try {
        for await (const event of feed) {
          input.onEvent(event);
          if (event.type === "ended") return;
        }
        if (!signal.aborted) input.onLost(new Error("The call's feed closed."));
      } catch (error) {
        if (!signal.aborted) input.onLost(error);
      }
    })();
  } catch (error) {
    close();
    throw error;
  }
  return {
    setMuted(muted) {
      for (const track of microphone.getAudioTracks()) track.enabled = !muted;
    },
    close,
  };
}

/** Reports when the remote voice starts and stops being audible. */
function watchLevel(stream: MediaStream, onSpeaking: (speaking: boolean) => void) {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let speaking = false;
  let loudAt = 0;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const now = Date.now();
    if (Math.sqrt(sum / samples.length) > SPEAKING_LEVEL) loudAt = now;
    const next = now - loudAt < SPEAKING_HANGOVER_MS;
    if (next === speaking) return;
    speaking = next;
    onSpeaking(speaking);
  }, LEVEL_POLL_MS);
  return { context, timer };
}
