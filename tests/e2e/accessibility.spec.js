import { test, expect } from '@playwright/test';

async function ready(page, path = '/today?date=2026-09-09') {
  await page.goto(path);
  await expect(page.getByRole('heading').first()).toBeVisible();
}

async function openEditorOnMobile(page) {
  if (page.viewportSize().width < 768) await page.getByRole('button', { name: /^(开始写|继续写)$/ }).click();
}

test('keyboard users can reveal the skip link and move focus to the main content', async ({ page }) => {
  for (const path of ['/today?date=2026-09-09', '/login']) {
    await ready(page, path);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: '跳到正文' });
    await expect(skip).toBeFocused();
    const focus = await skip.evaluate((element) => {
      const style = getComputedStyle(element);
      return { top: element.getBoundingClientRect().top, width: parseFloat(style.outlineWidth), style: style.outlineStyle };
    });
    expect(focus.top).toBeGreaterThanOrEqual(0);
    expect(focus.width).toBeGreaterThanOrEqual(2);
    expect(focus.style).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main')).toBeFocused();
  }
});

test('visible interactive controls have programmatic or visible names', async ({ page }) => {
  await ready(page);
  await openEditorOnMobile(page);
  for (const path of ['/today?date=2026-09-09', '/tasks', '/search', '/settings', '/login']) {
    await ready(page, path);
    if (path.startsWith('/today')) await openEditorOnMobile(page);
    const unnamed = await page.locator('button:visible, a[href]:visible, input:visible, select:visible, textarea:visible, [role="textbox"]:visible').evaluateAll((elements) => elements.flatMap((element) => {
      if (element.getAttribute('aria-hidden') === 'true') return [];
      const labelledBy = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      const labels = 'labels' in element ? [...(element.labels ?? [])].map((label) => label.textContent ?? '').join(' ') : '';
      const name = [element.getAttribute('aria-label'), labelledBy, labels, element.textContent, element.getAttribute('title')]
        .find((value) => value?.trim())?.trim();
      return name ? [] : [`${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}.${element.className || ''}`];
    }));
    expect(unnamed, `${path} contains unnamed controls`).toEqual([]);
  }
});

test('navigation and mobile editor targets remain usable and reduced motion disables transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  const mobile = page.viewportSize().width < 768;
  const navigation = page.locator(mobile ? '.bottom-navigation .nav-link' : '.main-navigation .nav-link');
  for (const box of await navigation.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height };
  }))) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  if (mobile) {
    await openEditorOnMobile(page);
    for (const box of await page.locator('.editor-toolbar .format-button:visible').evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height };
    }))) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
  const motion = await page.getByRole('button').first().evaluate((element) => {
    const style = getComputedStyle(element); return { animation: style.animationName, transition: style.transitionDuration };
  });
  expect(['', 'none']).toContain(motion.animation);
  expect(motion.transition.split(',').every((duration) => !duration.trim() || parseFloat(duration) === 0)).toBe(true);
});

test('core light and dark color pairs meet normal-text contrast', async ({ page }) => {
  await ready(page);
  const ratios = await page.evaluate(() => {
    const luminance = (color) => {
      const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
      if (!hex) throw new Error(`Expected a hexadecimal design token, received ${color}`);
      const expanded = hex.length === 3 ? [...hex].map((value) => value + value).join('') : hex;
      const channels = [0, 2, 4].map((offset) => {
        const channel = Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const ratio = (first, second) => {
      const a = luminance(first), b = luminance(second);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const result = {};
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme;
      const style = getComputedStyle(document.documentElement);
      const value = (name) => style.getPropertyValue(name).trim();
      result[theme] = {
        text: ratio(value('--text'), value('--bg')),
        muted: ratio(value('--muted'), value('--bg')),
        primary: ratio(value('--primary'), value('--paper')),
        primaryInk: ratio(value('--primary-ink'), value('--primary')),
        danger: ratio(value('--danger'), value('--paper')),
        success: ratio(value('--success'), value('--paper')),
      };
    }
    return result;
  });
  for (const [theme, pairs] of Object.entries(ratios)) {
    for (const [name, ratio] of Object.entries(pairs)) expect(ratio, `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
  }
});
