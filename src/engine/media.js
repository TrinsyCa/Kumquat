import path from 'node:path';
import { ext, stem, uniquePath, makeDir, ffmpeg, mediaInfo, parseTimestamp } from './util.js';

const AUDIO_CODECS = {
  mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
  m4a: ['-c:a', 'aac', '-b:a', '192k'],
  wav: ['-c:a', 'pcm_s16le'],
  flac: ['-c:a', 'flac'],
  ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-c:a', 'libopus', '-b:a', '128k'],
  aiff: ['-c:a', 'pcm_s16be'],
};

const VIDEO_CODECS = {
  mp4: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
  mov: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'],
  mkv: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k'],
  webm: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k'],
};

const GIF_FILTER = 'fps=12,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4';

function run(ctx, args) {
  return ffmpeg(args, { onProgress: ctx.progress, signal: ctx.signal });
}

async function encode(file, ctx, format, extraArgs, suffix = '') {
  const out = uniquePath(ctx.outDir(file), `${stem(file)}${suffix}`, format);
  await run(ctx, ['-i', file, ...extraArgs, out]);
  return out;
}

/** Same container as the source when it's one we can write, otherwise MP4 / M4A. */
function sameFormat(file, kind) {
  const e = ext(file);
  if (kind === 'video') return VIDEO_CODECS[e] ? e : 'mp4';
  return AUDIO_CODECS[e] ? e : e === 'aif' ? 'aiff' : 'm4a';
}

function codecsFor(file, kind) {
  const format = sameFormat(file, kind);
  return { format, codec: kind === 'video' ? VIDEO_CODECS[format] : AUDIO_CODECS[format] };
}

/** Concatenates several media files (re-encoding, so mixed sources work). */
async function concat(files, ctx, kind) {
  const infos = await Promise.all(files.map(mediaInfo));
  const { format, codec } = codecsFor(files[0], kind);
  const out = uniquePath(ctx.outDir(files[0]), `${stem(files[0])} (merged)`, format);
  const inputs = files.flatMap((f) => ['-i', f]);
  let filter;
  if (kind === 'video') {
    const allAudio = infos.every((i) => i.hasAudio);
    const prep = files.map((_, i) => `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`).join(';');
    const streams = files.map((_, i) => `[v${i}]${allAudio ? `[${i}:a]` : ''}`).join('');
    filter = `${prep};${streams}concat=n=${files.length}:v=1:a=${allAudio ? 1 : 0}[v]${allAudio ? '[a]' : ''}`;
    await run(ctx, [...inputs, '-filter_complex', filter, '-map', '[v]', ...(allAudio ? ['-map', '[a]'] : []), ...codec, out]);
  } else {
    filter = files.map((_, i) => `[${i}:a]`).join('') + `concat=n=${files.length}:v=0:a=1[a]`;
    await run(ctx, [...inputs, '-filter_complex', filter, '-map', '[a]', ...codec, out]);
  }
  return out;
}

async function split(file, ctx, kind, minutes) {
  const seconds = Math.max(1, Math.round(parseFloat(minutes) * 60));
  const { format } = codecsFor(file, kind);
  const dir = await makeDir(ctx.outDir(file), `${stem(file)} (parts)`);
  await run(ctx, ['-i', file, '-map', '0', '-c', 'copy', '-f', 'segment', '-segment_time', String(seconds), '-reset_timestamps', '1', path.join(dir, `${stem(file)} %03d.${format}`)]);
  return dir;
}

async function trim(file, ctx, kind, p) {
  const start = parseTimestamp(p.start) ?? 0;
  const end = parseTimestamp(p.end);
  const { format, codec } = codecsFor(file, kind);
  const args = ['-ss', String(start), '-i', file];
  if (end != null) {
    if (end <= start) throw new Error('End must be after start');
    args.push('-t', String(end - start));
  }
  const out = uniquePath(ctx.outDir(file), `${stem(file)} (trimmed)`, format);
  await run(ctx, [...args, ...codec, out]);
  return out;
}

