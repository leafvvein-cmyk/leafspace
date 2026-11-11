import { expect, test } from '@playwright/test';

test('creates, edits, completes, deletes and restores an offline task', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: '待办', exact: true })).toBeVisible();
  await expect(page.locator(page.viewportSize().width < 768 ? '.bottom-navigation' : '.main-navigation').getByRole('link', { name: '待办' })).toHaveAttribute('aria-current', 'page');

  await page.locator('.page-header').getByRole('button', { name: '新建待办' }).click();
  await page.getByRole('textbox', { name: '标题' }).fill('准备周会资料');
  await page.getByRole('textbox', { name: '备注' }).fill('整理本周进展与问题');
  await page.getByRole('textbox', { name: '子项' }).fill('整理进展\n列出问题');
  await page.locator('dialog').getByRole('combobox', { name: '优先级' }).selectOption('urgent');
  await page.getByLabel('截止时间').fill('2026-09-09T09:00');
  await page.locator('.task-form-grid').getByRole('combobox').nth(2).selectOption('weekly');
  await page.getByLabel('重复间隔').fill('2');
  await page.getByLabel('周一').check();
  await page.getByLabel('周三').check();
  await page.getByRole('button', { name: '创建待办' }).click();
  await expect(page.getByRole('heading', { name: '准备周会资料' })).toBeVisible();
  await expect(page.getByText('0/2 子项')).toBeVisible();
  await expect(page.getByText('每 2 周的周一、周三重复')).toBeVisible();
  await expect(page.getByRole('region', { name: '逾期待办' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('1 项修改仅保存在此设备');
  await page.getByLabel('搜索待办').fill('不会匹配的内容');
  await expect(page.getByRole('heading', { name: '没有符合筛选的待办' })).toBeVisible();
  await page.getByLabel('搜索待办').fill('周会');
  await page.getByLabel('筛选优先级').selectOption('urgent');
  await expect(page.getByRole('heading', { name: '准备周会资料' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: '准备周会资料' })).toBeVisible();
  await page.getByRole('button', { name: '编辑' }).click();
  await page.getByRole('textbox', { name: '标题' }).fill('准备周会资料（已整理）');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByRole('heading', { name: '准备周会资料（已整理）' })).toBeVisible();

  await page.getByRole('button', { name: '完成：准备周会资料（已整理）' }).click();
  await expect(page.getByRole('heading', { name: '准备周会资料（已整理）' })).toHaveCount(0);
  await page.getByRole('button', { name: '已完成' }).click();
  await expect(page.getByRole('heading', { name: '准备周会资料（已整理）' })).toBeVisible();
  await page.getByRole('button', { name: '重新打开：准备周会资料（已整理）' }).click();
  await page.getByRole('button', { name: '待完成' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '已删除' }).click();
  await expect(page.getByRole('heading', { name: '准备周会资料（已整理）' })).toBeVisible();
  await page.getByRole('button', { name: '恢复' }).click();
  await page.getByRole('button', { name: '待完成' }).click();
  await expect(page.getByRole('heading', { name: '准备周会资料（已整理）' })).toBeVisible();
  expect(errors).toEqual([]);
});
