'use client';
/**
 * Upload a JSON file, either one document (for the open entry or a new route)
 * or a bulk export ({"entries":[{service,path,content}]}).
 *
 * Two kinds of duplicates are surfaced instead of being resolved silently:
 *  1. the same key twice in one object of the file: every value is listed and
 *     the editor picks which one to keep;
 *  2. a key in the file that already exists in the entry with a different
 *     value: every conflict is listed with both values and the editor picks.
 */
import { useMemo, useState, type DragEvent } from 'react';
import {
  fromPointer,
  isObject,
  JsonSyntaxError,
  mergeJson,
  parseJsonDetailed,
  setAt,
  type DuplicateKey,
  type Json,
} from '@/lib/caas/json-tools';
import { normalizeKey } from '@/lib/caas/keys';
import type { BulkDryRun, EntryMeta } from './api';
import { SanitizeReview } from './sanitize-review';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface UploadTarget {
  service: string;
  path: string;
  isNew: boolean;
}

type BulkItem = { service: string; path: string; content: Json };

interface Props {
  current: { service: string; path: string; doc: Json; isNew: boolean } | null;
  known: EntryMeta[];
  onApply: (target: UploadTarget, doc: Json, note: string) => void;
  onBulkImport: (items: BulkItem[], mode: 'upsert' | 'create') => Promise<void>;
  /** Server-side check of a bulk import without writing anything. */
  onBulkCheck: (items: BulkItem[], mode: 'upsert' | 'create') => Promise<BulkDryRun | undefined>;
}

