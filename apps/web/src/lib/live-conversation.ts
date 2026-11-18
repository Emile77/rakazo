import { decodeLivePcm, encodeLivePcm, livePcmRate } from "@rakazo/core";
import type { ConversationAudio, ConversationInput } from "./conversation-call.js";
import { rpc } from "./rpc.js";

/** Authenticated PCM transport. Input is never retried: it is not idempotent. */
export async function startLiveConversation(
  input: ConversationInput,
  imageInput = false,
): Promise<ConversationAudio> {
  const { botId, callId, signal } = input;
  const context = new AudioContext();
  const sources = new Set<AudioBufferSourceNode>();
  let microphone: MediaStream | undefined;
  let processor: ScriptProcessorNode | undefined;
  let sessionId: string | undefined;
  let stopped = false;
  let muted = false;
  let pending = false;
  const audioQueue: Uint8Array[] = [];
  let queuedBytes = 0;
  let sendingBytes = 0;
  // 16 kHz, mono, 16-bit PCM; include the in-flight frame in the bound.
  const maxAudioBytes = 16000 * 2 * 2;
  const clearAudioQueue = () => {
    audioQueue.length = 0;
    queuedBytes = 0;
  };
  let reconnecting = false;
  let reconnects = 0;
  let nextAudio = 0;
  let cursor = 0;
  let userText = "";
  let visual: MediaStream | undefined;
  let frameTimer: ReturnType<typeof setInterval> | undefined;
  const stopVisual = () => {
    clearInterval(frameTimer);
    for (const track of visual?.getTracks() ?? []) track.stop();
    visual = undefined;
    input.onVisual?.(null);
  };
  const shareVisual = async (kind: "camera" | "screen" | null) => {
    stopVisual();
    if (!kind || stopped) return;
    const stream =
      kind === "camera"
        ? await navigator.mediaDevices.getUserMedia({ video: { width: 640 }, audio: false })
        : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    if (stopped) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    visual = stream;
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (error) {
      stopVisual();
      throw error;
    }
    const canvas = document.createElement("canvas");
    let sending = false;
    frameTimer = setInterval(() => {
      if (
        stopped ||
        reconnecting ||
        muted ||
        sending ||
        visual !== stream ||
        !sessionId ||
        !video.videoWidth
      )
        return;
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      sending = true;
      const sentSession = sessionId;
      void rpc.liveMedia
        .input(
          {
            botId,
            sessionId,
            input: {
              type: "frame",
              data: canvas.toDataURL("image/jpeg", 0.65).split(",")[1]!,
              mimeType: "image/jpeg",
            },
          },
          { signal },
        )
        .catch((error) => {
          if (reconnecting || stopped || sentSession !== sessionId) return;
          stopVisual();
          input.onLost(error);
        })
        .finally(() => {
          sending = false;
        });
    }, 1000);
    input.onVisual?.(kind);
    stream.getVideoTracks()[0]?.addEventListener("ended", stopVisual, { once: true });
  };
  const stopPlayback = () => {
    for (const source of sources) source.stop();
    sources.clear();
    nextAudio = 0;
    input.onSpeaking(false);
  };
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearAudioQueue();
    stopPlayback();
    stopVisual();
    processor?.disconnect();
    for (const track of microphone?.getTracks() ?? []) track.stop();
    void context.close().catch(() => undefined);
    if (sessionId) void rpc.liveMedia.end({ botId, sessionId }).catch(() => undefined);
    signal.removeEventListener("abort", close);
  };
  const sendText = async (text: string) => {
    if (!sessionId || stopped || reconnecting) return;
    await rpc.liveMedia.input({ botId, sessionId, input: { type: "text", text } }, { signal });
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    if (signal.aborted) throw new Error("Call cancelled");
    microphone = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (stopped) {
      for (const track of microphone.getTracks()) track.stop();
      throw new Error("Call cancelled");
    }
    const connected = await rpc.liveMedia.connect({ botId, callId }, { signal });
    sessionId = connected.sessionId;
    if (stopped) {
      void rpc.liveMedia.end({ botId, sessionId }).catch(() => undefined);
      throw new Error("Call cancelled");
    }
    await context.resume();
    processor = context.createScriptProcessor(4096, 1, 1);
    context.createMediaStreamSource(microphone).connect(processor);
    processor.connect(context.destination);
    const drainAudio = () => {
      if (stopped || reconnecting || muted || pending || !sessionId) return;
      const bytes = audioQueue.shift();
      if (!bytes) return;
      queuedBytes -= bytes.length;
      sendingBytes = bytes.length;
      const data = btoa(String.fromCharCode(...bytes));
      pending = true;
      const sentSession = sessionId;
      void rpc.liveMedia
        .input({ botId, sessionId, input: { type: "audio", data } }, { signal })
        .catch((error) => {
          if (!stopped && !reconnecting && sentSession === sessionId) {
            close();
            input.onLost(error);
          }
        })
        .finally(() => {
          pending = false;
          sendingBytes = 0;
          drainAudio();
        });
    };
    processor.onaudioprocess = (event) => {
      if (stopped || reconnecting || muted || !sessionId) return;
      const bytes = encodeLivePcm(event.inputBuffer.getChannelData(0), context.sampleRate);
      if (queuedBytes + sendingBytes + bytes.length > maxAudioBytes) {
        close();
        input.onLost(new Error("Live microphone audio overflow"));
        return;
      }
      audioQueue.push(bytes);
      queuedBytes += bytes.length;
      drainAudio();
    };
    void (async () => {
      let failures = 0;
      try {
        while (!stopped && sessionId) {
          let batch: Awaited<ReturnType<typeof rpc.liveMedia.events>>;
          try {
            batch = await rpc.liveMedia.events(
              { botId, sessionId, cursor },
              { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) },
            );
            failures = 0;
          } catch (error) {
            if (stopped) return;
            if (++failures >= 3) throw error;
            await new Promise((resolve) => setTimeout(resolve, failures * 400));
            continue;
          }
          cursor = batch.cursor;
          let renewed = false;
          for (const { event } of batch.events) {
            if (stopped) break;
            if (event.type === "audio") {
              const samples = decodeLivePcm(
                Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0)),
              );
              const buffer = context.createBuffer(1, samples.length, livePcmRate(event.mimeType));
              buffer.getChannelData(0).set(samples);
              const source = context.createBufferSource();
              source.buffer = buffer;
              source.connect(context.destination);
              nextAudio = Math.max(context.currentTime, nextAudio);
              if (nextAudio - context.currentTime > 15) throw new Error("Live audio overflow");
              sources.add(source);
              source.onended = () => {
                sources.delete(source);
                if (!sources.size) input.onSpeaking(false);
              };
              source.start(nextAudio);
              nextAudio += buffer.duration;
              input.onSpeaking(true);
            } else if (event.type === "transcript") {
              input.onEvent({ type: "caption", role: event.role, text: event.text });
              if (event.role === "user") {
                userText += event.text;
                if (userText.length > 20000) throw new Error("Live transcript overflow");
              }
            } else if (event.type === "turn-complete") {
              if (userText.trim()) input.onUserTranscript?.(userText);
              userText = "";
            } else if (event.type === "interrupted") stopPlayback();
            else if (event.type === "reconnect-needed") {
              if (++reconnects > 2) throw new Error("Live call reconnect limit");
              reconnecting = true;
              clearAudioQueue();
              stopPlayback();
              userText = "";
              // Close first; never replay non-idempotent input or delegated actions.
              const reconnectSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
              await rpc.liveMedia.end({ botId, sessionId }, { signal: reconnectSignal });
              if (stopped) return;
              const next = await rpc.liveMedia.connect(
                { botId, callId },
                { signal: reconnectSignal },
              );
              sessionId = next.sessionId;
              if (stopped) {
                void rpc.liveMedia.end({ botId, sessionId }).catch(() => undefined);
                return;
              }
              cursor = 0;
              reconnecting = false;
              renewed = true;
              break;
            } else if (event.type === "closed") throw new Error("Live call closed");
          }
          if (renewed) continue;
          if (batch.closed) throw new Error("Live call closed");
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      } catch (error) {
        if (!stopped) {
          close();
          input.onLost(error);
        }
      }
    })();
    return {
      setMuted(value) {
        muted = value;
        if (value) clearAudioQueue();
        for (const track of microphone?.getAudioTracks() ?? []) track.enabled = !value;
      },
      close,
      sendText,
      ...(imageInput ? { shareVisual } : {}),
    };
  } catch (error) {
    close();
    throw error;
  }
}
