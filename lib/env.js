import fs from 'node:fs';

// Load secrets from gitignored .env (DB_CLIENT_ID, DB_CLIENT_SECRET, MASKLABS_*).
// Import this module FIRST so process.env is populated before any provider loads.
const envUrl = new URL('../.env', import.meta.url);
if (process.env.DB_CLIENT_ID === undefined && fs.existsSync(envUrl)) {
  for (const raw of fs.readFileSync(envUrl, 'utf8').split('\n')) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}