/**
 * Plain-language vocabulary — the single map from finance jargon to
 * everyday wording, used to keep terminology consistent app-wide.
 *
 * Usage: `plainTerm('receivables', isSimple)` returns the plain label in
 * simple mode and the precise term otherwise; `HELP_TEXTS` feeds the
 * `<HelpHint>` tooltips shown next to dense labels in advanced mode.
 * One concept, one name — add new jargon here, never inline in a component.
 */

export interface PlainTermEntry {
    /** Precise finance term (advanced mode). */
    term: string;
    /** Everyday wording (simple mode). */
    plain: string;
    /** One-sentence explanation for tooltips/help hints. */
    help: string;
}

export const PLAIN_TERMS = {
    receivables: {
        term: 'Receivables',
        plain: 'Money owed to you',
        help: 'Money other people or companies still owe you, like a loan to a friend.',
    },
    liquidAssets: {
        term: 'Liquid Assets',
        plain: 'Cash you can use',
        help: 'Money you could spend right away: cash accounts plus investments you can sell.',
    },
    netWorth: {
        term: 'Net Worth',
        plain: 'What you own overall',
        help: 'Everything you own minus everything you owe. The single best measure of your finances.',
    },
    reconcile: {
        term: 'Monthly check-in',
        plain: 'Monthly check-in',
        help: 'A quick confirmation of your real account balances so forecasts stay accurate. Nothing is deleted or changed elsewhere.',
    },
    euriborDue: {
        term: 'Euribor update due',
        plain: 'Mortgage interest rate update due',
        help: 'Your mortgage interest rate follows the Euribor reference rate and is due for its periodic update. Enter the new rate from your bank.',
    },
    utilization: {
        term: 'Utilization',
        plain: 'Card limit used',
        help: 'How much of your credit card limit is currently in use.',
    },
    homeEquity: {
        term: 'Home equity',
        plain: 'Your share of the home',
        help: 'The part of your home you actually own: its value share minus what is still owed on the mortgage.',
    },
    creditCards: {
        term: 'Credit cards',
        plain: 'Credit card debt',
        help: 'What you currently owe on your credit cards. It is paid off with each card bill.',
    },
    investments: {
        term: 'Investments',
        plain: 'Investments',
        help: 'Money you have put into funds, stocks or similar, growing over time.',
    },
    splitBalance: {
        term: 'Split balance',
        plain: 'Split balance',
        help: 'The net of shared expenses: positive means others owe you, negative means you owe them.',
    },
    projection: {
        term: 'Projection',
        plain: 'Forecast',
        help: 'An estimate of your future balance based on your income, bills and plans.',
    },
    balanceToday: {
        term: 'Balance today',
        plain: 'Money in your account now',
        help: 'Your real bank balance from the last sync. Anything you\'ve already paid or received this month is included in it.',
    },
    stillAhead: {
        term: 'Still ahead',
        plain: 'Still to come',
        help: 'Planned income and expenses for this month that haven\'t hit your account yet. Already-paid items aren\'t counted again.',
    },
    paidAlready: {
        term: 'Paid',
        plain: 'Already paid',
        help: 'This item matched a real bank transaction this month, so it\'s already included in your balance.',
    },
} as const satisfies Record<string, PlainTermEntry>;

export type PlainTermKey = keyof typeof PLAIN_TERMS;

/** The label to show for a concept: everyday wording in simple mode, the
 *  precise term otherwise. */
export function plainTerm(key: PlainTermKey, isSimple: boolean): string {
    const entry = PLAIN_TERMS[key];
    return isSimple ? entry.plain : entry.term;
}

/** Tooltip/help sentence for a concept. */
export function helpText(key: PlainTermKey): string {
    return PLAIN_TERMS[key].help;
}
