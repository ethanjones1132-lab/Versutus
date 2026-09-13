import { registerWebModule, NativeModule } from 'expo';

import { HandsfreeVoiceModuleEvents } from './HandsfreeVoice.types';

// HandsfreeVoiceModule is not available on the web platform.
class HandsfreeVoiceModule extends NativeModule<HandsfreeVoiceModuleEvents> {
  // No widget and no Keystore on the web: a launch link is never signed.
  async verifyLaunch(): Promise<boolean> {
    return false;
  }
}

export default registerWebModule(HandsfreeVoiceModule, 'HandsfreeVoiceModule');
