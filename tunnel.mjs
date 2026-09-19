import './lib/env.js';
import net from 'node:net';
import { SocksClient } from 'socks';

const HOME_HOST = process.env.HOME_PROXY_HOST || '';
const HOME_PORT = parseInt(process.env.HOME_PROXY_PORT) || 1080;
const MASKLABS = { host: 'proxy.masklabs.io', port: 1080, userId: process.env.MASKLABS_USER || '', password: process.env.MASKLABS_PASS || '' };

async function socksConnect(host, port, destination) {
  const proxy = { host, port, type: 5, userId: '', password: '' };
  return SocksClient.createConnection({ proxy, command: 'connect', destination, timeout: 12000 });
}

async function connectWithFallback(dest) {
  // Try home PC first
  if (HOME_HOST) {
    try {
      const r = await socksConnect(HOME_HOST, HOME_PORT, dest);
      console.log(`[tunnel] → home ${HOME_HOST}:${HOME_PORT}`);
      return r;
    } catch (e) {
      console.log(`[tunnel] home ${HOME_HOST} failed: ${e.message?.slice(0, 50)}`);
    }
  }
  // Fallback to masklabs
  try {
    const r = await SocksClient.createConnection({
      proxy: { ...MASKLABS, type: 5 },
      command: 'connect', destination: dest, timeout: 12000
    });
    console.log(`[tunnel] → masklabs`);
    return r;
  } catch (e) {
    console.log(`[tunnel] masklabs failed: ${e.message?.slice(0, 50)}`);
    throw e;
  }
}

const server = net.createServer((c) => {
  c.once('data', async (d) => {
    if (d[0] !== 5) { c.destroy(); return; }
    c.write(Buffer.from([5, 0]));
    c.once('data', async (r) => {
      if (r[1] !== 1) { c.destroy(); return; }
      const t = r[3];
      let h, p;
      if (t === 3) { const l = r[4]; h = r.slice(5, 5 + l).toString(); p = r.readUInt16BE(5 + l); }
      else if (t === 1) { h = `${r[4]}.${r[5]}.${r[6]}.${r[7]}`; p = r.readUInt16BE(8); }
      else { c.destroy(); return; }
      try {
        const { socket } = await connectWithFallback({ host: h, port: p });
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        socket.pipe(c); c.pipe(socket);
        socket.on('error', () => c.destroy());
      } catch {
        if (!c.destroyed) c.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (!c.destroyed) c.destroy();
      }
    });
  });
  c.on('error', () => {});
});
server.listen(1081, '127.0.0.1', () => {
  console.log(`Tunnel :1081 (home: ${HOME_HOST ? HOME_HOST + ':' + HOME_PORT : 'disabled'}, fallback: masklabs)`);
});
process.on('uncaughtException', () => {});
