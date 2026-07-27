'use client';

import { useMemo, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { InputTextarea } from 'primereact/inputtextarea';
import { Checkbox } from 'primereact/checkbox';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { importMortgageActuals, clearMortgageActuals } from '@/lib/actions/shared-mortgages';
import type { SharedMortgage, MortgageActualInput } from '@/types';

/** Lenient number parse: handles "1 234,56" (fi), "1.234,56", and "1234.56". */
function parseNum(raw: string): number | null {
  let s = raw.trim().replace(/\s/g, '').replace(/[€$£]/g, '');
  if (!s) return null;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // assume '.' thousands, ',' decimal (Finnish)
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

interface ParseResult {
  entries: MortgageActualInput[];
  errors: string[];
}

export function MortgageImportDialog({
  visible,
  mortgage,
  hasActuals,
  onClose,
  onImported,
}: {
  visible: boolean;
  mortgage: SharedMortgage;
  hasActuals: boolean;
  onClose: () => void;
  onImported: (msg: string) => void;
}) {
  const [text, setText] = useState('');
  const [replaceAll, setReplaceAll] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Map a CSV loan token → loan id (accepts id, kind, or label, case-insensitive).
  const loanLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of mortgage.loans) {
      map.set(l.id.toLowerCase(), l.id);
      map.set(l.kind.toLowerCase(), l.id);
      map.set(l.label.toLowerCase(), l.id);
      map.set(l.label.toLowerCase().replace(/\s*loan\s*/g, '').trim(), l.id);
    }
    return map;
  }, [mortgage.loans]);

  const parsed = useMemo<ParseResult>(() => {
    const entries: MortgageActualInput[] = [];
    const errors: string[] = [];
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    lines.forEach((line, i) => {
      const cols = line.split(/[,;\t]/).map((c) => c.trim());
      // Skip a header row.
      if (i === 0 && /month|loan|remaining/i.test(line)) return;
      if (cols.length < 6) {
        errors.push(`Line ${i + 1}: expected 6 columns (month, loan, remaining, repayment, interest, insurance) — subsidy optional`);
        return;
      }
      const [month, loanTok, rem, rep, intr, ins, sub] = cols;
      if (!/^\d{4}-\d{2}$/.test(month)) {
        errors.push(`Line ${i + 1}: bad month "${month}" (use YYYY-MM)`);
        return;
      }
      const loanId = loanLookup.get(loanTok.toLowerCase());
      if (!loanId) {
        errors.push(`Line ${i + 1}: unknown loan "${loanTok}"`);
        return;
      }
      const remaining = parseNum(rem), repayment = parseNum(rep), interest = parseNum(intr), insurance = parseNum(ins);
      // Subsidy column is optional; a blank/missing value means €0.
      const subsidy = sub != null && sub !== '' ? parseNum(sub) : 0;
      if (remaining == null || repayment == null || interest == null || insurance == null || subsidy == null) {
        errors.push(`Line ${i + 1}: non-numeric value`);
        return;
      }
      entries.push({ loanId, yearMonth: month, remaining: Math.abs(remaining), repayment: Math.abs(repayment), interest: Math.abs(interest), insurance: Math.abs(insurance), subsidy: Math.abs(subsidy) });
    });
    return { entries, errors };
  }, [text, loanLookup]);

  const loanNames = mortgage.loans.map((l) => `${l.label} → "${l.kind}"`).join(', ');
  const example = `month,loan,remaining,repayment,interest,insurance,subsidy\n2023-02,${mortgage.loans[0]?.kind ?? 'asp'},100000,450.00,448.00,0,0`;

  const doImport = async () => {
    if (parsed.entries.length === 0) { setError('Nothing to import'); return; }
    setSaving(true);
    setError('');
    const res = await importMortgageActuals(mortgage.id, { entries: parsed.entries, replaceAll });
    setSaving(false);
    if (res.success) onImported(`Imported ${res.data?.imported ?? parsed.entries.length} monthly rows.`);
    else setError(res.error ?? 'Import failed');
  };

  const doClear = async () => {
    if (!confirm('Remove all imported history? Sampolio will go back to projecting from terms.')) return;
    setSaving(true);
    const res = await clearMortgageActuals(mortgage.id);
    setSaving(false);
    if (res.success) onImported('Imported history cleared.');
    else setError(res.error ?? 'Failed to clear');
  };

  return (
    <Dialog header="Import actual monthly history" visible={visible} onHide={onClose} style={{ width: '42rem' }} maximizable>
      <p className="text-sm opacity-70 mb-2">
        Paste one row per loan per month so the ledger matches your bank exactly. Sampolio uses these figures for
        the recorded months and projects only beyond the latest one.
      </p>
      <div className="text-xs opacity-70 mb-2 p-2 rounded surface-ground">
        <div className="font-medium mb-1">Columns (comma, semicolon or tab separated):</div>
        <code>month, loan, remaining, repayment, interest, insurance, subsidy</code>
        <ul className="list-disc ml-5 mt-1 space-y-0.5">
          <li><b>month</b>: YYYY-MM · <b>loan</b>: {loanNames}</li>
          <li><b>remaining</b>: balance left after the month · <b>repayment</b>: the bank&apos;s total charge for the loan (incl. insurance)</li>
          <li><b>interest</b> and <b>insurance</b>: that month&apos;s amounts (positive numbers)</li>
          <li><b>subsidy</b> (optional): government ASP interest subsidy that month — leave blank or 0 when none</li>
        </ul>
        <div className="mt-1">Example:<br /><code className="whitespace-pre">{example}</code></div>
      </div>

      <InputTextarea value={text} onChange={(e) => setText(e.target.value)} rows={10} className="w-full font-mono text-xs" placeholder="Paste your rows here…" />

      <div className="flex items-center gap-2 mt-2">
        <Checkbox inputId="replaceAll" checked={replaceAll} onChange={(e) => setReplaceAll(!!e.checked)} />
        <label htmlFor="replaceAll" className="text-sm">Replace all existing imported history</label>
      </div>

      {parsed.entries.length > 0 && (
        <Message severity="info" className="mt-2 block" text={`Ready to import ${parsed.entries.length} rows${parsed.errors.length ? `, skipping ${parsed.errors.length} bad line(s)` : ''}.`} />
      )}
      {parsed.errors.length > 0 && (
        <div className="mt-2 text-xs text-red-500 max-h-24 overflow-auto">{parsed.errors.slice(0, 8).map((e, i) => <div key={i}>{e}</div>)}</div>
      )}
      {error && <Message severity="error" className="mt-2 block" text={error} />}

      <div className="flex justify-between items-center mt-4">
        {hasActuals ? (
          <Button label="Clear imported history" text severity="danger" onClick={doClear} disabled={saving} />
        ) : <span />}
        <div className="flex gap-2">
          <Button label="Cancel" text onClick={onClose} disabled={saving} />
          <Button label="Import" loading={saving} onClick={doImport} disabled={parsed.entries.length === 0} />
        </div>
      </div>
    </Dialog>
  );
}
