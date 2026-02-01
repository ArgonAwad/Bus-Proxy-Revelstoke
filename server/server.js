import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import protobuf from 'protobufjs';
import ScheduleLoader from './schedule-loader.js';

// Import ONLY the helpers we actually need
import {
  extractBlockIdFromTripId,
  getShapeIdFromTrip,
  isTripCurrentlyActive,
  findCurrentStopAndProgress,
  calculateCurrentPosition,
  calculateBearing,
  getRouteDisplayName
} from './virtual-vehicles.js';

const scheduleLoader = new ScheduleLoader();
const app = express();
app.use(cors());

// Constants
const GTFS_PROTO_URL = 'https://raw.githubusercontent.com/google/transit/master/gtfs-realtime/proto/gtfs-realtime.proto';
const BASE_URL = 'https://bct.tmix.se/gtfs-realtime';
const DEFAULT_OPERATOR_ID = '36';
let root = null;

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

// Main virtuals endpoint (minimal, on-demand)
app.get('/api/virtuals', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const allVirtuals = req.query.all_virtuals === 'true';
    const currentTimeSec = Math.floor(Date.now() / 1000);
    const start = Date.now();

    console.log(`[VIRTUALS] Called | op=${operatorId} | all=${allVirtuals} | t=${currentTimeSec}`);

    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);
    if (!tripResult.success) return res.status(503).json({ error: 'Trip feed unavailable' });

    await ensureScheduleLoaded();
    const schedule = scheduleLoader.scheduleData;
    if (!schedule?.tripsMap || !schedule?.shapes || !schedule?.stops) {
      return res.status(500).json({ error: 'Schedule incomplete' });
    }

    const virtualEntities = [];

    tripResult.data.entity?.forEach(entity => {
      const tu = entity.tripUpdate;
      if (!tu?.trip?.tripId || !tu.stopTimeUpdate?.length) return;

      const trip = tu.trip;
      const stopTimes = tu.stopTimeUpdate;
      const blockId = extractBlockIdFromTripId(trip.tripId);
      if (!blockId) return;

      // Only active trips
      if (!isTripCurrentlyActive(stopTimes, currentTimeSec)) return;

      const info = findCurrentStopAndProgress(stopTimes, currentTimeSec);
      if (!info) return;

      const { currentStop, nextStop, progress } = info;

      const position = calculateCurrentPosition(
        currentStop,
        nextStop,
        progress,
        schedule,
        trip.tripId
      );

      const vehicleId = `VIRT-${blockId}`;

      virtualEntities.push({
        id: vehicleId,
        vehicle: {
          trip: {
            tripId: trip.tripId,
            startTime: trip.startTime,
            startDate: trip.startDate,
            routeId: trip.routeId,
            directionId: trip.directionId || 0,
            blockId
          },
          position: {
            latitude: position.latitude,
            longitude: position.longitude,
            bearing: position.bearing || null,
            speed: position.speed || 0
          },
          currentStopSequence: currentStop.stopSequence || 1,
          currentStatus: progress === 0 ? 1 : 2,
          timestamp: currentTimeSec,
          stopId: currentStop.stopId,
          vehicle: {
            id: vehicleId,
            label: `Ghost ${getRouteDisplayName(trip.routeId)}`,
            is_virtual: true
          },
          progress: progress.toFixed(3)
        }
      });
    });

    const took = Date.now() - start;

    res.json({
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
        mode: allVirtuals ? 'all' : 'missing_only',
        generated: virtualEntities.length
      }
    });

    console.log(`[VIRTUALS] Done: ${virtualEntities.length} buses in ${took}ms`);
  } catch (err) {
    console.error('[VIRTUALS] Error:', err);
    res.status(500).json({ error: 'Failed', details: err.message });
  }
});

