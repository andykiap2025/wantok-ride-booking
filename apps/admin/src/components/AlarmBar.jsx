/**
 * The SOS alarm (spec §10).
 *
 *   > Loud, repeating, on the admin console and the on-call admin phone.
 *   > Cannot be dismissed without acknowledgement and a note.
 *
 * Three consequences, all of them deliberate irritations:
 *
 *   - **There is no close button.** The only way off the screen is to
 *     acknowledge, and acknowledging requires typing something. An alarm that
 *     can be clicked away is an alarm that gets clicked away.
 *   - **It repeats.** A sound every few seconds until acknowledged, because
 *     the console will be on a desk in an office where someone has walked out
 *     to make tea. The two-minute target in the escalation procedure assumes
 *     something audible from the corridor.
 *   - **The contact numbers are on the bar itself**, not one click away. The
 *     first thing the escalation procedure says is "call the passenger", and
 *     it should not require navigating anywhere to do that.
 *
 * Prefers-reduced-motion turns off the flashing, not the alarm.
 */

import React, { useEffect, useRef, useState } from 'react';

import * as api from '../api';

/**
 * A repeating tone, synthesised rather than shipped as a file.
 *
 * Browsers block audio until the page has been interacted with; an admin who
 * has signed in has interacted with it, so by the time an alarm can fire the
 * context is unlocked. If it is not, the visual alarm still runs — the sound
 * is an escalation, not the mechanism.
 */
function useAlarmSound(active) {
  const ctxRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!active) {
      clearInterval(timerRef.current);
      return undefined;
    }

    const beep = () => {
      try {
        ctxRef.current ??= new (window.AudioContext || window.webkitAudioContext)();
        const ctx = ctxRef.current;
        if (ctx.state === 'suspended') ctx.resume();

        // Two short tones, a fifth apart. Distinct from a notification chime
        // and audible over an open-plan office.
        [0, 0.22].forEach((offset, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'square';
          osc.frequency.value = i === 0 ? 880 : 660;
          gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
          gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + offset + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.18);
          osc.connect(gain).connect(ctx.destination);
          osc.start(ctx.currentTime + offset);
          osc.stop(ctx.currentTime + offset + 0.2);
        });
      } catch {
        // No audio available. The bar is still flashing and still blocking.
      }
    };

    beep();
    timerRef.current = setInterval(beep, 3000);
    return () => clearInterval(timerRef.current);
  }, [active]);
}

