import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

export function parseSemver(version) {
  const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function versionInRange(version, min, maxExclusiveMajor) {
  const parsed = parseSemver(version);
  const floor = parseSemver(min);
  if (!parsed || !floor) return false;
  if (parsed.major !== floor.major) return parsed.major > floor.major && parsed.major < maxExclusiveMajor;
  if (parsed.minor !== floor.minor) return parsed.minor >= floor.minor;
  return parsed.patch >= floor.patch;
}

export function spawnCommand(executablePath) {
  if (executablePath.endsWith('.mjs')) {
    return { command: process.execPath, prefix: [executablePath] };
  }
  return { command: executablePath, prefix: [] };
}

/**
 * Run a CLI to completion. Resolves with { code, stdout, stderr } whatever the
 * exit code -- callers that need a verdict (probeVersion) judge `code`
 * themselves -- and rejects only on spawn failure or timeout.
 */
export async function runCli(executablePath, args, { timeoutMs = 5000, spawnImpl = spawn } = {}) {
  await access(executablePath.endsWith('.mjs') ? executablePath : executablePath.split(' ')[0]);
  const { command, prefix } = spawnCommand(executablePath);
  return new Promise((resolve, reject) => {
    // stdin is never written; an open pipe would park a CLI that reads to EOF.
    const child = spawnImpl(command, [...prefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('cli probe timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      });
    });
  });
}

/** First stderr line (else stdout), bounded, for a probe failure message. */
function probeOutput(result) {
  const text = (result?.stderr || result?.stdout || '').trim();
  const line = text.split(/\r?\n/).find((entry) => entry.trim()) ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

function exitFailure(what, result) {
  const detail = probeOutput(result);
  return `${what} exited with code ${result?.code ?? 'null'}${detail ? `: ${detail}` : ''}`;
}

export async function probeVersion(executablePath, {
  min,
  maxExclusiveMajor,
  protocol,
  handshakeArgs,
  // Optional: output the handshake must contain to prove the protocol, for a
  // handshake (a --help) whose exit code alone only proves the CLI runs.
  handshakeExpect,
  runCliImpl = runCli,
}) {
  try {
    await access(executablePath.endsWith('.mjs') ? executablePath : executablePath);
  } catch {
    return { state: 'not_installed', executablePath, message: 'executable not found' };
  }

  let versionResult;
  try {
    versionResult = await runCliImpl(executablePath, ['--version']);
  } catch {
    return { state: 'not_installed', executablePath, message: 'executable not runnable' };
  }
  // A version line printed by a command that then failed is not a working CLI.
  if (versionResult.code !== 0) {
    return {
      state: 'not_installed',
      executablePath,
      message: `executable not runnable: ${exitFailure('--version', versionResult)}`,
    };
  }

  // CLIs decorate their version line differently — `1.17.9`,
  // `codex-cli 0.147.0`, `2.1.140 (Claude Code)`. Taking the last whitespace
  // token parsed Claude's as "Code)"; take the first semver anywhere instead.
  const version = versionResult.stdout.match(/\d+\.\d+\.\d+/)?.[0];
  if (!versionInRange(version, min, maxExclusiveMajor)) {
    return {
      state: 'incompatible',
      executablePath,
      cliVersion: version,
      message: `unsupported CLI version ${version}`,
    };
  }

  // The handshake is judged by its exit code, not just by having run: `hermes
  // --acp --probe` exits 2 with "unrecognized arguments" on 0.19, and treating
  // that as success reported a backend `ready` that could not do the protocol.
  let handshake;
  try {
    handshake = await runCliImpl(executablePath, handshakeArgs);
  } catch (error) {
    return {
      state: 'degraded',
      executablePath,
      cliVersion: version,
      protocol,
      message: error.message,
    };
  }
  if (handshake.code !== 0) {
    return {
      state: 'degraded',
      executablePath,
      cliVersion: version,
      protocol,
      message: `protocol probe failed: ${exitFailure(handshakeArgs.join(' '), handshake)}`,
      ...(handshake.stderr ? { stderr: probeOutput({ stderr: handshake.stderr }) } : {}),
    };
  }
  if (handshakeExpect && !handshakeExpect.test(`${handshake.stdout ?? ''}\n${handshake.stderr ?? ''}`)) {
    return {
      state: 'degraded',
      executablePath,
      cliVersion: version,
      protocol,
      message: `protocol probe failed: \`${handshakeArgs.join(' ')}\` does not offer ${handshakeExpect.source}`,
    };
  }

  return {
    state: 'ready',
    executablePath,
    cliVersion: version,
    protocol,
    protocolVersion: '1',
  };
}
