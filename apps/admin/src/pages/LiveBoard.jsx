/**
 * The live board (spec §17, daily: "watch the live board").
 *
 * Every trip in motion, one row each, refreshed by Realtime rather than by
 * polling. What it is really for is spotting the two failures that a
 * marketplace with no dispatch cannot catch on its own:
 *
 *   - A **request sitting unanswered** with its 90 seconds ticking down. That
 *     is a passenger about to be sent back to the list, and if it keeps
 *     happening in one suburb the operator needs to know tonight, not in
 *     next month's report.
 *   - A **driver who has been "en route" for 25 minutes**. Nothing in the
 *     state machine is wrong, but something on the ground is.
 *
 * So the age of each state is a column, and rows go amber and then red as
 * they sit. The board is sorted by how stuck a trip is, not by when it
 * started — the thing that needs attention should be at the top.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { BookingState, formatKina, secondsToAccept } from '@wantok/core';
import * as api from '../api';

/** How long a state should normally last, in seconds, before it looks stuck. */
const PATIENCE = {
  [BookingState.REQUESTED]: 90,
  [BookingState.CONFIRMED]: 5 * 60,
  [BookingState.DRIVER_EN_ROUTE]: 20 * 60,
  [BookingState.ARRIVED]: 10 * 60,
  [BookingState.IN_PROGRESS]: 60 * 60,
};

const STATE_TONE = {
  [BookingState.REQUESTED]: 'warning',
  [BookingState.CONFIRMED]: 'info',
  [BookingState.DRIVER_EN_ROUTE]: 'info',
  [BookingState.ARRIVED]: 'gold',
  [BookingState.IN_PROGRESS]: 'success',
};

/** When the current state began, so "stuck" means stuck in *this* step. */
function stateSince(booking) {
  const stamps = {
    [BookingState.REQUESTED]: booking.requested_at,
    [BookingState.CONFIRMED]: booking.confirmed_at,
    [BookingState.DRIVER_EN_ROUTE]: booking.en_route_at,
    [BookingState.ARRIVED]: booking.arrived_at,
    [BookingState.IN_PROGRESS]: booking.started_at,
  };
  return new Date(stamps[booking.state] ?? booking.created_at);
}

export default function LiveBoard() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      setBookings(await api.getLiveBoard());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return api.watchLiveBoard(load);
  }, [load]);

  // The board is a clock as much as a list.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo(
    () =>
      bookings
        .map((b) => {
          const age = Math.floor((Date.now() - stateSince(b).getTime()) / 1000);
          const patience = PATIENCE[b.state] ?? 600;
          return { ...b, age, overdue: age / patience };
        })
        // Most stuck first. The thing that needs attention is at the top.
        .sort((a, b) => b.overdue - a.overdue),
    [bookings],
  );

  const counts = rows.reduce((acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }), {});
  const stuck = rows.filter((r) => r.overdue >= 1).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Live board</h1>
          <p>{rows.length} trips in motion{stuck ? ` · ${stuck} need a look` : ''}</p>
        </div>
        <button className="btn ghost small" onClick={load}>Refresh</button>
      </div>

      <div className="page-body">
        <div className="grid stats" style={{ marginBottom: 18 }}>
          {[
            [BookingState.REQUESTED, 'Waiting on driver'],
            [BookingState.CONFIRMED, 'Confirmed'],
            [BookingState.DRIVER_EN_ROUTE, 'On the way'],
            [BookingState.ARRIVED, 'At pick-up'],
            [BookingState.IN_PROGRESS, 'On trip'],
          ].map(([state, label]) => (
            <div key={state} className="card stat" style={{ marginBottom: 0 }}>
              <div className="label">{label.toUpperCase()}</div>
              <div className="value">{counts[state] ?? 0}</div>
            </div>
          ))}
        </div>

        <div className="card flush">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>State</th>
                <th>In this state</th>
                <th>Passenger</th>
                <th>Vehicle</th>
                <th>Route</th>
                <th className="right">Fare</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td className="mono">{b.reference}</td>
                  <td>
                    <span className={`pill ${STATE_TONE[b.state] ?? ''}`}>
                      {b.state.replace(/_/g, ' ')}
                    </span>
                    {b.is_scheduled ? <span className="pill" style={{ marginLeft: 4 }}>BOOKED</span> : null}
                  </td>
                  <td className="nowrap">
                    <Age
                      seconds={b.age}
                      overdue={b.overdue}
                      countdown={b.state === BookingState.REQUESTED ? secondsToAccept(b) : null}
                    />
                  </td>
                  <td>
                    <div>{b.profiles?.full_name ?? '—'}</div>
                    <a className="small muted" href={`tel:${b.profiles?.phone}`}>
                      {b.profiles?.phone}
                    </a>
                  </td>
                  <td>
                    <div className="mono">{b.vehicles?.registration_no ?? '—'}</div>
                    <div className="small muted">
                      {b.vehicles ? `${b.vehicles.colour} ${b.vehicles.make} ${b.vehicles.model}` : ''}
                    </div>
                  </td>
                  <td className="small">
                    {b.pickup_label}
                    <div className="muted">→ {b.dest_label}</div>
                  </td>
                  <td className="right nowrap">
                    {formatKina(b.quoted_fare)}
                    {b.is_night_rate ? <div className="small muted">night</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {!rows.length ? (
            <div className="empty">
              {loading ? 'Loading…' : 'Nothing on the road right now.'}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Age({ seconds, overdue, countdown }) {
  const mins = Math.floor(seconds / 60);
  const secs = String(seconds % 60).padStart(2, '0');
  const tone = overdue >= 1.5 ? 'danger' : overdue >= 1 ? 'warning' : '';

  return (
    <>
      <span className={`pill ${tone}`}>
        {mins}:{secs}
      </span>
      {countdown !== null ? (
        <div className="small muted" style={{ marginTop: 2 }}>
          {countdown > 0 ? `${countdown}s left to accept` : 'window closed'}
        </div>
      ) : null}
    </>
  );
}
