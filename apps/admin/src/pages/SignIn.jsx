/**
 * Admin sign-in.
 *
 * Same phone OTP as the apps (spec §16) — no passwords anywhere in the
 * product, for any role.
 *
 * Spec §16 also requires a second factor on the console. Supabase Auth's TOTP
 * enrolment is the intended mechanism and is enforced at the project level
 * rather than here; this screen surfaces the challenge when the project
 * demands it. Until MFA is switched on for the admin accounts, this is
 * single-factor and the banner below says so rather than pretending otherwise.
 */

import React, { useState } from 'react';

import { isValidPngMobile, normalisePhone } from '@wantok/core';
import * as api from '../api';

export default function SignIn() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const send = async () => {
    if (!isValidPngMobile(phone)) {
      setError('Enter a PNG mobile number');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.requestOtp(normalisePhone(phone));
      setStage('code');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.verifyOtp(normalisePhone(phone), code);
      // The auth listener in App takes it from here.
    } catch (e) {
      setError('That code is not right, or it has expired.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <div className="card">
        <h1>Wantok Ride Admin</h1>
        <p className="muted small" style={{ marginTop: 6, marginBottom: 20 }}>
          Skyworks staff only. Sign in with the mobile number on your staff account.
        </p>

        {stage === 'phone' ? (
          <>
            <div className="field">
              <label>Mobile number</label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="7412 8860"
                inputMode="numeric"
                onKeyDown={(e) => e.key === 'Enter' && send()}
              />
            </div>
            <button className="btn" onClick={send} disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </>
        ) : (
          <>
            <div className="field">
              <label>6-digit code</label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                inputMode="numeric"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && verify()}
              />
            </div>
            <button className="btn" onClick={verify} disabled={busy || code.length < 6} style={{ width: '100%' }}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <button
              className="btn ghost"
              style={{ width: '100%', marginTop: 8 }}
              onClick={() => {
                setStage('phone');
                setCode('');
                setError(null);
              }}
            >
              Use a different number
            </button>
          </>
        )}

        {error ? (
          <div className="blocker" style={{ marginTop: 14 }}>
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
