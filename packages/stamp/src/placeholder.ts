/**
 * Programmatic placeholder images: abstract colour fields with no faces or likenesses, standing
 * in for AI output in tests and the demo.
 */

import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An RGB PNG with a seeded diagonal gradient and stripes. */
export function placeholderPng(width: number, height: number, seed: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, RGB, deflate, no filter method, no interlace

  const hue = (seed * 97) % 256;
  const rows = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    rows[row] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const stripe = Math.floor((x + y + seed * 7) / 8) % 2 === 0 ? 40 : 0;
      const i = row + 1 + x * 3;
      rows[i] = (hue + Math.floor((x * 255) / width)) % 256;
      rows[i + 1] = (Math.floor((y * 255) / height) + stripe) % 256;
      rows[i + 2] = (255 - hue + stripe) % 256;
    }
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
