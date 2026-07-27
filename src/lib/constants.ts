import type { Currency, SplitInterval } from '@/types';
import { isDemoMasked, maskMoney } from './demo-mode';

// Single source of truth for currency codes — keep in sync with the Currency
// type union and reuse via z.enum(CURRENCY_VALUES) in validation schemas.
export const CURRENCY_VALUES = ['EUR', 'USD', 'BRL', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK'] as const;

export const CURRENCIES: { value: Currency; label: string; symbol: string }[] = [
  { value: 'EUR', label: 'Euro', symbol: '€' },
  { value: 'USD', label: 'US Dollar', symbol: '$' },
  { value: 'BRL', label: 'Brazilian Real', symbol: 'R$' },
  { value: 'GBP', label: 'British Pound', symbol: '£' },
  { value: 'JPY', label: 'Japanese Yen', symbol: '¥' },
  { value: 'CHF', label: 'Swiss Franc', symbol: 'CHF' },
  { value: 'CAD', label: 'Canadian Dollar', symbol: 'C$' },
  { value: 'AUD', label: 'Australian Dollar', symbol: 'A$' },
  { value: 'SEK', label: 'Swedish Krona', symbol: 'kr' },
  { value: 'NOK', label: 'Norwegian Krone', symbol: 'kr' },
  { value: 'DKK', label: 'Danish Krone', symbol: 'kr' },
];

export const PLANNING_HORIZONS = [
  { value: 12, label: '1 Year' },
  { value: 24, label: '2 Years' },
  { value: 36, label: '3 Years' },
  { value: 60, label: '5 Years' },
  { value: 120, label: '10 Years' },
  { value: -1, label: 'Custom End Date' },
];

export const FREQUENCIES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly (every 3 months)' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'custom', label: 'Custom Interval' },
];

export const ITEM_CATEGORIES = [
  'Salary',
  'Freelance',
  'Investment',
  'Rental Income',
  'Other Income',
  'Housing',
  'Utilities',
  'Transportation',
  'Food & Groceries',
  'Healthcare',
  'Insurance',
  'Entertainment',
  'Shopping',
  'Travel',
  'Education',
  'Taxes',
  'Debt Payment',
  'Savings',
  'Reimbursement',
  'Other Expense',
];

// One category → color map used by EVERY category-colored surface (expense
// treemap, cashflow Sankey, category badges) so a category always looks the
// same. Warm hues = discretionary spending, cool hues = fixed costs/income.
export const CATEGORY_COLORS: Record<string, string> = {
  // Income (cool greens/teals)
  Salary: '#22c55e',
  Freelance: '#10b981',
  Investment: '#14b8a6',
  'Rental Income': '#06b6d4',
  'Other Income': '#34d399',
  // Fixed costs (cool blues/purples)
  Housing: '#3b82f6',
  Utilities: '#6366f1',
  Insurance: '#8b5cf6',
  Taxes: '#64748b',
  'Debt Payment': '#7c3aed',
  Savings: '#0ea5e9',
  Education: '#2563eb',
  Healthcare: '#0891b2',
  // Discretionary (warm reds/oranges/pinks)
  'Food & Groceries': '#f97316',
  Transportation: '#f59e0b',
  Entertainment: '#ec4899',
  Shopping: '#ef4444',
  Travel: '#e11d48',
  Reimbursement: '#a3e635',
  'Other Expense': '#d97706',
  'Credit cards': '#f59e0b', // matches the card-block amber in the charts
};

// Deterministic fallback shades for custom categories not in the map.
const CATEGORY_FALLBACK_COLORS = ['#dc2626', '#ea580c', '#db2777', '#be123c', '#c2410c', '#b91c1c'];

/** The canonical color for a category (stable fallback for custom ones). */
export function getCategoryColor(category: string | undefined): string {
  if (!category) return '#9ca3af';
  const mapped = CATEGORY_COLORS[category];
  if (mapped) return mapped;
  let hash = 0;
  for (let i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) | 0;
  return CATEGORY_FALLBACK_COLORS[Math.abs(hash) % CATEGORY_FALLBACK_COLORS.length];
}

// Short, plain-word categories for trip/project budgets (lines, grant
// restrictions and the expense log all pick from this same list).
export const BUDGET_CATEGORIES = [
  'Accommodation',
  'Travel',
  'Local transport',
  'Food',
  'Insurance',
  'Fees',
  'Equipment',
  'Other',
];

// Categories for split groups (Splitwise replacement). Mirrors the common
// Splitwise category set so an import maps directly; an unknown imported
// category falls back to "Other" while keeping the original string.
export const SPLIT_CATEGORIES = [
  'Groceries',
  'Dining out',
  'Liquor',
  'Household supplies',
  'Furniture',
  'Electronics',
  'Rent',
  'Mortgage',
  'Utilities',
  'Electricity',
  'Water',
  'Heating',
  'TV/Phone/Internet',
  'Maintenance',
  'Cleaning',
  'Home - Other',
  'Transport',
  'Bus/train',
  'Taxi',
  'Car',
  'Fuel',
  'Parking',
  'Plane',
  'Hotel',
  'Travel',
  'Entertainment',
  'Movies',
  'Music',
  'Games',
  'Sports',
  'Clothing',
  'Gifts',
  'Medical',
  'Insurance',
  'Education',
  'Services',
  'Payment',
  'General',
  'Other',
];

// Recurrence cadences for split expenses (date-grained, unlike the
// month-grained FREQUENCIES used by the projection engine).
export const SPLIT_INTERVALS: { value: SplitInterval; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

export const APP_NAME = 'Sampolio';
export const APP_DESCRIPTION = 'Personal Finance Planning Tool';

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

export function getCurrencySymbol(currency: Currency): string {
  return CURRENCIES.find(c => c.value === currency)?.symbol || currency;
}

export const LOCALE = 'fi-FI';

export function formatCurrency(amount: number, currency: Currency): string {
  const symbol = getCurrencySymbol(currency);
  // Demo mode: replace every monetary value with a fixed placeholder mask.
  // formatCents wraps this, so it inherits the masking automatically.
  if (isDemoMasked()) return maskMoney(symbol, amount < 0);
  const formatted = new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(amount));
  
  if (amount < 0) {
    return `−${symbol}${formatted}`;
  }
  return `${symbol}${formatted}`;
}

/** Format an integer-cents amount as currency (wraps formatCurrency). */
export function formatCents(cents: number, currency: Currency): string {
  return formatCurrency(cents / 100, currency);
}

export function formatYearMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  return `${MONTHS[parseInt(month, 10) - 1]} ${year}`;
}

export function formatYearMonthShort(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  return `${MONTHS_SHORT[parseInt(month, 10) - 1]} ${year}`;
}

/** Format a percentage rate with two decimals, fi-FI style (e.g. "2,71 %"). */
export function formatRate(rate: number): string {
  return `${new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rate)} %`;
}

// Mortgage option lists
export const MORTGAGE_PAYMENT_MODES = [
  { value: 'annuity-fixed-term', label: 'Fixed term (payment recalculated each year)' },
  { value: 'fixed-payment', label: 'Fixed payment (term flexes)' },
];

export const MORTGAGE_DAY_COUNTS = [
  { value: 'actual/360', label: 'Actual / 360 (Finnish default)' },
  { value: '30E/360', label: '30 / 360' },
];
