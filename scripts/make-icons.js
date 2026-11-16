'use strict';

// Generates the PWA icons (192px and 512px PNGs): navy tile with an amber "RD" monogram.
// No image libraries needed: PNG is written with zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const NAVY = [30, 58, 138];
const AMBER = [251, 191, 36];

// Monogram drawn as filled rectangles on a 5x7 grid per letter, scaled to the icon.
const LETTERS = {
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
};

function inLetter(letter, x, y, size) {
  const rows = LETTERS[letter];
  const cell = Math.floor(size * 0.09);
  const cols = 5;
  const w = cols * cell;
  const h = rows.length * cell;
  const left = (size - (w * 2 + cell)) / 2 + (letter === 'D' ? w + cell : 0);
  const top = (size - h) / 2;
  const cx = Math.floor((x - left) / cell);
  const cy = Math.floor((y - top) / cell);
  if (x < left || y < top || cx < 0 || cx >= cols || cy < 0 || cy >= rows.length) return false;
  return rows[cy][cx] === '1';
}

function pixel(x, y, size) {
  const radius = size * 0.18;
  const dx = Math.max(radius - x, 0, x - (size - radius));
  const dy = Math.max(radius - y, 0, y - (size - radius));
  if (dx * dx + dy * dy > radius * radius) return [255, 255, 255, 0];
  if (inLetter('R', x, y, size) || inLetter('D', x, y, size)) return [...AMBER, 255];
  return [...NAVY, 255];
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png(size));
  console.log(`wrote icon-${size}.png`);
}