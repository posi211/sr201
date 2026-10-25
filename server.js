// SR-201 relay power-reset web controller.
// Run:  node server.js   (relay defaults to 192.168.155.97; override with RELAY_HOST=...)
// Optional env: PORT=8080  ACCESS_PIN=1234  HOLD_MS=1000
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const RELAY_HOST = process.env.RELAY_HOST || '192.168.155.97';
const RELAY_PORT = 6722;
const PORT = parseInt(process.env.PORT || '8080', 10);
const ACCESS_PIN = process.env.ACCESS_PIN || '';
const HOLD_MS = parseInt(process.env.HOLD_MS || '1000', 10);

const RELAYS = { 1: 'Server', 2: 'Posi' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One short-lived TCP connection per command, as the device expects.
function send(cmd) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: RELAY_HOST, port: RELAY_PORT });
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('relay timeout')), 3000);
    sock.on('connect', () => sock.write(cmd));
    sock.on('data', (d) => finish(null, d.toString('latin1')));
    sock.on('error', (e) => finish(e));
  });
}

// Reply is 8 chars of 0/1 = relay state *before* the command ran.
async function readStates() {
  const s = await send('00');
  return Object.keys(RELAYS).map((id) => ({
    id: Number(id),
    name: RELAYS[id],
    closed: s[Number(id) - 1] === '1',
  }));
}

let busy = false;

// close -> hold -> open. Never leaves a relay closed:
//  1) The close command carries a hardware timer ("1R:3") so the relay itself
//     re-opens after 3 s even if this server dies mid-sequence.
//  2) An explicit open ("2R") is always sent afterwards, with retries.
async function restart(n) {
  if (busy) throw new Error('another restart is in progress');
  busy = true;
  let openErr = null;
  try {
    try {
      await send(`1${n}:3`);
      await sleep(HOLD_MS);
    } catch (e) {
      openErr = e; // fall through to the open attempts below
    }
  } finally {
    let opened = false;
    for (let i = 0; i < 5 && !opened; i++) {
      try {
        await send(`2${n}`);
        opened = true;
      } catch (e) {
        await sleep(500);
      }
    }
    busy = false;
    if (!opened) throw new Error('could not confirm relay opened (hardware timer will open it within 3 s)');
  }
  if (openErr) throw openErr;
  const states = await readStates();
  return states;
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (req.method === 'GET' && req.url === '/api/status') {
      return json(200, { busy, relays: await readStates() });
    }

    const m = req.url.match(/^\/api\/restart\/([12])$/);
    if (req.method === 'POST' && m) {
      if (ACCESS_PIN && req.headers['x-pin'] !== ACCESS_PIN) {
        return json(401, { error: 'PIN required' });
      }
      const relays = await restart(Number(m[1]));
      return json(200, { ok: true, relays });
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }

    json(404, { error: 'not found' });
  } catch (e) {
    json(500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Relay controller on http://0.0.0.0:${PORT} -> ${RELAY_HOST}:${RELAY_PORT}`);
  // Set OPEN_BROWSER=1 (the .bat file does) to open Chrome once the server is listening.
  if (process.env.OPEN_BROWSER) {
    require('child_process').exec(`start "" chrome http://127.0.0.1:${PORT}`);
  }
});
