// One-time script to generate placeholder 16x16 PNG tray icons.
// Uses a hand-rolled minimal PNG encoder so we don't add a dep.
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import zlib from 'zlib';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng16(rgb) {
  const W = 16, H = 16;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0; // filter type none
    for (let x = 0; x < W; x++) {
      raw[p++] = rgb[0];
      raw[p++] = rgb[1];
      raw[p++] = rgb[2];
      raw[p++] = 255;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const targets = {
  'resources/icons/tray-idle.png':  [128, 128, 128],
  'resources/icons/tray-ready.png': [240, 240, 240],
  'resources/icons/tray-live.png':  [80, 200, 80],
  'resources/icons/tray-error.png': [220, 60, 60],
};

for (const [path, rgb] of Object.entries(targets)) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, makePng16(rgb));
  console.log('wrote', path);
}