const trimParams = [
  { key: 'start', type: 'text', default: '0:00', placeholder: '0:00', label: { en: 'Start', tr: 'Başlangıç' } },
  { key: 'end', type: 'text', default: '', placeholder: '1:30', label: { en: 'End (empty = until the end)', tr: 'Bitiş (boş = sonuna kadar)' } },
];
const splitParams = [{ key: 'minutes', type: 'number', default: 5, min: 0.1, step: 0.5, label: { en: 'Part length (minutes)', tr: 'Parça uzunluğu (dakika)' } }];
const speedParams = [{ key: 'speed', type: 'select', default: '2', options: ['0.5', '0.75', '1.25', '1.5', '2', '3'], unit: '×', label: { en: 'Speed', tr: 'Hız' } }];

function atempo(speed) {
  // atempo only accepts 0.5–2.0, so chain filters for larger factors.
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${s}`);
  return parts.join(',');
}

const audioOps = [
  ...Object.keys(AUDIO_CODECS).map((format) => ({
    id: `audio.to.${format}`,
    group: 'convert',
    kinds: ['audio'],
    label: format.toUpperCase(),
    skipExt: format === 'aiff' ? ['aiff', 'aif'] : [format],
    each: (file, p, ctx) => encode(file, ctx, format, ['-vn', ...AUDIO_CODECS[format]]),
  })),
  {
    id: 'audio.compress',
    group: 'tools',
    kinds: ['audio'],
    icon: 'compress',
    label: { en: 'Compress', tr: 'Sıkıştır' },
    params: [{ key: 'bitrate', type: 'select', default: '96', options: ['64', '96', '128', '160'], unit: ' kbps', label: { en: 'Bitrate', tr: 'Bit hızı' } }],
    each: (file, p, ctx) => encode(file, ctx, 'mp3', ['-vn', '-c:a', 'libmp3lame', '-b:a', `${p.bitrate}k`], ' (compressed)'),
  },
  { id: 'audio.trim', group: 'tools', kinds: ['audio'], icon: 'scissors', label: { en: 'Trim', tr: 'Kırp' }, params: trimParams, each: (f, p, ctx) => trim(f, ctx, 'audio', p) },
  { id: 'audio.split', group: 'tools', kinds: ['audio'], icon: 'split', label: { en: 'Split', tr: 'Böl' }, params: splitParams, each: (f, p, ctx) => split(f, ctx, 'audio', p.minutes) },
  { id: 'audio.merge', group: 'tools', kinds: ['audio'], minFiles: 2, icon: 'merge', label: { en: 'Merge', tr: 'Birleştir' }, all: async (files, p, ctx) => [await concat(files, ctx, 'audio')] },
  {
    id: 'audio.normalize',
    group: 'tools',
    kinds: ['audio'],
    icon: 'volume',
    label: { en: 'Normalize volume', tr: 'Sesi dengele' },
    each: (file, p, ctx) => {
      const { format, codec } = codecsFor(file, 'audio');
      return encode(file, ctx, format, ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', ...codec], ' (normalized)');
    },
  },
  {
    id: 'audio.speed',
    group: 'tools',
    kinds: ['audio'],
    icon: 'gauge',
    label: { en: 'Change speed', tr: 'Hızı değiştir' },
    params: speedParams,
    each: (file, p, ctx) => {
      const { format, codec } = codecsFor(file, 'audio');
      return encode(file, ctx, format, ['-af', atempo(+p.speed), ...codec], ` (${p.speed}x)`);
    },
  },
];

const videoOps = [
  ...Object.keys(VIDEO_CODECS).map((format) => ({
    id: `video.to.${format}`,
    group: 'convert',
    kinds: ['video'],
    label: format.toUpperCase(),
    skipExt: [format],
    each: (file, p, ctx) => encode(file, ctx, format, VIDEO_CODECS[format]),
  })),
  {
    id: 'video.to.gif',
    group: 'convert',
    kinds: ['video'],
    label: 'GIF',
    each: (file, p, ctx) => encode(file, ctx, 'gif', ['-filter_complex', GIF_FILTER, '-loop', '0']),
  },
  ...['mp3', 'm4a', 'wav'].map((format) => ({
    id: `video.to.${format}`,
    group: 'convert',
    kinds: ['video'],
    label: format.toUpperCase(),
    sub: { en: 'audio', tr: 'ses' },
    each: (file, p, ctx) => encode(file, ctx, format, ['-vn', ...AUDIO_CODECS[format]]),
  })),
  {
    id: 'video.compress',
    group: 'tools',
    kinds: ['video'],
    icon: 'compress',
    label: { en: 'Compress', tr: 'Sıkıştır' },
    params: [
      { key: 'quality', type: 'select', default: 'balanced', options: ['high', 'balanced', 'small'], labels: { high: { en: 'High quality', tr: 'Yüksek kalite' }, balanced: { en: 'Balanced', tr: 'Dengeli' }, small: { en: 'Smallest', tr: 'En küçük' } }, label: { en: 'Preset', tr: 'Ayar' } },
      { key: 'height', type: 'select', default: '1080', options: ['original', '1080', '720', '480'], unit: 'p', label: { en: 'Max height', tr: 'Maks. yükseklik' } },
    ],
    each: (file, p, ctx) => {
      const crf = { high: 23, balanced: 28, small: 33 }[p.quality] ?? 28;
      const scale = p.height === 'original' ? [] : ['-vf', `scale=-2:'min(${p.height},ih)'`];
      return encode(file, ctx, 'mp4', [...scale, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'], ' (compressed)');
    },
  },
  { id: 'video.trim', group: 'tools', kinds: ['video'], icon: 'scissors', label: { en: 'Trim', tr: 'Kırp' }, params: trimParams, each: (f, p, ctx) => trim(f, ctx, 'video', p) },
  { id: 'video.split', group: 'tools', kinds: ['video'], icon: 'split', label: { en: 'Split', tr: 'Böl' }, params: splitParams, each: (f, p, ctx) => split(f, ctx, 'video', p.minutes) },
  { id: 'video.merge', group: 'tools', kinds: ['video'], minFiles: 2, icon: 'merge', label: { en: 'Merge', tr: 'Birleştir' }, all: async (files, p, ctx) => [await concat(files, ctx, 'video')] },
  {
    id: 'video.mute',
    group: 'tools',
    kinds: ['video'],
    icon: 'mute',
    label: { en: 'Remove audio', tr: 'Sesi kaldır' },
    each: (file, p, ctx) => encode(file, ctx, sameFormat(file, 'video'), ['-an', '-c:v', 'copy'], ' (muted)'),
  },
  {
    id: 'video.rotate',
    group: 'tools',
    kinds: ['video'],
    icon: 'rotate-cw',
    label: { en: 'Rotate', tr: 'Döndür' },
    params: [{ key: 'dir', type: 'select', default: 'right', options: ['right', 'left', '180'], labels: { right: { en: '90° right', tr: '90° sağa' }, left: { en: '90° left', tr: '90° sola' }, 180: { en: '180°', tr: '180°' } }, label: { en: 'Direction', tr: 'Yön' } }],
    each: (file, p, ctx) => {
      const vf = { right: 'transpose=1', left: 'transpose=2', 180: 'transpose=1,transpose=1' }[p.dir];
      const { format, codec } = codecsFor(file, 'video');
      return encode(file, ctx, format, ['-vf', vf, ...codec], ' (rotated)');
    },
  },
  {
    id: 'video.speed',
    group: 'tools',
    kinds: ['video'],
    icon: 'gauge',
    label: { en: 'Change speed', tr: 'Hızı değiştir' },
    params: speedParams,
    each: async (file, p, ctx) => {
      const { hasAudio } = await mediaInfo(file);
      const { format, codec } = codecsFor(file, 'video');
      const audio = hasAudio ? ['-af', atempo(+p.speed)] : ['-an'];
      return encode(file, ctx, format, ['-vf', `setpts=PTS/${p.speed}`, ...audio, ...codec], ` (${p.speed}x)`);
    },
  },
  {
    id: 'video.thumbnail',
    group: 'tools',
    kinds: ['video'],
    icon: 'image',
    label: { en: 'Snapshot', tr: 'Kare yakala' },
    params: [{ key: 'at', type: 'text', default: '', placeholder: '0:05', label: { en: 'Time (empty = middle)', tr: 'Zaman (boş = orta)' } }],
    each: async (file, p, ctx) => {
      const at = parseTimestamp(p.at) ?? (await mediaInfo(file)).duration / 2;
      const out = uniquePath(ctx.outDir(file), `${stem(file)} (frame)`, 'jpg');
      await run(ctx, ['-ss', String(at), '-i', file, '-frames:v', '1', '-q:v', '2', out]);
      return out;
    },
  },
];

export const operations = [...videoOps, ...audioOps];
