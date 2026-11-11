import { randomUUID } from 'node:crypto';
import { test as base, expect, devices } from '@playwright/test';

const transientLoopbackError = /ERR_ADDRESS_IN_USE|ERR_NO_BUFFER_SPACE|EADDRINUSE|ENOBUFS/;
async function retryLoopbackNavigation(action) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (attempt >= 2 || !transientLoopbackError.test(error.message ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
const test = base.extend({
  sharedContext: [async ({ browser }, use, workerInfo) => {
    const descriptor = workerInfo.project.name === 'mobile' ? devices['Pixel 7'] : devices['Desktop Chrome'];
    const { defaultBrowserType: _defaultBrowserType, ...device } = descriptor;
    const context = await browser.newContext({ ...device, baseURL: 'http://127.0.0.2:4174', serviceWorkers: 'block', acceptDownloads: true });
    await use(context); await context.close();
  }, { scope: 'worker' }],
  sharedPage: [async ({ sharedContext }, use) => {
    const page = await sharedContext.newPage();
    const goto = page.goto.bind(page);
    page.goto = (...args) => retryLoopbackNavigation(() => goto(...args));
    await use(page); await page.close();
  }, { scope: 'worker' }],
  context: async ({ sharedContext }, use) => use(sharedContext),
  page: async ({ sharedPage, sharedContext }, use) => {
    await sharedContext.setOffline(false);
    for (const sibling of sharedContext.pages()) if (sibling !== sharedPage) await sibling.close();
    await sharedPage.unrouteAll({ behavior: 'ignoreErrors' });
    sharedPage.removeAllListeners('pageerror');
    await sharedPage.goto('about:blank');
    await sharedContext.clearCookies();
    const session = await sharedContext.newCDPSession(sharedPage);
    await session.send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.2:4174', storageTypes: 'all' });
    await session.detach();
    await use(sharedPage);
  },
});

const password = 'my-diary-password-2026!';
const username = () => `ui_${randomUUID().slice(0, 18)}`;
async function register(page, name = username()) {
  await page.goto('/register');
  await page.getByLabel('账号', { exact: true }).fill(name);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '请保存你的恢复码' })).toBeVisible();
  return name;
}
async function login(page, name, secret = password) {
  await page.goto('/login');
  await page.getByLabel('账号', { exact: true }).fill(name);
  await page.getByLabel('密码', { exact: true }).fill(secret);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
}
async function moment(page, title) {
  await page.goto('/entries/new?kind=moment');
  await page.getByRole('textbox', { name: '日记标题' }).fill(title);
  await expect(page.getByRole('textbox', { name: '日记标题' })).toHaveValue(title);
  await page.getByRole('textbox', { name: '日记正文' }).fill(`${title}，不可串到其他账号。`);
  await expect(page.getByRole('textbox', { name: '日记标题' })).toHaveValue(title);
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
}
async function logout(page) {
  await page.goto('/settings/account');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '保留本机副本并退出' }).click();
  await expect(page).toHaveURL(/\/login$/);
}
async function openTimeline(page) {
  await page.goto('/timeline');
  // An absence assertion succeeds while the async app shell is still empty.
  // Wait for session restoration and the requested route before checking that
  // another workspace's entry is absent.
  await expect(page.getByRole('heading', { name: '时间线', exact: true })).toBeVisible();
}

test('uses account/password only, validates fields and registers from a phone or desktop', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/register');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByLabel('账号', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: /Apple|验证码|手机登录/ })).toHaveCount(0);
  const name = await register(page);
  await page.getByRole('button', { name: '暂时跳过' }).click();
  await page.goto('/settings/account');
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByLabel('昵称', { exact: true }).fill('中文昵称，不进请求头');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('账号资料已保存');
  await page.reload();
  await expect(page.getByLabel('昵称', { exact: true })).toHaveValue('中文昵称，不进请求头');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  expect(errors).toEqual([]);
});

