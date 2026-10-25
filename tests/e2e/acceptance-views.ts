import { expect, type Page } from '@playwright/test';
import { selectOperation, goTo, cell, lot, opLabels, recorded, row, waitForApp } from './helpers.ts';

export async function verifyScn01Case(page: Page): Promise<void> {
  await goTo(page, 'stock');
  await recorded(page, 'needRegister', { project: 'A-001', item: 'P', basis: 'counted', value: '120', source: '架空AT45必要表', revision: '初版' }, '17:40');
  await recorded(page, 'stop', { process: 'R組立', item: 'R', project: 'A-001', reason: '架空AT45部品待ち', shortageItem: 'P', shortageValue: '20', affected: '2' }, '17:45');
  await goTo(page, 'supply');
  await page.locator('[name=case-project]').selectOption('A-001');
  const parts = page.locator('#case article[data-item="P"][data-unit="個"]');
  await expect(parts).toContainText('必要な数 120個');
  await expect(parts).toContainText('元の資料「架空AT45必要表」・初版');
  await expect(parts).toContainText('不足 20個');
  await expect(parts).toContainText('影響2台');
  await expect(parts.locator('li').filter({ hasText: '保管単位PA・' })).toContainText('保管単位PA・所在S1・記録上の数70個');
  const assembled = page.locator('#case article[data-item="R"][data-unit="台"]');
  const section = (name: string) => assembled.getByRole('heading', { name, exact: true }).locator('xpath=following-sibling::ul[1]');
  await expect(section('仕掛品')).toContainText('保管単位R1・所在T・記録上の数10台');
  await expect(section('仕掛品')).toContainText('保管単位R2・所在T・記録上の数2台');
  await expect(section('工程完了品')).toContainText('保管単位R3・所在T・記録上の数8台');
  await expect(section('未使用の部品')).toContainText('保管単位R4・所在N・10台・数えた');
  await assembled.locator('button[data-lot="R3"]').click();
  await expect(page.locator('#detail')).toContainText('現在の記録上の数記録上の数8台');
}

