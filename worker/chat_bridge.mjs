// Local ChatGPT Bridge Server. Runs in the background on the worker PC,
// bridging between the worker (via chat.mjs) and the user's active ChatGPT web session.
//
// Zero external dependencies: pure Node.js http + RFC 6455 WebSocket server.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.CHAT_BRIDGE_PORT) || 8765;
const HOST = '127.0.0.1';

let activeWsClient = null;
const answerWaiters = new Map();

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': '*',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-allow-private-network': 'true',
    });
    res.end();
    return;
  }

  // Status check
  if (method === 'GET' && (pathname === '/health' || pathname === '/status')) {
    sendJson(res, 200, { ok: true, connected: !!activeWsClient });
    return;
  }

  // Worker asking prompt
  if (method === 'POST' && pathname === '/ask') {
    const body = await readBody(req);
    const id = body.id || String(Date.now());
    const prompt = String(body.prompt || '').trim();
    const timeoutMs = Number(body.timeoutMs) || 180_000;

    if (!prompt) {
      sendJson(res, 400, { ok: false, error: 'prompt is required' });
      return;
    }

    if (!activeWsClient) {
      sendJson(res, 503, { ok: false, error: 'no active ChatGPT tab connected to local worker on https://chatgpt.com' });
      return;
    }

    const task = { id, action: 'prompt', prompt, model: body.model || 'auto' };
    activeWsClient.send(task);

    const answer = await new Promise((resolve) => {
      let timer;
      const onAnswer = (result) => {
        clearTimeout(timer);
        resolve(result);
      };

      timer = setTimeout(() => {
        answerWaiters.delete(id);
        resolve({ ok: false, error: `ChatGPT web timed out after ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs);

      answerWaiters.set(id, onAnswer);
    });

    sendJson(res, answer.ok ? 200 : 500, answer);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

// RFC 6455 WebSocket Handshake and Frame Handling
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const digest = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${digest}\r\n` +
    '\r\n'
  );

  let buffer = Buffer.alloc(0);

  const client = {
    send(data) {
      const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
      const len = payload.length;
      let header;
      if (len <= 125) {
        header = Buffer.from([0x81, len]);
      } else if (len <= 65535) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      try {
        socket.write(Buffer.concat([header, payload]));
      } catch { }
    },
    close() {
      try { socket.destroy(); } catch { }
    },
  };

  activeWsClient = client;
  console.log('[Bridge] ChatGPT browser tab CONNECTED via WebSocket.');

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const byte1 = buffer[0];
      const byte2 = buffer[1];
      const opcode = byte1 & 0x0f;
      const isMasked = (byte2 & 0x80) !== 0;
      let payloadLen = byte2 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) break;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) break;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) break;

      let mask = null;
      if (isMasked) {
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
      if (isMasked && mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }

      buffer = buffer.subarray(offset + payloadLen);

      if (opcode === 0x08) { // Close
        socket.destroy();
        if (activeWsClient === client) activeWsClient = null;
        return;
      }
      if (opcode === 0x09) { // Ping
        socket.write(Buffer.from([0x8a, 0x00])); // Pong
        continue;
      }
      if (opcode === 0x01) { // Text
        const str = payload.toString('utf8');
        try {
          const msg = JSON.parse(str);
          if (msg.type === 'done' || msg.type === 'error') {
            const waiter = answerWaiters.get(msg.id);
            if (waiter) {
              answerWaiters.delete(msg.id);
              waiter(msg);
            }
          }
        } catch { }
      }
    }
  });

  socket.on('close', () => {
    if (activeWsClient === client) {
      activeWsClient = null;
      console.log('[Bridge] ChatGPT browser tab disconnected.');
    }
  });
  socket.on('error', () => {
    if (activeWsClient === client) {
      activeWsClient = null;
    }
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`CHAT_BRIDGE_READY on ${HOST}:${PORT}\n`);
});
