/**
 * Category conveniences shared by the cashflow item forms (pure, unit-tested).
 *
 * `guessItemCategory` mirrors the split quick-add's `guessCategory`
 * (`src/lib/split-utils.ts`) but maps to the cashflow `ITEM_CATEGORIES`
 * vocabulary instead of the split categories. Best-effort keyword matching —
 * a convenience prefill, never authoritative.
 */

const KEYWORDS: Array<[RegExp, string]> = [
  // Income
  [/salary|palkka|wage|payroll/i, 'Salary'],
  [/freelance|invoice|consulting|gig/i, 'Freelance'],
  [/dividend|interest|osinko/i, 'Investment'],
  [/rent(al)? income|vuokratulo/i, 'Rental Income'],
  // Expenses
  [/rent|vuokra|mortgage|vastike|housing/i, 'Housing'],
  [/electric|sähkö|water|vesi|heating|gas bill|internet|broadband|phone|puhelin|dna|elisa|telia|helen\b|caruna|fortum|vattenfall|oomi|väre/i, 'Utilities'],
  [/bus|train|hsl|vr\b|metro|fuel|bensa|diesel|parking|taxi|uber|bolt|car\b|auto\b|neste|st1\b|teboil|shell|matkahuolto|onnibus/i, 'Transportation'],
  [/grocer|market|prisma|k-market|s-market|lidl|alepa|sale\b|food|ruoka|restaurant|ravintola|lunch|lounas|wolt|foodora|alko\b|hesburger|mcdonald|burger|kebab|pizza|sushi|subway|kahvila|cafe|espresso/i, 'Food & Groceries'],
  [/doctor|lääkäri|pharmacy|apteekki|dentist|hammas|terveys|hospital|mehiläinen|pihlajalinna/i, 'Healthcare'],
  [/insurance|vakuutus|if\b|lähitapiola|op vakuutus/i, 'Insurance'],
  [/netflix|spotify|hbo|disney|viaplay|cinema|elokuva|game|steam|playstation|xbox|concert|gym|sali|fitness/i, 'Entertainment'],
  [/amazon|zalando|ikea|clothes|vaate|shopping|verkkokauppa|gigantti|tokmanni|puuilo|motonet|biltema|clas ohlson|k-rauta|bauhaus|kirpputori|kirppis/i, 'Shopping'],
  [/flight|lento|hotel|hotelli|airbnb|travel|matka|finnair|norwegian/i, 'Travel'],
  [/tuition|course|kurssi|school|koulu|university|opisto|book/i, 'Education'],
  [/tax|vero/i, 'Taxes'],
  [/loan|laina|amortization|lyhennys|credit payment/i, 'Debt Payment'],
  [/saving|säästö|investment deposit/i, 'Savings'],
];

/** Guess an ITEM_CATEGORIES entry from an item name; null when nothing matches. */
export function guessItemCategory(name: string): string | null {
  const n = name.trim();
  if (n.length < 3) return null;
  for (const [re, category] of KEYWORDS) {
    if (re.test(n)) return category;
  }
  return null;
}
