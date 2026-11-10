'use client';
/**
 * The content console. Talks to the admin API with the token the editor
 * pastes in; the token is kept in memory for this tab only (reloading the page
 * forgets it), never in localStorage or a cookie.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { deepEqual, JsonSyntaxError, parseJsonDetailed, type Json } from '@/lib/caas/json-tools';
import { normalizeKey } from '@/lib/caas/keys';
import { ApiError, createApi, describeReport, type Api, type EntryMeta, type PublishReport, type Status } from './api';
import { JsonTree } from './json-tree';
import { UploadPanel, type UploadTarget } from './upload-panel';

interface Editing {
  service: string;
  path: string;
  etag: string | null;
  original: Json;
  doc: Json;
  isNew: boolean;
  meta?: EntryMeta;
}

type Tab = 'fields' | 'json' | 'upload' | 'history';
type Notice = { text: string; kind: 'ok' | 'error' | 'info'; details?: string[] };

function errorNotice(e: unknown): Notice {
  if (e instanceof ApiError) {
    const d = e.data;
    const details: string[] = [];
    for (const p of (d.problems as Array<{ pointer: string; reason: string }>) ?? []) details.push(`${p.pointer || '(root)'}: ${p.reason}`);
    for (const p of (d.duplicates as Array<{ pointer: string; values: Json[] }>) ?? []) details.push(`${p.pointer}: ${p.values.length} values`);
    for (const r of (d.rejected as Array<{ index: number; reason: string }>) ?? []) details.push(`entry ${r.index}: ${r.reason}`);
    return { text: e.message, kind: 'error', details };
  }
  return { text: (e as Error).message, kind: 'error' };
}

const noSubscribe = () => () => {};
/** host:port this console was loaded from (empty during server rendering). */
function useServerHost(): string {
  return useSyncExternalStore(noSubscribe, () => window.location.host, () => '');
}

function rejectedMessage(host: string): string {
  return (
    `The server at ${host || 'this address'} rejected the admin token. ` +
    'If several servers are running, check this is the right one: each has its own CAAS_ADMIN_TOKENS. ' +
    'Paste only the token, without the "name:" in front of it.'
  );
}

function sanitizedDetails(r: PublishReport): string[] {
  return (r.sanitized ?? []).map((s) => `${s.index !== undefined ? `entry ${s.index} ` : ''}${s.pointer || '(root)'}: ${s.reason}`);
}

