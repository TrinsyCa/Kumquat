import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, degrees, rgb } from 'pdf-lib';
import { stem, uniquePath, makeDir, parseRanges, escapeHtml } from './util.js';
import { writeDocument } from './document.js';

const require = createRequire(import.meta.url);
const DPI = 300;

async function openWithPdfjs(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = path.dirname(require.resolve('pdfjs-dist/package.json')).replace('app.asar', 'app.asar.unpacked');
  return pdfjs.getDocument({
    data: new Uint8Array(await fsp.readFile(file)),
    standardFontDataUrl: pathToFileURL(path.join(root, 'standard_fonts')).href + '/',
    cMapUrl: pathToFileURL(path.join(root, 'cmaps')).href + '/',
    cMapPacked: true,
    wasmUrl: pathToFileURL(path.join(root, 'wasm')).href + '/',
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
}

async function renderPage(pdf, n, dpi = DPI) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const page = await pdf.getPage(n);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  page.cleanup();
  return { png: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height };
}

/** Renders every page; a single page becomes a file, several pages go into a folder. */
export async function renderPdfToImages(file, format, ctx, nameFrom = file) {
  const pdf = await openWithPdfjs(file);
  const count = pdf.numPages;
  const dir = count > 1 ? await makeDir(ctx.outDir(nameFrom), stem(nameFrom)) : ctx.outDir(nameFrom);
  const pad = String(count).length;
  let out;
  for (let n = 1; n <= count; n++) {
    const { png } = await renderPage(pdf, n);
    const name = count > 1 ? `${stem(nameFrom)} ${String(n).padStart(pad, '0')}` : stem(nameFrom);
    out = uniquePath(dir, name, format);
    const img = sharp(png).withMetadata({ density: DPI });
    await (format === 'jpg' ? img.jpeg({ quality: 92, mozjpeg: true }) : img.png()).toFile(out);
    ctx.progress(n / count);
  }
  await (pdf.destroy?.() ?? pdf.loadingTask?.destroy());
  return count > 1 ? dir : out;
}

/** Extracts text with basic layout recovery: lines, paragraphs, headings and table-like rows. */
async function extractPages(file, ctx) {
  const pdf = await openWithPdfjs(file);
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const items = content.items.filter((i) => i.str !== undefined && (i.str.trim() || i.hasEOL));
    const lines = [];
    for (const it of items) {
      const y = it.transform[5];
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      let line = lines.find((l) => Math.abs(l.y - y) < size * 0.5);
      if (!line) lines.push((line = { y, size, parts: [] }));
      line.size = Math.max(line.size, size);
      line.parts.push({ x: it.transform[4], w: it.width, str: it.str });
    }
    lines.sort((a, b) => b.y - a.y);
    for (const line of lines) {
      line.parts.sort((a, b) => a.x - b.x);
      line.cells = [];
      let cur = null;
      for (const p of line.parts) {
        const gap = cur ? p.x - (cur.end) : 0;
        if (!cur || gap > line.size * 2.2) line.cells.push((cur = { text: p.str, end: p.x + p.w }));
        else {
          cur.text += (gap > line.size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(p.str) ? ' ' : '') + p.str;
          cur.end = p.x + p.w;
        }
      }
      line.cells = line.cells.map((c) => c.text.trim()).filter(Boolean);
      line.text = line.cells.join('  ');
    }
    pages.push(lines.filter((l) => l.text));
    ctx.progress((n / pdf.numPages) * 0.7);
    page.cleanup();
  }
  await (pdf.destroy?.() ?? pdf.loadingTask?.destroy());
  return pages;
}

function pagesToHtml(pages) {
  const sizes = pages.flat().map((l) => l.size).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 10;
  return pages.map((lines) => {
    const blocks = [];
    let para = [];
    let rows = [];
    let prev = null;
    const flushPara = () => { if (para.length) blocks.push(`<p>${escapeHtml(para.join(' '))}</p>`); para = []; };
    const flushRows = () => {
      if (rows.length) blocks.push(`<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</table>`);
      rows = [];
    };
    for (const l of lines) {
      if (l.size > body * 1.35) {
        flushPara(); flushRows();
        const tag = l.size > body * 1.8 ? 'h1' : 'h2';
        blocks.push(`<${tag}>${escapeHtml(l.text)}</${tag}>`);
      } else if (l.cells.length > 1) {
        // Lines with widely spaced columns are most likely table rows.
        flushPara();
        rows.push(l.cells);
      } else {
        flushRows();
        if (prev && prev.y - l.y > l.size * 1.9) flushPara();
        para.push(l.text);
      }
      prev = l;
    }
    flushPara(); flushRows();
    return blocks.join('\n');
  }).join('\n<div class="page-break"></div>\n');
}

