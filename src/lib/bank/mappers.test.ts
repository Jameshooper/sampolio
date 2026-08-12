import { describe, it, expect } from 'vitest';
import {
  mapAspsps,
  mapAspspDetails,
  mapSessionAccounts,
  mapSessionDetails,
  mapBalances,
  pickAnchorBalance,
  pickCardBalances,
  mapTransactions,
  inferAccountRole,
  terminalSessionStatus,
  toCurrency,
} from './mappers';

let seq = 0;
const idFactory = () => `tx-${++seq}`;

describe('toCurrency', () => {
  it('accepts known currencies and falls back to EUR', () => {
    expect(toCurrency('SEK')).toBe('SEK');
    expect(toCurrency('XXX')).toBe('EUR');
    expect(toCurrency(undefined)).toBe('EUR');
  });
});

describe('inferAccountRole', () => {
  it('maps cash, card and savings', () => {
    expect(inferAccountRole({ cash_account_type: 'CACC' })).toBe('cash');
    expect(inferAccountRole({ cash_account_type: 'CARD' })).toBe('credit-card');
    expect(inferAccountRole({ cash_account_type: 'SVGS' })).toBe('savings');
    expect(inferAccountRole({ product: 'Gold Credit Card' })).toBe('credit-card');
    expect(inferAccountRole({})).toBe('other');
  });
});

describe('mapAspsps', () => {
  it('maps and uppercases country', () => {
    expect(mapAspsps({ aspsps: [{ name: 'Example Bank', country: 'fi' }, { country: 'FI' }] })).toEqual([
      { name: 'Example Bank', country: 'FI' },
    ]);
  });
});

