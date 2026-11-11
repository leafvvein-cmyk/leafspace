import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function seedLearning(page, { entries = [], assets = [] }) {
  // page.goto() waits for the document load event, while the production app
  // still initializes its store and route asynchronously. Do not race Dexie's
  // schema open/upgrade with a second raw IndexedDB connection.
  await expect(page.getByRole('heading').first()).toBeVisible();
  const stamp = new Date().toISOString();
  await page.evaluate(({ entries, assets, stamp }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('diary-v2:learning');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const names = [...new Set([...entries.map(() => 'entries'), ...assets.map(() => 'assets')])];
      if (!names.length) { db.close(); resolve(); return; }
      const transaction = db.transaction(names, 'readwrite');
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.oncomplete = () => { db.close(); resolve(); };
      const contentText = (node) => [node?.text, ...(node?.content ?? []).map(contentText)].filter(Boolean).join(' ');
      for (const input of entries) {
        const content = input.content ?? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: input.title }] }] };
        transaction.objectStore('entries').put({ id: input.id, kind: input.kind ?? 'moment', entryDate: input.entryDate,
          timezone: input.timezone ?? 'UTC', occurredAt: input.kind === 'daily' ? null : (input.occurredAt ?? stamp), title: input.title,
          contentSchemaVersion: 1, content, plainText: contentText(content).trim(), mood: input.mood ?? null, tags: input.tags ?? [],
          revision: '0', localRevision: 1, createdAt: stamp, updatedAt: stamp, deletedAt: null, purgeAfter: null });
      }
      for (const input of assets) transaction.objectStore('assets').put({ mimeType: 'image/webp', width: 1, height: 1,
        createdAt: stamp, updatedAt: stamp, status: 'local-only', uploadAttempts: 0, error: null,
        uploadRequestId: crypto.randomUUID(), completeRequestId: crypto.randomUUID(), ...input,
        bytes: new Uint8Array(input.bytes ?? [1]) });
    };
  }), { entries, assets, stamp });
}

async function learningAssetsExist(page, ids) {
  return page.evaluate((ids) => new Promise((resolve, reject) => {
    const request = indexedDB.open('diary-v2:learning');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('assets', 'readonly'), store = transaction.objectStore('assets');
      const values = new Array(ids.length); let remaining = ids.length;
      ids.forEach((id, index) => { const read = store.get(id); read.onerror = () => reject(read.error);
        read.onsuccess = () => { values[index] = Boolean(read.result); if (!--remaining) { db.close(); resolve(values); } }; });
    };
  }), ids);
}

async function seedLargeLearningTimeline(page, count) {
  await expect(page.getByRole('heading').first()).toBeVisible();
  await page.evaluate((count) => new Promise((resolve, reject) => {
    const request = indexedDB.open('diary-v2:learning');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('entries', 'readwrite'), entries = transaction.objectStore('entries');
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.oncomplete = () => { db.close(); resolve(); };
      const stamp = new Date().toISOString();
      for (let index = 0; index < count; index++) {
        const title = `性能日记 ${String(index).padStart(5, '0')}`;
        entries.put({ id: crypto.randomUUID(), kind: 'moment', entryDate: '2026-08-31', timezone: 'UTC', occurredAt: stamp,
          title, contentSchemaVersion: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] },
          plainText: title, mood: null, tags: [], revision: '0', localRevision: 1, createdAt: stamp, updatedAt: stamp,
          deletedAt: null, purgeAfter: null });
      }
    };
  }), count);
}

async function openTodayWriting(page) {
  if (page.viewportSize().width < 768) await page.getByRole('button', { name: /^(开始写|继续写)$/ }).click();
}

