'use client';
/* eslint-disable react-hooks/set-state-in-effect -- the form intentionally resets its fields when the dialog opens */

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { MdClose } from 'react-icons/md';
import {
  createSplitGroup,
  updateSplitGroup,
  addSplitGroupMember,
  removeSplitGroupMember,
  updateSplitGroupMemberRole,
} from '@/lib/actions/split-groups';
import { CURRENCIES } from '@/lib/constants';
import type { Currency, SplitGroup, SplitGroupMemberRole } from '@/types';

const EMOJI_CHOICES = ['🏠', '💞', '✈️', '🍽️', '🎉', '🛒', '🚗', '🏖️', '👨‍👩‍👧', '💡'];
const ROLE_OPTIONS: { label: string; value: SplitGroupMemberRole }[] = [
  { label: 'Owner', value: 'owner' },
  { label: 'Member', value: 'member' },
];

export function GroupFormDialog({
  visible,
  onHide,
  group,
  onSaved,
}: {
  visible: boolean;
  onHide: () => void;
  group?: SplitGroup;
  onSaved: (groupId?: string) => void;
}) {
  const editing = !!group;
  const { data: session } = useSession();
  const myId = session?.user?.id ?? '';
  const myRole = group?.members.find((m) => m.userId === myId)?.role;
  const isOwner = myRole === 'owner';
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🏠');
  const [currency, setCurrency] = useState<Currency>('EUR');
  const [memberEmail, setMemberEmail] = useState('');
  const [pendingEmails, setPendingEmails] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    setName(group?.name ?? '');
    setEmoji(group?.emoji ?? '🏠');
    setCurrency(group?.currency ?? 'EUR');
    setMemberEmail('');
    setPendingEmails([]);
    setError('');
  }, [visible, group]);

  const addPartner = async () => {
    const email = memberEmail.trim();
    if (!email) return;
    if (editing && group) {
      setSaving(true);
      const res = await addSplitGroupMember(group.id, { email });
      setSaving(false);
      if (!res.success) return setError(res.error ?? 'Could not add member');
      setMemberEmail('');
      onSaved(group.id);
    } else {
      if (!pendingEmails.includes(email)) setPendingEmails((p) => [...p, email]);
      setMemberEmail('');
    }
  };

  const save = async () => {
    if (!name.trim()) return setError('Name is required');
    setSaving(true);
    setError('');
    if (editing && group) {
      const res = await updateSplitGroup(group.id, { name: name.trim(), emoji });
      setSaving(false);
      if (!res.success) return setError(res.error ?? 'Failed to save');
      onSaved(group.id);
      onHide();
    } else {
      const res = await createSplitGroup({
        name: name.trim(),
        emoji,
        currency,
        members: pendingEmails.map((email) => ({ email })),
      });
      setSaving(false);
      if (!res.success) return setError(res.error ?? 'Failed to create');
      onSaved(res.data?.id);
      onHide();
    }
  };

  return (
    <Dialog
      header={editing ? 'Group settings' : 'New split group'}
      visible={visible}
      onHide={onHide}
      modal
      dismissableMask
      style={{ width: '28rem' }}
    >
      <div className="flex flex-col gap-3 pt-1">
        <div className="flex items-center gap-2">
          <Dropdown
            value={emoji}
            onChange={(e) => setEmoji(e.value)}
            options={EMOJI_CHOICES.map((x) => ({ label: x, value: x }))}
            className="w-20"
          />
          <InputText value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name" className="flex-1" />
        </div>

        {!editing && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 w-20 shrink-0">Currency</span>
            <Dropdown
              value={currency}
              onChange={(e) => setCurrency(e.value)}
              options={CURRENCIES.map((c) => ({ label: `${c.symbol} ${c.value}`, value: c.value }))}
              className="flex-1"
            />
          </div>
        )}

        {/* Members */}
        <div className="flex flex-col gap-2">
          <span className="text-sm text-gray-500">Members</span>
          {editing &&
            group!.members.map((m) => (
              <div key={m.userId} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex-1 min-w-0 truncate">{m.name}</span>
                <div className="flex items-center gap-1 shrink-0">
                  {isOwner ? (
                    <Dropdown
                      value={m.role}
                      options={ROLE_OPTIONS}
                      className="w-28"
                      disabled={saving}
                      onChange={async (e) => {
                        const newRole = e.value as SplitGroupMemberRole;
                        if (newRole === m.role) return;
                        setSaving(true);
                        setError('');
                        const res = await updateSplitGroupMemberRole(group!.id, m.userId, newRole);
                        setSaving(false);
                        if (!res.success) return setError(res.error ?? 'Could not update role');
                        onSaved(group!.id);
                      }}
                    />
                  ) : (
                    <span className="text-xs text-gray-400 capitalize">{m.role}</span>
                  )}
                  {m.role !== 'owner' && (
                    <Button
                      icon={<MdClose />}
                      text
                      rounded
                      severity="danger"
                      onClick={async () => {
                        const res = await removeSplitGroupMember(group!.id, m.userId);
                        if (!res.success) setError(res.error ?? 'Could not remove');
                        else onSaved(group!.id);
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
          {!editing &&
            pendingEmails.map((e) => (
              <div key={e} className="flex items-center justify-between text-sm">
                <span>{e}</span>
                <Button icon={<MdClose />} text rounded onClick={() => setPendingEmails((p) => p.filter((x) => x !== e))} />
              </div>
            ))}
          <div className="flex gap-2">
            <InputText
              value={memberEmail}
              onChange={(e) => setMemberEmail(e.target.value)}
              placeholder="Partner's account email"
              className="flex-1"
              onKeyDown={(e) => e.key === 'Enter' && addPartner()}
            />
            <Button label="Add" outlined onClick={addPartner} disabled={saving} />
          </div>
        </div>

        {error && <Message severity="error" text={error} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button label="Cancel" text onClick={onHide} disabled={saving} />
          <Button label={editing ? 'Save' : 'Create group'} severity="success" loading={saving} onClick={save} />
        </div>
      </div>
    </Dialog>
  );
}
