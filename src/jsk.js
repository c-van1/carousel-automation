/**
 * 肌本 (Just Skincare) 版型出圖。
 *
 * 內容 JSON 的 "brand": "jsk" 會走這裡。設計系統是唯一的事實來源:
 * token、字型、結尾卡圖都直接從設計系統資料夾讀,本 repo 不存任何品牌數值。
 *
 * 設計系統位置(按次序找第一個存在的):
 *   1. 環境變數 JSK_DESIGN_SYSTEM
 *   2. /opt/jsk/design/DesignAsset/Just Skincare Design System(Hermes 容器)
 *   3. iCloud 的 DesignStuff/Just/DesignAsset/Just Skincare Design System(本機 Mac)
 *
 * 輸出:<output>/01.png …、carousel.pdf、report.json(警告:缺相片、自動縮字、超字)。
 */

import { chromium } from 'playwright';
import nunjucks from 'nunjucks';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve, isAbsolute } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';

/* 尺寸:實際高度由設計系統 token 決定(--social-h、--social-h-reel、--social-h-square),
   這裡只列可選名稱;出圖時從頁面量度畫布大小 */
export const JSK_SIZES = ['post', 'story', 'square'];
/* 樣式:green = 綠底圓形裝飾(預設);band = 米白底綠色頁首條 */
export const JSK_STYLES = ['green', 'band'];

/* 每種版型:必填欄位、可放相片與否 */
export const JSK_TYPES = {
  cover: { required: ['title'], image: true },
  'title-paragraph': { required: [], image: true, oneOf: ['title', 'body'] },
  numbered: { required: ['items'] },
  bullets: { required: ['items'] },
  statement: { required: ['text'] },
  product: { required: [], image: true, oneOf: ['name', 'sku'] },
  products: { required: ['items'] },
  menu: { required: ['rows'] },
  bundle: { required: ['items'] },
  steps: { required: ['steps'] },
  'qa-photo': { required: ['question'], image: true },
  end: { required: [] },
};

