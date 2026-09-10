/**
 * Reports (spec §17, weekly).
 *
 * Two reports, both of which exist because the spec says what they are *for*
 * rather than what they should contain.
 *
 * **Decline reasons.** Spec §7: "They are how you find out which suburbs are
 * underserved and at which hours." So this is grouped by reason *and* by
 * pickup area, and the hour-of-day histogram is the point — a cluster of "I
 * will not travel to that area at this time" at 21:00 in one suburb is an
 * operational fact worth acting on, and it is invisible in a flat total.
 *
 * **Flagged vehicles.** Spec §7: three driver cancellations or no-shows in a
 * rolling seven days triggers a review. The threshold is applied at read time
 * by `driverReviewFlag`, so changing the policy does not need a migration.
 * Note what this produces: a flag, not a suspension. The right answer to a
 * driver having a bad week is often a phone call.
 */

import React, { useEffect, useMemo, useState } from 'react';

import { DECLINE_REASONS, Thresholds, driverReviewFlag } from '@wantok/core';
import * as api from '../api';

const REASON_LABEL = Object.fromEntries(DECLINE_REASONS.map((r) => [r.code, r.label]));

export default function Reports() {
  const [declines, setDeclines] = useState([]);
  const [conduct, setConduct] = useState([]);
  const [audit, setAudit] = useState([]);
  const [days, setDays] = useState(30);

  useEffect(() => {
    api.getDeclineReasons(days).then(setDeclines).catch(() => setDeclines([]));
    api.getFlaggedVehicles(Thresholds.DRIVER_STRIKE_WINDOW_DAYS).then(setConduct).catch(() => setConduct([]));
    api.getAuditLog(60).then(setAudit).catch(() => setAudit([]));
  }, [days]);

  const byReason = useMemo(() => {
    const map = new Map();
    for (const d of declines) {
      const key = d.decline_reason;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [declines]);

  const byArea = useMemo(() => {
    const map = new Map();
    for (const d of declines) {
      const key = d.pickup_label ?? 'Unknown';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [declines]);

  const byHour = useMemo(() => {
    const hours = Array.from({ length: 24 }, () => 0);
    for (const d of declines) {
      // Port Moresby local hour — UTC+10, no daylight saving.
      const local = new Date(new Date(d.created_at).getTime() + 10 * 3_600_000);
      hours[local.getUTCHours()] += 1;
    }
    return hours;
  }, [declines]);

  const flagged = useMemo(() => {
    const byVehicle = new Map();
    for (const record of conduct) {
      const list = byVehicle.get(record.subject_id) ?? [];
      list.push(record);
      byVehicle.set(record.subject_id, list);
    }
    return [...byVehicle.entries()]
      .map(([id, records]) => ({
        id,
        vehicle: records[0].vehicles,
        ...driverReviewFlag(records),
      }))
      .filter((v) => v.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [conduct]);

  const peak = Math.max(1, ...byHour);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p>Where the platform is failing to serve people, and who needs a conversation.</p>
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-strong)' }}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      <div className="page-body">
        <h2 style={{ marginBottom: 10 }}>Declines — {declines.length} in {days} days</h2>

        <div className="grid two">
          <div className="card">
            <h3>By reason</h3>
            <table style={{ marginTop: 10 }}>
              <tbody>
                {byReason.map(([code, count]) => (
                  <tr key={code}>
                    <td className="small">{REASON_LABEL[code] ?? code}</td>
                    <td style={{ width: '55%' }}>
                      <Bar value={count} max={byReason[0]?.[1] ?? 1} />
                    </td>
                    <td className="right nowrap" style={{ fontWeight: 700 }}>{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!byReason.length ? <p className="small muted" style={{ marginTop: 10 }}>No declines recorded.</p> : null}
          </div>

          <div className="card">
            <h3>By pick-up area</h3>
            <p className="small muted" style={{ marginTop: 2 }}>
              Where passengers are asking and not being served.
            </p>
            <table style={{ marginTop: 10 }}>
              <tbody>
                {byArea.map(([area, count]) => (
                  <tr key={area}>
                    <td className="small">{area}</td>
                    <td style={{ width: '50%' }}>
                      <Bar value={count} max={byArea[0]?.[1] ?? 1} />
                    </td>
                    <td className="right nowrap" style={{ fontWeight: 700 }}>{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h3>By hour of day</h3>
          <p className="small muted" style={{ marginTop: 2 }}>
            Port Moresby time. A spike in the evening usually means the night rate is not enough to
            make a run worth taking.
          </p>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 110, marginTop: 14 }}>
            {byHour.map((count, hour) => (
              <div key={hour} style={{ flex: 1, textAlign: 'center' }}>
                <div
                  title={`${hour}:00 — ${count} declines`}
                  style={{
                    height: `${(count / peak) * 90}px`,
                    background: hour >= 20 || hour < 5 ? 'var(--ink)' : 'var(--gold)',
                    borderRadius: '3px 3px 0 0',
                    minHeight: count ? 3 : 0,
                  }}
                />
                <div style={{ fontSize: 9, color: 'var(--grey)', marginTop: 3 }}>
                  {hour % 3 === 0 ? hour : ''}
                </div>
              </div>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            Dark bars are inside the night window (20:00–05:00).
          </p>
        </div>

        <h2 style={{ margin: '22px 0 10px' }}>
          Vehicles to review — {Thresholds.DRIVER_STRIKES}+ cancellations or no-shows in{' '}
          {Thresholds.DRIVER_STRIKE_WINDOW_DAYS} days
        </h2>
        <div className="card flush">
          <table>
            <thead>
              <tr>
                <th>Registration</th>
                <th>Vehicle</th>
                <th>Events</th>
                <th>Flagged</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map((v) => (
                <tr key={v.id}>
                  <td className="mono">{v.vehicle?.registration_no ?? v.id}</td>
                  <td>{v.vehicle ? `${v.vehicle.make} ${v.vehicle.model}` : '—'}</td>
                  <td>{v.count}</td>
                  <td>
                    {v.flagged ? (
                      <span className="pill danger">NEEDS A CONVERSATION</span>
                    ) : (
                      <span className="pill">under threshold</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!flagged.length ? <div className="empty">No cancellations or no-shows in the window.</div> : null}
        </div>

        <h2 style={{ margin: '22px 0 10px' }}>Recent admin actions</h2>
        <div className="card flush">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Entity</th>
              </tr>
            </thead>
            <tbody>
              {audit.slice(0, 25).map((a) => (
                <tr key={a.id}>
                  <td className="small nowrap">
                    {new Date(a.created_at).toLocaleString('en-AU', {
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="small">{a.action.replace(/_/g, ' ')}</td>
                  <td className="mono small">
                    {a.entity_type} {a.entity_id?.slice(0, 8)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Bar({ value, max }) {
  return (
    <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ width: `${(value / max) * 100}%`, height: 8, background: 'var(--gold)', borderRadius: 4 }} />
    </div>
  );
}
