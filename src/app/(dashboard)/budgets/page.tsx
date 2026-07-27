'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ListPageSkeleton } from '@/components/ui/skeletons';
import { useAppContext } from '@/components/layout/app-layout';
import { getBudgets } from '@/lib/actions/budgets';
import { getTrips } from '@/lib/actions/trips';
import { getAccounts } from '@/lib/actions/accounts';
import { TripsSection } from '@/components/trips/trips-section';
import { BudgetsSection } from '@/components/budgets/budgets-section';
import type { Budget, Trip, FinancialAccount } from '@/types';

/**
 * "Trips & Budgets" — the merged travel/project planning page. Trips (per-diem
 * calculator) come first, then Budgets (bounded project/grant budgets). Both
 * are fetched together here and share one first-load skeleton + refresh
 * callback; each section owns its own dialogs and mutation flows.
 */
export default function TripsAndBudgetsPage() {
  const appContext = useAppContext();

  const [isLoading, setIsLoading] = useState(true);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const hasLoadedOnce = useRef(false);

  const fetchData = useCallback(async () => {
    if (!hasLoadedOnce.current) setIsLoading(true);
    try {
      const [budgetsRes, tripsRes, accountsRes] = await Promise.all([getBudgets(), getTrips(), getAccounts()]);
      setBudgets(budgetsRes.success && budgetsRes.data ? budgetsRes.data : []);
      setTrips(tripsRes.success && tripsRes.data ? tripsRes.data : []);
      setAccounts(accountsRes.success && accountsRes.data ? accountsRes.data : []);
    } catch (err) {
      console.error('Failed to load trips & budgets:', err);
    } finally {
      hasLoadedOnce.current = true;
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { if (appContext) appContext.setRefreshCallback(fetchData); }, [appContext, fetchData]);

  if (isLoading) {
    return <ListPageSkeleton />;
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-10">
      <h1 className="text-2xl font-bold">Trips &amp; Budgets</h1>
      <TripsSection trips={trips} accounts={accounts} budgets={budgets} onChanged={fetchData} />
      <BudgetsSection budgets={budgets} onChanged={fetchData} />
    </div>
  );
}
