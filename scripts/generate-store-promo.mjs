#!/usr/bin/env node
// Regenerates the Chrome Web Store promo tiles from their reviewed HTML source.
//
//   node scripts/generate-store-promo.mjs
//
// Source of truth: store-assets/promo/promo-tiles.html (vector/type only; no
// screenshots, credentials, account data, or captured content of any kind).
// Outputs are overwritten in place at exact Chrome Web Store dimensions:
//   store-assets/promo/small-tile.png  440x280
//   store-assets/promo/marquee.png     1400x560
//
// Browser resolution mirrors tests/runtime/puppeteer-runtime.mjs:
// PUPPETEER_EXECUTABLE_PATH first, then the puppeteer-managed Chrome. Some
// environments have a Chrome build whose headless screenshots never resolve;
// each candidate gets a bounded protocol timeout and the stable Chrome channel
// is tried as a fallback so the script fails loudly instead of hanging.
// Text rendering uses the host system font stack, matching the existing
// scripts/capture-store-screenshots.mjs host-dependent rendering model.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const root = process.cwd();
const source = path.join(root, 'store-assets/promo/promo-tiles.html');
const tiles = [
  { query: 'small', file: 'small-tile.png', width: 440, height: 280 },
  { query: 'marquee', file: 'marquee.png', width: 1400, height: 560 },
];
const protocolTimeout = 30000;

if (!existsSync(source)) {
  throw new Error(`Promo tile source is missing: ${path.relative(root, source)}`);
}

const candidates = [];
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  if (!existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    throw new Error(
      `PUPPETEER_EXECUTABLE_PATH does not exist: ${process.env.PUPPETEER_EXECUTABLE_PATH}`,
    );
  }
  candidates.push({
    label: 'PUPPETEER_EXECUTABLE_PATH',
    options: { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH },
  });
} else {
  const managed = await puppeteer.executablePath();
  if (existsSync(managed)) {
    candidates.push({ label: 'puppeteer-managed Chrome', options: { executablePath: managed } });
  }
}
candidates.push({ label: 'stable Chrome channel', options: { channel: 'chrome' } });

let lastError;
for (const candidate of candidates) {
  try {
    await renderTiles(candidate.options);
    console.log(`Rendered promo tiles with ${candidate.label}.`);
    lastError = undefined;
    break;
  } catch (error) {
    lastError = error;
    console.warn(
      `Promo tile render with ${candidate.label} failed: ${String(error).split('\n')[0]}`,
    );
  }
}
if (lastError) {
  throw new Error(
    `Could not render promo tiles with any Chrome candidate. Last error: ${lastError}`,
  );
}

async function renderTiles(launchOptions) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout,
      args: ['--force-color-profile=srgb', '--hide-scrollbars'],
      ...launchOptions,
    });
    for (const tile of tiles) {
      const page = await browser.newPage();
      await page.setViewport({ width: tile.width, height: tile.height, deviceScaleFactor: 1 });
      const url = pathToFileURL(source);
      url.search = `?tile=${tile.query}`;
      // 'networkidle0' never settles for file:// pages; 'load' plus explicit
      // font/image waits is deterministic here.
      await page.goto(url.href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(
        () => [...document.images].every((img) => img.complete && img.naturalWidth > 0),
      );
      const output = path.join(root, 'store-assets/promo', tile.file);
      await page.screenshot({ path: output });
      const { width, height } = pngDimensions(output);
      assert.equal(width, tile.width, `${tile.file} width`);
      assert.equal(height, tile.height, `${tile.file} height`);
      console.log(`Rendered ${tile.file} at ${width}x${height}`);
      await page.close();
    }
  } finally {
    await browser?.close().catch(() => {});
  }
}

function pngDimensions(file) {
  const header = readFileSync(file).subarray(0, 24);
  assert.equal(header.toString('hex', 1, 4), '504e47', `${path.basename(file)} is not a PNG`);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}
