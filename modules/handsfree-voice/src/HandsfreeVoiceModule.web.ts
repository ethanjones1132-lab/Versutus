import { registerWebModule, NativeModule } from 'expo';

import { HandsfreeVoiceModuleEvents } from './HandsfreeVoice.types';

// HandsfreeVoiceModule is not available on the web platform.
class HandsfreeVoiceModule extends NativeModule<HandsfreeVoiceModuleEvents> {}

export default registerWebModule(HandsfreeVoiceModule, 'HandsfreeVoiceModule');
