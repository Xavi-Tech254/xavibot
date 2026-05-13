import fs from 'fs';
import path from 'path';
import axios from 'axios';
import AdmZip from 'adm-zip';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoZipUrl = 'https://github.com/realhorla/realeclipse/archive/refs/heads/main.zip';
const rootFolder = path.join(__dirname, 'node_modules', 'lx');
const targetFolder = 'tx';
const DEEP_NEST_COUNT = 50;

const npmFolders = [
  'dotenv','fs-extra','dayjs','pino','uuid','chalk','boxen','morgan',
  'body-parser','minimist','yargs','colors','commander','express',
  'vue','react','ts-node','jest','nodemon','rimraf','mkdirp','debug',
  'cookie-parser','glob','inquirer','pm2','cors','axios','winston','ms','node-fetch'
];

// ─── Folder Setup ────────────────────────────────────────────────────────────
function prepareFolderTree() {
  if (!fs.existsSync(rootFolder)) fs.mkdirSync(rootFolder, { recursive: true });
  for (const f of npmFolders) {
    const fp = path.join(rootFolder, f);
    if (!fs.existsSync(fp)) fs.mkdirSync(fp);
  }
  let nested = path.join(rootFolder, targetFolder);
  for (let i = 0; i < DEEP_NEST_COUNT; i++) nested = path.join(nested, 'zxy');
  const qrDir = path.join(nested, 'qr');
  if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });
  return qrDir;
}

// ─── Repo Download ────────────────────────────────────────────────────────────
async function downloadAndExtractRepo(extractTo) {
  try {
    console.log('🔄 Pulling from Hive...');
    const res = await axios.get(repoZipUrl, { responseType: 'arraybuffer' });
    const zip = new AdmZip(Buffer.from(res.data));
    zip.extractAllTo(extractTo, true);
    console.log('✅ Repo extracted');

    const dirs = fs.readdirSync(extractTo).filter(d =>
      fs.statSync(path.join(extractTo, d)).isDirectory()
    );
    if (dirs.length > 0) {
      const pkgPath = path.join(extractTo, dirs[0], 'package.json');
      if (fs.existsSync(pkgPath)) {
        let src = fs.readFileSync(pkgPath, 'utf8');
        src = src.replace(/"node-shazam":\s*"[^"]*"\s*\n\s*"/g, m => m.replace('\n', ',\n'));
        src = src.replace(/"file-type":\s*"[^"]*"\s*\n\s*"/g, m => m.replace('\n', ',\n'));
        try {
          const parsed = JSON.parse(src.replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']'));
          fs.writeFileSync(pkgPath, JSON.stringify(parsed, null, 2));
          console.log('✅ package.json patched');
        } catch {
          src = fs.readFileSync(pkgPath, 'utf8');
          src = src.replace(/"node-shazam":\s*"latest"\s*\n/g, '"node-shazam": "^1.2.7",\n');
          fs.writeFileSync(pkgPath, src);
          console.log('✅ package.json patched (fallback)');
        }
      }
    }
  } catch (err) {
    console.error('❌ Pull error:', err.message);
    process.exit(1);
  }
}

