/**
 * Dodgeball Australia (DA) carousel renderer.
 *
 * Content JSON with "brand": "da" is routed here. The design system is the single source of truth:
 * colours, fonts and logos are read straight from the DA design system folder; this repo only
 * holds layout structure (templates/da/). See DA.md.
 *
 * Design system location (first that exists):
 *   1. env DA_DESIGN_SYSTEM
 *   2. iCloud DesignStuff/DodgeballAustralia/04-Design-System (local Mac, current location)
 *   3. iCloud DesignStuff/DodgeballAustralia/Dodgeball Australia Design System (previous location)
 *
 * Output: <output>/01.png …, carousel.pdf, report.json (warnings: overflow, small type, contrast, QR).
 */

import { chromium } from 'playwright';
import nunjucks from 'nunjucks';
import QRCode from 'qrcode';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { dirname, join, resolve, isAbsolute } from 'path';
import { homedir } from 'os';
import { pathToFileURL, fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

/* pride = Pride in Sport campaign frame: rainbow stripes top and bottom, DA green field in the middle */
export const DA_THEMES = ['green', 'black', 'white', 'pride'];

/* Each slide type: required fields, whether it takes a photo */
export const DA_TYPES = {
  cover: { required: ['title'], image: true },
  'title-paragraph': { required: ['title', 'body'] },
  bullets: { required: ['title', 'items'] },
  cta: { required: ['title'] },
};

/* Default theme per type, overridable per deck ("theme") or per slide */
const DEFAULT_THEME = { cover: 'black', 'title-paragraph': 'white', bullets: 'green', cta: 'black' };

function findDesignSystem() {
  const candidates = [
    process.env.DA_DESIGN_SYSTEM,
    join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Documents/DesignStuff/DodgeballAustralia/04-Design-System'),
    join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Documents/DesignStuff/DodgeballAustralia/Dodgeball Australia Design System'),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(join(p, 'styles.css')));
  if (!found) {
    throw new Error(`DA design system not found (needs styles.css). Looked in:\n  ${candidates.join('\n  ')}\nSet DA_DESIGN_SYSTEM to point at it.`);
  }
  return found;
}

/**
 * da-design-check: run the design-check skill with the DA profile on the rendered deck.
 * Where the skill isn't installed (e.g. a container), the render still completes and says the check was skipped.
 */
function daDesignCheck(htmlPath, outputDir) {
  const script = process.env.DESIGN_CHECK_SCRIPT || join(homedir(), '.claude/skills/design-check/scripts/check.mjs');
  if (!existsSync(script)) return { status: 'skipped', reason: `design-check not found at ${script}` };
  const jsonPath = join(outputDir, 'design-check.json');
  const playwright = join(dirname(fileURLToPath(import.meta.url)), '../node_modules/playwright/index.mjs');
  const run = spawnSync(process.execPath, [script, htmlPath, '--profile', 'da', '--json', jsonPath], {
    encoding: 'utf8',
    env: { ...process.env, DESIGN_CHECK_PLAYWRIGHT: process.env.DESIGN_CHECK_PLAYWRIGHT || playwright },
  });
  if (run.status !== 0 && run.status !== 2) return { status: 'error', reason: (run.stderr || run.error?.message || 'unknown error').trim() };
  const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
  return { status: run.status === 2 ? 'must-fix' : 'passed', must: result.must, should: result.should, output: run.stdout.trim() };
}

/*
 * Photo framing, adjustable per slide via "photo" (and the studio's sliders). Limits keep a photo covering its area,
 * so framing can change but the brand layout cannot.
 *   fill: full-bleed. zoom scales about the focus point; x/y (-100..100) pan the crop.
 *   band: a landscape photo across the slide on black, faded top and bottom. zoom = width × canvas,
 *         x = shift as % of canvas width (limited so no black edge shows), y = top offset in px.
 */
export const PHOTO_LIMITS = { zoom: [1, 2.5], brightness: [0.7, 1.4], pan: [-100, 100], bandTop: [0, 700] };
const CANVAS_W = 1080; /* matches --da-w in da.css */

function photoFraming(slide, where, warnings) {
  const p = slide.photo || {};
  const num = (v, [lo, hi], name, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) { warnings.push(`${where}: photo.${name} "${v}" is not a number, using ${fallback}`); return fallback; }
    if (n < lo - 1e-9 || n > hi + 1e-9) warnings.push(`${where}: photo.${name} ${n} is outside ${+lo.toFixed(1)} to ${+hi.toFixed(1)}, limited`);
    return Math.min(hi, Math.max(lo, n));
  };
  const zoom = num(p.zoom, PHOTO_LIMITS.zoom, 'zoom', 1);
  const brightness = num(p.brightness, PHOTO_LIMITS.brightness, 'brightness', 1);
  const filter = brightness !== 1 ? `filter: brightness(${brightness});` : '';
  if (p.mode === 'band') {
    const width = CANVAS_W * zoom;
    const maxShift = ((width - CANVAS_W) / 2 / CANVAS_W) * 100;
    const x = num(p.x, [-maxShift, maxShift], 'x', 0);
    const top = num(p.y, PHOTO_LIMITS.bandTop, 'y', 0);
    return { mode: 'band', style: `width: ${width}px; left: ${(CANVAS_W - width) / 2 + (x / 100) * CANVAS_W}px; top: ${top}px; ${filter}` };
  }
  if (p.mode && p.mode !== 'fill') warnings.push(`${where}: unknown photo.mode "${p.mode}", using fill`);
  const x = num(p.x, PHOTO_LIMITS.pan, 'x', 0);
  const y = num(p.y, PHOTO_LIMITS.pan, 'y', 0);
  /* Scaling about a point inside the image always keeps it covering the frame, so zoom never shows an edge */
  const pos = slide.photo ? `${50 + x / 2}% ${50 + y / 2}%` : slide.focus || 'center';
  return { mode: 'fill', style: `object-position: ${pos}; transform-origin: ${pos}; transform: scale(${zoom}); ${filter}` };
}

/** Validate content and resolve photo paths. Errors abort; a missing photo only warns.
 *  urlFor maps a local file to the URL the page loads it from (file:// for renders, http for the studio). */
async function prepareSlides(content, contentDir, warnings, urlFor = (abs) => pathToFileURL(abs).href) {
  if (!Array.isArray(content.slides) || content.slides.length === 0) {
    throw new Error('Content JSON needs a non-empty "slides" array.');
  }
  const errors = [];
  if (content.theme && !DA_THEMES.includes(content.theme)) errors.push(`Unknown theme "${content.theme}" (use ${DA_THEMES.join(', ')})`);
  for (const [i, slide] of content.slides.entries()) {
    const where = `Slide ${i + 1} (${slide.type})`;
    const spec = DA_TYPES[slide.type];
    if (!spec) { errors.push(`Slide ${i + 1}: unknown type "${slide.type}" (use ${Object.keys(DA_TYPES).join(', ')})`); continue; }
    for (const key of spec.required) {
      const v = slide[key];
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) errors.push(`${where}: missing "${key}"`);
    }
    if (slide.body !== undefined) slide.paras = Array.isArray(slide.body) ? slide.body : [slide.body];
    slide.theme = slide.theme || content.theme || DEFAULT_THEME[slide.type];
    if (!DA_THEMES.includes(slide.theme)) errors.push(`${where}: unknown theme "${slide.theme}"`);
    if (slide.image) {
      if (!spec.image) warnings.push(`${where}: this type takes no photo, image ignored`);
      else {
        const abs = isAbsolute(slide.image) ? slide.image : resolve(contentDir, slide.image);
        if (existsSync(abs)) {
          slide.imageUrl = urlFor(abs);
          const framing = photoFraming(slide, where, warnings);
          slide.photoMode = framing.mode;
          slide.photoStyle = framing.style;
        } else warnings.push(`${where}: photo ${slide.image} not found, rendered without it`);
      }
    } else if (slide.photo) warnings.push(`${where}: "photo" settings need an "image", ignored`);
    if (slide.qr) {
      /* The URL is encoded exactly as written — never trimmed, re-encoded or shortened.
         Partner links (e.g. Pride in Sport) must be distributed character-for-character. */
      if (typeof slide.qr !== 'string' || !/^https?:\/\//.test(slide.qr)) errors.push(`${where}: "qr" must be a full http(s) URL`);
      else slide.qrSvg = await QRCode.toString(slide.qr, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }); /* allow-hardcoded: QR must be pure black on white to scan */
    }
  }
  /* Partner logos (e.g. Pride in Sport) shown in a row with the DA emblem lockup. A missing file renders a
     labelled dashed placeholder and a warning — partner artwork must come from the partner, never be redrawn. */
  content.partnerList = (content.partners || []).map((p, k) => {
    if (!p.name) errors.push(`partners[${k}]: missing "name"`);
    const abs = p.image && (isAbsolute(p.image) ? p.image : resolve(contentDir, p.image));
    if (abs && existsSync(abs)) return { ...p, imageUrl: urlFor(abs) };
    warnings.push(`Partner logo "${p.name}" ${p.image ? `not found at ${p.image}` : 'has no image'} — placeholder shown`);
    return { ...p };
  });
  if (errors.length) throw new Error('Content has errors, nothing rendered:\n  ' + errors.join('\n  '));
}