test('writes a diary, saves on this device and restores after reload', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/today?date=2026-09-08');
  await openTodayWriting(page);
  await expect(page.getByRole('textbox', { name: '日记正文' })).toBeVisible();
  await page.getByRole('textbox', { name: '日记标题' }).fill('值得记录的一天');
  await page.getByRole('textbox', { name: '日记正文' }).fill('今天完成了第一篇日记。');
  await page.getByRole('button', { name: '愉快', exact: true }).click();
  await page.getByRole('textbox', { name: '标签', exact: true }).fill('生活，学习');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: '日记标题' })).toHaveValue('值得记录的一天');
  await expect(page.getByRole('textbox', { name: '日记正文' })).toHaveText('今天完成了第一篇日记。');
  await expect(page.getByRole('textbox', { name: '标签', exact: true })).toHaveValue('生活，学习');
  expect(errors).toEqual([]);
});

test('supports moment, search, trash and restore without code execution', async ({ page }) => {
  await page.goto('/entries/new?kind=moment&date=2026-09-08');
  await page.getByRole('textbox', { name: '日记标题' }).fill('<img src=x onerror=alert(1)>');
  await page.getByRole('textbox', { name: '日记正文' }).fill('咖啡和窗边的一束阳光');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await page.getByRole('button', { name: '返回时间线', exact: true }).click();
  await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeVisible();
  await expect(page.locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: '搜索日记', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索日记' }).fill('窗边');
  await page.getByRole('link', { name: '<img src=x onerror=alert(1)>' }).click();
  await page.getByRole('button', { name: '移到回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click();
  await expect(page.getByRole('heading', { name: '故事从今天开始' })).toBeVisible();
  await page.goto('/trash');
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByRole('heading', { name: '回收站是空的' })).toBeVisible();
});

test('calendar handles leap months and a narrow viewport without horizontal overflow', async ({ page }) => {
  await page.goto('/calendar?month=2024-02');
  await expect(page.getByRole('button', { name: /2月29日/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /2月30日/ })).toHaveCount(0);
  await page.getByRole('button', { name: /2月29日/ }).click();
  await openTodayWriting(page);
  await expect(page.getByRole('textbox', { name: '日记正文' })).toBeVisible();
  await page.getByRole('textbox', { name: '日记标题' }).fill('闰日记录');
  await page.getByRole('button', { name: '愉快', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await page.goto('/calendar?month=2024-02');
  await expect(page.getByRole('button', { name: /2月29日，1 篇记录，心情愉快/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
});

test('new moments get a durable URL and details are read-only until editing', async ({ page }) => {
  await page.goto('/entries/new?kind=moment&date=2026-09-09');
  await page.getByRole('textbox', { name: '日记标题' }).fill('手机也能继续写');
  await page.getByRole('button', { name: '粗体', exact: true }).click();
  await page.getByRole('textbox', { name: '日记正文' }).fill('加粗的记忆');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await expect(page).toHaveURL(/\/entries\/[a-f0-9-]+\/edit$/);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '日记标题' })).toHaveValue('手机也能继续写');
  await page.getByRole('button', { name: '返回时间线', exact: true }).click();
  await page.getByRole('link', { name: '手机也能继续写' }).click();
  await expect(page.getByRole('textbox', { name: '日记正文' })).toHaveCount(0);
  await expect(page.locator('.rich-reading')).toContainText('加粗的记忆');
  await page.getByRole('button', { name: '编辑日记', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '日记正文' })).toBeVisible();
  if (page.viewportSize().width < 768) await expect(page.getByRole('navigation', { name: '手机主导航' })).toBeHidden();
});

test('saves before switching between desktop writing and phone summary', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/today?date=2026-09-10');
  await page.getByRole('textbox', { name: '日记标题' }).fill('调整窗口也保留');
  await page.getByRole('textbox', { name: '日记正文' }).fill('还没有等到定时保存，就缩小窗口。');
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByRole('heading', { name: '调整窗口也保留' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '日记正文' })).toHaveCount(0);
  await page.getByRole('button', { name: '继续写', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '日记正文' })).toHaveText('还没有等到定时保存，就缩小窗口。');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
});

