import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import { correctOccurredAt, practiceLedger, hold, recount, register, split, type Ledger, type Meta, type Project } from '../../src/domain/ledger.ts';
import { allocateArrival, declareShortage, emptySupply, receiveLot, recordReply, recordRequest, registerNeed, reviseReceipt, type Supply } from '../../src/domain/supply.ts';
import { dateStatusOf, requestSummaryOf, shortageOf, type GroupKey } from '../../src/domain/shortage.ts';
import { dateStatusText, judgementText, requestDateText, requestStateText, shortageLinesText, stateTriadText } from '../../src/ui/supply-format.ts';

const b001: Project & { kind: 'case' } = { kind: 'case', id: 'B-001' };
const key: GroupKey = { project: b001, item: 'P', unit: '個' };

function meta(eventId: string, hour = 9): Meta {
  const at = `2026-10-01T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

const lotOf = (id: string) => ({ id, item: 'P', unit: '個', project: b001, location: 'S1' });
const need = (value: number | null = 100, basis: 'counted' | 'unknown' = 'counted', dueDate: string | null = '2026-10-01'): Supply =>
  registerNeed(emptySupply, fixedMasters, meta('n1', 7), { project: b001, item: 'P', unit: '個', required: { basis, value }, dueDate, source: '架空', revision: '初版' });

// SCN-02の途中（在庫98、不良3、不足5、依頼5）。
function scn(): { ledger: Ledger; supply: Supply } {
  let l: Ledger = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'label', 100);
  l = recount(l, meta('c1', 9), 'L1', 98, { kind: 'unknown' });
  l = split(l, meta('s1', 10), 'L1', 'L1-bad', 'counted', 3);
  l = hold(l, meta('h1', 10), 'L1-bad', 'defective');
  const supply = recordRequest(need(), fixedMasters, meta('q1', 11), { project: b001, item: 'P', unit: '個', quantity: 5, vendor: '架空の仕入先X', requestedOn: '2026-10-01', reply: { kind: 'none' } });
  return { ledger: l, supply };
}

describe('不足・依頼の欄の文言', () => {
  test('2.4: 判定は、帳簿上・数量確認が必要・中身未確認・判定不能（理由）を文字で区別する', () => {
    expect(judgementText({ kind: 'ledger' })).toBe('帳簿上の不足');
    expect(judgementText({ kind: 'confirm', approximate: true, unconfirmed: false })).toBe('数量確認が必要（だいたいの数を含む）');
    expect(judgementText({ kind: 'confirm', approximate: false, unconfirmed: true })).toBe('中身未確認（表示の数（ラベル・パッケージ）を含む）');
    expect(judgementText({ kind: 'confirm', approximate: true, unconfirmed: true })).toBe('数量確認が必要（だいたいの数を含む）・中身未確認（表示の数（ラベル・パッケージ）を含む）');
    expect(judgementText({ kind: 'undecidable', reasons: ['noNeed', 'openIssue'] })).toBe('判定不能：必要な数が未登録・数量に影響する未解決の確認事項がある');
  });

  test('SCN-02の途中: 不足5（数量不足2・不良3）と、在庫98・使用可能95を、別々の数として示す', () => {
    const { ledger, supply } = scn();
    const lines = shortageLinesText(shortageOf(ledger, supply, key), '個');
    expect(lines.join('\n')).toContain('必要な数 100個');
    expect(lines.join('\n')).toContain('在庫（未使用の総数） 98個');
    expect(lines.join('\n')).toContain('使用可能 95個');
    expect(lines.join('\n')).toContain('不足 5個（帳簿上の不足）');
    expect(lines.join('\n')).toMatch(/数量不足 2個.*不良 記録上の数3個|数量不足 2個.*不良 3個/);
  });

  test('2.4: 判定不能のときは不足の値を出さず、理由と、分かる部分（必要な数・在庫・使用可能）を示す', () => {
    const { ledger } = scn();
    const lines = shortageLinesText(shortageOf(ledger, need(null, 'unknown'), key), '個').join('\n');
    expect(lines).toContain('不足 判定不能：必要な数が不明');
    expect(lines).not.toMatch(/不足 \d/);
    expect(lines).toContain('分かる部分');
    expect(lines).toContain('使用可能 95個');
  });

  test('10.3: 予備で賄える数を、予備の根拠つきで示し、不足の数は減らさない。不明なら不明と書く', () => {
    let l: Ledger = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 95);
    l = register(l, meta('r2', 8), lotOf('L2'), 'label', 5);
    l = hold(l, meta('h1', 9), 'L2', 'spare');
    const lines = shortageLinesText(shortageOf(l, need(), key), '個').join('\n');
    expect(lines).toContain('不足 5個');
    expect(lines).toContain('予備 5個・表示の数（ラベル・パッケージ）・中身未確認');
    expect(lines).toContain('予備で賄える数 5個（予備が数えた数ではないので、確定していない）');
    // 数えたの予備なら、注記は付かない。
    let c: Ledger = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 95);
    c = register(c, meta('r2', 8), lotOf('L2'), 'counted', 3);
    c = hold(c, meta('h1', 9), 'L2', 'spare');
    const exact = shortageLinesText(shortageOf(c, need(), key), '個').join('\n');
    expect(exact).toContain('予備で賄える数 3個（予備は使用可能に数えない');
    expect(exact).not.toContain('確定していない');
  });

  test('4.4: 不足・手配対象数・依頼済み・依頼の未着を別々に示す。手配対象数は、不足が不明・過剰割り当てのとき保留と理由を書く（0としない）', () => {
    const { ledger, supply } = scn();
    const text = requestStateText(requestSummaryOf(ledger, supply, key), '個').join('\n');
    expect(text).toContain('手配対象数 0個');
    expect(text).toContain('依頼済み 5個');
    expect(text).toContain('依頼の未着 5個');
    const held = requestStateText(requestSummaryOf(ledger, recordRequest(need(null, 'unknown'), fixedMasters, meta('q1', 11), { project: b001, item: 'P', unit: '個', quantity: 5, vendor: 'X', requestedOn: '2026-10-01', reply: { kind: 'none' } }), key), '個').join('\n');
    expect(held).toContain('手配対象数 保留（不足が不明のため。0ではない）');
  });

  test('確定していない不足（だいたい・表示の数（ラベル・パッケージ））のときは、手配対象数を0としても数としても出さず、保留と理由を書く', () => {
    const ledger = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'approximate', 100);
    const supply = recordRequest(need(), fixedMasters, meta('q1', 11), { project: b001, item: 'P', unit: '個', quantity: 5, vendor: 'X', requestedOn: '2026-10-01', reply: { kind: 'none' } });
    const text = requestStateText(requestSummaryOf(ledger, supply, key), '個').join('\n');
    expect(text).toContain('手配対象数 保留（不足が確定していないため。数量確認が必要・中身未確認）');
    expect(text).toContain('不要の可能性の判定は保留');
    expect(text).not.toContain('不要の可能性がある依頼');
  });

  test('5.4・5.5: 届いた数と、不足の解消に充てた使える数を別に示す。過剰割り当ては、実際に受け取った数と割り当ての合計を示して保留と書く', () => {
    let { ledger, supply } = scn();
    const r = receiveLot(ledger, supply, meta('e1', 12), lotOf('R5'), 'counted', 5);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 12), 'q1', { receiptLotId: 'R5', arrived: 5, good: 3 });
    expect(requestStateText(requestSummaryOf(r.ledger, supply, key), '個').join('\n')).toContain('到着 5個（不足の解消に充てた良品 3個）');
    supply = reviseReceipt(r.ledger, supply, meta('v1', 13), 'R5', 4, '4個だった');
    const text = requestStateText(requestSummaryOf(r.ledger, supply, key), '個').join('\n');
    expect(text).toContain('過剰割り当て：保管単位R5 実際に受け取った数4に対して割り当て5');
    expect(text).toContain('手配対象数 保留（過剰割り当てのため）');
  });

  test('割り当ての日時が受け取りより前になったときは、手配対象数を保留し、直し方を書く', () => {
    let { ledger, supply } = scn();
    const r = receiveLot(ledger, supply, meta('e1', 12), lotOf('R5'), 'counted', 5);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 13), 'q1', { receiptLotId: 'R5', arrived: 5, good: 5 });
    const corrected = correctOccurredAt(r.ledger, meta('t1', 14), 'e1', '2026-10-01T14:00:00+09:00');
    const text = requestStateText(requestSummaryOf(corrected, supply, key), '個').join('\n');
    expect(text).toContain('手配対象数 保留（割り当ての日時が受け取りより前のため）');
    expect(text).toContain('割り当ての日時が受け取りより前：依頼q1の割り当てa1（保管単位R5）');
    expect(text).toContain('受け取りの日時を元に戻すか、割り当ての届いた数を0に訂正する');
  });

  test('4.5: 納期の状態は、納期未回答・到着予定超過・必要日に間に合わないを文字で示す。指摘がなければそう書く', () => {
    const { supply } = scn();
    expect(dateStatusText(dateStatusOf(supply, fixedMasters, 'q1', '2026-10-02'))).toBe('納期未回答');
    const late = recordReply(supply, fixedMasters, meta('q2', 12), 'q1', { kind: 'estimated', date: '2026-10-03' });
    expect(dateStatusText(dateStatusOf(late, fixedMasters, 'q1', '2026-10-02'))).toBe('必要日に間に合わない');
    // 予定日が必要日より前なら間に合う。判定日より前なら到着予定超過（予定日を過ぎても届いていない）。
    const over = recordReply(supply, fixedMasters, meta('q2', 12), 'q1', { kind: 'answered', date: '2026-09-30' });
    expect(dateStatusText(dateStatusOf(over, fixedMasters, 'q1', '2026-10-02'))).toBe('到着予定超過');
    // 必要日が予定日より前なら、予定超過と、必要日に間に合わないが同時に立つ。
    const both = registerNeed(emptySupply, fixedMasters, meta('n1', 7), { project: b001, item: 'P', unit: '個', required: { basis: 'counted', value: 1 }, dueDate: '2026-09-29', source: '架空', revision: '初版' });
    const bothReq = recordRequest(both, fixedMasters, meta('q1', 8), { project: b001, item: 'P', unit: '個', quantity: 1, vendor: 'X', requestedOn: '2026-09-28', reply: { kind: 'answered', date: '2026-09-30' } });
    expect(dateStatusText(dateStatusOf(bothReq, fixedMasters, 'q1', '2026-10-02'))).toBe('到着予定超過・必要日に間に合わない');
    const ok = registerNeed(emptySupply, fixedMasters, meta('n1', 7), { project: b001, item: 'P', unit: '個', required: { basis: 'counted', value: 1 }, dueDate: '2026-12-31', source: '架空', revision: '初版' });
    const fine = recordRequest(ok, fixedMasters, meta('q1', 8), { project: b001, item: 'P', unit: '個', quantity: 1, vendor: 'X', requestedOn: '2026-10-01', reply: { kind: 'answered', date: '2026-10-05' } });
    expect(dateStatusText(dateStatusOf(fine, fixedMasters, 'q1', '2026-10-02'))).toBe('遅れの指摘なし');
  });

  test('7.1: 不足の解消・依頼の未着の解消・作業の再開を、互いから導かず、別々の三つの文として示す', () => {
    const { ledger, supply } = scn();
    const triad = stateTriadText(shortageOf(ledger, supply, key), requestSummaryOf(ledger, supply, key), []);
    expect(triad).toEqual(['不足の解消：未解消（不足5個）', '依頼の未着の解消：未着5個', '作業の再開：未再開の中断なし']);
    const summary = requestSummaryOf(ledger, supply, key);
    const resolved = stateTriadText(shortageOf(ledger, supply, key), { ...summary, effectiveShortage: 0, outstanding: 0 }, [{} as never]);
    expect(resolved).toEqual(['不足の解消：解消（不足0）', '依頼の未着の解消：未着なし', '作業の再開：未再開の中断が1件（再開は別の記録）']);
    expect(stateTriadText(shortageOf(ledger, supply, key), { ...summary, effectiveShortage: null }, [])[0]).toBe('不足の解消：判定不能');
    // AT-07: 不足0でも、だいたい・表示の数（ラベル・パッケージ）に基づくときは、解消と断定せず、確定していないと書く。
    const approx = { ...shortageOf(ledger, supply, key), shortage: 0, judgement: { kind: 'confirm', approximate: true, unconfirmed: false } as const };
    expect(stateTriadText(approx, { ...summary, effectiveShortage: 0, tentative: true }, [])[0]).toBe('不足の解消：不足0に見えるが確定していない（数量確認が必要（だいたいの数を含む））');
    // 不足が正でも、確定していなければ断定しない。
    expect(stateTriadText({ ...approx, shortage: 5 }, { ...summary, effectiveShortage: 5, tentative: true }, [])[0]).toBe('不足の解消：未解消に見えるが確定していない（不足5個。数量確認が必要（だいたいの数を含む））');
    const label = { ...approx, judgement: { kind: 'confirm', approximate: false, unconfirmed: true } as const };
    expect(stateTriadText(label, { ...summary, effectiveShortage: 0, tentative: true }, [])[0]).toBe('不足の解消：不足0に見えるが確定していない（中身未確認（表示の数（ラベル・パッケージ）を含む））');
  });

  test('7.1: 過剰割り当て・割り当てや実際に受け取った数の訂正の日時の食い違いがある間は、不足の解消を断定せず確認待ちと書く', () => {
    const { ledger, supply } = scn();
    const view = shortageOf(ledger, supply, key);
    const base = { ...requestSummaryOf(ledger, supply, key), effectiveShortage: 0 };
    const pending = '不足の解消：確認待ち（過剰割り当て、または割り当て・実際に受け取った数の訂正の日時の食い違いがあるため）';
    expect(stateTriadText(view, { ...base, overAllocated: [{ receiptLotId: 'R1', received: 2, allocated: 5 }] }, [])[0]).toBe(pending);
    // 依頼の未着も、割り当てが確かでないので「未着なし」と断定しない。
    expect(stateTriadText(view, { ...base, outstanding: 0, overAllocated: [{ receiptLotId: 'R1', received: 2, allocated: 5 }] }, [])[1]).toBe('依頼の未着の解消：確認待ち（過剰割り当て、または割り当て・実際に受け取った数の訂正の日時の食い違いがあるため）');
    expect(stateTriadText(view, { ...base, predatedArrivals: [{ requestId: 'q1', arrivalId: 'a1', receiptLotId: 'R1' }] }, [])[0]).toBe(pending);
    expect(stateTriadText(view, { ...base, predatedRevisions: [{ receiptLotId: 'R1', eventId: 'v1' }] }, [])[0]).toBe(pending);
    expect(requestStateText({ ...base, toOrder: null, predatedRevisions: [{ receiptLotId: 'R1', eventId: 'v1' }] }, '個').join('\n')).toContain('実際に受け取った数の訂正の日時が受け取りより前：保管単位R1の訂正v1');
  });

  test('4.5: 依頼の割り当てに過剰割り当て・日時の食い違いがある間は、全量到着に見えても納期の判定を確認待ちにする', () => {
    let { ledger, supply } = scn();
    const r = receiveLot(ledger, supply, meta('e1', 12), lotOf('R5'), 'counted', 5);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 12), 'q1', { receiptLotId: 'R5', arrived: 5, good: 5 });
    const ok = requestDateText(supply.requests['q1']!, requestSummaryOf(r.ledger, supply, key), dateStatusOf(supply, fixedMasters, 'q1', '2026-10-02'));
    expect(ok).toBe('遅れの指摘なし');
    supply = reviseReceipt(r.ledger, supply, meta('v1', 13), 'R5', 2, '2個だった');
    const held = requestDateText(supply.requests['q1']!, requestSummaryOf(r.ledger, supply, key), dateStatusOf(supply, fixedMasters, 'q1', '2026-10-02'));
    expect(held).toBe('確認待ち（この依頼の割り当てに、過剰割り当てまたは日時の食い違いがあるため）');
  });

  test('仮の実際に受け取った数への割当は、数を出したうえで「仮」と書く（手配対象数・不足の解消・未着・納期）。使い切って確定すれば「仮」は消える', () => {
    let { ledger, supply } = scn();
    const r = receiveLot(ledger, supply, meta('e1', 12), lotOf('R5'), 'label', 5);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 12), 'q1', { receiptLotId: 'R5', arrived: 5, good: 5 });
    const s = requestSummaryOf(r.ledger, supply, key);
    expect(s.provisionalReceipts).toEqual(['R5']);
    const text = requestStateText(s, '個').join('\n');
    expect(text).toContain('仮の割当：保管単位R5');
    const date = requestDateText(supply.requests['q1']!, s, dateStatusOf(supply, fixedMasters, 'q1', '2026-10-02'));
    expect(date).toContain('仮の割当を含む');
    const triad = stateTriadText(shortageOf(r.ledger, supply, key), s, []);
    expect(triad[1]).toContain('仮の割当を含む');
  });

  test('7.1: 不足の解消は、手配と同じ実効の不足で決める。自動の不足0でも独立した申告が残れば未解消、申告だけの群でも申告が解消すれば解消', () => {
    // 必要100・在庫100（自動の不足0）に、独立した足りない分の記録5。
    const ledger = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    const need = registerNeed(emptySupply, fixedMasters, meta('n1', 7), { project: b001, item: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: null, source: '架空', revision: '初版' });
    const declared = declareShortage(need, fixedMasters, meta('d1', 9), { project: b001, item: 'P', unit: '個', value: 5, reason: '現場の申告' });
    expect(stateTriadText(shortageOf(ledger, declared, key), requestSummaryOf(ledger, declared, key), [])[0]).toBe('不足の解消：未解消（不足5個）');
    // 申告だけの群（必要な数なし）で、申告のあとに良品5が届くと解消。
    let s = declareShortage(emptySupply, fixedMasters, meta('d1', 9), { project: b001, item: 'P', unit: '個', value: 5, reason: '現場の申告' });
    s = recordRequest(s, fixedMasters, meta('q1', 9), { project: b001, item: 'P', unit: '個', quantity: 5, vendor: 'X', requestedOn: '2026-10-02', reply: { kind: 'none' } });
    const r = receiveLot(practiceLedger, s, meta('e1', 10), lotOf('R1'), 'counted', 5);
    s = allocateArrival(r.ledger, r.supply, meta('a1', 10), 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 });
    expect(stateTriadText(shortageOf(r.ledger, s, key), requestSummaryOf(r.ledger, s, key), [])[0]).toBe('不足の解消：解消（不足0）');
  });
});
