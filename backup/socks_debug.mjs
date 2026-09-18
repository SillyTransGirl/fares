import net from 'node:net';
import { SocksClient } from 'socks';

const server = net.createServer((client) => {
  console.log('[tunnel] New client connection');
  let step = 'greeting';
  
  client.on('error', (e) => console.log('[tunnel] Client error:', e.message));
  client.on('close', () => console.log('[tunnel] Client closed'));
  
  client.once('data', (data) => {
    console.log('[tunnel] Client greeting:', Array.from(data).map(b => '0x'+b.toString(16)).join(' '));
    
    if (data[0] !== 0x05) {
      console.log('[tunnel] Not SOCKS5, destroying');
      client.destroy();
      return;
    }
    
    // Offer no-auth
    client.write(Buffer.from([0x05, 0x00]));
    
    client.once('data', async (req) => {
      console.log('[tunnel] Client request:', Array.from(req).map(b => '0x'+b.toString(16)).join(' '));
      
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
      } else {
        console.log('[tunnel] Unknown atyp:', atyp);
        client.destroy();
        return;
      }
      
      console.log(`[tunnel] Connecting to ${host}:${port}`);
      
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
        
        console.log(`[tunnel] Connected to ${host}:${port}`);
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));
        socket.pipe(client);
        client.pipe(socket);
        
        socket.on('error', (e) => console.log('[tunnel] Upstream error:', e.message));
      } catch (e) {
        console.log('[tunnel] Connect failed:', e.message);
        client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0,0,0,0, 0,0]));
        client.destroy();
      }
    });
  });
});

server.listen(1081, '127.0.0.1', () => console.log('Debug SOCKS5 :1081'));
