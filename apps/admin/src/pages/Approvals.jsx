/**
 * Vehicle approvals and the inspection checklist (spec §6).
 *
 * The spec calls registration "the platform's main trust asset" and says it
 * should not be automated away. This screen is where that promise is either
 * kept or quietly abandoned, so it is built to make the thorough path the easy
 * one:
 *
 *   - **Every blocker is listed at once**, not one rejection at a time. An
 *     admin fixes the file in a single conversation with the owner instead of
 *     three.
 *   - **The checklist is complete or it is not a verdict.** An unfilled item
 *     is not a pass; `evaluateInspection` returns no result until every line
 *     is marked, and the Approve button stays off.
 *   - **A failed critical item — brakes, seatbelts, lights, insurance,
 *     licence — blocks approval outright** and cannot be waived from this
 *     screen. The database refuses it too, so a determined click cannot get
 *     round it.
 *
 * Documents open through short-lived signed URLs. Licences and NIDs are never
 * publicly addressable (spec §16), so there is no plain image src anywhere in
 * this file.
 */

import React, { useCallback, useEffect, useState } from 'react';

import {
  INSPECTION_ITEMS,
  InspectionMark,
  InspectionResult,
  PHOTO_ANGLE_LABELS,
  REQUIRED_PHOTO_ANGLES,
  approvalBlockers,
  documentStatus,
  evaluateInspection,
} from '@wantok/core';

import * as api from '../api';