/** Deck HTML for the studio's live preview: same templates and checks on content, served over http. */
export async function buildPreviewHtml(content, contentDir, { urlFor, dsUrl }) {
  const copy = JSON.parse(JSON.stringify(content));
  const warnings = [];
  await prepareSlides(copy, contentDir, warnings, urlFor);
  return { html: buildHtml(copy, findDesignSystem(), dsUrl), warnings };
}

export { findDesignSystem };

function buildHtml(content, dsDir, dsUrl = pathToFileURL(dsDir).href) {
  const root = resolve(dirname(new URL(import.meta.url).pathname), '..', 'templates', 'da');
  const env = nunjucks.configure(root, { autoescape: true });
  env.addFilter('pad2', (n) => String(n).padStart(2, '0'));
  env.addFilter('br', (s) => new nunjucks.runtime.SafeString(
    nunjucks.lib.escape(String(s ?? '')).replace(/\r?\n/g, '<br>')));
  /* Brand device: a full stop closing a display line is set in gold ("HAVE YOUR SAY.") */
  env.addFilter('stop', (s) => new nunjucks.runtime.SafeString(
    nunjucks.lib.escape(String(s ?? '')).replace(/\r?\n/g, '<br>').replace(/\.(?=<br>|$)/g, '<span class="da-stop">.</span>')));
  return env.render('deck.html', {
    title: content.title || 'Dodgeball Australia carousel',
    series: content.series || '',
    showPageNo: content.pageNumbers !== false,
    slides: content.slides,
    partners: content.partnerList,
    dsUrl,
    inlineStyles: readFileSync(join(root, 'da.css'), 'utf-8'),
  });
}

