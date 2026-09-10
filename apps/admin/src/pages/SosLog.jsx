/**
 * The SOS log (spec §10, §16).
 *
 * SOS records are kept indefinitely — they are the only category in the
 * retention policy with no expiry, because an incident may be revisited years
 * later by people who are not this company.
 *
 * So this screen is an archive, not a queue. It shows the frozen snapshot as
 * it was at the moment of the trigger, the acknowledgement and its note, and
 * the location trail that followed. Nothing here is editable and there is no
 * delete: the database has a rule that discards them.
 *
 * The number worth watching is time-to-acknowledge. The escalation procedure
 * sets a two-minute target, and a target nobody measures is a target nobody
 * meets.
 */

import React, { useEffect, useState } from 'react';

import { secondsUnacknowledged } from '@wantok/core';
import * as api from '../api';

export default function SosLog() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    api
      .getRecentSos(50)
      .then(setEvents)
      .finally(() => setLoading(false));
  }, []);

  const acknowledged = events.filter((e) => e.acknowledged_at);
  const median = acknowledged.length
    ? [...acknowledged]
        .map((e) => (new Date(e.acknowledged_at) - new Date(e.triggered_at)) / 1000)
        .sort((a, b) => a - b)[Math.floor(acknowledged.length / 2)]
    : null;
  const breaches = acknowledged.filter(
    (e) => (new Date(e.acknowledged_at) - new Date(e.triggered_at)) / 1000 > 120,
  ).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>SOS log</h1>
          <p>Kept indefinitely. Target: acknowledge within 2 minutes.</p>
        </div>
      </div>

      <div className="page-body">
        <div className="grid stats" style={{ marginBottom: 18 }}>
          <div className="card stat" style={{ marginBottom: 0 }}>
            <div className="label">ALERTS (LAST 50)</div>
            <div className="value">{events.length}</div>
          </div>
          <div className="card stat" style={{ marginBottom: 0 }}>
            <div className="label">MEDIAN TIME TO ACKNOWLEDGE</div>
            <div className="value">{median === null ? '—' : `${Math.round(median)}s`}</div>
          </div>
          <div className="card stat" style={{ marginBottom: 0 }}>
            <div className="label">OVER TWO MINUTES</div>
            <div className="value" style={breaches ? { color: 'var(--danger)' } : undefined}>
              {breaches}
            </div>
          </div>
          <div className="card stat" style={{ marginBottom: 0 }}>
            <div className="label">STILL OPEN</div>
            <div className="value" style={{ color: events.length - acknowledged.length ? 'var(--danger)' : undefined }}>
              {events.length - acknowledged.length}
            </div>
          </div>
        </div>

        <div className="card flush">
          <table>
            <thead>
              <tr>
                <th>Triggered</th>
                <th>By</th>
                <th>Booking</th>
                <th>Vehicle</th>
                <th>Acknowledged</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const took = e.acknowledged_at
                  ? Math.round((new Date(e.acknowledged_at) - new Date(e.triggered_at)) / 1000)
                  : null;
                return (
                  <tr key={e.id}>
                    <td className="small nowrap">
                      {new Date(e.triggered_at).toLocaleString('en-AU', {
                        day: 'numeric',
                        month: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </td>
                    <td>
                      <span className={`pill ${e.role === 'CUSTOMER' ? 'info' : 'gold'}`}>
                        {e.role === 'CUSTOMER' ? 'PASSENGER' : 'DRIVER'}
                      </span>
                    </td>
                    <td className="mono small">{e.snapshot?.reference ?? '—'}</td>
                    <td className="mono small">{e.snapshot?.vehicle?.registration_no ?? '—'}</td>
                    <td className="nowrap">
                      {took === null ? (
                        <span className="pill danger">
                          OPEN · {Math.floor(secondsUnacknowledged(e) / 60)}m
                        </span>
                      ) : (
                        <span className={`pill ${took > 120 ? 'warning' : 'success'}`}>{took}s</span>
                      )}
                    </td>
                    <td className="right">
                      <button className="btn small ghost" onClick={() => setOpen(e)}>
                        Record
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!events.length ? (
            <div className="empty">{loading ? 'Loading…' : 'No alerts have been raised.'}</div>
          ) : null}
        </div>
      </div>

      {open ? <Record event={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function Record({ event, onClose }) {
  const [trail, setTrail] = useState([]);

  useEffect(() => {
    api.getSosTrail(event.id).then(setTrail).catch(() => setTrail([]));
  }, [event.id]);

  const s = event.snapshot ?? {};

  return (
    <div className="backdrop">
      <div className="modal">
        <div className="modal-head">
          <div>
            <h2>SOS — {event.role === 'CUSTOMER' ? 'Passenger' : 'Driver'}</h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              {new Date(event.triggered_at).toLocaleString('en-AU')} · record kept indefinitely
            </p>
          </div>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </div>

        <div className="modal-body">
          <div className="card" style={{ background: 'var(--surface-alt)' }}>
            <div className="small muted" style={{ marginBottom: 8 }}>
              FROZEN AT THE MOMENT OF TRIGGER — not re-resolved since
            </div>
            <table>
              <tbody>
                <Row label="Booking" value={s.reference} />
                <Row label="Trip state" value={s.state} />
                <Row
                  label="Vehicle"
                  value={
                    s.vehicle
                      ? `${s.vehicle.colour} ${s.vehicle.make} ${s.vehicle.model} · ${s.vehicle.registration_no}`
                      : null
                  }
                />
                <Row label="Driver" value={s.driver ? `${s.driver.full_name} · ${s.driver.phone}` : null} />
                <Row
                  label="Passenger"
                  value={s.customer ? `${s.customer.full_name} · ${s.customer.phone}` : null}
                />
                <Row label="Pick-up" value={s.pickup?.label} />
                <Row label="Destination" value={s.destination?.label} />
                <Row
                  label="Position at trigger"
                  value={event.lat ? `${event.lat.toFixed(5)}, ${event.lng.toFixed(5)}` : 'not reported'}
                />
              </tbody>
            </table>
          </div>

          <h3 style={{ marginTop: 16 }}>Acknowledgement</h3>
          {event.acknowledged_at ? (
            <div className="card" style={{ marginTop: 8 }}>
              <div className="small muted">
                {new Date(event.acknowledged_at).toLocaleString('en-AU')} ·{' '}
                {Math.round((new Date(event.acknowledged_at) - new Date(event.triggered_at)) / 1000)}s
                after trigger
              </div>
              <p style={{ marginTop: 6 }}>{event.notes}</p>
            </div>
          ) : (
            <div className="blocker" style={{ marginTop: 8 }}>
              Never acknowledged. This is a process failure and should be raised at the next
              operations review.
            </div>
          )}

          <h3 style={{ marginTop: 16 }}>Location trail ({trail.length} points)</h3>
          {trail.length ? (
            <table style={{ marginTop: 8 }}>
              <tbody>
                {trail.slice(0, 20).map((p) => (
                  <tr key={p.id}>
                    <td className="small nowrap">
                      {new Date(p.recorded_at).toLocaleTimeString('en-AU')}
                    </td>
                    <td className="mono small">
                      {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
                    </td>
                    <td className="right">
                      <a
                        className="small"
                        href={`https://www.google.com/maps?q=${p.lat},${p.lng}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Map
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="small muted" style={{ marginTop: 8 }}>
              No positions recorded — the handset may have lost signal or been switched off.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <tr>
      <td className="small muted nowrap">{label}</td>
      <td>{value ?? '—'}</td>
    </tr>
  );
}
