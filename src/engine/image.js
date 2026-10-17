import fsp from 'node:fs/promises';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { ext, stem, uniquePath } from './util.js';


/** Returns a sharp pipeline for any supported image, decoding HEIC/BMP/ICO first. */
export async function load(file) {
  const e = ext(file);
  if (e === 'heic' || e === 'heif') {
    const { default: convert } = await import('heic-convert');
    const png = await convert({ buffer: await fsp.readFile(file), format: 'PNG' });
    return sharp(Buffer.from(png));
  }
  if (e === 'bmp' || e === 'ico') {
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const img = await loadImage(await fsp.readFile(file));
    const canvas = createCanvas(img.width, img.height);
    canvas.getContext('2d').drawImage(img, 0, 0);
    return sharp(canvas.toBuffer('image/png'));
  }
  if (e === 'svg') return sharp(file, { density: 300 });
  return sharp(file, { animated: e === 'gif' || e === 'webp' });
}

const ENCODERS = {
  jpg: (s, q = 90) => s.flatten({ background: '#ffffff' }).jpeg({ quality: q, mozjpeg: true }),
  png: (s) => s.png({ compressionLevel: 9 }),
  webp: (s, q = 85) => s.webp({ quality: q }),
  avif: (s, q = 60) => s.avif({ quality: q }),
  tiff: (s) => s.tiff({ compression: 'lzw' }),
  gif: (s) => s.gif(),
};

async function writeAs(pipeline, file, format, ctx, quality) {
  const out = uniquePath(ctx.outDir(file), stem(file), format);
  await ENCODERS[format](pipeline, quality).toFile(out);
  return out;
}

/** Builds a minimal .ico file containing PNG-encoded frames. */
async function toIco(file, ctx) {
  const base = (await load(file)).ensureAlpha();
  const sizes = [16, 32, 48, 64, 128, 256];
  const frames = await Promise.all(
    sizes.map((s) => base.clone().resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer())
  );
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((data, i) => {
    const o = 6 + i * 16;
    header.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], o);
    header.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], o + 1);
    header.writeUInt16LE(1, o + 4);
    header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(data.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  const out = uniquePath(ctx.outDir(file), stem(file), 'ico');
  await fsp.writeFile(out, Buffer.concat([header, ...frames]));
  return out;
}

/** Combines one or more images into a single PDF, one image per page. */
export async function imagesToPdf(files, ctx, name) {
  const doc = await PDFDocument.create();
  for (const [i, file] of files.entries()) {
    const jpg = await (await load(file)).autoOrient().flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
    const img = await doc.embedJpg(jpg.data);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    ctx.progress((i + 1) / files.length);
  }
  const out = uniquePath(ctx.outDir(files[0]), name ?? stem(files[0]), 'pdf');
  await fsp.writeFile(out, await doc.save());
  return out;
}

const targets = ['jpg', 'png', 'webp', 'avif', 'tiff', 'gif'];