export default function AlarmBar({ events, adminId, onAcknowledged, onOpenLog }) {
  const [acknowledging, setAcknowledging] = useState(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  const active = events.length > 0;
  useAlarmSound(active);

  // The clock is shown because the escalation procedure has a target on it.
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      const oldest = Math.min(...events.map((e) => new Date(e.triggered_at).getTime()));
      setElapsed(Math.floor((Date.now() - oldest) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [active, events]);

  if (!active) return null;

  const event = events[0];
  const snapshot = event.snapshot ?? {};
  const contacts = [
    snapshot.customer && { role: 'Passenger', ...snapshot.customer },
    snapshot.driver && { role: 'Driver', ...snapshot.driver },
    snapshot.customer?.emergency_contact_phone && {
      role: 'Passenger’s contact',
      full_name: snapshot.customer.emergency_contact_name,
      phone: snapshot.customer.emergency_contact_phone,
    },
    snapshot.driver?.emergency_contact_phone && {
      role: 'Driver’s contact',
      full_name: snapshot.driver.emergency_contact_name,
      phone: snapshot.driver.emergency_contact_phone,
    },
  ].filter(Boolean);

  const submit = async () => {
    if (!note.trim()) {
      setError('A note is required — what did you do about it?');
      return;
    }
    setSaving(true);
    try {
      await api.acknowledgeSos(acknowledging.id, adminId, note.trim());
      onAcknowledged(acknowledging.id);
      setAcknowledging(null);
      setNote('');
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const mins = Math.floor(elapsed / 60);
  const secs = String(elapsed % 60).padStart(2, '0');

  return (
    <>
      <div className="alarm-bar" role="alert" aria-live="assertive">
        <div style={{ flex: 1 }}>
          <strong>
            SOS — {event.role === 'CUSTOMER' ? 'Passenger' : 'Driver'}
            {events.length > 1 ? ` (+${events.length - 1} more)` : ''}
          </strong>
          <div className="small" style={{ marginTop: 3, opacity: 0.92 }}>
            Booking {snapshot.reference ?? 'none'} · Vehicle{' '}
            {snapshot.vehicle?.registration_no ?? 'unknown'} · Unacknowledged for {mins}:{secs}
          </div>
        </div>

        {/* One click to call. The procedure's first step is a phone call. */}
        {contacts.slice(0, 2).map((c) => (
          <a
            key={c.phone}
            className="btn small"
            href={`tel:${c.phone}`}
            style={{ background: '#fff', color: 'var(--danger)' }}
          >
            Call {c.role.split(' ')[0]}
          </a>
        ))}

        <button className="btn" onClick={() => setAcknowledging(event)}>
          Acknowledge
        </button>
        <button className="btn ghost" style={{ color: '#fff', borderColor: 'rgba(255,255,255,0.5)' }} onClick={onOpenLog}>
          Open
        </button>
      </div>

      {acknowledging ? (
        <div className="backdrop">
          <div className="modal">
            <div className="modal-head">
              <div>
                <h2>Acknowledge this SOS</h2>
                <p className="muted small" style={{ marginTop: 4 }}>
                  Triggered {new Date(acknowledging.triggered_at).toLocaleString('en-AU')} · This
                  record is kept indefinitely.
                </p>
              </div>
            </div>

            <div className="modal-body">
              <div className="card" style={{ background: 'var(--surface-alt)' }}>
                <h3>Everything we know</h3>
                <div className="grid two" style={{ marginTop: 12 }}>
                  <Fact label="Booking" value={snapshot.reference ?? '—'} />
                  <Fact label="Trip state" value={snapshot.state ?? '—'} />
                  <Fact
                    label="Vehicle"
                    value={
                      snapshot.vehicle
                        ? `${snapshot.vehicle.colour} ${snapshot.vehicle.make} ${snapshot.vehicle.model} · ${snapshot.vehicle.registration_no}`
                        : '—'
                    }
                  />
                  <Fact label="Pick-up" value={snapshot.pickup?.label ?? '—'} />
                  <Fact label="Destination" value={snapshot.destination?.label ?? '—'} />
                  <Fact
                    label="Last known position"
                    value={
                      acknowledging.lat
                        ? `${acknowledging.lat.toFixed(5)}, ${acknowledging.lng.toFixed(5)}`
                        : 'not reported'
                    }
                  />
                </div>
              </div>

              <h3 style={{ marginTop: 18 }}>Who to call</h3>
              <table style={{ marginTop: 8 }}>
                <tbody>
                  {contacts.map((c) => (
                    <tr key={`${c.role}-${c.phone}`}>
                      <td className="small muted nowrap">{c.role}</td>
                      <td>{c.full_name}</td>
                      <td className="right">
                        <a className="btn small ghost" href={`tel:${c.phone}`}>
                          {c.phone}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="field" style={{ marginTop: 18 }}>
                <label>What did you do? (required)</label>
                <textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Called the passenger — safe, pressed by accident. Called the driver to confirm."
                />
              </div>

              {error ? <div className="blocker">{error}</div> : null}

              <p className="small muted">
                Escalation: acknowledge within 2 minutes, call the passenger, call the driver, call
                police on 000 or the local station.
              </p>
            </div>

            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setAcknowledging(null)} disabled={saving}>
                Back to alarm
              </button>
              <button className="btn danger" onClick={submit} disabled={saving}>
                {saving ? 'Saving…' : 'Acknowledge'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Fact({ label, value }) {
  return (
    <div>
      <div className="small muted">{label}</div>
      <div style={{ fontWeight: 600 }}>{value}</div>
    </div>
  );
}
