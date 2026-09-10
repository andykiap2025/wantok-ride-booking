/**
 * Wantok Ride palette.
 *
 * ⚠ Branding is open decision #1 in the spec. This is a proposal, not a
 * sign-off. What follows is the reasoning, so it can be argued with.
 *
 * The source design kit ran red as the brand colour *and* as the stop colour.
 * That is the one thing in it worth changing outright, and safety is the
 * reason: this product has an SOS button. If red is also the colour of the
 * header, the logo and every primary button, then red has stopped meaning
 * anything by the time it matters.
 *
 * So:
 *
 *   - **Gold** (#FCD116, the bird of paradise on the PNG flag) carries every
 *     call to action. It is the one colour that holds up over bright tropical
 *     photography, which is what the brand plates are.
 *   - **Ink**, a near-black charcoal, is the brand surface — headers, the
 *     drawer, hero panels. Unmistakably PNG next to the gold, and it lets
 *     photography do the talking.
 *   - **Red** (#CE1126, PNG flag red) is reserved, strictly, for SOS, cancel
 *     and errors. Nothing else in the product is red. That is the whole point.
 *   - **Harbour blue** and **route green** are sampled from the Fairfax
 *     Harbour and live-tracking plates, so the UI sits inside the photography
 *     rather than on top of it.
 */

export const colors = {
  // --- Brand ---------------------------------------------------------
  /** Header, drawer, hero panels. */
  ink: '#141A21',
  inkSoft: '#1E2833',
  inkLift: '#2A3644',

  /** The call to action. Bird-of-paradise gold. */
  gold: '#FCD116',
  goldDark: '#E0B900',
  goldSoft: '#FFF6D0',
  goldFaint: '#FFFBEC',
  /** Text and icons sitting on gold. Never white — it fails contrast. */
  onGold: '#241C00',

  // --- Ocean (links, info, the driver's route) -------------------------
  harbour: '#0E6BA8',
  harbourLight: '#3E9BD6',
  sky: '#8FCBEF',
  harbourSoft: '#E7F2FA',

  /** The live-tracking polyline, straight off the brand plate. */
  route: '#22C55E',
  routeSoft: '#E8F8EE',

  // --- Neutrals -------------------------------------------------------
  bg: '#F6F7F9',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F3F6',
  border: '#E3E7EC',
  borderStrong: '#C9D1DA',
  text: '#141A21',
  textMuted: '#5C6773',
  grey: '#8794A1',
  greyLight: '#B8C2CC',

  // --- States ---------------------------------------------------------
  success: '#1B8F4A',
  successSoft: '#E6F5EC',
  warning: '#C77700',
  warningSoft: '#FFF3DE',

  /**
   * Reserved. SOS, cancel a booking, destructive confirmations, form errors.
   * If you are reaching for this for anything else, reach for `gold` or
   * `harbour` instead.
   */
  danger: '#CE1126',
  dangerDark: '#A50D1E',
  dangerSoft: '#FDECEE',

  white: '#FFFFFF',
  black: '#000000',
  overlay: 'rgba(20,26,33,0.55)',
  scrim: 'rgba(0,0,0,0.45)',
};

/** Gradients used over the Port Moresby photography. */
export const gradients = {
  /** Top scrim, so white headline text survives an open sky. */
  heroTop: ['rgba(20,26,33,0.90)', 'rgba(20,26,33,0.45)', 'rgba(20,26,33,0)'],
  /** Bottom scrim, so controls read against foliage and road. */
  heroBottom: ['rgba(20,26,33,0)', 'rgba(20,26,33,0.72)', 'rgba(20,26,33,0.96)'],
  header: ['#141A21', '#1E2833'],
  gold: ['#FCD116', '#E8B800'],
  harbour: ['#0E6BA8', '#3E9BD6'],
  /** Behind the SOS button while it is being held down. */
  alarm: ['#CE1126', '#8E0A18'],
};

/** Vehicle class accent colours, used on list rows and the class chips. */
export const classColors = {
  SEDAN: '#0E6BA8',
  UTE: '#B45309',
  WAGON4WD: '#1B8F4A',
  BUS10: '#6D28D9',
};
