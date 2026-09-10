/**
 * The domain engine, inside the edge runtime.
 *
 * `@wantok/core` is plain ESM with no dependencies and no I/O, which is
 * exactly what makes it portable: the same `applyEvent` that greys out a
 * button on a driver's phone decides whether the transition is legal here.
 * One implementation, one set of tests, no drift between what the app thinks
 * the rules are and what the server enforces.
 *
 * Supabase deploys the `functions/` directory and nothing above it, so the
 * package is vendored into `_shared/core/` rather than imported across the
 * workspace. Run this before deploying:
 *
 *     npm run sync:core        # copies packages/core/src -> _shared/core
 *
 * The copy is checked in so a deploy is reproducible from a clean clone, and
 * `npm test` still runs against the original. If the two ever disagree, the
 * package is the source of truth and the copy is stale — re-run the sync.
 */

// @ts-ignore — plain JS, deliberately untyped. The functions that use it are
// small enough that JSDoc in the source carries the meaning.
export * from './core/index.js';
