// Engine smoke test: builds sample files, then runs every applicable operation on them.
// Usage: node test/smoke.mjs [filter]      (HTML→PDF steps are skipped outside Electron)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createRequire } from 'node:module';
import { getOptions, runOperation } from '../src/engine/index.js';
import { ffmpeg } from '../src/engine/util.js';
import { pack } from '../src/engine/archive.js';

const require = createRequire(import.meta.url);
const filter = process.argv[2] ?? '';
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kumquat-smoke-'));
const src = path.join(root, 'src');
await fsp.mkdir(src);
const f = (name) => path.join(src, name);

async function fixtures(htmlToPdf) {
  await sharp({ create: { width: 640, height: 400, channels: 3, background: '#ff8a1f' } })
    .composite([{ input: Buffer.from('<svg width="640" height="400"><circle cx="320" cy="200" r="120" fill="#2b7a0b"/></svg>') }])
    .jpeg().toFile(f('photo.jpg'));
  await sharp(f('photo.jpg')).png().toFile(f('graphic.png'));
  await fsp.writeFile(f('logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="orange"/></svg>');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', f('tone.wav')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=3', '-shortest', '-pix_fmt', 'yuv420p', f('clip.mp4')]);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Chapter ${i}`, { x: 50, y: 780, size: 26, font });
    page.drawText('Name        Qty        Price', { x: 50, y: 720, size: 11, font });
    page.drawText(`Kumquat     ${i * 3}          ${i * 1.5}`, { x: 50, y: 700, size: 11, font });
    page.drawText('Lorem ipsum dolor sit amet, consectetur adipiscing elit.', { x: 50, y: 650, size: 11, font });
  }
  const jpg = await doc.embedJpg(await fsp.readFile(f('photo.jpg')));
  doc.getPage(0).drawImage(jpg, { x: 50, y: 300, width: 320, height: 200 });
  await fsp.writeFile(f('report.pdf'), await doc.save());
  await fsp.writeFile(f('notes.md'), '# Kumquat\n\nA **tiny** citrus.\n\n- Tart\n- Sweet skin\n\n## Uses\n\nMarmalade ğüşıöç.\n');
  await fsp.writeFile(f('plain.txt'), 'Hello from Kumquat.\n\nSecond paragraph with Türkçe karakterler.\n');
  await fsp.writeFile(f('page.html'), '<html><head><title>Page</title></head><body><h1>Hi</h1><p>HTML <em>input</em></p></body></html>');
  await fsp.writeFile(f('letter.rtf'), '{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0 Dear reader,\\par Caf\\\'e9 \\u351?ehir\\par}');
  const HTMLtoDOCX = require('@turbodocx/html-to-docx');
  await fsp.writeFile(f('essay.docx'), await HTMLtoDOCX('<h1>Essay</h1><p>Paragraph <b>one</b>.</p><ul><li>a</li><li>b</li></ul>'));
  await fsp.writeFile(f('data.csv'), 'name,qty,price\nKumquat,3,1.5\nYuzu,2,4\nŞeftali,5,2\n');
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), 'One');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['c'], [3]]), 'Two');
  XLSX.writeFile(wb, f('book.xlsx'));
  await fsp.writeFile(f('movie.srt'), '1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>World</i>\n');
  await fsp.mkdir(f('folder'));
  await fsp.writeFile(path.join(f('folder'), 'inside.txt'), 'inside');
  await pack([{ path: f('folder'), name: 'folder' }, { path: f('plain.txt'), name: 'plain.txt' }], f('bundle.zip'), 'zip');
  // An EPUB produced by the engine itself, used as an input below.
  await runOperation('doc.to.epub', [f('notes.md')], {}, { outDir: () => src, progress() {}, htmlToPdf });
}

const PARAMS = { 'pdf.extract': { pages: '2-3' }, 'pdf.delete': { pages: '1' }, 'video.trim': { start: '0:01', end: '0:02' }, 'audio.trim': { start: '0:00.5', end: '0:02' }, 'video.split': { minutes: 0.02 }, 'audio.split': { minutes: 0.02 } };

export async function smoke({ htmlToPdf } = {}) {
  htmlToPdf ??= async () => { throw Object.assign(new Error('htmlToPdf needs Electron'), { skip: true }); };
  await fixtures(htmlToPdf);
  const out = path.join(root, 'out');
  await fsp.mkdir(out);
  const sets = [
    ...fs.readdirSync(src).map((n) => [f(n)]),
    [f('photo.jpg'), f('graphic.png')], [f('report.pdf'), f('photo.jpg')], [f('tone.wav'), f('tone.wav')],
    [f('clip.mp4'), f('clip.mp4')], [f('notes.md'), f('plain.txt')], [f('data.csv'), f('book.xlsx')],
  ];
  let pass = 0, fail = 0, skip = 0;
  for (const files of sets) {
    const opts = getOptions(files, 'en');
    for (const op of [...opts.convert, ...opts.tools]) {
      if (filter && !op.id.includes(filter) && !files.some((x) => x.includes(filter))) continue;
      const label = `${files.map((x) => path.basename(x)).join('+')} → ${op.id}`;
      const t = Date.now();
      try {
        const r = await runOperation(op.id, files, PARAMS[op.id] ?? {}, { outDir: () => out, progress() {}, htmlToPdf }, 'en');
        const sizes = r.outputs.map((o) => (fs.statSync(o).isDirectory() ? `${fs.readdirSync(o).length} files` : `${fs.statSync(o).size}B`));
        if (r.outputs.some((o) => !fs.statSync(o).isDirectory() && fs.statSync(o).size === 0)) throw new Error('empty output');
        if (!r.outputs.length && !r.message) throw new Error('no output');
        console.log(`  ok   ${label} [${sizes.join(', ') || r.message.split('\n')[0]}] ${Date.now() - t}ms`);
        pass++;
      } catch (e) {
        if (e.skip || e.code === 'NEEDS_LIBREOFFICE') { console.log(`  skip ${label} (${e.message.slice(0, 50)})`); skip++; }
        else { console.log(`  FAIL ${label}: ${e.stack.split('\n').slice(0, 3).join(' | ')}`); fail++; }
      }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped — output in ${out}`);
  return { pass, fail, skip, out };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { fail } = await smoke();
  process.exitCode = fail ? 1 : 0;
}
