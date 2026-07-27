// Quick-add cost templates shared by the setup wizard and the costs panel.
// Clicking one prefills a sensible name/category/recurrence; the user only types the amount.

export interface BudgetTemplate {
  name: string;
  category: string; // from BUDGET_CATEGORIES
  kind: 'monthly' | 'one-off';
}

export const BUDGET_TEMPLATES: BudgetTemplate[] = [
  { name: 'Rent', category: 'Accommodation', kind: 'monthly' },
  { name: 'Flights', category: 'Travel', kind: 'one-off' },
  { name: 'Local transport', category: 'Local transport', kind: 'monthly' },
  { name: 'Groceries', category: 'Food', kind: 'monthly' },
  { name: 'Insurance', category: 'Insurance', kind: 'one-off' },
  { name: 'Conference fee', category: 'Fees', kind: 'one-off' },
  { name: 'Phone & internet', category: 'Other', kind: 'monthly' },
  { name: 'Visa & paperwork', category: 'Fees', kind: 'one-off' },
];
