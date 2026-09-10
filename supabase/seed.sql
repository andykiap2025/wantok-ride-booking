-- =====================================================================
-- Wantok Ride — seed
--
-- Vehicle classes, and a launch rate table.
--
-- ⚠ The kina figures below are **open decision #2 in the spec** and are not
-- signed off. The SEDAN row is the worked example from spec §5; the other
-- three are scaled from it and are placeholders until someone who runs a
-- vehicle in Port Moresby has priced them. They are here so the app has
-- something to quote from on day one, not because they are right.
--
-- Changing a rate later means INSERTing a new version with a future
-- `effective_from`. The table is append-only by rule — an UPDATE is silently
-- discarded — so an old booking can always be explained.
-- =====================================================================

insert into vehicle_classes (code, name, seats, description, sort_order, active) values
  ('SEDAN',    'Small sedan',      4,  'Town runs on sealed roads',                1, true),
  ('UTE',      'Twin cab utility', 4,  'Rough roads, some load space',             2, true),
  ('WAGON4WD', '4WD wagon',        7,  'Settlements, wet season, out of town',     3, true),
  ('BUS10',    '10-seater bus',    10, 'Groups and airport runs',                  4, true)
on conflict (code) do nothing;

-- Amounts are toea. K10.00 is 1000.
insert into rate_versions (
  class_code, base_fare, per_km, minimum_fare,
  night_multiplier, night_start, night_end, rounding,
  service_fee, commission_pct, effective_from
) values
  -- Spec §5's worked example, exactly as written.
  ('SEDAN',    1000, 350, 2000, 1.30, '20:00', '05:00', 5, 0, 10.00, '2026-01-01T00:00:00Z'),
  ('UTE',      1200, 400, 2500, 1.30, '20:00', '05:00', 5, 0, 10.00, '2026-01-01T00:00:00Z'),
  ('WAGON4WD', 1500, 500, 3000, 1.30, '20:00', '05:00', 5, 0, 10.00, '2026-01-01T00:00:00Z'),
  -- Open decision #6: whether buses are distance-priced like everything else
  -- or run fixed charter routes. Distance-priced here, pending that call.
  ('BUS10',    2500, 600, 6000, 1.30, '20:00', '05:00', 5, 0, 10.00, '2026-01-01T00:00:00Z');
