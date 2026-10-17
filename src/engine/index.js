import fs from 'node:fs';
import { kindOf, ext } from './util.js';
import { operations as image } from './image.js';
import { operations as media } from './media.js';
import { operations as pdf } from './pdf.js';
import { operations as document } from './document.js';
import { operations as sheet } from './sheet.js';
import { operations as subtitle } from './subtitle.js';
import { operations as archive, genericOperations } from './archive.js';
import { findSoffice } from './libreoffice.js';

export const OPERATIONS = [...image, ...media, ...pdf, ...document, ...sheet, ...subtitle, ...archive, ...genericOperations];
const BY_ID = new Map(OPERATIONS.map((op) => [op.id, op]));

export function localize(value, locale) {
  if (value == null || typeof value === 'string') return value;
  return value[locale] ?? value.en;
}

function describe(file) {
  let isDir = false;
  try {
    isDir = fs.statSync(file).isDirectory();
  } catch {
    // Missing files are treated as plain files; the operation will report the error.
  }
  return { file, isDir, kind: isDir ? 'folder' : kindOf(file), ext: ext(file) };
}

function applies(op, items) {
  if (items.length < (op.minFiles ?? 1)) return false;
  if (op.kinds === '*') return !op.filesOnly || items.every((i) => !i.isDir);
  if (!items.every((i) => op.kinds.includes(i.kind))) return false;
  if (op.requireKind && !items.some((i) => i.kind === op.requireKind)) return false;
  if (op.accepts && !items.every((i) => op.accepts(i.file))) return false;
  if (op.skipExt && items.every((i) => op.skipExt.includes(i.ext))) return false;
  return true;
}

function present(op, locale) {
  return {
    id: op.id,
    group: op.group,
    label: localize(op.label, locale),
    sub: localize(op.sub, locale),
    icon: op.icon,
    needs: op.note === 'libreoffice' && !findSoffice() ? 'LibreOffice' : undefined,
    params: op.params?.map((p) => ({
      ...p,
      label: localize(p.label, locale),
      labels: p.labels && Object.fromEntries(Object.entries(p.labels).map(([k, v]) => [k, localize(v, locale)])),
    })),
  };
}

/** Lists the convert and tool options available for a selection of files. */
export function getOptions(files, locale = 'en') {
  const items = files.map(describe);
  const result = { convert: [], tools: [], kinds: [...new Set(items.map((i) => i.kind))] };
  for (const op of OPERATIONS) {
    if (applies(op, items)) result[op.group].push(present(op, locale));
  }
  return result;
}

/**
 * Runs an operation. `ctx` provides: outDir(file) → string, progress(0..1), htmlToPdf(html, opts) → Buffer, signal.
 * Resolves to { outputs: string[], message?: string, copy?: string }.
 */
export async function runOperation(id, files, params, ctx, locale = 'en') {
  const op = BY_ID.get(id);
  if (!op) throw new Error(`Unknown operation: ${id}`);
  const values = Object.fromEntries((op.params ?? []).map((p) => [p.key, params?.[p.key] ?? p.default]));
  const outputs = [];
  let extra = {};
  const collect = (r) => {
    if (r == null) return;
    if (typeof r === 'string') outputs.push(r);
    else if (Array.isArray(r)) outputs.push(...r);
    else extra = r;
  };
  if (op.all) {
    collect(await op.all(files, values, ctx));
  } else {
    for (const [i, file] of files.entries()) {
      if (ctx.signal?.aborted) throw new Error('Cancelled');
      const sub = { ...ctx, progress: (f) => ctx.progress((i + Math.min(1, Math.max(0, f))) / files.length) };
      collect(await op.each(file, values, sub));
      ctx.progress((i + 1) / files.length);
    }
  }
  return { outputs, message: localize(extra.message, locale), copy: extra.copy };
}

export { kindOf };
