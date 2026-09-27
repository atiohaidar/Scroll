/**
 * Scroll Local Companion Server (Zero Dependencies)
 * Automatically detects LAN Wi-Fi IP, serves mobile trackpad PWA,
 * and provides pairing endpoint for the Chrome Extension.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const MOBILE_DIR = path.join(__dirname, 'mobile');

// MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Find local Wi-Fi / LAN IP address
function getLocalNetworkIp() {
  const interfaces = os.networkInterfaces();
  let localIp = 'localhost';

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // IPv4 and not internal loopback (127.0.0.1)
      if (iface.family === 'IPv4' && !iface.internal) {
        // Prioritize Wi-Fi or Ethernet
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.')) {
          return iface.address;
        }
        localIp = iface.address;
      }
    }
  }
  return localIp;
}

const localIp = getLocalNetworkIp();
const mobileUrl = `http://${localIp}:${PORT}`;

// Create HTTP Server
const server = http.createServer((req, res) => {
  // CORS Headers for extension queries
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsedUrl.pathname;

  // Telemetry / Discovery API endpoint
  if (pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: '1.0.0',
      localIp: localIp,
      port: PORT,
      mobileUrl: mobileUrl
    }));
    return;
  }

  // Static file serving from mobile/
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(MOBILE_DIR, safePath);

  // Security check: ensure path is within MOBILE_DIR
  if (!filePath.startsWith(MOBILE_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n============================================================');
  console.log('   SCROLL — Remote Glass Trackpad for Browser');
  console.log('============================================================\n');
  console.log(`  Local host:    http://localhost:${PORT}`);
  console.log(`  Phone Wi-Fi:   ${mobileUrl}`);
  console.log('\n------------------------------------------------------------');
  console.log('  CHROME EXTENSION SETUP:');
  console.log('  1. Open Chrome -> chrome://extensions/');
  console.log('  2. Enable "Developer mode" (top right)');
  console.log('  3. Click "Load unpacked" -> Select:');
  console.log(`     ${path.join(__dirname, 'extension')}`);
  console.log('  4. Click the Scroll icon in your toolbar, then scan the QR code!');
  console.log('============================================================\n');
});