test('can recover from clearing a saved new record and then trash it', async ({ page }) => {
  await page.goto('/entries/new?kind=moment&date=2026-09-11');
  const title = page.getByRole('textbox', { name: '日记标题' });
  await title.fill('上次保存的内容');
  await expect(page.getByRole('button', { name: '移到回收站', exact: true })).toBeVisible();
  await title.fill('');
  await expect(page.getByRole('button', { name: '撤销未保存修改', exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '撤销未保存修改', exact: true }).click();
  await expect(title).toHaveValue('上次保存的内容');
  await page.getByRole('button', { name: '移到回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click();
  await expect(page.getByRole('heading', { name: '故事从今天开始' })).toBeVisible();
});

test('recovers a mood-only daily draft after reload without creating a diary entry', async ({ page }) => {
  await page.goto('/today?date=2026-09-12');
  await openTodayWriting(page);
  await page.getByRole('button', { name: '愉快', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '愉快', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: '日记标题' })).toHaveValue('');
  await page.goto('/timeline');
  await expect(page.getByRole('heading', { name: '故事从今天开始' })).toBeVisible();
});

test('moves a saved daily entry to another date without leaving it under the old date', async ({ page }) => {
  await page.goto('/entries/new?kind=daily&date=2026-09-13');
  await page.getByRole('textbox', { name: '日记标题' }).fill('改到正确日期');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await page.getByLabel('日记日期').fill('2026-09-14');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await page.goto('/today?date=2026-09-13');
  await expect(page.getByText('改到正确日期')).toHaveCount(0);
  await page.goto('/today?date=2026-09-14');
  if (page.viewportSize().width < 768) await expect(page.getByRole('heading', { name: '改到正确日期' })).toBeVisible();
  else await expect(page.getByRole('textbox', { name: '日记标题' })).toHaveValue('改到正确日期');
});

test('renders the timeline in stable batches instead of mounting every diary at once', async ({ page }) => {
  await page.goto('/timeline');
  await seedLearning(page, { entries: Array.from({ length: 55 }, (_, index) => ({ id: randomUUID(), kind: 'moment', entryDate: '2026-09-19',
    title: `分页日记 ${String(index).padStart(2, '0')}`, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `内容 ${index}` }] }] } })) });
  await page.reload();
  await expect(page.locator('.entry-card')).toHaveCount(50);
  await page.getByRole('button', { name: /加载更多/ }).click();
  await expect(page.locator('.entry-card')).toHaveCount(55);
  await expect(page.getByRole('link', { name: '分页日记 54' })).toHaveCount(1);
});

test('renames and removes a tag without deleting the diary', async ({ page }) => {
  await page.goto('/entries/new?kind=moment&date=2026-09-20');
  await page.getByRole('textbox', { name: '日记标题' }).fill('标签管理日记');
  await page.getByRole('textbox', { name: '标签', exact: true }).fill('旧标签，保留标签');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await page.goto('/tags');
  const oldCard = page.locator('.tag-manage-card').filter({ hasText: '旧标签' });
  page.once('dialog', (dialog) => dialog.accept('新标签'));
  await oldCard.getByRole('button', { name: '重命名' }).click();
  const newCard = page.locator('.tag-manage-card').filter({ hasText: '新标签' });
  await expect(newCard).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await newCard.getByRole('button', { name: '移除标签' }).click();
  await expect(page.getByText('新标签', { exact: false })).toHaveCount(0);
  await page.goto('/timeline');
  await expect(page.getByRole('link', { name: '标签管理日记' })).toBeVisible();
});

