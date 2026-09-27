const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Minimalistic pure Node PNG generator
function createPNG(width, height, pixelFn) {
  // 4 bytes per pixel: RGBA
  const rowSize = width * 4 + 1; // +1 for filter byte (0)
  const rawData = Buffer.alloc(height * rowSize);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const pixelOffset = rowOffset + 1 + x * 4;
      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(rawData);

  // PNG Signature: 89 50 4E 47 0D 0A 1A 0A
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR Chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth: 8
  ihdr[9] = 6; // Color type: 6 (RGBA)
  ihdr[10] = 0; // Compression method: 0
  ihdr[11] = 0; // Filter method: 0
  ihdr[12] = 0; // Interlace method: 0
  const ihdrChunk = createChunk('IHDR', ihdr);

  // IDAT Chunk
  const idatChunk = createChunk('IDAT', compressed);

  // IEND Chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(4 + 4 + len + 4);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);

  const crc = calculateCRC(chunk.subarray(4, 8 + len));
  chunk.writeInt32BE(crc, 8 + len);
  return chunk;
}

// CRC32 table
let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    crcTable[n] = c;
  }
  return crcTable;
}

function calculateCRC(buf) {
  const table = getCrcTable();
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc ^ -1;
}

// Minimalist Dieter Rams / Braun / Apple trackpad icon renderer
function drawIcon(x, y, w, h) {
  // Normalized coords -1 to 1
  const nx = (x / w) * 2 - 1;
  const ny = (y / h) * 2 - 1;

  // Squircle background corner radius
  const cornerR = 0.82;
  const distSq = Math.pow(Math.abs(nx), 4) + Math.pow(Math.abs(ny), 4);
  if (distSq > cornerR) {
    // Outside icon shape
    return [0, 0, 0, 0];
  }

  // Base icon background: Graphite dark `#18181B`
  let r = 24, g = 24, b = 27, a = 255;

  // Trackpad glass surface inside
  const padX = Math.abs(nx);
  const padY = Math.abs(ny);
  if (padX < 0.72 && padY < 0.72) {
    // Inner trackpad surface: deep matte titanium
    r = 39; g = 39; b = 42;

    // Trackpad border
    if (padX > 0.68 || padY > 0.68) {
      r = 63; g = 63; b = 70;
    }

    // Central gesture icon: 4 directional smooth arrows / scroll touch indicator
    const cx = nx;
    const cy = ny;
    const dCenter = Math.sqrt(cx * cx + cy * cy);

    // Touch dot in center: Emerald glow `#10B981`
    if (dCenter < 0.16) {
      r = 16; g = 185; b = 129; // Emerald #10B981
    } else if (dCenter < 0.22) {
      r = 52; g = 211; b = 153; // Soft emerald ring
      a = 200;
    }

    // Directional pan subtle indicators (cross dots)
    const isArrow = (
      (Math.abs(cx) < 0.05 && Math.abs(cy) > 0.32 && Math.abs(cy) < 0.48) ||
      (Math.abs(cy) < 0.05 && Math.abs(cx) > 0.32 && Math.abs(cx) < 0.48)
    );
    if (isArrow) {
      r = 244; g = 244; b = 245; // Clean white/ivory
    }
  }

  return [r, g, b, a];
}

// Generate icons
const sizes = [
  { dir: 'extension/icons', name: 'icon16.png', size: 16 },
  { dir: 'extension/icons', name: 'icon32.png', size: 32 },
  { dir: 'extension/icons', name: 'icon48.png', size: 48 },
  { dir: 'extension/icons', name: 'icon128.png', size: 128 },
  { dir: 'mobile/icons', name: 'icon-192.png', size: 192 },
  { dir: 'mobile/icons', name: 'icon-512.png', size: 512 }
];

for (const item of sizes) {
  const buf = createPNG(item.size, item.size, drawIcon);
  const outPath = path.join(item.dir, item.name);
  fs.writeFileSync(outPath, buf);
  console.log(`Generated ${outPath} (${item.size}x${item.size})`);
}
