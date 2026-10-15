import { NativeModule, requireNativeModule } from 'expo';

export declare class VersutusShortcutsNativeModule extends NativeModule {
  setShortcuts(shortcuts: Array<{ id: string; shortLabel: string; longLabel: string; url: string }>): Promise<boolean>;
  updateShortcuts(shortcuts: Array<{ id: string; shortLabel: string; longLabel: string; url: string }>): Promise<boolean>;
  donateShortcuts(shortcuts: Array<{ id: string; shortLabel: string; longLabel: string; url: string }>): Promise<boolean>;
  setDynamicShortcuts(shortcuts: Array<{ id: string; shortLabel: string; longLabel: string; url: string }>): Promise<boolean>;
}

export default requireNativeModule<VersutusShortcutsNativeModule>('VersutusShortcuts');
