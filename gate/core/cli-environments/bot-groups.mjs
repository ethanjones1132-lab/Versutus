import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function groupSessionTitle(name) {
  return `Group: ${name}`;
}

export function validateGroup({ name, memberIds }) {
  if (!name || !String(name).trim()) return { ok: false, error: 'name required' };
  const unique = [...new Set(memberIds ?? [])];
  if (unique.length < 2) return { ok: false, error: 'need at least 2 bots' };
  if (unique.length > 6) return { ok: false, error: 'at most 6 bots' };
  return { ok: true, memberIds: unique, name: String(name).trim() };
}

export function planGroupRounds({ memberIds, mentionedIds = [], maxRounds = 3, maxMessages = 10 }) {
  const mentioned = mentionedIds.filter((id) => memberIds.includes(id));
  const active = mentioned.length > 0 ? mentioned : memberIds;
  const steps = [];
  for (let round = 0; round < maxRounds && steps.length < maxMessages; round += 1) {
    for (const botId of active) {
      if (steps.length >= maxMessages) break;
      steps.push({ botId });
    }
  }
  return steps;
}

export function createBotGroupStore(gateHome) {
  const file = join(gateHome, 'bot-groups.json');

  async function read() {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return { groups: [] };
    }
  }

  async function write(data) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  }

  return {
    async list() {
      return (await read()).groups;
    },
    async create({ name, memberIds }) {
      const checked = validateGroup({ name, memberIds });
      if (!checked.ok) {
        const error = new Error(checked.error);
        error.code = 'invalid_group';
        error.status = 400;
        throw error;
      }
      const group = {
        id: randomBytes(8).toString('hex'),
        name: checked.name,
        memberIds: checked.memberIds,
      };
      const data = await read();
      data.groups.push(group);
      await write(data);
      return group;
    },
    async get(id) {
      return (await read()).groups.find((group) => group.id === id) ?? null;
    },
  };
}
