import { GEO } from './geodata.js';

// js/city-config.js
// The simulated city's spatial configuration & street database: Tehran's, built from OpenStreetMap by
// tools/city/build.mjs (GEO version 2) and served by open-city-config.js.
const config = await import('./open-city-config.js');

export const {
  CITY, LAND_REGIONS, SPAWN, DETAIL_POLYGON, WATER_BODIES, AVENUES, ALL_AVENUES, CENTRAL_PARK_BOUNDS,
  getIslandBoundsAtZ, MANHATTAN_COASTLINE, getBroadwayX, BROADWAY_LINE, WATERFRONT_PIERS, ROOSEVELT_ISLAND_POLYGON,
  GOVERNORS_ISLAND_POLYGON, NJ_SHORELINE_POLYGON, LONG_ISLAND_POLYGON, LONG_ISLAND_POLYGONS, BROOKLYN_POLYGONS,
  QUEENS_POLYGONS, BRONX_POLYGONS, WESTCHESTER_POLYGON, NASSAU_POLYGON, UPPER_MANHATTAN_POLYGON, BRONX_POLYGON,
  STATEN_ISLAND_POLYGON, RANDALLS_ISLAND_POLYGON, LIBERTY_ISLAND_POLYGON, LIBERTY_STATUE_POS, ELLIS_ISLAND_POLYGON,
  MILL_ROCK_POLYGON, EAST_RIVER_BRIDGES, OUTER_BRIDGES, STREETS, ALL_STREETS, ROADS, NYC_LANDMARKS, LANDMARK_SITES,
  TELEPORT_LOCATIONS, ISLAND_BOUNDS, LANDMARK_BLOCKS, BLOCKS, CUT_Z, SIGNAL_TIMING, streetZ, avenueX, avenueNameAt,
  districtAt, blockAt, blocksInRect, nearestRoads, getBlockBounds, getLocationLabel, fromOldFrame, isTypingInField,
  signalPhase, walkSignal
} = config;
