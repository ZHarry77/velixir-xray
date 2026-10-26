// Velixir free-tier single-file app:
// - Serves a decoy page on / and a base64 subscription on /sub
// - On first start, downloads Xray-core and unpacks it with built-in zlib only
//   (the container has no unzip/python3)
// - Runs Xray (VLESS + WebSocket) on 127.0.0.1 and proxies WS upgrades to it
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const UUID = process.env.UUID || '6c1ee4d3-a30c-4888-82db-2fd4d7eb3525';
const WS_PATH = (process.env.WS_PATH || 'ws-4a8dd7399082').replace(/^\//, '');
const XRAY_DIR = path.join(__dirname, 'xray');
const XRAY_BIN = path.join(XRAY_DIR, 'xray');
const XRAY_PORT = 10000;
const XRAY_URL =
  'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('download HTTP ' + res.statusCode));
          return;
        }
        const f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on('finish', () => f.close(resolve));
        f.on('error', reject);
      })
      .on('error', reject);
  });
}

// Minimal ZIP reader: sizes/offsets come from the central directory,
// payloads are inflated with zlib.inflateRawSync (no external tools needed).
function unzip(zipPath, outDir) {
  const data = fs.readFileSync(zipPath);
  let eocd = -1;
  const floor = Math.max(0, data.length - 22 - 65536);
  for (let i = data.length - 22; i >= floor; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');
  const count = data.readUInt16LE(eocd + 10);
  let off = data.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (data.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: bad central dir');
    const method = data.readUInt16LE(off + 10);
    const compSize = data.readUInt32LE(off + 20);
    const nameLen = data.readUInt16LE(off + 28);
    const extraLen = data.readUInt16LE(off + 30);
    const commentLen = data.readUInt16LE(off + 32);
    const localOff = data.readUInt32LE(off + 42);
    const name = data.subarray(off + 46, off + 46 + nameLen).toString();
    const lNameLen = data.readUInt16LE(localOff + 26);
    const lExtraLen = data.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const comp = data.subarray(start, start + compSize);
    const outPath = path.join(outDir, name);
    if (name.endsWith('/')) {
      fs.mkdirSync(outPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, method === 8 ? zlib.inflateRawSync(comp) : comp);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
}

function startXray() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: XRAY_PORT,
        protocol: 'vless',
        settings: { clients: [{ id: UUID }], decryption: 'none' },
        streamSettings: { network: 'ws', wsSettings: { path: '/' + WS_PATH } },
      },
    ],
    outbounds: [{ protocol: 'freedom' }],
  };
  fs.writeFileSync(path.join(XRAY_DIR, 'config.json'), JSON.stringify(cfg));
  const p = spawn(XRAY_BIN, ['run', '-c', path.join(XRAY_DIR, 'config.json')]);
  p.stdout.on('data', (d) => process.stdout.write('[xray] ' + d));
  p.stderr.on('data', (d) => process.stderr.write('[xray] ' + d));
  p.on('exit', (code) => {
    console.log('[xray] exited with', code, '- restarting in 3s');
    setTimeout(startXray, 3000);
  });
}

const BUNDLED_BIN = path.join(__dirname, 'bin', 'xray');

async function bootstrap() {
  try {
    if (!fs.existsSync(XRAY_BIN) && fs.existsSync(BUNDLED_BIN)) {
      // Preferred path: binary shipped inside the repo, no runtime download.
      fs.mkdirSync(XRAY_DIR, { recursive: true });
      fs.copyFileSync(BUNDLED_BIN, XRAY_BIN);
      fs.chmodSync(XRAY_BIN, 0o755);
      console.log('[boot] using bundled xray binary');
    }
    if (!fs.existsSync(XRAY_BIN)) {
      fs.mkdirSync(XRAY_DIR, { recursive: true });
      const zip = path.join(XRAY_DIR, 'xray.zip');
      console.log('[boot] downloading xray-core...');
      await download(XRAY_URL, zip);
      console.log('[boot] unpacking...');
      unzip(zip, XRAY_DIR);
      fs.chmodSync(XRAY_BIN, 0o755);
      fs.unlinkSync(zip);
      console.log('[boot] xray ready');
    }
    startXray();
  } catch (e) {
    console.error('[boot] failed:', e.message, '- retrying in 10s');
    setTimeout(bootstrap, 10000);
  }
}

const DECOY = `<!doctype html><html><head><meta charset="utf-8">
<title>Notes</title></head><body style="font-family:sans-serif;margin:3em">
<h1>Notes</h1><p>A small personal blog. Nothing here yet.</p></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/sub') {
    const host = req.headers.host;
    const link =
      `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws` +
      `&host=${host}&path=%2F${WS_PATH}#Velixir-EU`;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(Buffer.from(link).toString('base64'));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(DECOY);
});

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/' + WS_PATH) {
    socket.destroy();
    return;
  }
  const up = net.connect(XRAY_PORT, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, () => console.log('[app] listening on', PORT));
bootstrap();
