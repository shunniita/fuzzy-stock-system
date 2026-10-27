import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 同期decoderが無限ループしても、試験プロセス全体を止めない。
const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import {practiceLedger,register,beginRework,split,recordReworkPart} from './src/domain/ledger.ts';
  import {emptySupply} from './src/domain/supply.ts';
  import {initial,parse,serialize} from './src/ui/storage.ts';
  import {decodePending} from './src/ui/storageparse.ts';
  import {backupTextOf,readBackup} from './src/ui/backup.ts';
  const at='2026-10-22T00:00:00+09:00';
  const meta=(eventId,hour)=>({eventId,actor:'架空担当A',occurredAt:'2026-10-21T'+hour+':00:00+09:00',recordedAt:at});
  const p={id:'R組立',criterion:'inspection'};
  let l=register(practiceLedger,meta('done',10),{id:'done',item:'R',unit:'台',project:{kind:'common'},location:'T',stage:{kind:'awaitingHandover',process:p}},'counted',20);
  l=beginRework(l,meta('rework',11),'done','repair','counted',20,'架空の手直し');
  l=split(l,meta('Y',12),'repair','Y','counted',10);
  l=split(l,meta('Z',13),'Y','Z','counted',5);
  l=recordReworkPart(l,meta('part',14),{action:'discard',reworkId:'rework',subjectLotId:'Z',item:'P',unit:'個',value:1,reason:'架空の処置'});
  const s=structuredClone(initial(l,emptySupply));
  assert.deepEqual(parse(serialize(s)),s);
  const pending={format:'fuzzy-stock-pending',version:s.version,pending:{progress:'saving',unknownSince:null,savingSince:at,baseRevision:0,opId:'op1',opLabel:'架空操作',fingerprint:'f',values:{},actor:'架空担当A',startedAt:at,units:[{ledger:s.ledger,supply:s.supply,targets:[],conflictReviews:[]}]}};
  assert.deepEqual(decodePending(pending),pending.pending);
  s.ledger.lots.Y.splitFrom='Z';
  assert.throws(()=>parse(serialize(s)),/循環/);
  assert.throws(()=>decodePending(pending),/循環/);
  assert.equal(readBackup(new TextEncoder().encode(backupTextOf(s,at))).kind,'unreadable');
`], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 5000, windowsHide: true });
assert.equal(result.error, undefined, `分割元の循環検査が終了しません: ${result.error?.message}`);
assert.equal(result.status, 0, result.stderr);
console.log('PASS: 正常な系譜の保存往復と、分割元の循環をsnapshot/pending/backupで拒否');
