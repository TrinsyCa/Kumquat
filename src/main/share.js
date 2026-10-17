import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { pack } from '../engine/archive.js';

/** Picks the most likely LAN address (prefers private IPv4 ranges on Wi-Fi/Ethernet). */
export function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(vEthernet|docker|br-|veth|virbr|vmnet|VirtualBox|tailscale|zt|utun|wsl)/i.test(name)) continue;
      const score = /^192\.168\./.test(a.address) ? 3 : /^10\./.test(a.address) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 1 : 0;
      candidates.push({ address: a.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address ?? null;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page(files, token) {
  const items = files.map((f, i) => {
    const size = fs.statSync(f).isDirectory() ? 'folder · zip' : `${(fs.statSync(f).size / 1048576).toFixed(1)} MB`;
    return `<a class="f" href="/${token}/${i}">${esc(path.basename(f))}<small>${size}</small></a>`;
  }).join('');
  const all = files.length > 1 ? `<a class="all" href="/${token}/all">Download all (.zip)</a>` : '';
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kumquat</title>
<style>body{font:16px system-ui,sans-serif;background:#1b1410;color:#fff;margin:0;padding:24px}h1{font-size:20px;color:#ff9a3c}
a{display:block;padding:16px;margin:10px 0;border-radius:14px;background:#2c211a;color:#fff;text-decoration:none;word-break:break-all}
small{display:block;opacity:.6;margin-top:4px}.all{background:#ff8a1f;color:#1b1410;font-weight:600;text-align:center}</style>
<h1>🍊 Kumquat</h1>${all}${items}`;
}

/**
 * Serves files on the local network until stopped. Returns { url, qr, stop }.
 * A random token in the URL keeps other devices on the network from guessing the address.
 */
export async function startShare(files, { onDownload } = {}) {
  const ip = lanAddress();
  if (!ip) throw Object.assign(new Error('No local network'), { code: 'NO_NETWORK' });
  const token = crypto.randomBytes(9).toString('base64url');
  const server = http.createServer(async (req, res) => {
    const parts = decodeURIComponent(req.url.split('?')[0]).split('/').filter(Boolean);
    if (parts[0] !== token) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      if (parts.length === 1) {
        if (files.length === 1 && !fs.statSync(files[0]).isDirectory()) {
          res.writeHead(302, { Location: `/${token}/0` }).end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(files, token));
        }
        return;
      }
      const which = parts[1] === 'all' ? files : [files[+parts[1]]];
      if (!which[0]) throw new Error('missing');
      let target = which[0];
      let name = path.basename(target);
      let tmp;
      if (which.length > 1 || fs.statSync(target).isDirectory()) {
        tmp = path.join(os.tmpdir(), `kumquat-share-${crypto.randomUUID()}.zip`);
        await pack(which.map((f) => ({ path: f, name: path.basename(f) })), tmp, 'zip');
        target = tmp;
        name = which.length > 1 ? 'Kumquat.zip' : `${name}.zip`;
      }
      const { size } = fs.statSync(target);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      const stream = fs.createReadStream(target);
      stream.pipe(res);
      stream.on('close', () => {
        if (tmp) fs.rm(tmp, { force: true }, () => {});
        onDownload?.();
      });
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const url = `http://${ip}:${server.address().port}/${token}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#1b1410', light: '#ffffff' } });
  return { url, qr, stop: () => server.close() };
}
