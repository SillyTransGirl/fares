// local SOCKS5 (no auth) :1082 -> MaskLabs sticky SOCKS5 :1080 with auth
import net from 'node:net';
import { SocksClient } from 'socks';
const UP = { host: 'proxy.masklabs.io', port: 1080, type: 5, userId: 'mlabs_93557d33dd_sticky', password: '5MSSPCXJ6JPw5zsdom8xOOhiJN5qvaym' };
net.createServer((c) => {
  c.once('data', async (d) => {
    if (d[0] !== 5) { c.destroy(); return; }
    c.write(Buffer.from([5, 0]));
    c.once('data', async (r) => {
      if (r[1] !== 1) { c.destroy(); return; }
      const t = r[3]; let h, p;
      if (t === 3) { const l = r[4]; h = r.slice(5,5+l).toString(); p = r.readUInt16BE(5+l); }
      else if (t === 1) { h = `${r[4]}.${r[5]}.${r[6]}.${r[7]}`; p = r.readUInt16BE(8); }
      else { c.destroy(); return; }
      try {
        const { socket } = await SocksClient.createConnection({ proxy: UP, command: 'connect', destination: { host: h, port: p }, timeout: 30000 });
        c.write(Buffer.from([5,0,0,1, 0,0,0,0, 0,0]));
        socket.pipe(c); c.pipe(socket); socket.on('error', () => c.destroy());
      } catch (e) { console.log('err', h, e.message); if (!c.destroyed) { c.write(Buffer.from([5,5,0,1,0,0,0,0,0,0])); c.destroy(); } }
    });
  });
  c.on('error', () => {});
}).listen(1082, '127.0.0.1', () => console.log('sticky-socks :1082 ready'));
process.on('uncaughtException', () => {});
