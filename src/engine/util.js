import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const KINDS = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'tif', 'tiff', 'avif', 'gif', 'bmp', 'svg', 'ico'],
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'm4v', 'flv', 'mpg', 'mpeg', '3gp', 'ts', 'mts'],
  audio: ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'wma', 'aac'],
  pdf: ['pdf'],
  doc: ['docx', 'md', 'markdown', 'txt', 'epub', 'rtf', 'html', 'htm', 'odt', 'doc'],
  slides: ['pptx', 'ppt', 'odp', 'key'],
  sheet: ['xlsx', 'xls', 'ods', 'csv', 'tsv'],
  subtitle: ['srt', 'vtt'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'rar'],
};

export function ext(file) {
  const base = path.basename(file).toLowerCase();
  if (base.endsWith('.tar.gz')) return 'tgz';
  return path.extname(base).slice(1);
}

export function kindOf(file) {
  const e = ext(file);
  for (const [kind, list] of Object.entries(KINDS)) if (list.includes(e)) return kind;
  return 'other';
}

export function stem(file) {
  const base = path.basename(file);
  if (base.toLowerCase().endsWith('.tar.gz')) return base.slice(0, -7);
  return base.slice(0, base.length - path.extname(base).length);
}

/** Returns a path that does not exist yet: "name.ext", "name (1).ext", ... */
export function uniquePath(dir, name, extension) {
  const suffix = extension ? `.${extension}` : '';
  let candidate = path.join(dir, `${name}${suffix}`);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${name} (${i})${suffix}`);
  return candidate;
}

export async function makeDir(dir, name) {
  const target = uniquePath(dir, name, '');
  await fsp.mkdir(target, { recursive: true });
  return target;
}

export function ffmpegPath() {
  // When packaged, binaries live outside the asar archive.
  return require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
}

function parseTime(s) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

/** Runs ffmpeg, reporting progress (0..1) based on the input duration. */
export function ffmpeg(args, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-y', ...args], { windowsHide: true });
    let duration = null;
    let log = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      log = (log + text).slice(-8000);
      if (duration == null) {
        const d = /Duration: (\d+:\d+:\d+(?:\.\d+)?)/.exec(log);
        if (d) duration = parseTime(d[1]);
      }
      const t = /time=(\d+:\d+:\d+(?:\.\d+)?)/.exec(text);
      if (t && duration && onProgress) onProgress(Math.min(1, parseTime(t[1]) / duration));
    });
    signal?.addEventListener('abort', () => proc.kill('SIGKILL'));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ duration, log });
      else reject(new Error(lastError(log) || `ffmpeg exited with code ${code}`));
    });
  });
}

function lastError(log) {
  const lines = log.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-2).join(' — ');
}

/** Reads media duration (seconds) by letting ffmpeg probe the file. */
export async function mediaInfo(file) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-i', file], { windowsHide: true });
    let log = '';
    proc.stderr.on('data', (c) => (log += c.toString()));
    proc.on('close', () => {
      const d = /Duration: (\d+:\d+:\d+(?:\.\d+)?)/.exec(log);
      resolve({
        duration: d ? parseTime(d[1]) : 0,
        hasAudio: /Stream #.*Audio:/.test(log),
        hasVideo: /Stream #.*Video:(?!.*attached pic)/.test(log),
      });
    });
    proc.on('error', () => resolve({ duration: 0, hasAudio: false, hasVideo: false }));
  });
}

export function parseTimestamp(value) {
  if (value == null || value === '') return null;
  const parts = String(value).trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`Invalid time: ${value}`);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** Parses page ranges like "1-3, 5, 8-" into zero-based indexes. */
export function parseRanges(spec, pageCount) {
  const result = [];
  for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) {
      const from = m[1] ? +m[1] : 1;
      const to = m[2] ? +m[2] : pageCount;
      for (let i = from; i <= to; i++) if (i >= 1 && i <= pageCount) result.push(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = +part;
      if (n >= 1 && n <= pageCount) result.push(n - 1);
    } else {
      throw new Error(`Invalid page range: ${part}`);
    }
  }
  if (!result.length) throw new Error('No pages selected');
  return result;
}
