import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import protobuf from 'protobufjs';
import ScheduleLoader from './schedule-loader.js';

// In server.js, change the imports to:
import {
  extractBlockIdFromTripId,
  getShapeIdFromTrip,
  isTripCurrentlyActive,
  findCurrentSegmentAndProgress,  // Changed name
  calculateVirtualBusPosition,    // New function
  getRouteDisplayName,
  timeStringToSeconds,            
  getScheduleTimeInSeconds,
  isTripActiveInStaticSchedule,
  getStaticScheduleForTrip,
  isTripScheduledToday,           // NEW: Add this import
  isTripActiveAndScheduled,        // NEW: Add this import
  getScheduleTimeFromUnix
} from './virtual-vehicles.js';

//construct Cache to throttle back virtual bus feed to 5 seconds
const virtualBusesCache = new Map(); // operatorId -> { virtualEntities, timestamp }
const virtualsCache = new Map(); // operatorId -> { data, timestamp }

const scheduleLoader = new ScheduleLoader();
const app = express();
app.use(cors());

// Constants
const GTFS_PROTO_URL = 'https://raw.githubusercontent.com/google/transit/master/gtfs-realtime/proto/gtfs-realtime.proto';
const BASE_URL = 'https://bct.tmix.se/gtfs-realtime';
const DEFAULT_OPERATOR_ID = '36';
let root = null;

//clean caches periodically
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  let cleanedVirtuals = 0;
  let cleanedBuses = 0;
  
  // Clean virtualsCache
  for (const [key, value] of virtualsCache.entries()) {
    if (now - value.timestamp > 300) {
      virtualsCache.delete(key);
      cleanedVirtuals++;
    }
  }
  
  // Clean virtualBusesCache
  for (const [key, value] of virtualBusesCache.entries()) {
    if (now - value.timestamp > 300) {
      virtualBusesCache.delete(key);
      cleanedBuses++;
    }
  }
  
  if (cleanedVirtuals > 0 || cleanedBuses > 0) {
    console.log(`[CACHE-CLEANUP] Removed ${cleanedVirtuals} from virtualsCache, ${cleanedBuses} from virtualBusesCache`);
    console.log(`[CACHE-STATS] Current: virtualsCache=${virtualsCache.size}, virtualBusesCache=${virtualBusesCache.size}`);
  }
}, 60000); // Run every minute

// helper function
function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Load proto once
async function loadProto() {
  try {
    const response = await fetch(GTFS_PROTO_URL);
    const protoText = await response.text();
    root = protobuf.parse(protoText).root;
    console.log('✅ GTFS proto loaded');
  } catch (error) {
    console.error('❌ Failed to load proto:', error);
  }
}