function findDesignSystem() {
  const candidates = [
    process.env.JSK_DESIGN_SYSTEM,
    '/opt/jsk/design/DesignAsset/Just Skincare Design System',
    join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Documents/DesignStuff/Just/DesignAsset/Just Skincare Design System'),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(join(p, 'styles.css')));
  if (!found) {
    throw new Error(`找不到設計系統(需要 styles.css)。已找過:\n  ${candidates.join('\n  ')}\n可用環境變數 JSK_DESIGN_SYSTEM 指定。`);
  }
  return found;
}

/**
 * 讀價錢檔。價錢不寫在內容 JSON,一律由 SKU 對 Odoo 匯出的價錢檔
 * (tools/sku_prices.py 或 odoo.py read 的輸出,陣列或 {SKU: {...}} 皆可)。
 */
function loadPrices(content, contentDir) {
  if (!content.prices) return null;
  const abs = isAbsolute(content.prices) ? content.prices : resolve(contentDir, content.prices);
  if (!existsSync(abs)) throw new Error(`找不到價錢檔 ${content.prices}`);
  const raw = JSON.parse(readFileSync(abs, 'utf-8'));
  const rows = Array.isArray(raw) ? raw : Object.entries(raw).map(([k, v]) => ({ default_code: k, ...v }));
  return Object.fromEntries(rows.map((r) => [r.default_code, { name: r.name, listPrice: Number(r.list_price) }]));
}

/** 由 SKU 計原價與折後價;discount 0.5 = 五折。非整數會四捨五入並警告。 */
function priceFor(sku, prices, promo, where, errors, warnings) {
  if (!prices) { errors.push(`${where}:用了 sku "${sku}" 但內容沒有指定 "prices" 價錢檔`); return null; }
  const p = prices[sku];
  if (!p || !Number.isFinite(p.listPrice)) { errors.push(`${where}:價錢檔沒有 ${sku}`); return null; }
  const out = { sku, name: p.name, was: p.listPrice, now: p.listPrice };
  if (promo && promo.discount) {
    const exact = p.listPrice * (1 - promo.discount);
    out.now = Math.round(exact);
    if (out.now !== exact) warnings.push(`${where}:${sku} 折後價 ${exact} 已四捨五入為 ${out.now}`);
  }
  return out;
}

/** 檢查內容、解析相片路徑。錯誤直接中止;缺相片只警告並改用無相片版本。 */
function prepareSlides(content, contentDir, warnings) {
  if (!Array.isArray(content.slides) || content.slides.length === 0) {
    throw new Error('內容 JSON 必須有非空的 "slides" 陣列。');
  }
  const errors = [];
  const prices = loadPrices(content, contentDir);
  const promo = content.promo || null;
  if (promo && !(promo.discount > 0 && promo.discount < 1)) {
    errors.push(`promo.discount 必須是 0 至 1 之間的折扣比例(五折 = 0.5),現為 ${promo.discount}`);
  }
  const size = content.size || 'post';
  if (!JSK_SIZES.includes(size)) errors.push(`未知尺寸 "${content.size}",可用:${JSK_SIZES.join('、')}`);
  if (content.style && !JSK_STYLES.includes(content.style)) {
    errors.push(`未知樣式 "${content.style}",可用:${JSK_STYLES.join('、')}`);
  }
  content.slides.forEach((slide, i) => {
    const page = i + 1;
    const spec = JSK_TYPES[slide.type];
    if (!spec) {
      errors.push(`第 ${page} 頁:未知版型 "${slide.type}",可用:${Object.keys(JSK_TYPES).join('、')}`);
      return;
    }
    for (const key of spec.required) {
      const v = slide[key];
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
        errors.push(`第 ${page} 頁(${slide.type}):缺少 "${key}"`);
      }
    }
    if (spec.oneOf && !spec.oneOf.some((k) => slide[k])) {
      errors.push(`第 ${page} 頁(${slide.type}):${spec.oneOf.join(' 或 ')} 至少要有一個`);
    }
    const where = `第 ${page} 頁(${slide.type})`;
    const imgUrl = (path, label) => {
      if (!path) return undefined;
      const abs = isAbsolute(path) ? path : resolve(contentDir, path);
      if (existsSync(abs)) return pathToFileURL(abs).href;
      warnings.push(`${where}:找不到${label}相片 ${path},已略過`);
      return undefined;
    };
    if (slide.type === 'menu' && Array.isArray(slide.rows)) {
      slide.rows.forEach((row, k) => {
        if (!row.text) errors.push(`${where}:第 ${k + 1} 行缺少 text`);
        row.imageUrls = (row.images || []).map((im) => imgUrl(im, `第 ${k + 1} 行`)).filter(Boolean);
      });
    }
    if (slide.type === 'steps' && Array.isArray(slide.steps)) {
      slide.steps.forEach((st, k) => {
        if (!st.title && !st.text) errors.push(`${where}:第 ${k + 1} 步 title 或 text 至少要有一個`);
        st.imageUrl = imgUrl(st.image, `第 ${k + 1} 步`);
      });
    }
    if (slide.type === 'bundle' && Array.isArray(slide.items)) {
      slide.items.forEach((item, k) => {
        if (!item.sku) { errors.push(`${where}:第 ${k + 1} 款缺少 sku`); return; }
        item.price = priceFor(item.sku, prices, promo, where, errors, warnings);
        item.imageUrl = imgUrl(item.image, ` ${item.sku} `);
      });
      const ps = slide.items.map((it) => it.price).filter(Boolean);
      slide.sum = { now: ps.reduce((a, b) => a + b.now, 0), was: ps.reduce((a, b) => a + b.was, 0) };
    }
    if (slide.type === 'qa-photo' && !slide.image) warnings.push(`${where}:沒有實拍相片,改用綠底`);
    if (slide.type === 'products' && Array.isArray(slide.items)) {
      if (slide.items.length > 5) errors.push(`${where}:最多 5 款,現有 ${slide.items.length} 款`);
      if (slide.join && !['plus', 'steps', 'none'].includes(slide.join)) {
        errors.push(`${where}:join 只可以是 plus、steps 或 none`);
      }
      slide.items.forEach((item, k) => {
        if (!item.sku) { errors.push(`${where}:第 ${k + 1} 款缺少 sku`); return; }
        item.price = priceFor(item.sku, prices, promo, where, errors, warnings);
        if (item.image) {
          const abs = isAbsolute(item.image) ? item.image : resolve(contentDir, item.image);
          if (existsSync(abs)) item.imageUrl = pathToFileURL(abs).href;
          else warnings.push(`${where}:找不到 ${item.sku} 相片 ${item.image},只出文字`);
        } else warnings.push(`${where}:${item.sku} 沒有相片,只出文字`);
      });
      /* 合共:plus、steps 預設顯示,可用 total: false 關閉 */
      const join = slide.join || 'none';
      if (slide.total ?? (join !== 'none' && slide.items.length > 1)) {
        const ps = slide.items.map((it) => it.price).filter(Boolean);
        slide.sum = { now: ps.reduce((a, b) => a + b.now, 0), was: ps.reduce((a, b) => a + b.was, 0) };
      }
    }
    if (slide.sku) slide.price = priceFor(slide.sku, prices, promo, `第 ${page} 頁(${slide.type})`, errors, warnings);
    /* 徽章:有 promo 時封面預設顯示,其他頁要 "badge": true;"badge": false 一律隱藏 */
    slide.showBadge = Boolean(promo) && slide.badge !== false && (slide.badge === true || slide.type === 'cover');
    if (slide.badge === true && !promo) warnings.push(`第 ${page} 頁:要求顯示徽章但內容沒有 "promo",已略過`);
    if (slide.style && !JSK_STYLES.includes(slide.style)) {
      errors.push(`第 ${page} 頁:未知樣式 "${slide.style}",可用:${JSK_STYLES.join('、')}`);
    }
    if (slide.type === 'end' && size !== 'post') {
      warnings.push(`第 ${page} 頁(end):設計系統只有 4:5 結尾卡,${size} 尺寸以綠底置中顯示`
        + (slide.cta ? ',自訂 cta 只適用 4:5,已忽略' : ''));
      delete slide.cta;
    }
    if (slide.image) {
      if (!spec.image) {
        warnings.push(`第 ${page} 頁(${slide.type}):此版型不放相片,已忽略 image`);
      } else {
        const abs = isAbsolute(slide.image) ? slide.image : resolve(contentDir, slide.image);
        if (existsSync(abs)) slide.imageUrl = pathToFileURL(abs).href;
        else warnings.push(`第 ${page} 頁(${slide.type}):找不到相片 ${slide.image},已改用無相片版本`);
      }
    } else if (slide.type === 'product') {
      warnings.push(`第 ${page} 頁(product):沒有產品相片,只出文字版本`);
    }
  });
  if (errors.length) throw new Error('內容有誤,未出圖:\n  ' + errors.join('\n  '));
}

