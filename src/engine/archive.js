import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { ext, stem, uniquePath, makeDir } from './util.js';

const require = createRequire(import.meta.url);

function insideDir(dir, name) {
  const target = path.resolve(dir, name);
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error(`Blocked unsafe path in archive: ${name}`);
  return target;
}

/** Extracts an archive into `dir` (which must exist). Paths escaping `dir` are rejected. */
export async function extractTo(file, dir, ctx) {
  const e = ext(file);
  dir = path.resolve(dir);
  if (e === 'zip') {
    const AdmZip = require('adm-zip');
    const entries = new AdmZip(file).getEntries();
    for (const [i, entry] of entries.entries()) {
      const target = insideDir(dir, entry.entryName);
      if (entry.isDirectory) await fsp.mkdir(target, { recursive: true });
      else {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, entry.getData());
      }
      ctx.progress((i + 1) / entries.length);
    }
  } else if (e === 'tar' || e === 'tgz') {
    const tar = await import('tar');
    await tar.x({ file, cwd: dir, strict: false });
  } else if (e === 'gz') {
    await pipeline(fs.createReadStream(file), zlib.createGunzip(), fs.createWriteStream(path.join(dir, stem(file))));
  } else if (e === 'rar') {
    const { createExtractorFromData } = require('node-unrar-js');
    const buf = await fsp.readFile(file);
    const extractor = await createExtractorFromData({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    const { files } = extractor.extract();
    for (const f of files) {
      const target = insideDir(dir, f.fileHeader.name);
      if (f.fileHeader.flags.directory) await fsp.mkdir(target, { recursive: true });
      else {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, f.extraction);
      }
    }
  } else {
    throw new Error(`Cannot extract .${e}`);
  }
}

/** Creates a zip / tar / tar.gz from files and folders. */
export async function pack(entries, out, format) {
  const { ZipArchive, TarArchive } = await import('archiver');
  const archive = format === 'zip' ? new ZipArchive({ zlib: { level: 9 } }) : new TarArchive({ gzip: format === 'tgz', gzipOptions: { level: 9 } });
  const done = pipeline(archive, fs.createWriteStream(out));
  for (const entry of entries) {
    if ((await fsp.stat(entry.path)).isDirectory()) archive.directory(entry.path, entry.name);
    else archive.file(entry.path, { name: entry.name });
  }
  await archive.finalize();
  await done;
  return out;
}

const PACK_EXT = { zip: 'zip', tar: 'tar', tgz: 'tar.gz' };

async function repack(file, format, ctx) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kumquat-'));
  try {
    await extractTo(file, tmp, { progress: (f) => ctx.progress(f * 0.5) });
    const names = await fsp.readdir(tmp);
    const out = uniquePath(ctx.outDir(file), stem(file), PACK_EXT[format]);
    await pack(names.map((n) => ({ path: path.join(tmp, n), name: n })), out, format);
    return out;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

export const operations = [
  ...[['zip', 'ZIP'], ['tgz', 'TAR.GZ'], ['tar', 'TAR']].map(([format, label]) => ({
    id: `archive.to.${format}`,
    group: 'convert',
    kinds: ['archive'],
    label,
    accepts: (file) => ext(file) !== format && ext(file) !== 'gz',
    each: (file, p, ctx) => repack(file, format, ctx),
  })),
  {
    id: 'archive.extract',
    group: 'tools',
    kinds: ['archive'],
    icon: 'unzip',
    label: { en: 'Extract', tr: 'Arşivden çıkar' },
    each: async (file, p, ctx) => {
      const dir = await makeDir(ctx.outDir(file), stem(file));
      await extractTo(file, dir, ctx);
      // If the archive wraps a single folder, don't nest it twice.
      const items = await fsp.readdir(dir);
      if (items.length === 1 && (await fsp.stat(path.join(dir, items[0]))).isDirectory()) {
        const target = uniquePath(path.dirname(dir), items[0], '');
        const tmp = `${dir}.kumquat-tmp`;
        await fsp.rename(path.join(dir, items[0]), tmp);
        await fsp.rmdir(dir);
        await fsp.rename(tmp, target);
        return target;
      }
      return dir;
    },
  },
];

/** Tools that work on any selection, including folders and unknown file types. */
export const genericOperations = [
  {
    id: 'any.zip',
    group: 'tools',
    kinds: '*',
    icon: 'archive',
    label: { en: 'Compress to ZIP', tr: "ZIP'e sıkıştır" },
    all: async (files, p, ctx) => {
      const name = files.length === 1 ? path.basename(files[0]) : 'Archive';
      const out = uniquePath(ctx.outDir(files[0]), name, 'zip');
      await pack(files.map((f) => ({ path: f, name: path.basename(f) })), out, 'zip');
      return [out];
    },
  },
  {
    id: 'any.checksum',
    group: 'tools',
    kinds: '*',
    filesOnly: true,
    icon: 'fingerprint',
    label: { en: 'SHA-256 checksum', tr: 'SHA-256 özeti' },
    all: async (files, p, ctx) => {
      const lines = [];
      for (const [i, f] of files.entries()) {
        const hash = crypto.createHash('sha256');
        await pipeline(fs.createReadStream(f), hash);
        lines.push(`${hash.digest('hex')}  ${path.basename(f)}`);
        ctx.progress((i + 1) / files.length);
      }
      const text = lines.join('\n');
      return { copy: files.length === 1 ? text.split('  ')[0] : text, message: { en: `Checksum copied to clipboard\n${text}`, tr: `Özet panoya kopyalandı\n${text}` } };
    },
  },
];
