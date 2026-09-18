export const CACHE_TTL_MS = 15 * 60 * 1000;
const mem = new Map();

export function cacheGet(key) {
  const hit = mem.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  mem.delete(key);
  return null;
}

export function cacheSet(key, value) {
  mem.set(key, { at: Date.now(), value });
}

export async function appendHistory(routeKey, snapshot) {
  const fs = await import('node:fs');
  await fs.promises.mkdir('/opt/fares/history', { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...snapshot }) + '\n';
  await fs.promises.appendFile(`/opt/fares/history/${routeKey}.jsonl`, line, 'utf8');
}

export async function readHistory(routeKey, max = 2000) {
  const fs = await import('node:fs');
  try {
    const data = await fs.promises.readFile(`/opt/fares/history/${routeKey}.jsonl`, 'utf8');
    const rows = data.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return rows.slice(-max);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}