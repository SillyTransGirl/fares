import { Server } from 'node:net';
import { SocksClient } from 'socks';
import net from 'node:net';

const server = net.createServer((client) => {
  client.once('data', async (data) => {
    if (data[0] !== 0x05) { client.destroy(); return; }
    
    // Offer no-auth to Chrome
    client.write(Buffer.from([0x05, 0x00]));
    
    client.once('data', async (req) => {
      if (req[1] !== 0x01) { client.destroy(); return; }
      
      const atyp = req[3];
      let host, port;
      if (atyp === 0x01) {
        host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
        port = req.readUInt16BE(8);
      } else if (atyp === 0x03) {
        const len = req[4];
        host = req.slice(5, 5 + len).toString();
        port = req.readUInt16BE(5 + len);
      } else { client.destroy(); return; }
      
      try {
        const { socket } = await SocksClient.createConnection({
          proxy: {
            host: 'PROXY_HOST',
            port: 1080,
            type: 5,
            userId: 'SCRUBBED_USER',
            password: 'SCRUBBED_PASS',
          },
          command: 'connect',
          destination: { host, port },
        });
        
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));
        socket.pipe(client);
        client.pipe(socket);
        
        socket.on('error', () => client.destroy());
        client.on('error', () => socket.destroy());
      } catch (e) {
        client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0,0,0,0, 0,0]));
        client.destroy();
      }
    });
  });
  client.on('error', () => {});
});

server.listen(1081, '127.0.0.1', () => console.log('Local SOCKS5 :1081 → masklabs'));
server.on('error', (e) => console.error('Server error:', e.message));