// Fetch + decode GTFS feed
async function fetchGTFSFeed(feedType, operatorId = DEFAULT_OPERATOR_ID) {
  if (!root) throw new Error('Proto not loaded');
  const url = `${BASE_URL}/${feedType}?operatorIds=${operatorId}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
    const message = FeedMessage.decode(new Uint8Array(buffer));
    const data = FeedMessage.toObject(message, { defaults: true, longs: String, enums: String, bytes: String });
    return { success: true, data, url, timestamp: new Date().toISOString() };
  } catch (error) {
    return { success: false, error: error.message, url, timestamp: new Date().toISOString() };
  }
}

// Add parsed blockId to vehicle entities
function addParsedBlockIdToVehicles(vehicleEntities) {
  if (!Array.isArray(vehicleEntities)) return vehicleEntities || [];
  return vehicleEntities.map(entity => {
    const processed = JSON.parse(JSON.stringify(entity));
    const tripId = processed.vehicle?.trip?.tripId;
    if (tripId) {
      const blockId = extractBlockIdFromTripId(tripId);
      if (blockId) {
        if (!processed.vehicle.trip) processed.vehicle.trip = {};
        processed.vehicle.trip.blockId = blockId;
      }
    }
    return processed;
  });
}

// Add parsed blockId to trip updates
function addParsedBlockIdToTripUpdates(tripUpdateEntities) {
  if (!Array.isArray(tripUpdateEntities)) return tripUpdateEntities || [];
  return tripUpdateEntities.map(entity => {
    const processed = JSON.parse(JSON.stringify(entity));
    const tripId = processed.tripUpdate?.trip?.tripId;
    if (tripId) {
      const blockId = extractBlockIdFromTripId(tripId);
      if (blockId) {
        if (!processed.tripUpdate.trip) processed.tripUpdate.trip = {};
        processed.tripUpdate.trip.blockId = blockId;
      }
    }
    return processed;
  });
}

// Ensure schedule loaded
async function ensureScheduleLoaded() {
  if (!scheduleLoader.scheduleData?.tripsMap || Object.keys(scheduleLoader.scheduleData.tripsMap).length === 0) {
    console.log('[ensureSchedule] Reloading...');
    await scheduleLoader.loadSchedules();
  }
}

// Main virtuals endpoint with 5-second throttling
app.get('/api/virtuals', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const allVirtuals = req.query.all_virtuals === 'true';
    const forceRefresh = req.query.force === 'true';
    const currentTimeSec = Math.floor(Date.now() / 1000);
    const start = Date.now();
    
    // Helper function to format seconds as HH:MM:SS
    const formatTime = (seconds) => {
      const hrs = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };
    
    // Check cache - throttle to 5 seconds, unless force refresh
    const cacheKey = `${operatorId}-${allVirtuals}`;
    const cached = virtualsCache.get(cacheKey);
    
    if (!forceRefresh && cached && (currentTimeSec - cached.timestamp < 5)) {
      console.log(`[VIRTUALS] Returning cached response (${currentTimeSec - cached.timestamp}s old)`);
      
      // Update the timestamp in the response to "freshen" it
      const response = JSON.parse(JSON.stringify(cached.data));
      response.header.timestamp = currentTimeSec;
      response.metadata.cached = true;
      response.metadata.cachedForSeconds = currentTimeSec - cached.timestamp;
      response.metadata.generatedAt = cached.timestamp;
      response.metadata.responseTimeMs = Date.now() - start;
      
      console.log(`[VIRTUALS] Done: ${response.entity.length} virtual buses from cache`);
      return res.json(response);
    }

    console.log(`[VIRTUALS] Called | op=${operatorId} | all=${allVirtuals} | force=${forceRefresh} | currentTime=${currentTimeSec} | scheduleTime=${getScheduleTimeInSeconds(operatorId)}s`);
    
    // Fetch BOTH vehicle positions AND trip updates
    const [vehicleResult, tripResult] = await Promise.all([
      fetchGTFSFeed('vehicleupdates.pb', operatorId),
      fetchGTFSFeed('tripupdates.pb', operatorId)
    ]);

    if (!tripResult.success) {
      return res.status(503).json({ error: 'Trip feed unavailable' });
    }

    await ensureScheduleLoaded();
    const schedule = scheduleLoader.scheduleData;

    if (!schedule?.tripsMap || !schedule?.shapes || !schedule?.stopTimesByTrip) {
      console.error('[VIRTUALS] Schedule incomplete:', {
        hasTripsMap: !!schedule?.tripsMap,
        hasShapes: !!schedule?.shapes,
        hasStopTimesByTrip: !!schedule?.stopTimesByTrip,
        stopTimesCount: schedule?.stopTimesByTrip ? Object.keys(schedule.stopTimesByTrip).length : 0
      });
      return res.status(500).json({ error: 'Schedule incomplete - missing stop times or shapes' });
    }

    console.log(`[VIRTUALS] Schedule loaded: ${Object.keys(schedule.tripsMap).length} trips, ${Object.keys(schedule.shapes).length} shapes, ${Object.keys(schedule.stopTimesByTrip).length} trips with stop times`);
    
    // Check if we have calendar dates loaded
    const hasCalendarDates = schedule.calendarDates && Object.keys(schedule.calendarDates).length > 0;
    console.log(`[VIRTUALS] Calendar dates loaded: ${hasCalendarDates ? 'YES' : 'NO'}`);
    if (hasCalendarDates) {
      console.log(`[VIRTUALS] Service IDs in calendar: ${Object.keys(schedule.calendarDates).length}`);
    }

    // Get real vehicle trips to check against
    const realVehicleTripIds = new Set();
    if (vehicleResult.success && vehicleResult.data?.entity) {
      vehicleResult.data.entity.forEach(entity => {
        const tripId = entity.vehicle?.trip?.tripId;
        if (tripId) {
          realVehicleTripIds.add(tripId);
        }
      });
    }
    console.log(`[VIRTUALS] Found ${realVehicleTripIds.size} real vehicles with positions`);

    const virtualEntities = [];
    const processedTrips = new Set();

    tripResult.data.entity?.forEach((entity, index) => {
      const tu = entity.tripUpdate;
      if (!tu?.trip?.tripId) {
        return;
      }

      const trip = tu.trip;
      const tripId = trip.tripId;
      
      // Avoid duplicate processing
      if (processedTrips.has(tripId)) {
        return;
      }
      processedTrips.add(tripId);

      // Get static schedule for this trip
      const staticStopTimes = getStaticScheduleForTrip(tripId, schedule);
      if (!staticStopTimes || staticStopTimes.length === 0) {
        console.log(`[VIRTUALS] No static schedule found for ${tripId}`);
        return; // Can't create virtual without schedule
      }

      // NEW: Check if trip is scheduled today (based on calendar_dates)
      if (!isTripScheduledToday(tripId, schedule)) {
        console.log(`[VIRTUALS] Skipping ${tripId} - not scheduled today`);
        return;
      }

      // Check if trip is active in static schedule (with midnight crossing support)
      const currentScheduleSec = getScheduleTimeInSeconds(operatorId);
      const isActiveInSchedule = isTripActiveInStaticSchedule(staticStopTimes, currentScheduleSec);
      if (!isActiveInSchedule) {
        console.log(`[VIRTUALS] Skipping ${tripId} - not active in static schedule`);
        return;
      }

      console.log(`[VIRTUALS] ${tripId} is active in static schedule (${staticStopTimes.length} stops)`);

      // In normal mode: skip if real vehicle exists for this trip
      // In all_virtuals mode: show even if real vehicle exists
      const hasRealVehicle = realVehicleTripIds.has(tripId);
      if (!allVirtuals && hasRealVehicle) {
        console.log(`[VIRTUALS] Skipping ${tripId} - real vehicle exists (normal mode)`);
        return;
      }

      // Calculate position using static schedule
      const scheduleTimeSec = getScheduleTimeFromUnix(currentTimeSec, operatorId);
      let position = calculateVirtualBusPosition(tripId, scheduleTimeSec, schedule, operatorId);      
      if (!position) {
        console.log(`[VIRTUALS] Could not calculate position for ${tripId}`);
        
        // For all_virtuals mode, show at first stop as fallback
        if (allVirtuals) {
          const firstStop = staticStopTimes[0];
          const firstStopCoords = schedule.stops[firstStop.stop_id];
          if (firstStopCoords) {
            console.log(`[VIRTUALS] Showing ${tripId} at first stop as fallback`);
            position = {
              latitude: firstStopCoords.lat,
              longitude: firstStopCoords.lon,
              bearing: null,
              speed: 0,
              progress: 0
            };
          }
        } else {
          return;
        }
      }

      // If we have a position, create the virtual entity
      if (position) {
        const blockId = extractBlockIdFromTripId(tripId) || 'UNKNOWN';
        const vehicleId = `VIRT-${blockId}-${tripId}`;
        
        // Determine status based on progress
        let currentStatus = 2; // IN_TRANSIT_TO (default)
        if (position.progress <= 0) currentStatus = 1; // STOPPED_AT
        if (position.progress >= 1) currentStatus = 0; // INCOMING_AT
        
        const virtualEntity = {
          id: vehicleId,
          vehicle: {
            trip: {
              tripId: tripId,
              startTime: trip.startTime,
              startDate: trip.startDate,
              routeId: trip.routeId,
              directionId: trip.directionId || 0,
              blockId: blockId
            },
            position: {
              latitude: position.latitude,
              longitude: position.longitude,
              bearing: position.bearing || null,
              speed: position.speed || 0
            },
            currentStopSequence: 1,
            currentStatus: currentStatus,
            timestamp: currentTimeSec,
            stopId: position.segment?.start || staticStopTimes[0]?.stop_id,
            vehicle: {
              id: vehicleId,
              label: `Ghost ${getRouteDisplayName(trip.routeId)}`,
              is_virtual: true
            },
            progress: position.progress?.toFixed(3) || '0.000',
            metadata: {
              source: position.segment ? 'static_schedule' : 'first_stop_fallback',
              all_virtuals_mode: allVirtuals,
              has_real_vehicle: hasRealVehicle,
              crossed_midnight: position.crossedMidnight || false
            }
          }
        };
        
        virtualEntities.push(virtualEntity);
        console.log(`[VIRTUALS] Added virtual bus for ${tripId} at ${position.latitude},${position.longitude} (real vehicle: ${hasRealVehicle})`);
      }
    });

    const took = Date.now() - start;
    
    const response = {
      header: {
        gtfs_realtime_version: "2.0",
        incrementality: "FULL_DATASET",
        timestamp: currentTimeSec
      },
      entity: virtualEntities,
      metadata: {
        operatorId,
        fetchedAt: new Date().toISOString(),
        responseTimeMs: took,
        mode: allVirtuals ? 'all_virtuals' : 'missing_only',
        generated: virtualEntities.length,
        totalTripsInFeed: tripResult.data.entity?.length || 0,
        processedTrips: processedTrips.size,
        realVehiclesCount: realVehicleTripIds.size,
        scheduleInfo: {
          tripsLoaded: Object.keys(schedule.tripsMap).length,
          shapesLoaded: Object.keys(schedule.shapes).length,
          tripsWithStopTimes: Object.keys(schedule.stopTimesByTrip).length,
          hasCalendarDates: hasCalendarDates,
          serviceIdsCount: hasCalendarDates ? Object.keys(schedule.calendarDates).length : 0
        },
        cacheInfo: {
          cached: false,
          generatedAt: currentTimeSec,
          forceRefresh: forceRefresh
        },
        debug: {
          currentTimeUnix: currentTimeSec,
          currentTimeISO: new Date(currentTimeSec * 1000).toISOString(),
          currentScheduleSec: getScheduleTimeInSeconds(operatorId),
          currentScheduleTime: formatTime(getScheduleTimeInSeconds(operatorId))
        }
      }
    };

    // Cache the response for 5 seconds
    virtualsCache.set(cacheKey, {
      data: response,
      timestamp: currentTimeSec
    });
    
    console.log(`[VIRTUALS] Done: ${virtualEntities.length} virtual buses in ${took}ms (mode: ${allVirtuals ? 'all' : 'missing-only'}) | Cached for 5s`);
    res.json(response);
    
  } catch (err) {
    console.error('[VIRTUALS] Error:', err);
    res.status(500).json({ 
      error: 'Failed to generate virtual buses',
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Keep /api/buses (real + virtual combined) — with caching
app.get('/api/buses', async (req, res) => {
  if (!root) return res.status(500).json({ error: 'Proto not loaded' });
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const noVirtuals = 'no_virtuals' in req.query;
    const allVirtuals = req.query.all_virtuals === 'true';
    const forceRefresh = req.query.force === 'true';
    const startTime = Date.now();
    const currentTimeSec = Math.floor(Date.now() / 1000);
    const currentScheduleSec = getScheduleTimeInSeconds(operatorId);

    console.log(`[${new Date().toISOString()}] /api/buses called | operator=${operatorId} | no_virtuals=${noVirtuals} | all_virtuals=${allVirtuals}`);

    // ALWAYS fetch fresh real vehicle positions (no cache)
    const [vehicleResult, tripResult, alertsResult] = await Promise.all([
      fetchGTFSFeed('vehicleupdates.pb', operatorId),
      fetchGTFSFeed('tripupdates.pb', operatorId),
      fetchGTFSFeed('alerts.pb', operatorId)
    ]);

    // Process vehicle positions (add blockId parsing) - ALWAYS FRESH
    let processedVehicles = [];
    if (vehicleResult.success && vehicleResult.data?.entity) {
      processedVehicles = addParsedBlockIdToVehicles(vehicleResult.data.entity);
    }

    // Process trip updates (add blockId parsing) - ALWAYS FRESH
    let processedTrips = tripResult.success ? addParsedBlockIdToTripUpdates(tripResult.data.entity || []) : [];

    // VIRTUAL BUSES: Check cache (5-second throttle)
    let virtualEntities = [];
    if (!noVirtuals) {
      const cacheKey = `buses-${operatorId}-${allVirtuals}`;
      const cached = virtualBusesCache.get(cacheKey);
      
      if (!forceRefresh && cached && (Date.now() - cached.timestamp < 5000)) {
        // Use cached virtual buses
        console.log(`[/api/buses] Using cached virtual buses (${Date.now() - cached.timestamp}ms old)`);
        virtualEntities = cached.virtualEntities;
      } else {
        // Generate fresh virtual buses - USE STATIC SCHEDULE LIKE /api/virtuals
        await ensureScheduleLoaded();
        const schedule = scheduleLoader.scheduleData;

        if (!schedule?.tripsMap || !schedule?.stopTimesByTrip) {
          console.log('[/api/buses] Schedule not loaded, skipping virtual buses');
        } else {
          // Check if we have calendar dates
          const hasCalendarDates = schedule.calendarDates && Object.keys(schedule.calendarDates).length > 0;
          console.log(`[/api/buses] Calendar dates loaded: ${hasCalendarDates ? 'YES' : 'NO'}`);

          // Get real vehicle trips to check against (for filtering in normal mode)
          const realVehicleTripIds = new Set();
          if (vehicleResult.success && vehicleResult.data?.entity) {
            vehicleResult.data.entity.forEach(entity => {
              const tripId = entity.vehicle?.trip?.tripId;
              if (tripId) {
                realVehicleTripIds.add(tripId);
              }
            });
          }
          console.log(`[/api/buses] Found ${realVehicleTripIds.size} real vehicles for filtering`);

          virtualEntities = [];
          const processedVirtualTrips = new Set();

          // Process ALL trips from the static schedule
          const allStaticTripIds = Object.keys(schedule.stopTimesByTrip || {});
          console.log(`[/api/buses] Checking ${allStaticTripIds.length} trips from static schedule`);

          allStaticTripIds.forEach(tripId => {
            // Avoid duplicate processing
            if (processedVirtualTrips.has(tripId)) return;
            processedVirtualTrips.add(tripId);

            // Get static schedule for this trip
            const staticStopTimes = getStaticScheduleForTrip(tripId, schedule);
            if (!staticStopTimes || staticStopTimes.length === 0) {
              return; // Can't create virtual without schedule
            }

            // NEW: Check if trip is scheduled today (based on calendar_dates)
            if (!isTripScheduledToday(tripId, schedule)) {
              console.log(`[/api/buses] Skipping ${tripId} - not scheduled today`);
              return;
            }

            // Check if trip is active in static schedule (with midnight crossing support)
            const isActiveInSchedule = isTripActiveInStaticSchedule(staticStopTimes, currentScheduleSec);
            if (!isActiveInSchedule) {
              console.log(`[/api/buses] Skipping ${tripId} - not active in static schedule`);
              return;
            }

            // In normal mode: skip if real vehicle exists for this trip
            // In all_virtuals mode: show even if real vehicle exists
            const hasRealVehicle = realVehicleTripIds.has(tripId);
            if (!allVirtuals && hasRealVehicle) {
              console.log(`[/api/buses] Skipping ${tripId} - real vehicle exists (normal mode)`);
              return;
            }

            // Calculate position using static schedule
            const scheduleTimeSec = getScheduleTimeFromUnix(currentTimeSec, operatorId);
            const position = calculateVirtualBusPosition(tripId, scheduleTimeSec, schedule, operatorId);            
            if (!position) {
              console.log(`[/api/buses] Could not calculate position for ${tripId}`);
              return;
            }

            const blockId = extractBlockIdFromTripId(tripId) || 'UNKNOWN';
            const vehicleId = `VIRT-${blockId}-${tripId}`;
            
            // Determine status based on progress
            let currentStatus = 2; // IN_TRANSIT_TO (default)
            if (position.progress <= 0) currentStatus = 1; // STOPPED_AT
            if (position.progress >= 1) currentStatus = 0; // INCOMING_AT
            
            // Try to get trip details from GTFS-RT if available, otherwise use static data
            let routeId = 'UNKNOWN';
            let startTime = '';
            let startDate = '';
            let directionId = 0;
            
            // Look for this trip in GTFS-RT feed
            const rtTrip = tripResult.data?.entity?.find(e => 
              e.tripUpdate?.trip?.tripId === tripId
            );
            
            if (rtTrip && rtTrip.tripUpdate?.trip) {
              routeId = rtTrip.tripUpdate.trip.routeId || 'UNKNOWN';
              startTime = rtTrip.tripUpdate.trip.startTime || '';
              startDate = rtTrip.tripUpdate.trip.startDate || '';
              directionId = rtTrip.tripUpdate.trip.directionId || 0;
            } else {
              // Try to get from static schedule
              const staticTrip = schedule.tripsMap?.[tripId];
              if (staticTrip) {
                routeId = staticTrip.route_id || 'UNKNOWN';
                startTime = staticTrip.start_time || '';
                startDate = staticTrip.start_date || '';
                directionId = staticTrip.direction_id || 0;
              }
            }

            virtualEntities.push({
              id: vehicleId,
              vehicle: {
                trip: {
                  tripId: tripId,
                  startTime: startTime,
                  startDate: startDate,
                  routeId: routeId,
                  directionId: directionId,
                  blockId: blockId
                },
                position: {
                  latitude: position.latitude,
                  longitude: position.longitude,
                  bearing: position.bearing || null,
                  speed: position.speed || 0
                },
                currentStopSequence: 1,
                currentStatus: currentStatus,
                timestamp: currentTimeSec,
                stopId: position.segment?.start || staticStopTimes[0]?.stop_id,
                vehicle: {
                  id: vehicleId,
                  label: `Ghost ${getRouteDisplayName(routeId)}`,
                  is_virtual: true
                },
                progress: position.progress?.toFixed(3) || '0.000',
                metadata: {
                  source: 'static_schedule',
                  all_virtuals_mode: allVirtuals,
                  has_real_vehicle: hasRealVehicle,
                  crossed_midnight: position.crossedMidnight || false
                }
              }
            });
            
            console.log(`[/api/buses] Added virtual bus for ${tripId} (${routeId}) at ${position.latitude},${position.longitude}`);
          });

          // Cache the virtual buses
          virtualBusesCache.set(cacheKey, {
            virtualEntities,
            timestamp: Date.now()
          });
          
          console.log(`[/api/buses] Generated ${virtualEntities.length} virtual buses from static schedule`);
        }
      }
    }

    // Combine real + (possibly cached) virtual vehicles
    const allVehicleEntities = [...processedVehicles, ...virtualEntities];

    // Build final response
    const responseTime = Date.now() - startTime;

    if (noVirtuals) {
      // Raw GTFS-RT format for compatibility (only real vehicles)
      res.json({
        header: vehicleResult.data?.header || { gtfsRealtimeVersion: "2.0", incrementality: "FULL_DATASET", timestamp: currentTimeSec },
        entity: processedVehicles
      });
    } else {
      // Full wrapped format with all feeds
      const response = {
        metadata: {
          operatorId,
          location: operatorId === '36' ? 'Revelstoke' :
                    operatorId === '47' ? 'Kelowna' :
                    operatorId === '48' ? 'Victoria' : `Operator ${operatorId}`,
          fetchedAt: new Date().toISOString(),
          responseTimeMs: responseTime,
          no_virtuals: noVirtuals,
          all_virtuals_mode: allVirtuals,
          cacheInfo: {
            virtualBusesCached: virtualEntities.length > 0 && virtualBusesCache.has(`buses-${operatorId}-${allVirtuals}`) && 
                              (Date.now() - virtualBusesCache.get(`buses-${operatorId}-${allVirtuals}`).timestamp < 5000),
            realBusesFresh: true
          },
          feeds: {
            vehicle_positions: {
              success: vehicleResult.success,
              entities: allVehicleEntities.length,
              virtual_vehicles: virtualEntities.length,
              real_vehicles: processedVehicles.length,
              url: vehicleResult.url
            },
            trip_updates: {
              success: tripResult.success,
              entities: processedTrips.length,
              url: tripResult.url
            },
            service_alerts: {
              success: alertsResult.success,
              entities: alertsResult.data?.entity?.length || 0,
              url: alertsResult.url
            }
          },
          block_id: {
            enabled: true,
            source: "parsed_from_trip_id",
            vehicles_with_blockId: allVehicleEntities.filter(e => !!e.vehicle?.trip?.blockId).length,
            trip_updates_with_blockId: processedTrips.filter(e => !!e.tripUpdate?.trip?.blockId).length
          }
        },
        data: {
          vehicle_positions: {
            header: vehicleResult.data?.header || { gtfsRealtimeVersion: "2.0", incrementality: "FULL_DATASET", timestamp: currentTimeSec },
            entity: allVehicleEntities
          },
          trip_updates: tripResult.success ? {
            header: tripResult.data.header,
            entity: processedTrips
          } : null,
          service_alerts: alertsResult.success ? alertsResult.data : null
        }
      };

      const errors = [];
      if (!vehicleResult.success) errors.push(`Vehicle positions: ${vehicleResult.error}`);
      if (!tripResult.success) errors.push(`Trip updates: ${tripResult.error}`);
      if (!alertsResult.success) errors.push(`Service alerts: ${alertsResult.error}`);
      if (errors.length > 0) response.metadata.errors = errors;

      console.log(`[${new Date().toISOString()}] /api/buses completed in ${responseTime}ms | Vehicles: ${allVehicleEntities.length} (real: ${processedVehicles.length}, virtual: ${virtualEntities.length})`);
      res.json(response);
    }
  } catch (error) {
    console.error('Error in /api/buses:', error);
    res.status(500).json({
      error: 'Failed to fetch combined feeds',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Debug endpoint to see trip matching
app.get('/api/debug/trip-matching', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    
    // Fetch real vehicle positions
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    await ensureScheduleLoaded();
    const schedule = scheduleLoader.scheduleData;
    
    // Get real vehicle trip IDs
    const realVehicleTripIds = new Set();
    const realVehicles = [];
    
    if (vehicleResult.success && vehicleResult.data?.entity) {
      vehicleResult.data.entity.forEach(entity => {
        const tripId = entity.vehicle?.trip?.tripId;
        if (tripId) {
          realVehicleTripIds.add(tripId);
          realVehicles.push({
            tripId: tripId,
            routeId: entity.vehicle?.trip?.routeId,
            blockId: entity.vehicle?.trip?.blockId || extractBlockIdFromTripId(tripId),
            position: entity.vehicle?.position
          });
        }
      });
    }
    
    // Get all static trip IDs
    const staticTripIds = Object.keys(schedule.stopTimesByTrip || {});
    
    // Check which static trips match real vehicles
    const matchingAnalysis = staticTripIds.map(tripId => {
      const hasRealVehicle = realVehicleTripIds.has(tripId);
      const staticTrip = schedule.tripsMap?.[tripId];
      
      return {
        tripId,
        routeId: staticTrip?.route_id || 'unknown',
        blockId: staticTrip?.block_id || extractBlockIdFromTripId(tripId),
        serviceId: staticTrip?.service_id || 'unknown',
        hasRealVehicle,
        hasStaticSchedule: !!schedule.stopTimesByTrip?.[tripId],
        isActiveNow: isTripActiveInStaticSchedule(
          getStaticScheduleForTrip(tripId, schedule), 
          getScheduleTimeInSeconds(operatorId)
        ),
        isScheduledToday: isTripScheduledToday(tripId, schedule),
        calendarDatesCount: schedule.calendarDates?.[staticTrip?.service_id]?.size || 0
      };
    });
    
    res.json({
      realVehicles,
      realVehicleCount: realVehicleTripIds.size,
      staticTripCount: staticTripIds.length,
      matchingAnalysis,
      currentTime: {
        unix: Math.floor(Date.now() / 1000),
        schedule: getScheduleTimeInSeconds(operatorId),
        formatted: formatTime(getScheduleTimeInSeconds(operatorId))
      },
      calendarInfo: {
        loaded: !!schedule.calendarDates,
        serviceCount: schedule.calendarDates ? Object.keys(schedule.calendarDates).length : 0,
        today: new Date().toISOString().split('T')[0].replace(/-/g, '')
      }
    });
    
  } catch (error) {
    console.error('[DEBUG] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to inspect virtual position calculation
app.get('/api/debug/virtuals-detail', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || '36';
    const allVirtuals = req.query.all_virtuals === 'true';
    const currentTimeSec = Math.floor(Date.now() / 1000);
    const start = Date.now();

    console.log(`[DEBUG-VIRTUALS] Called | operator=${operatorId} | all=${allVirtuals} | time=${currentTimeSec}`);

    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);
    if (!tripResult.success) return res.status(503).json({ error: 'Trip feed unavailable' });

    await ensureScheduleLoaded();
    const schedule = scheduleLoader.scheduleData;
    if (!schedule?.tripsMap || !schedule?.shapes || !schedule?.stops) {
      return res.status(500).json({ error: 'Schedule incomplete' });
    }

    const debugInfo = {
      currentTime: {
        unix: currentTimeSec,
        iso: new Date(currentTimeSec * 1000).toISOString()
      },
      scheduleStats: {
        tripsCount: Object.keys(schedule.tripsMap).length,
        shapesCount: Object.keys(schedule.shapes).length,
        stopsCount: Object.keys(schedule.stops).length,
        sampleTripKeys: Object.keys(schedule.tripsMap).slice(0, 3),  // Shows how trips are keyed
        sampleShapeKeys: Object.keys(schedule.shapes).slice(0, 3)   // Shows shape IDs
      },
      rtTrips: tripResult.data.entity.map(e => e.tripUpdate?.trip?.tripId).filter(Boolean),
      virtualsDebug: []
    };

    tripResult.data.entity?.forEach(entity => {
      const tu = entity.tripUpdate;
      if (!tu?.trip?.tripId || !tu.stopTimeUpdate?.length) return;

      const trip = tu.trip;
      const stopTimes = tu.stopTimeUpdate;
      const blockId = extractBlockIdFromTripId(trip.tripId);

      const active = isTripCurrentlyActive(stopTimes, currentTimeSec);
      if (!active && !allVirtuals) return;  // Skip inactive unless all

      const info = findCurrentSegmentAndProgress(stopTimes, currentTimeSec);

      const shapeId = getShapeIdFromTrip(trip.tripId, schedule);

      let position = null;
      let shapeUsed = false;
      let fallbackReason = null;

      if (info) {
        const { currentStop, nextStop, progress } = info;
        position = calculateVirtualBusPosition(trip.tripId, currentTimeSec, schedule);
        shapeUsed = true;  // Assume shape success if position calculated — adjust based on logs
      } else {
        fallbackReason = 'No stop info';
      }

      debugInfo.virtualsDebug.push({
        rtTripId: trip.tripId,
        blockId,
        routeId: trip.routeId,
        directionId: trip.directionId,
        startTime: trip.startTime,
        isActive: active,
        progress: info?.progress.toFixed(4) || 0,
        currentStop: info?.currentStop.stopId || 'none',
        nextStop: info?.nextStop?.stopId || 'none',
        shapeId,
        shapeUsed,
        fallbackReason,
        position
      });
    });

    const tookMs = Date.now() - start;

    res.json(debugInfo);
  } catch (err) {
    console.error('[DEBUG-VIRTUALS] Error:', err);
    res.status(500).json({ error: 'Debug failed', details: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    proto: !!root,
    schedule: !!scheduleLoader.scheduleData?.tripsMap,
    trips: scheduleLoader.scheduleData?.tripsMap ? Object.keys(scheduleLoader.scheduleData.tripsMap).length : 0,
    calendarDates: scheduleLoader.scheduleData?.calendarDates ? Object.keys(scheduleLoader.scheduleData.calendarDates).length : 0
  });
});

// Root page
app.get('/', (req, res) => {
  res.send('BC Transit GTFS-RT Proxy - Use /api/virtuals or /api/buses');
});

await loadProto();

export default app;