/** Overflow check: the [data-fit] box must hold its content. No auto-shrink — too much copy is a copy problem. */
async function fitPages(page) {
  return page.evaluate(() => [...document.querySelectorAll('.da-frame')].map((frame, i) => {
    const box = frame.querySelector('[data-fit]');
    if (!box) return { page: i + 1, status: 'ok' };
    const over = box.scrollHeight - box.clientHeight;
    return over > 1 ? { page: i + 1, status: 'overflow', overPx: Math.round(over) } : { page: i + 1, status: 'ok' };
  }));
}

/** Static check: templates and da.css must use design system tokens, not hard-coded colours. */
function lintHardcodedColors() {
  const root = resolve(dirname(new URL(import.meta.url).pathname), '..', 'templates', 'da');
  const files = [join(root, 'da.css'), join(root, 'deck.html'), ...readdirSync(join(root, 'slides')).map((f) => join(root, 'slides', f))];
  const hits = [];
  for (const f of files) {
    readFileSync(f, 'utf-8').split('\n').forEach((line, i) => {
      if (line.includes('allow-hardcoded')) return;
      if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(line.replace(/\/\*.*?\*\//g, ''))) hits.push(`${f.slice(root.length + 1)}:${i + 1}`);
    });
  }
  return hits;
}

/**
 * Per-page checks after layout: text below the minimum social size (--da-min-text) and
 * WCAG AA contrast against the composited background. Text over a photo cannot be checked
 * automatically and is counted as unchecked, not passed.
 */
async function checkPages(page) {
  return page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgba = (c) => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255];
    };
    const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const minPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--da-min-text')) || 24;
    return [...document.querySelectorAll('.da-frame')].map((frame, i) => {
      const small = []; const low = []; let unchecked = 0; const seen = new Set();
      const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const el = t.parentElement;
        if (!t.textContent.trim() || seen.has(el) || el.closest('svg')) continue;
        seen.add(el);
        const cs = getComputedStyle(el);
        if (!el.getClientRects().length) continue;
        const px = parseFloat(cs.fontSize);
        const text = t.textContent.trim().slice(0, 16);
        if (px < minPx - 0.5) small.push(`"${text}" ${px}px`);
        if (el.closest('.has-photo [data-over-photo]')) { unchecked++; continue; }
        let bg = [255, 255, 255, 1];
        const chain = [];
        for (let n = el; n && n !== frame.parentElement; n = n.parentElement) chain.unshift(n);
        for (const n of chain) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) bg = over(c, bg); }
        const r = ratio(over(rgba(cs.color), bg), bg);
        const large = px >= 24 || (parseInt(cs.fontWeight, 10) >= 700 && px >= 18.67);
        const need = large ? 3 : 4.5;
        if (r < need) low.push(`"${text}" ${r.toFixed(2)}:1 (needs ${need}:1)`);
      }
      return { page: i + 1, small, low, unchecked };
    });
  });
}