export function AdminApp() {
  const [tokenInput, setTokenInput] = useState('');
  const [api, setApi] = useState<Api | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [entries, setEntries] = useState<EntryMeta[]>([]);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [tab, setTab] = useState<Tab>('fields');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const newDialog = useRef<HTMLDialogElement>(null);
  const host = useServerHost();

  const dirty = editing ? editing.isNew || !deepEqual(editing.doc, editing.original) : false;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setApi(null);
          setNotice({ text: rejectedMessage(host), kind: 'error' });
        } else setNotice(errorNotice(e));
      } finally {
        setBusy(false);
      }
    },
    [host],
  );

  const showError = useCallback((e: unknown) => setNotice(errorNotice(e)), []);

  const refresh = useCallback(async (client: Api) => {
    const [list, st] = await Promise.all([client.list(), client.status()]);
    setEntries(list.entries);
    setStatus(st);
  }, []);

  const connect = () =>
    run(async () => {
      const client = createApi(tokenInput.trim());
      await refresh(client);
      setApi(client);
      setTokenInput('');
      setNotice({ text: 'Connected.', kind: 'ok' });
    });

  const disconnect = () => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    setApi(null);
    setEntries([]);
    setStatus(null);
    setEditing(null);
    setNotice(null);
  };

  const confirmDiscard = () => !dirty || confirm('You have unsaved changes. Discard them?');

  const open = (service: string, path: string) => {
    if (!api || !confirmDiscard()) return;
    void run(async () => {
      const r = await api.read(service, path);
      setEditing({ service, path, etag: r.etag, original: r.content, doc: r.content, isNew: false, meta: r.entry });
      setTab((t) => (t === 'upload' || t === 'history' ? 'fields' : t));
      setNotice(null);
    });
  };

  const save = () => {
    if (!api || !editing) return;
    void run(async () => {
      const r = await api.save(editing.service, editing.path, editing.doc, { ifMatch: editing.etag, createOnly: editing.isNew });
      // Re-read so the editor shows exactly what was stored (after sanitizing).
      const fresh = await api.read(editing.service, editing.path);
      setEditing({ ...editing, etag: fresh.etag, original: fresh.content, doc: fresh.content, isNew: false, meta: fresh.entry });
      const rep = describeReport(r);
      setNotice({
        text: `${editing.isNew ? 'Created' : 'Saved'} and published: ${rep.text}`,
        kind: rep.ok && !r.sanitized?.length ? 'ok' : 'info',
        details: sanitizedDetails(r),
      });
      await refresh(api);
    });
  };

  const remove = () => {
    if (!api || !editing || editing.isNew) return;
    if (!confirm(`Delete ${editing.service}/${editing.path} on all pods? It can be restored from History.`)) return;
    void run(async () => {
      const r = await api.remove(editing.service, editing.path, editing.etag);
      setEditing(null);
      setNotice({ text: `Deleted: ${describeReport(r).text}`, kind: 'ok' });
      await refresh(api);
    });
  };

  const purge = (scope: { service?: string; path?: string }, label: string) => {
    if (!api || !confirm(`Purge the cache for ${label}?`)) return;
    void run(async () => {
      const r = await api.purge(scope);
      setNotice({ text: `Purged ${label}: ${describeReport(r).text}`, kind: 'ok' });
    });
  };

  const applyUpload = (target: UploadTarget, doc: Json, note: string) => {
    if (editing && (editing.service !== target.service || editing.path !== target.path) && !confirmDiscard()) return;
    setEditing((cur) =>
      cur && cur.service === target.service && cur.path === target.path
        ? { ...cur, doc }
        : { service: target.service, path: target.path, etag: null, original: target.isNew ? {} : doc, doc, isNew: target.isNew },
    );
    setTab('fields');
    setNotice({ text: note, kind: 'info' });
  };

  const bulkImport = async (items: Array<{ service: string; path: string; content: Json }>, mode: 'upsert' | 'create') => {
    if (!api) return;
    await run(async () => {
      const r = await api.importBulk(items, mode);
      setNotice({ text: `Imported ${r.imported} entries: ${describeReport(r).text}`, kind: 'ok', details: sanitizedDetails(r) });
      await refresh(api);
    });
  };

  const services = useMemo(() => [...new Set(entries.map((e) => e.service))].sort(), [entries]);
  const grouped = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const map = new Map<string, EntryMeta[]>();
    for (const e of entries) {
      if (f && !`${e.service}/${e.path}`.toLowerCase().includes(f)) continue;
      map.set(e.service, [...(map.get(e.service) ?? []), e]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries, filter]);

  if (!api) {
    return (
      <main className="connect">
        <form
          className="card connect-card"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <h1>CaaS console</h1>
          <p className="muted">Paste an admin token. It stays in this tab&apos;s memory only and is sent as a header, never stored.</p>
          <p className="small">
            Server: <code>{host || '…'}</code>
          </p>
          <label className="stack">
            Admin token
            <input type="password" autoComplete="off" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} required minLength={16} />
          </label>
          {/^[A-Za-z0-9_-]{1,40}:/.test(tokenInput.trim()) && (
            <p className="error small">
              This looks like it includes the name from CAAS_ADMIN_TOKENS (&quot;{tokenInput.trim().split(':')[0]}:&quot;). Paste only the part after the colon.
            </p>
          )}
          <button type="submit" className="primary" disabled={busy || tokenInput.trim().length < 16}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
          {notice && <NoticeView notice={notice} onClose={() => setNotice(null)} />}
        </form>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>CaaS console</h1>
        {status && (
          <span className="where">
            {status.env} / {status.zone} / {status.node} · {status.entries} entries · {status.peers.filter((p) => p.inSync).length}/
            {status.peers.length} peers in sync
          </span>
        )}
        <span className="grow" />
        <button type="button" onClick={() => void run(() => refresh(api))} disabled={busy}>
          Refresh
        </button>
        <button type="button" onClick={() => purge({}, 'ALL content')}>
          Purge all
        </button>
        <button type="button" onClick={disconnect}>
          Disconnect
        </button>
      </header>

      <div className="layout">
        <aside className="sidebar card" aria-label="Services and routes">
          <div className="row">
            <input className="grow" type="search" placeholder="Filter routes" aria-label="Filter routes" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button type="button" className="primary" onClick={() => newDialog.current?.showModal()}>
              + New
            </button>
          </div>
          {grouped.length === 0 && <p className="muted">No content{filter ? ' matches' : ' yet'}.</p>}
          {grouped.map(([svc, list]) => (
            <details key={svc} open className="service">
              <summary>
                <span>{svc}</span>
                <span className="muted small">{list.length}</span>
              </summary>
              <ul>
                {list.map((e) => {
                  const active = editing?.service === e.service && editing.path === e.path;
                  return (
                    <li key={e.path}>
                      <button type="button" className="route" aria-current={active ? 'true' : undefined} onClick={() => open(e.service, e.path)}>
                        {e.path}
                        <small className="muted">
                          {e.updatedBy}
                          {e.updatedAt ? ` · ${new Date(e.updatedAt).toLocaleString()}` : ''}
                        </small>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <button type="button" className="link small" onClick={() => purge({ service: svc }, `service ${svc}`)}>
                Purge {svc} cache
              </button>
            </details>
          ))}
          <PeersView status={status} />
        </aside>

        <main className="editor card">
          {notice && <NoticeView notice={notice} onClose={() => setNotice(null)} />}
          {!editing ? (
            <EmptyEditor onNew={() => newDialog.current?.showModal()} onUpload={() => setTab('upload')} tab={tab}>
              {tab === 'upload' && <UploadPanel current={null} known={entries} onApply={applyUpload} onBulkImport={bulkImport} />}
            </EmptyEditor>
          ) : (
            <>
              <div className="editor-head">
                <div>
                  <h2>
                    <span className="muted">{editing.service}/</span>
                    {editing.path}
                    {editing.isNew && <span className="badge">new route</span>}
                    {dirty && !editing.isNew && <span className="badge warn">unsaved</span>}
                  </h2>
                  <p className="muted small">
                    Public URL: <code>{`/api/caas/${editing.service}/${editing.path}.json`}</code>
                    {editing.meta && ` · version ${editing.meta.hlc} by ${editing.meta.updatedBy}`}
                  </p>
                </div>
                <div className="row">
                  <button type="button" className="primary" disabled={busy || !dirty} onClick={save}>
                    {editing.isNew ? 'Create and publish' : 'Save and publish'}
                  </button>
                  <button
                    type="button"
                    disabled={!dirty || editing.isNew}
                    onClick={() => confirm('Discard your changes?') && setEditing({ ...editing, doc: editing.original })}
                  >
                    Revert
                  </button>
                  {!editing.isNew && (
                    <>
                      <button type="button" onClick={() => purge({ service: editing.service, path: editing.path }, 'this entry')}>
                        Purge
                      </button>
                      <button type="button" className="danger" onClick={remove}>
                        Delete
                      </button>
                    </>
                  )}
                  {editing.isNew && (
                    <button type="button" onClick={() => confirm('Discard this new route?') && setEditing(null)}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>

              <div role="tablist" className="tabs" aria-label="Editor views">
                {(['fields', 'json', 'upload', 'history'] as const).map((t) => (
                  <button key={t} role="tab" type="button" aria-selected={tab === t} disabled={t === 'history' && editing.isNew} onClick={() => setTab(t)}>
                    {{ fields: 'Fields', json: 'JSON', upload: 'Upload', history: 'History' }[t]}
                  </button>
                ))}
              </div>

              <div role="tabpanel" className="tabpanel">
                {tab === 'fields' && <JsonTree value={editing.doc} onChange={(doc) => setEditing({ ...editing, doc })} />}
                {tab === 'json' && <RawEditor key={`${editing.service}/${editing.path}`} value={editing.doc} onChange={(doc) => setEditing({ ...editing, doc })} />}
                {tab === 'upload' && (
                  <UploadPanel
                    current={{ service: editing.service, path: editing.path, doc: editing.doc, isNew: editing.isNew }}
                    known={entries}
                    onApply={applyUpload}
                    onBulkImport={bulkImport}
                  />
                )}
                {tab === 'history' && !editing.isNew && (
                  <HistoryView
                    key={`${editing.service}/${editing.path}`}
                    api={api}
                    service={editing.service}
                    path={editing.path}
                    onRestored={(r) => {
                      setNotice({ text: `Restored: ${describeReport(r).text}`, kind: 'ok', details: sanitizedDetails(r) });
                      // Load the restored content without the unsaved-changes prompt.
                      void run(async () => {
                        const fresh = await api.read(editing.service, editing.path);
                        setEditing({ ...editing, etag: fresh.etag, original: fresh.content, doc: fresh.content, meta: fresh.entry });
                        await refresh(api);
                      });
                    }}
                    onError={showError}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>

      <NewRouteDialog
        ref={newDialog}
        services={services}
        known={entries}
        currentDoc={editing?.doc}
        onCreate={(service, path, doc) => {
          if (!confirmDiscard()) return false;
          setEditing({ service, path, etag: null, original: {}, doc, isNew: true });
          setTab('fields');
          setNotice({ text: `New route ${service}/${path}. Add fields, then "Create and publish".`, kind: 'info' });
          return true;
        }}
      />
      <datalist id="known-services">
        {services.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

function NoticeView({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  return (
    <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <div className="grow">
        <p>{notice.text}</p>
        {notice.details && notice.details.length > 0 && (
          <ul className="small">
            {notice.details.slice(0, 20).map((d, i) => (
              <li key={i}>
                <code>{d}</code>
              </li>
            ))}
            {notice.details.length > 20 && <li>…and {notice.details.length - 20} more</li>}
          </ul>
        )}
      </div>
      <button type="button" className="icon" aria-label="Dismiss" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

function PeersView({ status }: { status: Status | null }) {
  if (!status) return null;
  return (
    <details className="peers">
      <summary className="muted small">Pods ({status.peers.length} peers)</summary>
      {status.peers.length === 0 ? (
        <p className="muted small">This pod has no peers.</p>
      ) : (
        <ul className="small">
          {status.peers.map((p) => (
            <li key={p.url}>
              <span className={p.inSync ? 'ok' : 'bad'}>{p.inSync ? 'in sync' : p.lastError ? 'error' : 'catching up'}</span> {p.node ?? p.url}{' '}
              <span className="muted">[{p.scope}]</span>
              {p.lastError && <span className="bad"> {p.lastError}</span>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function EmptyEditor({ onNew, onUpload, tab, children }: { onNew: () => void; onUpload: () => void; tab: Tab; children: ReactNode }) {
  return (
    <div className="empty-editor">
      {tab !== 'upload' && (
        <>
          <h2>Pick a route on the left</h2>
          <p className="muted">Or start something new.</p>
        </>
      )}
      <div className="row">
        <button type="button" className="primary" onClick={onNew}>
          + New service or route
        </button>
        <button type="button" onClick={onUpload}>
          Upload JSON
        </button>
      </div>
      {children}
    </div>
  );
}

/** Raw JSON view. Changes apply only when the text is valid JSON without repeated keys. */
function RawEditor({ value, onChange }: { value: Json; onChange: (v: Json) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [lastValue, setLastValue] = useState(value);
  if (!deepEqual(lastValue, value)) {
    // Changed from outside (another tab of the editor, upload, revert).
    setLastValue(value);
    setText(JSON.stringify(value, null, 2));
    setError(null);
  }

  const edit = (t: string) => {
    setText(t);
    try {
      const r = parseJsonDetailed(t);
      if (r.duplicates.length > 0) {
        setError(`Repeated key${r.duplicates.length > 1 ? 's' : ''}: ${r.duplicates.map((d) => d.pointer).join(', ')}. Remove one so it is clear which value is meant.`);
        return;
      }
      setError(null);
      setLastValue(r.value);
      onChange(r.value);
    } catch (e) {
      setError(e instanceof JsonSyntaxError ? e.message : (e as Error).message);
    }
  };

  return (
    <div className="raw">
      <textarea value={text} spellCheck={false} aria-label="JSON content" aria-invalid={error ? true : undefined} onChange={(e) => edit(e.target.value)} />
      <div className="row">
        {error ? <p className="error small">{error}</p> : <p className="muted small">Valid JSON.</p>}
        <span className="grow" />
        <button type="button" className="small" disabled={!!error} onClick={() => setText(JSON.stringify(value, null, 2))}>
          Format
        </button>
      </div>
    </div>
  );
}

function HistoryView({
  api,
  service,
  path,
  onRestored,
  onError,
}: {
  api: Api;
  service: string;
  path: string;
  onRestored: (r: PublishReport) => void;
  onError: (e: unknown) => void;
}) {
  const [versions, setVersions] = useState<EntryMeta[] | null>(null);
  const [viewing, setViewing] = useState<{ hlc: string; content: Json | null } | null>(null);

  useEffect(() => {
    let live = true;
    api.history(service, path).then(
      (r) => live && setVersions(r.versions),
      (e) => live && onError(e),
    );
    return () => {
      live = false;
    };
  }, [api, service, path, onError]);

  if (!versions) return <p className="muted">Loading history…</p>;
  return (
    <div className="history">
      <p className="muted small">{versions.length} version(s) kept on this pod. Restoring publishes that version as a new change.</p>
      <ul>
        {versions.map((v) => (
          <li key={v.hlc} className="row">
            <span className="grow">
              {new Date(v.updatedAt || 0).toLocaleString()} · {v.updatedBy}
              {v.deleted && <span className="badge warn">deleted</span>}
            </span>
            <button
              type="button"
              className="small"
              onClick={() =>
                api.version(service, path, v.hlc).then(
                  (r) => setViewing({ hlc: v.hlc, content: r.content }),
                  onError,
                )
              }
            >
              View
            </button>
            <button
              type="button"
              className="small"
              onClick={() => {
                if (!confirm('Republish this version to all pods?')) return;
                api.rollback(service, path, v.hlc).then(onRestored, onError);
              }}
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
      {viewing && (
        <div className="card">
          <p className="muted small">Version {viewing.hlc}</p>
          {viewing.content === null ? <p className="muted">(deleted)</p> : <JsonTree value={viewing.content} onChange={() => {}} readOnly />}
        </div>
      )}
    </div>
  );
}

interface NewRouteProps {
  services: string[];
  known: EntryMeta[];
  currentDoc: Json | undefined;
  onCreate: (service: string, path: string, doc: Json) => boolean;
  ref: Ref<HTMLDialogElement>;
}

function NewRouteDialog({ services, known, currentDoc, onCreate, ref }: NewRouteProps) {
  const [service, setService] = useState('');
  const [path, setPath] = useState('');
  const [start, setStart] = useState<'empty' | 'copy'>('empty');

  const key = normalizeKey(service.trim(), path.trim());
  const exists = key ? known.some((e) => e.service === key.service && e.path === key.path) : false;
  const isNewService = key ? !services.includes(key.service) : false;

  const close = (el: HTMLElement) => el.closest('dialog')?.close();

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="new-title">
      <form
        method="dialog"
        onSubmit={(e) => {
          if (!key || exists) return e.preventDefault();
          const doc: Json = start === 'copy' && currentDoc !== undefined ? structuredClone(currentDoc) : {};
          if (!onCreate(key.service, key.path, doc)) return e.preventDefault();
          setPath('');
        }}
      >
        <h2 id="new-title">New service or route</h2>
        <p className="muted small">
          A service is a namespace; it exists as soon as it has one route. The route is served at <code>/api/caas/&#123;service&#125;/&#123;path&#125;.json</code>.
        </p>
        <label className="stack">
          Service
          <input value={service} onChange={(e) => setService(e.target.value)} list="known-services" placeholder="e.g. offers" required autoFocus />
        </label>
        <label className="stack">
          Path
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="e.g. home/hero" required />
        </label>
        <fieldset className="row">
          <legend className="small muted">Start with</legend>
          <label className="choice">
            <input type="radio" name="start" checked={start === 'empty'} onChange={() => setStart('empty')} /> empty object
          </label>
          <label className="choice">
            <input type="radio" name="start" checked={start === 'copy'} disabled={currentDoc === undefined} onChange={() => setStart('copy')} /> copy of the open entry
          </label>
        </fieldset>
        {(service || path) && !key && (
          <p className="error small">Service: lowercase letters, digits, - and _ (max 64). Path: letters, digits, . _ ~ - separated by /.</p>
        )}
        {exists && <p className="error small">That route already exists.</p>}
        {key && !exists && (
          <p className="muted small">
            {isNewService ? 'Creates the new service ' : 'Adds a route to '}
            <code>{key.service}</code>: <code>{`/api/caas/${key.service}/${key.path}.json`}</code>
          </p>
        )}
        <div className="row end">
          <button type="button" onClick={(e) => close(e.currentTarget)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!key || exists}>
            Create
          </button>
        </div>
      </form>
    </dialog>
  );
}