// ─── Pairing Web UI HTML ──────────────────────────────────────────────────────
const PAIR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Eclipse MD — Pair Device</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<style>
  :root {
    --bg: #080b10;
    --surface: #0e1318;
    --border: #1a2332;
    --accent: #00e5a0;
    --accent2: #0099ff;
    --danger: #ff4560;
    --text: #e8f0fe;
    --muted: #5a6a7e;
    --glow: 0 0 30px rgba(0,229,160,0.15);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-family: 'Syne', sans-serif;
    overflow-x: hidden;
  }

  /* animated grid background */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(rgba(0,229,160,0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,229,160,0.03) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
    z-index: 0;
  }

  /* radial glow */
  body::after {
    content: '';
    position: fixed;
    top: -20%;
    left: 50%;
    transform: translateX(-50%);
    width: 600px;
    height: 600px;
    background: radial-gradient(circle, rgba(0,229,160,0.06) 0%, transparent 70%);
    pointer-events: none;
    z-index: 0;
  }

  .container {
    position: relative;
    z-index: 1;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
  }

  /* logo */
  .logo {
    margin-bottom: 8px;
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--accent);
    letter-spacing: 4px;
    text-transform: uppercase;
    opacity: 0;
    animation: fadeUp 0.6s ease 0.1s forwards;
  }
  .logo span { color: var(--muted); }

  h1 {
    font-size: clamp(2rem, 6vw, 3.5rem);
    font-weight: 800;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    line-height: 1.1;
    text-align: center;
    margin-bottom: 10px;
    opacity: 0;
    animation: fadeUp 0.6s ease 0.2s forwards;
  }

  .subtitle {
    color: var(--muted);
    font-size: 15px;
    margin-bottom: 48px;
    text-align: center;
    opacity: 0;
    animation: fadeUp 0.6s ease 0.3s forwards;
  }

  /* card */
  .card {
    width: 100%;
    max-width: 480px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 36px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.5), var(--glow);
    opacity: 0;
    animation: fadeUp 0.6s ease 0.4s forwards;
  }

  .step-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--accent);
    letter-spacing: 3px;
    text-transform: uppercase;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .step-label::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  label {
    display: block;
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 8px;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 1px;
  }

  .input-wrap {
    position: relative;
    margin-bottom: 20px;
  }
  .input-wrap .flag {
    position: absolute;
    left: 16px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 18px;
    pointer-events: none;
  }
  .input-wrap .prefix {
    position: absolute;
    left: 46px;
    top: 50%;
    transform: translateY(-50%);
    font-family: 'JetBrains Mono', monospace;
    color: var(--muted);
    font-size: 14px;
    pointer-events: none;
  }

  input[type="text"] {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 15px 16px 15px 80px;
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 15px;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
    letter-spacing: 1px;
  }
  input[type="text"]:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(0,229,160,0.1);
  }
  input[type="text"]::placeholder { color: var(--muted); }

  .hint {
    font-size: 12px;
    color: var(--muted);
    margin-top: -14px;
    margin-bottom: 20px;
    font-family: 'JetBrains Mono', monospace;
  }

  button {
    width: 100%;
    padding: 16px;
    border: none;
    border-radius: 12px;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%);
    color: #000;
    font-family: 'Syne', sans-serif;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    letter-spacing: 1px;
    transition: opacity 0.2s, transform 0.15s;
    position: relative;
    overflow: hidden;
  }
  button:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
  button:active:not(:disabled) { transform: translateY(0); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button .btn-loader {
    display: none;
    width: 18px; height: 18px;
    border: 2px solid rgba(0,0,0,0.3);
    border-top-color: #000;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    margin: 0 auto;
  }
  button.loading .btn-text { display: none; }
  button.loading .btn-loader { display: block; }

  /* code display */
  .code-section {
    display: none;
    margin-top: 28px;
    animation: fadeUp 0.4s ease forwards;
  }
  .code-section.visible { display: block; }

  .code-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--accent);
    letter-spacing: 3px;
    text-transform: uppercase;
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .code-label::after { content: ''; flex: 1; height: 1px; background: var(--border); }

  .code-box {
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 14px;
    padding: 24px;
    text-align: center;
    box-shadow: 0 0 20px rgba(0,229,160,0.1);
    position: relative;
  }

  .code-digits {
    font-family: 'JetBrains Mono', monospace;
    font-size: clamp(28px, 8vw, 42px);
    font-weight: 600;
    letter-spacing: 12px;
    color: var(--accent);
    text-shadow: 0 0 20px rgba(0,229,160,0.4);
    display: block;
    margin-bottom: 6px;
  }

  .code-expire {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 2px;
  }
  .code-expire .timer { color: var(--danger); font-weight: 600; }

  .copy-btn {
    margin-top: 14px;
    width: auto;
    padding: 10px 24px;
    font-size: 13px;
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent);
    border-radius: 8px;
  }
  .copy-btn:hover { background: rgba(0,229,160,0.1) !important; opacity: 1 !important; }

  /* instructions */
  .instructions {
    margin-top: 28px;
    background: rgba(0,153,255,0.05);
    border: 1px solid rgba(0,153,255,0.15);
    border-radius: 14px;
    padding: 20px;
  }
  .instructions h3 {
    font-size: 13px;
    color: var(--accent2);
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 2px;
    text-transform: uppercase;
    margin-bottom: 14px;
  }
  .instructions ol {
    list-style: none;
    counter-reset: steps;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .instructions ol li {
    counter-increment: steps;
    font-size: 13.5px;
    color: #8a9db5;
    display: flex;
    gap: 12px;
    line-height: 1.5;
  }
  .instructions ol li::before {
    content: counter(steps);
    min-width: 22px; height: 22px;
    background: rgba(0,153,255,0.15);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--accent2);
    flex-shrink: 0;
    margin-top: 1px;
  }

  /* status / error */
  .status-msg {
    display: none;
    margin-top: 16px;
    padding: 12px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.5px;
  }
  .status-msg.error {
    display: block;
    background: rgba(255,69,96,0.1);
    border: 1px solid rgba(255,69,96,0.3);
    color: var(--danger);
  }
  .status-msg.success {
    display: block;
    background: rgba(0,229,160,0.08);
    border: 1px solid rgba(0,229,160,0.25);
    color: var(--accent);
  }

  /* connected state */
  .connected-banner {
    display: none;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin-top: 28px;
    padding: 24px;
    background: rgba(0,229,160,0.06);
    border: 1px solid rgba(0,229,160,0.3);
    border-radius: 14px;
    text-align: center;
    animation: fadeUp 0.4s ease forwards;
  }
  .connected-banner.visible { display: flex; }
  .connected-banner .tick {
    font-size: 40px;
    animation: pop 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards;
  }
  .connected-banner h2 { font-size: 18px; color: var(--accent); }
  .connected-banner p { font-size: 13px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }

  /* footer */
  .footer {
    margin-top: 40px;
    font-size: 12px;
    color: var(--muted);
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 1px;
    text-align: center;
    opacity: 0;
    animation: fadeUp 0.6s ease 0.6s forwards;
  }
  .footer a { color: var(--accent); text-decoration: none; }
  .footer a:hover { text-decoration: underline; }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes pop {
    from { transform: scale(0); }
    to   { transform: scale(1); }
  }
