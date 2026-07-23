// Maps Garmin's activityType.typeKey values to Cadence's controlled sport
// vocabulary (ISC-32). Built from Garmin Connect's documented activity type
// list. Anything not explicitly listed falls back to "other" rather than
// throwing — an unrecognized type must never abort a sync (ISC-28).

import type { Sport } from "../db";

const EXACT_MAP: Record<string, Sport> = {
  // Outdoor / real-world cycling
  cycling: "cycling",
  road_biking: "cycling",
  mountain_biking: "cycling",
  gravel_cycling: "cycling",
  cyclocross: "cycling",
  track_cycling: "cycling",
  recumbent_cycling: "cycling",
  handcycling: "cycling",
  e_bike_fitness: "cycling",
  e_bike_mountain: "cycling",
  indoor_cycling: "cycling", // stationary trainer, not Zwift/virtual

  // Zwift and other virtual rides flow in via Garmin auto-upload
  virtual_ride: "virtual_cycling",
  virtual_cycling: "virtual_cycling",

  // Swimming
  lap_swimming: "swimming",
  open_water_swimming: "swimming",
  swimming: "swimming",

  // Running
  running: "running",
  trail_running: "running",
  treadmill_running: "running",
  track_running: "running",
  street_running: "running",
  ultra_run: "running",
  virtual_run: "running",

  // Strength
  strength_training: "strength",
  indoor_cardio: "strength",

  // Golf: Garmin Connect typeKey for rounds recorded by watch or the
  // Garmin Golf app sync. Deliberately narrow: disc_golf is NOT a round of
  // golf and stays other.
  golf: "golf",
};

export function mapGarminTypeToSport(typeKey: string): Sport {
  return EXACT_MAP[typeKey] ?? "other";
}
