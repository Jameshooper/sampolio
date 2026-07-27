'use client';
/* eslint-disable react-hooks/set-state-in-effect -- the form resets and auto-maps columns when opened / when the pasted CSV changes */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { InputTextarea } from 'primereact/inputtextarea';
import { Dropdown } from 'primereact/dropdown';
import { Checkbox } from 'primereact/checkbox';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { parseSplitwiseCsv } from '@/lib/split-csv';
import { importSplitwiseCsv } from '@/lib/actions/split-groups';
import type { SplitGroup } from '@/types';

/**
 * Import a Splitwise CSV export into a group. Parses client-side (pure), lets
 * the user map each member column to a group member, previews the result, and
 * sends the normalized rows to the server.
 */
export function SplitImportDialog({
  visible,
  onHide,
  group,
  onImported,
}: {
  visible: boolean;
  onHide: () => void;
  group: SplitGroup;
  onImported: (n: number) => void;
}) {
  const [text, setText] = useState('');
  const [columnUserIds, setColumnUserIds] = useState<string[]>([]);
  const [replaceAll, setReplaceAll] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) {
      setText('');
      setColumnUserIds([]);
      setReplaceAll(true);
      setError('');
    }
  }, [visible]);

  const parsed = useMemo(() => (text.trim() ? parseSplitwiseCsv(text) : null), [text]);

  // Auto-map columns to members by fuzzy name match whenever the header changes.
  useEffect(() => {
    if (!parsed) return;
    setColumnUserIds(
      parsed.memberNames.map((mn) => {
        const lower = mn.toLowerCase();
        const match = group.members.find(
          (m) => lower.includes(m.name.toLowerCase().split(' ')[0]) || m.name.toLowerCase().includes(lower.split(' ')[0]),
        );
        return match?.userId ?? '';
      }),
    );
  }, [parsed, group.members]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const allMapped = parsed ? columnUserIds.length === parsed.memberNames.length && columnUserIds.every(Boolean) : false;

  const doImport = async () => {
    if (!parsed || parsed.rows.length === 0) return setError('Nothing to import');
    if (!allMapped) return setError('Map every column to a member');
    setSaving(true);
    setError('');
    const res = await importSplitwiseCsv({
      groupId: group.id,
      columnUserIds,
      rows: parsed.rows,
      replaceAll,
    });
    setSaving(false);
    if (!res.success) return setError(res.error ?? 'Import failed');
    onImported(res.data?.imported ?? parsed.rows.length);
    onHide();
  };

  return (
    <Dialog header="Import from Splitwise" visible={visible} onHide={onHide} modal dismissableMask style={{ width: '40rem' }}>
      <div className="flex flex-col gap-3 pt-1">
        <p className="text-sm text-gray-500">
          Paste your Splitwise CSV export (or upload the file). Then map each person column to a group member.
        </p>
        <div className="flex gap-2">
          <Button label="Upload CSV" outlined onClick={() => fileRef.current?.click()} />
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={onFile} />
        </div>
        <InputTextarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder="Date,Description,Category,Cost,Currency,Member A,Member B…"
          className="w-full font-mono text-xs"
        />

        {parsed && (
          <>
            {parsed.errors.length === 0 ? null : (
              <Message severity="warn" text={`${parsed.errors.length} row(s) skipped. First: ${parsed.errors[0]}`} />
            )}
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Map columns → members</span>
              {parsed.memberNames.map((mn, i) => (
                <div key={mn + i} className="flex items-center gap-2">
                  <span className="text-sm flex-1 truncate">{mn}</span>
                  <span className="text-gray-400">→</span>
                  <Dropdown
                    value={columnUserIds[i] ?? ''}
                    onChange={(e) => setColumnUserIds((p) => p.map((v, j) => (j === i ? e.value : v)))}
                    options={group.members.map((m) => ({ label: m.name, value: m.userId }))}
                    placeholder="Pick member"
                    className="w-48"
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Checkbox inputId="replaceAll" checked={replaceAll} onChange={(e) => setReplaceAll(!!e.checked)} />
              <label htmlFor="replaceAll" className="text-sm">
                Replace all existing expenses in this group
              </label>
            </div>
            <div className="text-sm text-gray-500">
              {parsed.rows.length} row(s) ready
              {parsed.warnings.length ? ` · ${parsed.warnings.length} warning(s)` : ''}
            </div>
          </>
        )}

        {error && <Message severity="error" text={error} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button label="Cancel" text onClick={onHide} disabled={saving} />
          <Button
            label={`Import ${parsed?.rows.length ?? 0} rows`}
            severity="success"
            loading={saving}
            disabled={!parsed || parsed.rows.length === 0}
            onClick={doImport}
          />
        </div>
      </div>
    </Dialog>
  );
}
