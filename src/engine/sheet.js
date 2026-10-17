import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ext, stem, uniquePath, makeDir, escapeHtml } from './util.js';
import { wrapHtml } from './document.js';

const require = createRequire(import.meta.url);

function readBook(file) {
  const XLSX = require('xlsx');
  const e = ext(file);
  // CSV/TSV are read as text so UTF-8 (e.g. Turkish characters) survives.
  if (e === 'csv' || e === 'tsv') {
    return fsp.readFile(file, 'utf8').then((text) => XLSX.read(text.replace(/^﻿/, ''), { type: 'string', FS: e === 'tsv' ? '\t' : undefined, raw: false }));
  }
  return fsp.readFile(file).then((buf) => XLSX.read(buf, { cellDates: true }));
}

function sheetHtml(XLSX, wb) {
  return wb.SheetNames.map((name) => {
    const table = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' });
    const inner = /<table[\s\S]*<\/table>/i.exec(table)?.[0] ?? table;
    return (wb.SheetNames.length > 1 ? `<h2>${escapeHtml(name)}</h2>` : '') + inner;
  }).join('\n<div class="page-break"></div>\n');
}

function markdownTable(rows) {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

/** Writes delimited text; workbooks with several sheets produce one file per sheet in a folder. */
async function writeDelimited(XLSX, wb, file, ctx, format) {
  const FS = format === 'tsv' ? '\t' : ',';
  const write = async (dir, name, sheet) => {
    const out = uniquePath(dir, name, format);
    // BOM so Excel opens UTF-8 CSV files with the right encoding.
    await fsp.writeFile(out, '﻿' + XLSX.utils.sheet_to_csv(sheet, { FS, blankrows: false }));
    return out;
  };
  if (wb.SheetNames.length === 1) return write(ctx.outDir(file), stem(file), wb.Sheets[wb.SheetNames[0]]);
  const dir = await makeDir(ctx.outDir(file), stem(file));
  for (const name of wb.SheetNames) await write(dir, `${stem(file)} - ${name.replace(/[\\/:*?"<>|]/g, '_')}`, wb.Sheets[name]);
  return dir;
}

async function convertSheet(file, format, ctx) {
  const XLSX = require('xlsx');
  const wb = await readBook(file);
  ctx.progress(0.4);
  if (format === 'csv' || format === 'tsv') return writeDelimited(XLSX, wb, file, ctx, format);
  const out = uniquePath(ctx.outDir(file), stem(file), format);
  switch (format) {
    case 'xlsx':
    case 'ods':
      XLSX.writeFile(wb, out, { bookType: format, compression: true });
      break;
    case 'json': {
      const data = Object.fromEntries(wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: null })]));
      await fsp.writeFile(out, JSON.stringify(wb.SheetNames.length === 1 ? data[wb.SheetNames[0]] : data, null, 2));
      break;
    }
    case 'md':
      await fsp.writeFile(out, wb.SheetNames.map((n) => (wb.SheetNames.length > 1 ? `## ${n}\n\n` : '') + markdownTable(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }))).join('\n\n') + '\n');
      break;
    case 'html':
      await fsp.writeFile(out, wrapHtml(stem(file), sheetHtml(XLSX, wb), 'body{max-width:none}'));
      break;
    case 'pdf':
      await fsp.writeFile(out, await ctx.htmlToPdf(wrapHtml(stem(file), sheetHtml(XLSX, wb), 'body{max-width:none;padding:0;font-size:9pt}'), { landscape: true }));
      break;
    default:
      throw new Error(`Cannot write ${format}`);
  }
  return out;
}

const TARGETS = { xlsx: 'XLSX', ods: 'ODS', csv: 'CSV', tsv: 'TSV', pdf: 'PDF', html: 'HTML', json: 'JSON', md: 'Markdown' };

export const operations = [
  ...Object.entries(TARGETS).map(([format, label]) => ({
    id: `sheet.to.${format}`,
    group: 'convert',
    kinds: ['sheet'],
    label,
    skipExt: [format],
    each: (file, p, ctx) => convertSheet(file, format, ctx),
  })),
  {
    id: 'sheet.merge',
    group: 'tools',
    kinds: ['sheet'],
    minFiles: 2,
    icon: 'merge',
    label: { en: 'Combine into workbook', tr: 'Tek dosyada birleştir' },
    all: async (files, p, ctx) => {
      const XLSX = require('xlsx');
      const out = XLSX.utils.book_new();
      const used = new Set();
      for (const f of files) {
        const wb = await readBook(f);
        for (const name of wb.SheetNames) {
          let sheetName = (wb.SheetNames.length > 1 ? `${stem(f)} ${name}` : stem(f)).replace(/[\\/?*[\]:]/g, '_').slice(0, 31);
          for (let i = 2; used.has(sheetName); i++) sheetName = `${sheetName.slice(0, 28)} ${i}`;
          used.add(sheetName);
          XLSX.utils.book_append_sheet(out, wb.Sheets[name], sheetName);
        }
      }
      const target = uniquePath(ctx.outDir(files[0]), `${stem(files[0])} (merged)`, 'xlsx');
      XLSX.writeFile(out, target, { compression: true });
      return [target];
    },
  },
];
