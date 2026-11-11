import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const sharp = requireFromApi('sharp');

const paper = '#F7F3EC';
const ink = '#8D4F39';
const light = '#FFFCF7';
const bookPaths = `
  <path d="M12 7v14"/>
  <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>`;

function bookSvg({ width, height, background = ink, round = false, transparent = false }) {
  const size = Math.min(width, height);
  const icon = Math.round(size * (transparent ? 0.5 : 0.5625));
  const x = Math.round((width - icon) / 2);
  const y = Math.round((height - icon) / 2);
  const backdrop = transparent ? '' : round
    ? `<circle cx="${width / 2}" cy="${height / 2}" r="${size / 2}" fill="${background}"/>`
    : `<rect width="${width}" height="${height}" fill="${background}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${backdrop}
    <svg x="${x}" y="${y}" width="${icon}" height="${icon}" viewBox="0 0 24 24" fill="none" stroke="${light}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${bookPaths}</svg>
  </svg>`;
}

function splashSvg(width, height) {
  const tile = Math.round(Math.min(width, height) * 0.28);
  const x = Math.round((width - tile) / 2);
  const y = Math.round((height - tile) / 2);
  const icon = Math.round(tile * 0.56);
  const iconX = Math.round(x + (tile - icon) / 2);
  const iconY = Math.round(y + (tile - icon) / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${paper}"/>
    <rect x="${x}" y="${y}" width="${tile}" height="${tile}" rx="${Math.round(tile * 0.22)}" fill="${ink}"/>
    <svg x="${iconX}" y="${iconY}" width="${icon}" height="${icon}" viewBox="0 0 24 24" fill="none" stroke="${light}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${bookPaths}</svg>
  </svg>`;
}

async function pngFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return pngFiles(target);
    return entry.isFile() && entry.name.endsWith('.png') ? [target] : [];
  }));
  return nested.flat();
}

async function render(svg, target, width, height, { allowAlpha = false } = {}) {
  let image = sharp(Buffer.from(svg)).resize(width, height);
  if (!allowAlpha) image = image.removeAlpha();
  await image.png({ compressionLevel: 9 }).toFile(target);
  const result = await sharp(target).metadata();
  if (result.width !== width || result.height !== height) throw new Error(`资源尺寸错误：${target}`);
  if (!allowAlpha && result.hasAlpha) throw new Error(`资源不应包含 Alpha 通道：${target}`);
}

const generated = [];
async function renderExisting(target, type) {
  const { width, height } = await sharp(target).metadata();
  if (!width || !height) throw new Error(`无法读取资源尺寸：${target}`);
  const svg = type === 'splash' ? splashSvg(width, height)
    : bookSvg({ width, height, round: type === 'round', transparent: type === 'foreground' });
  await render(svg, target, width, height, { allowAlpha: type === 'round' || type === 'foreground' });
  generated.push(path.relative(root, target));
}

const pwaDirectory = path.join(root, 'apps/client/pwa');
for (const size of [192, 512]) {
  const target = path.join(pwaDirectory, `icon-${size}.png`);
  await render(bookSvg({ width: size, height: size }), target, size, size);
  generated.push(path.relative(root, target));
}

const androidRes = path.join(root, 'apps/mobile/android/app/src/main/res');
for (const target of await pngFiles(androidRes)) {
  const name = path.basename(target);
  if (name === 'splash.png') await renderExisting(target, 'splash');
  else if (name === 'ic_launcher_foreground.png') await renderExisting(target, 'foreground');
  else if (name === 'ic_launcher_round.png') await renderExisting(target, 'round');
  else if (name === 'ic_launcher.png') await renderExisting(target, 'icon');
}

const iosAssets = path.join(root, 'apps/mobile/ios/App/App/Assets.xcassets');
for (const target of await pngFiles(iosAssets)) {
  await renderExisting(target, path.basename(target).startsWith('splash-') ? 'splash' : 'icon');
}

console.log(`Generated ${generated.length} branded PWA, Android and iOS assets.`);