test('shows terminal image upload problems and manually requeues the original image', async ({ page }) => {
  await page.goto('/settings/images');
  const entryId = randomUUID(), assetId = randomUUID();
  await seedLearning(page, { entries: [{ id: entryId, kind: 'moment', entryDate: '2026-09-21', title: '等待图片的日记',
    content: { type: 'doc', content: [{ type: 'image', attrs: { assetId, alt: '原图', caption: '' } }] } }],
  assets: [{ id: assetId, entryId, size: 1, sha256: 'a'.repeat(64), bytes: [1], status: 'error', uploadAttempts: 3,
    error: { code: 'NETWORK_UNAVAILABLE', message: '图片上传未完成，请检查网络后重试。' } }] });
  await page.reload();
  const card = page.locator('.asset-problem-card').filter({ hasText: '等待图片的日记' });
  await expect(card).toContainText('3 次尝试均未完成');
  await expect(card).toContainText('图片上传未完成，请检查网络后重试。');
  await expect(card).not.toContainText('do not render this detail');
  await card.getByRole('button', { name: '重新上传' }).click();
  await expect(page.getByRole('heading', { name: '图片已重新加入队列' })).toBeVisible();
});

test('combines timeline filters and trashes only explicitly selected visible diaries', async ({ page }) => {
  await page.goto('/timeline');
  await seedLearning(page, { entries: [
      { kind: 'daily', entryDate: '2026-09-22', title: '每日工作', mood: 5, tags: [{ name: '工作' }] },
      { kind: 'moment', entryDate: '2026-09-23', title: '普通随记', mood: 2, tags: [{ name: '生活' }] },
      { kind: 'moment', entryDate: '2026-09-24', title: '筛选目标', mood: 5, tags: [{ name: '工作' }] },
    ].map((record) => ({ id: randomUUID(), ...record })) });
  await page.reload();
  await page.getByLabel('时间线记录类型').selectOption('moment');
  await page.getByLabel('时间线心情').selectOption('5');
  await page.getByLabel('时间线标签').selectOption('工作');
  await page.getByLabel('时间线开始日期').fill('2026-09-24');
  await expect(page.getByRole('link', { name: '筛选目标' })).toBeVisible();
  await expect(page.getByRole('link', { name: '每日工作' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '普通随记' })).toHaveCount(0);

  await page.getByRole('button', { name: '清除筛选' }).first().click();
  for (const title of ['每日工作', '普通随记']) {
    const card = page.locator('.entry-card').filter({ has: page.getByRole('heading', { name: title }) });
    await card.getByRole('checkbox', { name: '选择这篇' }).check();
  }
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '移入回收站 2 篇' }).click();
  await expect(page.getByRole('link', { name: '筛选目标' })).toBeVisible();
  await expect(page.getByRole('link', { name: '每日工作' })).toHaveCount(0);
  await page.goto('/trash');
  await expect(page.getByRole('link', { name: '每日工作' })).toBeVisible();
  await expect(page.getByRole('link', { name: '普通随记' })).toBeVisible();
  await expect(page.getByRole('link', { name: '筛选目标' })).toHaveCount(0);
});

test('clears only redownloadable image cache and preserves the local original', async ({ page }) => {
  await page.goto('/settings/storage');
  const ids = { cachedId: randomUUID(), localId: randomUUID() }, entryId = randomUUID();
  await seedLearning(page, { assets: [
    { id: ids.cachedId, entryId, size: 2, sha256: '7'.repeat(64), bytes: [1, 2], status: 'ready', cacheSource: 'remote' },
    { id: ids.localId, entryId, size: 2, sha256: '8'.repeat(64), bytes: [1, 2], status: 'local-only' },
  ] });
  await page.reload();
  await expect(page.getByText('本机原件 · 2 B')).toBeVisible();
  await expect(page.getByText('可重下缓存 · 2 B')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '清理可重新下载的缓存' }).click();
  await expect(page.getByText('可重下缓存 · 0 B')).toBeVisible();
  const [cached, local] = await learningAssetsExist(page, [ids.cachedId, ids.localId]);
  expect({ cached, local }).toEqual({ cached: false, local: true });
});

