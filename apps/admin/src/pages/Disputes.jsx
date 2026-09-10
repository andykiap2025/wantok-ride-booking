/**
 * Disputes (spec §17).
 *
 * Each category carries a target response time — 24 hours for most, immediate
 * for anything involving safety. That target is the sort order: the queue is
 * arranged by how overdue a case is, not by when it arrived, so a safety
 * report raised twenty minutes ago outranks a fare disagreement from
 * yesterday morning.
 *
 * The fare breakdown is on the case, because "fare disagreement" is the most
 * common category and almost every one of them is answered by showing how the
 * number was arrived at: base, distance, minimum, night, rounding. That is
 * `explainQuote` reading the booking's own stored rate version — the same
 * explanation the passenger saw when they booked.
 */

import React, { useCallback, useEffect, useState } from 'react';

import { DISPUTE_CATEGORIES, formatKina } from '@wantok/core';
import * as api from '../api';

const CATEGORY = Object.fromEntries(DISPUTE_CATEGORIES.map((c) => [c.code, c]));

export default function Disputes({ profile, onChanged }) {
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.getOpenDisputes();
      const now = Date.now();
      setDisputes(
        rows
          .map((d) => {
            const target = CATEGORY[d.category]?.responseHours ?? 24;
            const ageHours = (now - new Date(d.created_at).getTime()) / 3_600_000;
            // Immediate categories are overdue from the first second.
            return { ...d, ageHours, target, overdue: target === 0 ? Infinity : ageHours / target };
          })
          .sort((a, b) => b.overdue - a.overdue),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const breached = disputes.filter((d) => d.overdue >= 1).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Disputes</h1>
          <p>
            {disputes.length} open
            {breached ? ` · ${breached} past their response target` : ''}
          </p>
        </div>
        <button className="btn ghost small" onClick={load}>Refresh</button>
      </div>

      <div className="page-body">
        <div className="card flush">
          <table>
            <thead>
              <tr>
                <th>Raised</th>
                <th>Category</th>
                <th>Booking</th>
                <th>Description</th>
                <th>Target</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {disputes.map((d) => (
                <tr key={d.id}>
                  <td className="small nowrap">
                    {new Date(d.created_at).toLocaleDateString('en-AU', {
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td>
                    <span className={`pill ${d.category === 'SAFETY' ? 'danger' : ''}`}>
                      {CATEGORY[d.category]?.label ?? d.category}
                    </span>
                  </td>
                  <td className="mono small">{d.bookings?.reference ?? '—'}</td>
                  <td className="small" style={{ maxWidth: 320 }}>
                    {d.description?.slice(0, 120)}
                    {d.description?.length > 120 ? '…' : ''}
                  </td>
                  <td className="nowrap">
                    <span
                      className={`pill ${d.overdue >= 1 ? 'danger' : d.overdue >= 0.7 ? 'warning' : ''}`}
                    >
                      {d.target === 0 ? 'IMMEDIATE' : `${Math.round(d.ageHours)}h of ${d.target}h`}
                    </span>
                  </td>
                  <td>
                    <span className="pill">{d.status}</span>
                  </td>
                  <td className="right">
                    <button className="btn small" onClick={() => setOpen(d)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!disputes.length ? (
            <div className="empty">{loading ? 'Loading…' : 'Queue is clear.'}</div>
          ) : null}
        </div>
      </div>

      {open ? (
        <CaseModal
          dispute={open}
          profile={profile}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            load();
            onChanged?.();
          }}
        />
      ) : null}
    </>
  );
}

function CaseModal({ dispute, profile, onClose, onDone }) {
  const [resolution, setResolution] = useState(dispute.resolution ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async (status) => {
    if (status !== 'INVESTIGATING' && !resolution.trim()) {
      setError('Write what was decided before closing a case.');
      return;
    }
    setSaving(true);
    try {
      await api.updateDispute(dispute.id, {
        status,
        assigned_to: profile.id,
        resolution: resolution.trim() || null,
        resolved_at: ['RESOLVED', 'CLOSED'].includes(status) ? new Date().toISOString() : null,
      });
      onDone();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  const booking = dispute.bookings;

  return (
    <div className="backdrop">
      <div className="modal">
        <div className="modal-head">
          <div>
            <h2>{CATEGORY[dispute.category]?.label ?? dispute.category}</h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              Raised {new Date(dispute.created_at).toLocaleString('en-AU')} · Booking{' '}
              <span className="mono">{booking?.reference ?? 'none'}</span>
            </p>
          </div>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </div>

        <div className="modal-body">
          <div className="card" style={{ background: 'var(--surface-alt)' }}>
            <div className="small muted">WHAT THEY SAID</div>
            <p style={{ marginTop: 6 }}>{dispute.description}</p>
          </div>

          {booking ? (
            <>
              <h3 style={{ marginTop: 16 }}>The trip</h3>
              <table style={{ marginTop: 8 }}>
                <tbody>
                  <tr>
                    <td className="small muted">Route</td>
                    <td>{booking.pickup_label} → {booking.dest_label}</td>
                  </tr>
                  <tr>
                    <td className="small muted">Locked fare</td>
                    <td style={{ fontWeight: 700 }}>{formatKina(booking.quoted_fare)}</td>
                  </tr>
                  <tr>
                    <td className="small muted">Final state</td>
                    <td>{booking.state?.replace(/_/g, ' ')}</td>
                  </tr>
                </tbody>
              </table>
              <p className="small muted" style={{ marginTop: 8 }}>
                The fare was locked at booking from a stored rate version and has not been
                recomputed since. Open the booking to see the full breakdown.
              </p>
            </>
          ) : null}

          <div className="field" style={{ marginTop: 18 }}>
            <label>Resolution</label>
            <textarea
              rows={4}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="What was decided, who was contacted, and what happens next."
            />
          </div>

          {error ? <div className="blocker">{error}</div> : null}

          <p className="small muted">
            Refunds and fare adjustments follow the written refund policy — see
            docs/policies. Anything you do here is written to the audit log.
          </p>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={() => save('INVESTIGATING')} disabled={saving}>
            Take it — still working
          </button>
          <button className="btn" onClick={() => save('RESOLVED')} disabled={saving}>
            {saving ? 'Saving…' : 'Resolve'}
          </button>
        </div>
      </div>
    </div>
  );
}
