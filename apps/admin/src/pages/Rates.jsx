/**
 * Rate tables (spec §5).
 *
 * Two rules shape this entire screen:
 *
 *   1. **Rates are versioned, never overwritten.** There is no edit button
 *      anywhere here. Changing a price publishes a new version with an
 *      `effective_from`, and the old one stays in the table forever so a
 *      booking from March can still be explained in September. The database
 *      enforces it with a rule that discards UPDATEs, so this is not a
 *      convention that erodes.
 *
 *   2. **Admin only.** Owners cannot set their own prices. That is what makes
 *      the fare on the customer's screen mean something across a fleet of
 *      independently owned vehicles.
 *
 * The preview is the important control. Every rate change is really a change
 * to what a passenger pays for a 5 km run, and reading that off a table of
 * base fares and per-kilometre rates is exactly the sort of arithmetic people
 * get wrong. So the form prices four real trips, live, as you type.
 */

import React, { useEffect, useMemo, useState } from 'react';

import { formatKina, normaliseRateVersion, quote, resolveRateVersion } from '@wantok/core';
import * as api from '../api';

/** Trips the operator will recognise, used to sanity-check a new rate. */
const SAMPLES = [
  { label: 'Boroko → Vision City', km: 6.2 },
  { label: 'Town → Jacksons Airport', km: 11.4 },
  { label: 'Short hop in Gordons', km: 1.8 },
  { label: 'Gerehu → Waigani', km: 9.1 },
];

