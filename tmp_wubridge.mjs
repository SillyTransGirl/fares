import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';

const OXY_HOST = 'unblock.oxylabs.io';
const OXY_PORT = 60000;
const USER = 'astridomfg_YNlM4';
const PASS = 'ilovebig_Dihh1';
const LOCAL_PORT = Number(process.env.BRIDGE_PORT || 1083);
const GEO = process.env.BRIDGE_GEO || 'Germany';
const SESSION = process.env.BRIDGE_SESSION || '';

const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');

const server = http.createServer((req, res) => {
  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('CONNECT only');
});

server.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  const up = tls.connect({
    host: OXY_HOST, port: OXY_PORT, rejectUnauthorized: false,
    servername: OXY_HOST,
  }, () => {
    up.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${auth}\r\nX-Oxylabs-Geo-Location: ${GEO}\r\n${SESSION ? `X-Oxylabs-Session-Id: ${SESSION}\r\n` : ''}\r\n`);
  });
  up.on('data', (d) => {
    const s = d.toString('latin1');
    if (s.includes('200')) {
      const idx = s.indexOf('\r\n\r\n');
      const rest = idx >= 0 ? d.subarray(idx + 4) : Buffer.alloc(0);
      if (head && head.length) up.write(head);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.removeAllListeners('data');
      clientSocket.pipe(up);
      if (rest.length) up.write(rest);
      up.pipe(clientSocket);
    } else if (/^\S+ \d{3}/.test(s) && !s.includes('200')) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end(); up.end();
    }
  });
  up.on('error', (e) => { try { clientSocket.end(); } catch {} });
  clientSocket.on('error', () => { try { up.end(); } catch {} });
});

server.listen(LOCAL_PORT, '127.0.0.1', () => console.log(`web-unblocker bridge :${LOCAL_PORT} geo=${GEO} session=${SESSION}`));