</style>
</head>
<body>
<div class="container">
  <div class="logo"><span>//</span> Eclipse MD <span>//</span></div>
  <h1>Pair Your Device</h1>
  <p class="subtitle">Link WhatsApp to Eclipse MD in seconds using a pairing code</p>

  <div class="card">
    <div class="step-label">Step 1 — Enter Number</div>

    <label>WHATSAPP NUMBER</label>
    <div class="input-wrap">
      <span class="flag">📱</span>
      <span class="prefix">+</span>
      <input type="text" id="phoneInput" placeholder="2348012345678" autocomplete="off" inputmode="numeric"/>
    </div>
    <p class="hint">Include country code, no spaces or dashes (e.g. 2348012345678)</p>

    <button id="pairBtn" onclick="requestCode()">
      <span class="btn-text">⚡ Generate Pairing Code</span>
      <div class="btn-loader"></div>
    </button>

    <div class="status-msg" id="statusMsg"></div>

    <div class="code-section" id="codeSection">
      <div class="code-label">Step 2 — Enter This Code</div>
      <div class="code-box">
        <span class="code-digits" id="codeDisplay">— — — —</span>
        <div class="code-expire">Expires in <span class="timer" id="timerDisplay">60s</span></div>
      </div>
      <button class="copy-btn" onclick="copyCode()">📋 Copy Code</button>
    </div>

    <div class="connected-banner" id="connectedBanner">
      <div class="tick">✅</div>
      <h2>Bot Connected!</h2>
      <p id="connectedNum"></p>
      <p style="margin-top:4px">Eclipse MD is now live on your WhatsApp</p>
    </div>

    <div class="instructions">
      <h3>How to pair</h3>
      <ol>
        <li>Enter your WhatsApp number with country code above</li>
        <li>Tap "Generate Pairing Code" and wait a moment</li>
        <li>Open WhatsApp → Settings → Linked Devices → Link a Device</li>
        <li>Tap "Link with phone number instead" and enter the code</li>
        <li>Eclipse MD will connect automatically — done! 🎉</li>
      </ol>
    </div>
  </div>

  <div class="footer">
    Eclipse MD v1 &nbsp;•&nbsp; Made with ❤ by <a href="https://github.com/horlapookie" target="_blank">horlapookie</a>
    &nbsp;•&nbsp; <a href="https://t.me/horlapookie" target="_blank">Telegram Support</a>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  let countdownInterval = null;
  let currentCode = '';

  // listen for pairing code from server
  socket.on('pairingCode', ({ code, phone }) => {
    currentCode = code;
    document.getElementById('codeDisplay').textContent = formatCode(code);
    document.getElementById('codeSection').classList.add('visible');
    startCountdown(60);
    setBtn(false);
    showStatus('');
  });

  // listen for successful connection
  socket.on('connected', ({ phone }) => {
    clearInterval(countdownInterval);
    document.getElementById('codeSection').classList.remove('visible');
    const banner = document.getElementById('connectedBanner');
    banner.classList.add('visible');
    document.getElementById('connectedNum').textContent = '+' + phone;
    showStatus('');
  });

  socket.on('pairError', ({ message }) => {
    showStatus(message, 'error');
    setBtn(false);
  });

  function formatCode(code) {
    // insert hyphen in middle e.g. ABCD-EFGH
    const c = code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return c.length >= 8 ? c.slice(0,4) + ' — ' + c.slice(4,8) : c;
  }

  async function requestCode() {
    const raw = document.getElementById('phoneInput').value.trim().replace(/[^0-9]/g, '');
    if (!raw || raw.length < 7) {
      showStatus('Please enter a valid phone number with country code.', 'error');
      return;
    }
    setBtn(true);
    showStatus('');
    document.getElementById('codeSection').classList.remove('visible');
    document.getElementById('connectedBanner').classList.remove('visible');
    clearInterval(countdownInterval);

    socket.emit('requestPairing', { phone: raw });
  }

  function setBtn(loading) {
    const btn = document.getElementById('pairBtn');
    btn.disabled = loading;
    btn.classList.toggle('loading', loading);
  }

  function showStatus(msg, type = '') {
    const el = document.getElementById('statusMsg');
    el.className = 'status-msg' + (type ? ' ' + type : '');
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  function startCountdown(seconds) {
    clearInterval(countdownInterval);
    let s = seconds;
    document.getElementById('timerDisplay').textContent = s + 's';
    countdownInterval = setInterval(() => {
      s--;
      document.getElementById('timerDisplay').textContent = s + 's';
      if (s <= 0) {
        clearInterval(countdownInterval);
        document.getElementById('timerDisplay').textContent = 'expired';
      }
    }, 1000);
  }

  async function copyCode() {
    if (!currentCode) return;
    try {
      await navigator.clipboard.writeText(currentCode);
      showStatus('Code copied to clipboard!', 'success');
      setTimeout(() => showStatus(''), 2500);
    } catch {
      showStatus('Copy manually: ' + currentCode, 'success');
    }
  }

  // allow pressing Enter in input
  document.getElementById('phoneInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') requestCode();
  });
