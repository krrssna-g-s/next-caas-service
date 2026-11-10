'use client';
/**
 * Field editor for nested JSON: edit values, rename keys, change types, add
 * and remove fields and array items at any depth. Everything is rendered as
 * React text, so content is never interpreted as HTML here.
 */
import { useState, type KeyboardEvent } from 'react';
import { getAt, isObject, removeAt, renameKeyAt, setAt, typeOf, type Json, type PathSeg } from '@/lib/caas/json-tools';

type Kind = ReturnType<typeof typeOf>;
const KINDS: Kind[] = ['string', 'number', 'boolean', 'null', 'object', 'array'];

function convert(v: Json, to: Kind): Json {
  switch (to) {
    case 'string':
      return v === null || typeof v === 'object' ? '' : String(v);
    case 'number': {
      const n = Number(v);
      return typeof v !== 'object' && Number.isFinite(n) ? n : 0;
    }
    case 'boolean':
      return typeof v === 'object' ? false : Boolean(v);
    case 'null':
      return null;
    case 'object':
      return {};
    case 'array':
      return [];
  }
}

function isContainer(v: Json): v is Json[] | { [k: string]: Json } {
  return v !== null && typeof v === 'object';
}

function hasChildren(v: Json): boolean {
  return Array.isArray(v) ? v.length > 0 : isObject(v) && Object.keys(v).length > 0;
}

function summary(v: Json): string {
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (isObject(v)) {
    const n = Object.keys(v).length;
    return `${n} field${n === 1 ? '' : 's'}`;
  }
  return '';
}

interface TreeProps {
  value: Json;
  onChange: (next: Json) => void;
  readOnly?: boolean;
}

export function JsonTree({ value, onChange, readOnly = false }: TreeProps) {
  const ops: Ops = {
    readOnly,
    set: (path, v) => onChange(setAt(value, path, v)),
    remove: (path) => onChange(removeAt(value, path)),
    rename: (parent, from, to) => onChange(renameKeyAt(value, parent, from, to)),
    get: (path) => getAt(value, path),
  };

  if (!isContainer(value)) {
    return (
      <div className="tree">
        <p className="muted">The document root is a {typeOf(value)}.</p>
        <div className="field-row">
          <TypeSelect value={value} path={[]} ops={ops} />
          <ValueEditor value={value} path={[]} ops={ops} label="Root value" />
        </div>
      </div>
    );
  }
  return (
    <div className="tree" role="tree" aria-label="Content fields">
      <Children value={value} path={[]} ops={ops} depth={0} />
    </div>
  );
}

interface Ops {
  readOnly: boolean;
  set: (path: PathSeg[], v: Json) => void;
  remove: (path: PathSeg[]) => void;
  rename: (parent: PathSeg[], from: string, to: string) => void;
  get: (path: PathSeg[]) => Json | undefined;
}

function Children({ value, path, ops, depth }: { value: Json[] | { [k: string]: Json }; path: PathSeg[]; ops: Ops; depth: number }) {
  const entries: Array<[PathSeg, Json]> = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  return (
    <ul className="tree-children" role="group">
      {entries.length === 0 && <li className="muted empty">{Array.isArray(value) ? 'No items' : 'No fields'}</li>}
      {entries.map(([k, v]) => (
        <Node key={String(k)} name={k} value={v} path={[...path, k]} ops={ops} depth={depth} parentIsArray={Array.isArray(value)} />
      ))}
      {!ops.readOnly && <AddRow parent={value} path={path} ops={ops} />}
    </ul>
  );
}

function Node({
  name,
  value,
  path,
  ops,
  depth,
  parentIsArray,
}: {
  name: PathSeg;
  value: Json;
  path: PathSeg[];
  ops: Ops;
  depth: number;
  parentIsArray: boolean;
}) {
  const [open, setOpen] = useState(depth < 2);
  const container = isContainer(value);
  const parentPath = path.slice(0, -1);
  const label = path.join(' › ');

  return (
    <li role="treeitem" aria-expanded={container ? open : undefined} aria-selected={false}>
      <div className="field-row">
        {container ? (
          <button type="button" className="twisty" aria-label={open ? `Collapse ${label}` : `Expand ${label}`} onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="twisty-spacer" />
        )}
        {parentIsArray ? (
          <span className="index">[{String(name)}]</span>
        ) : (
          <KeyInput name={String(name)} parentPath={parentPath} ops={ops} />
        )}
        <TypeSelect value={value} path={path} ops={ops} />
        {container ? (
          <span className="muted summary">{summary(value)}</span>
        ) : (
          <ValueEditor value={value} path={path} ops={ops} label={label} />
        )}
        {!ops.readOnly && (
          <button
            type="button"
            className="icon danger"
            aria-label={`Remove ${label}`}
            title="Remove"
            onClick={() => {
              if (hasChildren(value) && !confirm(`Remove "${label}" and everything inside it?`)) return;
              ops.remove(path);
            }}
          >
            ✕
          </button>
        )}
      </div>
      {container && open && <Children value={value} path={path} ops={ops} depth={depth + 1} />}
    </li>
  );
}

