import { expect, test } from '@playwright/test';
import { selectOperation, goTo, cell, opLabels, record, recorded, startEmpty, storageBytes, waitForApp } from './helpers.ts';

for (const scenario of [
  { unit: '個', step: '1', prior: '9007199254740990', receipt: '2', allocation: '1' },
  { unit: 'kg', step: '0.1', prior: '562949953421311.8', receipt: '0.2', allocation: '0.1' },
]) {
  test(`ADR-035・2.4・3.2: ${scenario.unit}の割り当て合計超過は受け取り全体を無変更拒否し、修正後だけ一回保存する`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await startEmpty(page);
    const { unit, step, prior, receipt, allocation } = scenario;
    await recorded(page, 'masterItem', { code: 'D', name: '架空境界品目', units: unit, [`unitStep-${unit}`]: step }, '07:00');
    const request = { project: 'A-001', item: 'D', unit, vendor: '架空仕入先', requestedOn: '2026-09-29', replyKind: 'none' };
    await recorded(page, 'requestRecord', { ...request, quantity: prior }, '07:10');
    await recorded(page, 'requestRecord', { ...request, quantity: allocation }, '07:20');
    const form = page.getByRole('form', { name: '操作の入力' });
    await selectOperation(form.locator('[name=op]'), { label: opLabels.receive });
    const requests = await form.locator('[name=r1request] option').evaluateAll(options => options.flatMap(option => option instanceof HTMLOptionElement && option.value ? [option.value] : []));
    const [first, second] = requests;
    if (first === undefined || second === undefined || requests.length !== 2) throw new Error('架空依頼二件が必要');
    const received = { item: 'D', unit, project: 'A-001', location: 'S1', basis: 'counted' };
    await recorded(page, 'receive', { ...received, newId: 'OLD', value: prior, r1request: first, r1arrived: prior, r1good: '0' }, '08:00');
    await recorded(page, 'use', { lot: 'OLD', basis: 'counted', value: prior, usedFor: '架空作業' }, '09:00');
    const before = await storageBytes(page);
    await goTo(page, 'issues');
    const shown = await page.locator('#history').innerText();
    const rejected = await record(page, 'receive', { ...received, newId: 'NEW', value: receipt,
      r1request: first, r1arrived: allocation, r1good: '0', r2request: second, r2arrived: allocation, r2good: '0' }, '10:00');
    await expect(rejected).toContainText('記録していない：');
    await expect(rejected).toContainText('届いた数の合計が上限を超える');
    expect(await storageBytes(page)).toEqual(before);
    expect(await page.locator('#history').innerText()).toBe(shown);
    await goTo(page, 'stock');
    await expect(cell(page, 'NEW', '記録上の数と根拠')).toHaveCount(0);
    await expect(form.locator('[name=newId]')).toHaveValue('NEW');
    await expect(form.locator('[name=r2arrived]')).toHaveValue(allocation);
    await page.reload();
    await waitForApp(page);
    expect(await storageBytes(page)).toEqual(before);
    await expect(cell(page, 'NEW', '記録上の数と根拠')).toHaveCount(0);
    await recorded(page, 'receive', { ...received, newId: 'NEW', value: receipt, r1request: first, r1arrived: allocation, r1good: '0' }, '10:00');
    await expect(cell(page, 'NEW', '記録上の数と根拠')).toContainText(`${receipt}${unit}`);
    const saved = await storageBytes(page);
    await page.reload();
    await waitForApp(page);
    expect(await storageBytes(page)).toEqual(saved);
    await expect(cell(page, 'NEW', '記録上の数と根拠')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}
