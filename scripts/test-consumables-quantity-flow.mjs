import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path => import(pathToFileURL(resolve(root, path)).href);
const { practiceLedger, use, recount, openIssues, InclusionRequired } = await source('src/domain/ledger.ts');
const { emptySupply, recordRemainder, currentLevelOf } = await source('src/domain/supply.ts');
const { consumablesOf, stockOf } = await source('src/domain/packaging.ts');
const { masterOps } = await source('src/ui/master-ui.ts');
const { amount, quantityValue, quantityStepFor, quantityTargetOf, registerFromValues } = await source('src/ui/fields.ts');
const core = await source('src/ui/storage.ts');
const { backupTextOf, readBackup } = await source('src/ui/backup.ts');
const { consumableLinesText } = await source('src/ui/supply-format.ts');

const actor = '架空担当A';
const recordedAt = '2026-10-30T12:00:00+09:00';
const meta = (eventId, minute = 0) => ({ eventId, actor, recordedAt, occurredAt: `2026-10-30T09:${String(minute).padStart(2, '0')}:00+09:00` });
function values(entries, state) {
  const text = name => typeof entries[name] === 'string' ? entries[name] : '';
  return { text, checked: name => entries[name] === true,
    step: name => quantityStepFor(state.ledger.masters, quantityTargetOf(name => Object.hasOwn(entries, name) ? text(name) : null, state.ledger, state.supply, name) ?? null) };
}
function configured(unit = '個') {
  let state = { ledger: practiceLedger, supply: emptySupply };
  const ctx = { ledger: () => state.ledger, supply: () => state.supply };
  const operations = masterOps(ctx);
  state = operations.masterItem.run(state, meta('setup-item'), values({ code: 'D', name: '架空共通消耗品D', units: '個、kg', 'unitStep-個': '1', 'unitStep-kg': '0.1', trial: 'true' }, state)).state;
  state = operations.masterConsumable.run(state, meta('setup-config'), values({ target: 'item:D', consumableEnabled: true, pieceUnit: unit, replenishmentEnabled: false, reason: '数量だけを管理する' }, state)).state;
  assert.deepEqual(state.ledger.masters.items.D.consumable, { pieceUnit: unit, rule: null });
  return state;
}
function memory() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
function harness(unit = '個') {
  const store = memory();
  const state = configured(unit);
  let snapshot = core.replace(store, null, state);
  const operation = (eventId, label, entries = {}) => ({ opId: eventId, opLabel: label, fingerprint: core.fingerprintOf(label, entries), values: entries, actor, startedAt: recordedAt, savingSince: recordedAt });
  const prepared = (next, eventId, label, entries = {}) => ({
    op: operation(eventId, label, entries), units: [{ ...next, conflictReviews: snapshot.conflictReviews, targets: core.targetsOf(snapshot, next) }], before: snapshot,
  });
  const reload = () => {
    const loaded = core.load(store);
    assert.equal(loaded.kind, 'ok', JSON.stringify(loaded));
    assert.equal(loaded.pending, null);
    snapshot = loaded.snapshot;
    return snapshot;
  };
  const persist = (next, eventId, label, entries = {}) => {
    const request = prepared(next, eventId, label, entries);
    const result = core.commit(store, request.before, request.op, request.units);
    assert.equal(result.kind, 'saved', JSON.stringify(result));
    snapshot = result.snapshot;
    const loaded = reload();
    assert.deepEqual(loaded.ledger, next.ledger);
    assert.deepEqual(loaded.supply, next.supply);
    assert.deepEqual(loaded.supply.requests, {});
    return loaded;
  };
  const register = (raw, basis = 'counted', eventId = 'op1', minute = 1) => {
    const entries = { newId: 'L', item: 'D', unit, project: 'common', location: 'S1', basis, value: raw };
    const ledger = registerFromValues(snapshot.ledger, meta(eventId, minute), values(entries, snapshot));
    return persist({ ledger, supply: snapshot.supply }, eventId, '登録', entries);
  };
  const consume = (raw, basis = 'counted', eventId = 'op2', minute = 2, inclusion) => {
    const entries = { lot: 'L', basis, value: raw, usedFor: '架空の練習作業' };
    const v = values(entries, snapshot), parsed = amount(v);
    const ledger = use(snapshot.ledger, meta(eventId, minute), 'L', parsed.basis, parsed.value, entries.usedFor, inclusion);
    return persist({ ledger, supply: snapshot.supply }, eventId, '使用', entries);
  };
  const count = (raw, eventId = 'op3', minute = 3, inclusion) => {
    const entries = { lot: 'L', value: raw };
    const v = values(entries, snapshot);
    const ledger = recount(snapshot.ledger, meta(eventId, minute), 'L', quantityValue(v.text('value'), v.step('value')), { kind: 'unknown' }, inclusion);
    return persist({ ledger, supply: snapshot.supply }, eventId, '数えて確認・訂正', entries);
  };
  const number = () => snapshot.ledger.lots.L.quantity.numeric?.value ?? null;
  const backup = () => {
    const encoded = new TextEncoder().encode(backupTextOf(snapshot, recordedAt));
    const read = readBackup(encoded);
    assert.equal(read.kind, 'ok', JSON.stringify(read));
    assert.deepEqual(read.snapshot, snapshot);
    return { encoded, read };
  };
  return { store, get snapshot() { return snapshot; }, prepared, persist, reload, register, consume, count, number, backup };
}