// SCN本来の期待値を確認したあと、そのデータに不明と仮の記録を加えてAT-45の表示を操作する。
export async function verifyScenarioViews(page: Page, known: { id: string; project: string; current: number; lastCount: number }): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-14T05:00:00+09:00'));
  await goTo(page, 'stock');
  await row(page, known.id).getByRole('button', { name: known.id, exact: true }).click();
  const detail = page.locator('#detail');
  await expect(detail).toContainText(`現在の記録上の数記録上の数${known.current}個`);
  await expect(detail).toContainText(`最後に数えた数${known.lastCount}個（2026-09-29 09:00（日本時間）`);
  await expect(detail).toContainText('この数を数えたわけではない');
  await expect(detail).toContainText('この保管単位の履歴');

  await recorded(page, 'requestRecord', { project: known.project, item: 'P', quantity: '5', vendor: '架空AT45関連依頼', requestedOn: '2026-09-29', replyKind: 'none' }, '18:00');
  const related = page.locator(`#supply article[data-group="${known.project}/P/個"]`);
  const request = related.locator('li').filter({ hasText: '架空AT45関連依頼' });
  await goTo(page, 'supply');
  await expect(request).toHaveCount(1);
  await expect(request).toContainText('5個・架空AT45関連依頼'); await expect(request).toContainText('未着5個');
  await expect(request).toContainText('納期未回答');
  await page.locator('[name=case-project]').selectOption(known.project);
  const caseRequest = page.locator('#case article[data-item="P"][data-unit="個"] li').filter({ hasText: '架空AT45関連依頼' });
  await expect(caseRequest).toHaveCount(1);
  await expect(caseRequest).toContainText('5個・架空AT45関連依頼');
  await expect(caseRequest).toContainText('未着5個');
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('AT45-unknown', 'Q', 'S2', 'unknown', '', { project: 'unassigned' }), '18:05');
  await recorded(page, 'register', lot('AT45-common', 'Q', 'S1', 'counted', '2', { project: 'common' }), '18:06');
  await expect(cell(page, 'AT45-unknown', '記録上の数と根拠')).toHaveText('数が不明');
  await expect(cell(page, 'AT45-unknown', '最後に数えた数')).toHaveText('数えた記録なし');
  await expect(cell(page, 'AT45-unknown', '確認が必要')).toHaveText('なし');

  for (const [name, value] of [['f-item', 'Q'], ['f-project', 'unassigned'], ['f-location', 'S2']]) {
    await page.locator(`[name=${name}]`).selectOption(value!);
    await goTo(page, 'stock');
    await expect(row(page, 'AT45-unknown')).toBeVisible(); await expect(row(page, known.id)).toHaveCount(0);
    await page.locator(`[name=${name}]`).selectOption('');
  }
  await goTo(page, 'stock');
  await page.locator('[name=f-item]').selectOption('P');
  await page.locator('[name=f-project]').selectOption(known.project);
  await page.locator('[name=f-location]').selectOption('S1');
  await expect(row(page, known.id)).toBeVisible(); await expect(row(page, 'AT45-unknown')).toHaveCount(0);
  for (const name of ['f-item', 'f-project', 'f-location']) await page.locator(`[name=${name}]`).selectOption('');
  await goTo(page, 'stock');
  await page.locator('[name=f-project]').selectOption('common');
  await expect(cell(page, 'AT45-common', '案件・用途')).toHaveText('共通在庫');
  await expect(row(page, known.id)).toHaveCount(0); await expect(row(page, 'AT45-unknown')).toHaveCount(0);
  await page.locator('[name=f-project]').selectOption('');
  await row(page, 'AT45-unknown').getByRole('button', { name: 'AT45-unknown', exact: true }).click();
  await expect(detail).toContainText('現在の記録上の数数が不明');
  await expect(detail).toContainText('案件・用途案件・用途が不明');
  await expect(detail).toContainText('・個');

  await recorded(page, 'provisional', { direction: 'found', item: '', location: 'T', basis: 'unknown', note: '架空AT45の元不明の箱' }, '18:10');
  const provisional = page.locator('#issues tbody tr').filter({ hasText: '架空AT45の元不明の箱' });
  await goTo(page, 'issues');
  await expect(provisional).toContainText('適用対象不明（仮の記録）');
  await expect(provisional).toContainText('対象なし（仮の記録）');
  await expect(provisional).toContainText('台帳に足していない');
  await expect(provisional).toContainText('数が不明');

  await goTo(page, 'stock');
  const before = await cell(page, known.id, '記録上の数と根拠').innerText();
  const updatedBefore = await page.locator('#updated').innerText();
  await page.clock.setFixedTime(new Date('2026-10-14T05:15:00+09:00'));
  await recorded(page, 'use', { lot: known.id, basis: 'counted', value: '999', usedFor: '架空AT45未反映の使用' }, '18:15');
  const held = page.locator('#issues tbody tr').filter({ hasText: '架空AT45未反映の使用' });
  await goTo(page, 'issues');
  await expect(held).toContainText('負数になるため未反映'); await expect(held).toContainText('999個');
  await expect(held).toContainText('親から減らしていない（未適用）');
  const issue = await held.locator('td').first().innerText();
  await goTo(page, 'stock');
  await expect(cell(page, known.id, '記録上の数と根拠')).toHaveText(before);
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(cell(page, known.id, '確認が必要')).toHaveText('確認が必要 1件');
  await row(page, known.id).getByRole('button', { name: known.id, exact: true }).click();
  await expect(detail).toContainText('記録上の数は直前の適用済みの値');
  await expect(detail).toContainText('負数になるため未反映');
  await expect(page.locator('#updated')).not.toHaveText(updatedBefore);
  await expect(page.locator('#updated')).toHaveText('最終記録更新：2026-10-14 05:15（日本時間）');
  const heldHistory = page.locator('#history li').filter({ hasText: '架空AT45未反映の使用' });
  await goTo(page, 'issues');
  await expect(heldHistory).toHaveCount(1);
  await expect(heldHistory).toContainText('発生 2026-09-29 18:15（日本時間）');
  await expect(heldHistory).toContainText('記録 2026-10-14 05:15（日本時間）');

  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: opLabels.use });
  for (const name of ['newId', 'r1request', 'alternativeSource', 'note', 'process']) await expect(form.locator(`[name=${name}]`)).toHaveCount(0);
  await goTo(page, 'stock');
  await recorded(page, 'recount', { lot: known.id, value: String(known.current), causeUnknown: true }, '18:20');
  await recorded(page, 'resolve', { issue, outcome: 'close' }, '18:25');
  const resolved = page.locator(`#issues tr[data-issue="${issue}"]`);
  await goTo(page, 'issues');
  await expect(resolved).toContainText('解消済み'); await expect(resolved).toContainText('閉じた');
  await expect(resolved).toContainText('架空AT45未反映の使用');
  await expect(provisional).toContainText('確認が必要（未解決）');
  await page.reload(); await waitForApp(page);
  await goTo(page, 'issues');
  await expect(resolved).toContainText('解消済み'); await expect(provisional).toContainText('適用対象不明（仮の記録）');
  await goTo(page, 'stock');
  await expect(cell(page, 'AT45-unknown', '記録上の数と根拠')).toHaveText('数が不明');
  await expect(cell(page, known.id, '記録上の数と根拠')).toHaveText(`${known.current}個・数えた`);
  await goTo(page, 'supply');
  await expect(related).toContainText('架空AT45関連依頼');
}
