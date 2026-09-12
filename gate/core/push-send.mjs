const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const SEND_CHUNK_SIZE = 100;
const RECEIPTS_CHUNK_SIZE = 1000;

function errorResult(error) {
  return { ok: false, error };
}

function normalizeTickets(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  return payload.data && typeof payload.data === 'object' ? [payload.data] : [];
}

function tokensForMessage(message) {
  const to = message?.to;
  if (typeof to === 'string') return [to];
  return Array.isArray(to) ? to.filter((token) => typeof token === 'string') : [];
}

function isDeviceNotRegistered(ticket) {
  return ticket?.details?.error === 'DeviceNotRegistered';
}

async function postJson(fetchImpl, url, body) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
    throw new Error(text || `Expo Push API responded with ${response.status}`);
  }
  return response.json();
}

export function createPushSend({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

  async function collectReceipts(ticketIds = []) {
    const ids = [...new Set((Array.isArray(ticketIds) ? ticketIds : []).filter((id) => typeof id === 'string' && id))];
    if (ids.length === 0) return { ok: true, receipts: [], deadTokens: [] };

    try {
      const receipts = [];
      const deadTokens = [];
      for (let index = 0; index < ids.length; index += RECEIPTS_CHUNK_SIZE) {
        const chunk = ids.slice(index, index + RECEIPTS_CHUNK_SIZE);
        const payload = await postJson(fetchImpl, RECEIPTS_URL, { ids: chunk });
        if (payload?.errors?.length) throw new Error(payload.errors.map((entry) => entry.message ?? entry.code).filter(Boolean).join('; ') || 'Expo receipt request failed');
        const byId = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {};
        for (const id of chunk) {
          const receipt = byId[id];
          if (!receipt) continue;
          receipts.push({ id, ...receipt });
          if (receipt?.details?.error === 'DeviceNotRegistered') deadTokens.push(id);
        }
      }
      return { ok: true, receipts, deadTokens };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function send(messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    try {
      const tickets = [];
      const ticketTokens = new Map();
      const deadTokens = [];

      for (let index = 0; index < list.length; index += SEND_CHUNK_SIZE) {
        const chunk = list.slice(index, index + SEND_CHUNK_SIZE);
        const payload = await postJson(fetchImpl, SEND_URL, chunk);
        if (payload?.errors?.length) throw new Error(payload.errors.map((entry) => entry.message ?? entry.code).filter(Boolean).join('; ') || 'Expo send request failed');
        const chunkTickets = normalizeTickets(payload);
        chunk.forEach((message, messageIndex) => {
          const ticket = chunkTickets[messageIndex] ?? { status: 'error', message: 'Expo returned no ticket for this message' };
          tickets.push(ticket);
          const tokens = tokensForMessage(message);
          for (const token of tokens) ticketTokens.set(ticket.id, token);
          if (isDeviceNotRegistered(ticket)) deadTokens.push(...tokens);
        });
      }

      const successfulTicketIds = tickets
        .filter((ticket) => ticket?.status === 'ok' && typeof ticket.id === 'string')
        .map((ticket) => ticket.id);
      const receiptResult = await collectReceipts(successfulTicketIds);
      if (!receiptResult.ok) return receiptResult;

      const receiptsByToken = new Map();
      for (const receipt of receiptResult.receipts) {
        const token = ticketTokens.get(receipt.id);
        const enriched = token ? { ...receipt, to: token } : receipt;
        receiptsByToken.set(receipt.id, enriched);
        if (receipt?.details?.error === 'DeviceNotRegistered' && token) deadTokens.push(token);
      }

      return {
        ok: true,
        tickets,
        receipts: [...receiptsByToken.values()],
        deadTokens: [...new Set(deadTokens)],
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  return { send, collectReceipts };
}