export default function Approvals({ profile, onChanged }) {
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setVehicles(await api.getPendingVehicles());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p>{vehicles.length} vehicles waiting. Inspect before approving — nothing here is a formality.</p>
        </div>
        <button className="btn ghost small" onClick={load}>Refresh</button>
      </div>

      <div className="page-body">
        <div className="card flush">
          <table>
            <thead>
              <tr>
                <th>Registration</th>
                <th>Vehicle</th>
                <th>Class</th>
                <th>Owner</th>
                <th>Documents</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => {
                const rego = documentStatus(v.rego_expiry);
                const insurance = documentStatus(v.insurance_expiry);
                const licence = documentStatus(v.drivers?.licence_expiry);
                const bad = [rego, insurance, licence].filter(
                  (d) => d.state === 'EXPIRED' || d.state === 'MISSING',
                ).length;

                return (
                  <tr key={v.id}>
                    <td className="mono">{v.registration_no}</td>
                    <td>
                      {v.colour} {v.make} {v.model}
                      <div className="small muted">{v.year} · {v.seats} seats</div>
                    </td>
                    <td>{v.class_code}</td>
                    <td className="small">
                      {v.owners?.nid_number}
                      <div className="muted">{v.owners?.bank_name}</div>
                    </td>
                    <td>
                      {bad ? (
                        <span className="pill danger">{bad} PROBLEM{bad > 1 ? 'S' : ''}</span>
                      ) : (
                        <span className="pill success">CURRENT</span>
                      )}
                    </td>
                    <td>
                      <span className="pill warning">{v.status.replace(/_/g, ' ')}</span>
                    </td>
                    <td className="right">
                      <button className="btn small" onClick={() => setOpen(v)}>
                        Open file
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {!vehicles.length ? (
            <div className="empty">{loading ? 'Loading…' : 'Nothing waiting for approval.'}</div>
          ) : null}
        </div>
      </div>

      {open ? (
        <VehicleFile
          vehicle={open}
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

function VehicleFile({ vehicle, profile, onClose, onDone }) {
  const [photos, setPhotos] = useState([]);
  const [inspection, setInspection] = useState(null);
  const [checklist, setChecklist] = useState({});
  const [odometer, setOdometer] = useState('');
  const [notes, setNotes] = useState('');
  const [photoUrls, setPhotoUrls] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      const [ps, inspections] = await Promise.all([
        api.getVehiclePhotos(vehicle.id),
        api.getInspections(vehicle.id),
      ]);
      setPhotos(ps);
      if (inspections.length) {
        setInspection(inspections[0]);
        setChecklist(inspections[0].checklist ?? {});
        setOdometer(String(inspections[0].odometer ?? ''));
      }

      // Signed URLs, 2 minutes. Long enough to look at, short enough that a
      // copied link is useless by the time it is pasted anywhere.
      const urls = {};
      await Promise.all(
        ps.map(async (p) => {
          try {
            urls[p.angle] = await api.signedUrl('vehicle-photos', p.url, 120);
          } catch {
            urls[p.angle] = null;
          }
        }),
      );
      setPhotoUrls(urls);
    })();
  }, [vehicle.id]);

  const mark = (key, value) =>
    setChecklist((c) => ({ ...c, [key]: { mark: value } }));

  const verdict = evaluateInspection(checklist);
  const blockers = approvalBlockers({
    vehicle,
    photos,
    inspection: verdict.complete ? { checklist, inspected_at: new Date().toISOString() } : inspection,
    driver: vehicle.drivers,
  });

  const saveInspection = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveInspection({
        vehicle_id: vehicle.id,
        inspector_id: profile.id,
        checklist,
        odometer: odometer ? Number(odometer) : null,
        result: verdict.result ?? InspectionResult.FAIL,
        notes: notes.trim() || null,
      });
      setInspection(saved);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const decide = async (status) => {
    setSaving(true);
    setError(null);
    try {
      if (!inspection && verdict.complete) await saveInspection();
      await api.setVehicleStatus(vehicle.id, status, profile.id);
      onDone();
    } catch (e) {
      // The database guard fires here if anything is out of order. Its message
      // names the specific problem, which is more use than a generic failure.
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="backdrop">
      <div className="modal">
        <div className="modal-head">
          <div>
            <h2>
              {vehicle.colour} {vehicle.make} {vehicle.model}
            </h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              <span className="mono">{vehicle.registration_no}</span> · {vehicle.class_code} ·{' '}
              {vehicle.seats} seats · {vehicle.year}
            </p>
          </div>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </div>

        <div className="modal-body">
          {/* --- What is stopping approval --------------------------- */}
          {blockers.length ? (
            <div style={{ marginBottom: 18 }}>
              <h3 style={{ marginBottom: 8 }}>Blocking approval</h3>
              {blockers.map((b) => (
                <div key={b.code} className="blocker">
                  <strong>{b.message}</strong>
                  {b.detail ? (
                    <span className="muted">
                      {Array.isArray(b.detail) ? b.detail.join(', ') : b.detail}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="blocker" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>
              Everything in order. This vehicle can be approved.
            </div>
          )}

          {/* --- Documents -------------------------------------------- */}
          <h3 style={{ marginTop: 18 }}>Documents</h3>
          <table style={{ marginTop: 8 }}>
            <tbody>
              {[
                ['Registration', vehicle.rego_expiry],
                ['Insurance', vehicle.insurance_expiry],
                ['Driver licence', vehicle.drivers?.licence_expiry],
              ].map(([label, expiry]) => {
                const status = documentStatus(expiry);
                return (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="mono small">{expiry ?? 'not supplied'}</td>
                    <td className="right">
                      <span
                        className={`pill ${
                          status.state === 'CURRENT'
                            ? 'success'
                            : status.state === 'WARNING'
                              ? 'warning'
                              : 'danger'
                        }`}
                      >
                        {status.state === 'CURRENT'
                          ? `${status.daysLeft} DAYS`
                          : status.state === 'WARNING'
                            ? `${status.daysLeft} DAYS LEFT`
                            : status.state}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* --- Photographs ------------------------------------------ */}
          <h3 style={{ marginTop: 18 }}>
            Photographs ({photos.length} of {REQUIRED_PHOTO_ANGLES.length})
          </h3>
          <div className="photo-grid" style={{ marginTop: 8 }}>
            {REQUIRED_PHOTO_ANGLES.map((angle) =>
              photoUrls[angle] ? (
                <a key={angle} href={photoUrls[angle]} target="_blank" rel="noreferrer">
                  <img src={photoUrls[angle]} alt={PHOTO_ANGLE_LABELS[angle]} />
                </a>
              ) : (
                <div key={angle} className="missing">
                  {PHOTO_ANGLE_LABELS[angle]}
                  <br />
                  missing
                </div>
              ),
            )}
          </div>

          {/* --- The checklist ---------------------------------------- */}
          <h3 style={{ marginTop: 22 }}>Physical inspection</h3>
          <p className="small muted" style={{ marginBottom: 10 }}>
            Every line must be marked. A failed critical item blocks approval and cannot be waived
            here.
          </p>

          <div className="card" style={{ padding: '4px 14px' }}>
            {INSPECTION_ITEMS.map((item) => {
              const current = checklist[item.key]?.mark;
              return (
                <div className="check-row" key={item.key}>
                  <div className="name">
                    {item.label}
                    {item.critical ? <span className="critical"> CRITICAL</span> : null}
                  </div>
                  <div className="marks">
                    {[InspectionMark.PASS, InspectionMark.FAIL, InspectionMark.NOTE].map((m) => (
                      <button
                        key={m}
                        className={`mark ${current === m ? `on-${m.toLowerCase()}` : ''}`}
                        onClick={() => mark(item.key, m)}
                      >
                        {m[0] + m.slice(1).toLowerCase()}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="field-row" style={{ marginTop: 14 }}>
            <div className="field">
              <label>Odometer</label>
              <input value={odometer} onChange={(e) => setOdometer(e.target.value)} inputMode="numeric" />
            </div>
            <div className="field">
              <label>Verdict</label>
              <input
                readOnly
                value={
                  verdict.complete
                    ? verdict.result
                    : `${verdict.missing.length} items not marked`
                }
              />
            </div>
          </div>

          <div className="field">
            <label>Inspector notes</label>
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {error ? <div className="blocker">{error}</div> : null}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={saveInspection} disabled={saving || !verdict.complete}>
            Save inspection
          </button>
          <button className="btn danger" onClick={() => decide('REJECTED')} disabled={saving}>
            Reject
          </button>
          <button className="btn" onClick={() => decide('APPROVED')} disabled={saving || blockers.length > 0}>
            {saving ? 'Working…' : 'Approve and go live'}
          </button>
        </div>
      </div>
    </div>
  );
}