async function pdfToDocument(file, format, ctx) {
  const pages = await extractPages(file, ctx);
  if (!pages.some((p) => p.length)) throw new Error('No text found — this PDF looks scanned. Try converting it to images instead.');
  if (format === 'txt') {
    const out = uniquePath(ctx.outDir(file), stem(file), 'txt');
    await fsp.writeFile(out, pages.map((p) => p.map((l) => l.text).join('\n')).join('\n\f\n') + '\n');
    return out;
  }
  return writeDocument({ title: stem(file), body: pagesToHtml(pages) }, format, file, ctx);
}

async function pdfToXlsx(file, ctx) {
  const XLSX = require('xlsx');
  const pages = await extractPages(file, ctx);
  const wb = XLSX.utils.book_new();
  pages.forEach((lines, i) => {
    const rows = lines.map((l) => l.cells.map((c) => (/^-?[\d.,]+$/.test(c) && !Number.isNaN(+c.replace(/,/g, '')) ? +c.replace(/,/g, '') : c)));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.length ? rows : [[]]), `Page ${i + 1}`);
  });
  const out = uniquePath(ctx.outDir(file), stem(file), 'xlsx');
  XLSX.writeFile(wb, out);
  return out;
}

async function pdfToPptx(file, ctx) {
  const PptxGenJS = require('pptxgenjs');
  const pdf = await openWithPdfjs(file);
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  const pptx = new PptxGenJS();
  const w = 10;
  const h = (first.height / first.width) * w;
  pptx.defineLayout({ name: 'PDF', width: w, height: h });
  pptx.layout = 'PDF';
  for (let n = 1; n <= pdf.numPages; n++) {
    const { png } = await renderPage(pdf, n, 200);
    const slide = pptx.addSlide();
    slide.addImage({ data: `data:image/png;base64,${png.toString('base64')}`, x: 0, y: 0, w, h });
    ctx.progress((n / pdf.numPages) * 0.9);
  }
  await (pdf.destroy?.() ?? pdf.loadingTask?.destroy());
  const out = uniquePath(ctx.outDir(file), stem(file), 'pptx');
  await fsp.writeFile(out, await pptx.write({ outputType: 'nodebuffer' }));
  return out;
}

async function loadPdf(file) {
  return PDFDocument.load(await fsp.readFile(file), { ignoreEncryption: true });
}

async function savePdf(doc, file, ctx, suffix) {
  const out = uniquePath(ctx.outDir(file), `${stem(file)} (${suffix})`, 'pdf');
  await fsp.writeFile(out, await doc.save({ useObjectStreams: true }));
  return out;
}

async function pickPages(file, ctx, spec, suffix, invert = false) {
  const src = await loadPdf(file);
  const selected = new Set(parseRanges(spec, src.getPageCount()));
  const indexes = src.getPageIndices().filter((i) => selected.has(i) !== invert);
  if (!indexes.length) throw new Error('That would leave an empty PDF');
  const doc = await PDFDocument.create();
  for (const page of await doc.copyPages(src, indexes)) doc.addPage(page);
  return savePdf(doc, file, ctx, suffix);
}

