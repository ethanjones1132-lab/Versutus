import { NativeModule, requireNativeModule } from 'expo';

import type { VersutusWidgetPayload } from './VersutusWidget.types';

export declare class VersutusWidgetNativeModule extends NativeModule {
  /** Store the payload and redraw every placed widget. Answers false if the JSON was refused. */
  setPayload(json: string): Promise<boolean>;
  /** Forget the payload (e.g. the gateway was removed) and redraw the empty state. */
  clearPayload(): Promise<void>;
}

export type { VersutusWidgetPayload };

export default requireNativeModule<VersutusWidgetNativeModule>('VersutusWidget');
