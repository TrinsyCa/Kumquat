import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ext, stem, uniquePath, escapeHtml } from './util.js';
import { findSoffice, sofficeConvert, NeedsLibreOffice } from './libreoffice.js';

const require = createRequire(import.meta.url);

export const STYLE = `
  body { font-family: "Segoe UI", "Noto Sans", "DejaVu Sans", Arial, sans-serif; font-size: 11pt; line-height: 1.55; color: #1d1d1f; max-width: 760px; margin: 0 auto; padding: 24px; }
  h1, h2, h3 { line-height: 1.25; } img { max-width: 100%; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 4px 8px; }
  pre, code { font-family: Consolas, "DejaVu Sans Mono", monospace; background: #f5f5f7; }
  pre { padding: 10px; white-space: pre-wrap; } blockquote { border-left: 3px solid #ddd; margin-left: 0; padding-left: 12px; color: #555; }
  .page-break { break-after: page; }`;

export function wrapHtml(title, body, extraStyle = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}${extraStyle}</style></head><body>${body}</body></html>`;
}

function textToHtml(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** Minimal RTF reader: keeps text and paragraphs, drops formatting and embedded objects. */
export function rtfToText(rtf) {
  const skipDest = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'listtable', 'listoverridetable', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr']);
  let out = '';
  const stack = [];
  let skip = false;
  let ucSkip = 1;
  let i = 0;
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === '{') { stack.push(skip); i++; continue; }
    if (c === '}') { skip = stack.pop() ?? false; i++; continue; }
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?|^\\'([0-9a-fA-F]{2})|^\\([^a-zA-Z])/.exec(rtf.slice(i, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      if (m[3]) { if (!skip) out += String.fromCharCode(parseInt(m[3], 16)); continue; }
      if (m[4]) {
        if (m[4] === '*') skip = true;
        else if (!skip && m[4] === '~') out += ' ';
        else if (!skip && '\\{}'.includes(m[4])) out += m[4];
        continue;
      }
      const word = m[1];
      if (skipDest.has(word)) skip = true;
      else if (word === 'uc') ucSkip = +m[2];
      else if (word === 'u' && !skip) {
        let code = +m[2];
        if (code < 0) code += 65536;
        out += String.fromCharCode(code);
        i += ucSkip; // skip the ANSI fallback character(s)
      } else if (!skip && (word === 'par' || word === 'line')) out += '\n';
      else if (!skip && word === 'tab') out += '\t';
      continue;
    }
    if (c === '\r' || c === '\n') { i++; continue; }
    if (!skip) out += c;
    i++;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

async function epubToHtml(file) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(file);
  const read = (p) => zip.getEntry(p)?.getData();
  const container = read('META-INF/container.xml')?.toString('utf8') ?? '';
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error('Not a valid EPUB (missing container.xml)');
  const opf = read(opfPath).toString('utf8');
  const base = path.posix.dirname(opfPath);
  const manifest = {};
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
    const href = /\bhref="([^"]+)"/.exec(m[0])?.[1];
    const nav = /properties="[^"]*\bnav\b/.test(m[0]);
    if (id && href) manifest[id] = { href: decodeURIComponent(href), nav };
  }
  const title = /<dc:title[^>]*>([^<]*)<\/dc:title>/.exec(opf)?.[1] ?? stem(file);
  const parts = [];
  for (const ref of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)) {
    const item = manifest[ref[1]];
    // Skip the generated table of contents; readers don't want it in the converted text.
    if (!item || item.nav || /^toc$/i.test(ref[1])) continue;
    const docPath = path.posix.join(base, item.href);
    let html = read(docPath)?.toString('utf8') ?? '';
    html = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
    // Inline images so the result is self-contained.
    html = html.replace(/(<img\b[^>]*\bsrc=|<image\b[^>]*\bxlink:href=)"([^"]+)"/gi, (all, pre, src) => {
      const data = read(path.posix.join(path.posix.dirname(docPath), decodeURIComponent(src)));
      if (!data) return all;
      const mime = /\.png$/i.test(src) ? 'image/png' : /\.svg$/i.test(src) ? 'image/svg+xml' : /\.gif$/i.test(src) ? 'image/gif' : 'image/jpeg';
      return `${pre}"data:${mime};base64,${data.toString('base64')}"`;
    });
    parts.push(html);
  }
  return { title, body: parts.join('\n<hr class="page-break">\n') };
}

/** Reads any supported document into { title, body } where body is HTML. */
export async function readDocument(file, ctx) {
  const e = ext(file);
  const title = stem(file);
  if (e === 'docx') {
    const mammoth = require('mammoth');
    const { value } = await mammoth.convertToHtml({ path: file });
    return { title, body: value };
  }
  if (e === 'md' || e === 'markdown') {
    const { marked } = await import('marked');
    return { title, body: await marked.parse(await fsp.readFile(file, 'utf8'), { gfm: true }) };
  }
  if (e === 'txt') return { title, body: textToHtml(await fsp.readFile(file, 'utf8')) };
  if (e === 'rtf') return { title, body: textToHtml(rtfToText(await fsp.readFile(file, 'latin1'))) };
  if (e === 'html' || e === 'htm') {
    const html = await fsp.readFile(file, 'utf8');
    return {
      title: /<title>([^<]*)<\/title>/i.exec(html)?.[1] || title,
      body: /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html,
    };
  }
  if (e === 'epub') return epubToHtml(file);
  if (e === 'odt' || e === 'doc') {
    const html = await sofficeConvert(file, 'html', ctx.signal);
    const content = await fsp.readFile(html, 'utf8');
    return { title, body: /<body[^>]*>([\s\S]*)<\/body>/i.exec(content)?.[1] ?? content };
  }
  throw new Error(`Unsupported document: .${e}`);
}

export function htmlToText(html) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, code) => code.replace(/\n/g, '<br>').replace(/ /g, '&nbsp;'))
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToMarkdown(html) {
  const TurndownService = require('turndown');
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.remove(['script', 'style']);
  td.addRule('tables', {
    filter: 'table',
    replacement: (content, node) => {
      const clean = (s) => s.textContent.trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|');
      const rows = Array.from(node.getElementsByTagName('tr'), (tr) => Array.from(tr.childNodes).filter((c) => /^T[HD]$/.test(c.nodeName)).map(clean));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      return `\n\n${[line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')}\n\n`;
    },
  });
  // Embedded base64 images would bloat Markdown files; keep only their alt text.
  td.addRule('dataImages', { filter: (n) => n.nodeName === 'IMG' && /^data:/.test(n.getAttribute('src') || ''), replacement: (c, n) => (n.getAttribute('alt') ? `*[${n.getAttribute('alt')}]*` : '') });
  return td.turndown(html);
}