describe('mapAspspDetails', () => {
  it('maps the consent-validity ceiling and required PSU headers', () => {
    const out = mapAspspDetails({
      aspsps: [
        {
          name: 'Example Bank',
          country: 'fi',
          maximum_consent_validity: 15552000, // 180d, as Nordea FI reports
          required_psu_headers: ['Psu-Ip-Address', 'Psu-User-Agent'],
        },
      ],
    });
    expect(out).toEqual([
      {
        name: 'Example Bank',
        country: 'FI',
        maximumConsentValiditySeconds: 15552000,
        requiredPsuHeaders: ['Psu-Ip-Address', 'Psu-User-Agent'],
      },
    ]);
  });

  it('parses a numeric-string validity', () => {
    const out = mapAspspDetails({ aspsps: [{ name: 'B', country: 'FI', maximum_consent_validity: '7776000' }] });
    expect(out[0].maximumConsentValiditySeconds).toBe(7776000);
  });

  it('drops a missing, non-positive or unparseable validity', () => {
    const out = mapAspspDetails({
      aspsps: [
        { name: 'A', country: 'FI' },
        { name: 'B', country: 'FI', maximum_consent_validity: 0 },
        { name: 'C', country: 'FI', maximum_consent_validity: -100 },
        { name: 'D', country: 'FI', maximum_consent_validity: 'not-a-number' },
        { name: 'E', country: 'FI', maximum_consent_validity: null },
      ],
    });
    expect(out.map((a) => a.maximumConsentValiditySeconds)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('tolerates garbage headers, nameless entries and malformed input', () => {
    const out = mapAspspDetails({
      aspsps: [
        { name: 'A', country: 'FI', required_psu_headers: 'not-an-array' },
        { name: 'B', country: 'FI', required_psu_headers: [] },
        { country: 'FI' }, // no name → dropped
        null,
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].requiredPsuHeaders).toBeUndefined();
    expect(out[1].requiredPsuHeaders).toBeUndefined();
    expect(mapAspspDetails(undefined)).toEqual([]);
    expect(mapAspspDetails({})).toEqual([]);
    expect(mapAspspDetails({ aspsps: 'not-an-array' })).toEqual([]);
  });
});

describe('terminalSessionStatus', () => {
  it('maps REVOKED to revoked', () => {
    expect(terminalSessionStatus('REVOKED')).toBe('revoked');
    expect(terminalSessionStatus('revoked')).toBe('revoked');
  });

  it('maps the lifecycle-end statuses to expired', () => {
    expect(terminalSessionStatus('EXPIRED')).toBe('expired');
    expect(terminalSessionStatus('CLOSED')).toBe('expired');
    expect(terminalSessionStatus('CANCELLED')).toBe('expired');
  });

  it('returns null for live, unknown or missing statuses', () => {
    expect(terminalSessionStatus('AUTHORIZED')).toBeNull();
    expect(terminalSessionStatus('SOME_FUTURE_ENUM')).toBeNull();
    expect(terminalSessionStatus('')).toBeNull();
    expect(terminalSessionStatus(undefined)).toBeNull();
  });
});

describe('mapSessionAccounts', () => {
  it('extracts uid, iban, currency and role', () => {
    const out = mapSessionAccounts({
      accounts: [
        { uid: 'u1', account_id: { iban: 'FI2112345600000785' }, name: 'Main', currency: 'EUR', cash_account_type: 'CACC' },
        { uid: 'u2', name: 'Visa', currency: 'EUR', cash_account_type: 'CARD' },
        { name: 'no-uid' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ accountUid: 'u1', iban: 'FI2112345600000785', accountRole: 'cash' });
    expect(out[1]).toMatchObject({ accountUid: 'u2', accountRole: 'credit-card' });
  });

  it('carries identification_hash through when present', () => {
    const out = mapSessionAccounts({
      accounts: [
        { uid: 'u1', identification_hash: 'hash-1', currency: 'EUR', cash_account_type: 'CACC' },
        { uid: 'u2', currency: 'EUR', cash_account_type: 'CARD' },
      ],
    });
    expect(out[0].identificationHash).toBe('hash-1');
    expect(out[1].identificationHash).toBeUndefined();
  });

  it('maps identification_hashes and folds the singular hash into the set', () => {
    const out = mapSessionAccounts({
      accounts: [
        {
          uid: 'u1',
          identification_hash: 'hash-primary',
          identification_hashes: ['hash-iban', 'hash-bban'],
          currency: 'EUR',
          cash_account_type: 'CACC',
        },
        // Singular only (a bank/session that doesn't send the array yet).
        { uid: 'u2', identification_hash: 'hash-solo', currency: 'EUR', cash_account_type: 'CARD' },
      ],
    });
    expect(out[0].identificationHashes).toEqual(['hash-iban', 'hash-bban', 'hash-primary']);
    expect(out[1].identificationHashes).toEqual(['hash-solo']);
  });

  it('treats an empty or garbage hashes array as absent', () => {
    const out = mapSessionAccounts({
      accounts: [
        { uid: 'u1', identification_hashes: [], currency: 'EUR' },
        { uid: 'u2', identification_hashes: 'not-an-array' as unknown as string[], currency: 'EUR' },
        { uid: 'u3', identification_hashes: [null, '', 42] as unknown as string[], currency: 'EUR' },
      ],
    });
    expect(out[0].identificationHashes).toBeUndefined();
    expect(out[1].identificationHashes).toBeUndefined();
    expect(out[2].identificationHashes).toBeUndefined();
  });
});

describe('mapSessionDetails', () => {
  it('extracts the session status and each account uid + hash(es)', () => {
    const out = mapSessionDetails({
      status: 'AUTHORIZED',
      accounts_data: [
        { uid: 'u1', identification_hash: 'hash-1', identification_hashes: ['hash-1', 'hash-1b'] },
        { uid: 'u2', identification_hash: 'hash-2' },
      ],
    });
    expect(out.status).toBe('AUTHORIZED');
    expect(out.accounts).toEqual([
      { uid: 'u1', identificationHash: 'hash-1', identificationHashes: ['hash-1', 'hash-1b'] },
      { uid: 'u2', identificationHash: 'hash-2', identificationHashes: ['hash-2'] },
    ]);
  });

  it('drops entries missing either field and tolerates garbage/absent input', () => {
    expect(
      mapSessionDetails({
        accounts_data: [
          { uid: 'u1' }, // no hash
          { identification_hash: 'hash-2' }, // no uid
          { uid: 'u3', identification_hash: 'hash-3' },
          null,
          'garbage',
        ],
      })
    ).toEqual({
      status: undefined,
      accounts: [{ uid: 'u3', identificationHash: 'hash-3', identificationHashes: ['hash-3'] }],
    });
    expect(mapSessionDetails({})).toEqual({ status: undefined, accounts: [] });
    expect(mapSessionDetails(undefined)).toEqual({ status: undefined, accounts: [] });
    expect(mapSessionDetails({ accounts_data: 'not-an-array' })).toEqual({ status: undefined, accounts: [] });
  });

  it('ignores a non-string or empty status', () => {
    expect(mapSessionDetails({ status: 42, accounts_data: [] }).status).toBeUndefined();
    expect(mapSessionDetails({ status: '', accounts_data: [] }).status).toBeUndefined();
  });
});

describe('mapBalances + pickAnchorBalance', () => {
  it('prefers closing-booked', () => {
    const balances = mapBalances({
      balances: [
        { balance_type: 'ITAV', balance_amount: { amount: '900.00', currency: 'EUR' } },
        { balance_type: 'CLBD', balance_amount: { amount: '1000.50', currency: 'EUR' } },
      ],
    });
    expect(balances).toHaveLength(2);
    const anchor = pickAnchorBalance(balances);
    expect(anchor).toMatchObject({ type: 'CLBD', amount: 1000.5 });
  });

  it('falls back to first balance when no priority type present', () => {
    const balances = mapBalances({ balances: [{ balance_type: 'INFO', balance_amount: { amount: 5, currency: 'EUR' } }] });
    expect(pickAnchorBalance(balances)?.amount).toBe(5);
  });
});

describe('pickCardBalances (real Enable Banking card shape)', () => {
  it('splits booked (owed) and available, enabling outstanding + limit derivation', () => {
    // A representative card balance pair as returned by EB.
    const balances = mapBalances({
      balances: [
        { name: 'Available balance', balance_type: 'ITAV', balance_amount: { amount: '8380.00', currency: 'EUR' } },
        { name: 'Booked balance', balance_type: 'ITBD', balance_amount: { amount: '-1620.00', currency: 'EUR' } },
      ],
    });
    const { booked, available } = pickCardBalances(balances);
    expect(booked?.amount).toBe(-1620.00);
    expect(available?.amount).toBe(8380.00);
    // Derivations the sync performs:
    const outstanding = Math.max(0, -(booked!.amount));
    expect(outstanding).toBeCloseTo(1620.00, 2);
    expect(available!.amount + outstanding).toBeCloseTo(10000, 2); // credit limit
  });

  it('handles a fully-available card (nothing owed)', () => {
    const balances = mapBalances({
      balances: [
        { balance_type: 'ITAV', balance_amount: { amount: '5300', currency: 'EUR' } },
        { balance_type: 'ITBD', balance_amount: { amount: '-0', currency: 'EUR' } },
      ],
    });
    const { booked, available } = pickCardBalances(balances);
    expect(Math.max(0, -(booked!.amount))).toBe(0);
    expect(available!.amount).toBe(5300);
  });

  it('reinterprets OP’s single negative ITAV as the booked/owed balance', () => {
    // OP returns exactly ONE balance — a negative ITAV that is really the owed
    // amount, mislabeled as "interim available".
    const balances = mapBalances({
      balances: [
        { name: 'Available balance', balance_type: 'ITAV', balance_amount: { amount: '-1896.56', currency: 'EUR' } },
      ],
    });
    const { booked, available } = pickCardBalances(balances);
    expect(booked?.type).toBe('ITAV');
    expect(booked?.amount).toBe(-1896.56);
    expect(available).toBeNull();
    expect(Math.max(0, -(booked!.amount))).toBeCloseTo(1896.56, 2); // outstanding
  });

  it('treats a positive CLAV as available credit (not reinterpreted)', () => {
    const balances = mapBalances({
      balances: [{ balance_type: 'CLAV', balance_amount: { amount: '5000', currency: 'EUR' } }],
    });
    const { booked, available } = pickCardBalances(balances);
    expect(available?.type).toBe('CLAV');
    expect(available?.amount).toBe(5000);
    expect(booked).toBeNull();
  });
});

describe('mapTransactions', () => {
  const now = '2026-06-10T12:00:00.000Z';

  it('signs amounts by credit/debit indicator', () => {
    const { transactions } = mapTransactions(
      {
        transactions: [
          { entry_reference: 'r1', booking_date: '2026-06-01', transaction_amount: { amount: '12.00', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'BOOK', creditor: { name: 'Shop' } },
          { entry_reference: 'r2', booking_date: '2026-06-02', transaction_amount: { amount: '50.00', currency: 'EUR' }, credit_debit_indicator: 'CRDT', status: 'BOOK', debtor: { name: 'Employer' } },
        ],
      },
      'acct-1',
      now,
      idFactory
    );
    expect(transactions[0]).toMatchObject({ amount: -12, status: 'booked', dedupKey: 'r1', counterpartyName: 'Shop' });
    expect(transactions[1]).toMatchObject({ amount: 50, status: 'booked', dedupKey: 'r2', counterpartyName: 'Employer' });
  });

  it('uses a synthetic key for pending / reference-less rows', () => {
    const { transactions } = mapTransactions(
      {
        transactions: [
          { booking_date: '2026-06-03', value_date: '2026-06-03', transaction_amount: { amount: '7.50', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'PDNG', creditor: { name: 'Cafe' }, remittance_information: ['coffee'] },
        ],
      },
      'acct-1',
      now,
      idFactory
    );
    expect(transactions[0].status).toBe('pending');
    expect(transactions[0].dedupKey.startsWith('syn:')).toBe(true);
    expect(transactions[0].remittanceInfo).toBe('coffee');
  });

  it('maps the structured creditor reference and its schema', () => {
    const { transactions } = mapTransactions(
      {
        transactions: [
          {
            entry_reference: 'r1',
            booking_date: '2026-06-01',
            transaction_amount: { amount: '120.00', currency: 'EUR' },
            credit_debit_indicator: 'DBIT',
            status: 'BOOK',
            reference_number: ' 1234561 ',
            reference_number_schema: ' SCOR ',
          },
          // Empty / whitespace-only / absent → undefined, never an empty string.
          {
            entry_reference: 'r2',
            booking_date: '2026-06-02',
            transaction_amount: { amount: '5.00', currency: 'EUR' },
            credit_debit_indicator: 'DBIT',
            status: 'BOOK',
            reference_number: '   ',
            reference_number_schema: null,
          },
          {
            entry_reference: 'r3',
            booking_date: '2026-06-03',
            transaction_amount: { amount: '5.00', currency: 'EUR' },
            credit_debit_indicator: 'DBIT',
            status: 'BOOK',
          },
        ],
      },
      'acct-1',
      now,
      idFactory
    );
    expect(transactions[0]).toMatchObject({ referenceNumber: '1234561', referenceNumberSchema: 'SCOR' });
    expect(transactions[1].referenceNumber).toBeUndefined();
    expect(transactions[1].referenceNumberSchema).toBeUndefined();
    expect(transactions[2].referenceNumber).toBeUndefined();
  });

  it('keeps the reference number OUT of the dedup key', () => {
    const mapOne = (reference?: string) =>
      mapTransactions(
        {
          transactions: [
            {
              booking_date: '2026-06-01',
              value_date: '2026-06-01',
              transaction_amount: { amount: '30.00', currency: 'EUR' },
              credit_debit_indicator: 'DBIT',
              status: 'PDNG',
              creditor: { name: 'Utility Co' },
              reference_number: reference,
            },
          ],
        },
        'acct-1',
        now,
        idFactory
      ).transactions[0];
    expect(mapOne('1234561').dedupKey).toBe(mapOne(undefined).dedupKey);
  });

  it('passes through the continuation key', () => {
    const res = mapTransactions({ transactions: [], continuation_key: 'page-2' }, 'acct-1', now, idFactory);
    expect(res.continuationKey).toBe('page-2');
  });

  it('falls back to transaction_date for bookingDate when booking + value dates are absent (OP)', () => {
    const { transactions } = mapTransactions(
      {
        transactions: [
          { entry_reference: 'r1', transaction_date: '2024-09-15', transaction_amount: { amount: '10.00', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'BOOK' },
        ],
      },
      'acct-1',
      now,
      idFactory
    );
    expect(transactions[0].bookingDate).toBe('2024-09-15'); // real date, not the sync day
    expect(transactions[0].transactionDate).toBe('2024-09-15');
  });

  it('keys a PDNG row by entry_reference and dates it from transaction_date', () => {
    // Live Nordea card shape for `transaction_status=PDNG`: a stable hex
    // reference, no booking/value date, the purchase date in transaction_date.
    const { transactions } = mapTransactions(
      {
        transactions: [
          {
            entry_reference: '67299f98ab',
            booking_date: null as unknown as undefined,
            value_date: null as unknown as undefined,
            transaction_date: '2026-07-28',
            status: 'PDNG',
            credit_debit_indicator: 'DBIT',
            transaction_amount: { currency: 'EUR', amount: '42.90' },
            creditor: { name: 'Kauppa' },
            bank_transaction_code: { description: 'Korttiosto' },
          },
        ],
      },
      'acct-1',
      now,
      idFactory
    );
    expect(transactions[0]).toMatchObject({
      dedupKey: '67299f98ab',
      entryReference: '67299f98ab',
      status: 'pending',
      bookingDate: '2026-07-28',
      transactionDate: '2026-07-28',
      amount: -42.9,
      counterpartyName: 'Kauppa',
      bankTransactionCode: 'Korttiosto',
    });
  });

  it('falls back to a synthetic key for a PDNG row with no entry_reference', () => {
    const { transactions } = mapTransactions(
      {
        transactions: [
          { transaction_date: '2026-07-28', status: 'PDNG', credit_debit_indicator: 'DBIT', transaction_amount: { currency: 'EUR', amount: '9.00' }, creditor: { name: 'Kiosk' } },
        ],
      },
      'acct-1',
      now,
      idFactory
    );
    expect(transactions[0].status).toBe('pending');
    expect(transactions[0].dedupKey.startsWith('syn:')).toBe(true);
  });

  it('uses a synthetic key for an unknown status even with an entry_reference', () => {
    // Only BOOK and PDNG carry an identity guarantee; anything else is content-keyed.
    const { transactions } = mapTransactions(
      {
        transactions: [
          { entry_reference: 'r-odd', booking_date: '2026-07-28', status: 'INFO', credit_debit_indicator: 'DBIT', transaction_amount: { currency: 'EUR', amount: '1.00' } },
        ],
      },
      'acct-1',
      now,
      idFactory
    );
    expect(transactions[0].status).toBe('other');
    expect(transactions[0].dedupKey.startsWith('syn:')).toBe(true);
    expect(transactions[0].entryReference).toBe('r-odd');
  });

  it('still falls back to the sync day when the bank gives no dates at all', () => {
    const { transactions } = mapTransactions(
      {
        transactions: [
          { entry_reference: 'r1', transaction_amount: { amount: '10.00', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'BOOK' },
        ],
      },
      'acct-1',
      now,
      idFactory
    );
    expect(transactions[0].bookingDate).toBe('2026-06-10'); // nowIso date
  });
});