export const operations = [
  ...targets.map((format) => ({
    id: `image.to.${format}`,
    group: 'convert',
    kinds: ['image'],
    label: format === 'tiff' ? 'TIFF' : format.toUpperCase(),
    skipExt: format === 'jpg' ? ['jpg', 'jpeg'] : format === 'tiff' ? ['tif', 'tiff'] : [format],
    each: async (file, p, ctx) => writeAs((await load(file)).autoOrient(), file, format, ctx),
  })),
  {
    id: 'image.to.ico',
    group: 'convert',
    kinds: ['image'],
    label: 'ICO',
    skipExt: ['ico'],
    each: (file, p, ctx) => toIco(file, ctx),
  },
  {
    id: 'image.to.pdf',
    group: 'convert',
    kinds: ['image'],
    label: 'PDF',
    each: (file, p, ctx) => imagesToPdf([file], ctx),
  },

  // ---- Tools ----
  {
    id: 'image.compress',
    group: 'tools',
    kinds: ['image'],
    icon: 'compress',
    label: { en: 'Compress', tr: 'Sıkıştır' },
    params: [{ key: 'quality', type: 'range', min: 30, max: 95, default: 72, label: { en: 'Quality', tr: 'Kalite' } }],
    each: async (file, p, ctx) => {
      let format = ext(file);
      if (format === 'jpeg') format = 'jpg';
      if (!['jpg', 'png', 'webp', 'avif'].includes(format)) format = 'jpg';
      const img = (await load(file)).autoOrient();
      const out = uniquePath(ctx.outDir(file), `${stem(file)} (compressed)`, format);
      if (format === 'png') await img.png({ palette: true, quality: +p.quality, compressionLevel: 9, effort: 8 }).toFile(out);
      else await ENCODERS[format](img, +p.quality).toFile(out);
      return out;
    },
  },
  {
    id: 'image.resize',
    group: 'tools',
    kinds: ['image'],
    icon: 'resize',
    label: { en: 'Resize', tr: 'Boyutlandır' },
    params: [
      { key: 'percent', type: 'range', min: 5, max: 200, default: 50, unit: '%', label: { en: 'Scale', tr: 'Ölçek' } },
    ],
    each: async (file, p, ctx) => {
      const img = (await load(file)).autoOrient();
      const { width } = await img.clone().metadata();
      const format = outputFormat(file);
      const out = uniquePath(ctx.outDir(file), `${stem(file)} (${p.percent}%)`, format);
      await ENCODERS[format](img.resize(Math.max(1, Math.round((width * p.percent) / 100)))).toFile(out);
      return out;
    },
  },
  transformTool('image.rotate-right', 'rotate-cw', { en: 'Rotate right', tr: 'Sağa döndür' }, 'rotated', (s) => s.autoOrient().rotate(90)),
  transformTool('image.rotate-left', 'rotate-ccw', { en: 'Rotate left', tr: 'Sola döndür' }, 'rotated', (s) => s.autoOrient().rotate(-90)),
  transformTool('image.flip', 'flip', { en: 'Mirror', tr: 'Aynala' }, 'mirrored', (s) => s.autoOrient().flop()),
  transformTool('image.grayscale', 'contrast', { en: 'Grayscale', tr: 'Siyah beyaz' }, 'grayscale', (s) => s.autoOrient().grayscale()),
  {
    id: 'image.square',
    group: 'tools',
    kinds: ['image'],
    icon: 'crop',
    label: { en: 'Crop square', tr: 'Kare kırp' },
    each: async (file, p, ctx) => {
      const img = (await load(file)).autoOrient();
      const buf = await img.toBuffer({ resolveWithObject: true });
      const size = Math.min(buf.info.width, buf.info.height);
      const format = outputFormat(file);
      const out = uniquePath(ctx.outDir(file), `${stem(file)} (square)`, format);
      await ENCODERS[format](sharp(buf.data).resize(size, size, { fit: 'cover', position: 'attention' })).toFile(out);
      return out;
    },
  },
  transformTool('image.strip', 'shield', { en: 'Remove metadata', tr: 'Meta veriyi sil' }, 'clean', (s) => s.autoOrient()),
  {
    id: 'image.merge-pdf',
    group: 'tools',
    kinds: ['image'],
    minFiles: 2,
    icon: 'merge',
    label: { en: 'Merge into PDF', tr: "PDF'te birleştir" },
    all: async (files, p, ctx) => [await imagesToPdf(files, ctx, `${stem(files[0])} (merged)`)],
  },
];

function outputFormat(file) {
  const e = ext(file);
  if (e === 'jpeg') return 'jpg';
  if (e === 'tif') return 'tiff';
  return ENCODERS[e] ? e : 'png';
}

function transformTool(id, icon, label, suffix, fn) {
  return {
    id,
    group: 'tools',
    kinds: ['image'],
    icon,
    label,
    each: async (file, p, ctx) => {
      const format = outputFormat(file);
      const out = uniquePath(ctx.outDir(file), `${stem(file)} (${suffix})`, format);
      // sharp drops metadata unless withMetadata() is called, so every transform also strips EXIF/GPS.
      await ENCODERS[format](fn(await load(file))).toFile(out);
      return out;
    },
  };
}

