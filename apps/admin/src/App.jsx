/**
 * The admin console shell.
 *
 * Spec §17 is clear that admin is a staffed function, not just a screen — the
 * daily list is approve pending vehicles, verify owner payments, clear the
 * dispute queue, review flagged drivers, watch the board. So the navigation is
 * that list, in that order, with live counts against each one. The console
 * should tell someone what needs doing before they have clicked anything.
 *
 * The SOS alarm sits outside the router because it has to. An alarm that only
 * shows on the SOS page is an alarm that goes unheard on the approvals page,
 * and spec §10 puts a two-minute acknowledgement target on it.
 */

import React, { useCallback, useEffect, useState } from 'react';

import * as api from './api';
import SignIn from './pages/SignIn';
import AlarmBar from './components/AlarmBar';
import LiveBoard from './pages/LiveBoard';
import Approvals from './pages/Approvals';
import Money from './pages/Money';
import Rates from './pages/Rates';
import Disputes from './pages/Disputes';
import SosLog from './pages/SosLog';
import Reports from './pages/Reports';

const PAGES = [
  { key: 'board', label: 'Live board', component: LiveBoard },
  { key: 'approvals', label: 'Approvals', component: Approvals },
  { key: 'money', label: 'Payments', component: Money },
  { key: 'disputes', label: 'Disputes', component: Disputes },
  { key: 'sos', label: 'SOS log', component: SosLog },
  { key: 'rates', label: 'Rate tables', component: Rates },
  { key: 'reports', label: 'Reports', component: Reports },
];

export default function App() {
  const [auth, setAuth] = useState(undefined); // undefined = still checking
  const [page, setPage] = useState('board');
  const [counts, setCounts] = useState({});
  const [openSos, setOpenSos] = useState([]);

  // --- Session ---------------------------------------------------------

  useEffect(() => {
    api.getSessionProfile().then(setAuth).catch(() => setAuth(null));
    const { data } = api.supabase.auth.onAuthStateChange(() => {
      api.getSessionProfile().then(setAuth).catch(() => setAuth(null));
    });
    return () => data?.subscription?.unsubscribe();
  }, []);

  // --- What needs doing -------------------------------------------------

  const refreshCounts = useCallback(async () => {
    if (!auth) return;
    const [vehicles, payments, disputes, sos] = await Promise.all([
      api.getPendingVehicles().catch(() => []),
      api.getPendingPayments().catch(() => []),
      api.getOpenDisputes().catch(() => []),
      api.getOpenSos().catch(() => []),
    ]);
    setCounts({
      approvals: vehicles.length,
      money: payments.length,
      disputes: disputes.length,
      sos: sos.length,
    });
    setOpenSos(sos);
  }, [auth]);

  useEffect(() => {
    refreshCounts();
    const timer = setInterval(refreshCounts, 30_000);
    return () => clearInterval(timer);
  }, [refreshCounts]);

  // A new SOS must arrive without waiting for the 30-second poll.
  useEffect(() => {
    if (!auth) return undefined;
    return api.watchSos((event) => setOpenSos((current) => [event, ...current]));
  }, [auth]);

  if (auth === undefined) {
    return <div className="empty">Loading…</div>;
  }

  if (!auth) {
    return <SignIn />;
  }

  const isAdmin = (auth.profile?.role ?? []).some((r) => r === 'ADMIN' || r === 'SUPER_ADMIN');
  if (!isAdmin) {
    return (
      <div className="signin">
        <div className="card">
          <h2>Not an admin account</h2>
          <p className="muted" style={{ marginTop: 8 }}>
            This console is for Skyworks staff. Your account does not carry an admin role.
          </p>
          <button className="btn ghost" style={{ marginTop: 16 }} onClick={api.signOut}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const Current = PAGES.find((p) => p.key === page)?.component ?? LiveBoard;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <div className="brand-name">
            Wantok<span> Ride</span>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.5)' }}>ADMIN</div>
          </div>
        </div>

        <nav className="nav">
          {PAGES.map((p) => (
            <button
              key={p.key}
              className={`nav-item ${page === p.key ? 'on' : ''}`}
              onClick={() => setPage(p.key)}
            >
              <span>{p.label}</span>
              {counts[p.key] ? (
                <span className={`nav-count ${p.key === 'sos' ? 'alarm' : ''}`}>{counts[p.key]}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div>{auth.profile.full_name}</div>
          <button onClick={api.signOut}>Sign out</button>
        </div>
      </aside>

      <main className="main">
        {/* Above every page, always, until it is acknowledged with a note. */}
        <AlarmBar
          events={openSos}
          adminId={auth.profile.id}
          onAcknowledged={(id) => {
            setOpenSos((current) => current.filter((e) => e.id !== id));
            refreshCounts();
          }}
          onOpenLog={() => setPage('sos')}
        />
        <Current profile={auth.profile} onChanged={refreshCounts} />
      </main>
    </div>
  );
}

function Mark() {
  return (
    <svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="32" fill="#FCD116" />
      <path d="M 18 46 C 18 34, 46 30, 46 18" stroke="#141A21" strokeWidth="5" strokeLinecap="round" fill="none" />
      <circle cx="18" cy="46" r="7" fill="#141A21" />
      <circle cx="46" cy="18" r="7" fill="#141A21" />
      <circle cx="18" cy="46" r="2.6" fill="#FCD116" />
      <circle cx="46" cy="18" r="2.6" fill="#FCD116" />
    </svg>
  );
}