/** Re-encodes embedded JPEG images at lower quality/resolution; text and vectors stay untouched. */
async function compressPdf(file, ctx, quality, maxDim) {
  const doc = await loadPdf(file);
  const objects = doc.context.enumerateIndirectObjects();
  let done = 0;
  for (const [ref, obj] of objects) {
    done++;
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    if (dict.get(PDFName.of('Filter')) !== PDFName.of('DCTDecode')) continue;
    if (dict.get(PDFName.of('ColorSpace')) === PDFName.of('DeviceCMYK')) continue;
    try {
      const img = sharp(Buffer.from(obj.contents));
      const meta = await img.metadata();
      const scale = Math.min(1, maxDim / Math.max(meta.width, meta.height));
      const width = Math.round(meta.width * scale);
      const height = Math.round(meta.height * scale);
      const pipeline = scale < 1 ? img.resize(width, height) : img;
      const gray = dict.get(PDFName.of('ColorSpace')) === PDFName.of('DeviceGray');
      const data = await (gray ? pipeline.grayscale() : pipeline.toColourspace('srgb')).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (data.length >= obj.contents.length) continue;
      dict.set(PDFName.of('Width'), PDFNumber.of(width));
      dict.set(PDFName.of('Height'), PDFNumber.of(height));
      dict.set(PDFName.of('Length'), PDFNumber.of(data.length));
      dict.delete(PDFName.of('DecodeParms'));
      doc.context.assign(ref, PDFRawStream.of(dict, data));
    } catch {
      // Leave images we cannot decode as they are.
    }
    ctx.progress((done / objects.length) * 0.9);
  }
  return savePdf(doc, file, ctx, 'compressed');
}

const pageParam = (def, label) => ({ key: 'pages', type: 'text', default: def, placeholder: '1-3, 5', label });

