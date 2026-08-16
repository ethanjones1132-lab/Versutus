const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const MAX_CHUNK = 16 * 1024;

export function createConptyFallback({
  providerService,
  approvalService,
  desktopPresent = Boolean(process.env.SESSIONNAME || process.env.DISPLAY || process.platform === 'win32'),
} = {}) {
  return {
    async start(request = {}) {
      if (!desktopPresent) {
        throw new Error('desktop presence is required for interactive CLI fallback');
      }
      const session = {
        chunks: [],
        async acceptChunk(text) {
          const stripped = String(text).replace(ANSI, '').slice(0, MAX_CHUNK);
          session.chunks.push(stripped);
          return { type: 'terminal.chunk', payload: { text: stripped } };
        },
        async exit(exitCode) {
          return { exitCode };
        },
      };
      session.acceptChunk = session.acceptChunk.bind(session);
      return session;
    },
    async acceptChunk(text) {
      const session = await this.start({});
      return session.acceptChunk(text);
    },
  };
}
