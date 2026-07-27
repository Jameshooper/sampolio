import { describe, it, expect } from 'vitest';
import {
  computeCardBilling,
  getOpenCycleMonths,
  isCardPayment,
  suggestStatementDay,
  transactionsForCycle,
  type CardTxn,
} from './card-billing';

const now = new Date('2026-06-24T12:00:00');

describe('computeCardBilling', () => {
  it('returns only the outstanding when no cycle is configured', () => {
    const res = computeCardBilling({ transactions: [], outstanding: 250, now });
    expect(res.bills).toEqual([]);
    expect(res.outstanding).toBe(250);
  });

  it('bills the most recent closed statement on the next due date (next month)', () => {
    const transactions: CardTxn[] = [
      { bookingDate: '2026-05-25', amount: -50 }, // in (05-20, 06-20]
      { bookingDate: '2026-06-01', amount: -100 }, // in cycle
      { bookingDate: '2026-04-10', amount: -999 }, // older cycle, excluded
    ];
    const res = computeCardBilling({ statementDay: 20, paymentDueDay: 10, transactions, now });
    expect(res.bills).toHaveLength(1);
    expect(res.bills[0]).toMatchObject({ billYearMonth: '2026-07', amount: 150, isEstimate: false, basis: 'statement' });
    expect(res.bills[0].statementCloseDate).toBe('2026-06-20');
    expect(res.bills[0].dueDate).toBe('2026-07-10');
    expect(res.currentBillYearMonth).toBe('2026-07');
  });

  it('computes the best day to shop as the day after the statement closes', () => {
    const res = computeCardBilling({ statementDay: 20, paymentDueDay: 10, transactions: [], now });
    expect(res.bestShopDay).toBe(21);
  });

  it('handles a same-month due date (due day after close day)', () => {
    const transactions: CardTxn[] = [{ bookingDate: '2026-06-02', amount: -80 }];
    const res = computeCardBilling({ statementDay: 5, paymentDueDay: 25, transactions, now });
    // close = 2026-06-05, due = 2026-06-25 (same month)
    expect(res.bills[0]).toMatchObject({ billYearMonth: '2026-06', amount: 80 });
    expect(res.bills[0].dueDate).toBe('2026-06-25');
  });

  it('always bills the open cycle from its actual transactions (no opt-in)', () => {
    const transactions: CardTxn[] = [
      { bookingDate: '2026-06-01', amount: -150 }, // closed cycle (05-20, 06-20]
      { bookingDate: '2026-06-22', amount: -30 }, // open cycle (06-20, now]
    ];
    const res = computeCardBilling({ statementDay: 20, paymentDueDay: 10, transactions, now });
    expect(res.bills).toHaveLength(2);
    const open = res.bills.find((b) => b.isEstimate);
    // No forecast supplied → the open bill is exactly the actual spend so far.
    expect(open).toMatchObject({ billYearMonth: '2026-08', amount: 30, basis: 'open-cycle', actualToDate: 30 });
    expect(res.outstanding).toBe(180); // 150 closed + 30 open
  });

  it('blends open-cycle actuals with the pro-rata remaining forecast', () => {
    const transactions: CardTxn[] = [
      { bookingDate: '2026-06-01', amount: -150 }, // closed cycle
      { bookingDate: '2026-06-22', amount: -30 }, // open cycle so far
    ];
    // Cycle 06-20 → 07-20 (30 days); now = 06-24T12:00 → 25.5/30 remaining.
    const res = computeCardBilling({
      statementDay: 20,
      paymentDueDay: 10,
      transactions,
      openCycleForecast: 90,
      now,
    });
    const open = res.bills.find((b) => b.basis === 'open-cycle');
    expect(open).toBeDefined();
    // Blend adds only the still-unspent part of the forecast (90 − 30), pro-rated.
    expect(open!.amount).toBeCloseTo(30 + (25.5 / 30) * (90 - 30), 6);
    expect(open!.actualToDate).toBe(30);
    expect(open!.isEstimate).toBe(true);
    // The forecast never leaks into the outstanding (actuals only).
    expect(res.outstanding).toBe(180);
  });

  it('never piles the forecast on top of actuals once they reach the expected total', () => {
    const transactions: CardTxn[] = [
      { bookingDate: '2026-06-22', amount: -140 }, // open-cycle actuals already > forecast
    ];
    const res = computeCardBilling({
      statementDay: 20,
      paymentDueDay: 10,
      transactions,
      openCycleForecast: 90,
      now,
    });
    const open = res.bills.find((b) => b.basis === 'open-cycle');
    // gap = max(0, 90 − 140) = 0 → the bill is exactly the actual spend so far.
    expect(open!.amount).toBeCloseTo(140, 6);
    expect(open!.actualToDate).toBe(140);
  });

  it('degenerates to the flat forecast at cycle start with no data', () => {
    // now = the close date itself → the whole cycle is still ahead.
    const startNow = new Date('2026-06-20T00:00:00');
    const res = computeCardBilling({
      statementDay: 20,
      paymentDueDay: 10,
      transactions: [],
      openCycleForecast: 90,
      now: startNow,
    });
    const open = res.bills.find((b) => b.basis === 'open-cycle');
    expect(open!.amount).toBeCloseTo(90, 6);
    expect(open!.actualToDate).toBe(0);
  });

  it('degenerates to pure actuals at cycle end', () => {
    const endNow = new Date('2026-07-20T00:00:00'); // = nextClose of the 06-20 cycle
    const res = computeCardBilling({
      statementDay: 20,
      paymentDueDay: 10,
      transactions: [{ bookingDate: '2026-07-01', amount: -45 }],
      openCycleForecast: 90,
      now: endNow,
    });
    // At 07-20 the cycle (06-20, 07-20] has just closed → it IS the closed
    // statement now; nothing of the old forecast remains in the new open cycle.
    const closed = res.bills.find((b) => b.basis === 'statement');
    expect(closed!.amount).toBe(45);
    const open = res.bills.find((b) => b.basis === 'open-cycle');
    // New open cycle (07-20 → 08-20) has full forecast ahead.
    expect(open!.amount).toBeCloseTo(90, 6);
  });

  it('floors a refund-heavy open cycle at zero actuals', () => {
    const res = computeCardBilling({
      statementDay: 20,
      paymentDueDay: 10,
      transactions: [
        { bookingDate: '2026-06-21', amount: -50, counterpartyName: 'Store' }, // purchase
        // A merchant refund (has a counterparty) larger than the purchase → net credit.
        { bookingDate: '2026-06-22', amount: 120, counterpartyName: 'Store', bankTransactionCode: 'Korttiosto' },
      ],
      openCycleForecast: 90,
      now,
    });
    const open = res.bills.find((b) => b.basis === 'open-cycle');
    expect(open!.actualToDate).toBe(0); // −50 + 120 → floored to 0
    expect(open!.amount).toBeCloseTo((25.5 / 30) * 90, 6);
  });

  it('emits no open bill when there is neither data nor forecast', () => {
    const res = computeCardBilling({ statementDay: 20, paymentDueDay: 10, transactions: [], now });
    expect(res.bills).toEqual([]);
  });

  it("reproduces a real-world cycle: August from open-cycle actuals, firm July untouched", () => {
    // A card whose statement closes the 13th, due the 1st. Today = 2026-07-03.
    const julyNow = new Date('2026-07-03T12:00:00');
    const transactions: CardTxn[] = [
      { bookingDate: '2026-06-01', amount: -500 }, // closed cycle (05-13, 06-13] → July bill
      { bookingDate: '2026-06-20', amount: -80 }, // open cycle (06-13, 07-13]
      { bookingDate: '2026-07-02', amount: -40 }, // open cycle (pending-style recent spend)
    ];
    const res = computeCardBilling({
      statementDay: 13,
      paymentDueDay: 1,
      transactions,
      openCycleForecast: 600,
      now: julyNow,
    });
    const july = res.bills.find((b) => b.billYearMonth === '2026-07');
    expect(july).toMatchObject({ amount: 500, basis: 'statement', isEstimate: false });
    const august = res.bills.find((b) => b.billYearMonth === '2026-08');
    // Cycle 06-13 → 07-13 (30 days), now 07-03T12:00 → 9.5/30 remaining.
    expect(august).toBeDefined();
    expect(august!.basis).toBe('open-cycle');
    expect(august!.actualToDate).toBe(120);
    // Blend adds only the unspent part of the forecast (600 − 120), pro-rated.
    expect(august!.amount).toBeCloseTo(120 + (9.5 / 30) * (600 - 120), 6);
    // NOT the flat 600€ estimate:
    expect(august!.amount).toBeLessThan(600);
  });

  it('keeps the previous closed statement due while its due month is still current (mid-month rollover)', () => {
    // A card whose statement closes the 13th, due the 1st. `close` rolls
    // forward to July 13 the instant `now` reaches it, but the May13→Jun13
    // bill (due Jul 1) is still due THIS month and must not vanish.
    const now22 = new Date('2026-07-22T12:00:00');
    const transactions: CardTxn[] = [
      { bookingDate: '2026-05-20', amount: -500 }, // May13–Jun13 cycle → due 2026-07
      { bookingDate: '2026-06-20', amount: -300 }, // Jun13–Jul13 cycle → due 2026-08
      { bookingDate: '2026-07-15', amount: -50 }, // open Jul13–Aug13 cycle → due 2026-09
    ];
    const res = computeCardBilling({
      statementDay: 13,
      paymentDueDay: 1,
      transactions,
      now: now22,
    });
    expect(res.bills.map((b) => b.billYearMonth)).toEqual(['2026-07', '2026-08', '2026-09']);
    const july = res.bills[0];
    expect(july).toMatchObject({ billYearMonth: '2026-07', amount: 500, basis: 'statement', isEstimate: false });
    // The May13–Jun13 statement CLOSES on Jun 13 (the cycle-end boundary) and is due Jul 1.
    expect(july.statementCloseDate).toBe('2026-06-13');
    expect(july.dueDate).toBe('2026-07-01');
    const august = res.bills[1];
    expect(august).toMatchObject({ billYearMonth: '2026-08', amount: 300, basis: 'statement', isEstimate: false });
    // The Jun13–Jul13 statement closes on Jul 13, due Aug 1.
    expect(august.statementCloseDate).toBe('2026-07-13');
    expect(august.dueDate).toBe('2026-08-01');
    const september = res.bills[2];
    expect(september.billYearMonth).toBe('2026-09');
    expect(september.basis).toBe('open-cycle');
  });

  it('ages the previous statement bill out once its due month has passed', () => {
    const transactions: CardTxn[] = [
      { bookingDate: '2026-05-20', amount: -500 }, // May13–Jun13 cycle → due 2026-07 (now past)
      { bookingDate: '2026-06-20', amount: -300 }, // Jun13–Jul13 cycle → due 2026-08
    ];
    const res = computeCardBilling({
      statementDay: 13,
      paymentDueDay: 1,
      transactions,
      now: new Date('2026-08-02T12:00:00'),
    });
    expect(res.bills.find((b) => b.billYearMonth === '2026-07')).toBeUndefined();
    const august = res.bills.find((b) => b.billYearMonth === '2026-08');
    expect(august).toMatchObject({ amount: 300, basis: 'statement' });
  });

  it('does not resurface an older statement whose due month has already passed (dueDay > statementDay)', () => {
    // statementDay 13, dueDay 25 (due AFTER the close, same-cycle-month due):
    // the day right after the close, the previous cycle's due date is already
    // in the past, so no extra bill should appear.
    const transactions: CardTxn[] = [
      { bookingDate: '2026-05-20', amount: -500 }, // May13–Jun13 cycle → due 2026-06-25 (past)
      { bookingDate: '2026-06-20', amount: -300 }, // Jun13–Jul13 cycle → due 2026-07-25
    ];
    const res = computeCardBilling({
      statementDay: 13,
      paymentDueDay: 25,
      transactions,
      now: new Date('2026-07-14T12:00:00'),
    });
    expect(res.bills.find((b) => b.billYearMonth === '2026-06')).toBeUndefined();
    const july = res.bills.find((b) => b.billYearMonth === '2026-07');
    expect(july).toMatchObject({ amount: 300, basis: 'statement' });
  });

  it('lastStatementBalance overrides only the newest statement bill; the older one still derives from cycleSpend', () => {
    const transactions: CardTxn[] = [
      { bookingDate: '2026-05-20', amount: -500 }, // May13–Jun13 actual spend
      { bookingDate: '2026-06-20', amount: -300 }, // Jun13–Jul13 actual spend
    ];
    const res = computeCardBilling({
      statementDay: 13,
      paymentDueDay: 1,
      transactions,
      lastStatementBalance: 999, // describes only the latest (Jun13–Jul13) statement
      now: new Date('2026-07-22T12:00:00'),
    });
    const july = res.bills.find((b) => b.billYearMonth === '2026-07');
    expect(july).toMatchObject({ amount: 500, basis: 'statement' }); // untouched by lastStatementBalance
    const august = res.bills.find((b) => b.billYearMonth === '2026-08');
    expect(august).toMatchObject({ amount: 999, basis: 'statement' }); // uses lastStatementBalance
  });

  it('a payment credit inside the older statement window does not reduce that older bill', () => {
    const transactions: CardTxn[] = [
      { bookingDate: '2026-05-20', amount: -500, bankTransactionCode: 'Korttiosto', counterpartyName: 'Shop' },
      // Settlement-coded credit inside the May13–Jun13 window — cycleSpend
      // already skips it (isCardPayment), so the bill must stay 500, not 500−200.
      { bookingDate: '2026-06-01', amount: 200, bankTransactionCode: 'Suoritus' },
      { bookingDate: '2026-06-20', amount: -300 },
    ];
    const res = computeCardBilling({
      statementDay: 13,
      paymentDueDay: 1,
      transactions,
      now: new Date('2026-07-22T12:00:00'),
    });
    const july = res.bills.find((b) => b.billYearMonth === '2026-07');
    expect(july).toMatchObject({ amount: 500, basis: 'statement' });
  });

  it('excludes a card payment (bill settlement) from the open-cycle spend', () => {
    // Regression: an open "cycle in progress" bill collapsed to just the
    // pro-rated buffer because the payment that settled the closed statement
    // (a big positive credit) landed inside the open cycle window and cancelled
    // its purchases, driving actuals to 0.
    const julyNow = new Date('2026-07-03T12:00:00');
    const transactions: CardTxn[] = [
      // Closed statement (05-13, 06-13] → firm July bill of 840.00.
      { bookingDate: '2026-06-01', amount: -840.00, bankTransactionCode: 'Korttiosto', counterpartyName: 'Shop' },
      // Open cycle (06-13, 07-13] purchases summing to 775.40.
      { bookingDate: '2026-06-20', amount: -600, bankTransactionCode: 'Korttiosto', counterpartyName: 'Shop A' },
      { bookingDate: '2026-07-01', amount: -175.40, bankTransactionCode: 'Korttiosto', counterpartyName: 'Shop B' },
      // The payment settling the closed statement — must NOT reduce open spend.
      { bookingDate: '2026-07-01', amount: 840.00, bankTransactionCode: 'Suoritus' },
    ];
    const res = computeCardBilling({
      statementDay: 13,
      paymentDueDay: 1,
      transactions,
      outstanding: 775.40,
      openCycleForecast: 600,
      now: julyNow,
    });
    const july = res.bills.find((b) => b.billYearMonth === '2026-07');
    expect(july).toMatchObject({ amount: 840.00, basis: 'statement' });
    const august = res.bills.find((b) => b.billYearMonth === '2026-08');
    expect(august!.basis).toBe('open-cycle');
    expect(august!.actualToDate).toBeCloseTo(775.40, 2); // payment excluded
    // Actuals already exceed the 600 buffer → no extra forecast on top.
    expect(august!.amount).toBeCloseTo(775.40, 2);
  });

  it('nets a merchant refund but never a bill payment', () => {
    const base: CardTxn[] = [
      { bookingDate: '2026-06-22', amount: -100, counterpartyName: 'Store', bankTransactionCode: 'Korttiosto' },
    ];
    const withRefund = computeCardBilling({
      statementDay: 20,
      paymentDueDay: 10,
      transactions: [...base, { bookingDate: '2026-06-23', amount: 40, counterpartyName: 'Store', bankTransactionCode: 'Korttiosto' }],
      now,
    });
    const withPayment = computeCardBilling({
      statementDay: 20,
      paymentDueDay: 10,
      transactions: [...base, { bookingDate: '2026-06-23', amount: 40, bankTransactionCode: 'Suoritus' }],
      now,
    });
    expect(withRefund.bills.find((b) => b.basis === 'open-cycle')!.actualToDate).toBe(60); // 100 − 40 refund
    expect(withPayment.bills.find((b) => b.basis === 'open-cycle')!.actualToDate).toBe(100); // payment excluded
  });

  it('isCardPayment: credits only, code- or structure-detected; refunds excluded', () => {
    // Debits are never payments (a POS purchase labelled "…payment" is a debit).
    expect(isCardPayment({ bookingDate: '2026-06-01', amount: -50, bankTransactionCode: 'Card payment' })).toBe(false);
    // Settlement code on a credit → payment.
    expect(isCardPayment({ bookingDate: '2026-06-01', amount: 500, bankTransactionCode: 'Suoritus' })).toBe(true);
    // Bare credit (no merchant identity) → payment.
    expect(isCardPayment({ bookingDate: '2026-06-01', amount: 500 })).toBe(true);
    // Merchant refund (has a counterparty) → not a payment.
    expect(isCardPayment({ bookingDate: '2026-06-01', amount: 40, counterpartyName: 'Store', bankTransactionCode: 'Korttiosto' })).toBe(false);
  });

  it('isCardPayment: OP-style settlement is a credit named "Suoritus" with no code and no MCC', () => {
    // OP reports bill settlements this way — must count as a payment.
    expect(isCardPayment({ bookingDate: '2026-07-01', amount: 1450.00, counterpartyName: 'Suoritus' })).toBe(true);
    // A processor refund whose name matches the pattern but carries an MCC → refund, not a payment.
    expect(
      isCardPayment({ bookingDate: '2026-07-01', amount: 20, counterpartyName: 'Klarna Payments AB', merchantCategoryCode: '5651' })
    ).toBe(false);
  });

  it('excludes an OP-style counterparty-named settlement from the open-cycle spend', () => {
    // The July-1 "Suoritus" credit (no code, no MCC) that settles the closed
    // statement must NOT cancel the open cycle's purchases.
    const julyNow = new Date('2026-07-03T12:00:00');
    const transactions: CardTxn[] = [
      { bookingDate: '2026-06-01', amount: -840.00, counterpartyName: 'Shop' }, // closed → firm July bill
      { bookingDate: '2026-06-20', amount: -600, counterpartyName: 'Shop A' }, // open cycle
      { bookingDate: '2026-07-01', amount: -175.40, counterpartyName: 'Shop B' }, // open cycle
      { bookingDate: '2026-07-01', amount: 1450.00, counterpartyName: 'Suoritus' }, // settlement, excluded
    ];
    const res = computeCardBilling({ statementDay: 13, paymentDueDay: 1, transactions, now: julyNow });
    const august = res.bills.find((b) => b.billYearMonth === '2026-08');
    expect(august!.basis).toBe('open-cycle');
    expect(august!.actualToDate).toBeCloseTo(775.40, 2); // 600 + 175.40, settlement excluded
  });

  it('prefers an explicit outstanding from the bank over derivation', () => {
    const res = computeCardBilling({
      statementDay: 20,
      paymentDueDay: 10,
      transactions: [{ bookingDate: '2026-06-01', amount: -150 }],
      outstanding: 1234.56,
      now,
    });
    expect(res.outstanding).toBe(1234.56);
  });

  it('suggests a statement-close day from the due day (grace shifted back)', () => {
    // due 1st, 18-day grace → closes ~13th (a common real-world card cycle)
    expect(suggestStatementDay(1, 18)).toBe(13);
    expect(suggestStatementDay(25, 18)).toBe(7);
    expect(suggestStatementDay(10, 18)).toBe(22);
    // stays within 1–28 so it's valid in February too
    expect(suggestStatementDay(31, 0)).toBe(28);
    // invalid input passes through
    expect(suggestStatementDay(0, 18)).toBe(0);
  });

  it('transactionsForCycle returns the purchases in (close-1mo, close]', () => {
    const txns = [
      { bookingDate: '2026-04-10' }, // before window
      { bookingDate: '2026-05-25' }, // in
      { bookingDate: '2026-06-01' }, // in
      { bookingDate: '2026-06-13' }, // in (boundary, inclusive)
      { bookingDate: '2026-06-20' }, // after window
    ];
    const out = transactionsForCycle(txns, '2026-06-13').map((t) => t.bookingDate);
    expect(out).toEqual(['2026-05-25', '2026-06-01', '2026-06-13']);
  });

  it('getOpenCycleMonths mirrors the forecast-loop spend-month rule', () => {
    // Due day on/before statement day → spend month is the month before due.
    const lateDue = getOpenCycleMonths(13, 1, new Date('2026-07-03T12:00:00'));
    expect(lateDue).toEqual({ dueYearMonth: '2026-08', spendYearMonth: '2026-07' });
    // Due day after statement day → spend month = due month.
    const sameMonth = getOpenCycleMonths(5, 25, now);
    expect(sameMonth).toEqual({ dueYearMonth: '2026-07', spendYearMonth: '2026-07' });
    // Year wrap: open cycle closes 2027-01-20, due 2027-02-10, spend Jan 2027.
    const wrap = getOpenCycleMonths(20, 10, new Date('2026-12-22T12:00:00'));
    expect(wrap).toEqual({ dueYearMonth: '2027-02', spendYearMonth: '2027-01' });
  });

  it('crosses the year boundary for a December statement', () => {
    const decNow = new Date('2026-12-22T12:00:00');
    const res = computeCardBilling({
      statementDay: 20,
      paymentDueDay: 10,
      transactions: [{ bookingDate: '2026-12-05', amount: -200 }],
      now: decNow,
    });
    // close 2026-12-20, due 2027-01-10
    expect(res.bills[0]).toMatchObject({ billYearMonth: '2027-01', amount: 200 });
    expect(res.bills[0].dueDate).toBe('2027-01-10');
  });
});
