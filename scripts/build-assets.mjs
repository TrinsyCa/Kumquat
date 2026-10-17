// Renders assets/icon.svg into the PNG/ICO files used by the app and the installers.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const dir = path.join(import.meta.dirname, '..', 'assets');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'));
const render = (size) => sharp(svg, { density: Math.ceil((72 * size) / 1024) * 2 }).resize(size, size).png().toBuffer();

fs.writeFileSync(path.join(dir, 'icon.png'), await render(1024));
fs.writeFileSync(path.join(dir, 'tray.png'), await render(32));
fs.writeFileSync(path.join(dir, 'tray@2x.png'), await render(64));
fs.mkdirSync(path.join(dir, 'icons'), { recursive: true });
for (const s of [16, 32, 48, 64, 128, 256, 512]) fs.writeFileSync(path.join(dir, 'icons', `${s}x${s}.png`), await render(s));

// Windows .ico with PNG frames
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = await Promise.all(sizes.map(render));
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach((data, i) => {
  const o = 6 + i * 16;
  header.writeUInt8(sizes[i] % 256, o);
  header.writeUInt8(sizes[i] % 256, o + 1);
  header.writeUInt16LE(1, o + 4);
  header.writeUInt16LE(32, o + 6);
  header.writeUInt32LE(data.length, o + 8);
  header.writeUInt32LE(offset, o + 12);
  offset += data.length;
});
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, ...frames]));
console.log('Assets written to', dir);