for (const [unit, original, used, remaining, counted] of [
  ['個', '10', '3', 7, '6'],
  ['個', '0', '0', 0, '0'],
  ['kg', '0.3', '0.1', 0.2, '0.1'],
  ['個', '9007199254740991', '1', 9007199254740990, '9007199254740991'],
  ['kg', '562949953421311.9', '0.1', 562949953421311.8, '562949953421311.9'],
  ['個', '1e1', '+3.0', 7, '6e0'],
]) {
  test(`quantity-only lifecycle ${unit}: register ${original}, consume ${used}, recount ${counted}, reload, backup and replace`, () => {
    const flow = harness(unit);
    flow.register(original);
    flow.consume(used);
    assert.equal(flow.number(), remaining);
    flow.count(counted);
    const expected = Number(counted);
    assert.equal(flow.number(), expected);
    assert.deepEqual(openIssues(flow.snapshot.ledger), []);
    const { read } = flow.backup();
    flow.count('1', 'op4', 4);
    assert.equal(flow.number(), 1);
    assert.notEqual(flow.number(), expected);
    const previous = flow.snapshot;
    const restored = core.replace(flow.store, previous, read.snapshot);
    assert.equal(restored.revision, previous.revision + 1);
    const loaded = flow.reload();
    assert.deepEqual(loaded.ledger, read.snapshot.ledger);
    assert.deepEqual(loaded.supply, read.snapshot.supply);
    assert.equal(flow.number(), expected);
    const config = consumablesOf(loaded.ledger.masters).find(value => value.item === 'D');
    const stock = stockOf(loaded.ledger, loaded.supply, 'D', unit, lot => lot.project.kind === 'common');
    assert.equal(stock.pieces.numeric.value, expected);
    const lines = consumableLinesText(loaded.ledger, config, Object.values(loaded.ledger.lots), stock, { kind: 'none' }, []).join('\n');
    assert.ok(!lines.includes('補充'));
  });
}

for (const [unit, raw] of [['個', ''], ['個', '-1'], ['個', '0.1'], ['kg', '0.05'], ['kg', '0.10000000000000001'], ['個', '9007199254740992'], ['kg', '562949953421312'], ['個', '0x10'], ['個', 'NaN'], ['個', 'Infinity'], ['kg', '1e-999']]) {
  test(`invalid quantity ${unit} ${JSON.stringify(raw)} is rejected without changing ledger or saved data`, () => {
    const flow = harness(unit);
    const before = [...flow.store.data];
    const state = core.serialize(flow.snapshot);
    assert.throws(() => flow.register(raw));
    assert.equal(core.serialize(flow.snapshot), state);
    assert.deepEqual([...flow.store.data], before);
    flow.register('1');
    const registered = [...flow.store.data];
    const previous = core.serialize(flow.snapshot);
    assert.throws(() => flow.consume(raw));
    assert.equal(core.serialize(flow.snapshot), previous);
    assert.deepEqual([...flow.store.data], registered);
    assert.throws(() => flow.count(raw));
    assert.equal(core.serialize(flow.snapshot), previous);
    assert.deepEqual([...flow.store.data], registered);
  });
}

