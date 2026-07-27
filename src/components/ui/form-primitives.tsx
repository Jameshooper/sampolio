'use client';

/**
 * Small shared form/display primitives used across entity editors (the entity
 * list drawer and the mortgage components). Extracted so both surfaces share one
 * implementation — no behavior change from their original definitions inside
 * entity-list-drawer.tsx.
 */

import { Button } from 'primereact/button';
import { Calendar } from 'primereact/calendar';
import { Tag } from 'primereact/tag';
import { MdEdit, MdDelete, MdReplay, MdArchive, MdExpandLess, MdExpandMore, MdAdd } from 'react-icons/md';

/** Convert a YYYY-MM string to a Date (1st of that month). */
export function yearMonthToDate(ym: string): Date | null {
  if (!ym) return null;
  const [year, month] = ym.split('-').map(Number);
  if (!year || !month) return null;
  return new Date(year, month - 1, 1);
}

/** Convert a Date to a YYYY-MM string. */
export function dateToYearMonth(date: Date | null | undefined): string {
  if (!date) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** A small caption that teaches/explains a field. */
export function HelpTip({ text }: { text: string }) {
  return <small className="block mt-1 opacity-60">{text}</small>;
}

/** A month (YYYY-MM) picker. */
export function MonthPicker({
  value,
  onChange,
  placeholder,
  helpText,
}: {
  value: string;
  onChange: (ym: string) => void;
  placeholder?: string;
  helpText?: string;
}) {
  return (
    <div>
      <Calendar
        value={yearMonthToDate(value)}
        onChange={(e) => onChange(dateToYearMonth(e.value as Date))}
        view="month"
        dateFormat="yy-mm"
        placeholder={placeholder || 'Select month'}
        showIcon
        className="w-full"
      />
      {helpText && <HelpTip text={helpText} />}
    </div>
  );
}

/** A card for one entity with edit / archive / delete / expand actions. */
export function ItemCard({
  name,
  subtitle,
  tags,
  onEdit,
  onArchive,
  isArchived,
  onDelete,
  onExpand,
  isExpanded,
  expandLabel,
}: {
  name: string;
  subtitle: string;
  tags?: { label: string; severity: 'success' | 'warning' | 'danger' | 'info' | 'secondary' }[];
  onEdit: () => void;
  onArchive: () => void;
  isArchived?: boolean;
  onDelete: () => void;
  onExpand?: () => void;
  isExpanded?: boolean;
  expandLabel?: string;
}) {
  return (
    <div className="p-3 rounded-lg surface-ground">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm truncate">{name}</h3>
            {tags?.map((t) => <Tag key={t.label} value={t.label} severity={t.severity} className="text-xs" />)}
          </div>
          <p className="text-xs mt-0.5 opacity-60">{subtitle}</p>
        </div>
      </div>
      {/* Labels show on mobile (no hover → no tooltips there) and collapse to
          icon-only + tooltip on lg+. */}
      <div className="flex items-center gap-1 mt-2 pt-2 border-t surface-border">
        <Button icon={<MdEdit />} label="Edit" severity="secondary" text size="small" tooltip="Edit" tooltipOptions={{ position: 'top', showOnDisabled: false }} onClick={onEdit} className="lg:[&_.p-button-label]:hidden" aria-label="Edit" />
        <Button icon={isArchived ? <MdReplay /> : <MdArchive />} label={isArchived ? 'Restore' : 'Archive'} severity="secondary" text size="small" tooltip={isArchived ? 'Restore' : 'Archive'} tooltipOptions={{ position: 'top' }} onClick={onArchive} className="lg:[&_.p-button-label]:hidden" aria-label={isArchived ? 'Restore' : 'Archive'} />
        <Button icon={<MdDelete />} label="Delete" severity="danger" text size="small" tooltip="Delete" tooltipOptions={{ position: 'top' }} onClick={onDelete} className="lg:[&_.p-button-label]:hidden" aria-label="Delete" />
        {onExpand && (
          <Button
            icon={isExpanded ? <MdExpandLess /> : <MdExpandMore />}
            severity="secondary"
            text
            size="small"
            tooltip={isExpanded ? `Hide ${expandLabel}` : `Show ${expandLabel}`}
            tooltipOptions={{ position: 'top' }}
            onClick={onExpand}
            className="ml-auto"
          />
        )}
      </div>
    </div>
  );
}

/** A nested list of sub-entities (e.g. rate history, extra payments) with add/edit/delete. */
export function SubEntityList({
  title,
  items,
  onAdd,
  onEditItem,
  onDeleteItem,
  addLabel,
}: {
  title?: string;
  items: { id: string; label: string; detail: string; inactive?: boolean }[];
  onAdd: () => void;
  onEditItem?: (id: string) => void;
  onDeleteItem: (id: string) => void;
  addLabel: string;
}) {
  return (
    <div className="ml-4 mb-3 border-l surface-border pl-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold opacity-60">{title || addLabel.replace('Add ', '')}</span>
        <Button icon={<MdAdd />} size="small" text onClick={onAdd} tooltip={addLabel} tooltipOptions={{ position: 'top' }} />
      </div>
      {items.length === 0 ? (
        <p className="text-xs opacity-40">None yet</p>
      ) : (
        <div className="space-y-1">
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between p-1.5 rounded text-xs surface-ground">
              <div className="flex-1 min-w-0">
                <span>{item.label}</span>
                <span className="ml-2 opacity-50">{item.detail}</span>
                {item.inactive && <Tag value="Inactive" severity="secondary" className="ml-1 text-xs" />}
              </div>
              <div className="flex gap-0.5">
                {onEditItem && <Button icon={<MdEdit />} size="small" text severity="secondary" tooltip="Edit" tooltipOptions={{ position: 'top' }} aria-label="Edit" onClick={() => onEditItem(item.id)} />}
                <Button icon={<MdDelete />} size="small" text severity="danger" tooltip="Delete" tooltipOptions={{ position: 'top' }} aria-label="Delete" onClick={() => onDeleteItem(item.id)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