export async function htmlToDocx(title, body) {
  const HTMLtoDOCX = require('@turbodocx/html-to-docx');
  const result = await HTMLtoDOCX(wrapHtml(title, body), null, { title, font: 'Calibri', fontSize: 22 });
  return Buffer.isBuffer(result) ? result : Buffer.from(await result.arrayBuffer?.() ?? result);
}

export async function htmlToEpub(title, body) {
  const mod = require('epub-gen-memory');
  const epub = mod.default?.default ?? mod.default ?? mod;
  // Split into chapters at top-level headings so readers get a table of contents.
  const chunks = body.split(/(?=<h1[\s>])/i).filter((c) => c.trim());
  const chapters = (chunks.length > 1 ? chunks : [body]).map((content, i) => ({
    title: htmlToText(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(content)?.[1] ?? '') || (chunks.length > 1 ? `${title} ${i + 1}` : title),
    content,
  }));
  return epub({ title, author: 'Kumquat', ignoreFailedDownloads: true, verbose: false, prependChapterTitles: false }, chapters);
}

/** Writes { title, body } HTML in the requested format next to the source file. */
export async function writeDocument(doc, format, file, ctx, nameSuffix = '') {
  const out = uniquePath(ctx.outDir(file), stem(file) + nameSuffix, format);
  switch (format) {
    case 'html': await fsp.writeFile(out, wrapHtml(doc.title, doc.body)); break;
    case 'txt': await fsp.writeFile(out, htmlToText(doc.body) + '\n'); break;
    case 'md': await fsp.writeFile(out, htmlToMarkdown(doc.body) + '\n'); break;
    case 'docx': await fsp.writeFile(out, await htmlToDocx(doc.title, doc.body)); break;
    case 'epub': await fsp.writeFile(out, await htmlToEpub(doc.title, doc.body)); break;
    case 'pdf': await fsp.writeFile(out, await ctx.htmlToPdf(wrapHtml(doc.title, doc.body, 'body{max-width:none;padding:0}'))); break;
    default: throw new Error(`Cannot write ${format}`);
  }
  return out;
}

const DOC_INPUTS = ['docx', 'md', 'markdown', 'txt', 'epub', 'rtf', 'html', 'htm', 'odt', 'doc'];
const DOC_TARGETS = ['pdf', 'docx', 'md', 'txt', 'html', 'epub'];

async function convertDocument(file, format, ctx) {
  const e = ext(file);
  // Office files render far more faithfully through LibreOffice when it is installed.
  if (format === 'pdf' && ['docx', 'odt', 'doc', 'rtf'].includes(e) && findSoffice()) {
    const produced = await sofficeConvert(file, 'pdf', ctx.signal);
    const out = uniquePath(ctx.outDir(file), stem(file), 'pdf');
    await fsp.copyFile(produced, out);
    return out;
  }
  ctx.progress(0.3);
  const doc = await readDocument(file, ctx);
  ctx.progress(0.6);
  return writeDocument(doc, format, file, ctx);
}