test('unknown stock stays unknown through consumption, then recount establishes the number', () => {
  const flow = harness();
  flow.register('', 'unknown');
  flow.consume('1');
  assert.equal(flow.snapshot.ledger.lots.L.quantity.kind, 'unknown');
  flow.backup();
  flow.count('7');
  assert.equal(flow.number(), 7);
  assert.equal(flow.snapshot.ledger.lots.L.quantity.kind, 'known');
  flow.backup();
});

test('unknown consumption preserves the previous known number as evidence, without reporting it as remaining stock', () => {
  const flow = harness();
  flow.register('7');
  flow.consume('', 'unknown');
  const quantity = flow.snapshot.ledger.lots.L.quantity;
  assert.equal(quantity.kind, 'unknown');
  assert.equal(quantity.before.numeric.value, 7);
  assert.equal(stockOf(flow.snapshot.ledger, flow.snapshot.supply, 'D', '個').pieces.kind, 'unknown');
  flow.backup();
});

test('overconsumption is held as an issue and never clips remaining stock to zero', () => {
  const flow = harness();
  flow.register('1');
  flow.consume('2');
  assert.equal(flow.number(), 1);
  assert.equal(flow.snapshot.ledger.history.at(-1).applied, false);
  assert.equal(openIssues(flow.snapshot.ledger)[0].reason, 'negative');
  flow.count('0');
  assert.equal(flow.number(), 0);
  flow.backup();
});

test('out-of-order consumption requires an inclusion answer and does not silently subtract twice', () => {
  const flow = harness();
  flow.register('10');
  flow.count('7', 'op2', 5);
  const before = [...flow.store.data];
  assert.throws(() => flow.consume('3', 'counted', 'op3', 4), InclusionRequired);
  assert.deepEqual([...flow.store.data], before);
  flow.consume('3', 'counted', 'op3', 4, 'included');
  assert.equal(flow.number(), 7);
  assert.equal(flow.snapshot.ledger.history.at(-1).applied, false);
});

test('remainder levels expire after consumption and recount, including after reload and backup restoration', () => {
  const flow = harness();
  flow.register('', 'unknown');
  const marked = recordRemainder(flow.snapshot.ledger, flow.snapshot.supply, meta('op2', 2), 'L', 'half');
  flow.persist({ ledger: flow.snapshot.ledger, supply: marked }, 'op2', '残り具合');
  assert.equal(currentLevelOf(flow.snapshot.ledger, flow.snapshot.supply, flow.snapshot.ledger.lots.L), 'half');
  flow.consume('1', 'counted', 'op3', 3);
  assert.equal(currentLevelOf(flow.snapshot.ledger, flow.snapshot.supply, flow.snapshot.ledger.lots.L), undefined);
  flow.count('7', 'op4', 4);
  assert.equal(currentLevelOf(flow.snapshot.ledger, flow.snapshot.supply, flow.snapshot.ledger.lots.L), undefined);
  assert.equal(flow.number(), 7);
  const { read } = flow.backup();
  const restoredStore = memory();
  const restored = core.replace(restoredStore, null, read.snapshot);
  assert.equal(currentLevelOf(restored.ledger, restored.supply, restored.ledger.lots.L), undefined);
});