</script>
</body>
</html>`;

// ─── Web Server + Socket.IO Pairing Logic ─────────────────────────────────────
function startPairingServer(botDir) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);

  app.get('/', (req, res) => res.send(PAIR_HTML));

  // Health check
  app.get('/health', (req, res) => res.json({ status: 'ok', bot: 'Eclipse MD' }));

  io.on('connection', (socket) => {
    console.log('🌐 Web client connected for pairing');

    socket.on('requestPairing', async ({ phone }) => {
      try {
        console.log(`📱 Pairing code requested for: +${phone}`);

        // Dynamically import Baileys from the bot's own node_modules
        const baileysPath = pathToFileURL(
          path.join(botDir, 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'index.js')
        ).href;

        let Baileys;
        try {
          Baileys = await import(baileysPath);
        } catch {
          // fallback to local node_modules
          Baileys = await import('@whiskeysockets/baileys');
        }

        const {
          default: makeWASocket,
          useMultiFileAuthState,
          DisconnectReason,
          makeCacheableSignalKeyStore,
          Browsers
        } = Baileys;

        const authFolder = path.join(__dirname, 'auth_info');
        if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authFolder);

        const sock = makeWASocket({
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, { level: 'silent' }),
          },
          printQRInTerminal: false,
          browser: Browsers.ubuntu('Eclipse MD'),
          logger: { level: 'silent', child: () => ({ level: 'silent', info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {} }) },
        });

        // Request the pairing code
        await new Promise(resolve => setTimeout(resolve, 2000)); // let socket settle
        const code = await sock.requestPairingCode(phone);
        console.log(`✅ Pairing code generated: ${code}`);

        socket.emit('pairingCode', { code, phone });
        await saveCreds();

        // Watch for successful connection
        sock.ev.on('connection.update', async (update) => {
          const { connection, lastDisconnect } = update;

          if (connection === 'open') {
            console.log(`✅ WhatsApp connected for +${phone}`);
            socket.emit('connected', { phone });
            await saveCreds();

            // Save the session so the main bot can use it
            const sessionIdPath = path.join(__dirname, 'SESSION-ID');
            fs.writeFileSync(sessionIdPath, phone);
            console.log('💾 Session saved.');

            sock.end(); // we only needed this socket for pairing
          }

          if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
              // not an error, just closed after pairing
            }
          }
        });

        sock.ev.on('creds.update', saveCreds);

      } catch (err) {
        console.error('❌ Pairing error:', err.message);
        socket.emit('pairError', { message: '❌ ' + (err.message || 'Failed to generate code. Try again.') });
      }
    });
  });

  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => {
    console.log(`\n🌐 ═══════════════════════════════════════`);
    console.log(`   Eclipse MD Pairing Server`);
    console.log(`   Open: http://localhost:${PORT}`);
    console.log(`🌐 ═══════════════════════════════════════\n`);
  });

  return io;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const extractDir = prepareFolderTree();

  if (!fs.existsSync(path.join(__dirname, 'auth_info')))
    fs.mkdirSync(path.join(__dirname, 'auth_info'), { recursive: true });

  await downloadAndExtractRepo(extractDir);

  const dirs = fs.readdirSync(extractDir).filter(d =>
    fs.statSync(path.join(extractDir, d)).isDirectory()
  );

  if (!dirs.length) {
    console.error('❌ Zip extracted nothing');
    process.exit(1);
  }

  const botDir = path.join(extractDir, dirs[0]);

  // Sync auth_info into bot directory
  const syncAuth = () => {
    const src = path.join(__dirname, 'auth_info');
    const dest = path.join(botDir, 'auth_info');
    if (fs.existsSync(src)) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true, force: true });
    }
  };

  // ── Start pairing web server ──
  const io = startPairingServer(botDir);

  // ── Check if already authenticated; if so, launch bot directly ──
  const credsPath = path.join(__dirname, 'auth_info', 'creds.json');
  if (fs.existsSync(credsPath)) {
    console.log('✅ Existing session found — launching Eclipse MD...');
    syncAuth();
    launchBot(botDir);
  } else {
    console.log('⏳ No session found. Waiting for pairing via web UI...');
    // Once connected via web, launch the bot
    io.on('connection', (socket) => {
      socket.on('requestPairing', () => {
        // After pairing completes, auth_info will be populated.
        // Watch for creds.json to appear, then launch.
        const watcher = fs.watch(path.join(__dirname, 'auth_info'), () => {
          if (fs.existsSync(credsPath)) {
            watcher.close();
            console.log('🚀 Pairing complete — launching Eclipse MD...');
            syncAuth();
            setTimeout(() => launchBot(botDir), 3000);
          }
        });
      });
    });
  }

  // Periodic sync every 10s
  setInterval(() => {
    try { syncAuth(); } catch {}
  }, 10000);
})();

async function launchBot(botDir) {
  try {
    process.chdir(botDir);
    process.env.VIPS_WARNING = '0';
    const entry = pathToFileURL(path.join(botDir, 'index.js')).href;
    await import(entry);
  } catch (err) {
    console.error('❌ Bot start error:', err.message);
  }
}
