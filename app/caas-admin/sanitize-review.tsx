'use client';
import type { SanitizedValue } from './api';

/** What the safety checks would remove, with before/after, before anything is saved. */
export function SanitizeReview({
  changes,
  busy,
  onSave,
  onCancel,
  saveLabel = 'Save with these changes',
}: {
  changes: SanitizedValue[];
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
  saveLabel?: string;
}) {
  return (
    <section className="card warn review" aria-labelledby="review-title">
      <h3 id="review-title">
        {changes.length} value{changes.length === 1 ? '' : 's'} contain{changes.length === 1 ? 's' : ''} HTML the safety checks will remove
      </h3>
      <p className="muted small">
        Everything else is saved as is. If the removed markup is needed and safe, ask for it to be allowed with CAAS_HTML_EXTRA_TAGS,
        CAAS_HTML_EXTRA_ATTRIBUTES or CAAS_HTML_IFRAME_HOSTS (environment or global.properties) instead of saving without it.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Removed</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {changes.slice(0, 200).map((c, i) => (
              <tr key={`${c.index ?? ''}${c.pointer}${i}`}>
                <th scope="row">
                  <code>{`${c.index !== undefined ? `entry ${c.index} ` : ''}${c.pointer || '(root)'}`}</code>
                </th>
                <td>{c.reason.replace(/^removed /, '')}</td>
                <td>
                  <code>{c.before ?? ''}</code>
                </td>
                <td>
                  <code>{c.after ?? ''}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {changes.length > 200 && <p className="muted small">…and {changes.length - 200} more</p>}
      </div>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={onSave}>
          {saveLabel}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel, keep editing
        </button>
      </div>
    </section>
  );
}
