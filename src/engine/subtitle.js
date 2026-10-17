import fsp from 'node:fs/promises';
import { ext, stem, uniquePath } from './util.js';

/** Parses SRT or WebVTT into cues of { start, end, text } (times in ms). */
export function parseCues(text) {
  const toMs = (t) => {
    const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(t);
    return m ? ((+(m[1] ?? 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0').slice(0, 3) : 0;
  };
  const cues = [];
  for (const block of text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split('-->');
    cues.push({ start: toMs(a), end: toMs(b), text: lines.slice(idx + 1).join('\n').trim() });
  }
  return cues;
}

function fmt(ms, sep) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function writeCues(cues, format) {
  if (format === 'srt') return cues.map((c, i) => `${i + 1}\n${fmt(c.start, ',')} --> ${fmt(c.end, ',')}\n${c.text}`).join('\n\n') + '\n';
  if (format === 'vtt') return 'WEBVTT\n\n' + cues.map((c) => `${fmt(c.start, '.')} --> ${fmt(c.end, '.')}\n${c.text}`).join('\n\n') + '\n';
  return cues.map((c) => c.text.replace(/<[^>]+>/g, '')).join('\n') + '\n';
}

export const operations = ['srt', 'vtt', 'txt'].map((format) => ({
  id: `subtitle.to.${format}`,
  group: 'convert',
  kinds: ['subtitle'],
  label: format.toUpperCase(),
  skipExt: [format],
  each: async (file, p, ctx) => {
    const cues = parseCues(await fsp.readFile(file, 'utf8'));
    if (!cues.length) throw new Error(`No subtitles found in .${ext(file)} file`);
    const out = uniquePath(ctx.outDir(file), stem(file), format);
    await fsp.writeFile(out, writeCues(cues, format));
    return out;
  },
}));
