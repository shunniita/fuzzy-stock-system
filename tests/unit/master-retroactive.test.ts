import { describe, expect, test } from 'vitest';
import { adoptProvisional, changeMasters, ConfirmationRequired, correctOccurredAt, practiceLedger, handOver, identifyProvisional, merge, move, recount, split, use, voidRecord, perBoxOfLot, recordProvisional, register, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { stockOf } from '../../src/domain/packaging.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { initial, parse, serialize } from '../../src/ui/storage.ts';

const day = (time: string): string => `2026-10-09T${time}:00+09:00`;
const meta = (eventId: string, occurred: string | null, recorded = '12:00'): Meta =>
  ({ eventId, occurredAt: occurred === null ? null : day(occurred), recordedAt: day(recorded), actor: '架空担当A' });
const lotOf = (id: string, item: string, unit: string, location = 'S1') => ({ id, item, unit, project: { kind: 'common' } as const, location });

describe('適用時点を過去にさかのぼる変更は、記録済みの前提を崩さない', () => {
  test('1箱あたりの数: 統合に関わった箱の1箱あたりの数が変わる変更は受け付けない', () => {
    let l: Ledger = register(practiceLedger, meta('ra', '09:00'), lotOf('S-a', 'S', '箱'), 'counted', 2);
    l = register(l, meta('rb', '10:30'), lotOf('S-b', 'S', '箱'), 'counted', 1);
    l = merge(l, meta('mg', '11:00'), 'S-b', 'S-a');
    const before = stockOf(l, emptySupply, 'S', '本').pieces;
    expect(() => changeMasters(l, meta('pb', '10:00'), { action: 'perBox', id: 'S', value: 800, reason: '仕入先の包装変更' })).toThrow('1箱あたりの数を変えると、統合に関わった箱');
    expect(stockOf(l, emptySupply, 'S', '本').pieces).toEqual(before);
  });

  test('1箱あたりの数: 統合に関わっていない箱だけが変わる変更は受け付ける', () => {
    let l: Ledger = register(practiceLedger, meta('ra', '09:00'), lotOf('S-a', 'S', '箱'), 'counted', 2);
    l = register(l, meta('rb', '10:30'), lotOf('S-b', 'S', '箱'), 'counted', 1);
    l = changeMasters(l, meta('pb', '10:00'), { action: 'perBox', id: 'S', value: 800, reason: '仕入先の包装変更' });
    expect(perBoxOfLot(l, l.lots['S-b']!)).toBe(800);
  });

  test('記録の対象: 適用時点以後にその場所へ置いた記録があれば外へ変えない', () => {
    let l: Ledger = register(practiceLedger, meta('r1', '08:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = move(l, meta('mv1', '10:30'), 'X-1', 'O');
    l = move(l, meta('mv2', '11:00'), 'X-1', 'S1');
    expect(() => changeMasters(l, meta('sc', '10:00'), { action: 'scope', id: 'O', inScope: false, reason: '他部署へ移管' })).toThrow('mv1');
  });

  test('記録の対象: 置いた記録がすべて適用時点より前なら外へ変えられる', () => {
    let l: Ledger = register(practiceLedger, meta('r1', '08:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = move(l, meta('mv1', '09:30'), 'X-1', 'O');
    l = move(l, meta('mv2', '09:45'), 'X-1', 'S1');
    expect(changeMasters(l, meta('sc', '10:00'), { action: 'scope', id: 'O', inScope: false, reason: '他部署へ移管' }).masters.locations.O?.scope).toHaveLength(2);
  });
});


describe('品番・コードも名称もない案件・用途を作らない', () => {
  test('名称のない案件・用途が付替えの相手なら、確認の前に断る。名称を付ければ付け替えられる', () => {
    const l = changeMasters(practiceLedger, meta('c1', '09:00'), { action: 'register', master: { type: 'case', code: 'C-9', name: null, source: null } });
    const swap = { action: 'code', type: 'case', id: 'A-001', code: 'C-9', reason: '入れ違い' } as const;
    expect(() => changeMasters(l, meta('c2', '09:10'), swap)).toThrow('名称');
    expect(() => changeMasters(l, meta('c2', '09:10'), swap, true)).toThrow('名称');
    const named = changeMasters(l, meta('c3', '09:05'), { action: 'rename', type: 'case', id: 'C-9', name: '架空案件・用途C', reason: '名称を付ける' });
    expect(changeMasters(named, meta('c4', '09:10'), swap, true).masters.cases['C-9']).toMatchObject({ code: null, name: '架空案件・用途C' });
  });
});

describe('仮の記録を新しい保管単位にしたあとの実際の日時の訂正', () => {
  const found = { direction: 'found', item: null, location: 'T', basis: 'counted', value: 3, note: '品目の分からない箱（架空）' } as const;

  test('仮の記録の日時は訂正せず、登録の記録の日時を訂正する', () => {
    let l: Ledger = recordProvisional(practiceLedger, meta('p1', '09:00'), found);
    l = adoptProvisional(l, meta('a1', '10:00'), 'p1', { id: 'S-found', item: 'S', unit: '箱', project: { kind: 'common' }, location: 'T' });
    expect(() => correctOccurredAt(l, meta('t1', '11:00'), 'p1', day('08:30'))).toThrow('a1');
    expect(correctOccurredAt(l, meta('t2', '11:00'), 'a1', day('08:30')).history.at(-1)).toMatchObject({ kind: 'correctTime', targetEventId: 'a1' });
  });

  test('登録されなかった仮の記録は、これまでどおり訂正できる', () => {
    const l = recordProvisional(practiceLedger, meta('p1', '09:00'), found);
    expect(correctOccurredAt(l, meta('t1', '11:00'), 'p1', day('08:30')).history.at(-1)).toMatchObject({ kind: 'correctTime' });
  });
});

describe('利用停止中の担当者の記録', () => {
  test('利用停止中の担当者の名前では、新しい記録を作らない。ほかの担当者が再開すれば作れる', () => {
    const off = changeMasters(practiceLedger, meta('d1', '09:00'), { action: 'deactivate', type: 'actor', id: '架空担当B', reason: '異動' });
    const lot = { id: 'X-1', item: 'X', unit: '個', project: { kind: 'common' } as const, location: 'S1' };
    expect(() => register(off, { ...meta('r1', '09:10'), actor: '架空担当B' }, lot, 'counted', 1)).toThrow('架空担当B');
    const on = changeMasters(off, meta('d2', '09:20'), { action: 'reactivate', type: 'actor', id: '架空担当B', reason: '復帰' });
    expect(register(on, { ...meta('r1', '09:30'), actor: '架空担当B' }, lot, 'counted', 1).lots['X-1']).toBeDefined();
  });
});

describe('担当者の利用停止で、記録できる人がいなくならない', () => {
  test('操作している担当者自身は止められない。ほかの担当者なら止められる', () => {
    expect(() => changeMasters(practiceLedger, meta('d1', '09:00'), { action: 'deactivate', type: 'actor', id: '架空担当A', reason: '異動' })).toThrow('操作している担当者');
    const off = changeMasters(practiceLedger, meta('d2', '09:00'), { action: 'deactivate', type: 'actor', id: '架空担当B', reason: '異動' });
    expect(off.masters.actors['架空担当B']?.active).toBe(false);
  });
});

describe('記録の対象を外へ変えるとき、適用時点以後にそこへあった物を見落とさない', () => {
  test('適用時点より後に別の場所へ移した保管単位が、適用時点にはその場所にあった場合は外へ変えない', () => {
    let l: Ledger = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = move(l, meta('mv1', '12:00'), 'X-1', 'S2');
    expect(() => changeMasters(l, meta('sc', '10:00'), { action: 'scope', id: 'S1', inScope: false, reason: '他部署へ移管' })).toThrow('mv1');
  });

  test('適用時点より前に別の場所へ移していれば外へ変えられる', () => {
    let l: Ledger = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = move(l, meta('mv1', '09:30'), 'X-1', 'S2');
    expect(changeMasters(l, meta('sc', '10:00'), { action: 'scope', id: 'S1', inScope: false, reason: '他部署へ移管' }).masters.locations.S1?.scope).toHaveLength(2);
  });
});

describe('仮の決定: 仮の記録の対応付けの品目と、実際の日時が不明な仮の記録の判断時点', () => {
  const foundS = { direction: 'found', item: 'S', location: 'T', basis: 'counted', value: 3, note: '箱（架空）' } as const;
  const foundT = foundS;
  const lot = { id: 'S-found', item: 'S', unit: '箱', project: { kind: 'common' } as const, location: 'T' };

  test('仮の記録の品目が分かっているとき、違う品目への対応付けと登録は確認を求める。確認すれば進められ、同じ品目では求めない', () => {
    let l: Ledger = register(practiceLedger, meta('r1', '08:00'), lotOf('Q-1', 'Q', '個', 'S1'), 'counted', 5);
    l = recordProvisional(l, meta('p1', '09:00'), foundS);
    const asked = (run: () => unknown): ConfirmationRequired => {
      try { run(); } catch (error) { if (error instanceof ConfirmationRequired) return error; throw error; }
      throw new Error('確認を求めなかった');
    };
    expect(asked(() => identifyProvisional(l, meta('i1', '10:00'), 'p1', 'Q-1', '同じ箱')).message).toContain('仮の記録の品目（S）と違う品目（Q）');
    expect(identifyProvisional(l, meta('i1', '10:00'), 'p1', 'Q-1', '同じ箱', true).issues['p1']?.resolution?.outcome).toBe('close');
    const other = { ...lot, item: 'Q', unit: '個' };
    expect(asked(() => adoptProvisional(l, meta('a1', '10:00'), 'p1', other)).message).toContain('仮の記録の品目（S）と違う品目（Q）');
    expect(adoptProvisional(l, meta('a1', '10:00'), 'p1', other, true).lots['S-found']).toBeDefined();
    expect(adoptProvisional(l, meta('a1', '10:00'), 'p1', lot).lots['S-found']).toBeDefined();
  });

  test('実際の日時が不明な仮の記録を登録すると、1箱あたりの数は仮の記録を記録した時点のもので換算する', () => {
    let l: Ledger = recordProvisional(practiceLedger, meta('p1', null, '09:00'), foundS);
    l = changeMasters(l, meta('pb', '10:00', '10:00'), { action: 'perBox', id: 'S', value: 800, reason: '仕入先の包装変更' });
    l = adoptProvisional(l, meta('a1', null, '11:00'), 'p1', lot);
    expect(stockOf(l, emptySupply, 'S', '本').pieces).toMatchObject({ kind: 'known', numeric: { value: 3000 } });
  });

  test('AT-35・要件7.9: 仮の記録だけなら残せるが、登録で対象外だった期間に物を残す前提を作らない', () => {
    // Tは10時に外れ、11時に戻った。仮の記録は9時、登録は11時30分の記録。
    let l: Ledger = recordProvisional(practiceLedger, meta('p1', null, '09:00'), foundT);
    l = changeMasters(l, meta('sc1', '10:00', '10:00'), { action: 'scope', id: 'T', inScope: false, reason: '撤去' });
    expect(() => adoptProvisional(l, meta('a0', null, '10:30'), 'p1', lot)).toThrow('記録の対象外になったあとも物が残る');
    l = changeMasters(l, meta('sc2', '11:00', '11:00'), { action: 'scope', id: 'T', inScope: true, reason: '再開' });
    expect(l.issues.p1?.resolution).toBeNull();
    expect(() => adoptProvisional(l, meta('a1', null, '11:30'), 'p1', lot)).toThrow('より後まで物が置かれていた');
  });
});

describe('実際の日時が不明な仮の記録から登録した保管単位の訂正は、仮の記録を記録した時点で判断する', () => {
  const foundT = { direction: 'found', item: 'S', location: 'T', basis: 'counted', value: 3, note: '箱（架空）' } as const;
  const lot = { id: 'S-found', item: 'S', unit: '箱', project: { kind: 'common' } as const, location: 'T' };

  test('登録を不明へ訂正するときは、仮の記録を記録した時点で判断する。外れていた時点の日時へは訂正しない', () => {
    // Tは10時に外れ、11時に戻った。仮の記録は再開後の11時10分。
    let l: Ledger = practiceLedger;
    l = changeMasters(l, meta('sc1', '10:00', '10:00'), { action: 'scope', id: 'T', inScope: false, reason: '撤去' });
    l = changeMasters(l, meta('sc2', '11:00', '11:00'), { action: 'scope', id: 'T', inScope: true, reason: '再開' });
    l = recordProvisional(l, meta('p1', null, '11:10'), foundT);
    l = adoptProvisional(l, meta('a1', null, '11:30'), 'p1', lot);
    expect(() => correctOccurredAt(l, meta('t1', '12:00', '12:00'), 'a1', day('10:30'))).toThrow('記録の対象外');
    expect(correctOccurredAt(l, meta('t2', '12:00', '12:00'), 'a1', null).history.at(-1)).toMatchObject({ kind: 'correctTime', targetEventId: 'a1' });
  });
});

describe('記録の対象を外へ変える検査の境界', () => {
  test('適用時点にちょうど別の場所へ移した物は、その時点では範囲外だったので外へ変えられる。数量0と分かっている物は見ない', () => {
    let l: Ledger = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = move(l, meta('mv1', '10:00'), 'X-1', 'S2');
    expect(changeMasters(l, meta('sc', '10:00'), { action: 'scope', id: 'S1', inScope: false, reason: '他部署へ移管' }).masters.locations.S1?.scope).toHaveLength(2);
    let zero: Ledger = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 0);
    zero = move(zero, meta('mv1', '12:00'), 'X-1', 'S2');
    expect(changeMasters(zero, meta('sc', '10:00'), { action: 'scope', id: 'S1', inScope: false, reason: '他部署へ移管' }).masters.locations.S1?.scope).toHaveLength(2);
  });
});

describe('確認の文は利用停止中の登録情報を示す', () => {
  test('仮の記録から登録するときの確認の文に、利用停止中の場所を示す', () => {
    let l: Ledger = register(practiceLedger, meta('r1', '08:00'), lotOf('S-1', 'S', '箱', 'T'), 'counted', 1);
    l = recordProvisional(l, meta('p1', '09:00'), { direction: 'found', item: 'S', location: 'S1', basis: 'counted', value: 3, note: '箱（架空）' });
    l = changeMasters(l, meta('d1', '09:10'), { action: 'deactivate', type: 'location', id: 'T', reason: '撤去' });
    try { adoptProvisional(l, meta('a1', '10:00'), 'p1', { id: 'S-f', item: 'S', unit: '箱', project: { kind: 'common' }, location: 'S1' }); throw new Error('確認を求めなかった'); }
    catch (error) { expect((error as Error).message).toContain('場所T（利用停止）'); }
  });
});

describe('レビュー指摘の穴を埋める試験', () => {
  const foundT = { direction: 'found', item: 'S', location: 'T', basis: 'counted', value: 3, note: '箱（架空）' } as const;
  const asked = (run: () => unknown): ConfirmationRequired | null => {
    try { run(); } catch (error) { if (error instanceof ConfirmationRequired) return error; throw error; }
    return null;
  };

  test('記録の対象を外す検査は、不明の時点の仮の記録から登録した物を、仮の記録を記録した時点に置かれたものとして扱う', () => {
    let l: Ledger = recordProvisional(practiceLedger, meta('p1', null, '09:00'), foundT);
    l = adoptProvisional(l, meta('a1', null, '11:00'), 'p1', { id: 'S-f', item: 'S', unit: '箱', project: { kind: 'common' }, location: 'T' });
    l = move(l, meta('mv1', '09:30', '12:00'), 'S-f', 'S1');
    expect(changeMasters(l, meta('sc', '10:00', '12:00'), { action: 'scope', id: 'T', inScope: false, reason: '撤去' }).masters.locations.T?.scope).toHaveLength(2);
  });

  test('仮の記録と品目が違うだけで現存する保管単位がなくても確認を求める。同じ品目では求めない', () => {
    const l: Ledger = recordProvisional(practiceLedger, meta('p1', '09:00'), foundT);
    const other = { id: 'P-f', item: 'P', unit: '個', project: { kind: 'common' } as const, location: 'T' };
    expect(asked(() => adoptProvisional(l, meta('a1', '10:00'), 'p1', other))?.message).toContain('仮の記録の品目（S）と違う品目（P）');
    expect(asked(() => adoptProvisional(l, meta('a1', '10:00'), 'p1', { ...other, id: 'S-f', item: 'S', unit: '箱' }))).toBeNull();
    const withS = register(l, meta('r1', '09:10'), lotOf('S-1', 'S', '箱', 'T'), 'counted', 1);
    expect(asked(() => identifyProvisional(withS, meta('i1', '10:00'), 'p1', 'S-1', '同じ箱'))).toBeNull();
  });

  test('品目違いの対応付けは、理由が空なら確認より先に理由を求める', () => {
    let l: Ledger = register(practiceLedger, meta('r1', '08:00'), lotOf('Q-1', 'Q', '個', 'S1'), 'counted', 5);
    l = recordProvisional(l, meta('p1', '09:00'), foundT);
    expect(() => identifyProvisional(l, meta('i1', '10:00'), 'p1', 'Q-1', ' ')).toThrow('理由');
  });
});

describe('記録の対象外の場所に、あとの記録で物を残さない', () => {
  const change = (l: Ledger, id: string, at: string, inScope: boolean) =>
    changeMasters(l, meta(id, at, at), { action: 'scope', id: 'S1', inScope, reason: '他部署へ移管' });

  test('移動の日時の訂正で、外した後まで物が置かれていたことにしない。訂正前は通っていた', () => {
    let l: Ledger = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = move(l, meta('mv1', '09:30'), 'X-1', 'S2');
    l = change(l, 'sc', '10:00', false);
    expect(() => correctOccurredAt(l, meta('t1', '11:00', '11:00'), 'mv1', day('10:30'))).toThrow('適用時点（2026-10-09T10:00:00+09:00）より後まで物が置かれていた');
    expect(correctOccurredAt(l, meta('t2', '11:00', '11:00'), 'mv1', day('09:45')).history.at(-1)).toMatchObject({ kind: 'correctTime' });
  });

  test('使い切った物の使用を取り消して、外れた場所に物を戻さない', () => {
    let l: Ledger = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = use(l, meta('u1', '09:10'), 'X-1', 'counted', 2, '架空作業');
    l = change(l, 'sc', '10:00', false);
    expect(() => voidRecord(l, meta('v1', '10:30'), 'u1', '記録誤り')).toThrow('記録の対象外になったあとも物が残る');
  });

  test('再開した場所なら、外れていた期間の外の記録は受け付ける', () => {
    let l: Ledger = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = move(l, meta('mv1', '09:30'), 'X-1', 'S2');
    l = change(l, 'sc1', '10:00', false);
    l = change(l, 'sc2', '11:00', true);
    expect(move(l, meta('mv2', '11:30'), 'X-1', 'S1').lots['X-1']?.location).toBe('S1');
  });

  test('AT-35・要件7.9: 再開時点や再開後へ出発日時を訂正しても、対象外だった期間の滞在を作らない', () => {
    let l = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = move(l, meta('mv1', '09:30'), 'X-1', 'S2');
    l = change(l, 'sc1', '10:00', false);
    l = change(l, 'sc2', '11:00', true);
    const before = l;
    for (const time of ['11:00', '11:30']) {
      expect(() => correctOccurredAt(l, meta('t1', '12:00'), 'mv1', day(time))).toThrow('より後まで物が置かれていた');
    }
    expect(l).toBe(before);
    const corrected = correctOccurredAt(l, meta('t1', '12:00'), 'mv1', day('10:00'));
    expect(corrected.history.at(-1)).toMatchObject({ kind: 'correctTime', corrected: day('10:00') });
    expect(() => correctOccurredAt(corrected, meta('t2', '12:00'), 'mv1', day('11:30'))).toThrow('より後まで物が置かれていた');
  });

  test('AT-35・要件7.9: 保存から戻しても、数が不明やだいたい・ラベル0を物がない証拠にはしない', () => {
    for (const [basis, value] of [['unknown', null], ['approximate', 0], ['label', 0]] as const) {
      let l = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), basis, value);
      l = move(l, meta('mv1', '09:30'), 'X-1', 'S2');
      l = change(l, 'sc1', '10:00', false);
      l = change(l, 'sc2', '11:00', true);
      const restored = parse(serialize({ ...initial(l, emptySupply), ledger: l }));
      if (restored === null) throw new Error('保存した台帳を復元できない');
      expect(() => correctOccurredAt(restored.ledger, meta('t1', '12:00'), 'mv1', day('11:30'))).toThrow('より後まで物が置かれていた');
    }
  });

  test('AT-35・要件7.9: 対象外期間中に実数0なら、再開後の数え直しと移動を受け付ける', () => {
    let l = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 0);
    l = change(l, 'sc1', '10:00', false);
    l = change(l, 'sc2', '11:00', true);
    l = recount(l, meta('rc1', '11:00'), 'X-1', 2, { kind: 'unknown' });
    l = move(l, meta('mv1', '11:30'), 'X-1', 'S2');
    expect(l.lots['X-1']?.location).toBe('S2');
    l = change(l, 'sc3', '12:00', false);
    l = change(l, 'sc4', '12:30', true);
    expect(l.masters.locations.S1?.scope).toHaveLength(5);
  });

  test('AT-35・要件7.9: 使い切る時点が再開後へ動くと、現在0でも対象外期間の滞在を断る', () => {
    let l = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = use(l, meta('u1', '09:30'), 'X-1', 'counted', 2, '架空作業');
    l = change(l, 'sc1', '10:00', false);
    l = change(l, 'sc2', '11:00', true);
    expect(() => correctOccurredAt(l, meta('t1', '12:00'), 'u1', day('11:30'))).toThrow('より後まで物が置かれていた');
    expect(l.lots['X-1']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 0 } });
  });

  test('AT-35・要件7.9: 後続の使い切りが先の使用に依存するなら、先の使用を再開後へ訂正しても対象外期間を0扱いしない', () => {
    let l = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = use(l, meta('u1', '09:15'), 'X-1', 'counted', 1, '架空作業');
    l = use(l, meta('u2', '09:30'), 'X-1', 'counted', 1, '架空作業');
    l = change(l, 'sc1', '10:00', false);
    l = change(l, 'sc2', '11:00', true);
    expect(() => correctOccurredAt(l, meta('t1', '12:00'), 'u1', day('11:30'))).toThrow('より後まで物が置かれていた');
    expect(l.issues).toEqual({});
    expect(l.lots['X-1']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 0 } });
    const reordered = correctOccurredAt(l, meta('t1', '12:00'), 'u1', day('09:45'));
    expect(reordered.history.at(-1)?.kind).toBe('correctTime');
    expect(correctOccurredAt(l, meta('t1', '12:00'), 'u1', day('09:30')).history.at(-1)?.kind).toBe('correctTime');
    expect(correctOccurredAt(l, meta('t1', '12:00'), 'u1', day('10:00')).history.at(-1)?.kind).toBe('correctTime');
  });

  test('AT-35・要件7.9: 後続の引渡しや分割による親の0も、先の減算の時点に依存する', () => {
    let l = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 3);
    l = handOver(l, meta('h1', '09:15'), 'X-1', 'counted', 1, '架空の移管先');
    const handed = handOver(l, meta('h2', '09:30'), 'X-1', 'counted', 2, '架空の移管先');
    let divided = split(l, meta('sp1', '09:30'), 'X-1', 'X-child', 'counted', 2);
    divided = move(divided, meta('mv1', '09:45'), 'X-child', 'S2');
    for (let branch of [handed, divided]) {
      branch = change(branch, 'sc1', '10:00', false);
      branch = change(branch, 'sc2', '11:00', true);
      const restored = parse(serialize(initial(branch, emptySupply)));
      if (restored === null) throw new Error('保存した台帳を復元できない');
      expect(() => correctOccurredAt(restored.ledger, meta('t1', '12:00'), 'h1', day('11:30'))).toThrow('より後まで物が置かれていた');
      expect(correctOccurredAt(restored.ledger, meta('t1', '12:00'), 'h1', day('09:45')).lots['X-1']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 0 } });
    }
  });

  test('AT-35・要件7.9: 独立した後続の実数0を、古い使用の数量の写しで復活させない', () => {
    let l = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = use(l, meta('u1', '09:15'), 'X-1', 'counted', 1, '架空作業');
    l = recount(l, meta('rc1', '09:30'), 'X-1', 0, { kind: 'unknown' });
    l = change(l, 'sc1', '10:00', false);
    l = change(l, 'sc2', '11:00', true);
    l = correctOccurredAt(l, meta('t1', '12:00'), 'u1', day('11:30'));
    expect(l.lots['X-1']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 0 } });
    expect(l.issues['rc1@time']?.reason).toBe('timeCorrected');
    expect(change(l, 'sc3', '12:00', false).history.at(-1)?.kind).toBe('master');
  });

  test('AT-35・要件7.9: 統合した数量の0も、反映済みの使用がすべて発生してから証拠に使う', () => {
    let l = register(practiceLedger, meta('ra', '09:00'), lotOf('X-a', 'X', '個', 'S1'), 'counted', 1);
    l = register(l, meta('rb', '09:00'), lotOf('X-b', 'X', '個', 'S1'), 'counted', 1);
    l = merge(l, meta('mg', '09:10'), 'X-b', 'X-a');
    l = use(l, meta('u1', '09:15'), 'X-a', 'counted', 1, '架空作業');
    l = use(l, meta('u2', '09:30'), 'X-a', 'counted', 1, '架空作業');
    l = change(l, 'sc1', '10:00', false);
    l = change(l, 'sc2', '11:00', true);
    expect(() => correctOccurredAt(l, meta('t1', '12:00'), 'u1', day('11:30'))).toThrow('より後まで物が置かれていた');
    expect(correctOccurredAt(l, meta('t1', '12:00'), 'u1', day('09:45')).lots['X-a']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 0 } });
    expect(l.lots['X-b']?.mergedInto).toBe('X-a');
  });

  test('AT-35・要件7.9: 使用の間で統合しても、数量の根拠待ちを物がない証拠にしない', () => {
    let l = register(practiceLedger, meta('ra', '09:00'), lotOf('X-a', 'X', '個', 'S1'), 'counted', 2);
    l = use(l, meta('u1', '09:15'), 'X-a', 'counted', 1, '架空作業');
    l = register(l, meta('rb', '09:00'), lotOf('X-b', 'X', '個', 'S1'), 'counted', 0);
    l = merge(l, meta('mg', '09:30'), 'X-a', 'X-b');
    l = use(l, meta('u2', '09:45'), 'X-b', 'counted', 1, '架空作業');
    l = change(l, 'sc1', '10:00', false);
    l = change(l, 'sc2', '11:00', true);
    const restored = parse(serialize(initial(l, emptySupply)));
    if (restored === null) throw new Error('保存した台帳を復元できない');
    for (const branch of [l, restored.ledger]) {
      expect(() => correctOccurredAt(branch, meta('t1', '12:00'), 'u1', day('11:30'))).toThrow('より後まで物が置かれていた');
      expect(correctOccurredAt(branch, meta('t1', '12:00'), 'u1', day('09:50')).history.at(-1)?.kind).toBe('correctTime');
      expect(branch.lots['X-b']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 0 } });
      expect(branch.lots['X-a']?.mergedInto).toBe('X-b');
      expect(branch.issues).toEqual({});
    }
  });

  test('AT-35・要件7.9: 統合先を独立して実数0と確認したら、元の使用の訂正で物を復活させない', () => {
    let l = register(practiceLedger, meta('ra', '09:00'), lotOf('X-a', 'X', '個', 'S1'), 'counted', 2);
    l = use(l, meta('u1', '09:15'), 'X-a', 'counted', 1, '架空作業');
    l = register(l, meta('rb', '09:00'), lotOf('X-b', 'X', '個', 'S1'), 'counted', 0);
    l = merge(l, meta('mg', '09:30'), 'X-a', 'X-b');
    l = recount(l, meta('rc1', '09:45'), 'X-b', 0, { kind: 'unknown' });
    l = change(l, 'sc1', '10:00', false);
    l = change(l, 'sc2', '11:00', true);
    const after = correctOccurredAt(l, meta('t1', '12:00'), 'u1', day('11:30'));
    expect(after.lots['X-b']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 0 } });
    expect(after.lots['X-a']?.mergedInto).toBe('X-b');
    expect(after.history.at(-1)?.kind).toBe('correctTime');
  });

  test('AT-35・要件7.9: 再開後に到着した物は通し、2回目の対象外期間をまたぐ訂正は断る', () => {
    let l = change(practiceLedger, 'sc1', '10:00', false);
    l = change(l, 'sc2', '11:00', true);
    l = register(l, meta('r1', '11:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    l = move(l, meta('mv1', '11:30'), 'X-1', 'S2');
    l = change(l, 'sc3', '12:00', false);
    l = change(l, 'sc4', '12:30', true);
    expect(() => correctOccurredAt(l, meta('t1', '13:00', '13:00'), 'mv1', day('12:30'))).toThrow('適用時点（2026-10-09T12:00:00+09:00）');
  });
});