test('keeps the current search and tag filter after opening a result and returning', async ({ page }) => {
  await page.goto('/search');
  await seedLearning(page, { entries: [['山间散步', '旅行'], ['山间工作', '工作']].map(([title, tag]) =>
    ({ id: randomUUID(), kind: 'moment', entryDate: '2026-09-25', title, tags: [{ name: tag }] })) });
  await page.reload();
  const search = page.getByRole('searchbox', { name: '搜索日记' });
  await expect(search).toHaveAttribute('maxlength', '100');
  await search.fill('山间');
  await page.getByLabel('标签筛选').selectOption('旅行');
  await expect(page.getByRole('link', { name: '山间散步' })).toBeVisible();
  await expect(page.getByRole('link', { name: '山间工作' })).toHaveCount(0);
  await page.getByRole('link', { name: '山间散步' }).click();
  await page.goBack();
  await expect(search).toHaveValue('山间');
  await expect(page.getByLabel('标签筛选')).toHaveValue('旅行');
  await expect(page.getByRole('link', { name: '山间散步' })).toBeVisible();
});

test('shows an image queue status separately from the diary save status', async ({ page }) => {
  await page.goto('/today');
  const entryId = randomUUID(), assetId = randomUUID();
  await seedLearning(page, { entries: [{ id: entryId, kind: 'moment', entryDate: '2026-09-26', title: '有本机图片',
    content: { type: 'doc', content: [{ type: 'image', attrs: { assetId, alt: '', caption: '' } }] } }],
  assets: [{ id: assetId, entryId, size: 1, sha256: '9'.repeat(64), bytes: [1] }] });
  await page.goto(`/entries/${entryId}/edit`);
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '图片仅保存在本机 1 张' })).toBeVisible();
});

test('persists reading font and size while keeping desktop writing width device-local', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('正文字体').selectOption('sans');
  await page.getByLabel('正文字号').fill('24');
  if (page.viewportSize().width >= 768) await page.getByLabel('电脑书写宽度').fill('920');
  await page.goto('/entries/new?kind=moment&date=2026-09-27');
  await expect.poll(() => page.evaluate(() => ({ family: document.documentElement.dataset.writingFont,
    size: getComputedStyle(document.documentElement).getPropertyValue('--writing-size').trim(),
    width: getComputedStyle(document.documentElement).getPropertyValue('--writing-width').trim() }))).toEqual({ family: 'sans', size: '24px', width: page.viewportSize().width >= 768 ? '920px' : '848px' });
  await page.reload();
  await expect(page.locator('.tiptap')).toHaveCSS('font-size', '24px');
  await expect(page.locator('.tiptap')).toHaveCSS('font-family', /Segoe UI|Microsoft YaHei|sans-serif/);
});

test('supports keyboard formatting and sanitizes pasted external HTML', async ({ page }) => {
  await page.goto('/entries/new?kind=moment&date=2026-09-28');
  const editor = page.getByRole('textbox', { name: '日记正文' });
  await editor.focus();
  await page.keyboard.press('Control+b');
  await page.keyboard.type('加粗内容');
  await expect(page.locator('.tiptap strong')).toContainText('加粗内容');
  await editor.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData('text/html', '<p>安全文字<script>globalThis.__unsafe_diary=1</script><a href="javascript:alert(1)" onclick="alert(2)">危险链接</a><img src="x" onerror="alert(3)"></p>');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect(editor).toContainText('安全文字');
  await expect(editor).toContainText('危险链接');
  await expect(page.locator('.tiptap script, .tiptap a, .tiptap img')).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.__unsafe_diary)).toBeUndefined();
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
});