function buildHtml(content, dsDir) {
  const root = resolve(dirname(new URL(import.meta.url).pathname), '..', 'templates', 'jsk');
  const env = nunjucks.configure(root, { autoescape: true });
  env.addFilter('pad2', (n) => String(n).padStart(2, '0'));
  env.addFilter('br', (s) => new nunjucks.runtime.SafeString(
    nunjucks.lib.escape(String(s ?? '')).replace(/\r?\n/g, '<br>')));
  const cloudPath = join(dsDir, 'assets/patterns/accent-cloud.svg');
  return env.render('deck.html', {
    title: content.title || '肌本 Carousel',
    series: content.series || '',
    showPageNo: content.pageNumbers !== false,
    slides: content.slides,
    size: content.size || 'post',
    deckStyle: content.style || 'green',
    bandRight: content.bandRight || '',
    currency: content.currency ?? 'HK$',
    badgeTop: content.promo ? (content.promo.badgeTop || `${Math.round(content.promo.discount * 100)}%`) : '',
    badgeBottom: content.promo ? (content.promo.badgeBottom ?? 'OFF') : '',
    flowerSvg: readFileSync(join(root, 'flower.svg'), 'utf-8').replace(/<!--[\s\S]*?-->\n?/, ''),
    dsUrl: pathToFileURL(dsDir).href,
    cloudSvg: existsSync(cloudPath) ? readFileSync(cloudPath, 'utf-8') : '',
    inlineStyles: readFileSync(join(root, 'jsk.css'), 'utf-8'),
  });
}

