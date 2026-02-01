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
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    await ensureScheduleLoaded();
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);
    const alertsResult = await fetchGTFSFeed('alerts.pb', operatorId);

    res.json({
      metadata: {
        operatorId,
        fetchedAt: new Date().toISOString(),
        feeds: {
          vehicle_positions: vehicleResult,
          trip_updates: tripResult,
          alerts: alertsResult
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed', details: err.message });
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