describe('記録の対象外の場所の検査は、遅れて入力した記録の時点の場所で判断する', () => {
  const change = (l: Ledger, id: string, at: string, inScope: boolean) =>
    changeMasters(l, meta(id, at, at), { action: 'scope', id: 'S1', inScope, reason: '他部署へ移管' });
  // X-1はS2にあり、S1は10時に外れて11時に戻り、11時30分にX-1をS1へ移した。
  const reopened = (): Ledger => {
    let l: Ledger = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S2'), 'counted', 5);
    l = change(l, 'sc1', '10:00', false);
    l = change(l, 'sc2', '11:00', true);
    return move(l, meta('mv1', '11:30'), 'X-1', 'S1');
  };

  test('外れていた期間の日時の使用を、再開後にその場所へ移した物へ遅れて入力しても断られない', () => {
    const l = reopened();
    expect(use(l, meta('u1', '10:30', '12:00'), 'X-1', 'counted', 1, '架空作業', { kind: 'unknown' } as never).history.at(-1)).toMatchObject({ kind: 'use' });
  });

  test('再開後にその場所へ置いた物を、動かす・使う記録は断られない。2回目の外す/戻すも通る', () => {
    let l = reopened();
    l = use(l, meta('u2', '11:40'), 'X-1', 'counted', 1, '架空作業');
    l = move(l, meta('mv2', '11:50'), 'X-1', 'S2');
    l = change(l, 'sc3', '12:00', false);
    l = change(l, 'sc4', '12:30', true);
    expect(l.masters.locations.S1?.scope).toHaveLength(5);
  });

  test('受け付ける前から食い違っていた記録は、無関係な記録を止めない', () => {
    const l: Ledger = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    const stuck: Ledger = { ...l, masters: { ...l.masters, locations: { ...l.masters.locations, S1: { ...l.masters.locations.S1!, scope: [{ from: null, inScope: true }, { from: day('10:00'), inScope: false }] } } } };
    expect(register(stuck, meta('r2', '11:00'), lotOf('P-1', 'P', '個', 'S2'), 'counted', 1).lots['P-1']).toBeDefined();
  });

  test('AT-35・要件7.9: 旧台帳の不整合を悪化させない再開後の移動・名称変更は通し、滞在を延長する訂正は断る', () => {
    const resident = register(practiceLedger, meta('r1', '09:00'), lotOf('X-1', 'X', '個', 'S1'), 'counted', 2);
    const l = move(resident, meta('mv1', '10:30'), 'X-1', 'S2');
    const place = l.masters.locations.S1;
    if (place === undefined) throw new Error('試験の場所S1がない');
    const stuck: Ledger = { ...l, masters: { ...l.masters, locations: { ...l.masters.locations, S1: { ...place, scope: [{ from: null, inScope: true }, { from: day('10:00'), inScope: false }, { from: day('11:00'), inScope: true }] } } } };
    expect(changeMasters(stuck, meta('name', '11:30'), { action: 'rename', type: 'location', id: 'S1', name: '架空棚', reason: '表記訂正' }).history.at(-1)?.kind).toBe('master');
    expect(correctOccurredAt(stuck, meta('t1', '12:00'), 'mv1', day('10:15')).history.at(-1)?.kind).toBe('correctTime');
    expect(() => correctOccurredAt(stuck, meta('t2', '12:00'), 'mv1', day('10:45'))).toThrow('より後まで物が置かれていた');
    const stuckResident: Ledger = { ...resident, masters: stuck.masters };
    expect(move(stuckResident, meta('mv2', '11:30'), 'X-1', 'S2').lots['X-1']?.location).toBe('S2');
  });
});
