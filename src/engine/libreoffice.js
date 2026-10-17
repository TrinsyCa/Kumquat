import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

let cached;

/** Locates a LibreOffice installation (optional; used for Office formats that need real rendering). */
export function findSoffice() {
  if (cached !== undefined) return cached;
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe'),
      ]
    : ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice', '/opt/libreoffice/program/soffice'];
  cached = candidates.find((c) => fs.existsSync(c)) ?? null;
  if (!cached) {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      cached = execFileSync(cmd, ['soffice'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || null;
    } catch {
      cached = null;
    }
  }
  return cached;
}

export class NeedsLibreOffice extends Error {
  constructor() {
    super('This conversion needs LibreOffice. Install it (free) from libreoffice.org and try again.');
    this.code = 'NEEDS_LIBREOFFICE';
  }
}

/** Converts a file with LibreOffice and returns the path of the produced file in a temp dir. */
export async function sofficeConvert(file, target, signal) {
  const soffice = findSoffice();
  if (!soffice) throw new NeedsLibreOffice();
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kumquat-lo-'));
  // A private profile avoids clashing with a LibreOffice window the user already has open.
  const profile = `file:///${path.join(outDir, 'profile').replace(/\\/g, '/').replace(/^\/+/, '')}`;
  await new Promise((resolve, reject) => {
    const proc = spawn(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', target, '--outdir', outDir, file], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (c) => (err += c));
    signal?.addEventListener('abort', () => proc.kill());
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `LibreOffice exited with ${code}`))));
  });
  const produced = (await fsp.readdir(outDir)).find((f) => f !== 'profile');
  if (!produced) throw new Error('LibreOffice did not produce an output file');
  return path.join(outDir, produced);
}
