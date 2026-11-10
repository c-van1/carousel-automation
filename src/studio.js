#!/usr/bin/env node
/**
 * DA studio: a local control panel for one DA carousel.
 *
 *   npm run studio -- path/to/post.json [--port 4321]
 *
 * Lets you adjust copy, slide grounds and photo framing (zoom, position, brightness) with a live preview.
 * Brand rules stay locked: logo colourway, fonts, sizes, margins and colours come from the templates and
 * the design system. "Save" writes the JSON; "Save & render" also writes PNG/PDF and runs da-design-check.
 * Listens on 127.0.0.1 only and can only write the one JSON file it was opened with.
 */
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync } from 'fs';
import { dirname, join, resolve, relative, extname, sep } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { buildPreviewHtml, findDesignSystem, PHOTO_LIMITS } from './da.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 4321;
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
if (!file || !existsSync(file) || extname(file) !== '.json') {
  console.error('Usage: npm run studio -- path/to/post.json [--port 4321]');
  process.exit(1);
}
const contentPath = resolve(file);
const contentDir = dirname(contentPath);
const outDir = join(contentDir, 'out');
const dsDir = findDesignSystem();
if (JSON.parse(readFileSync(contentPath, 'utf8')).brand !== 'da') {
  console.error('The studio only supports DA decks ("brand": "da").');
  process.exit(1);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf' };
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Serve a file only if it sits inside root, so a crafted URL cannot read elsewhere */
function sendFrom(root, rel, res) {
  const abs = resolve(root, decodeURIComponent(rel));
  if (abs !== root && !abs.startsWith(root + sep)) return send(res, 403, 'Forbidden');
  if (!existsSync(abs) || !statSync(abs).isFile()) return send(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': TYPES[extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(abs));
}
const send = (res, code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
const json = (res, code, data) => send(res, code, JSON.stringify(data), 'application/json');
const readBody = (req) => new Promise((ok, fail) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 5e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { fail(e); } }); });
const urlFor = (abs) => (abs.startsWith(contentDir + sep) ? `/files/${relative(contentDir, abs).split(sep).map(encodeURIComponent).join('/')}` : `/files/__outside__`);

function listPhotos(dir, depth = 0) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const abs = join(dir, d.name);
    if (d.isDirectory()) return depth < 2 && !['out', 'node_modules'].includes(d.name) && !d.name.startsWith('out') ? listPhotos(abs, depth + 1) : [];
    return IMAGE_EXT.has(extname(d.name).toLowerCase()) ? [relative(contentDir, abs).split(sep).join('/')] : [];
  });
}

/** Keep only fields the studio may change, so saving can never inject unrelated keys */
function sanitise(incoming, original) {
  const out = { ...original, slides: original.slides.map((s) => ({ ...s })) };
  const text = (v) => (typeof v === 'string' ? v : undefined);
  incoming.slides.forEach((s, i) => {
    const t = out.slides[i];
    if (!t) return;
    for (const k of ['label', 'title', 'subtitle', 'note']) if (k in s) { if (text(s[k])) t[k] = s[k]; else delete t[k]; }
    if ('body' in s) t.body = Array.isArray(s.body) ? s.body.filter((p) => typeof p === 'string' && p.trim()) : text(s.body);
    if (Array.isArray(s.items)) t.items = s.items.filter((x) => typeof x === 'string' && x.trim());
    if (['white', 'black', 'green'].includes(s.theme) || (s.theme === 'pride' && t.theme === 'pride')) t.theme = s.theme;
    if (t.type === 'cover') {
      if (typeof s.image === 'string' && s.image) t.image = s.image; else if (s.image === '') { delete t.image; delete t.photo; }
      if (s.photo && typeof s.photo === 'object') {
        const p = {};
        if (['fill', 'band'].includes(s.photo.mode)) p.mode = s.photo.mode;
        for (const k of ['zoom', 'x', 'y', 'brightness']) if (Number.isFinite(Number(s.photo[k]))) p[k] = Math.round(Number(s.photo[k]) * 100) / 100;
        t.photo = p;
        delete t.focus;
      }
    }
  });
  return out;
}

function runRender() {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [join(repo, 'src/render.js'), contentPath, '--output', outDir], { env: process.env });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('close', (code) => {
      let report = null;
      try { report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8')); } catch { /* render failed before writing */ }
      const pngs = existsSync(outDir) ? readdirSync(outDir).filter((f) => /^\d+\.png$/.test(f)).sort().map((f) => `/files/out/${f}?t=${Date.now()}`) : [];
      ok({ code, log: log.replace(/^Written: .*\n/gm, '').trim(), report, pngs });
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') return sendFrom(join(repo, 'templates/studio'), 'index.html', res);
    if (req.method === 'GET' && url.pathname.startsWith('/ds/')) return sendFrom(dsDir, url.pathname.slice(4), res);
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) return sendFrom(contentDir, url.pathname.slice(7), res);
    if (req.method === 'GET' && url.pathname === '/api/deck') {
      return json(res, 200, { file: contentPath, content: JSON.parse(readFileSync(contentPath, 'utf8')), photos: listPhotos(contentDir), limits: PHOTO_LIMITS });
    }
    if (req.method === 'POST' && url.pathname === '/api/preview') {
      const { content } = await readBody(req);
      const clean = sanitise(content, JSON.parse(readFileSync(contentPath, 'utf8')));
      const { html, warnings } = await buildPreviewHtml(clean, contentDir, { urlFor, dsUrl: '/ds' });
      return json(res, 200, { html, warnings });
    }
    if (req.method === 'POST' && (url.pathname === '/api/save' || url.pathname === '/api/render')) {
      const { content } = await readBody(req);
      const original = JSON.parse(readFileSync(contentPath, 'utf8'));
      const clean = sanitise(content, original);
      await buildPreviewHtml(clean, contentDir, { urlFor, dsUrl: '/ds' }); /* throws on invalid content, so nothing broken is saved */
      const backup = `${contentPath}.bak`;
      if (!existsSync(backup)) copyFileSync(contentPath, backup);
      writeFileSync(contentPath, `${JSON.stringify(clean, null, 2)}\n`);
      if (url.pathname === '/api/save') return json(res, 200, { saved: true });
      return json(res, 200, { saved: true, ...(await runRender()) });
    }
    send(res, 404, 'Not found');
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`DA studio: http://localhost:${port}\nEditing: ${contentPath}\nFirst save keeps a backup at ${contentPath}.bak. Ctrl+C to stop.`);
});
