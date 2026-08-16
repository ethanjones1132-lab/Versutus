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

export async function runCli(executablePath, args, { timeoutMs = 5000 } = {}) {
  await access(executablePath.endsWith('.mjs') ? executablePath : executablePath.split(' ')[0]);
  const { command, prefix } = spawnCommand(executablePath);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { windowsHide: true });
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

export async function probeVersion(executablePath, { min, maxExclusiveMajor, protocol, handshakeArgs }) {
  try {
    await access(executablePath.endsWith('.mjs') ? executablePath : executablePath);
  } catch {
    return { state: 'not_installed', executablePath, message: 'executable not found' };
  }

  let versionResult;
  try {
    versionResult = await runCli(executablePath, ['--version']);
  } catch {
    return { state: 'not_installed', executablePath, message: 'executable not runnable' };
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

  try {
    await runCli(executablePath, handshakeArgs);
  } catch (error) {
    return {
      state: 'degraded',
      executablePath,
      cliVersion: version,
      protocol,
      message: error.message,
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
