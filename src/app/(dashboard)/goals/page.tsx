'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { Button } from 'primereact/button';
import { confirmDialog } from 'primereact/confirmdialog';
import { ListPageSkeleton } from '@/components/ui/skeletons';
import { MdAdd, MdFlag } from 'react-icons/md';
import { useAppContext } from '@/components/layout/app-layout';
import { useToast } from '@/components/providers/toast-provider';
import { getGoals, updateGoal, deleteGoal } from '@/lib/actions/goals';
import { getAccounts } from '@/lib/actions/accounts';
import { getProjection } from '@/lib/actions/projection';
import { calculateGoalProgress, computeGoalPlan } from '@/lib/goal-utils';
import { fetchWealthProjectionMonths } from '@/lib/wealth-assembly';
import { GoalCard } from '@/components/goals/goal-card';
import { GoalDialog } from '@/components/goals/goal-dialog';
import type { FinancialAccount, Goal, MonthlyProjection, WealthProjectionMonth } from '@/types';

export default function GoalsPage() {
  const appContext = useAppContext();
  const toast = useToast();
  const { data: session } = useSession();

  const [isLoading, setIsLoading] = useState(true);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [cashProjections, setCashProjections] = useState<Map<string, MonthlyProjection[]>>(new Map());
  const [wealthMonths, setWealthMonths] = useState<WealthProjectionMonth[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const hasLoadedOnce = useRef(false);

  const userId = session?.user?.id;

  const fetchData = useCallback(async () => {
    if (!hasLoadedOnce.current) setIsLoading(true);
    try {
      const [goalsRes, accountsRes] = await Promise.all([getGoals(), getAccounts()]);
      const loadedGoals = goalsRes.success && goalsRes.data ? goalsRes.data : [];
      setGoals(loadedGoals);
      setAccounts(accountsRes.success && accountsRes.data ? accountsRes.data : []);

      // Projections only for the accounts goals actually track.
      const activeGoals = loadedGoals.filter((g) => !g.isArchived);
      const linkedAccountIds = [...new Set(
        activeGoals
          .filter((g) => g.trackingMethod === 'account-balance' && g.linkedAccountId)
          .map((g) => g.linkedAccountId as string)
      )];
      const projectionResults = await Promise.all(
        linkedAccountIds.map((id) =>
          getProjection(id).then((r) => [id, r.success && r.data ? r.data.monthly : []] as [string, MonthlyProjection[]])
        )
      );
      setCashProjections(new Map(projectionResults));

      // The full wealth projection is needed for net-worth goals directly, AND
      // for the joint plan whenever ANY non-manual goal exists — an
      // account-balance goal's claim also reduces the net-worth pool for
      // later net-worth goals (see computeGoalPlan in goal-utils.ts).
      if (activeGoals.some((g) => g.trackingMethod !== 'manual')) {
        setWealthMonths(await fetchWealthProjectionMonths(userId));
      } else {
        setWealthMonths([]);
      }
    } catch (err) {
      console.error('Failed to load goals:', err);
    } finally {
      hasLoadedOnce.current = true;
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { if (appContext) appContext.setRefreshCallback(fetchData); }, [appContext, fetchData]);

  const warningFor = (goal: Goal): string | undefined => {
    if (goal.trackingMethod === 'account-balance' && goal.linkedAccountId && !accounts.some((a) => a.id === goal.linkedAccountId)) {
      return 'The linked account no longer exists — edit the goal to pick another.';
    }
    return undefined;
  };

  // Active goals share pools (an account's balance, or net worth) — plan them
  // jointly so cards reflect what's actually left for each goal once earlier
  // (higher-priority / earlier-dated) goals have claimed their share.
  const activeGoals = goals.filter((g) => !g.isArchived);
  const goalPlan = useMemo(
    () => computeGoalPlan(activeGoals, cashProjections, wealthMonths),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeGoals.map((g) => g.id).join(','), activeGoals.map((g) => g.updatedAt).join(','), cashProjections, wealthMonths]
  );

  const openCreate = () => { setEditingGoal(null); setDialogOpen(true); };
  const openEdit = (goal: Goal) => { setEditingGoal(goal); setDialogOpen(true); };

  const handleToggleArchive = async (goal: Goal) => {
    const res = await updateGoal(goal.id, { isArchived: !goal.isArchived });
    if (res.success) {
      toast.success(goal.isArchived ? 'Goal unarchived' : 'Goal archived', goal.name);
      fetchData();
    } else {
      toast.error('Error', res.error || 'Failed to update goal');
    }
  };

  const handleDelete = (goal: Goal) => {
    confirmDialog({
      message: `Delete "${goal.name}"? This cannot be undone.`,
      header: 'Delete goal',
      icon: 'pi pi-trash',
      acceptClassName: 'p-button-danger',
      accept: async () => {
        const res = await deleteGoal(goal.id);
        if (res.success) {
          toast.success('Goal deleted', goal.name);
          fetchData();
        } else {
          toast.error('Error', res.error || 'Failed to delete goal');
        }
      },
    });
  };

  const active = activeGoals;
  const archived = goals.filter((g) => g.isArchived);

  if (isLoading) {
    return <ListPageSkeleton />;
  }

  // Active goals render in plan order (priority, then target date, then name)
  // with the joint-plan context; archived goals keep the standalone
  // calculateGoalProgress path (no pool claims — they're no longer competing).
  const renderActiveGrid = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {goalPlan.entries.map(({ goal: g, progress, competingGoalIds, requiredMonthlySaving, targetDatePassed }) => (
        <GoalCard
          key={g.id}
          goal={g}
          progress={progress}
          warning={warningFor(g)}
          plan={{ competingGoalIds, requiredMonthlySaving, targetDatePassed }}
          onEdit={() => openEdit(g)}
          onToggleArchive={() => handleToggleArchive(g)}
          onDelete={() => handleDelete(g)}
        />
      ))}
    </div>
  );

  const renderArchivedGrid = (list: Goal[]) => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {list.map((g) => {
        const progress = calculateGoalProgress(g, cashProjections, wealthMonths);
        return (
          <GoalCard
            key={g.id}
            goal={g}
            progress={progress}
            warning={warningFor(g)}
            onEdit={() => openEdit(g)}
            onToggleArchive={() => handleToggleArchive(g)}
            onDelete={() => handleDelete(g)}
          />
        );
      })}
    </div>
  );

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Goals</h1>
          <p className="text-sm opacity-60">Set savings targets and see when your plan reaches them.</p>
        </div>
        <Button label="New goal" icon={<MdAdd />} className="shrink-0 self-start sm:self-auto" onClick={openCreate} />
      </div>

      {active.length === 0 && archived.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <MdFlag size={48} className="opacity-30 mb-4" />
          <p className="text-lg font-medium mb-1">Set your first goal</p>
          <p className="text-sm opacity-60 max-w-md mb-4">
            A target amount and a date — Sampolio tracks it against an account&apos;s projected balance,
            your total net worth, or a number you update yourself.
          </p>
          <Button label="New goal" icon={<MdAdd />} onClick={openCreate} />
        </div>
      ) : (
        <>
          {renderActiveGrid()}
          {archived.length > 0 && (
            <div className="pt-2">
              <Button
                label={showArchived ? 'Hide archived' : `Show archived (${archived.length})`}
                text
                size="small"
                severity="secondary"
                onClick={() => setShowArchived((s) => !s)}
              />
              {showArchived && <div className="animate-fade-in mt-2">{renderArchivedGrid(archived)}</div>}
            </div>
          )}
        </>
      )}

      <GoalDialog
        visible={dialogOpen}
        goal={editingGoal}
        accounts={accounts}
        onHide={() => setDialogOpen(false)}
        onSaved={fetchData}
      />
    </div>
  );
}