export const operations = [
  ...['png', 'jpg'].map((format) => ({
    id: `pdf.to.${format}`,
    group: 'convert',
    kinds: ['pdf'],
    label: format.toUpperCase(),
    each: (file, p, ctx) => renderPdfToImages(file, format, ctx),
  })),
  ...['docx', 'txt', 'md', 'html', 'epub'].map((format) => ({
    id: `pdf.to.${format}`,
    group: 'convert',
    kinds: ['pdf'],
    label: format === 'md' ? 'Markdown' : format.toUpperCase(),
    each: (file, p, ctx) => pdfToDocument(file, format, ctx),
  })),
  { id: 'pdf.to.xlsx', group: 'convert', kinds: ['pdf'], label: 'XLSX', each: (file, p, ctx) => pdfToXlsx(file, ctx) },
  { id: 'pdf.to.pptx', group: 'convert', kinds: ['pdf'], label: 'PPTX', each: (file, p, ctx) => pdfToPptx(file, ctx) },

  // ---- Tools ----
  {
    id: 'pdf.compress',
    group: 'tools',
    kinds: ['pdf'],
    icon: 'compress',
    label: { en: 'Compress', tr: 'Sıkıştır' },
    params: [{ key: 'level', type: 'select', default: 'medium', options: ['light', 'medium', 'strong'], labels: { light: { en: 'Light', tr: 'Hafif' }, medium: { en: 'Medium', tr: 'Orta' }, strong: { en: 'Strong', tr: 'Güçlü' } }, label: { en: 'Level', tr: 'Seviye' } }],
    each: (file, p, ctx) => {
      const [q, dim] = { light: [80, 3000], medium: [65, 2000], strong: [45, 1400] }[p.level] ?? [65, 2000];
      return compressPdf(file, ctx, q, dim);
    },
  },
  {
    id: 'pdf.merge',
    group: 'tools',
    kinds: ['pdf', 'image'],
    minFiles: 2,
    requireKind: 'pdf',
    icon: 'merge',
    label: { en: 'Merge', tr: 'Birleştir' },
    all: async (files, p, ctx) => {
      const { load } = await import('./image.js');
      const doc = await PDFDocument.create();
      for (const [i, f] of files.entries()) {
        if (f.toLowerCase().endsWith('.pdf')) {
          const src = await loadPdf(f);
          for (const page of await doc.copyPages(src, src.getPageIndices())) doc.addPage(page);
        } else {
          const jpg = await (await load(f)).autoOrient().flatten({ background: '#fff' }).jpeg({ quality: 92 }).toBuffer();
          const img = await doc.embedJpg(jpg);
          doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        }
        ctx.progress((i + 1) / files.length);
      }
      return [await savePdf(doc, files[0], ctx, 'merged')];
    },
  },
  {
    id: 'pdf.split',
    group: 'tools',
    kinds: ['pdf'],
    icon: 'split',
    label: { en: 'Split', tr: 'Böl' },
    params: [{ key: 'every', type: 'number', default: 1, min: 1, step: 1, label: { en: 'Pages per file', tr: 'Dosya başına sayfa' } }],
    each: async (file, p, ctx) => {
      const src = await loadPdf(file);
      const count = src.getPageCount();
      const every = Math.max(1, Math.floor(+p.every || 1));
      const dir = await makeDir(ctx.outDir(file), `${stem(file)} (split)`);
      for (let start = 0; start < count; start += every) {
        const doc = await PDFDocument.create();
        const idx = src.getPageIndices().slice(start, start + every);
        for (const page of await doc.copyPages(src, idx)) doc.addPage(page);
        const label = idx.length > 1 ? `${start + 1}-${start + idx.length}` : `${start + 1}`;
        await fsp.writeFile(uniquePath(dir, `${stem(file)} ${label}`, 'pdf'), await doc.save());
        ctx.progress(Math.min(1, (start + every) / count));
      }
      return dir;
    },
  },
  {
    id: 'pdf.extract',
    group: 'tools',
    kinds: ['pdf'],
    icon: 'pages',
    label: { en: 'Extract pages', tr: 'Sayfa çıkar' },
    params: [pageParam('1', { en: 'Pages to keep', tr: 'Tutulacak sayfalar' })],
    each: (file, p, ctx) => pickPages(file, ctx, p.pages, 'pages'),
  },
  {
    id: 'pdf.delete',
    group: 'tools',
    kinds: ['pdf'],
    icon: 'trash',
    label: { en: 'Delete pages', tr: 'Sayfa sil' },
    params: [pageParam('1', { en: 'Pages to delete', tr: 'Silinecek sayfalar' })],
    each: (file, p, ctx) => pickPages(file, ctx, p.pages, 'edited', true),
  },
  {
    id: 'pdf.rotate',
    group: 'tools',
    kinds: ['pdf'],
    icon: 'rotate-cw',
    label: { en: 'Rotate', tr: 'Döndür' },
    params: [
      { key: 'angle', type: 'select', default: '90', options: ['90', '180', '270'], unit: '°', label: { en: 'Angle', tr: 'Açı' } },
      pageParam('1-', { en: 'Pages', tr: 'Sayfalar' }),
    ],
    each: async (file, p, ctx) => {
      const doc = await loadPdf(file);
      for (const i of parseRanges(p.pages, doc.getPageCount())) {
        const page = doc.getPage(i);
        page.setRotation(degrees((page.getRotation().angle + +p.angle) % 360));
      }
      return savePdf(doc, file, ctx, 'rotated');
    },
  },
  {
    id: 'pdf.number',
    group: 'tools',
    kinds: ['pdf'],
    icon: 'hash',
    label: { en: 'Page numbers', tr: 'Sayfa numarası' },
    each: async (file, p, ctx) => {
      const doc = await loadPdf(file);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pages = doc.getPages();
      pages.forEach((page, i) => {
        const { width } = page.getSize();
        const text = `${i + 1} / ${pages.length}`;
        page.drawText(text, { x: width / 2 - font.widthOfTextAtSize(text, 9) / 2, y: 18, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
      });
      return savePdf(doc, file, ctx, 'numbered');
    },
  },
  {
    id: 'pdf.watermark',
    group: 'tools',
    kinds: ['pdf'],
    icon: 'stamp',
    label: { en: 'Watermark', tr: 'Filigran' },
    params: [{ key: 'text', type: 'text', default: 'CONFIDENTIAL', label: { en: 'Text', tr: 'Metin' } }],
    each: async (file, p, ctx) => {
      const doc = await loadPdf(file);
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      // Standard PDF fonts only cover WinAnsi; fold accents so e.g. Turkish text still renders.
      const text = String(p.text || 'CONFIDENTIAL').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/[^\x20-\x7e]/g, '');
      for (const page of doc.getPages()) {
        const { width, height } = page.getSize();
        const size = Math.min(width, height) / Math.max(4, text.length * 0.62);
        const tw = font.widthOfTextAtSize(text, size);
        const angle = Math.atan2(height, width);
        page.drawText(text, {
          x: width / 2 - (tw / 2) * Math.cos(angle) + (size / 3) * Math.sin(angle),
          y: height / 2 - (tw / 2) * Math.sin(angle) - (size / 3) * Math.cos(angle),
          size, font, color: rgb(0.85, 0.2, 0.1), opacity: 0.18, rotate: degrees((angle * 180) / Math.PI),
        });
      }
      return savePdf(doc, file, ctx, 'watermarked');
    },
  },
];