// Keep /api/buses (real + virtual combined) — simplified
app.get('/api/buses', async (req, res) => {
  if (!root) return res.status(500).json({ error: 'Proto not loaded' });
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const noVirtuals = 'no_virtuals' in req.query;
    const allVirtuals = req.query.all_virtuals === 'true';
    const startTime = Date.now();

    console.log(`[${new Date().toISOString()}] /api/buses called | operator=${operatorId} | no_virtuals=${noVirtuals} | all_virtuals=${allVirtuals}`);

    // Fetch all three feeds in parallel
    const [vehicleResult, tripResult, alertsResult] = await Promise.all([
      fetchGTFSFeed('vehicleupdates.pb', operatorId),
      fetchGTFSFeed('tripupdates.pb', operatorId),
      fetchGTFSFeed('alerts.pb', operatorId)
    ]);

    // Process vehicle positions (add blockId parsing)
    let processedVehicles = [];
    if (vehicleResult.success && vehicleResult.data?.entity) {
      processedVehicles = addParsedBlockIdToVehicles(vehicleResult.data.entity);
    }

    // Process trip updates (add blockId parsing)
    let processedTrips = tripResult.success ? addParsedBlockIdToTripUpdates(tripResult.data.entity || []) : [];

    // If we want virtuals, generate them on-the-fly
    let virtualEntities = [];
    if (!noVirtuals && tripResult.success) {
      await ensureScheduleLoaded();
      const schedule = scheduleLoader.scheduleData;

      processedTrips.forEach(entity => {
        const tu = entity.tripUpdate;
        if (!tu?.trip?.tripId || !tu.stopTimeUpdate?.length) return;

        const trip = tu.trip;
        const stopTimes = tu.stopTimeUpdate;
        const blockId = extractBlockIdFromTripId(trip.tripId);
        if (!blockId) return;

        // Skip if not in all-virtual mode and block is real/active
        // (you can add real block check here later if needed)
        // if (!allVirtuals && activeRealBlocks.has(blockId)) return;

        if (!isTripCurrentlyActive(stopTimes, Math.floor(Date.now() / 1000))) return;

        const info = findCurrentStopAndProgress(stopTimes, Math.floor(Date.now() / 1000));
        if (!info) return;

        const { currentStop, nextStop, progress } = info;

        const position = calculateCurrentPosition(
          currentStop,
          nextStop,
          progress,
          schedule,
          trip.tripId
        );

        const vehicleId = `VIRT-${blockId}`;

        virtualEntities.push({
          id: vehicleId,
          vehicle: {
            trip: {
              tripId: trip.tripId,
              startTime: trip.startTime,
              startDate: trip.startDate,
              routeId: trip.routeId,
              directionId: trip.directionId || 0,
              blockId
            },
            position: {
              latitude: position.latitude,
              longitude: position.longitude,
              bearing: position.bearing || null,
              speed: position.speed || 0
            },
            currentStopSequence: currentStop.stopSequence || 1,
            currentStatus: progress === 0 ? 1 : 2,
            timestamp: Math.floor(Date.now() / 1000),
            stopId: currentStop.stopId,
            vehicle: {
              id: vehicleId,
              label: `Ghost ${getRouteDisplayName(trip.routeId)}`,
              is_virtual: true
            },
            progress: progress.toFixed(3)
          }
        });
      });
    }

    // Combine real + virtual vehicles
    const allVehicleEntities = [...processedVehicles, ...virtualEntities];

    // Build final response
    const responseTime = Date.now() - startTime;

    if (noVirtuals) {
      // Raw GTFS-RT format for compatibility (only real vehicles)
      res.json({
        header: vehicleResult.data?.header || { gtfsRealtimeVersion: "2.0", incrementality: "FULL_DATASET", timestamp: Math.floor(Date.now() / 1000) },
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
            header: vehicleResult.data?.header || { gtfsRealtimeVersion: "2.0", incrementality: "FULL_DATASET", timestamp: Math.floor(Date.now() / 1000) },
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

// Debug endpoint to see exactly what is happening with virtual position calculation
app.get('/api/debug/virtuals-detail', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || '36';
    const currentTimeSec = Math.floor(Date.now() / 1000);

    console.log(`[DEBUG-VIRTUALS] Called | time=${currentTimeSec}`);

    // Fetch trip updates
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);
    if (!tripResult.success) {
      return res.status(503).json({ error: 'Trip feed unavailable' });
    }

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
        stopsCount: Object.keys(schedule.stops).length
      },
      activeVirtuals: []
    };

    tripResult.data.entity?.forEach(entity => {
      const tu = entity.tripUpdate;
      if (!tu?.trip?.tripId || !tu.stopTimeUpdate?.length) return;

      const trip = tu.trip;
      const stopTimes = tu.stopTimeUpdate;
      const blockId = extractBlockIdFromTripId(trip.tripId);
      if (!blockId) return;

      const isActive = isTripCurrentlyActive(stopTimes, currentTimeSec);
      if (!isActive) return;  // only include active ones

      const info = findCurrentStopAndProgress(stopTimes, currentTimeSec);
      if (!info) return;

      const { currentStop, nextStop, progress } = info;

      const shapeId = getShapeIdFromTrip(trip.tripId, schedule);

      let positionResult = null;
      let shapeUsed = false;
      let fallbackReason = null;

      if (trip.tripId && progress > 0) {
        positionResult = calculatePositionAlongShape(trip.tripId, progress, schedule);
        if (positionResult) {
          shapeUsed = true;
        } else {
          fallbackReason = 'No valid shape points or shape_id';
        }
      }

      if (!positionResult && nextStop) {
        const nextId = String(nextStop.stopId).trim();
        const currentId = String(currentStop.stopId).trim();
        const cCoords = schedule.stops[currentId];
        const nCoords = schedule.stops[nextId];
        if (cCoords && nCoords) {
          const lat = cCoords.lat + (nCoords.lat - cCoords.lat) * progress;
          const lon = cCoords.lon + (nCoords.lon - cCoords.lon) * progress;
          const bearing = calculateBearing(cCoords.lat, cCoords.lon, nCoords.lat, nCoords.lon);
          positionResult = { latitude: lat, longitude: lon, bearing, speed: 25 };
          fallbackReason = 'Linear between stops (shape failed)';
        } else {
          fallbackReason = 'No stop coordinates';
        }
      }

      if (!positionResult) {
        const coords = schedule.stops[String(currentStop.stopId).trim()];
        positionResult = coords
          ? { latitude: coords.lat, longitude: coords.lon, bearing: null, speed: 0 }
          : { latitude: 50.9981, longitude: -118.1957, bearing: null, speed: 0 };
        fallbackReason = fallbackReason || 'Ultimate fallback (no data)';
      }

      debugInfo.activeVirtuals.push({
        blockId,
        tripId: trip.tripId,
        routeId: trip.routeId,
        directionId: trip.directionId,
        startTime: trip.startTime,
        isActive: isActive,
        progress: progress.toFixed(4),
        currentStop: currentStop.stopId,
        nextStop: nextStop?.stopId || null,
        shapeId,
        shapeUsed,
        fallbackReason,
        position: positionResult
      });
    });

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
    trips: scheduleLoader.scheduleData?.tripsMap ? Object.keys(scheduleLoader.scheduleData.tripsMap).length : 0
  });
});

// Root page
app.get('/', (req, res) => {
  res.send('BC Transit GTFS-RT Proxy - Use /api/virtuals or /api/buses');
});

await loadProto();

export default app;
