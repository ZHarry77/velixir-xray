// Velixir free-tier single-file app:
// - Serves a decoy page on / and a base64 subscription on /sub
// - On first start, downloads Xray-core and unpacks it with built-in zlib only
//   (the container has no unzip/python3)
// - Runs Xray with three XHTTP inbounds (VLESS / Trojan / VMess) on 127.0.0.1
//   and forwards plain-HTTP requests under each secret path to its inbound.
//   (The platform edge strips WebSocket upgrades, so WS transports cannot
//   work here; XHTTP rides plain HTTP and does.)
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
const TROJAN_PW = process.env.TROJAN_PW || '1c340c0bc00948f298935c65';
const TROJAN_PATH = (process.env.TROJAN_PATH || 'tj-07dfaae49dd1').replace(/^\//, '');
const VMESS_ID = process.env.VMESS_ID || '762756e3-b90c-4163-b82c-4b86301cc2cf';
const VMESS_PATH = (process.env.VMESS_PATH || 'vm-0c24a7209aa2').replace(/^\//, '');
// Secret path prefix -> local Xray inbound port
const ROUTES = [
  { prefix: WS_PATH, port: 10000 },
  { prefix: TROJAN_PATH, port: 10001 },
  { prefix: VMESS_PATH, port: 10002 },
];
const XRAY_DIR = path.join(__dirname, 'xray');
const XRAY_BIN = path.join(XRAY_DIR, 'xray');
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
    log: { loglevel: 'info' },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: 10000,
        protocol: 'vless',
        settings: { clients: [{ id: UUID }], decryption: 'none' },
        streamSettings: { network: 'xhttp', xhttpSettings: { path: '/' + WS_PATH } },
      },
      {
        listen: '127.0.0.1',
        port: 10001,
        protocol: 'trojan',
        settings: { clients: [{ password: TROJAN_PW }] },
        streamSettings: { network: 'xhttp', xhttpSettings: { path: '/' + TROJAN_PATH } },
      },
      {
        listen: '127.0.0.1',
        port: 10002,
        protocol: 'vmess',
        settings: { clients: [{ id: VMESS_ID, alterId: 0 }] },
        streamSettings: { network: 'xhttp', xhttpSettings: { path: '/' + VMESS_PATH } },
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
    // The edge presents an internal regional host (e.g.
    // harrynotes-eu.velixir.run) that only serves a placeholder page
    // publicly; the working public host drops the region infix.
    const host = req.headers.host.replace(/-[a-z]{2}(?=\.velixir\.run$)/, '');
    const links = [
      `vless://${UUID}@${host}:443?encryption=none&security=tls&type=xhttp` +
        `&host=${host}&path=%2F${WS_PATH}&mode=packet-up#Velixir-UK-VLESS-XHTTP`,
      `trojan://${TROJAN_PW}@${host}:443?security=tls&sni=${host}&type=xhttp` +
        `&host=${host}&path=%2F${TROJAN_PATH}&mode=packet-up#Velixir-UK-Trojan-XHTTP`,
      `vmess://${VMESS_ID}@${host}:443?encryption=auto&security=tls&type=xhttp` +
        `&host=${host}&path=%2F${VMESS_PATH}&mode=packet-up#Velixir-UK-VMess-XHTTP`,
    ];
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="Velixir-UK.txt"',
    });
    res.end(Buffer.from(links.join('\n')).toString('base64'));
    return;
  }
  // XHTTP traffic arrives as plain HTTP requests under a secret path
  // (the platform edge does not forward WebSocket upgrades). Forward
  // method, headers and body to the matching local Xray inbound.
  const route = ROUTES.find(
    (r) => u.pathname === '/' + r.prefix || u.pathname.startsWith('/' + r.prefix + '/')
  );
  if (route) {
    const HOP = new Set([
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailer', 'transfer-encoding', 'proxy-connection',
    ]);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP.has(k)) headers[k] = v;
    }
    headers.host = `127.0.0.1:${route.port}`;
    const t0 = Date.now();
    console.log(`[fwd] ${req.method} ${req.url} http/${req.httpVersion}`);
    const up = http.request(
      { host: '127.0.0.1', port: route.port, path: req.url, method: req.method, headers, agent: false },
      (upRes) => {
        console.log(`[fwd] ${req.method} ${req.url} -> ${upRes.statusCode} headers in ${Date.now() - t0}ms`);
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', () =>
          console.log(`[fwd] ${req.method} ${req.url} done in ${Date.now() - t0}ms`)
        );
      }
    );
    up.on('error', (e) => {
      console.log(`[fwd] ${req.method} ${req.url} upstream error: ${e.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(DECOY);
});

server.listen(PORT, () => console.log('[app] listening on', PORT));
bootstrap();
