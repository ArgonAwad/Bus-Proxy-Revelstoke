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

      const info = findCurrentStopAndProgress(stopTimes, currentTimeSec);

      const shapeId = getShapeIdFromTrip(trip.tripId, schedule);

      let position = null;
      let shapeUsed = false;
      let fallbackReason = null;

      if (info) {
        const { currentStop, nextStop, progress } = info;
        position = calculateCurrentPosition(currentStop, nextStop, progress, schedule, trip.tripId);
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

// Add this endpoint to your server.js file

// Time verification endpoint
app.get('/api/debug/time-verification', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    
    // Get times from different sources
    const now = new Date();
    const serverTimeISO = now.toISOString();
    const serverTimeLocal = now.toString();
    const serverTimeUTC = now.toUTCString();
    const serverTimeMs = Date.now();
    const serverTimeSec = Math.floor(serverTimeMs / 1000);
    
    // Fetch trip updates to see what timestamps they contain
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);
    
    // Get header timestamp from GTFS feed if available
    let feedTimestampSec = null;
    let feedTimestampISO = null;
    let feedHeader = null;
    
    if (tripResult.success && tripResult.data?.header) {
      feedHeader = tripResult.data.header;
      feedTimestampSec = feedHeader.timestamp;
      if (feedTimestampSec) {
        feedTimestampISO = new Date(feedTimestampSec * 1000).toISOString();
      }
    }
    
    // Find a sample trip to analyze its timing
    let sampleTrip = null;
    let sampleStopTimes = null;
    
    if (tripResult.success && tripResult.data?.entity) {
      // Find first trip update with stop times
      const tripUpdate = tripResult.data.entity.find(e => 
        e.tripUpdate?.stopTimeUpdate?.length > 0
      );
      
      if (tripUpdate) {
        sampleTrip = tripUpdate.tripUpdate.trip;
        sampleStopTimes = tripUpdate.tripUpdate.stopTimeUpdate.map(st => ({
          stopId: st.stopId,
          arrivalTime: st.arrival?.time,
          arrivalTimeISO: st.arrival?.time ? new Date(st.arrival.time * 1000).toISOString() : null,
          departureTime: st.departure?.time,
          departureTimeISO: st.departure?.time ? new Date(st.departure.time * 1000).toISOString() : null,
          stopSequence: st.stopSequence
        }));
      }
    }
    
    // Calculate time differences
    const timeDifferences = {
      serverVsFeed: feedTimestampSec ? serverTimeSec - feedTimestampSec : null,
      serverVsNow: 0, // Should be 0
      clientRequestTime: req.headers['x-request-time'] || 'Not provided'
    };
    
    // Test trip activity check with current time
    let activityCheckResult = null;
    if (sampleStopTimes) {
      const stopTimes = tripResult.data.entity[0]?.tripUpdate?.stopTimeUpdate || [];
      const isActive = isTripCurrentlyActive(stopTimes, serverTimeSec);
      
      // Also check with ±30 seconds to see sensitivity
      const isActivePlus30 = isTripCurrentlyActive(stopTimes, serverTimeSec + 30);
      const isActiveMinus30 = isTripCurrentlyActive(stopTimes, serverTimeSec - 30);
      
      activityCheckResult = {
        currentTimeCheck: isActive,
        plus30Seconds: isActivePlus30,
        minus30Seconds: isActiveMinus30,
        sensitivity: isActivePlus30 !== isActive || isActiveMinus30 !== isActive ? 
          "SENSITIVE (±30s changes result)" : "STABLE (±30s same result)",
        currentStopInfo: findCurrentStopAndProgress(stopTimes, serverTimeSec)
      };
    }
    
    const response = {
      metadata: {
        operatorId,
        requestedAt: new Date().toISOString(),
        endpoint: '/api/debug/time-verification',
        purpose: "Verify time consistency for virtual bus calculations"
      },
      
      // TIME VARIABLES USED IN CALCULATIONS
      timeVariables: {
        // This is what your code uses for calculations:
        currentTimeSec: serverTimeSec,
        
        // Derived formats for verification:
        currentTimeISO: new Date(serverTimeSec * 1000).toISOString(),
        currentTimeReadable: new Date(serverTimeSec * 1000).toString(),
        currentTimeUTC: new Date(serverTimeSec * 1000).toUTCString(),
        
        // Your device/system time at moment of request:
        systemTime: {
          milliseconds: serverTimeMs,
          iso: serverTimeISO,
          local: serverTimeLocal,
          utc: serverTimeUTC
        },
        
        // Time from GTFS feed header:
        feedTime: {
          seconds: feedTimestampSec,
          iso: feedTimestampISO,
          source: feedHeader ? 'GTFS-RT feed header' : 'No feed available'
        }
      },
      
      // TIME DIFFERENCES AND CONSISTENCY
      consistencyCheck: {
        differences: {
          serverVsFeedSeconds: timeDifferences.serverVsFeed,
          serverVsFeedReadable: timeDifferences.serverVsFeed ? 
            `${Math.abs(timeDifferences.serverVsFeed)} seconds ${timeDifferences.serverVsFeed > 0 ? 'ahead of' : 'behind'} feed` : 'N/A',
          within30Seconds: timeDifferences.serverVsFeed ? 
            Math.abs(timeDifferences.serverVsFeed) <= 30 : null
        },
        assessment: timeDifferences.serverVsFeed ? 
          (Math.abs(timeDifferences.serverVsFeed) <= 30 ? 
            "✅ TIMES ARE CONSISTENT (within 30 seconds)" :
            `⚠️ TIMES DIFFER BY ${Math.abs(timeDifferences.serverVsFeed)} SECONDS`) :
          "⚠️ CANNOT VERIFY (no feed timestamp)"
      },
      
      // SAMPLE TRIP ANALYSIS
      sampleAnalysis: sampleTrip ? {
        tripId: sampleTrip.tripId,
        routeId: sampleTrip.routeId,
        startTime: sampleTrip.startTime,
        startDate: sampleTrip.startDate,
        blockId: extractBlockIdFromTripId(sampleTrip.tripId),
        
        // First and last stop times
        firstStop: sampleStopTimes[0] ? {
          stopId: sampleStopTimes[0].stopId,
          departureTime: sampleStopTimes[0].departureTime,
          departureISO: sampleStopTimes[0].departureTimeISO,
          relativeToNow: sampleStopTimes[0].departureTime ? 
            `${serverTimeSec - sampleStopTimes[0].departureTime} seconds ${serverTimeSec > sampleStopTimes[0].departureTime ? 'after' : 'before'} departure` : 'N/A'
        } : null,
        
        lastStop: sampleStopTimes[sampleStopTimes.length - 1] ? {
          stopId: sampleStopTimes[sampleStopTimes.length - 1].stopId,
          arrivalTime: sampleStopTimes[sampleStopTimes.length - 1].arrivalTime,
          arrivalISO: sampleStopTimes[sampleStopTimes.length - 1].arrivalTimeISO,
          relativeToNow: sampleStopTimes[sampleStopTimes.length - 1].arrivalTime ? 
            `${serverTimeSec - sampleStopTimes[sampleStopTimes.length - 1].arrivalTime} seconds ${serverTimeSec > sampleStopTimes[sampleStopTimes.length - 1].arrivalTime ? 'after' : 'before'} arrival` : 'N/A'
        } : null,
        
        // Activity check results
        activityCheck: activityCheckResult
      } : null,
      
      // RECOMMENDATIONS
      recommendations: (() => {
        const recs = [];
        
        if (timeDifferences.serverVsFeed && Math.abs(timeDifferences.serverVsFeed) > 30) {
          recs.push("Server time differs significantly from feed time. Consider using feed timestamp as reference.");
        }
        
        if (!feedTimestampSec) {
          recs.push("Feed doesn't provide timestamp. Using server time may cause inconsistencies.");
        }
        
        if (activityCheckResult?.sensitivity === "SENSITIVE (±30s changes result)") {
          recs.push("Trip activity is time-sensitive. Small time differences will affect virtual bus generation.");
        }
        
        if (recs.length === 0) {
          recs.push("Time consistency looks good. Check shape interpolation if buses still fluctuate.");
        }
        
        return recs;
      })()
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('[TIME-VERIFICATION] Error:', error);
    res.status(500).json({
      error: 'Failed to verify time consistency',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test specific trip with time analysis
app.get('/api/debug/test-trip-activity', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const tripId = req.query.tripId;
    
    if (!tripId) {
      return res.status(400).json({ error: 'tripId parameter required' });
    }
    
    const currentTimeSec = Math.floor(Date.now() / 1000);
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);
    
    if (!tripResult.success) {
      return res.status(503).json({ error: 'Trip feed unavailable' });
    }
    
    // Find the specific trip
    const tripEntity = tripResult.data.entity?.find(e => 
      e.tripUpdate?.trip?.tripId === tripId
    );
    
    if (!tripEntity) {
      return res.status(404).json({ error: `Trip ${tripId} not found in feed` });
    }
    
    const stopTimes = tripEntity.tripUpdate.stopTimeUpdate;
    const trip = tripEntity.tripUpdate.trip;
    
    // Test with multiple time points
    const testTimes = [
      { label: 'Current', offset: 0 },
      { label: '-60 seconds', offset: -60 },
      { label: '-30 seconds', offset: -30 },
      { label: '+30 seconds', offset: 30 },
      { label: '+60 seconds', offset: 60 },
      { label: '+5 minutes', offset: 300 },
      { label: '-5 minutes', offset: -300 }
    ];
    
    const testResults = testTimes.map(test => {
      const testTimeSec = currentTimeSec + test.offset;
      const isActive = isTripCurrentlyActive(stopTimes, testTimeSec);
      const stopInfo = findCurrentStopAndProgress(stopTimes, testTimeSec);
      
      return {
        testTimeLabel: test.label,
        testTimeSec,
        testTimeISO: new Date(testTimeSec * 1000).toISOString(),
        isActive,
        currentStop: stopInfo?.currentStop?.stopId,
        nextStop: stopInfo?.nextStop?.stopId,
        progress: stopInfo?.progress?.toFixed(4),
        relativeToNow: `${test.offset > 0 ? '+' : ''}${test.offset} seconds`
      };
    });
    
    // Get stop time details
    const stopDetails = stopTimes.map(st => ({
      stopId: st.stopId,
      arrivalTime: st.arrival?.time,
      arrivalISO: st.arrival?.time ? new Date(st.arrival.time * 1000).toISOString() : null,
      departureTime: st.departure?.time,
      departureISO: st.departure?.time ? new Date(st.departure.time * 1000).toISOString() : null,
      stopSequence: st.stopSequence
    }));
    
    res.json({
      tripId,
      routeId: trip.routeId,
      blockId: extractBlockIdFromTripId(tripId),
      currentTime: {
        seconds: currentTimeSec,
        iso: new Date(currentTimeSec * 1000).toISOString(),
        readable: new Date(currentTimeSec * 1000).toString()
      },
      stopCount: stopTimes.length,
      stopDetails,
      timeSensitivityTest: testResults,
      analysis: {
        firstStopTime: stopDetails[0]?.departureTime || stopDetails[0]?.arrivalTime,
        lastStopTime: stopDetails[stopDetails.length - 1]?.arrivalTime || stopDetails[stopDetails.length - 1]?.departureTime,
        tripDurationSeconds: (stopDetails[stopDetails.length - 1]?.arrivalTime || stopDetails[stopDetails.length - 1]?.departureTime) - 
                           (stopDetails[0]?.departureTime || stopDetails[0]?.arrivalTime),
        isCurrentlyActive: isTripCurrentlyActive(stopTimes, currentTimeSec)
      }
    });
    
  } catch (error) {
    console.error('[TEST-TRIP] Error:', error);
    res.status(500).json({
      error: 'Failed to test trip activity',
      details: error.message
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
