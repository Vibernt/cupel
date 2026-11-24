#!/usr/bin/env node
// Renders the README artwork (docs/assets/src/*.html) to PNG in Fire's default look.
//
//   node scripts/render-readme-art.mjs --fire /path/to/firedesign [--browser /path/to/chromium] [name...]
//
// A developer tool, not part of Cupel: it needs a Fire checkout (MIT; its `fire/` styles, fonts and
// icons, and its playwright-core) and a Chromium. Pages are served to the browser from disk through
// request routing under a made-up origin: no server is started and nothing leaves the machine.
// Writes docs/assets/<name>.png and <name>-dark.png (the system dark scheme) at twice the CSS size.

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const repo = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name) => { const k = args.indexOf(name); return k >= 0 ? args.splice(k, 2)[1] : undefined; };
const fire = resolve(option('--fire') ?? process.env.FIRE_DIR ?? '');
let browserPath = option('--browser') ?? process.env.CUPEL_ART_BROWSER;
if (!existsSync(join(fire, 'fire', 'fire.css'))) {
  console.error('usage: node scripts/render-readme-art.mjs --fire <Fire checkout> [--browser <chromium>] [name...]');
  process.exit(2);
}
if (!browserPath) {
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const candidates = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse() : [];
  for (const dir of candidates) {
    for (const sub of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
      if (existsSync(join(cache, dir, sub))) { browserPath = join(cache, dir, sub); break; }
    }
    if (browserPath) break;
  }
}
const { chromium } = createRequire(join(fire, 'package.json'))('playwright-core');

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json' };
const ORIGIN = 'http://cupel-art.invalid';
const src = join(repo, 'docs', 'assets', 'src');
const names = args.length ? args : readdirSync(src).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5));

const browser = await chromium.launch({ executablePath: browserPath, headless: true });
try {
  for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1280, height: 900 }, colorScheme: scheme });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = path.startsWith('/fire/') ? join(fire, path) : join(repo, path);
    const inside = path.startsWith('/fire/') ? file.startsWith(join(fire, 'fire')) : file.startsWith(repo);
    if (!inside || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } });
  });
  // Anything not under the made-up origin is refused: the artwork must be self-contained.
  await page.route((url) => !url.href.startsWith(ORIGIN), (route) => route.abort());
  for (const name of names) {
    await page.goto(`${ORIGIN}/docs/assets/src/${name}.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.querySelectorAll('i[data-icon]')].every((i) => i.querySelector('svg')), null, { timeout: 15000 });
    const shot = await page.locator('#art').screenshot({ omitBackground: true, animations: 'disabled' });
    const out = join(repo, 'docs', 'assets', `${name}${scheme === 'dark' ? '-dark' : ''}.png`);
    writeFileSync(out, shot);
    console.log(`wrote ${out} (${shot.length} bytes)`);
  }
  await page.close();
  }
} finally { await browser.close(); }
