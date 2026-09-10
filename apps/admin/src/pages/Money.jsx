/**
 * Payments and the commission ledger (spec §8, §17 daily: "verify owner
 * payments").
 *
 * The job on this screen is matching a photographed receipt against a line on
 * a bank statement. So the receipt and the numbers needed to find it — the
 * owner's bank, account and reference — are side by side, and verifying is one
 * button.
 *
 * What happens after that button is deliberately not this screen's business.
 * It writes a PAYMENT entry to the ledger; the triggers in `0002_functions`
 * recompute the balance and relist the vehicle if it was suspended for
 * non-payment. Nothing here touches `balance_owed` — it is derived, and an
 * admin who wants to change a balance writes an adjustment that says who and
 * why.
 */

import React, { useCallback, useEffect, useState } from 'react';

import { EntryType, ceilingState, formatKina, rebuildBalance, signOf } from '@wantok/core';
import * as api from '../api';

export default function Money({ profile, onChanged }) {
  const [payments, setPayments] = useState([]);
  const [debtors, setDebtors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [receipt, setReceipt] = useState(null);
  const [ledgerFor, setLedgerFor] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, d] = await Promise.all([api.getPendingPayments(), api.getVehiclesWithBalance()]);
      setPayments(p);
      setDebtors(d);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const verify = async (payment) => {
    await api.verifyPayment(payment, profile.id);
    setReceipt(null);
    load();
    onChanged?.();
  };

  const owed = debtors.reduce((sum, v) => sum + v.balance_owed, 0);
  const suspended = debtors.filter((v) => v.status === 'SUSPENDED_UNPAID').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <p>
            {payments.length} receipts to verify · {formatKina(owed)} outstanding across{' '}
            {debtors.length} vehicles
          </p>
        </div>
        <button className="btn ghost small" onClick={load}>Refresh</button>
      </div>

      <div className="page-body">
        <div className="grid stats" style={{ marginBottom: 18 }}>
          <Stat label="AWAITING VERIFICATION" value={payments.length} />
          <Stat label="TOTAL OUTSTANDING" value={formatKina(owed)} />
          <Stat label="SUSPENDED FOR NON-PAYMENT" value={suspended} tone={suspended ? 'danger' : ''} />
        </div>

        <h2 style={{ margin: '4px 0 10px' }}>Receipts to verify</h2>
        <div className="card flush">
          <table>
            <thead>
              <tr>
                <th>Submitted</th>
                <th>Owner</th>
                <th>Bank details</th>
                <th>Method</th>
                <th>Reference</th>
                <th className="right">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="small nowrap">
                    {new Date(p.created_at).toLocaleDateString('en-AU', {
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td>
                    {p.owners?.profiles?.full_name}
                    <div className="small muted">{p.owners?.profiles?.phone}</div>
                  </td>
                  <td className="small">
                    {p.owners?.bank_name}
                    <div className="mono muted">{p.owners?.bank_account}</div>
                  </td>
                  <td className="small">{p.method.replace(/_/g, ' ')}</td>
                  <td className="mono small">{p.reference ?? '—'}</td>
                  <td className="right nowrap" style={{ fontWeight: 700 }}>
                    {formatKina(p.amount)}
                  </td>
                  <td className="right nowrap">
                    <button className="btn small ghost" onClick={() => setReceipt(p)}>
                      Receipt
                    </button>{' '}
                    <button className="btn small" onClick={() => verify(p)}>
                      Verify
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!payments.length ? (
            <div className="empty">{loading ? 'Loading…' : 'No receipts waiting.'}</div>
          ) : null}
        </div>

        <h2 style={{ margin: '22px 0 10px' }}>Vehicles carrying a balance</h2>
        <div className="card flush">
          <table>
            <thead>
              <tr>
                <th>Registration</th>
                <th>Vehicle</th>
                <th>Status</th>
                <th>Against limit</th>
                <th className="right">Owed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {debtors.map((v) => {
                const state = ceilingState(v.balance_owed, v.commission_ceiling);
                return (
                  <tr key={v.id}>
                    <td className="mono">{v.registration_no}</td>
                    <td>{v.make} {v.model}</td>
                    <td>
                      <span className={`pill ${v.status === 'APPROVED' ? 'success' : 'danger'}`}>
                        {v.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td style={{ minWidth: 170 }}>
                      <Meter fraction={state.fraction} state={state.state} />
                      <div className="small muted">of {formatKina(state.ceiling)}</div>
                    </td>
                    <td className="right nowrap" style={{ fontWeight: 700 }}>
                      {formatKina(v.balance_owed)}
                    </td>
                    <td className="right">
                      <button className="btn small ghost" onClick={() => setLedgerFor(v)}>
                        Ledger
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!debtors.length ? <div className="empty">Every vehicle is settled up.</div> : null}
        </div>
      </div>

      {receipt ? <ReceiptModal payment={receipt} onClose={() => setReceipt(null)} onVerify={verify} /> : null}
      {ledgerFor ? <LedgerModal vehicle={ledgerFor} onClose={() => setLedgerFor(null)} /> : null}
    </>
  );
}

function ReceiptModal({ payment, onClose, onVerify }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!payment.receipt_url) {
      setError('No receipt image was attached.');
      return;
    }
    api
      .signedUrl('receipts', payment.receipt_url, 180)
      .then(setUrl)
      .catch(() => setError('Could not open the receipt.'));
  }, [payment]);

  return (
    <div className="backdrop">
      <div className="modal">
        <div className="modal-head">
          <div>
            <h2>{formatKina(payment.amount)} — {payment.method.replace(/_/g, ' ')}</h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              {payment.owners?.bank_name} {payment.owners?.bank_account} · ref{' '}
              <span className="mono">{payment.reference ?? 'none given'}</span>
            </p>
          </div>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          {url ? (
            <img src={url} alt="Payment receipt" style={{ width: '100%', borderRadius: 10 }} />
          ) : (
            <div className="empty">{error ?? 'Loading…'}</div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Not yet</button>
          <button className="btn" onClick={() => onVerify(payment)}>
            I can see it on the statement — verify
          </button>
        </div>
      </div>
    </div>
  );
}

function LedgerModal({ vehicle, onClose }) {
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    api.getLedger(vehicle.id).then((rows) => setEntries(rebuildBalance(rows).entries));
  }, [vehicle.id]);

  return (
    <div className="backdrop">
      <div className="modal">
        <div className="modal-head">
          <div>
            <h2 className="mono">{vehicle.registration_no}</h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              Every entry, oldest first. The balance is replayed from these — it is never edited.
            </p>
          </div>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Entry</th>
                <th className="right">Amount</th>
                <th className="right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="small nowrap">
                    {new Date(e.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                  </td>
                  <td className="small">
                    {e.entry_type === EntryType.COMMISSION
                      ? e.amount === 0
                        ? 'Trip — free period'
                        : `Commission on ${formatKina(e.gross_fare ?? 0)}`
                      : e.entry_type.replace(/_/g, ' ')}
                    {e.note ? <div className="muted">{e.note}</div> : null}
                  </td>
                  <td className="right nowrap">
                    {signOf(e.entry_type) > 0 ? '+' : '−'}
                    {formatKina(e.amount)}
                  </td>
                  <td className="right nowrap" style={{ fontWeight: 600 }}>
                    {formatKina(e.balance_after)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="card stat" style={{ marginBottom: 0 }}>
      <div className="label">{label}</div>
      <div className="value" style={tone === 'danger' ? { color: 'var(--danger)' } : undefined}>
        {value}
      </div>
    </div>
  );
}

function Meter({ fraction, state }) {
  const colour =
    state === 'OVER' ? 'var(--danger)' : state === 'WARN' ? 'var(--warning)' : 'var(--success)';
  return (
    <div style={{ height: 7, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
      <div
        style={{
          width: `${Math.min(100, fraction * 100)}%`,
          height: 7,
          background: colour,
          borderRadius: 4,
        }}
      />
    </div>
  );
}