test('syncs an end-to-end encrypted password vault to a separate device database', async ({ page, browser }) => {
  const name = await register(page);
  await page.getByRole('button', { name: '暂时跳过' }).click();
  await page.goto('/vault');
  await page.getByLabel('创建保险库密码').fill('cross-device-vault-password!');
  await page.getByLabel('确认保险库密码').fill('cross-device-vault-password!');
  await page.getByText('我明白：必须把恢复密钥').click();
  await page.getByRole('button', { name: '创建并解锁' }).click();
  await page.getByText('我已把恢复密钥保存在安全位置').click();
  await page.getByRole('button', { name: '我已安全保存' }).click();
  await page.getByRole('button', { name: '添加账号' }).click();
  await page.getByLabel('账号类型').selectOption('website');
  await page.getByLabel('应用或网站名称').fill('跨设备测试网站');
  await page.getByLabel('登录账号').fill('cross-device@example.com');
  await page.getByLabel('密码', { exact: true }).fill('ciphertext-only-secret!');
  await page.getByLabel('登录地址（可选）').fill('https://example.com/login');
  await page.getByLabel('标签（可选，用逗号分隔）').fill('工作，跨设备');
  await page.getByRole('button', { name: '加密保存' }).click();
  await expect(page.getByRole('heading', { name: '跨设备测试网站' })).toBeVisible();
  await expect(page.locator('.vault-sync-note')).toHaveCount(0, { timeout: 15000 });

  const second = await browser.newContext({ baseURL: 'http://127.0.0.2:4174', serviceWorkers: 'block' });
  try {
    const other = await second.newPage(); await login(other, name);
    await other.goto('/vault');
    await expect(other.getByRole('heading', { name: '密码本已锁定' })).toBeVisible({ timeout: 15000 });
    await expect(other.getByText('cross-device@example.com')).toHaveCount(0);
    await other.getByLabel('保险库密码').fill('cross-device-vault-password!');
    await other.getByRole('button', { name: '解锁密码本' }).click();
    await expect(other.getByRole('heading', { name: '跨设备测试网站' })).toBeVisible({ timeout: 15000 });
    await expect(other.getByText('cross-device@example.com')).toBeVisible();
    await expect(other.getByLabel('账号标签').getByText('跨设备')).toBeVisible();
    await other.getByLabel('筛选账号记录').selectOption('tag:工作');
    await expect(other.getByText('cross-device@example.com')).toBeVisible();
    await other.getByLabel('筛选账号记录').selectOption('');
    await expect(other.getByText('ciphertext-only-secret!')).toHaveCount(0);
    await other.getByRole('button', { name: '查看密码' }).click();
    await expect(other.getByText('ciphertext-only-secret!')).toBeVisible();

    let releaseFirst, markBlocked;
    const blocked = new Promise((resolve) => { markBlocked = resolve; });
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    await page.route('**/api/v1/vault/items/*', async (route) => {
      if (route.request().method() === 'PUT') { markBlocked(); await gate; }
      await route.continue();
    });
    await page.getByRole('button', { name: '编辑' }).click();
    await page.getByLabel('备注（可选）').fill('本机冲突版本');
    await page.getByRole('button', { name: '保存修改' }).click();
    await blocked;
    await other.getByRole('button', { name: '编辑' }).click();
    await other.getByLabel('备注（可选）').fill('云端冲突版本');
    const cloudWrite = other.waitForResponse((response) => response.request().method() === 'PUT' && /\/api\/v1\/vault\/items\//.test(response.url()) && response.status() === 200);
    await other.getByRole('button', { name: '保存修改' }).click();
    await cloudWrite;
    releaseFirst();
    await expect(page.getByRole('heading', { name: '需要选择的跨设备修改' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/本机：.*本机冲突版本/)).toBeVisible();
    await expect(page.getByText(/云端：.*云端冲突版本/)).toBeVisible();
    await page.getByRole('button', { name: '保留本机版本' }).click();
    await expect(page.locator('.vault-sync-note')).toHaveCount(0, { timeout: 15000 });
    await page.unrouteAll({ behavior: 'wait' });

    const thirdContext = await browser.newContext({ baseURL: 'http://127.0.0.2:4174', serviceWorkers: 'block' });
    try {
      const third = await thirdContext.newPage(); await login(third, name); await third.goto('/vault');
      await third.getByLabel('保险库密码').fill('cross-device-vault-password!');
      await third.getByRole('button', { name: '解锁密码本' }).click();
      await expect(third.getByText('本机冲突版本')).toBeVisible({ timeout: 15000 });
      await expect(third.getByLabel('账号标签').getByText('跨设备')).toBeVisible();
    } finally { await thirdContext.close(); }
  } finally { await second.close(); }
});

test('rotates every password-vault data key only after saving the new recovery key', async ({ page, browser }) => {
  test.setTimeout(60000);
  const name = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click(); await page.goto('/vault');
  const vaultPassword = 'complete-data-key-rotation-password!';
  await page.getByLabel('创建保险库密码').fill(vaultPassword); await page.getByLabel('确认保险库密码').fill(vaultPassword);
  await page.getByText('我明白：必须把恢复密钥').click(); await page.getByRole('button', { name: '创建并解锁' }).click();
  const oldRecoveryKey = await page.getByLabel('一次性显示的密码本恢复密钥').inputValue();
  await page.getByText('我已把恢复密钥保存在安全位置').click(); await page.getByRole('button', { name: '我已安全保存' }).click();
  await page.getByRole('button', { name: '添加账号' }).click(); await page.getByLabel('应用或网站名称').fill('密钥轮换测试网站');
  await page.getByLabel('登录账号').fill('rotation@example.com'); await page.getByLabel('密码', { exact: true }).fill('rotation-item-secret!');
  await page.getByRole('button', { name: '加密保存' }).click(); await expect(page.locator('.vault-sync-note')).toHaveCount(0, { timeout: 15000 });

  await page.getByRole('button', { name: '轮换数据密钥' }).click();
  await page.getByLabel('确认保险库密码').fill(vaultPassword); await page.getByRole('button', { name: '验证并准备轮换' }).click();
  const newRecoveryKey = await page.getByLabel('数据密钥轮换后的密码本恢复密钥').inputValue();
  expect(newRecoveryKey).toMatch(/^DVK1-/); expect(newRecoveryKey).not.toBe(oldRecoveryKey);
  await expect(page.getByRole('button', { name: '已保存，开始原子轮换' })).toBeDisabled();
  await page.getByText('我已把新的恢复密钥保存在安全位置').click();
  const committed = page.waitForResponse((response) => response.request().method() === 'POST'
    && /\/api\/v1\/vault\/key-rotations\/[^/]+\/commit$/.test(response.url()) && response.status() === 200);
  await page.getByRole('button', { name: '已保存，开始原子轮换' }).click(); await committed;
  await expect(page.getByText('rotation@example.com')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '查看密码' }).click(); await expect(page.getByText('rotation-item-secret!')).toBeVisible();

  await page.getByRole('button', { name: '锁定', exact: true }).click(); await page.getByRole('button', { name: '忘记密码，使用恢复密钥' }).click();
  await page.getByLabel('密码本恢复密钥', { exact: true }).fill(oldRecoveryKey);
  await page.getByLabel('新保险库密码', { exact: true }).fill('old-key-must-not-work-password!');
  await page.getByLabel('确认新保险库密码').fill('old-key-must-not-work-password!');
  await page.getByRole('button', { name: '恢复并设置新密码' }).click(); await expect(page.getByRole('alert')).toContainText('恢复密钥错误');
  await page.getByRole('button', { name: '取消' }).click();

  const secondContext = await browser.newContext({ baseURL: 'http://127.0.0.2:4174', serviceWorkers: 'block' });
  try {
    const second = await secondContext.newPage(); await login(second, name); await second.goto('/vault');
    await second.getByLabel('保险库密码').fill(vaultPassword); await second.getByRole('button', { name: '解锁密码本' }).click();
    await expect(second.getByText('rotation@example.com')).toBeVisible({ timeout: 15000 });
    await second.getByRole('button', { name: '查看密码' }).click(); await expect(second.getByText('rotation-item-secret!')).toBeVisible();
  } finally { await secondContext.close(); }
});

test('syncs offline-first tasks across devices and requires a choice for concurrent edits', async ({ page, browser }) => {
  const name = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click(); await page.goto('/tasks');
  await page.getByRole('button', { name: '新建待办' }).click();
  await page.getByRole('textbox', { name: '标题' }).fill('跨设备待办');
  await page.getByRole('textbox', { name: '备注' }).fill('初始版本');
  await page.getByRole('button', { name: '添加站内动作' }).click();
  await page.getByLabel('快捷动作名称').fill('查看时间线');
  await page.getByLabel('快捷动作站内目标').selectOption('/timeline');
  const created = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/v1\/tasks$/.test(response.url()) && response.status() === 201);
  const actionSaved = page.waitForResponse((response) => response.request().method() === 'PUT' && /\/api\/v1\/tasks\/[^/]+\/actions$/.test(response.url()) && response.status() === 200);
  await page.getByRole('button', { name: '创建待办' }).click(); await created; await actionSaved;
  await expect(page.locator('.task-sync-notice')).toContainText('待上传 0 项', { timeout: 15000 });

  const secondContext = await browser.newContext({ baseURL: 'http://127.0.0.2:4174', serviceWorkers: 'block' });
  try {
    const second = await secondContext.newPage(); await login(second, name); await second.goto('/tasks');
    await expect(second.getByRole('heading', { name: '跨设备待办' })).toBeVisible({ timeout: 15000 });
    await expect(second.getByText('初始版本')).toBeVisible();
    second.once('dialog', (dialog) => dialog.accept());
    await second.getByRole('button', { name: '查看时间线' }).click(); await expect(second).toHaveURL(/\/timeline$/);
    await second.goto('/tasks');

    let releaseFirst, markBlocked;
    const blocked = new Promise((resolve) => { markBlocked = resolve; });
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    await page.route('**/api/v1/tasks/*', async (route) => {
      if (route.request().method() === 'PATCH') { markBlocked(); await gate; }
      await route.continue();
    });
    await page.getByRole('button', { name: '编辑' }).click();
    await page.getByRole('textbox', { name: '备注' }).fill('第一台设备版本');
    await page.getByRole('button', { name: '保存修改' }).click(); await blocked;

    await second.getByRole('button', { name: '编辑' }).click();
    await second.getByRole('textbox', { name: '备注' }).fill('第二台设备版本');
    const cloudWrite = second.waitForResponse((response) => response.request().method() === 'PATCH' && /\/api\/v1\/tasks\//.test(response.url()) && response.status() === 200);
    await second.getByRole('button', { name: '保存修改' }).click(); await cloudWrite; releaseFirst();

    await expect(page.getByRole('heading', { name: '需要选择的待办修改' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('本机：第一台设备版本')).toBeVisible();
    await expect(page.getByText('云端：第二台设备版本')).toBeVisible();
    await page.getByRole('button', { name: '保留本机版本' }).click();
    await expect(page.locator('.task-sync-notice')).toContainText('待上传 0 项', { timeout: 15000 });
    await page.unrouteAll({ behavior: 'wait' });

    const thirdContext = await browser.newContext({ baseURL: 'http://127.0.0.2:4174', serviceWorkers: 'block' });
    try {
      const third = await thirdContext.newPage(); await login(third, name); await third.goto('/tasks');
      await expect(third.getByText('第一台设备版本')).toBeVisible({ timeout: 15000 });
      const completed = third.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/v1\/tasks\/[^/]+\/complete$/.test(response.url()) && response.status() === 200);
      await third.getByRole('button', { name: '完成：跨设备待办' }).click(); await completed;
    } finally { await thirdContext.close(); }
    await second.reload();
    await expect(second.getByRole('heading', { name: '待办', exact: true })).toBeVisible();
    await second.getByRole('button', { name: '已完成' }).click();
    await expect(second.getByRole('heading', { name: '跨设备待办' })).toBeVisible({ timeout: 15000 });
  } finally { await secondContext.close(); }
});

test('syncs a quick note into the reading page on a separate device', async ({ page, browser }) => {
  const name = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  const uploaded = page.waitForResponse((response) => response.request().method() === 'POST'
    && response.url().includes('/api/v1/sync/mutations') && response.status() === 200);
  await moment(page, '跨设备随记'); await uploaded;

  const secondContext = await browser.newContext({ baseURL: 'http://127.0.0.2:4174', serviceWorkers: 'block' });
  try {
    const other = await secondContext.newPage(); await login(other, name); await other.goto('/timeline');
    const link = other.getByRole('link', { name: '跨设备随记' });
    await expect(link).toBeVisible({ timeout: 15000 }); await link.click();
    await expect(other.getByRole('heading', { name: '随记', exact: true })).toBeVisible();
    await expect(other.locator('.reading-sheet').getByRole('heading', { name: '跨设备随记' })).toBeVisible();
    await expect(other.getByText('跨设备随记，不可串到其他账号。')).toBeVisible();
    await expect(other.getByRole('button', { name: '编辑日记' })).toBeVisible();
  } finally { await secondContext.close(); }
});

test('syncs a daily entry into another device calendar and selected-day view', async ({ page, browser }) => {
  const name = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  const date = '2026-10-15';
  const uploaded = page.waitForResponse((response) => response.request().method() === 'POST'
    && response.url().includes('/api/v1/sync/mutations') && response.status() === 200);
  await page.goto(`/entries/new?kind=daily&date=${date}`);
  await page.getByRole('textbox', { name: '日记标题' }).fill('跨设备每日一页');
  await page.getByRole('textbox', { name: '日记正文' }).fill('从另一台设备的日历进入，也要看到这段正文。');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await uploaded;

  const secondContext = await browser.newContext({ baseURL: 'http://127.0.0.2:4174', serviceWorkers: 'block' });
  try {
    const other = await secondContext.newPage(); await login(other, name);
    await other.goto('/calendar?month=2026-10');
    const day = other.getByRole('button', { name: /10月15日，1 篇记录/ });
    await expect(day).toBeVisible({ timeout: 15000 });
    await day.click();
    await expect(other).toHaveURL(/\/today\?date=2026-10-15$/);
    if (other.viewportSize().width < 768) {
      await expect(other.getByRole('heading', { name: '跨设备每日一页' })).toBeVisible();
      await expect(other.getByText('从另一台设备的日历进入，也要看到这段正文。')).toBeVisible();
    } else {
      await expect(other.getByRole('textbox', { name: '日记标题' })).toHaveValue('跨设备每日一页');
      await expect(other.getByRole('textbox', { name: '日记正文' })).toContainText('从另一台设备的日历进入，也要看到这段正文。');
    }
  } finally { await secondContext.close(); }
});

test('syncs tag rename and removal without deleting the diary', async ({ page, browser }) => {
  test.setTimeout(90000);
  const name = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  const uploaded = page.waitForResponse((response) => response.request().method() === 'POST'
    && response.url().includes('/api/v1/sync/mutations') && response.status() === 200);
  await page.goto('/entries/new?kind=moment&date=2026-10-16');
  await page.getByRole('textbox', { name: '日记标题' }).fill('跨设备标签管理日记');
  await page.getByRole('textbox', { name: '标签', exact: true }).fill('旧标签，保留标签');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await uploaded;

  const secondContext = await browser.newContext({ baseURL: 'http://127.0.0.2:4174', serviceWorkers: 'block' });
  const thirdContext = await browser.newContext({ baseURL: 'http://127.0.0.2:4174', serviceWorkers: 'block' });
  try {
    const second = await secondContext.newPage(); await login(second, name); await second.goto('/tags');
    const oldCard = second.locator('.tag-manage-card').filter({ hasText: '旧标签' });
    await expect(oldCard).toBeVisible({ timeout: 15000 });
    const renamed = second.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().includes('/api/v1/sync/mutations') && response.status() === 200);
    second.once('dialog', (dialog) => dialog.accept('新标签'));
    await oldCard.getByRole('button', { name: '重命名' }).click(); await renamed;
    await expect(second.locator('.tag-manage-card').filter({ hasText: '新标签' })).toBeVisible();

    const third = await thirdContext.newPage(); await login(third, name); await third.goto('/tags');
    const newCard = third.locator('.tag-manage-card').filter({ hasText: '新标签' });
    await expect(newCard).toBeVisible({ timeout: 15000 });
    await expect(third.getByText('旧标签', { exact: false })).toHaveCount(0);
    const removed = third.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().includes('/api/v1/sync/mutations') && response.status() === 200);
    third.once('dialog', (dialog) => dialog.accept());
    await newCard.getByRole('button', { name: '移除标签' }).click(); await removed;
    await expect(third.getByText('新标签', { exact: false })).toHaveCount(0);

    await second.reload();
    await expect(second.getByRole('heading', { name: '标签', exact: true })).toBeVisible();
    await expect(second.getByText('新标签', { exact: false })).toHaveCount(0, { timeout: 15000 });
    await expect(second.getByRole('button', { name: /保留标签 · 1 篇/ })).toBeVisible();
    await second.goto('/timeline');
    await expect(second.getByRole('link', { name: '跨设备标签管理日记' })).toBeVisible();
  } finally { await thirdContext.close(); await secondContext.close(); }
});

