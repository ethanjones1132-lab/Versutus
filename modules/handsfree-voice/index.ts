// Re-export the native module. On web, it will be resolved to HandsfreeVoiceModule.web.ts
// and on native platforms to HandsfreeVoiceModule.ts
export { default } from './src/HandsfreeVoiceModule';
export * from './src/HandsfreeVoice.types';
