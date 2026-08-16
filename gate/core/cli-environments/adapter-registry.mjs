import { hermesAdapter } from './adapters/hermes.mjs';
import { codexAdapter } from './adapters/codex.mjs';
import { claudeCodeAdapter } from './adapters/claude-code.mjs';
import { opencodeAdapter } from './adapters/opencode.mjs';

const ADAPTERS = new Map([
  [hermesAdapter.adapterId, hermesAdapter],
  [codexAdapter.adapterId, codexAdapter],
  [claudeCodeAdapter.adapterId, claudeCodeAdapter],
  [opencodeAdapter.adapterId, opencodeAdapter],
]);

export class CliAdapterRegistry {
  get(adapterId) {
    const adapter = ADAPTERS.get(adapterId);
    if (!adapter) {
      throw new Error(`unknown CLI adapter "${adapterId}"`);
    }
    return adapter;
  }

  list() {
    return [...ADAPTERS.values()];
  }
}