export default function Rates({ profile }) {
  const [classes, setClasses] = useState([]);
  const [rates, setRates] = useState([]);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    const [c, r] = await Promise.all([api.getVehicleClasses(), api.getAllRates()]);
    setClasses(c);
    setRates(r);
  };

  useEffect(() => {
    load();
  }, []);

  const normalised = useMemo(() => rates.map(normaliseRateVersion), [rates]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rate tables</h1>
          <p>
            Versioned and append-only. Publishing a change never alters an existing booking's fare.
          </p>
        </div>
      </div>

      <div className="page-body">
        {classes.map((cls) => {
          const versions = rates.filter((r) => r.class_code === cls.code);
          const live = resolveRateVersion(normalised, cls.code, new Date());
          const staged = versions.filter((v) => new Date(v.effective_from) > new Date());

          return (
            <div className="card" key={cls.code}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div>
                  <h2>
                    {cls.name} <span className="muted mono small">{cls.code}</span>
                  </h2>
                  <p className="small muted" style={{ marginTop: 2 }}>
                    {cls.description} · {cls.seats} seats
                  </p>
                </div>
                <button className="btn small" onClick={() => setEditing({ cls, from: live })}>
                  Publish new rate
                </button>
              </div>

              {live ? (
                <>
                  <div className="grid stats" style={{ marginTop: 16 }}>
                    <Cell label="BASE FARE" value={formatKina(live.baseFare)} />
                    <Cell label="PER KM" value={formatKina(live.perKm)} />
                    <Cell label="MINIMUM" value={formatKina(live.minimumFare)} />
                    <Cell label="NIGHT" value={`×${live.nightMultiplier}`} />
                    <Cell label="ROUNDING" value={`K${live.rounding}`} />
                    <Cell label="COMMISSION" value={`${live.commissionPct}%`} />
                  </div>

                  <div style={{ marginTop: 14 }}>
                    <div className="small muted" style={{ marginBottom: 6 }}>
                      WHAT THAT MEANS FOR A PASSENGER
                    </div>
                    <table>
                      <tbody>
                        {SAMPLES.map((s) => {
                          const day = quote({ rate: live, distanceKm: s.km, startAt: at(12) });
                          const night = quote({ rate: live, distanceKm: s.km, startAt: at(21) });
                          return (
                            <tr key={s.label}>
                              <td className="small">{s.label}</td>
                              <td className="small muted">{s.km} km</td>
                              <td className="right">{formatKina(day.fare)}</td>
                              <td className="right small muted">{formatKina(night.fare)} at night</td>
                              <td className="right small muted">
                                {formatKina(day.commission)} commission
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="blocker" style={{ marginTop: 12 }}>
                  No rate in force for this class — the app cannot quote it.
                </div>
              )}

              {staged.length ? (
                <div className="blocker" style={{ background: 'var(--gold-soft)', color: '#7a5c00', marginTop: 12 }}>
                  {staged.length} staged change{staged.length > 1 ? 's' : ''}, next from{' '}
                  {new Date(staged[staged.length - 1].effective_from).toLocaleString('en-AU')}
                </div>
              ) : null}

              <details style={{ marginTop: 12 }}>
                <summary className="small muted" style={{ cursor: 'pointer' }}>
                  {versions.length} version{versions.length === 1 ? '' : 's'} in history
                </summary>
                <table style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th>Effective from</th>
                      <th className="right">Base</th>
                      <th className="right">Per km</th>
                      <th className="right">Minimum</th>
                      <th className="right">Night</th>
                      <th className="right">Commission</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.id}>
                        <td className="small nowrap">
                          {new Date(v.effective_from).toLocaleDateString('en-AU')}
                          {v.id === live?.id ? <span className="pill success" style={{ marginLeft: 6 }}>LIVE</span> : null}
                        </td>
                        <td className="right">{formatKina(v.base_fare)}</td>
                        <td className="right">{formatKina(v.per_km)}</td>
                        <td className="right">{formatKina(v.minimum_fare)}</td>
                        <td className="right">×{v.night_multiplier}</td>
                        <td className="right">{v.commission_pct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          );
        })}
      </div>

      {editing ? (
        <RateEditor
          cls={editing.cls}
          from={editing.from}
          profile={profile}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </>
  );
}

/** Port Moresby local hour as an instant, for the day/night preview. */
function at(hour) {
  const d = new Date();
  d.setUTCHours(hour - 10, 0, 0, 0);
  return d;
}

function RateEditor({ cls, from, profile, onClose, onDone }) {
  const [form, setForm] = useState({
    base_fare: from ? from.baseFare / 100 : 10,
    per_km: from ? from.perKm / 100 : 3.5,
    minimum_fare: from ? from.minimumFare / 100 : 20,
    night_multiplier: from?.nightMultiplier ?? 1.3,
    night_start: from?.nightStart ?? '20:00',
    night_end: from?.nightEnd ?? '05:00',
    rounding: from?.rounding ?? 5,
    service_fee: from ? from.serviceFee / 100 : 0,
    commission_pct: from?.commissionPct ?? 10,
    effective_from: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // Price the samples live, so the effect of a change is visible before it
  // is published rather than discovered by a driver at the kerb.
  const preview = useMemo(() => {
    try {
      const rate = normaliseRateVersion({
        id: 'preview',
        class_code: cls.code,
        base_fare: Number(form.base_fare),
        per_km: Number(form.per_km),
        minimum_fare: Number(form.minimum_fare),
        night_multiplier: Number(form.night_multiplier),
        night_start: form.night_start,
        night_end: form.night_end,
        rounding: Number(form.rounding),
        service_fee: Number(form.service_fee),
        commission_pct: Number(form.commission_pct),
        effective_from: new Date().toISOString(),
      });
      return SAMPLES.map((s) => ({
        ...s,
        day: quote({ rate, distanceKm: s.km, startAt: at(12) }),
        night: quote({ rate, distanceKm: s.km, startAt: at(21) }),
      }));
    } catch {
      return [];
    }
  }, [form, cls.code]);

  const publish = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.publishRate({
        class_code: cls.code,
        // Stored in toea. The form is in kina because that is what an admin
        // thinks in; the conversion happens once, here.
        base_fare: Math.round(Number(form.base_fare) * 100),
        per_km: Math.round(Number(form.per_km) * 100),
        minimum_fare: Math.round(Number(form.minimum_fare) * 100),
        night_multiplier: Number(form.night_multiplier),
        night_start: form.night_start,
        night_end: form.night_end,
        rounding: Number(form.rounding),
        service_fee: Math.round(Number(form.service_fee) * 100),
        commission_pct: Number(form.commission_pct),
        effective_from: form.effective_from
          ? new Date(form.effective_from).toISOString()
          : new Date().toISOString(),
        created_by: profile.id,
      });
      onDone();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="backdrop">
      <div className="modal">
        <div className="modal-head">
          <div>
            <h2>New rate for {cls.name}</h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              This publishes a new version. Nothing already booked changes price.
            </p>
          </div>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </div>

        <div className="modal-body">
          <div className="field-row">
            <Field label="Base fare (K)" value={form.base_fare} onChange={set('base_fare')} />
            <Field label="Per km (K)" value={form.per_km} onChange={set('per_km')} />
            <Field label="Minimum fare (K)" value={form.minimum_fare} onChange={set('minimum_fare')} />
          </div>
          <div className="field-row">
            <Field label="Night multiplier" value={form.night_multiplier} onChange={set('night_multiplier')} />
            <Field label="Night starts" value={form.night_start} onChange={set('night_start')} />
            <Field label="Night ends" value={form.night_end} onChange={set('night_end')} />
          </div>
          <div className="field-row">
            <Field label="Round up to (K)" value={form.rounding} onChange={set('rounding')} />
            <Field label="Service fee (K)" value={form.service_fee} onChange={set('service_fee')} />
            <Field label="Commission (%)" value={form.commission_pct} onChange={set('commission_pct')} />
          </div>

          <div className="field">
            <label>Effective from</label>
            <input type="datetime-local" value={form.effective_from} onChange={set('effective_from')} />
            <div className="small muted" style={{ marginTop: 4 }}>
              Leave blank to take effect immediately. A future date stages the change — it stays
              invisible to the apps until then.
            </div>
          </div>

          <h3 style={{ marginTop: 18 }}>What passengers would pay</h3>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Trip</th>
                <th className="right">Day</th>
                <th className="right">Night</th>
                <th className="right">Driver keeps (day)</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((p) => (
                <tr key={p.label}>
                  <td className="small">
                    {p.label} <span className="muted">{p.km} km</span>
                    {p.day.flooredToMinimum ? (
                      <span className="pill" style={{ marginLeft: 6 }}>AT MINIMUM</span>
                    ) : null}
                  </td>
                  <td className="right" style={{ fontWeight: 700 }}>{formatKina(p.day.fare)}</td>
                  <td className="right">{formatKina(p.night.fare)}</td>
                  <td className="right muted">{formatKina(p.day.driverNet)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {error ? <div className="blocker" style={{ marginTop: 12 }}>{error}</div> : null}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn" onClick={publish} disabled={saving}>
            {saving ? 'Publishing…' : 'Publish this rate'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input value={value} onChange={onChange} />
    </div>
  );
}

function Cell({ label, value }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );
}