export async function renderDa(content, { contentPath, outputDir, imageFormat = 'png', noPdf = false }) {
  const warnings = [];
  const dsDir = findDesignSystem();
  await prepareSlides(content, dirname(contentPath), warnings);

  mkdirSync(outputDir, { recursive: true });
  /* Written to disk and opened via file:// so styles.css relative paths (fonts, logos) resolve */
  const htmlPath = join(outputDir, '_deck.html');
  writeFileSync(htmlPath, buildHtml(content, dsDir));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.images].map((im) => im.decode().catch(() => {}))));

  const fit = await fitPages(page);
  for (const f of fit) if (f.status === 'overflow') warnings.push(`Slide ${f.page}: content overflows by ${f.overPx}px — cut copy or split the slide`);
  const checks = { hardcodedColors: lintHardcodedColors(), pages: await checkPages(page) };
  if (checks.hardcodedColors.length) warnings.push(`Hard-coded colours (use design system tokens): ${checks.hardcodedColors.join(', ')}`);
  for (const c of checks.pages) {
    if (c.small.length) warnings.push(`Slide ${c.page}: text below 24px: ${c.small.join(', ')}`);
    if (c.low.length) warnings.push(`Slide ${c.page}: low contrast: ${c.low.join(', ')}`);
    if (c.unchecked) warnings.push(`Slide ${c.page}: ${c.unchecked} text block(s) over a photo — contrast not auto-checked, check by eye`);
  }

  const ext = imageFormat === 'jpeg' ? 'jpg' : 'png';
  const frames = page.locator('.da-frame');
  const count = await frames.count();
  const files = [];
  for (let i = 0; i < count; i++) {
    const path = join(outputDir, `${String(i + 1).padStart(2, '0')}.${ext}`);
    await frames.nth(i).screenshot({ path, type: imageFormat });
    files.push(path);
    console.log('Written:', path);
  }
  if (!noPdf) {
    const pdfPath = join(outputDir, 'carousel.pdf');
    await page.addStyleTag({ content: 'body{background:none}' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: pdfPath, width: '1080px', height: '1350px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    files.push(pdfPath);
    console.log('Written:', pdfPath);
  }
  await browser.close();

  const qr = content.slides.filter((s) => s.qr).map((s) => s.qr);
  const designCheck = daDesignCheck(htmlPath, outputDir);
  if (designCheck.status === 'skipped' || designCheck.status === 'error') warnings.push(`da-design-check did not run: ${designCheck.reason}`);
  const report = { designSystem: dsDir, size: '1080x1350', qr, checks, designCheck: { status: designCheck.status, must: designCheck.must, should: designCheck.should, reason: designCheck.reason }, pages: count, files, warnings, ok: !fit.some((f) => f.status === 'overflow') && designCheck.status !== 'must-fix' };
  writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  if (designCheck.output) console.log(`\nda-design-check:\n${designCheck.output}`);
  if (warnings.length) { console.log('\nWarnings:'); warnings.forEach((w) => console.log('  - ' + w)); }
  if (!report.ok) process.exitCode = 2;
  return report;
}
