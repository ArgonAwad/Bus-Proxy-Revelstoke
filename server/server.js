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
    console.log(`[${new Date().toISOString()}] /api/buses called for operator ${operatorId} | no_virtuals=${noVirtuals} | all_virtuals=${allVirtuals}`);

    const [vehicleResult, tripResult, alertsResult] = await Promise.all([
      fetchGTFSFeed('vehicleupdates.pb', operatorId),
      fetchGTFSFeed('tripupdates.pb', operatorId),
      fetchGTFSFeed('alerts.pb', operatorId)
    ]);

    const enhancedVehicleResult = await getEnhancedVehiclePositions(
      operatorId,
      !noVirtuals,
      'subs',
      allVirtuals
    );

    let enhancedTripResult = tripResult;
    if (tripResult.success && tripResult.data?.entity) {
      const processedTripUpdates = addParsedBlockIdToTripUpdates(tripResult.data.entity);
      enhancedTripResult = {
        ...tripResult,
        data: {
          ...tripResult.data,
          entity: processedTripUpdates
        }
      };
    }

    const responseTime = Date.now() - startTime;

    if (noVirtuals) {
      // Return RAW GTFS format for compatibility with Railway/frontend
      res.json(enhancedVehicleResult.data);  // Just header + entity array
    } else {
      // Return wrapped version
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
              success: enhancedVehicleResult.success,
              entities: enhancedVehicleResult.success ? enhancedVehicleResult.data.entity?.length || 0 : 0,
              virtual_vehicles: noVirtuals ? 0 : (enhancedVehicleResult.data?.metadata?.virtual_vehicles || 0),
              real_vehicles: enhancedVehicleResult.data?.metadata?.real_vehicles || 0,
              url: enhancedVehicleResult.url
            },
            trip_updates: {
              success: tripResult.success,
              entities: tripResult.success ? enhancedTripResult.data.entity?.length || 0 : 0,
              url: tripResult.url
            },
            service_alerts: {
              success: alertsResult.success,
              entities: alertsResult.success ? alertsResult.data.entity?.length || 0 : 0,
              url: alertsResult.url
            }
          },
          block_id: {
            enabled: true,
            source: "parsed_from_trip_id",
            method: "last_numeric_part_after_colon",
            vehicles_with_blockId: enhancedVehicleResult.data?.entity?.filter(e => !!e.vehicle?.trip?.blockId)?.length || 0,
            trip_updates_with_blockId: enhancedTripResult.data?.entity?.filter(e => !!e.tripUpdate?.trip?.blockId)?.length || 0
          }
        },
        data: {
          vehicle_positions: enhancedVehicleResult.success ? enhancedVehicleResult.data : null,
          trip_updates: enhancedTripResult.success ? enhancedTripResult.data : null,
          service_alerts: alertsResult.success ? alertsResult.data : null
        }
      };
      const errors = [];
      if (!enhancedVehicleResult.success) errors.push(`Vehicle positions: ${enhancedVehicleResult.error}`);
      if (!tripResult.success) errors.push(`Trip updates: ${tripResult.error}`);
      if (!alertsResult.success) errors.push(`Service alerts: ${alertsResult.error}`);
      if (errors.length > 0) response.metadata.errors = errors;
      console.log(`[${new Date().toISOString()}] /api/buses completed in ${responseTime}ms`);
      console.log(` Vehicles: ${enhancedVehicleResult.data?.entity?.length || 0}, Virtuals: ${noVirtuals ? 0 : (enhancedVehicleResult.data?.metadata?.virtual_vehicles || 0)}`);
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
