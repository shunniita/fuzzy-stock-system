import { deepFreeze, type Ledger, type Process } from '../../src/domain/ledger.ts';

// 試験用に、工程の登録操作を経ずに利用中の工程をマスタへ直接足す。名前はIDと同じにする。
export function withProcesses(ledger: Ledger, ...processes: Process[]): Ledger {
  const added = Object.fromEntries(processes.map(({ id, criterion }) => [id, { type: 'process' as const, id, name: id, criterion, active: true }]));
  return deepFreeze({ ...ledger, masters: { ...ledger.masters, processes: { ...ledger.masters.processes, ...added } } });
}