export function preview(v: Json | undefined, max = 140): string {
  const s = v === undefined ? '(absent)' : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function UploadPanel({ current, known, onApply, onBulkImport, onBulkCheck }: Props) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [fallback, setFallback] = useState<'first' | 'last'>('last');
  const [dragging, setDragging] = useState(false);

  const load = async (f: File | undefined) => {
    setReadError(null);
    setChoices({});
    setFile(null);
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) return setReadError(`File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    try {
      setFile({ name: f.name, text: await f.text() });
    } catch (e) {
      setReadError(`Could not read the file: ${(e as Error).message}`);
    }
  };

  // Parsed with the editor's duplicate choices applied.
  const parsed = useMemo(() => {
    if (!file) return null;
    try {
      const r = parseJsonDetailed(file.text, { duplicates: { choices, fallback } });
      return { ok: true as const, ...r };
    } catch (e) {
      const msg = e instanceof JsonSyntaxError ? e.message : (e as Error).message;
      return { ok: false as const, error: msg };
    }
  }, [file, choices, fallback]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void load(e.dataTransfer.files[0]);
  };

  const bulk = parsed?.ok ? asBulk(parsed.value) : null;

  return (
    <div className="upload">
      <div
        className={`dropzone${dragging ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>Drop a .json file here, or</p>
        <label className="button">
          Choose file
          <input
            type="file"
            accept=".json,application/json"
            className="visually-hidden"
            onChange={(e) => {
              void load(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
        <p className="muted small">
          One document for the open entry or a new route, or a bulk file shaped like the export:{' '}
          <code>{'{"entries":[{"service","path","content"}]}'}</code>
        </p>
      </div>

      {readError && <p className="error">{readError}</p>}
      {file && parsed && !parsed.ok && (
        <p className="error">
          {file.name}: not valid JSON. {parsed.error}
        </p>
      )}

      {file && parsed?.ok && (
        <>
          <p className="muted">
            Loaded <strong>{file.name}</strong> ({(file.text.length / 1024).toFixed(1)} KB)
            {bulk ? ` — bulk file with ${bulk.length} entries` : ' — single document'}
          </p>
          {parsed.duplicates.length > 0 && (
            <DuplicateResolver
              duplicates={parsed.duplicates}
              choices={choices}
              fallback={fallback}
              onChoose={(pointer, i) => setChoices((c) => ({ ...c, [pointer]: i }))}
              onFallback={(f) => {
                setFallback(f);
                setChoices({});
              }}
            />
          )}
          {bulk ? (
            <BulkPreview key={`${file.name}:${file.text.length}`} items={bulk} known={known} onImport={onBulkImport} onCheck={onBulkCheck} />
          ) : (
            <SinglePreview key={`${file.name}:${file.text.length}`} fileName={file.name} doc={parsed.value} current={current} known={known} onApply={onApply} />
          )}
        </>
      )}
    </div>
  );
}

function asBulk(v: Json): BulkItem[] | null {
  if (!isObject(v) || !Array.isArray(v.entries)) return null;
  const items = v.entries;
  if (!items.every((e) => isObject(e) && typeof e.service === 'string' && typeof e.path === 'string' && 'content' in e)) return null;
  return items.map((e) => {
    const o = e as { service: string; path: string; content: Json };
    return { service: o.service, path: o.path, content: o.content };
  });
}

function DuplicateResolver({
  duplicates,
  choices,
  fallback,
  onChoose,
  onFallback,
}: {
  duplicates: DuplicateKey[];
  choices: Record<string, number>;
  fallback: 'first' | 'last';
  onChoose: (pointer: string, index: number) => void;
  onFallback: (f: 'first' | 'last') => void;
}) {
  return (
    <section className="card warn" aria-labelledby="dup-title">
      <h3 id="dup-title">
        {duplicates.length} duplicate key{duplicates.length === 1 ? '' : 's'} in the file
      </h3>
      <p className="muted small">
        The same key appears more than once in one object. Pick the value to keep for each; plain JSON parsers would keep the last one
        without telling you.
      </p>
      <div className="row">
        <span className="muted small">Default for all:</span>
        <button type="button" className={`small${fallback === 'first' ? ' selected' : ''}`} onClick={() => onFallback('first')}>
          Keep first
        </button>
        <button type="button" className={`small${fallback === 'last' ? ' selected' : ''}`} onClick={() => onFallback('last')}>
          Keep last
        </button>
      </div>
      <ul className="dup-list">
        {duplicates.map((d) => {
          const chosen = choices[d.pointer] ?? d.kept;
          return (
            <li key={d.pointer}>
              <code className="pointer">{d.pointer}</code>
              <fieldset>
                <legend className="visually-hidden">Value to keep for {d.pointer}</legend>
                {d.values.map((v, i) => (
                  <label key={i} className="choice">
                    <input type="radio" name={`dup-${d.pointer}`} checked={chosen === i} onChange={() => onChoose(d.pointer, i)} />
                    <span className="muted small">#{i + 1}</span> <code>{preview(v)}</code>
                  </label>
                ))}
              </fieldset>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type Mode = 'replace' | 'merge-incoming' | 'merge-existing';

function SinglePreview({
  fileName,
  doc,
  current,
  known,
  onApply,
}: {
  fileName: string;
  doc: Json;
  current: Props['current'];
  known: EntryMeta[];
  onApply: Props['onApply'];
}) {
  const [targetKind, setTargetKind] = useState<'current' | 'new'>(current ? 'current' : 'new');
  const [service, setService] = useState(current?.service ?? '');
  const [path, setPath] = useState(() => fileName.replace(/\.json$/i, '').replace(/[^A-Za-z0-9._~/-]/g, '-'));
  const [mode, setMode] = useState<Mode>('merge-incoming');
  const [overrides, setOverrides] = useState<Record<string, 'existing' | 'incoming'>>({});

  const useCurrent = targetKind === 'current' && current !== null;
  const merge = useMemo(() => {
    if (!useCurrent || mode === 'replace') return null;
    return mergeJson(current.doc, doc, mode === 'merge-incoming' ? 'incoming' : 'existing');
  }, [useCurrent, current, doc, mode]);
  const replaceDiff = useMemo(() => (useCurrent && mode === 'replace' ? mergeJson(current.doc, doc, 'incoming') : null), [useCurrent, current, doc, mode]);

  const newKey = !useCurrent ? normalizeKey(service.trim(), path.trim()) : undefined;
  const exists = newKey ? known.some((e) => e.service === newKey.service && e.path === newKey.path) : false;

  const apply = () => {
    if (useCurrent) {
      let result = mode === 'replace' ? doc : merge!.value;
      let picked = 0;
      if (merge) {
        const prefer = mode === 'merge-incoming' ? 'incoming' : 'existing';
        for (const c of merge.conflicts) {
          const want = overrides[c.pointer] ?? prefer;
          if (want !== prefer) {
            result = setAt(result, fromPointer(c.pointer), want === 'incoming' ? c.incoming : c.existing);
            picked++;
          }
        }
      }
      const note =
        mode === 'replace'
          ? `Replaced with ${fileName}`
          : `Merged ${fileName}: ${merge!.added.length} added, ${merge!.conflicts.length} conflict(s)${picked ? `, ${picked} chosen by hand` : ''}`;
      onApply({ service: current.service, path: current.path, isNew: current.isNew }, result, note + '. Review, then save.');
    } else if (newKey) {
      onApply({ ...newKey, isNew: true }, doc, `Loaded ${fileName} as a new route. Review, then save.`);
    }
  };

  const conflicts = merge?.conflicts ?? [];
  const prefer = mode === 'merge-incoming' ? 'incoming' : 'existing';

  return (
    <section className="card" aria-label="Apply uploaded document">
      <div className="row">
        <label className="choice">
          <input type="radio" name="target" checked={useCurrent} disabled={!current} onChange={() => setTargetKind('current')} />
          Open entry {current ? <code>{`${current.service}/${current.path}`}</code> : <span className="muted">(none open)</span>}
        </label>
        <label className="choice">
          <input type="radio" name="target" checked={!useCurrent} onChange={() => setTargetKind('new')} />
          New route
        </label>
      </div>

      {useCurrent ? (
        <>
          <div className="row">
            <label className="choice">
              <input type="radio" name="mode" checked={mode === 'merge-incoming'} onChange={() => setMode('merge-incoming')} />
              Merge, file wins on conflicts
            </label>
            <label className="choice">
              <input type="radio" name="mode" checked={mode === 'merge-existing'} onChange={() => setMode('merge-existing')} />
              Merge, keep current values
            </label>
            <label className="choice">
              <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
              Replace entirely
            </label>
          </div>
          {merge && (
            <p className="muted small">
              {merge.added.length} new field(s) from the file · {merge.untouched.length} field(s) only in the current entry are kept ·{' '}
              {conflicts.length} key(s) with different values
            </p>
          )}
          {replaceDiff && (
            <p className="muted small">
              {replaceDiff.untouched.length} field(s) not in the file will be removed · {replaceDiff.conflicts.length} value(s) change ·{' '}
              {replaceDiff.added.length} added
            </p>
          )}
          {conflicts.length > 0 && (
            <div className="table-wrap">
              <table className="conflicts">
                <caption className="visually-hidden">Keys whose value differs between the entry and the file</caption>
                <thead>
                  <tr>
                    <th scope="col">Key</th>
                    <th scope="col">Current value</th>
                    <th scope="col">Value in file</th>
                  </tr>
                </thead>
                <tbody>
                  {conflicts.map((c) => {
                    const want = overrides[c.pointer] ?? prefer;
                    const set = (w: 'existing' | 'incoming') => setOverrides((o) => ({ ...o, [c.pointer]: w }));
                    return (
                      <tr key={c.pointer}>
                        <th scope="row">
                          <code>{c.pointer || '(root)'}</code>
                        </th>
                        <td className={want === 'existing' ? 'kept' : ''}>
                          <label className="choice">
                            <input type="radio" name={`c-${c.pointer}`} checked={want === 'existing'} onChange={() => set('existing')} />
                            <code>{preview(c.existing)}</code>
                          </label>
                        </td>
                        <td className={want === 'incoming' ? 'kept' : ''}>
                          <label className="choice">
                            <input type="radio" name={`c-${c.pointer}`} checked={want === 'incoming'} onChange={() => set('incoming')} />
                            <code>{preview(c.incoming)}</code>
                          </label>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="row">
          <input className="grow" value={service} placeholder="service" aria-label="Service" onChange={(e) => setService(e.target.value)} list="known-services" />
          <input className="grow" value={path} placeholder="path, e.g. home/hero" aria-label="Path" onChange={(e) => setPath(e.target.value)} />
        </div>
      )}
      {!useCurrent && !newKey && (service || path) && <p className="error small">Service: lowercase letters, digits, - and _. Path: letters, digits, . _ ~ - separated by /.</p>}
      {!useCurrent && exists && <p className="error small">That route already exists. Open it and upload with a merge instead.</p>}

      <div className="row">
        <button type="button" className="primary" disabled={!useCurrent && (!newKey || exists)} onClick={apply}>
          Load into editor
        </button>
        <span className="muted small">Nothing is published until you save.</span>
      </div>
    </section>
  );
}

function BulkPreview({
  items,
  known,
  onImport,
  onCheck,
}: {
  items: BulkItem[];
  known: EntryMeta[];
  onImport: Props['onBulkImport'];
  onCheck: Props['onBulkCheck'];
}) {
  const [check, setCheck] = useState<BulkDryRun | null>(null);
  const [keep, setKeep] = useState<'first' | 'last'>('last');
  const [existing, setExisting] = useState<'overwrite' | 'skip'>('overwrite');
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const knownSet = new Set(known.map((e) => `${e.service}/${e.path}`));
    const byKey = new Map<string, number[]>();
    const out = items.map((item, index) => {
      const key = normalizeKey(item.service, item.path);
      const id = key ? `${key.service}/${key.path}` : null;
      if (id) byKey.set(id, [...(byKey.get(id) ?? []), index]);
      return { index, item, id, exists: id ? knownSet.has(id) : false };
    });
    return out.map((r) => {
      const group = r.id ? byKey.get(r.id)! : [];
      const repeated = group.length > 1;
      const winner = keep === 'first' ? group[0] : group[group.length - 1];
      return { ...r, repeated, dropped: repeated && r.index !== winner };
    });
  }, [items, known, keep]);

  const invalid = rows.filter((r) => !r.id);
  const repeated = rows.filter((r) => r.repeated);
  const toSend = rows.filter((r) => r.id && !r.dropped && !(existing === 'skip' && r.exists));
  const overwrites = toSend.filter((r) => r.exists).length;

  return (
    <section className="card" aria-label="Bulk import">
      <p>
        {toSend.length} entr{toSend.length === 1 ? 'y' : 'ies'} will be written ({toSend.length - overwrites} new, {overwrites} overwritten).
      </p>
      {repeated.length > 0 && (
        <div className="row warn-inline">
          <span>The same service/path appears more than once in the file. Keep:</span>
          <button type="button" className={`small${keep === 'first' ? ' selected' : ''}`} onClick={() => setKeep('first')}>
            first
          </button>
          <button type="button" className={`small${keep === 'last' ? ' selected' : ''}`} onClick={() => setKeep('last')}>
            last
          </button>
        </div>
      )}
      <div className="row">
        <span className="muted small">Entries that already exist:</span>
        <label className="choice">
          <input type="radio" name="existing" checked={existing === 'overwrite'} onChange={() => setExisting('overwrite')} />
          overwrite
        </label>
        <label className="choice">
          <input type="radio" name="existing" checked={existing === 'skip'} onChange={() => setExisting('skip')} />
          skip
        </label>
      </div>
      {invalid.length > 0 && <p className="error small">{invalid.length} entr{invalid.length === 1 ? 'y has' : 'ies have'} an invalid service or path and will be skipped.</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Route</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map((r) => (
              <tr key={r.index} className={!r.id || r.dropped || (existing === 'skip' && r.exists) ? 'skipped' : ''}>
                <td>{r.index}</td>
                <td>
                  <code>{`${r.item.service}/${r.item.path}`}</code>
                </td>
                <td>
                  {!r.id
                    ? 'invalid route'
                    : r.dropped
                      ? 'repeated in file, not used'
                      : r.exists
                        ? existing === 'skip'
                          ? 'exists, skipped'
                          : 'exists, overwritten'
                        : 'new'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 500 && <p className="muted small">…and {rows.length - 500} more</p>}
      </div>
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={busy || toSend.length === 0}
          onClick={async () => {
            setBusy(true);
            try {
              // Ask the server first: rejected entries and values it would clean are shown before anything is written.
              const r = await onCheck(
                toSend.map((x) => x.item),
                existing === 'skip' ? 'create' : 'upsert',
              );
              if (!r) return;
              if (!r.ok || r.sanitized.length > 0) {
                setCheck(r);
                return;
              }
              if (!confirm(`Publish ${toSend.length} entries to all pods?`)) return;
              await onImport(
                toSend.map((x) => x.item),
                existing === 'skip' ? 'create' : 'upsert',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Checking…' : `Import ${toSend.length}`}
        </button>
      </div>
      {check && !check.ok && (
        <div className="notice error" role="alert">
          <div className="grow">
            <p>The server would refuse this import; nothing was written.</p>
            <ul className="small">
              {check.rejected.slice(0, 20).map((r) => (
                <li key={r.index}>
                  <code>{`entry ${r.index}: ${r.reason}`}</code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {check && check.ok && check.sanitized.length > 0 && (
        <SanitizeReview
          changes={check.sanitized}
          busy={busy}
          saveLabel={`Import ${toSend.length} with these changes`}
          onCancel={() => setCheck(null)}
          onSave={async () => {
            setBusy(true);
            try {
              setCheck(null);
              await onImport(
                toSend.map((x) => x.item),
                existing === 'skip' ? 'create' : 'upsert',
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </section>
  );
}