function KeyInput({ name, parentPath, ops }: { name: string; parentPath: PathSeg[]; ops: Ops }) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  // Keep the draft in step when the key changes from outside (undo, upload, rename elsewhere).
  const [seen, setSeen] = useState(name);
  if (seen !== name) {
    setSeen(name);
    setDraft(name);
  }

  const commit = () => {
    if (draft === name) return setError(null);
    try {
      ops.rename(parentPath, name, draft);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setDraft(name);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') {
      setDraft(name);
      setError(null);
    }
  };
  return (
    <span className="key-wrap">
      <input
        className="key"
        value={draft}
        readOnly={ops.readOnly}
        aria-label="Field name"
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
      />
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function TypeSelect({ value, path, ops }: { value: Json; path: PathSeg[]; ops: Ops }) {
  const kind = typeOf(value);
  return (
    <select
      className="type"
      value={kind}
      disabled={ops.readOnly}
      aria-label="Field type"
      onChange={(e) => {
        const to = e.target.value as Kind;
        if (hasChildren(value) && !confirm(`Changing to ${to} discards what is inside. Continue?`)) return;
        ops.set(path, convert(value, to));
      }}
    >
      {KINDS.map((k) => (
        <option key={k} value={k}>
          {k}
        </option>
      ))}
    </select>
  );
}

function ValueEditor({ value, path, ops, label }: { value: Json; path: PathSeg[]; ops: Ops; label: string }) {
  if (typeof value === 'string') {
    const long = value.length > 80 || value.includes('\n');
    return long ? (
      <textarea
        className="value"
        value={value}
        rows={Math.min(8, Math.max(2, value.split('\n').length))}
        readOnly={ops.readOnly}
        aria-label={`Value of ${label}`}
        onChange={(e) => ops.set(path, e.target.value)}
      />
    ) : (
      <input className="value" value={value} readOnly={ops.readOnly} aria-label={`Value of ${label}`} onChange={(e) => ops.set(path, e.target.value)} />
    );
  }
  if (typeof value === 'number') return <NumberInput value={value} path={path} ops={ops} label={label} />;
  if (typeof value === 'boolean') {
    return (
      <label className="bool">
        <input type="checkbox" checked={value} disabled={ops.readOnly} onChange={(e) => ops.set(path, e.target.checked)} />
        {value ? 'true' : 'false'}
      </label>
    );
  }
  return <span className="muted">null</span>;
}

function NumberInput({ value, path, ops, label }: { value: number; path: PathSeg[]; ops: Ops; label: string }) {
  const [draft, setDraft] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(String(value));
  }
  const valid = draft.trim() !== '' && Number.isFinite(Number(draft));
  return (
    <input
      className="value number"
      inputMode="decimal"
      value={draft}
      readOnly={ops.readOnly}
      aria-label={`Value of ${label}`}
      aria-invalid={!valid || undefined}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n)) {
          setSeen(n);
          ops.set(path, n);
        }
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

function AddRow({ parent, path, ops }: { parent: Json[] | { [k: string]: Json }; path: PathSeg[]; ops: Ops }) {
  const isArray = Array.isArray(parent);
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<Kind>('string');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    if (isArray) {
      ops.set([...path, parent.length], convert('', kind));
      return;
    }
    const k = key.trim();
    if (!k) return setError('Enter a field name');
    if (Object.prototype.hasOwnProperty.call(parent, k)) return setError(`"${k}" already exists here`);
    ops.set([...path, k], convert('', kind));
    setKey('');
    setError(null);
  };

  return (
    <li className="add-row">
      <span className="twisty-spacer" />
      {!isArray && (
        <input
          className="key"
          placeholder="new field"
          value={key}
          aria-label="New field name"
          spellCheck={false}
          onChange={(e) => {
            setKey(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
      )}
      <select className="type" value={kind} aria-label="New field type" onChange={(e) => setKind(e.target.value as Kind)}>
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <button type="button" className="small" onClick={add}>
        {isArray ? '+ Add item' : '+ Add field'}
      </button>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}
