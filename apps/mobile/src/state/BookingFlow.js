/**
 * The customer's booking attempt.
 *
 * One object carried across five screens — pickup, destination, the quoted
 * route, and the vehicles that have already said no.
 *
 * That last list is the important one. Spec §7, step 7: when a driver declines
 * or lets the countdown run out, the customer goes back to the list *with that
 * vehicle removed and the fare still held*. The platform never silently
 * reassigns, because the customer chose that vehicle, that driver and that
 * price deliberately.
 *
 * Holding the fare falls out of holding the route: the distance is fixed for
 * the attempt, so re-quoting the same class returns the identical number and
 * the price does not move under the customer while they are recovering from
 * someone else's decline.
 */

import React, { createContext, useCallback, useContext, useMemo, useReducer } from 'react';

import { getQuoteRoute } from '../services/maps';

const FlowContext = createContext(null);

const initial = {
  pickup: null,        // { lat, lng, label }
  destination: null,   // { lat, lng, label }
  route: null,         // { distanceKm, seconds, path }
  seatsNeeded: 1,
  scheduledFor: null,  // ISO string, or null for an immediate booking
  noteToDriver: null,
  /** Vehicles that declined or timed out on *this* attempt. */
  excludedVehicleIds: [],
  routeError: null,
  loadingRoute: false,
};

function reducer(state, action) {
  switch (action.type) {
    case 'PICKUP':
      // Changing either end invalidates the route and, with it, the price.
      return { ...state, pickup: action.pickup, route: null, excludedVehicleIds: [] };
    case 'DESTINATION':
      return { ...state, destination: action.destination, route: null, excludedVehicleIds: [] };
    case 'SWAP':
      return { ...state, pickup: state.destination, destination: state.pickup, route: null };
    case 'ROUTE_LOADING':
      return { ...state, loadingRoute: true, routeError: null };
    case 'ROUTE':
      return { ...state, route: action.route, loadingRoute: false, routeError: null };
    case 'ROUTE_ERROR':
      return { ...state, loadingRoute: false, routeError: action.error };
    case 'SEATS':
      return { ...state, seatsNeeded: action.seats };
    case 'SCHEDULE':
      return { ...state, scheduledFor: action.scheduledFor };
    case 'NOTE':
      return { ...state, noteToDriver: action.note };
    case 'EXCLUDE':
      return { ...state, excludedVehicleIds: [...state.excludedVehicleIds, action.vehicleId] };
    case 'RESET':
      return initial;
    default:
      return state;
  }
}

export function BookingFlowProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial);

  /**
   * Fetch the route being quoted.
   *
   * This is the one Directions call of the booking attempt (spec §13, rule 2).
   * The service caches it for ten minutes, so a customer opening four vehicles
   * and backing out of three still costs one call.
   */
  const loadRoute = useCallback(async (pickup, destination) => {
    const from = pickup ?? state.pickup;
    const to = destination ?? state.destination;
    if (!from || !to) return null;

    dispatch({ type: 'ROUTE_LOADING' });
    try {
      const route = await getQuoteRoute(from, to);
      dispatch({ type: 'ROUTE', route });
      return route;
    } catch (error) {
      dispatch({
        type: 'ROUTE_ERROR',
        error:
          error.status === 'NO_ROUTE'
            ? 'There is no road route between those two points. Try a nearby landmark.'
            : 'Could not work out the route. Check your connection and try again.',
      });
      return null;
    }
  }, [state.pickup, state.destination]);

  const value = useMemo(
    () => ({
      ...state,
      ready: Boolean(state.pickup && state.destination),
      setPickup: (pickup) => dispatch({ type: 'PICKUP', pickup }),
      setDestination: (destination) => dispatch({ type: 'DESTINATION', destination }),
      swap: () => dispatch({ type: 'SWAP' }),
      setSeats: (seats) => dispatch({ type: 'SEATS', seats }),
      setSchedule: (scheduledFor) => dispatch({ type: 'SCHEDULE', scheduledFor }),
      setNote: (note) => dispatch({ type: 'NOTE', note }),
      exclude: (vehicleId) => dispatch({ type: 'EXCLUDE', vehicleId }),
      reset: () => dispatch({ type: 'RESET' }),
      loadRoute,
    }),
    [state, loadRoute],
  );

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>;
}

export function useBookingFlow() {
  const context = useContext(FlowContext);
  if (!context) throw new Error('useBookingFlow must be used inside BookingFlowProvider');
  return context;
}
