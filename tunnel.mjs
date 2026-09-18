import './lib/env.js';
import net from 'node:net';
import { SocksClient } from 'socks';

const server = net.createServer((c) => {
  c.once('data', async (d) => {
    if (d[0] !== 5) { c.destroy(); return; }
    c.write(Buffer.from([5, 0]));
    c.once('data', async (r) => {
      if (r[1] !== 1) { c.destroy(); return; }
      const t = r[3];
      let h, p;
      if (t === 3) { const l = r[4]; h = r.slice(5,5+l).toString(); p = r.readUInt16BE(5+l); }
      else if (t === 1) { h = `${r[4]}.${r[5]}.${r[6]}.${r[7]}`; p = r.readUInt16BE(8); }
      else { c.destroy(); return; }
      try {
        const { socket } = await SocksClient.createConnection({
          proxy: { host:'proxy.masklabs.io', port:1080, type:5, userId: process.env.MASKLABS_USER || '', password: process.env.MASKLABS_PASS || '' },
          command:'connect', destination:{ host:h, port:p }, timeout:15000
        });
        c.write(Buffer.from([5,0,0,1, 0,0,0,0, 0,0]));
        socket.pipe(c); c.pipe(socket);
        socket.on('error', () => c.destroy());
      } catch { if (!c.destroyed) { c.write(Buffer.from([5,5,0,1, 0,0,0,0, 0,0])); c.destroy(); } }
    });
  });
  c.on('error', () => {});
});
server.listen(1081, '127.0.0.1', () => console.log('Tunnel :1081'));
process.on('uncaughtException', () => {});