test('accepts a dropped desktop image through the same private local image pipeline', async ({ page }) => {
  await page.goto('/entries/new?kind=moment&date=2026-09-29');
  const editor = page.getByRole('textbox', { name: '日记正文' });
  await editor.evaluate((element) => {
    const raw = atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPYEmX0H4QZYAwAT3wI/Y4CtQMAAAAASUVORK5CYII=');
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], '拖入照片.png', { type: 'image/png' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.getByRole('status').filter({ hasText: /图片已保存在此设备|图片仅保存在本机 1 张/ }).first()).toBeVisible();
  await expect(page.locator('.tiptap figure.diary-image')).toHaveCount(1);
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
});

test('shows auditable app, page, API and local schema versions on the about page', async ({ page }) => {
  await page.goto('/settings/about');
  await expect(page.getByText('应用版本：0.1.0')).toBeVisible();
  await expect(page.getByText(/页面版本：[0-9a-f]{8}-[0-9a-f-]{27}/)).toBeVisible();
  await expect(page.getByText(/本地数据库：v3 · 完整备份：v3 · 正文格式：v1/)).toBeVisible();
  const api = page.locator('[data-api-version]');
  await expect(api).not.toHaveText('正在读取 API 版本…');
  await expect(api).toHaveText(/API：v1|API 版本暂时无法读取/);
});

test('keeps the open daily entry on its original date and offers a new page after midnight', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-08T15:59:50Z') });
  await page.goto('/today');
  await openTodayWriting(page);
  await page.getByRole('textbox', { name: '日记标题' }).fill('午夜前开始写');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await page.clock.fastForward(30000);
  const notice = page.getByRole('status').filter({ hasText: '已是新的一天' });
  await expect(notice).toContainText('这篇仍保存在 9月8日，不会自动改日期。');
  await expect(notice.getByRole('button', { name: '另写今天' })).toBeVisible();
  await expect(page.getByLabel('日记日期', { exact: true })).toHaveValue('2026-09-08');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
});

test('keeps a 10,000-entry local timeline to a 50-card first render', async ({ page }) => {
  test.setTimeout(45000);
  await page.goto('/timeline');
  await seedLargeLearningTimeline(page, 10000);
  const startedAt = Date.now();
  await page.reload();
  await expect(page.locator('.entry-card')).toHaveCount(50);
  expect(Date.now() - startedAt).toBeLessThan(5000);
  await expect(page.getByRole('button', { name: '加载更多（还有 9950 篇）' })).toBeVisible();
});

test('keeps a 10,000-entry local search to 50 results and filters it without mounting every diary', async ({ page }) => {
  test.setTimeout(45000);
  await page.goto('/search');
  await seedLargeLearningTimeline(page, 10000);
  const startedAt = Date.now();
  await page.reload();
  await expect(page.locator('.entry-card')).toHaveCount(50);
  expect(Date.now() - startedAt).toBeLessThan(5000);
  await expect(page.getByRole('button', { name: '加载更多搜索结果（还有 9950 篇）' })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索日记' }).fill('性能日记 09999');
  await expect(page.locator('.entry-card')).toHaveCount(1);
  await expect(page.getByRole('link', { name: '性能日记 09999' })).toBeVisible();
});

test('searches one-character Chinese and punctuation literally', async ({ page }) => {
  await page.goto('/search');
  await seedLearning(page, { entries: [
    { id: randomUUID(), kind: 'moment', entryDate: '2026-09-28', title: '雨。' },
    { id: randomUUID(), kind: 'moment', entryDate: '2026-09-28', title: '雨天' },
    { id: randomUUID(), kind: 'moment', entryDate: '2026-09-28', title: '晴天' },
  ] });
  await page.reload();
  const search = page.getByRole('searchbox', { name: '搜索日记' });
  await search.fill('雨');
  await expect(page.locator('.entry-card')).toHaveCount(2);
  await search.fill('。');
  await expect(page.locator('.entry-card')).toHaveCount(1);
  await expect(page.getByRole('link', { name: '雨。' })).toBeVisible();
});

test('reflows settings at a 200% equivalent desktop viewport and remains usable at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 500 });
  await page.goto('/settings');
  await expect(page.getByRole('navigation', { name: '手机主导航' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '我的日记' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/calendar?month=2026-09');
  await expect(page.getByRole('heading', { name: '日历' })).toBeVisible();
  await expect(page.getByRole('button', { name: /9月8日/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
});
