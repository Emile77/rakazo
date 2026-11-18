# Native live-media feasibility

Status: **blocked for full-duplex live transport; not integrated**. Mobile still
uses dictation/recorded-clip transcription plus speech. That is not a live-media
fallback implementation. No live session is opened by this change.

## Installed source evidence

Inspected `expo-audio` **58.0.11**. Paths here are relative to
`apps/mobile/node_modules/expo-audio/`:

- `src/AudioStream.types.ts` exposes real microphone `ArrayBuffer` delivery,
  `encoding: 'int16'`, requested `sampleRate: 16000`, `channels: 1`, and actual
  rate/channel metadata. `src/AudioStream.ts` subscribes to `audioStreamBuffer`;
  `src/ExpoAudio.ts` exports `useAudioStream` and `AudioModule`.
- `android/src/main/java/expo/modules/audio/AudioStream.kt` uses `AudioRecord`,
  `ENCODING_PCM_16BIT`, and reports actual sample rate/channels. Hardware fallback
  rates are possible; a future adapter must validate/resample rather than label
  arbitrary hardware output as mono 16 kHz PCM16.
- `ios/AudioStream.swift`, `start()`, uses AVAudioEngine microphone input and
  AVAudioConverter, but unconditionally calls
  `AVAudioSession.setCategory(.record, mode: .measurement)` before starting.
  This is not a playback-capable duplex session. Setting JS audio mode before
  stream start cannot override this later native category change. Its
  converter-unavailable branch also falls back to hardware format.
- `src/AudioModule.types.ts`: `AudioPlayer.replace` and `AudioPlaylist.add/insert`
  take `AudioSource`. `src/Audio.types.ts` defines URI/asset sources, not a raw PCM
  buffer queue. No appendable sample-scheduled PCM output with immediate flush
  for interruption/barge-in is exposed by these installed APIs.
- `useAudioSampleListener` / `audioSampleUpdate` sample player output, NOT the
  microphone. They must never be used as capture.

Capture therefore **does exist**. Full-duplex live transport is blocked by the
native session/output capabilities, not by an absent microphone API. Repeated
WAV files or player replacement would not demonstrate continuous low-latency PCM
output; no such workaround has been added or described as integration.

## Missing native capability and build constraint

A native duplex audio bridge (or verified compatible dependency) must provide:

1. Playback-capable iOS playAndRecord session ownership coordinated with capture,
   interruptions, routes and teardown, instead of the stream's forced record mode.
2. iOS/Android raw PCM output enqueue at provider rate, bounded buffering, ordered
   continuous playback, and immediate stop/flush on interruption.
3. Validated/resampled PCM16 mono 16 kHz input with lifecycle-safe stop/release.

No installed local module supplies these operations.
`modules/rakazo-voice-chat/ios/RakazoVoiceChatModule.swift` routes a pending
Shortcuts request; it is not an audio engine. `package.json` has no `expo-camera`;
`expo-image-picker` is not a continuous camera-frame API, so camera was not added.

The project has native build paths: `eas.json` preview/production profiles,
`expo run:ios` / `expo run:android`, and
`.github/workflows/mobile-android-screenshots.yml` prebuild plus Gradle. This
foreground environment is Linux with no xcodebuild, Java, Gradle or adb on PATH,
and no generated `apps/mobile/ios` or `apps/mobile/android` projects. A new
Swift/Kotlin bridge cannot be built and device-tested here under this task's
requirement. No speculative native module or dependency has been added.

## Remaining integration (not performed)

After native duplex audio is built and device-tested, wire it to existing
`rpc.liveMedia.connect/input/events/end`, the mobile call lifecycle, consent and
approval surfaces, account-generation cancellation, mute, interruption,
reconnection and teardown. Preserve the existing authorized tool-approval UI;
never auto-approve provider tool requests. Existing dictation/speech does not
establish that any live-session path has been integrated.
