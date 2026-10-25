import { legacyEventLabels } from '../fixtures/history-labels.ts';
import { describe, expect, test } from 'vitest';
import { practiceLedger, merge, recordStop, recount, register, resolveIssue, use, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import type { Basis } from '../../src/domain/quantity.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { seedLedger, seedScn02 } from '../../src/ui/seed.ts';
import { commit, fingerprintOf, initial, load, parse, sameSnapshot, serialize, type Pending, type Snapshot, type StoreLike } from '../../src/ui/storage.ts';

class MemoryStore implements StoreLike {
  readonly data = new Map<string, string>();
  readonly writes: string[] = [];
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.writes.push(key); this.data.set(key, value); }
  removeItem(key: string): void { this.writes.push(key); this.data.delete(key); }
}

const lot = (id: string) => ({ id, item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' } as const, location: 'S1' });
// 過去時点の入力として包含の回答を求められないよう、操作ごとに時刻を進める。
const meta = (n: number): Meta => {
  const minutes = 8 * 60 + n;
  const hh = String(Math.floor(minutes / 60) % 24).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  const day = String(1 + Math.floor(minutes / 1440)).padStart(2, '0');
  return { eventId: `op${n}`, occurredAt: `2026-11-${day}T${hh}:${mm}:00+09:00`, recordedAt: '2026-10-07T09:00:00+09:00', actor: '架空担当A' };
};

function uses(basis: Basis, n: number): Ledger {
  let ledger = register(practiceLedger, meta(1), lot('X'), basis, basis === 'unknown' ? null : 100000);
  for (let i = 0; i < n; i++) ledger = use(ledger, meta(i + 2), 'X', 'counted', 1, '架空作業');
  return ledger;
}

function mergesOfUnknown(n: number): Ledger {
  let ledger = register(practiceLedger, meta(1), lot('X'), 'counted', 100);
  for (let i = 0; i < n; i++) {
    ledger = register(ledger, meta(2 * i + 2), lot(`Y${i}`), 'unknown', null);
    ledger = merge(ledger, meta(2 * i + 3), `Y${i}`, 'X');
  }
  return ledger;
}

// 合流は新しい側の並びの後ろに古い側の並びをつなぐので、古い保管単位を新しい保管単位へ合流させ続けると、先頭の共有だけでは足りない。
function mergesIntoNew(basis: Basis, n: number): Ledger {
  let ledger = register(practiceLedger, meta(1), lot('Z0'), basis, basis === 'unknown' ? null : 100000);
  let k = 2;
  for (let i = 1; i <= n; i++) {
    ledger = use(ledger, meta(k++), `Z${i - 1}`, 'counted', 1, '架空作業');
    ledger = register(ledger, meta(k++), lot(`Z${i}`), basis, basis === 'unknown' ? null : 1);
    ledger = merge(ledger, meta(k++), `Z${i - 1}`, `Z${i}`);
  }
  return ledger;
}

// 適用しない数え直しの差異は、保管単位の並びを符号を反転して後ろに持つ。先頭が毎回新しい観測なので、後ろの部分を共有できないと二乗になる。
function unappliedRecounts(n: number): Ledger {
  let ledger = register(practiceLedger, meta(1), lot('X'), 'unknown', null);
  let k = 2;
  for (let i = 0; i < n; i++) {
    ledger = use(ledger, meta(k + 10), 'X', 'counted', 1, '架空作業');
    ledger = recount(ledger, { ...meta(k + 5), eventId: `op${k + 1}` }, 'X', 500, { kind: 'unknown' }, 'notIncluded');
    const issue = Object.values(ledger.issues).find(found => found.resolution === null);
    if (issue === undefined) throw new Error('確認事項が必要');
    ledger = resolveIssue(ledger, { ...meta(k + 11), eventId: `op${k + 2}` }, issue.id, 'close');
    k += 12;
  }
  return ledger;
}

const workloads: [string, (n: number) => Ledger][] = [
  ['数えたの保管単位への使用', n => uses('counted', n)],
  ['表示の数（ラベル・パッケージ）の保管単位への使用', n => uses('label', n)],
  ['だいたいの保管単位への使用', n => uses('approximate', n)],
  ['数が不明の保管単位への使用', n => uses('unknown', n)],
  ['数が不明の保管単位の合流', n => mergesOfUnknown(n)],
  ['古い保管単位を新しい保管単位へ合流させ続ける操作', n => mergesIntoNew('counted', n / 2)],
  ['数が不明の古い保管単位を新しい保管単位へ合流させ続ける操作', n => mergesIntoNew('unknown', n / 2)],
  ['数が不明の保管単位への、含まれていない数え直しの繰り返し', n => unappliedRecounts(n / 2)],
];

const lengthOf = (ledger: Ledger) => serialize(initial(ledger, emptySupply)).length;

describe('F1-0 要件1: 写しの大きさ', () => {
  test('版1の書き方では、同じ保管単位への使用を2倍にすると写しが3倍を超える（試験が二乗を検出できる）', () => {
    const v1 = (ledger: Ledger) => JSON.stringify(initial(ledger, emptySupply)).length;
    expect(v1(uses('counted', 200)) / v1(uses('counted', 100))).toBeGreaterThan(3);
  });

  for (const [name, build] of workloads) {
    test(`${name}を2倍にしても、写しの文字数は2.5倍以下`, () => {
      expect(lengthOf(build(200)) / lengthOf(build(100))).toBeLessThanOrEqual(2.5);
    });
  }

  test('保存中の操作（pending）も同じ表現で書く', () => {
    const store = new MemoryStore();
    const current = initial(uses('counted', 200), emptySupply);
    store.data.set('fuzzy-stock/head', 'A');
    store.data.set('fuzzy-stock/slot-A', serialize(current));
    // 見出しを書いた後の応答を失わせ、pendingを残す。
    const lossy: StoreLike = { getItem: k => store.getItem(k), removeItem: k => store.removeItem(k),
      setItem: (k, v) => { store.setItem(k, v); if (k === 'fuzzy-stock/head') throw new Error('架空の応答喪失'); } };
    const next = use(current.ledger, meta(900), 'X', 'counted', 1, '架空作業');
    const result = commit(lossy, current, operation(), [{ conflictReviews: [], ledger: next, supply: current.supply, targets: ['保管単位X'] }]);
    expect(result.kind).toBe('unknown');
    const text = store.data.get('fuzzy-stock/pending') ?? '';
    expect(text).toContain('"quantities"');
    expect(text.length).toBeLessThan(serialize(current).length * 1.5);
  });
});

function operation(): Omit<Pending, 'units' | 'progress' | 'unknownSince' | 'baseRevision'> {
  const values = { value: '1' };
  return { opId: 'op900', opLabel: '使用', values, fingerprint: fingerprintOf('使用', values), actor: '架空担当A', startedAt: '2026-10-07T09:00:00+09:00', savingSince: '2026-10-07T09:00:00+09:00' };
}

describe('F1-0 要件6: 確定の中の検査', () => {
  test('JSONで表せない数値を持つ保存中の操作は、検査で拒否する', () => {
    const store = new MemoryStore();
    const current = initial(uses('counted', 3), emptySupply);
    store.data.set('fuzzy-stock/head', 'A');
    store.data.set('fuzzy-stock/slot-A', serialize(current));
    const stopped = recordStop(use(current.ledger, meta(900), 'X', 'counted', 1, '架空作業'), meta(901), { process: '架空工程', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, reason: '架空の停止', shortage: null, affected: null });
    const broken = { ...stopped, stops: Object.fromEntries(Object.entries(stopped.stops).map(([id, stop]) => [id, { ...stop, affected: Number.NaN }])) };
    const result = commit(store, current, operation(), [{ conflictReviews: [], ledger: broken, supply: current.supply, targets: ['保管単位X'] }]);
    expect(result.kind).toBe('failed');
    expect(store.data.get('fuzzy-stock/slot-A')).toBe(serialize(current));
  });

  test('数量の表の中のJSONで表せない数値も、保存で拒否する', () => {
    const current = initial(uses('unknown', 1), emptySupply);
    const lot = current.ledger.lots.X;
    if (lot === undefined) throw new Error('保管単位Xが必要');
    // 型では表せない値なので、JSONで作ってから書き換える。
    const observation = JSON.parse('{"id":"op1","basis":"unknown","value":null}');
    observation.value = Number.NaN;
    const broken = { ...current, ledger: { ...current.ledger, lots: { X: { ...lot, quantity: { kind: 'unknown' as const, before: null, terms: [{ sign: 1 as const, observation }] } } } } };
    expect(() => serialize(broken)).toThrow('JSONで表せない数値');
  });
});

describe('F1-0 要件2: 往復で失わない', () => {
  const cases: [string, () => Snapshot][] = [
    ...workloads.map(([name, build]): [string, () => Snapshot] => [name, () => initial(build(30), emptySupply)]),
    ['固定の架空データ', () => initial(seedLedger(), emptySupply)],
    ['SCN-02の状態', () => { const { ledger, supply } = seedScn02(); return initial(ledger, supply); }],
  ];
  for (const [name, make] of cases) {
    test(`${name}を読み戻すと同じ写しで、同じ写しは同じ文字列になる`, () => {
      const original = make();
      const decoded = parse(serialize(original));
      expect(sameSnapshot(original, decoded)).toBe(true);
      expect(decoded).toEqual(original);
      expect(serialize(original)).toBe(serialize(original));
      expect(serialize(parse(serialize(decoded)))).toBe(serialize(decoded));
    });
  }

  test('同一性の比較は、数量の奥の観測・不明部分の違いを見落とさない', () => {
    const original = initial(mergesOfUnknown(3), emptySupply);
    const text = JSON.stringify(original);
    const changed = (from: string, to: string) => {
      expect(text).toContain(from);
      return parse(text.replace(from, to));
    };
    expect(sameSnapshot(original, parse(text))).toBe(true);
    expect(sameSnapshot(original, changed('"sign":1', '"sign":-1'))).toBe(false);
    expect(sameSnapshot(original, changed('"id":"op2","basis":"unknown"', '"id":"op2x","basis":"unknown"'))).toBe(false);
    expect(sameSnapshot(original, changed('"unknownParts":[', '"unknownParts":[{"kind":"unknown","before":null,"terms":[]},'))).toBe(false);
  });

  test('読み戻した写しから操作を続けても往復で同じ', () => {
    const decoded = parse(serialize(initial(uses('unknown', 20), emptySupply)));
    const next = initial(use(decoded.ledger, meta(500), 'X', 'counted', 1, '架空作業'), emptySupply);
    expect(parse(serialize(next))).toEqual(next);
  });
});

describe('F1-0 要件3: 版1からの移行', () => {
  const v1Text = (snapshot: Snapshot) => JSON.stringify({ ...snapshot, version: 1 }, (key, value: unknown) => key === 'itemLabels' || key === 'unitSteps' || key === 'conflictReviews' || key === 'receiptTemplates' ? undefined : value);

  test('版1の写しは当時表示不明を補い、業務内容を保って今の版（9）へ読む', () => {
    const original = initial(uses('unknown', 10), emptySupply);
    const decoded = parse(v1Text(original));
    expect(decoded.version).toBe(10);
    expect(decoded).toEqual({ ...original, ledger: { ...original.ledger, history: original.ledger.history.map(e => ({ ...e, ...legacyEventLabels })) } });
  });

  test('版1の写しを読んだだけでは保存先を書かず、次の確定は今の版（9）で書く', () => {
    const store = new MemoryStore();
    const original = initial(uses('counted', 10), emptySupply);
    store.data.set('fuzzy-stock/head', 'A');
    store.data.set('fuzzy-stock/slot-A', v1Text(original));
    const loaded = load(store);
    if (loaded.kind !== 'ok') throw new Error(`読み込めない: ${loaded.kind}`);
    expect(store.writes).toEqual([]);
    const next = use(loaded.snapshot.ledger, meta(900), 'X', 'counted', 1, '架空作業');
    const result = commit(store, loaded.snapshot, operation(), [{ conflictReviews: [], ledger: next, supply: loaded.snapshot.supply, targets: ['保管単位X'] }]);
    expect(result.kind).toBe('saved');
    const written = store.data.get('fuzzy-stock/slot-B') ?? '';
    expect(JSON.parse(written)).toMatchObject({ version: 10, quantities: expect.any(Object) });
    expect(store.data.get('fuzzy-stock/slot-A')).toBe(v1Text(original));
  });

  test('版1のpendingを読み込める', () => {
    const store = new MemoryStore();
    const current = initial(uses('counted', 10), emptySupply);
    store.data.set('fuzzy-stock/head', 'A');
    store.data.set('fuzzy-stock/slot-A', v1Text(current));
    const next = use(current.ledger, meta(900), 'X', 'counted', 1, '架空作業');
    const pending: Pending = { ...operation(), progress: 'saving', unknownSince: null, baseRevision: 0, units: [{ conflictReviews: [], ledger: next, supply: current.supply, targets: ['保管単位X'] }] };
    store.data.set('fuzzy-stock/pending', JSON.stringify(pending, (key, value: unknown) => key === 'itemLabels' || key === 'unitSteps' || key === 'conflictReviews' || key === 'receiptTemplates' ? undefined : value));
    const loaded = load(store);
    expect(loaded).toMatchObject({ kind: 'ok', pending: { ...pending, units: pending.units.map(u => ({ ...u, ledger: { ...u.ledger, history: u.ledger.history.map(e => ({ ...e, ...legacyEventLabels })) } })) } });
  });

  test('版1の本文に数量の番号があれば読み込めない', () => {
    const encoded = JSON.parse(serialize(initial(uses('counted', 3), emptySupply)));
    expect(() => parse(JSON.stringify({ ...encoded, version: 1 }))).toThrow('version');
  });
});

describe('F1-0 要件4: 不正な版2の拒否', () => {
  const encoded = () => JSON.parse(serialize(initial(mergesOfUnknown(3), emptySupply)));

  test('表のない番号は読み込めない', () => {
    const { quantities: _, ...body } = encoded();
    expect(() => parse(JSON.stringify(body))).toThrow('quantity');
  });

  test('範囲外の番号は読み込めない', () => {
    const value = encoded();
    value.ledger.lots.X.quantity = 9999;
    expect(() => parse(JSON.stringify(value))).toThrow('quantity');
  });

  test('自分以降の数量を指す項目は読み込めない（循環を作れない）', () => {
    const value = JSON.parse(serialize(initial(uses('unknown', 3), emptySupply)));
    const items: { kind: string; before?: unknown }[] = value.quantities.items;
    const index = items.findIndex(item => item.kind === 'unknown' && item.before !== null);
    value.quantities.items[index].before = index;
    expect(() => parse(JSON.stringify(value))).toThrow('before');
  });

  test('親が自分以降の観測の並びは読み込めない', () => {
    const value = encoded();
    value.quantities.terms[0][0] = 1;
    expect(() => parse(JSON.stringify(value))).toThrow('terms[0][0]: 1未満の番号が必要');
  });

  test('不明部分に数が不明でない数量があれば読み込めない', () => {
    const value = encoded();
    const part: number = value.quantities.parts[0][1];
    value.quantities.items[part] = { kind: 'known', numeric: { value: 1, approximate: false, unconfirmed: 'none' }, computed: false, terms: 0 };
    expect(() => parse(JSON.stringify(value))).toThrow('数が不明の数量が必要');
  });

  test('表の観測の値が不正なら読み込めない', () => {
    const value = encoded();
    value.quantities.terms[0][4] = -1;
    expect(() => parse(JSON.stringify(value))).toThrow('value');
  });

  test('参照されない不明部分の並びの節も検査する', () => {
    const value = encoded();
    value.quantities.parts.push([0, 'x']);
    expect(() => parse(JSON.stringify(value))).toThrow('parts');
    const known = encoded();
    const items: { kind: string }[] = known.quantities.items;
    known.quantities.parts.push([0, items.findIndex(item => item.kind === 'known')]);
    expect(() => parse(JSON.stringify(known))).toThrow('数が不明の数量が必要');
  });

  test('自分以降の並びをつなぐ節は読み込めない', () => {
    const value = JSON.parse(serialize(initial(mergesIntoNew('counted', 3), emptySupply)));
    const nodes: unknown[] = value.quantities.terms;
    const index = nodes.findIndex(node => !Array.isArray(node));
    expect(index).toBeGreaterThanOrEqual(0);
    value.quantities.terms[index].concat[1] = index + 1;
    expect(() => parse(JSON.stringify(value))).toThrow('concat');
  });

  // 保存先が壊れていても、画面ごと落ちずに読み込めないと示せるようにする（要件4）。
  const chain = (nodes: number, items: (k: number) => number[]) => {
    const value = encoded();
    value.quantities.terms = Array.from({ length: nodes }, (_, k) => [k, 1, `架空${k}`, 'counted', 1]);
    value.quantities.parts = [];
    value.quantities.items = items(nodes).map(terms => ({ kind: 'known', numeric: { value: 1, approximate: false, unconfirmed: 'none' }, computed: true, terms }));
    for (const id of Object.keys(value.ledger.lots)) value.ledger.lots[id].quantity = 0;
    value.ledger.history = [];
    return JSON.stringify(value);
  };

  test('長い観測の並びは、参照された並びだけを作る', () => {
    const decoded = parse(chain(40000, n => [n]));
    expect(decoded.ledger.lots.X?.quantity.terms).toHaveLength(40000);
  });

  test('空の並びを倍々につなぐ節は、要素がなくても上限で止める', () => {
    const value = JSON.parse(chain(1, () => [1]));
    value.quantities.terms = [{ concat: [0, 0] }, ...Array.from({ length: 40 }, (_, k) => ({ concat: [k + 1, k + 1] }))];
    value.quantities.items[0].terms = 41;
    expect(() => parse(JSON.stringify(value))).toThrow('大きすぎる');
  });

  test('節と生成要素がそれぞれ上限内でも、合計が上限を超える連結は拒否する', () => {
    const value = JSON.parse(chain(1, () => [1]));
    value.quantities.terms.push(...Array.from({ length: 22 }, (_, k) => ({ concat: [k + 1, k + 1] })));
    value.quantities.items[0].terms = 23;
    // たどる節8,388,607個と生成要素4,194,304個は、合計すると1000万を超える。
    expect(() => parse(JSON.stringify(value))).toThrow('大きすぎる');
  });

  test('節と生成要素の合計が上限内の連結は内容を保って読める', () => {
    const value = JSON.parse(chain(1, () => [1]));
    value.quantities.terms.push(...Array.from({ length: 21 }, (_, k) => ({ concat: [k + 1, k + 1] })));
    value.quantities.items[0].terms = 22;
    const terms = parse(JSON.stringify(value)).ledger.lots.X?.quantity.terms;
    expect(terms).toHaveLength(2097152);
    expect(terms?.every(t => t.sign === 1 && t.observation.id === '架空0' && t.observation.basis === 'counted' && t.observation.value === 1)).toBe(true);
  });

  test('並びの合計が大きすぎる表は、理由つきで読み込めない', () => {
    expect(() => parse(chain(5000, n => Array.from({ length: n }, (_, k) => k + 1)))).toThrow('大きすぎる');
  });

  for (const target of ['slot', 'pending']) {
    for (const copies of [2, 1001]) {
      test(`Issue #12: ${target}で同じ不明部分の並びを${copies}項目が参照すると、配列生成を予算に含める`, () => {
        const store = new MemoryStore();
        const current = initial(register(practiceLedger, meta(1), lot('X'), 'unknown', null), emptySupply);
        const parts = 10000;
        const quantities = {
          terms: [],
          parts: Array.from({ length: parts }, (_, i) => [i, 0]),
          items: [
            { kind: 'unknown', before: null, terms: 0 },
            ...Array.from({ length: copies }, () => ({ kind: 'partlyUnknown', numeric: null, unknownParts: parts, terms: 0 })),
          ],
        };
        // 最後の項目だけを本文から参照する。他の項目を検査する際の生成も予算に含む。
        const ledger = { ...current.ledger, lots: { X: { ...current.ledger.lots.X, quantity: copies } }, history: [] };
        store.data.set('fuzzy-stock/head', 'A');
        store.data.set('fuzzy-stock/slot-A', JSON.stringify(target === 'slot' ? { ...current, ledger, quantities } : current));
        if (target === 'pending') store.data.set('fuzzy-stock/pending', JSON.stringify({
          ...operation(), progress: 'saving', unknownSince: null, baseRevision: 0,
          units: [{ ledger, supply: current.supply, targets: ['X'] }], quantities,
        }, (key, value: unknown) => key === 'itemLabels' || key === 'unitSteps' || key === 'receiptTemplates' ? undefined : value));
        const before = [...store.data];
        const loaded = load(store);
        expect(loaded).toMatchObject(copies === 2
          ? { kind: 'ok' }
          : { kind: 'unreadable', reason: expect.stringContaining('数量の表の並びが大きすぎる') });
        if (copies === 2 && loaded.kind === 'ok') {
          const decoded = target === 'slot' ? loaded.snapshot.ledger : loaded.pending?.units[0]?.ledger;
          expect(decoded?.lots.X?.quantity).toEqual({
            kind: 'partlyUnknown', numeric: null, terms: [],
            unknownParts: Array.from({ length: parts }, () => ({ kind: 'unknown', before: null, terms: [] })),
          });
        }
        expect(store.writes).toEqual([]);
        expect([...store.data]).toEqual(before);
      });
    }
  }

  test('読み込めない版2の写しは、load が理由つきで返し、保存先を書かない', () => {
    const store = new MemoryStore();
    const value = encoded();
    value.ledger.lots.X.quantity = 9999;
    store.data.set('fuzzy-stock/head', 'A');
    store.data.set('fuzzy-stock/slot-A', JSON.stringify(value));
    expect(load(store)).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('quantity') });
    expect(store.writes).toEqual([]);
  });
});
