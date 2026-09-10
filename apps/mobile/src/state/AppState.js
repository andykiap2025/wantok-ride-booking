/**
 * Application state.
 *
 * Three things live here because every screen needs them and none of them
 * belongs to a screen: who is signed in, whether there is a connection, and
 * the rate table.
 *
 * The rate table is the interesting one. Spec §14: it is cached with its
 * version stamp, refreshed on app open and before any quote, and **a quote is
 * never produced from a table older than 24 hours**. So `rates` here always
 * carries its own freshness, and `canQuote` is what the booking screens check
 * before they offer a price. Refusing to quote is a feature; guessing is not.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { AppState as RNAppState } from 'react-native';

import { isRateTableFresh } from '@wantok/core';

import * as api from '../services/supabase';
import * as offline from '../services/offline';

const AppContext = createContext(null);

const initial = {
  status: 'LOADING', // LOADING | SIGNED_OUT | SIGNED_IN
  session: null,
  profile: null,
  driver: null,
  owner: null,
  vehicle: null,

  rates: null,
  ratesFetchedAt: null,

  connection: 'online', // online | offline | searching | syncing
  pendingActions: 0,
  error: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'RESTORED':
      return { ...state, ...action.payload, status: action.payload.session ? 'SIGNED_IN' : 'SIGNED_OUT' };
    case 'SIGNED_IN':
      return { ...state, status: 'SIGNED_IN', session: action.session, profile: action.profile };
    case 'SIGNED_OUT':
      return { ...initial, status: 'SIGNED_OUT' };
    case 'PROFILE':
      return { ...state, profile: action.profile };
    case 'ROLES':
      return { ...state, driver: action.driver, owner: action.owner, vehicle: action.vehicle };
    case 'RATES':
      return { ...state, rates: action.rates, ratesFetchedAt: action.fetchedAt };
    case 'CONNECTION':
      return { ...state, connection: action.connection };
    case 'PENDING':
      return { ...state, pendingActions: action.count };
    case 'ERROR':
      return { ...state, error: action.error };
    default:
      return state;
  }
}

export function AppStateProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const refreshing = useRef(false);

  // --- Rates ---------------------------------------------------------

  /**
   * Refresh the rate table, falling back to the local mirror.
   *
   * A handset that has been out of coverage still gets *a* table — it just
   * may not be fresh enough to quote from, which the UI then says out loud
   * rather than silently pricing from stale data.
   */
  const refreshRates = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const rates = await api.getRates();
      await offline.cacheRates(rates);
      dispatch({ type: 'RATES', rates, fetchedAt: new Date().toISOString() });
      dispatch({ type: 'CONNECTION', connection: 'online' });
    } catch {
      const cached = await offline.getCachedRates();
      if (cached.rates) {
        dispatch({ type: 'RATES', rates: cached.rates, fetchedAt: cached.fetchedAt });
      }
      dispatch({ type: 'CONNECTION', connection: 'offline' });
    } finally {
      refreshing.current = false;
    }
  }, []);

  // --- Session -------------------------------------------------------

  const loadRoles = useCallback(async (profile) => {
    if (!profile) return;
    try {
      const [driver, owner] = await Promise.all([
        api.getDriverForProfile(profile.id).catch(() => null),
        api.getOwnerForProfile(profile.id).catch(() => null),
      ]);
      const vehicle = driver ? await api.getVehicleForDriver(driver.id).catch(() => null) : null;
      dispatch({ type: 'ROLES', driver, owner, vehicle });
    } catch {
      // Roles are a refinement, not a gate. A customer with no driver row is
      // the common case and must not look like an error.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const session = await api.getSession().catch(() => null);
      let profile = null;

      if (session) {
        profile = await api.getProfile(session.user.id).catch(() => null);
        if (profile) await offline.cacheProfile(profile);
        else profile = await offline.getCachedProfile();
      }

      if (cancelled) return;
      dispatch({ type: 'RESTORED', payload: { session, profile } });
      if (profile) loadRoles(profile);
      refreshRates();
    })();

    const { data: sub } = api.supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        await offline.clearAll();
        dispatch({ type: 'SIGNED_OUT' });
        return;
      }
      if (session) {
        const profile = await api.getProfile(session.user.id).catch(() => null);
        dispatch({ type: 'SIGNED_IN', session, profile });
        if (profile) {
          await offline.cacheProfile(profile);
          loadRoles(profile);
        }
      }
    });

    return () => {
      cancelled = true;
      sub?.subscription?.unsubscribe();
    };
  }, [loadRoles, refreshRates]);

  // --- Foreground refresh --------------------------------------------

  useEffect(() => {
    // Spec §14: refresh on app open. A driver who left the app open overnight
    // must not quote from yesterday's table when he picks the phone up.
    const sub = RNAppState.addEventListener('change', (next) => {
      if (next === 'active') {
        refreshRates();
        offline.pendingCount().then((count) => dispatch({ type: 'PENDING', count }));
      }
    });
    return () => sub.remove();
  }, [refreshRates]);

  // --- The offline queue ---------------------------------------------

  const flush = useCallback(async () => {
    const count = await offline.pendingCount();
    if (!count) {
      dispatch({ type: 'PENDING', count: 0 });
      return;
    }
    dispatch({ type: 'CONNECTION', connection: 'syncing' });
    dispatch({ type: 'PENDING', count });

    const result = await offline.flushQueue(api.transition);
    const left = await offline.pendingCount();
    dispatch({ type: 'PENDING', count: left });
    dispatch({ type: 'CONNECTION', connection: left ? 'offline' : 'online' });
    return result;
  }, []);

  useEffect(() => {
    if (state.status !== 'SIGNED_IN') return undefined;
    const timer = setInterval(flush, 20_000);
    flush();
    return () => clearInterval(timer);
  }, [state.status, flush]);

  // --- Derived --------------------------------------------------------

  const value = useMemo(
    () => ({
      ...state,
      /**
       * May the app produce a price right now? (spec §14)
       *
       * Both halves matter: a table that exists but is 26 hours old is not
       * a table you may quote from.
       */
      canQuote: Boolean(state.rates?.length) && isRateTableFresh(state.ratesFetchedAt),
      isDriver: Boolean(state.driver),
      isOwner: Boolean(state.owner),
      refreshRates,
      flush,
      setConnection: (connection) => dispatch({ type: 'CONNECTION', connection }),
      setProfile: (profile) => dispatch({ type: 'PROFILE', profile }),
      reloadRoles: () => loadRoles(state.profile),
      signOut: async () => {
        await api.signOut().catch(() => null);
        await offline.clearAll();
        dispatch({ type: 'SIGNED_OUT' });
      },
    }),
    [state, refreshRates, flush, loadRoles],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppStateProvider');
  return context;
}
