import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path => import(pathToFileURL(resolve(root, path)).href);
const { changeMasters, practiceLedger, register } = await source('src/domain/ledger.ts');
const { consumablesOf, replenishmentOf, stockOf } = await source('src/domain/packaging.ts');
const { parseScalar } = await source('src/domain/scalar.ts');
const { emptySupply, recordRemainder } = await source('src/domain/supply.ts');
const { consumableLinesText } = await source('src/ui/supply-format.ts');
const { initial, parse, serialize } = await source('src/ui/storage.ts');
const { backupTextOf, readBackup } = await source('src/ui/backup.ts');
const at = '2026-10-02T09:00:00+09:00';
const meta = eventId => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const add = (ledger, id, basis, value, item = 'V', unit = '本', project = { kind: 'common' }) =>
  register(ledger, meta(id), { id, item, unit, project, location: 'S1' }, basis, value);
const config = (ledger, item) => {
  const cfg = consumablesOf(ledger.masters).find(value => value.item === item);
  assert.ok(cfg);
  return cfg;
};
function lines(ledger, supply = emptySupply, item = 'V') {
  const cfg = config(ledger, item);
  const common = lot => lot.project.kind === 'common';
  const stock = stockOf(ledger, supply, item, cfg.pieceUnit, common);
  const lots = Object.values(ledger.lots).filter(lot => lot.item === item && lot.mergedInto === null && common(lot));
  const requests = Object.values(supply.requests).filter(request => request.item === item && common(request));
  return consumableLinesText(ledger, cfg, lots, stock, cfg.rule ? replenishmentOf(stock, cfg.rule) : { kind: 'none' }, requests).join('\n');
}

for (const value of [0, 7, Number.MAX_SAFE_INTEGER]) {
  test(`count only: ${value} known and remainder level must be a subtotal, including save and backup restore`, () => {
    const ledger = add(add(practiceLedger, 'KNOWN', 'counted', value), 'OPEN', 'unknown', null);
    const supply = recordRemainder(ledger, emptySupply, meta('level'), 'OPEN', 'few');
    assert.equal(config(ledger, 'V').rule, null);
    const snapshot = initial(ledger, supply);
    const before = serialize(snapshot);
    const text = lines(ledger, supply);
    assert.ok(text.includes(`数量の数値部分の小計（本） ${value}本・数えた`), text);
    assert.ok(!text.includes('数量合計（本）'), text);
    assert.ok(text.includes('残量区分のみ（数量へは換算しない）：OPEN 少ない'));
    assert.ok(!text.includes('補充'));
    assert.equal(serialize(snapshot), before);
    const loaded = parse(before);
    assert.deepEqual(loaded.ledger, ledger);
    assert.deepEqual(loaded.supply, supply);
    assert.equal(lines(loaded.ledger, loaded.supply), text);
    const restored = readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)));
    assert.equal(restored.kind, 'ok');
    assert.deepEqual(restored.snapshot.ledger, ledger);
    assert.deepEqual(restored.snapshot.supply, supply);
    assert.equal(lines(restored.snapshot.ledger, restored.snapshot.supply), text);
  });
}

for (const value of [0, 7]) {
  test(`numeric only: ${value} remains a total`, () => {
    const text = lines(add(practiceLedger, 'KNOWN', 'counted', value));
    assert.ok(text.includes(`数量合計（本） ${value}本・数えた`), text);
    assert.ok(!text.includes('小計'));
  });
}

test('remainder level only has no numeric value and is not zero', () => {
  const ledger = add(practiceLedger, 'OPEN', 'unknown', null);
  const supply = recordRemainder(ledger, emptySupply, meta('level'), 'OPEN', 'half');
  const text = lines(ledger, supply);
  assert.ok(text.includes('数量合計（本） 数値なし'), text);
  assert.ok(text.includes('残量区分のみ（数量へは換算しない）：OPEN 半分程度'));
  assert.ok(!text.includes('0本'));
});

test('decimal count only: 0.1 + 0.2 remains 0.3 with unknown remainder excluded', () => {
  let ledger = changeMasters(practiceLedger, meta('item'), { action: 'register', master: { type: 'item', code: 'D', name: '架空消耗品D', units: ['個'], unitSteps: { 個: 0.1 }, source: null, trial: true } });
  ledger = changeMasters(ledger, meta('config'), { action: 'consumable', id: 'D', setting: { pieceUnit: '個', rule: null }, reason: '数量だけを見る' });
  ledger = add(add(add(ledger, 'A', 'counted', 0.1, 'D', '個'), 'B', 'counted', 0.2, 'D', '個'), 'OPEN', 'unknown', null, 'D', '個');
  const supply = recordRemainder(ledger, emptySupply, meta('level'), 'OPEN', 'few');
  const text = lines(ledger, supply, 'D');
  assert.ok(text.includes('数量の数値部分の小計（個） 記録上の数0.3個'), text);
  assert.ok(!text.includes('0.30000000000000004'));
  assert.ok(!text.includes('数量合計（個）'));
});

test('converted packaging plus remainder level is a subtotal and keeps label evidence', () => {
  const ledger = add(add(practiceLedger, 'BOX', 'counted', 2, 'S', '箱'), 'OPEN', 'unknown', null, 'S');
  const supply = recordRemainder(ledger, emptySupply, meta('level'), 'OPEN', 'few');
  const text = lines(ledger, supply, 'S');
  assert.match(text, /数量の数値部分の小計（本） .*2000本/);
  assert.ok(text.includes('中身未確認'));
  assert.ok(!text.includes('数量合計（本）'));
});

test('unknown quantity without a remainder level keeps the existing unknown total', () => {
  const text = lines(add(add(practiceLedger, 'KNOWN', 'counted', 7), 'OPEN', 'unknown', null));
  assert.ok(text.includes('数値部分の小計7本'));
  assert.ok(text.includes('ほかに数が不明1件。全体数量は不明'));
});

test('case-specific stock is excluded from common counts', () => {
  const ledger = add(add(practiceLedger, 'COMMON', 'counted', 7), 'CASE', 'counted', 100, 'V', '本', { kind: 'case', id: 'A-001' });
  const text = lines(ledger);
  assert.ok(text.includes('数量合計（本） 7本・数えた'), text);
  assert.ok(!text.includes('CASE'));
  assert.ok(!text.includes('107本'));
});

test('quantity validation preserves zero and the safe limit, rejecting invalid values', () => {
  assert.equal(parseScalar('0', 1), 0);
  assert.equal(parseScalar(String(Number.MAX_SAFE_INTEGER), 1), Number.MAX_SAFE_INTEGER);
  assert.equal(parseScalar('0.3', 0.1), 0.3);
  for (const text of ['-1', '9007199254740992', '0.1', 'NaN', 'Infinity', '']) assert.throws(() => parseScalar(text, 1));
  assert.throws(() => parseScalar('0.10000000000000001', 0.1));
});

test('legacy v10 consumable fixtures remain readable without adding configuration', () => {
  const legacy = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/consumables-v10/partial.json'), 'utf8'));
  for (const raw of [legacy.initial, legacy.complete]) {
    const loaded = parse(raw);
    for (const item of Object.values(loaded.ledger.masters.items)) assert.equal(item.consumable, null);
  }
});