test('a failed slot write preserves saved quantities and permits one later save', () => {
  const flow = harness();
  flow.register('10');
  const current = flow.snapshot;
  const ledger = use(current.ledger, meta('op2', 2), 'L', 'counted', 3, '架空の練習作業');
  const request = flow.prepared({ ledger, supply: current.supply }, 'op2', '使用', { value: '3' });
  const head = flow.store.getItem('fuzzy-stock/head');
  const slot = head === 'A' ? 'B' : 'A';
  const write = flow.store.setItem;
  let failed = false;
  flow.store.setItem = (key, value) => { if (!failed && key === `fuzzy-stock/slot-${slot}`) { failed = true; throw new Error('架空の書込み失敗'); } return write(key, value); };
  const result = core.commit(flow.store, current, request.op, request.units);
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  flow.store.setItem = write;
  flow.reload();
  assert.equal(flow.number(), 10);
  flow.persist({ ledger, supply: current.supply }, 'op2', '使用', { value: '3' });
  assert.equal(flow.number(), 7);
  assert.equal(flow.snapshot.ledger.history.filter(event => event.kind === 'use').length, 1);
});

test('lost save response followed by retry never consumes twice', () => {
  const flow = harness();
  flow.register('10');
  const current = flow.snapshot;
  const ledger = use(current.ledger, meta('op2', 2), 'L', 'counted', 3, '架空の練習作業');
  const request = flow.prepared({ ledger, supply: current.supply }, 'op2', '使用', { value: '3' });
  core.faults.loseResponseAt = 1;
  let result;
  try { result = core.commit(flow.store, current, request.op, request.units); }
  finally { core.faults.loseResponseAt = null; }
  assert.equal(result.kind, 'unknown');
  const loaded = core.load(flow.store);
  assert.equal(loaded.kind, 'ok');
  assert.ok(loaded.pending);
  const retried = core.retry(flow.store, loaded.snapshot, loaded.pending, actor, recordedAt);
  assert.equal(retried.kind, 'recovered', JSON.stringify(retried));
  flow.reload();
  assert.equal(flow.number(), 7);
  assert.equal(flow.snapshot.ledger.history.filter(event => event.kind === 'use').length, 1);
  flow.backup();
});

test('a stale core snapshot cannot overwrite newly saved consumption', () => {
  const flow = harness();
  flow.register('10');
  const current = flow.snapshot;
  const ledger = use(current.ledger, meta('op3', 3), 'L', 'counted', 1, '架空の古い入力');
  const stale = flow.prepared({ ledger, supply: current.supply }, 'op3', '使用', { value: '1' });
  flow.consume('3');
  const before = [...flow.store.data];
  assert.equal(core.commit(flow.store, current, stale.op, stale.units).kind, 'conflict');
  assert.deepEqual([...flow.store.data], before);
  assert.equal(flow.number(), 7);
});

test('corrupt or precision-invalid backups are rejected without replacing saved stock', () => {
  const flow = harness();
  flow.register('7');
  const before = [...flow.store.data];
  const { encoded } = flow.backup();
  const corrupt = new TextDecoder().decode(encoded).replace('fuzzy-stock-system 復元用', '変更された 復元用');
  // The notice is descriptive. Corrupt the checksummed snapshot itself.
  const envelope = JSON.parse(corrupt);
  envelope.snapshot = envelope.snapshot.replace('架空共通消耗品D', '架空の別名');
  assert.equal(readBackup(new TextEncoder().encode(JSON.stringify(envelope))).kind, 'unreadable');
  const lot = flow.snapshot.ledger.lots.L;
  const invalid = { ...flow.snapshot, ledger: { ...flow.snapshot.ledger, lots: { ...flow.snapshot.ledger.lots, L: { ...lot, quantity: { ...lot.quantity, numeric: { ...lot.quantity.numeric, value: 0.1 } } } } } };
  assert.equal(readBackup(new TextEncoder().encode(backupTextOf(invalid, recordedAt))).kind, 'unreadable');
  assert.throws(() => core.replace(flow.store, flow.snapshot, invalid));
  assert.deepEqual([...flow.store.data], before);
  assert.equal(flow.number(), 7);
});

test('legacy v10 data remains readable and roundtrips without inventing consumable settings', () => {
  const fixture = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/consumables-v10/partial.json'), 'utf8'));
  for (const raw of [fixture.initial, fixture.complete]) {
    const loaded = core.parse(raw);
    assert.ok(Object.values(loaded.ledger.masters.items).every(item => item.consumable === null));
    assert.deepEqual(core.parse(core.serialize(loaded)), loaded);
  }
});