const SAME = { markdown: 'md', htm: 'html' };

const docOps = DOC_TARGETS.map((format) => ({
  id: `doc.to.${format}`,
  group: 'convert',
  kinds: ['doc'],
  label: format === 'md' ? 'Markdown' : format.toUpperCase(),
  accepts: (file) => DOC_INPUTS.includes(ext(file)) && (SAME[ext(file)] ?? ext(file)) !== format,
  each: (file, p, ctx) => convertDocument(file, format, ctx),
}));

// ---- Slides (PowerPoint / Keynote / Impress) ----

async function pptxText(file) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(file);
  const slides = zip.getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => +/\d+/.exec(a.entryName)[0] - +/\d+/.exec(b.entryName)[0]);
  return slides.map((entry, i) => {
    const xml = entry.getData().toString('utf8');
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map((p) => [...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(''))
      .filter(Boolean);
    return { n: i + 1, paras };
  });
}

const slideOps = [
  ...['pdf', 'png', 'jpg'].map((format) => ({
    id: `slides.to.${format}`,
    group: 'convert',
    kinds: ['slides'],
    label: format.toUpperCase(),
    note: 'libreoffice',
    each: async (file, p, ctx) => {
      if (!findSoffice()) throw new NeedsLibreOffice();
      const pdf = await sofficeConvert(file, 'pdf', ctx.signal);
      ctx.progress(0.5);
      if (format === 'pdf') {
        const out = uniquePath(ctx.outDir(file), stem(file), 'pdf');
        await fsp.copyFile(pdf, out);
        return out;
      }
      const { renderPdfToImages } = await import('./pdf.js');
      return renderPdfToImages(pdf, format, ctx, file);
    },
  })),
  ...['txt', 'md'].map((format) => ({
    id: `slides.to.${format}`,
    group: 'convert',
    kinds: ['slides'],
    label: format === 'md' ? 'Markdown' : 'TXT',
    accepts: (file) => ext(file) === 'pptx',
    each: async (file, p, ctx) => {
      const slides = await pptxText(file);
      const text = format === 'md'
        ? slides.map((s) => `## ${s.paras[0] ?? `Slide ${s.n}`}\n\n${s.paras.slice(1).map((x) => `- ${x}`).join('\n')}`).join('\n\n')
        : slides.map((s) => `— ${s.n} —\n${s.paras.join('\n')}`).join('\n\n');
      const out = uniquePath(ctx.outDir(file), stem(file), format);
      await fsp.writeFile(out, text + '\n');
      return out;
    },
  })),
  {
    id: 'slides.to.pptx',
    group: 'convert',
    kinds: ['slides'],
    label: 'PPTX',
    accepts: (file) => ext(file) !== 'pptx',
    note: 'libreoffice',
    each: async (file, p, ctx) => {
      const produced = await sofficeConvert(file, 'pptx', ctx.signal);
      const out = uniquePath(ctx.outDir(file), stem(file), 'pptx');
      await fsp.copyFile(produced, out);
      return out;
    },
  },
];

const textTools = [
  {
    id: 'doc.merge',
    group: 'tools',
    kinds: ['doc'],
    minFiles: 2,
    icon: 'merge',
    label: { en: 'Merge', tr: 'Birleştir' },
    params: [{ key: 'format', type: 'select', default: 'docx', options: ['docx', 'pdf', 'md', 'txt', 'html'], label: { en: 'Output', tr: 'Çıktı' } }],
    all: async (files, p, ctx) => {
      const docs = [];
      for (const [i, f] of files.entries()) {
        docs.push(await readDocument(f, ctx));
        ctx.progress((i + 1) / (files.length + 1));
      }
      const body = docs.map((d) => d.body).join('\n<div class="page-break"></div>\n');
      return [await writeDocument({ title: docs[0].title, body }, p.format, files[0], ctx, ' (merged)')];
    },
  },
  {
    id: 'doc.count',
    group: 'tools',
    kinds: ['doc'],
    icon: 'hash',
    label: { en: 'Word count', tr: 'Kelime sayısı' },
    all: async (files, p, ctx) => {
      let words = 0;
      let chars = 0;
      for (const f of files) {
        const text = htmlToText((await readDocument(f, ctx)).body);
        words += (text.match(/\S+/g) ?? []).length;
        chars += text.replace(/\s/g, '').length;
      }
      const minutes = Math.max(1, Math.round(words / 230));
      return { message: { en: `${words.toLocaleString('en')} words · ${chars.toLocaleString('en')} characters · ~${minutes} min read`, tr: `${words.toLocaleString('tr')} kelime · ${chars.toLocaleString('tr')} karakter · ~${minutes} dk okuma` } };
    },
  },
];

export const operations = [...docOps, ...slideOps, ...textTools];
