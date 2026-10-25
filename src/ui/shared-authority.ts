import * as storage from './storage.ts';
import { parseExactJson } from '../domain/exact-json.ts';

export const coreKeys = ['fuzzy-stock/head', 'fuzzy-stock/slot-A', 'fuzzy-stock/slot-B', 'fuzzy-stock/pending', 'fuzzy-stock/reset-recovery'] as const;
export const authorityClient = crypto.randomUUID();
export type CoreValues = (string | null)[];
export type SharedState = {
  format: 'fuzzy-stock-authority'; version: 1; generation: string;
  legacy: CoreValues; core: CoreValues; archive: Record<string, string>; receipts: Record<string, string>;
};

export function coreValues(source: storage.StoreLike): CoreValues { return coreKeys.map(key => source.getItem(key)); }
export function memoryStore(values: CoreValues): storage.StoreLike {
  const data = new Map<string, string | null>(coreKeys.map((key, i) => [key, values[i] ?? null]));
  return { getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { if (!data.has(key)) throw new Error('保存先のキーが不正'); data.set(key, value); },
    removeItem: key => { if (!data.has(key)) throw new Error('保存先のキーが不正'); data.set(key, null); } };
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('共有保存の欄が不正');
  return Object.fromEntries(Object.entries(value));
}
function values(value: unknown): CoreValues {
  if (!Array.isArray(value) || value.length !== coreKeys.length || !value.every((item: unknown) => item === null || typeof item === 'string')) throw new Error('共有保存の原資料が不正');
  return value.map((item: string | null) => item);
}
function strings(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('共有資料が不正');
  const result: Record<string, string> = Object.create(null);
  for (const [key, raw] of Object.entries(value)) { if (typeof raw !== 'string') throw new Error('共有資料の原文が不正'); result[key] = raw; }
  return result;
}
export function parseAuthority(raw: unknown): SharedState {
  if (typeof raw !== 'string') throw new Error('共有保存が読めない');
  const o = object(parseExactJson(raw), ['format', 'version', 'generation', 'legacy', 'core', 'archive', 'receipts']);
  if (o['format'] !== 'fuzzy-stock-authority' || o['version'] !== 1 || typeof o['generation'] !== 'string' || o['generation'].length > 80 || !o['generation'].trim()) throw new Error('共有保存の形式・世代が不正');
  return { format: 'fuzzy-stock-authority', version: 1, generation: o['generation'], legacy: values(o['legacy']), core: values(o['core']), archive: strings(o['archive']), receipts: strings(o['receipts']) };
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    let finished = false;
    const timer = setTimeout(() => { finished = true; reject(new Error('共有保存を開けない。他のタブを閉じてやり直してください')); }, 5000);
    request.onupgradeneeded = () => { request.result.createObjectStore('authority'); };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => { clearTimeout(timer); if (finished) request.result.close(); else resolve(request.result); };
  });
}

// Legacy操作も同じtransactionの順序に入れ、新版の移行と新版の旧writerを直列化する。
export class SharedAuthority {
  readonly source: storage.StoreLike;
  readonly name: string;
  readonly factory: IDBFactory;
  constructor(source: storage.StoreLike, factory: IDBFactory, name = 'fuzzy-stock-shared') {
    this.source = source; this.factory = factory; this.name = name;
  }
  async transact<T>(body: (state: SharedState | null, core: storage.StoreLike) => { state: SharedState | null; value: T }, options: { abortAfterWrite?: boolean } = {}): Promise<T> {
    const db = await openDatabase(this.factory, this.name);
    let changed: 'core' | 'archive' | null = null;
    try {
      const value = await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('authority', 'readwrite', { durability: 'strict' });
        const store = tx.objectStore('authority');
        let result: { value: T } | null = null;
        let failure: unknown;
        let legacy = false;
        const timer = setTimeout(() => { try { tx.abort(); } catch { /* 完了イベントから結果を返す。 */ } }, 5000);
        tx.oncomplete = () => { clearTimeout(timer); if (result === null) reject(new Error('共有保存の完了結果がない')); else resolve(result.value); };
        tx.onabort = () => {
          clearTimeout(timer);
          if (legacy && result !== null) resolve(result.value);
          else reject(failure ?? tx.error ?? new Error('共有保存を中止した。保存の状態を確認してください'));
        };
        const request = store.get('current');
        request.onsuccess = () => {
          try {
            const before: unknown = request.result;
            const state = before === undefined ? null : parseAuthority(before);
            const beforeCore = state === null ? null : JSON.stringify([state.generation, state.core]);
            if (state !== null && JSON.stringify(coreValues(this.source)) !== JSON.stringify(state.legacy)) throw new Error('旧版の記録が変わっている。両方の原資料を控え、照合してください');
            const core = state === null ? this.source : memoryStore(state.core);
            const next = body(state, core);
            legacy = state === null && next.state === null;
            if (next.state !== null) {
              next.state.core = coreValues(core);
              const raw = JSON.stringify(next.state);
              parseAuthority(raw);
              if (raw !== before) {
                changed = JSON.stringify([next.state.generation, next.state.core]) === beforeCore ? 'archive' : 'core';
                const written = store.put(raw, 'current');
                if (options.abortAfterWrite) written.onsuccess = () => tx.abort();
              }
            }
            result = { value: next.value };
          } catch (error) { failure = error; tx.abort(); }
        };
      });
      if (changed !== null && typeof BroadcastChannel !== 'undefined') {
        let channel: BroadcastChannel | null = null;
        try { channel = new BroadcastChannel(`${this.name}/changes`); channel.postMessage({ client: authorityClient, kind: changed }); }
        catch { /* 通知失敗は確定済みtransactionの結果を変えない。再照会でも更新を検出する。 */ }
        finally { try { channel?.close(); } catch { /* 通知用の接続は保存の成否とは別。 */ } }
      }
      return value;
    } finally { db.close(); }
  }
  async enable(expected: storage.Snapshot): Promise<string> {
    return this.transact((state, core) => {
      if (state !== null) return { state, value: state.generation };
      const raw = coreValues(core), copy = memoryStore(raw), loaded = storage.load(copy);
      if (loaded.kind !== 'ok' || loaded.pending !== null || !storage.sameSnapshot(loaded.snapshot, expected) || JSON.stringify(coreValues(copy)) !== JSON.stringify(raw)) throw new Error('保存中・読取不能・変更済みの記録は移行できない。先に保存の状態を確認してください');
      const generation = crypto.randomUUID();
      const next: SharedState = { format: 'fuzzy-stock-authority', version: 1, generation, legacy: raw, core: raw, archive: {}, receipts: {} };
      return { state: next, value: generation };
    });
  }
  read(): Promise<{ state: SharedState | null; loaded: storage.LoadResult }> {
    return this.transact((state, core) => ({ state, value: { state, loaded: storage.load(core) } }));
  }
  async inspectRaw(): Promise<{ authority: unknown; legacy: CoreValues }> {
    const db = await openDatabase(this.factory, this.name);
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('authority', 'readonly'), request = tx.objectStore('authority').get('current');
        const timer = setTimeout(() => { try { tx.abort(); } catch { /* 完了イベントを待つ。 */ } }, 5000);
        tx.onabort = () => { clearTimeout(timer); reject(tx.error ?? new Error('原資料を読み出せない')); };
        tx.oncomplete = () => {
          clearTimeout(timer);
          try { resolve({ authority: request.result, legacy: coreValues(this.source) }); }
          catch (error) { reject(error); }
        };
      });
    } finally { db.close(); }
  }
}