test('keeps learning, Alice and Bravo diaries isolated across logout and reload', async ({ page }) => {
  await moment(page, '学习空间的原稿');
  const alice = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  await openTimeline(page); await expect(page.getByRole('link', { name: '学习空间的原稿' })).toHaveCount(0);
  await moment(page, 'Alice的私密日记'); await logout(page);
  const bravo = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  await openTimeline(page); await expect(page.getByRole('link', { name: 'Alice的私密日记' })).toHaveCount(0);
  await moment(page, 'Bravo的私密日记'); await logout(page);
  await login(page, alice); await page.goto('/timeline');
  await expect(page.getByRole('link', { name: 'Alice的私密日记' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Bravo的私密日记' })).toHaveCount(0);
  await page.goto('/settings/account'); await page.getByRole('button', { name: '查看本机学习空间' }).click();
  await expect(page).toHaveURL(/\/today$/);
  await page.goto('/timeline'); await expect(page.getByRole('link', { name: '学习空间的原稿' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Alice的私密日记' })).toHaveCount(0);
  expect(alice).not.toBe(bravo);
});

test('explicitly previews and copies learning content into the chosen account without deleting the source', async ({ page }) => {
  await moment(page, '准备迁移的学习稿');
  const name = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  await page.goto('/settings');
  await page.getByRole('button', { name: '复制学习内容到账号' }).click();
  await expect(page.getByRole('heading', { name: '复制学习空间内容' })).toBeVisible();
  await expect(page.getByText(`目标账号：${name}`, { exact: false })).toBeVisible();
  await expect(page.getByText('1项内容', { exact: false })).toBeVisible();
  await page.getByLabel(new RegExp(`复制到账号“${name}”`)).check();
  await page.getByRole('button', { name: '复制到这个账号' }).click();
  await expect(page.locator('.migration-page p[role="status"]')).toContainText('已复制 1 项');
  await page.getByRole('button', { name: '打开账号日记并开始同步' }).click();
  await page.goto('/timeline');
  await expect(page.getByRole('link', { name: '准备迁移的学习稿' })).toBeVisible();
  await page.goto('/settings/account'); await page.getByRole('button', { name: '查看本机学习空间' }).click();
  await page.goto('/timeline');
  await expect(page.getByRole('link', { name: '准备迁移的学习稿' })).toBeVisible();
});

test('issues a recovery code only on explicit action and recovers the password', async ({ page }) => {
  const name = await register(page);
  await page.getByRole('button', { name: '验证密码并生成新码' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('当前密码').fill(password);
  await dialog.getByRole('button', { name: '继续', exact: true }).click();
  const field = page.getByRole('textbox', { name: '一次性显示的恢复码' });
  await expect(field).not.toHaveValue(''); const code = await field.inputValue();
  await page.reload(); await expect(field).toHaveCount(0);
  await page.getByRole('button', { name: '暂时跳过' }).click(); await logout(page);
  await page.getByRole('button', { name: '忘记密码' }).click();
  await page.getByLabel('账号', { exact: true }).fill(name);
  await page.getByLabel('恢复码', { exact: true }).fill(code);
  await page.getByLabel('新密码', { exact: true }).fill('recovered-diary-password!');
  await page.getByLabel('确认新密码', { exact: true }).fill('recovered-diary-password!');
  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/); await login(page, name, 'recovered-diary-password!');
  await page.goto('/settings/account'); await expect(page.getByText('尚无可用恢复码。', { exact: false })).toBeVisible();
});

test('recovers safely when a recovery-code response is lost', async ({ page }) => {
  await register(page);
  let discardResponse = true;
  await page.route('**/api/v1/security/recovery-code', async (route) => {
    if (!discardResponse || route.request().method() !== 'POST') { await route.continue(); return; }
    discardResponse = false; await route.fetch(); await route.abort('failed');
  });
  await page.getByRole('button', { name: '验证密码并生成新码' }).click();
  await page.getByRole('dialog').getByLabel('当前密码').fill(password);
  await page.getByRole('dialog').getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByText('恢复码生成结果未能确认')).toBeVisible();
  await expect(page.getByText('不会自动重复生成')).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: '验证密码并生成新码' }).click();
  await page.getByRole('dialog').getByLabel('当前密码').fill(password);
  await page.getByRole('dialog').getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '一次性显示的恢复码' })).not.toHaveValue('');
});

test('masks the old account immediately after a sibling tab switches accounts', async ({ page, context }) => {
  await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  await moment(page, '旧账号窗口的原稿');
  const sibling = await context.newPage(); await register(sibling);
  await expect(page.getByRole('alertdialog', { name: '请重新确认登录' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '日记正文' })).toHaveCount(0);
  await page.getByRole('button', { name: '保存本机草稿并去登录' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await sibling.close();
});

test('handles offline login without deleting the existing learning diary', async ({ page, context }) => {
  await moment(page, '断网前的本机日记'); await page.goto('/login');
  await page.getByLabel('账号', { exact: true }).fill(username());
  await page.getByLabel('密码', { exact: true }).fill(password);
  await context.setOffline(true); await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时无法连接服务');
  await page.getByRole('button', { name: '继续使用本机学习空间' }).click();
  await expect(page).toHaveURL(/\/today$/); await context.setOffline(false);
  await page.goto('/timeline'); await expect(page.getByRole('link', { name: '断网前的本机日记' })).toBeVisible();
});

test('opens an offline account copy only after the configured local PIN', async ({ page }) => {
  await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  await moment(page, '离线前账号日记');
  await page.goto('/settings/privacy');
  await page.getByLabel('设置 6 位本机 PIN').fill('246810');
  await page.getByLabel('再次输入 PIN').fill('246810');
  await page.getByRole('button', { name: '开启日记锁' }).click();
  await expect(page.getByRole('button', { name: '立即锁定' })).toBeVisible();
  await page.goto('/timeline');
  let syncRequests = 0;
  page.on('request', (request) => { if (request.url().includes('/api/v1/sync/')) syncRequests++; });
  await page.route('**/api/v1/auth/refresh', (route) => route.abort('failed'));
  await page.reload();
  await expect(page.getByRole('dialog', { name: '日记已锁定' })).toBeVisible();
  await expect(page.getByText('只打开这个账号保存在本机的副本')).toBeVisible();
  await page.getByLabel('6 位本机 PIN').fill('000000');
  await page.getByRole('button', { name: '解锁日记' }).click();
  await expect(page.getByRole('alert')).toContainText('PIN 不正确');
  await page.getByLabel('6 位本机 PIN').fill('246810');
  await page.getByRole('button', { name: '解锁日记' }).click();
  await expect(page.getByText('离线账号副本：修改只保存在此设备')).toBeVisible();
  await expect(page.getByRole('link', { name: '离线前账号日记' })).toBeVisible();

  await page.goto('/entries/new?kind=moment&date=2026-10-17');
  await expect(page.getByRole('dialog', { name: '日记已锁定' })).toBeVisible();
  await page.getByLabel('6 位本机 PIN').fill('246810');
  await page.getByRole('button', { name: '解锁日记' }).click();
  syncRequests = 0;
  await page.getByRole('textbox', { name: '日记标题' }).fill('离线 PIN 解锁后保存');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  await expect.poll(() => syncRequests).toBe(0);
});

test('saves account writing locally during a slow sync and uploads after recovery', async ({ page }) => {
  await register(page);
  let delayed = false, delayCompleted = false;
  const slowOnce = async (route) => {
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    await route.continue();
    delayCompleted = true;
  };
  await page.route('**/api/v1/sync/**', slowOnce);
  await page.getByRole('button', { name: '暂时跳过' }).click();
  await page.goto('/entries/new?kind=moment');
  const started = Date.now();
  await page.getByRole('textbox', { name: '日记标题' }).fill('慢网也先保存');
  await page.getByRole('textbox', { name: '日记正文' }).fill('云端响应慢时，正文先写入当前账号的本机空间。');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible({ timeout: 2200 });
  expect(Date.now() - started).toBeLessThan(2600);
  await expect.poll(() => delayed).toBe(true);
  await expect.poll(() => delayCompleted, { timeout: 5000 }).toBe(true);
  await page.unroute('**/api/v1/sync/**', slowOnce);
  await page.goto('/sync');
  await page.getByRole('button', { name: '立即同步' }).click();
  await expect(page.locator('[data-sync-summary]')).toContainText('待上传 0 篇', { timeout: 15000 });
  await expect(page.locator('[data-download-status]')).toContainText('本轮已保存的修改已确认', { timeout: 15000 });
});

test('changes a password and manages another active device through the real API', async ({ page }) => {
  const name = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  const other = await page.request.post('/api/v1/auth/native/login', { data: { username: name, password, device: { installationId: randomUUID(), platform: 'android', name: '测试 Android 会话' } } });
  expect(other.status()).toBe(200);
  await page.goto('/settings/devices');
  await expect(page.getByRole('heading', { name: '测试 Android 会话', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出该设备', exact: true }).click();
  await page.getByRole('dialog').getByLabel('当前密码').fill(password);
  await page.getByRole('dialog').getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '测试 Android 会话', exact: true })).toHaveCount(0);
  await page.goto('/settings/account');
  await page.getByLabel('新密码', { exact: true }).fill('changed-password-for-diary!');
  await page.getByLabel('确认新密码', { exact: true }).fill('changed-password-for-diary!');
  await page.getByRole('button', { name: '验证当前密码并修改' }).click();
  await page.getByRole('dialog').getByLabel('当前密码').fill(password);
  await page.getByRole('dialog').getByRole('button', { name: '继续', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page, name, 'changed-password-for-diary!');
});

test('treats a lost password-change response as uncertain and preserves the new password', async ({ page }) => {
  const name = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  await page.goto('/settings/account');
  const nextPassword = 'response-lost-new-password!';
  let discardResponse = true;
  await page.route('**/api/v1/security/password', async (route) => {
    if (!discardResponse || route.request().method() !== 'POST') { await route.continue(); return; }
    discardResponse = false; await route.fetch(); await route.abort('failed');
  });
  await page.getByLabel('新密码', { exact: true }).fill(nextPassword);
  await page.getByLabel('确认新密码', { exact: true }).fill(nextPassword);
  await page.getByRole('button', { name: '验证当前密码并修改' }).click();
  await page.getByRole('dialog').getByLabel('当前密码').fill(password);
  await page.getByRole('dialog').getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('结果未能确认');
  await expect(page.getByRole('alert')).toContainText('新密码可能已生效');
  await expect(page.getByLabel('新密码', { exact: true })).toHaveValue(nextPassword);
  await page.unrouteAll({ behavior: 'wait' });
  const oldLogin = await page.request.post('/api/v1/auth/native/login', { data: { username: name, password,
    device: { installationId: randomUUID(), platform: 'android', name: '旧密码验证设备' } } });
  expect(oldLogin.status()).toBe(401);
  const newLogin = await page.request.post('/api/v1/auth/native/login', { data: { username: name, password: nextPassword,
    device: { installationId: randomUUID(), platform: 'android', name: '新密码验证设备' } } });
  expect(newLogin.status()).toBe(200);
});

test('reuses an uncertain revoke-others request without revoking a later device', async ({ page }) => {
  const name = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  const nativeLogin = (deviceName) => page.request.post('/api/v1/auth/native/login', { data: {
    username: name, password, device: { installationId: randomUUID(), platform: 'android', name: deviceName },
  } });
  expect((await nativeLogin('先登录的手机')).status()).toBe(200);
  await page.goto('/settings/devices');
  await expect(page.getByRole('heading', { name: '先登录的手机', exact: true })).toBeVisible();
  let loseResponse = true; const requestIds = [];
  await page.route('**/api/v1/sessions/revoke-others', async (route) => {
    requestIds.push(route.request().postDataJSON().requestId);
    if (!loseResponse) { await route.continue(); return; }
    loseResponse = false; await route.fetch(); await route.abort('failed');
  });
  await page.getByRole('button', { name: '退出其他所有设备' }).click();
  await page.getByRole('dialog').getByLabel('当前密码').fill(password);
  await page.getByRole('dialog').getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('结果尚未确认');
  const later = await nativeLogin('响应丢失后新登录的手机');
  expect(later.status()).toBe(200); const laterSession = await later.json();
  await page.getByRole('button', { name: '退出其他所有设备' }).click();
  await page.getByRole('dialog').getByLabel('当前密码').fill(password);
  await page.getByRole('dialog').getByRole('button', { name: '继续', exact: true }).click();
  await expect.poll(() => requestIds.length).toBe(2);
  expect(requestIds[1]).toBe(requestIds[0]);
  const stillActive = await page.request.get('/api/v1/me', { headers: { Authorization: `Bearer ${laterSession.data.accessToken}` } });
  expect(stillActive.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '响应丢失后新登录的手机', exact: true })).toBeVisible();
});

test('reports an uncertain single-device revoke and confirms it by refreshing', async ({ page }) => {
  const name = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  const other = await page.request.post('/api/v1/auth/native/login', { data: { username: name, password,
    device: { installationId: randomUUID(), platform: 'android', name: '响应可能丢失的手机' } } });
  expect(other.status()).toBe(200);
  await page.goto('/settings/devices');
  await expect(page.getByRole('heading', { name: '响应可能丢失的手机', exact: true })).toBeVisible();
  let discardResponse = true;
  await page.route('**/api/v1/sessions/*', async (route) => {
    if (!discardResponse || route.request().method() !== 'DELETE') { await route.continue(); return; }
    discardResponse = false; await route.fetch(); await route.abort('failed');
  });
  await page.getByRole('button', { name: '退出该设备', exact: true }).click();
  await page.getByRole('dialog').getByLabel('当前密码').fill(password);
  await page.getByRole('dialog').getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('结果尚未确认');
  await expect(page.getByRole('alert')).toContainText('刷新设备列表确认');
  await page.unrouteAll({ behavior: 'wait' });
  await page.reload();
  await expect(page.getByRole('heading', { name: '设备会话', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '响应可能丢失的手机', exact: true })).toHaveCount(0);
});

test('export-and-logout from learning backs up the actual account namespace', async ({ page }) => {
  const name = await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  await moment(page, '必须导出的账号日记');
  await page.goto('/settings/account'); await page.getByRole('button', { name: '查看本机学习空间' }).click();
  await expect(page).toHaveURL(/\/today$/);
  await page.goto('/settings/account'); await page.getByRole('button', { name: '退出登录', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: '导出后退出', exact: true }).click();
  const download = await downloaded; const stream = await download.createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const backup = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(backup.namespace).toMatch(/^user:/); expect(backup.source).toBe('account-local');
  expect(backup.entries.some((entry) => entry.title === '必须导出的账号日记')).toBe(true);
  await expect(page).toHaveURL(/\/login$/); expect(name).toBeTruthy();
});

test('a failed account restore does not overwrite the chosen account-space preference', async ({ page }) => {
  await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  await page.route('**/api/v1/auth/refresh', (route) => route.abort());
  await page.reload(); await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  const preferred = await page.evaluate(() => new Promise((resolve, reject) => {
    // Omit a version: Dexie maps its logical v2 schema to IndexedDB v20.
    const request = indexedDB.open('diary-v2:device');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('settings', 'readonly').objectStore('settings').get('preferred-space');
      read.onerror = () => { db.close(); reject(read.error); };
      read.onsuccess = () => { const value = read.result?.value ?? null; db.close(); resolve(value); };
    };
  }));
  expect(preferred).toBe('account');
  await expect(page.getByRole('status').filter({ hasText: '账号会话暂未恢复' })).toBeVisible();
});

test('rescues an unsaved draft after account invalidation without writing it into the new account', async ({ page, context }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.failDiaryWrites && this.transaction.db.name.startsWith('diary-v2:user:') && ['entries', 'drafts'].includes(this.name)) throw new DOMException('测试：存储空间不足', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await register(page); await page.getByRole('button', { name: '暂时跳过' }).click();
  await page.goto('/entries/new?kind=moment');
  await page.getByRole('textbox', { name: '日记标题' }).waitFor();
  await page.evaluate(() => { window.failDiaryWrites = true; });
  await page.getByRole('textbox', { name: '日记标题' }).fill('不能丢失的未保存草稿');
  await page.getByRole('textbox', { name: '日记正文' }).fill('磁盘写入失败也要保留这段话。');
  await expect(page.getByRole('heading', { name: '这次修改尚未保存' })).toBeVisible();
  const sibling = await context.newPage(); await register(sibling);
  await expect(page.getByRole('alertdialog')).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出救援备份', exact: true }).click();
  const stream = await (await downloaded).createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const backup = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(backup.unsavedEditor.title).toBe('不能丢失的未保存草稿');
  expect(JSON.stringify(backup.unsavedEditor.content)).toContain('磁盘写入失败也要保留这段话。');
  await expect(page.getByRole('button', { name: '备份已确认，继续登录' })).toBeDisabled();
  await page.getByLabel('我已确认救援备份包含当前草稿').check();
  await page.getByRole('button', { name: '备份已确认，继续登录' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await sibling.getByRole('button', { name: '暂时跳过' }).click(); await sibling.goto('/timeline');
  await expect(sibling.getByRole('link', { name: '不能丢失的未保存草稿' })).toHaveCount(0);
  await sibling.close();
});