/**
 * 在頁面內逐頁檢查內容是否放得下;放不下就把正文([data-shrink])逐步縮小,
 * 直到放得下或到達 --jsk-body-min。回傳每頁的處理結果。
 */
async function fitPages(page) {
  return page.evaluate(() => {
    const min = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--jsk-body-min')) || 34;
    const span = (box) => {
      const kids = [...box.children].filter((k) => k.offsetParent !== null);
      if (!kids.length) return 0;
      const first = kids[0].getBoundingClientRect();
      const last = kids[kids.length - 1].getBoundingClientRect();
      const mt = parseFloat(getComputedStyle(kids[0]).marginTop) || 0;
      const mb = parseFloat(getComputedStyle(kids[kids.length - 1]).marginBottom) || 0;
      return last.bottom + mb - (first.top - mt);
    };
    return [...document.querySelectorAll('.jsk-frame')].map((frame, i) => {
      const box = frame.querySelector('[data-fit]');
      if (!box) return { page: i + 1, status: 'ok' };
      const targets = [...box.querySelectorAll('[data-shrink]')];
      const start = targets.length ? parseFloat(getComputedStyle(targets[0]).fontSize) : 0;
      let size = start;
      while (span(box) > box.clientHeight + 1 && targets.length && size - 2 >= min) {
        size -= 2;
        targets.forEach((t) => { t.style.fontSize = `${size}px`; });
      }
      const over = span(box) - box.clientHeight;
      if (over > 1) return { page: i + 1, status: 'overflow', overPx: Math.round(over), fromPx: start, fontPx: size };
      if (size !== start) return { page: i + 1, status: 'shrunk', fromPx: start, fontPx: size };
      return { page: i + 1, status: 'ok' };
    });
  });
}

export async function renderJsk(content, { contentPath, outputDir, imageFormat = 'png', noPdf = false }) {
  const warnings = [];
  const dsDir = findDesignSystem();
  prepareSlides(content, dirname(contentPath), warnings);

  mkdirSync(outputDir, { recursive: true });
  /* 寫成檔案再以 file:// 開啟,styles.css 的相對路徑(字型、圖)才解析得到 */
  const htmlPath = join(outputDir, '_deck.html');
  writeFileSync(htmlPath, buildHtml(content, dsDir));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  /* 等所有相片解碼完才截圖,避免截到未畫完的頁(曾出現下半頁空白) */
  await page.evaluate(() => Promise.all([...document.images].map((im) => im.decode().catch(() => {}))));
  /* 畫布大小以設計系統 token 為準,量度第一頁後把視窗設成同一大小 */
  const { W, H } = await page.evaluate(() => {
    const f = document.querySelector('.jsk-frame').getBoundingClientRect();
    return { W: Math.round(f.width), H: Math.round(f.height) };
  });
  await page.setViewportSize({ width: W, height: H });

  const fit = await fitPages(page);
  for (const f of fit) {
    if (f.status === 'shrunk') warnings.push(`第 ${f.page} 頁:字數偏多,正文由 ${f.fromPx}px 自動縮至 ${f.fontPx}px`);
    if (f.status === 'overflow') warnings.push(`第 ${f.page} 頁:超出版面 ${f.overPx}px`
      + (f.fontPx < f.fromPx ? `(正文已縮至下限 ${f.fontPx}px)` : '') + ',請刪字、減少產品或分頁');
  }

  const ext = imageFormat === 'jpeg' ? 'jpg' : 'png';
  const frames = page.locator('.jsk-frame');
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
    await page.pdf({ path: pdfPath, width: `${W}px`, height: `${H}px`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    files.push(pdfPath);
    console.log('Written:', pdfPath);
  }
  await browser.close();

  const report = { designSystem: dsDir, size: `${W}x${H}`, pages: count, files, warnings, ok: !fit.some((f) => f.status === 'overflow') };
  writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  if (warnings.length) {
    console.log('\n注意:');
    warnings.forEach((w) => console.log('  - ' + w));
  }
  if (!report.ok) process.exitCode = 2;
  return report;
}
