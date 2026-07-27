'use client';

import { useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Password } from 'primereact/password';
import { InputText } from 'primereact/inputtext';
import { Checkbox } from 'primereact/checkbox';
import { Dialog } from 'primereact/dialog';
import { confirmDialog } from 'primereact/confirmdialog';
import { ProgressSpinner } from 'primereact/progressspinner';
import { MdLock, MdWarning, MdDeleteSweep, MdDeleteForever, MdPhotoCamera } from 'react-icons/md';
import { useAppContext } from '@/components/layout/app-layout';
import { useToast } from '@/components/providers/toast-provider';
import { changeMyPassword, getAccountDeletionPreflight, deleteMyAccount, resetMyData, updateMyAvatar } from '@/lib/actions/account';
import { changePasswordSchema, type ChangePasswordFormData } from '@/lib/schemas/auth.schema';
import { UserAvatar } from '@/components/ui/user-avatar';
import { AvatarEditorDialog } from '@/components/ui/avatar-editor-dialog';
import { useUserProfiles, invalidateUserProfiles } from '@/lib/hooks/use-user-profiles';
import type { AccountDeletionPreflight } from '@/types';

interface AccountPanelProps {
    isDark: boolean;
}

export function AccountPanel({ isDark }: AccountPanelProps) {
    const { data: session } = useSession();
    const router = useRouter();
    const appContext = useAppContext();
    const toast = useToast();

    const heading = `text-lg font-semibold mb-4 ${isDark ? 'text-gray-100' : 'text-gray-900'}`;
    const subtext = `text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`;

    // ---- Profile picture ----
    const myId = session?.user?.id;
    const myName = session?.user?.name || session?.user?.email || 'You';
    const profiles = useUserProfiles(myId ? [myId] : []);
    const myAvatarUrl = myId ? profiles[myId]?.avatarUrl : undefined;
    const [avatarDialogVisible, setAvatarDialogVisible] = useState(false);

    const handleSaveAvatar = async (dataUri: string | null) => {
        const result = await updateMyAvatar(dataUri);
        if (result.success) {
            if (myId) invalidateUserProfiles([myId]);
            toast.success(
                dataUri ? 'Photo updated' : 'Photo removed',
                dataUri ? 'Your new profile picture is set.' : 'Your profile picture was removed.'
            );
        }
        return result;
    };

    // ---- Change password ----
    const {
        control,
        handleSubmit,
        reset,
        formState: { errors },
    } = useForm<ChangePasswordFormData>({
        resolver: zodResolver(changePasswordSchema),
        defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
    });
    const [isChangingPassword, setIsChangingPassword] = useState(false);

    const onChangePassword = async (data: ChangePasswordFormData) => {
        setIsChangingPassword(true);
        try {
            const result = await changeMyPassword(data);
            if (result.success) {
                toast.success('Password updated', 'Use your new password next time you sign in.');
                reset();
            } else {
                toast.error('Could not update password', result.error);
            }
        } finally {
            setIsChangingPassword(false);
        }
    };

    // ---- Start fresh ----
    const [resetDialogVisible, setResetDialogVisible] = useState(false);
    const [resetUnderstood, setResetUnderstood] = useState(false);
    const [isResetting, setIsResetting] = useState(false);

    const handleStartFresh = () => {
        confirmDialog({
            header: 'Start fresh?',
            icon: 'pi pi-exclamation-triangle',
            acceptClassName: 'p-button-danger',
            acceptLabel: 'Delete my data',
            message: 'This cannot be undone.',
            accept: async () => {
                setIsResetting(true);
                try {
                    const result = await resetMyData();
                    if (result.success) {
                        toast.success('Data cleared', 'Your account is now a blank slate.');
                        setResetDialogVisible(false);
                        setResetUnderstood(false);
                        appContext?.refreshData();
                        router.refresh();
                    } else {
                        toast.error('Could not reset your data', result.error);
                    }
                } finally {
                    setIsResetting(false);
                }
            },
        });
    };

    // ---- Delete account ----
    const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
    const [isLoadingPreflight, setIsLoadingPreflight] = useState(false);
    const [preflight, setPreflight] = useState<AccountDeletionPreflight | null>(null);
    const [confirmationText, setConfirmationText] = useState('');
    const [isDeleting, setIsDeleting] = useState(false);

    const openDeleteDialog = async () => {
        setDeleteDialogVisible(true);
        setConfirmationText('');
        setPreflight(null);
        setIsLoadingPreflight(true);
        try {
            const result = await getAccountDeletionPreflight();
            if (result.success && result.data) {
                setPreflight(result.data);
            } else {
                toast.error('Could not check your account', result.error);
                setDeleteDialogVisible(false);
            }
        } finally {
            setIsLoadingPreflight(false);
        }
    };

    const emailMatches =
        !!session?.user?.email &&
        confirmationText.trim().toLowerCase() === session.user.email.trim().toLowerCase();

    const handleDeleteAccount = () => {
        confirmDialog({
            header: 'Permanently delete your account?',
            icon: 'pi pi-exclamation-triangle',
            acceptClassName: 'p-button-danger',
            acceptLabel: 'Delete everything',
            message: 'This cannot be undone.',
            accept: async () => {
                setIsDeleting(true);
                try {
                    const result = await deleteMyAccount({ confirmationText });
                    if (result.success) {
                        toast.success('Account deleted', 'Signing you out…');
                        await signOut({ callbackUrl: '/auth/signin' });
                    } else {
                        toast.error('Could not delete your account', result.error);
                        setIsDeleting(false);
                    }
                } catch {
                    setIsDeleting(false);
                }
            },
        });
    };

    return (
        <div className="space-y-6">
            <Card>
                <h2 className={heading}>Profile picture</h2>
                <div className="flex items-center gap-4">
                    {myId && <UserAvatar userId={myId} name={myName} avatarUrl={myAvatarUrl} size={64} />}
                    <div className="flex flex-col gap-2 min-w-0">
                        <p className={subtext}>
                            Shows next to your name in shared split groups and mortgages.
                        </p>
                        <div>
                            <Button
                                label="Change photo"
                                icon={<MdPhotoCamera />}
                                outlined
                                onClick={() => setAvatarDialogVisible(true)}
                            />
                        </div>
                    </div>
                </div>
            </Card>

            <Card>
                <h2 className={heading}>Change password</h2>
                <form onSubmit={handleSubmit(onChangePassword)} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
                        <div className="flex flex-col gap-2">
                            <label htmlFor="currentPassword" className={isDark ? 'text-gray-300' : 'text-gray-700'}>
                                Current password
                            </label>
                            <Controller
                                name="currentPassword"
                                control={control}
                                render={({ field }) => (
                                    <Password
                                        inputId="currentPassword"
                                        value={field.value}
                                        onChange={(e) => field.onChange(e.target.value)}
                                        feedback={false}
                                        toggleMask
                                        className="w-full"
                                        inputClassName="w-full"
                                        autoComplete="current-password"
                                    />
                                )}
                            />
                            {errors.currentPassword && <small className="text-red-500">{errors.currentPassword.message}</small>}
                        </div>

                        <div />

                        <div className="flex flex-col gap-2">
                            <label htmlFor="newPassword" className={isDark ? 'text-gray-300' : 'text-gray-700'}>
                                New password
                            </label>
                            <Controller
                                name="newPassword"
                                control={control}
                                render={({ field }) => (
                                    <Password
                                        inputId="newPassword"
                                        value={field.value}
                                        onChange={(e) => field.onChange(e.target.value)}
                                        feedback
                                        toggleMask
                                        className="w-full"
                                        inputClassName="w-full"
                                        autoComplete="new-password"
                                    />
                                )}
                            />
                            {errors.newPassword && <small className="text-red-500">{errors.newPassword.message}</small>}
                        </div>

                        <div className="flex flex-col gap-2">
                            <label htmlFor="confirmPassword" className={isDark ? 'text-gray-300' : 'text-gray-700'}>
                                Confirm new password
                            </label>
                            <Controller
                                name="confirmPassword"
                                control={control}
                                render={({ field }) => (
                                    <Password
                                        inputId="confirmPassword"
                                        value={field.value}
                                        onChange={(e) => field.onChange(e.target.value)}
                                        feedback={false}
                                        toggleMask
                                        className="w-full"
                                        inputClassName="w-full"
                                        autoComplete="new-password"
                                    />
                                )}
                            />
                            {errors.confirmPassword && <small className="text-red-500">{errors.confirmPassword.message}</small>}
                        </div>
                    </div>

                    <div className="flex justify-end max-w-2xl">
                        <Button type="submit" label="Update password" icon={<MdLock />} loading={isChangingPassword} />
                    </div>
                </form>
            </Card>

            <Card className="border-2 border-red-300 dark:border-red-800">
                <h2 className={`${heading} text-red-600 dark:text-red-400`}>Danger zone</h2>

                <div className="space-y-6">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <p className={isDark ? 'text-gray-200' : 'text-gray-700'}>Start fresh</p>
                            <p className={subtext}>
                                Wipe all of your financial data (accounts, items, investments, debts, goals, budgets,
                                trips, check-ins, bank connections) but keep your login and preferences.
                            </p>
                        </div>
                        <Button
                            label="Start fresh…"
                            icon={<MdDeleteSweep />}
                            outlined
                            severity="danger"
                            className="w-full sm:w-auto shrink-0"
                            onClick={() => setResetDialogVisible(true)}
                        />
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <p className={isDark ? 'text-gray-200' : 'text-gray-700'}>Delete account</p>
                            <p className={subtext}>
                                Permanently delete your account and every bit of data tied to it. This cannot be undone.
                            </p>
                        </div>
                        <Button
                            label="Delete account…"
                            icon={<MdDeleteForever />}
                            severity="danger"
                            className="w-full sm:w-auto shrink-0"
                            onClick={openDeleteDialog}
                        />
                    </div>
                </div>
            </Card>

            {/* Start fresh dialog */}
            <Dialog
                header="Start fresh?"
                visible={resetDialogVisible}
                onHide={() => {
                    setResetDialogVisible(false);
                    setResetUnderstood(false);
                }}
                style={{ width: '30rem' }}
                modal
                draggable={false}
                footer={
                    <div className="flex justify-end gap-2">
                        <Button
                            label="Cancel"
                            severity="secondary"
                            text
                            onClick={() => {
                                setResetDialogVisible(false);
                                setResetUnderstood(false);
                            }}
                            disabled={isResetting}
                        />
                        <Button
                            label="Start fresh"
                            icon={<MdDeleteSweep />}
                            severity="danger"
                            disabled={!resetUnderstood}
                            loading={isResetting}
                            onClick={handleStartFresh}
                        />
                    </div>
                }
            >
                <div className="space-y-4">
                    <div>
                        <p className={`text-sm font-medium mb-1 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>
                            This wipes:
                        </p>
                        <ul className={`list-disc pl-5 text-sm space-y-0.5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                            <li>Accounts &amp; balances</li>
                            <li>Recurring and planned income/expense items</li>
                            <li>Investments, debts, receivables</li>
                            <li>Goals, budgets, trips</li>
                            <li>Check-in (reconciliation) history</li>
                            <li>Bank connections — connections will be disconnected and bank consents revoked</li>
                        </ul>
                    </div>
                    <div>
                        <p className={`text-sm font-medium mb-1 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>
                            This keeps:
                        </p>
                        <ul className={`list-disc pl-5 text-sm space-y-0.5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                            <li>Your login and preferences</li>
                            <li>Shared split groups and shared mortgages — shared data is not touched</li>
                        </ul>
                    </div>
                    <div className="flex items-start gap-2">
                        <Checkbox
                            inputId="reset-understood"
                            checked={resetUnderstood}
                            onChange={(e) => setResetUnderstood(e.checked ?? false)}
                        />
                        <label htmlFor="reset-understood" className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                            I understand this permanently deletes my financial data
                        </label>
                    </div>
                </div>
            </Dialog>

            {/* Delete account dialog */}
            <Dialog
                header="Delete account"
                visible={deleteDialogVisible}
                onHide={() => setDeleteDialogVisible(false)}
                style={{ width: '32rem' }}
                modal
                draggable={false}
                footer={
                    <div className="flex justify-end gap-2">
                        <Button
                            label="Cancel"
                            severity="secondary"
                            text
                            onClick={() => setDeleteDialogVisible(false)}
                            disabled={isDeleting}
                        />
                        <Button
                            label="Delete everything"
                            icon={<MdDeleteForever />}
                            severity="danger"
                            disabled={!preflight || preflight.blockers.length > 0 || !emailMatches}
                            loading={isDeleting}
                            onClick={handleDeleteAccount}
                        />
                    </div>
                }
            >
                {isLoadingPreflight ? (
                    <div className="flex justify-center py-8">
                        <ProgressSpinner style={{ width: '2.5rem', height: '2.5rem' }} />
                    </div>
                ) : preflight && preflight.blockers.length > 0 ? (
                    <div className="space-y-3">
                        <p className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                            Resolve the following before you can delete your account:
                        </p>
                        <ul className="space-y-2">
                            {preflight.blockers.map((b, i) => (
                                <li key={i} className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
                                    <MdWarning className="mt-0.5 shrink-0" />
                                    <span>{b.message}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : preflight ? (
                    <div className="space-y-4">
                        <div>
                            <p className={`text-sm font-medium mb-1 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>
                                This will permanently delete:
                            </p>
                            <ul className={`list-disc pl-5 text-sm space-y-0.5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                                <li>{preflight.summary.accounts} account(s), all items, investments, debts, receivables</li>
                                <li>{preflight.summary.goals} goal(s), {preflight.summary.budgets} budget(s), {preflight.summary.trips} trip(s)</li>
                                <li>{preflight.summary.bankConnections} bank connection(s) — consents revoked</li>
                                {preflight.summary.splitGroupsToDelete > 0 && (
                                    <li>{preflight.summary.splitGroupsToDelete} split group(s) you are the only member of</li>
                                )}
                                {preflight.summary.mortgagesToDelete > 0 && (
                                    <li>{preflight.summary.mortgagesToDelete} shared mortgage(s) you are the only member of</li>
                                )}
                                <li>Your login and preferences</li>
                            </ul>
                        </div>
                        {(preflight.summary.splitGroupsToLeave > 0 || preflight.summary.mortgagesToLeave > 0) && (
                            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                                You will leave {preflight.summary.splitGroupsToLeave} shared split group(s) and{' '}
                                {preflight.summary.mortgagesToLeave} shared mortgage(s) — those stay intact for the other members.
                            </p>
                        )}
                        <p className="text-sm font-medium text-red-600 dark:text-red-400">This cannot be undone.</p>
                        <div className="flex flex-col gap-2">
                            <label htmlFor="delete-confirm-email" className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                                Type your email ({session?.user?.email}) to confirm
                            </label>
                            <InputText
                                id="delete-confirm-email"
                                value={confirmationText}
                                onChange={(e) => setConfirmationText(e.target.value)}
                                className="w-full"
                                autoComplete="off"
                            />
                        </div>
                    </div>
                ) : null}
            </Dialog>

            {/* Profile picture editor */}
            {myId && (
                <AvatarEditorDialog
                    visible={avatarDialogVisible}
                    onHide={() => setAvatarDialogVisible(false)}
                    currentAvatarUrl={myAvatarUrl}
                    userName={myName}
                    userId={myId}
                    onSave={handleSaveAvatar}
                />
            )}
        </div>
    );
}
