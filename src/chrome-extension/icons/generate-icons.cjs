/**
 * Generate minimal valid PNG icon files for the Chrome extension.
 *
 * Run: node icons/generate-icons.js
 *
 * Creates solid-color PNG files at 16, 32, 48, and 128 pixels.
 * No external dependencies required.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Brand color #4a6cf7 -> RGB(74, 108, 247)
const COLOR = { r: 74, g: 108, b: 247 };

function crc32(buf) {
  let crc = 0xffffffff;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([length, typeBytes, data, crc]);
}

function generatePNG(size) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);   // width
  ihdr.writeUInt32BE(size, 4);   // height
  ihdr.writeUInt8(8, 8);         // bit depth
  ihdr.writeUInt8(2, 9);         // color type: RGB
  ihdr.writeUInt8(0, 10);        // compression
  ihdr.writeUInt8(0, 11);        // filter
  ihdr.writeUInt8(0, 12);        // interlace

  // Image data: create a simple icon with a rounded-rect look
  // Each row: filter byte (0) + RGB pixels
  const rawRows = [];
  const center = size / 2;
  const radius = size * 0.15;    // corner radius ratio
  const margin = size * 0.08;    // margin from edge
  const inner = size - margin * 2;

  for (let y = 0; y < size; y++) {
    const row = [0]; // filter: none
    for (let x = 0; x < size; x++) {
      // Check if inside rounded rect
      const rx = x - margin;
      const ry = y - margin;
      let inside = false;

      if (rx >= 0 && rx < inner && ry >= 0 && ry < inner) {
        // Check corners for rounding
        const corners = [
          [0, 0],
          [inner, 0],
          [0, inner],
          [inner, inner],
        ];
        inside = true;
        for (const [cx, cy] of corners) {
          const dx = Math.abs(rx - cx) < radius ? rx - cx : 0;
          const dy = Math.abs(ry - cy) < radius ? ry - cy : 0;
          if (
            Math.abs(rx - cx) < radius &&
            Math.abs(ry - cy) < radius &&
            dx * dx + dy * dy > radius * radius
          ) {
            inside = false;
            break;
          }
        }
      }

      if (inside) {
        // Draw some white lines to suggest "slides" content
        const relY = (y - margin) / inner;
        const relX = (x - margin) / inner;

        const isLine1 = relY > 0.3 && relY < 0.38 && relX > 0.2 && relX < 0.8;
        const isLine2 = relY > 0.45 && relY < 0.53 && relX > 0.2 && relX < 0.65;
        const isLine3 = relY > 0.6 && relY < 0.68 && relX > 0.2 && relX < 0.72;

        if (isLine1 || isLine2 || isLine3) {
          row.push(255, 255, 255); // white lines
        } else {
          row.push(COLOR.r, COLOR.g, COLOR.b);
        }
      } else {
        row.push(0, 0, 0, ); // transparent-ish (will appear as black on non-alpha PNG)
        // Actually since we're RGB not RGBA, use white for background
        row.pop(); // remove the extra 0
        row.push(255, 255, 255); // white background
      }
    }
    rawRows.push(Buffer.from(row));
  }

  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData);

  const ihdrChunk = createChunk('IHDR', ihdr);
  const idatChunk = createChunk('IDAT', compressed);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Generate all sizes
const sizes = [16, 32, 48, 128];
const dir = __dirname;

for (const size of sizes) {
  const png = generatePNG(size);
  const filePath = path.join(dir, `icon-${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Generated ${filePath} (${png.length} bytes)`);
}

console.log('Done! All icons generated.');
