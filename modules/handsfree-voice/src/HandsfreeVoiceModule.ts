import { NativeModule, requireNativeModule } from 'expo';

import type {
  HandsfreeAvailability,
  HandsfreeSpeakOptions,
  HandsfreeStartOutcome,
  HandsfreeVoiceModuleEvents,
} from './HandsfreeVoice.types';

// The one native boundary a hands-free call crosses. Every method is a
// request to the platform's own microphone/speech/voice APIs; every event is
// something the platform observed. Nothing here is a provider call and
// nothing here records audio.
export declare class HandsfreeVoiceModule extends NativeModule<HandsfreeVoiceModuleEvents> {
  /** What this device can do, asked before Start is offered. */
  getAvailability(): Promise<HandsfreeAvailability>;
  /** Open a call session and promote the user-visible lifetime. */
  startSession(options: { title: string }): Promise<HandsfreeStartOutcome>;
  /** Begin recognizing one listening turn. Answers false if it could not start. */
  startListening(): Promise<boolean>;
  /** Stop the current recognition turn. */
  stopListening(): Promise<void>;
  /** Speak an ordered list of chunks through the call's own audio session. */
  speak(options: HandsfreeSpeakOptions): Promise<boolean>;
  /** Flush the speech queue; never emits a stale completion. */
  stopSpeaking(): Promise<void>;
  /** Mute or unmute recognition without touching reply playback. */
  setMuted(muted: boolean): Promise<void>;
  /** Play the short, bundled send earcon, fire-and-forget. */
  playSendEarcon(): Promise<void>;
  /** End the call and release recognition, TTS, audio focus and the service. */
  stopSession(): Promise<void>;
}

export default requireNativeModule<HandsfreeVoiceModule>('HandsfreeVoice');
