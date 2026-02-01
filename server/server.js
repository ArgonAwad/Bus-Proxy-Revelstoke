import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import protobuf from 'protobufjs';
import virtualVehicleManager from './virtual-vehicles.js';
import virtualUpdater from './virtual-updater.js';
import ScheduleLoader from './schedule-loader.js';

const scheduleLoader = new ScheduleLoader();
const app = express();
app.use(cors());

// URL of the GTFS-Realtime protobuf schema
const GTFS_PROTO_URL = 'https://raw.githubusercontent.com/google/transit/master/gtfs-realtime/proto/gtfs-realtime.proto';
const BASE_URL = 'https://bct.tmix.se/gtfs-realtime';

// Default operator ID (Revelstoke = 36, can be overridden via query param)
const DEFAULT_OPERATOR_ID = '36';

let root = null;

// Global time offset for debugging virtual bus movement (simulate future time)
let timeOffsetSeconds = 0;

// Helper: Ensure schedule is loaded before using it
async function ensureScheduleLoaded() {
  if (!scheduleLoader.scheduleData || 
      !scheduleLoader.scheduleData.tripsMap || 
      Object.keys(scheduleLoader.scheduleData.tripsMap).length === 0) {
    console.log('[ensureSchedule] Schedule empty - forcing reload...');
    try {
      await scheduleLoader.loadSchedules();
      const counts = {
        trips: Object.keys(scheduleLoader.scheduleData?.tripsMap || {}).length,
        stops: Object.keys(scheduleLoader.scheduleData?.stops || {}).length,
        shapes: Object.keys(scheduleLoader.scheduleData?.shapes || {}).length
      };
      console.log('[ensureSchedule] Reload complete:', counts);
      if (counts.trips === 0) {
        console.warn('[ensureSchedule] WARNING: Still 0 trips after reload!');
      }
    } catch (err) {
      console.error('[ensureSchedule] Reload failed:', err.message);
      throw new Error('Schedule reload failed: ' + err.message);
    }
  } else {
    console.log('[ensureSchedule] Schedule already loaded');
  }
}

// Load and parse the GTFS .proto schema
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

// Helper function to fetch and decode a GTFS feed
async function fetchGTFSFeed(feedType, operatorId = DEFAULT_OPERATOR_ID) {
  if (!root) {
    throw new Error('Proto not loaded');
  }
  const url = `${BASE_URL}/${feedType}?operatorIds=${operatorId}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
    const message = FeedMessage.decode(new Uint8Array(buffer));
    const data = FeedMessage.toObject(message, {
      defaults: true,
      longs: String,
      enums: String,
      bytes: String,
    });
    return {
      success: true,
      data,
      url,
      timestamp: new Date().toISOString(),
      headers: {
        'content-type': response.headers.get('content-type'),
        'content-length': response.headers.get('content-length')
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      url,
      timestamp: new Date().toISOString()
    };
  }
}

// Extract blockId from tripId – last numeric part after colon
function extractBlockIdFromTripId(tripId) {
  if (!tripId || typeof tripId !== 'string') return null;
  const parts = tripId.split(':');
  if (parts.length >= 3) {
    const lastPart = parts[parts.length - 1];
    if (/^\d+$/.test(lastPart)) {
      return lastPart;
    }
  }
  return null;
}

// Fix vehicle structure to match what tracker expects
function fixVehicleStructure(vehicleEntity) {
  if (!vehicleEntity.vehicle) return vehicleEntity;
  const vehicleData = vehicleEntity.vehicle;
  if (vehicleData.vehicle && typeof vehicleData.vehicle === 'object') {
    const nestedVehicle = vehicleData.vehicle;
    const fixedVehicle = {
      trip: vehicleData.trip || null,
      vehicle: {
        id: nestedVehicle.id || '',
        label: nestedVehicle.label || '',
        licensePlate: nestedVehicle.licensePlate || '',
        wheelchairAccessible: nestedVehicle.wheelchairAccessible || 0
      },
      position: vehicleData.position || null,
      timestamp: vehicleData.timestamp || null,
      congestionLevel: vehicleData.congestionLevel || null,
      occupancyStatus: vehicleData.occupancyStatus || null,
      occupancyPercentage: vehicleData.occupancyPercentage || null,
      currentStopSequence: vehicleData.currentStopSequence || null,
      currentStatus: vehicleData.currentStatus || null,
      stopId: vehicleData.stopId || null,
      multiCarriageDetails: vehicleData.multiCarriageDetails || []
    };
    return { ...vehicleEntity, vehicle: fixedVehicle };
  }
  return vehicleEntity;
}

// Add parsed blockId to vehicle entities
function addParsedBlockIdToVehicles(vehicleEntities) {
  if (!Array.isArray(vehicleEntities)) return vehicleEntities || [];
  return vehicleEntities.map(entity => {
    const fixedEntity = fixVehicleStructure(entity);
    const processed = JSON.parse(JSON.stringify(fixedEntity));
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

// Get expected blockIds from trip updates
function getExpectedBlockIdsFromTripUpdates(tripUpdateEntities) {
  const blockIds = new Set();
  if (!Array.isArray(tripUpdateEntities)) return blockIds;
  tripUpdateEntities.forEach(entity => {
    const tripId = entity?.tripUpdate?.trip?.tripId;
    if (tripId) {
      const blockId = extractBlockIdFromTripId(tripId);
      if (blockId) blockIds.add(blockId);
    }
  });
  return Array.from(blockIds);
}

// Get active real blockIds from vehicle positions
function getActiveRealBlockIds(vehicleEntities) {
  const blockIds = new Set();
  if (!Array.isArray(vehicleEntities)) return blockIds;
  vehicleEntities.forEach(entity => {
    const blockId = entity?.vehicle?.trip?.blockId;
    if (blockId) blockIds.add(blockId);
  });
  return blockIds;
}

// Enhanced vehicle positions with virtuals
async function getEnhancedVehiclePositions(
  operatorId = DEFAULT_OPERATOR_ID,
  includeVirtual = true,
  virtualMode = 'subs',
  allVirtuals = false
) {
  try {
    console.log(`🚀 Enhancing vehicle positions for operator ${operatorId}, virtual=${includeVirtual}, mode=${virtualMode}, allVirtuals=${allVirtuals}`);
 
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
 
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);
 
    console.log(`📊 Raw vehicles from API: ${vehicleResult.data?.entity?.length || 0}`);
    console.log(`📊 Trip updates: ${tripResult.data?.entity?.length || 0}`);
 
    let processedVehicles = [];
    let virtualVehicles = [];
 
    if (vehicleResult.success && vehicleResult.data?.entity) {
      processedVehicles = addParsedBlockIdToVehicles(vehicleResult.data.entity);
      console.log(`🔄 Processed structure + blockId for ${processedVehicles.length} vehicles`);
    }
 
    if (includeVirtual && tripResult.success) {
      try {
        const originalMode = virtualVehicleManager.currentMode;
        virtualVehicleManager.setMode(virtualMode);
     
        const realVehicleIds = new Set();
        processedVehicles.forEach(v => {
          if (v.vehicle?.vehicle?.id) realVehicleIds.add(v.vehicle.vehicle.id);
        });
     
        if (virtualMode === 'all') {
          virtualVehicles = virtualVehicleManager.generateAllVirtualVehicles(
            tripResult.data,
            scheduleLoader.scheduleData
          );
        } else {
          virtualVehicles = virtualVehicleManager.generateSubstituteVirtualVehicles(
            tripResult.data,
            scheduleLoader.scheduleData,
            realVehicleIds,
            allVirtuals
          );
        }
     
        virtualVehicleManager.updateVirtualPositions(scheduleLoader.scheduleData);
        virtualVehicleManager.setMode(originalMode);
        console.log(`👻 Virtual vehicles generated: ${virtualVehicles.length} (allVirtuals=${allVirtuals})`);
      } catch (virtualError) {
        console.warn('⚠️ Virtual vehicle generation failed:', virtualError.message);
        virtualVehicles = [];
      }
    }
 
    const allEntities = [...processedVehicles, ...virtualVehicles];
 
    return {
      ...vehicleResult,
      data: {
        ...vehicleResult.data,
        entity: allEntities,
        metadata: {
          ...vehicleResult.data.metadata || {},
          total_vehicles: allEntities.length,
          virtual_vehicles: virtualVehicles.length,
          real_vehicles: processedVehicles.length,
          all_virtuals_mode: allVirtuals
        }
      }
    };
  } catch (error) {
    console.error('❌ Error enhancing vehicle positions:', error);
    throw error;
  }
}

await loadProto();

// ==================== ENDPOINTS ====================
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
  } catch (error) {
    console.error('Error in /api/buses:', error);
    res.status(500).json({
      error: 'Failed to fetch combined feeds',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/virtuals', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const allVirtuals = req.query.all_virtuals === 'true';
    const currentTimeSec = Math.floor(Date.now() / 1000);  // Current Unix time
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] /api/virtuals called | operator=${operatorId} | all_virtuals=${allVirtuals} | time=${currentTimeSec}`);

    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);
    if (!tripResult.success) return res.status(503).json({ error: 'Trip feed unavailable' });

    const processedTrips = addParsedBlockIdToTripUpdates(tripResult.data.entity || []);
    const expectedBlocks = getExpectedBlockIdsFromTripUpdates(processedTrips);

    await ensureScheduleLoaded();

    const virtualEntities = [];

    processedTrips.forEach(entity => {
      const tu = entity.tripUpdate;
      if (!tu) return;
      const trip = tu.trip;
      const stopTimes = tu.stopTimeUpdate || [];
      if (!trip || !trip.tripId || stopTimes.length === 0) return;

      const blockId = extractBlockIdFromTripId(trip.tripId);

      // Skip if not in all mode and block is real
      if (!allVirtuals && activeRealBlocks.has(blockId)) return;

      // Check if trip is active now
      if (this.isTripCurrentlyActive(stopTimes, currentTimeSec)) {
        const currentStopInfo = this.findCurrentStopAndProgress(stopTimes, currentTimeSec);
        if (!currentStopInfo) return;

        const { currentStop, nextStop, progress } = currentStopInfo;

        const position = this.calculateCurrentPosition(currentStop, nextStop, progress, scheduleLoader.scheduleData, trip.tripId);

        const shapeId = this.getShapeIdFromTrip(trip.tripId, scheduleLoader.scheduleData);

        const virtualEntity = {
          id: `VIRT-${allVirtuals ? 'ALL-' : ''}${blockId}`,
          isDeleted: false,
          tripUpdate: null,
          vehicle: {
            trip: {
              tripId: trip.tripId,
              startTime: trip.startTime,
              startDate: trip.startDate,
              scheduleRelationship: 0,
              routeId: trip.routeId,
              directionId: trip.directionId || 0,
              modifiedTrip: null,
              blockId: blockId
            },
            position: {
              latitude: position.latitude,
              longitude: position.longitude,
              bearing: position.bearing,
              odometer: 0,
              speed: position.speed
            },
            currentStopSequence: currentStop.stopSequence || 1,
            currentStatus: progress === 0 ? 1 : 2,
            timestamp: currentTimeSec,
            congestionLevel: 0,
            stopId: currentStop.stopId,
            vehicle: {
              id: `VIRT-${allVirtuals ? 'ALL-' : ''}${blockId}`,
              label: `Ghost Bus ${trip.routeId.split('-')[0]}`,
              licensePlate: "",
              wheelchairAccessible: 0,
              is_virtual: true,
              virtual_mode: allVirtuals ? 'AllScheduled' : 'Substitute',
              original_trip_id: trip.tripId
            },
            occupancyStatus: 0,
            occupancyPercentage: 0,
            multiCarriageDetails: [],
            progress: progress
          },
          alert: null,
          shape: null,
          stop: null,
          tripModifications: null,
          lastUpdated: Date.now(),
          stopTimes: stopTimes,
          currentStop: currentStop,
          nextStop: nextStop,
          modeType: allVirtuals ? 'AllScheduled' : 'Substitute',
          _metadata: {
            progress: progress,
            shapeId: shapeId,
            lastUpdate: Date.now(),
            startTime: currentTimeSec,
            stopTimes: stopTimes,
            currentStop: currentStop,
            nextStop: nextStop,
            currentStopInfo: currentStopInfo,
            positionHistory: [{
              lat: position.latitude,
              lng: position.longitude,
              time: currentTimeSec,
              progress: progress
            }]
          }
        };

        virtualEntities.push(virtualEntity);
      }
    });

    const responseTime = Date.now() - startTime;
    res.json({
      metadata: {
        operatorId,
        fetchedAt: new Date().toISOString(),
        responseTimeMs: responseTime,
        mode: allVirtuals ? 'all_scheduled' : 'missing_only',
        total_scheduled_blocks: expectedBlocks.length,
        real_active_blocks: activeRealBlocks.size,
        virtuals_generated: virtualEntities.length
      },
      data: {
        virtual_positions: {
          header: {
            gtfs_realtime_version: "2.0",
            incrementality: "FULL_DATASET",
            timestamp: currentTimeSec
          },
          entity: virtualEntities
        }
      }
    });

    console.log(`Returned ${virtualEntities.length} virtual positions (computed on-the-fly)`);
  } catch (error) {
    console.error('Error in /api/virtuals:', error);
    res.status(500).json({ error: 'Failed to generate virtuals', details: error.message });
  }
});

app.get('/api/vehicle_positions', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const includeVirtual = req.query.virtual !== 'false' && !('no_virtuals' in req.query);
    const virtualMode = req.query.virtual_mode || 'subs';
    console.log(`Vehicle positions: operator=${operatorId}, virtual=${includeVirtual}, mode=${virtualMode}, no_virtuals=${'no_virtuals' in req.query}`);
    const enhancedVehicleResult = await getEnhancedVehiclePositions(operatorId, includeVirtual, virtualMode);
    res.json({
      metadata: {
        operatorId,
        fetchedAt: new Date().toISOString(),
        block_id_enabled: true,
        block_id_source: "parsed_from_trip_id",
        no_virtuals: !includeVirtual,
        virtual_vehicles: enhancedVehicleResult.data?.metadata?.virtual_vehicles || 0,
        real_vehicles: enhancedVehicleResult.data?.metadata?.real_vehicles || 0,
        feed_info: {
          success: enhancedVehicleResult.success,
          entities: enhancedVehicleResult.success ? enhancedVehicleResult.data.entity?.length || 0 : 0,
          url: enhancedVehicleResult.url
        }
      },
      data: enhancedVehicleResult.success ? enhancedVehicleResult.data : null
    });
  } catch (error) {
    console.error('Error in /api/vehicle_positions:', error);
    res.status(500).json({
      error: 'Failed to fetch vehicle positions',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/trip_updates', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const result = await fetchGTFSFeed('tripupdates.pb', operatorId);
    if (result.success) {
      const processed = addParsedBlockIdToTripUpdates(result.data.entity || []);
      res.json({
        metadata: {
          feedType: 'trip_updates',
          operatorId,
          fetchedAt: result.timestamp,
          url: result.url,
          entities: processed.length,
          block_id_parsed: processed.filter(e => !!e.tripUpdate?.trip?.blockId).length
        },
        data: {
          ...result.data,
          entity: processed
        }
      });
    } else {
      res.status(500).json({
        error: 'Failed to fetch trip updates',
        details: result.error,
        url: result.url,
        timestamp: result.timestamp
      });
    }
  } catch (error) {
    console.error('Error in /api/trip_updates:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Debug time simulation endpoint
app.get('/api/debug/simulate-time', (req, res) => {
  const offset = parseInt(req.query.offset || '0', 10);
  timeOffsetSeconds = offset;
  console.log(`[DEBUG] Virtual time offset set to ${offset} seconds`);
  res.json({
    status: 'ok',
    offset_seconds: offset,
    simulated_time: new Date(Date.now() + offset * 1000).toISOString()
  });
});

// All your original debug endpoints
app.get('/api/debug/updater-status', (req, res) => {
  const status = virtualUpdater.getStatus();
  res.json({
    updater: status,
    note: status.isRunning ? 'Updater is active - virtuals should update every ' + status.updateInterval / 1000 + ' seconds' : 'Updater NOT running - virtuals won\'t move. Try /api/debug/start-updater'
  });
});

app.get('/api/debug/start-updater', (req, res) => {
  try {
    virtualUpdater.start();
    res.json({
      status: 'started',
      note: 'Updater forced to start. Check /api/debug/updater-status to confirm isRunning: true. Virtuals should now advance over time.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start updater: ' + err.message });
  }
});

app.get('/api/debug/force-create-virtuals', async (req, res) => {
  try {
    const allVirtuals = req.query.all === 'true';
    const tripResult = await fetchGTFSFeed('tripupdates.pb', DEFAULT_OPERATOR_ID);
    if (!tripResult.success) return res.status(503).json({ error: 'Trip feed unavailable' });

    await ensureScheduleLoaded(); // From previous changes

    const processedTrips = addParsedBlockIdToTripUpdates(tripResult.data.entity || []);
    const expectedBlocks = getExpectedBlockIdsFromTripUpdates(processedTrips);

    virtualVehicleManager.virtualVehicles.clear(); // Reset for testing

    const virtualEntities = [];
    expectedBlocks.forEach(blockId => {
      // Find a trip for this block
      const entity = processedTrips.find(e => extractBlockIdFromTripId(e.tripUpdate.trip.tripId) === blockId);
      if (!entity) return;

      const tu = entity.tripUpdate;
      const virtualEntity = virtualVehicleManager.createVirtualVehicle(
        tu.trip,
        tu.stopTimeUpdate || [],
        scheduleLoader.scheduleData,
        `DEBUG-VIRT-${blockId}`,
        allVirtuals ? 'AllScheduled' : 'Substitute'
      );

      if (virtualEntity) {
        virtualVehicleManager.updateVehiclePosition(virtualEntity, scheduleLoader.scheduleData);
        virtualEntities.push(virtualEntity);
      }
    });

    res.json({
      status: 'created',
      generated: virtualEntities.length,
      note: 'Virtuals forced recreated. Check /api/debug/virtual-state for positions/progress.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to force create virtuals: ' + err.message });
  }
});

app.get('/api/debug/force-update-positions', async (req, res) => {
  try {
    await ensureScheduleLoaded();
    const result = virtualVehicleManager.updateVirtualPositions(scheduleLoader.scheduleData);
    res.json({
      status: 'updated',
      updated_count: result.updated,
      removed_count: result.removed,
      total_virtuals: virtualVehicleManager.virtualVehicles.size,
      note: 'Positions forced updated. Check /api/debug/virtual-state for new progress/positions.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to force update positions: ' + err.message });
  }
});

app.get('/api/debug/schedule-status', async (req, res) => {
  try {
    await scheduleLoader.loadSchedules();
    const scheduleData = scheduleLoader.scheduleData;
    const debugInfo = virtualVehicleManager.debugScheduleData();
    const tripResult = await fetchGTFSFeed('tripupdates.pb', '36');
    const tripUpdates = tripResult.success ? tripResult.data?.entity || [] : [];
    const updateTripIds = tripUpdates
      .filter(tu => tu.tripUpdate?.trip?.tripId)
      .map(tu => tu.tripUpdate.trip.tripId)
      .slice(0, 5);
    res.json({
      schedule_loading: {
        attempted: true,
        trips_loaded: Object.keys(scheduleData.tripsMap || {}).length,
        stops_loaded: Object.keys(scheduleData.stops || {}).length,
        shapes_loaded: Object.keys(scheduleData.shapes || {}).length,
        sample_trip_ids: Object.keys(scheduleData.tripsMap || {}).slice(0, 5),
        sample_shape_ids: Object.keys(scheduleData.shapes || {}).slice(0, 3)
      },
      virtual_manager: debugInfo,
      trip_updates: {
        count: tripUpdates.length,
        sample_trip_ids: updateTripIds
      },
      analysis: Object.keys(scheduleData.tripsMap || {}).length === 0
        ? '❌ CRITICAL: No trips loaded! Check schedule-loader.js'
        : '✅ Schedule data loaded'
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

app.get('/api/debug/test-virtual-movement', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    const scheduleData = scheduleLoader.scheduleData;
    const trips = Object.entries(scheduleData.tripsMap || {});
    const tripWithShape = trips.find(([id, trip]) => trip.shape_id);
    if (!tripWithShape) {
      return res.json({
        error: 'No trips with shapes found',
        total_trips: trips.length,
        trips_with_shapes: trips.filter(([id, trip]) => trip.shape_id).length
      });
    }
    const [tripId, trip] = tripWithShape;
    const shapeId = trip.shape_id;
    const shapePoints = scheduleData.shapes?.[shapeId];
    const testVehicle = {
      id: 'MOVEMENT-TEST-1',
      vehicle: {
        trip: {
          tripId: tripId,
          routeId: trip.route_id,
          blockId: trip.block_id || 'TEST-BLOCK'
        },
        vehicle: {
          id: 'MOVEMENT-TEST-1',
          label: 'Movement Test Bus',
          licensePlate: '',
          wheelchairAccessible: 0
        },
        position: {
          latitude: shapePoints?.[0]?.lat || 50.9981,
          longitude: shapePoints?.[0]?.lon || -118.1957,
          bearing: 0,
          speed: 5.0
        },
        timestamp: Math.floor(Date.now() / 1000),
        currentStatus: 'IN_TRANSIT_TO'
      },
      _metadata: {
        shapeId: shapeId,
        progress: 0.1,
        lastUpdate: Date.now(),
        stopTimes: [
          {
            stopId: 'TEST-START',
            arrival: { time: Math.floor(Date.now() / 1000) - 300 },
            departure: { time: Math.floor(Date.now() / 1000) - 240 }
          },
          {
            stopId: 'TEST-END',
            arrival: { time: Math.floor(Date.now() / 1000) + 600 },
            departure: { time: Math.floor(Date.now() / 1000) + 660 }
          }
        ]
      },
      lastUpdated: Date.now()
    };
    virtualVehicleManager.virtualVehicles.set('MOVEMENT-TEST-1', testVehicle);
    const updateResult = virtualVehicleManager.forceUpdateAllVirtuals(scheduleData);
    res.json({
      test_created: true,
      vehicle_id: 'MOVEMENT-TEST-1',
      trip: {
        id: tripId,
        shape_id: shapeId,
        shape_points: shapePoints?.length || 0
      },
      update_result: updateResult,
      virtual_count: virtualVehicleManager.virtualVehicles.size
    });
  } catch (error) {
    console.error('Virtual movement test error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/data-flow', async (req, res) => {
  try {
    console.log('=== DATA FLOW TRACE ===');
    const directData = scheduleLoader.scheduleData;
    console.log('1. Direct from scheduleLoader:');
    console.log(' - Has data?', !!directData);
    console.log(' - Keys:', directData ? Object.keys(directData) : []);
    console.log('2. Calling loadSchedules()...');
    const loadedData = await scheduleLoader.loadSchedules();
    console.log(' - Returned:', typeof loadedData);
    console.log(' - Has tripsMap?', !!loadedData?.tripsMap);
    console.log(' - Trips count:', loadedData?.tripsMap ? Object.keys(loadedData.tripsMap).length : 0);
    console.log('3. Checking for mutations...');
    const afterLoadData = scheduleLoader.scheduleData;
    console.log(' - Same object?', directData === afterLoadData);
    console.log(' - Still has trips?', afterLoadData?.tripsMap ? Object.keys(afterLoadData.tripsMap).length : 0);
    console.log('4. Simulating /api/health check...');
    const healthCheckData = scheduleLoader.scheduleData;
    const healthCounts = healthCheckData ? {
      trips: Object.keys(healthCheckData.tripsMap || {}).length,
      stops: Object.keys(healthCheckData.stops || {}).length,
      shapes: Object.keys(healthCheckData.shapes || {}).length
    } : { trips: 0, stops: 0, shapes: 0 };
    console.log(' - Health sees:', healthCounts);
    console.log('5. Checking property descriptors...');
    const descriptors = {};
    if (directData) {
      ['tripsMap', 'stops', 'shapes'].forEach(key => {
        const desc = Object.getOwnPropertyDescriptor(directData, key);
        descriptors[key] = {
          hasGetter: !!desc?.get,
          hasSetter: !!desc?.set,
          enumerable: desc?.enumerable,
          configurable: desc?.configurable
        };
      });
    }
    res.json({
      trace: {
        direct_from_loader: {
          has_data: !!directData,
          keys: directData ? Object.keys(directData) : [],
          trips_count: directData?.tripsMap ? Object.keys(directData.tripsMap).length : 0,
          stops_count: directData?.stops ? Object.keys(directData.stops).length : 0,
          shapes_count: directData?.shapes ? Object.keys(directData.shapes).length : 0
        },
        after_load: {
          returned_data_type: typeof loadedData,
          returned_has_trips: !!loadedData?.tripsMap,
          returned_trips_count: loadedData?.tripsMap ? Object.keys(loadedData.tripsMap).length : 0
        },
        comparison: {
          same_object: directData === afterLoadData,
          trips_same: directData?.tripsMap === afterLoadData?.tripsMap
        },
        health_check_simulation: healthCounts,
        property_descriptors: descriptors
      },
      analysis: healthCounts.trips === 0 ?
        '❌ Health endpoint sees 0 trips but data exists!' :
        '✅ Data flow looks correct',
      possible_issues: [
        'Data is being cleared somewhere after load',
        'There might be a race condition',
        'The health endpoint might be checking before data is loaded',
        'There could be multiple instances of ScheduleLoader'
      ]
    });
  } catch (error) {
    console.error('Data flow trace error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/schedule-source', async (req, res) => {
  try {
    console.log('=== SCHEDULE LOADER DIAGNOSIS ===');
    const loaderInfo = {
      constructorName: scheduleLoader.constructor.name,
      methods: Object.getOwnPropertyNames(Object.getPrototypeOf(scheduleLoader)),
      properties: Object.getOwnPropertyNames(scheduleLoader),
      hasLoadMethod: typeof scheduleLoader.loadSchedules === 'function',
      hasScheduleData: !!scheduleLoader.scheduleData
    };
    console.log('Loader info:', loaderInfo);
    console.log('Calling loadSchedules()...');
    let loadResult;
    try {
      loadResult = await scheduleLoader.loadSchedules();
      console.log('loadSchedules() returned:', typeof loadResult, loadResult ? 'has data' : 'null/undefined');
    } catch (loadError) {
      console.error('loadSchedules() error:', loadError.message);
      loadResult = { error: loadError.message };
    }
    const scheduleData = scheduleLoader.scheduleData;
    const dataAnalysis = {
      exists: !!scheduleData,
      keys: scheduleData ? Object.keys(scheduleData) : [],
      tripsMap: scheduleData?.tripsMap ? {
        exists: true,
        keys: Object.keys(scheduleData.tripsMap),
        count: Object.keys(scheduleData.tripsMap).length,
        firstKey: Object.keys(scheduleData.tripsMap)[0],
        firstValue: scheduleData.tripsMap[Object.keys(scheduleData.tripsMap)[0]]
      } : { exists: false },
      stops: scheduleData?.stops ? {
        exists: true,
        count: Object.keys(scheduleData.stops).length
      } : { exists: false },
      shapes: scheduleData?.shapes ? {
        exists: true,
        count: Object.keys(scheduleData.shapes).length
      } : { exists: false }
    };
    console.log('Data analysis:', dataAnalysis);
    console.log('Testing GTFS URL...');
    const gtfsUrl = 'https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=36';
    let urlTest = { accessible: false };
    try {
      const testResponse = await fetch(gtfsUrl);
      urlTest = {
        accessible: true,
        status: testResponse.status,
        statusText: testResponse.statusText,
        contentType: testResponse.headers.get('content-type'),
        contentLength: testResponse.headers.get('content-length')
      };
      const buffer = await testResponse.arrayBuffer();
      const firstBytes = Buffer.from(buffer.slice(0, 4)).toString('hex');
      urlTest.firstBytesHex = firstBytes;
      urlTest.isZip = firstBytes === '504b0304';
    } catch (err) {
      urlTest.error = err.message;
    }
    res.json({
      diagnosis: {
        timestamp: new Date().toISOString(),
        issue: 'Schedule data structure exists but is empty (0 trips, 0 stops, 0 shapes)',
        likely_cause: 'ScheduleLoader.fetchAndParseGTFS() is not populating data correctly'
      },
      loader_analysis: loaderInfo,
      load_result: {
        called: true,
        returned_type: typeof loadResult,
        has_error: loadResult?.error || false
      },
      data_analysis: dataAnalysis,
      gtfs_url_test: {
        url: gtfsUrl,
        ...urlTest
      },
      next_steps: [
        'Check ScheduleLoader.js fetchAndParseGTFS() method',
        'Check if ZIP extraction is working',
        'Check if CSV parsing is working',
        'Look for error handling that might swallow errors'
      ]
    });
  } catch (error) {
    console.error('Diagnosis error:', error);
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

app.get('/api/debug/shape-movement', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    const scheduleData = scheduleLoader.scheduleData;
    const { trip_id, shape_id } = req.query;
    const trips = Object.entries(scheduleData.tripsMap || {});
    const sampleTrip = trips.find(([id, trip]) => trip.shape_id) || trips[0];
    if (!sampleTrip) {
      return res.json({ error: 'No trips found' });
    }
    const [tripId, trip] = sampleTrip;
    const shapeId = shape_id || trip.shape_id;
    const shapePoints = scheduleData.shapes?.[shapeId];
    if (!shapePoints) {
      return res.json({
        error: 'No shape found',
        trip_id: tripId,
        shape_id: shapeId,
        available_shapes: Object.keys(scheduleData.shapes || {})
      });
    }
    const totalDistance = shapePoints.length;
    const testPositions = [0.1, 0.25, 0.5, 0.75, 0.9];
    const calculatedPositions = testPositions.map(percent => {
      const index = Math.floor(percent * (totalDistance - 1));
      return shapePoints[index] || shapePoints[0];
    });
    res.json({
      trip: {
        id: tripId,
        route_id: trip.route_id,
        shape_id: shapeId,
        block_id: trip.block_id
      },
      shape: {
        id: shapeId,
        total_points: shapePoints.length,
        first_point: shapePoints[0],
        last_point: shapePoints[shapePoints.length - 1],
        bounding_box: {
          min_lat: Math.min(...shapePoints.map(p => p.lat)),
          max_lat: Math.max(...shapePoints.map(p => p.lat)),
          min_lon: Math.min(...shapePoints.map(p => p.lon)),
          max_lon: Math.max(...shapePoints.map(p => p.lon))
        }
      },
      movement_test: {
        total_distance_points: totalDistance,
        test_positions: calculatedPositions.map((pos, i) => ({
          percent: testPositions[i],
          point_index: Math.floor(testPositions[i] * (totalDistance - 1)),
          latitude: pos.lat,
          longitude: pos.lon
        }))
      },
      virtual_vehicle_manager: {
        has_update_method: typeof virtualVehicleManager.updateVehiclePosition === 'function',
        has_update_all_method: typeof virtualVehicleManager.updateVirtualPositions === 'function',
        current_mode: virtualVehicleManager.currentMode
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/virtual-state', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const virtualEntities = virtualVehicleManager.virtualVehicles || {};
    const virtualIds = Object.keys(virtualEntities);
    const virtualStates = virtualIds.map(id => {
      const vehicle = virtualEntities[id];
      return {
        id,
        block_id: vehicle?.vehicle?.trip?.blockId,
        trip_id: vehicle?.vehicle?.trip?.tripId,
        position: vehicle?.vehicle?.position,
        timestamp: vehicle?.vehicle?.timestamp,
        shape_id: vehicle?._metadata?.shapeId,
        progress: vehicle?._metadata?.progress
      };
    });
    const updaterState = virtualUpdater ? {
      isRunning: virtualUpdater.isRunning,
      updateInterval: virtualUpdater.updateInterval,
      lastUpdate: virtualUpdater.lastUpdate
    } : { isRunning: false };
    res.json({
      virtual_system: {
        total_virtuals: virtualIds.length,
        virtual_ids: virtualIds,
        updater: updaterState
      },
      virtual_states: virtualStates,
      schedule_ready: !!scheduleLoader.scheduleData?.shapes
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/trip-shapes', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    const scheduleData = scheduleLoader.scheduleData;
    const trips = Object.entries(scheduleData.tripsMap || {});
    const analysis = {
      total_trips: trips.length,
      trips_with_shapes: trips.filter(([id, trip]) => trip.shape_id).length,
      trips_without_shapes: trips.filter(([id, trip]) => !trip.shape_id).length,
      unique_shapes: new Set(trips.map(([id, trip]) => trip.shape_id).filter(Boolean)).size
    };
    const tripsWithShapes = trips
      .filter(([id, trip]) => trip.shape_id)
      .slice(0, 10)
      .map(([id, trip]) => ({
        trip_id: id,
        route_id: trip.route_id,
        shape_id: trip.shape_id,
        block_id: trip.block_id,
        shape_points: scheduleData.shapes?.[trip.shape_id]?.length || 0
      }));
    const tripsWithoutShapes = trips
      .filter(([id, trip]) => !trip.shape_id)
      .slice(0, 10)
      .map(([id, trip]) => ({
        trip_id: id,
        route_id: trip.route_id,
        block_id: trip.block_id
      }));
    res.json({
      analysis,
      trips_with_shapes: tripsWithShapes,
      trips_without_shapes: tripsWithoutShapes,
      shapes_available: Object.keys(scheduleData.shapes || {}).slice(0, 10)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/test-virtual-move', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    const scheduleData = scheduleLoader.scheduleData;
    const trips = Object.entries(scheduleData.tripsMap || {});
    const tripWithShape = trips.find(([id, trip]) => trip.shape_id);
    if (!tripWithShape) {
      return res.json({ error: 'No trips with shapes found' });
    }
    const [tripId, trip] = tripWithShape;
    const shapeId = trip.shape_id;
    const shapePoints = scheduleData.shapes?.[shapeId];
    if (!shapePoints) {
      return res.json({ error: 'Shape not found', shape_id: shapeId });
    }
    const testVehicle = {
      id: 'TEST-VIRTUAL-1',
      vehicle: {
        trip: {
          tripId: tripId,
          routeId: trip.route_id,
          blockId: trip.block_id || 'TEST-BLOCK'
        },
        vehicle: {
          id: 'TEST-VIRTUAL-1',
          label: 'Test Virtual Bus',
          licensePlate: '',
          wheelchairAccessible: 0
        },
        position: {
          latitude: shapePoints[0].lat,
          longitude: shapePoints[0].lon,
          bearing: 0,
          speed: 0
        },
        timestamp: Math.floor(Date.now() / 1000),
        currentStatus: 'IN_TRANSIT_TO'
      },
      _metadata: {
        shapeId: shapeId,
        progress: 0,
        lastUpdate: Date.now(),
        speedMultiplier: 1.0
      }
    };
    if (!virtualVehicleManager.virtualVehicles) {
      virtualVehicleManager.virtualVehicles = {};
    }
    virtualVehicleManager.virtualVehicles['TEST-VIRTUAL-1'] = testVehicle;
    if (typeof virtualVehicleManager.updateVehiclePosition === 'function') {
      virtualVehicleManager.updateVehiclePosition(testVehicle, scheduleData);
      for (let i = 0; i < 3; i++) {
        testVehicle._metadata.progress += 0.1;
        virtualVehicleManager.updateVehiclePosition(testVehicle, scheduleData);
      }
    }
    res.json({
      test_vehicle_created: true,
      initial_position: {
        lat: shapePoints[0].lat,
        lon: shapePoints[0].lon
      },
      final_position: testVehicle.vehicle.position,
      progress: testVehicle._metadata.progress,
      shape_info: {
        id: shapeId,
        points: shapePoints.length,
        points_used: Math.floor(testVehicle._metadata.progress * shapePoints.length)
      },
      vehicle_data: {
        id: testVehicle.id,
        position: testVehicle.vehicle.position,
        timestamp: testVehicle.vehicle.timestamp
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  const scheduleData = scheduleLoader.scheduleData;
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    proto_loaded: !!root,
    schedule_loaded: !!scheduleData,
    schedule_counts: scheduleData ? {
      trips: Object.keys(scheduleData.tripsMap || {}).length,
      stops: Object.keys(scheduleData.stops || {}).length,
      shapes: Object.keys(scheduleData.shapes || {}).length
    } : null,
    virtual_system: {
      has_manager: !!virtualVehicleManager,
      has_updater: !!virtualUpdater,
      manager_mode: virtualVehicleManager?.currentMode
    }
  });
});

app.get('/api/debug/virtual-creation', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const allVirtuals = req.query.all_virtuals === 'true';
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);
    if (!tripResult.success || !tripResult.data?.entity) {
      return res.json({ error: 'No trip updates' });
    }
    const processedTrips = addParsedBlockIdToTripUpdates(tripResult.data.entity || []);
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    const scheduleData = scheduleLoader.scheduleData;
    const sampleTripUpdate = processedTrips[0];
    if (!sampleTripUpdate?.tripUpdate) {
      return res.json({ error: 'No trip updates available' });
    }
    const trip = sampleTripUpdate.tripUpdate.trip;
    const stopTimeUpdates = sampleTripUpdate.tripUpdate.stopTimeUpdate || [];
    console.log('Creating test virtual vehicle for trip:', trip.tripId);
    const virtualEntity = virtualVehicleManager.createVirtualVehicle(
      trip,
      stopTimeUpdates,
      scheduleData,
      'TEST-VIRTUAL-1',
      'Test'
    );
    if (!virtualEntity) {
      return res.json({ error: 'createVirtualVehicle returned null' });
    }
    const hasMetadata = !!virtualEntity._metadata;
    const metadata = virtualEntity._metadata || {};
    const hasProgress = 'progress' in metadata;
    const hasShapeId = 'shapeId' in metadata;
    res.json({
      virtual_created: true,
      vehicle_id: virtualEntity.id,
      trip_info: {
        trip_id: trip.tripId,
        route_id: trip.routeId,
        block_id: trip.blockId,
        shape_id: trip.shapeId
      },
      metadata: {
        exists: hasMetadata,
        values: metadata,
        has_progress: hasProgress,
        has_shape_id: hasShapeId,
        progress_value: metadata.progress,
        shape_id_value: metadata.shapeId
      },
      position: virtualEntity.vehicle?.position,
      shape_data: metadata.shapeId ? {
        exists: !!scheduleData.shapes?.[metadata.shapeId],
        point_count: scheduleData.shapes?.[metadata.shapeId]?.length || 0
      } : null,
      update_methods: {
        has_updateVehiclePosition: typeof virtualVehicleManager.updateVehiclePosition === 'function',
        has_updateVirtualPositions: typeof virtualVehicleManager.updateVirtualPositions === 'function'
      }
    });
  } catch (error) {
    console.error('Virtual creation debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/virtual-movement-test', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    const scheduleData = scheduleLoader.scheduleData;
    const trips = Object.entries(scheduleData.tripsMap || {});
    const tripWithShape = trips.find(([id, trip]) => trip.shape_id);
    if (!tripWithShape) {
      return res.json({ error: 'No trips with shapes found' });
    }
    const [tripId, trip] = tripWithShape;
    const shapeId = trip.shape_id;
    const shapePoints = scheduleData.shapes?.[shapeId];
    if (!shapePoints || shapePoints.length === 0) {
      return res.json({ error: 'Shape has no points', shape_id: shapeId });
    }
    console.log(`Testing movement on shape ${shapeId} with ${shapePoints.length} points`);
    const testVehicle = {
      id: 'MOVEMENT-TEST-1',
      vehicle: {
        trip: {
          tripId: tripId,
          routeId: trip.route_id,
          blockId: trip.block_id || 'TEST-BLOCK'
        },
        vehicle: {
          id: 'MOVEMENT-TEST-1',
          label: 'Movement Test Bus',
          licensePlate: '',
          wheelchairAccessible: 0
        },
        position: {
          latitude: shapePoints[0].lat,
          longitude: shapePoints[0].lon,
          bearing: 0,
          speed: 5.0
        },
        timestamp: Math.floor(Date.now() / 1000),
        currentStatus: 'IN_TRANSIT_TO'
      },
      _metadata: {
        shapeId: shapeId,
        progress: 0,
        lastUpdate: Date.now(),
        speedMultiplier: 1.0,
        totalShapePoints: shapePoints.length
      }
    };
    if (!virtualVehicleManager.virtualVehicles) {
      virtualVehicleManager.virtualVehicles = {};
    }
    virtualVehicleManager.virtualVehicles['MOVEMENT-TEST-1'] = testVehicle;
    const positions = [];
    if (typeof virtualVehicleManager.updateVehiclePosition === 'function') {
      positions.push({
        step: 0,
        progress: testVehicle._metadata.progress,
        position: { ...testVehicle.vehicle.position },
        point_index: Math.floor(testVehicle._metadata.progress * shapePoints.length)
      });
      for (let i = 1; i <= 5; i++) {
        testVehicle._metadata.progress += 0.1;
        if (testVehicle._metadata.progress > 1.0) {
          testVehicle._metadata.progress = 1.0;
        }
        virtualVehicleManager.updateVehiclePosition(testVehicle, scheduleData);
        positions.push({
          step: i,
          progress: testVehicle._metadata.progress,
          position: { ...testVehicle.vehicle.position },
          point_index: Math.floor(testVehicle._metadata.progress * (shapePoints.length - 1)),
          shape_point_at_index: shapePoints[Math.floor(testVehicle._metadata.progress * (shapePoints.length - 1))]
        });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else {
      positions.push({
        note: 'updateVehiclePosition method not found, using manual calculation',
        shape_length: shapePoints.length
      });
    }
    res.json({
      test_vehicle: {
        id: testVehicle.id,
        shape_id: shapeId,
        total_shape_points: shapePoints.length,
        initial_progress: 0,
        final_progress: testVehicle._metadata.progress
      },
      movement_test: {
        positions: positions,
        shape_info: {
          id: shapeId,
          total_points: shapePoints.length,
          first_point: shapePoints[0],
          midpoint: shapePoints[Math.floor(shapePoints.length / 2)],
          last_point: shapePoints[shapePoints.length - 1]
        }
      },
      analysis: positions.length > 1 ?
        `Movement tested: ${positions.length - 1} updates applied` :
        'No movement updates applied'
    });
  } catch (error) {
    console.error('Movement test error:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

app.get('/api/debug/virtual-manager', (req, res) => {
  try {
    const manager = virtualVehicleManager;
    const managerAnalysis = {
      constructor_name: manager.constructor.name,
      current_mode: manager.currentMode,
      has_virtual_vehicles: !!manager.virtualVehicles,
      virtual_vehicles_count: manager.virtualVehicles ? Object.keys(manager.virtualVehicles).length : 0,
      virtual_vehicles_sample: manager.virtualVehicles ?
        Object.keys(manager.virtualVehicles).slice(0, 3) : [],
      methods: {
        createVirtualVehicle: typeof manager.createVirtualVehicle,
        updateVehiclePosition: typeof manager.updateVehiclePosition,
        updateVirtualPositions: typeof manager.updateVirtualPositions,
        generateSubstituteVirtualVehicles: typeof manager.generateSubstituteVirtualVehicles,
        generateAllVirtualVehicles: typeof manager.generateAllVirtualVehicles,
        setMode: typeof manager.setMode,
        clearAllVirtuals: typeof manager.clearAllVirtuals
      },
      sample_vehicle_metadata: (() => {
        if (!manager.virtualVehicles || Object.keys(manager.virtualVehicles).length === 0) {
          return 'No virtual vehicles';
        }
        const firstKey = Object.keys(manager.virtualVehicles)[0];
        const firstVehicle = manager.virtualVehicles[firstKey];
        return {
          vehicle_id: firstKey,
          has_metadata: !!firstVehicle._metadata,
          metadata: firstVehicle._metadata,
          has_position: !!firstVehicle.vehicle?.position,
          position: firstVehicle.vehicle?.position
        };
      })()
    };
    const updaterAnalysis = virtualUpdater ? {
      exists: true,
      isRunning: virtualUpdater.isRunning,
      updateInterval: virtualUpdater.updateInterval,
      lastUpdate: virtualUpdater.lastUpdate,
      hasStart: typeof virtualUpdater.start === 'function',
      hasStop: typeof virtualUpdater.stop === 'function',
      hasRefresh: typeof virtualUpdater.refresh === 'function'
    } : { exists: false };
    res.json({
      virtual_vehicle_manager: managerAnalysis,
      virtual_updater: updaterAnalysis,
      summary: {
        system_ready: managerAnalysis.methods.updateVehiclePosition === 'function',
        movement_possible: managerAnalysis.methods.updateVehiclePosition === 'function' &&
                          updaterAnalysis.exists &&
                          updaterAnalysis.isRunning,
        needs_fix: managerAnalysis.methods.updateVehiclePosition !== 'function' ?
          'updateVehiclePosition method missing or not a function' :
          'Check implementation of updateVehiclePosition'
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/manual-move-virtuals', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    const scheduleData = scheduleLoader.scheduleData;
    const virtuals = virtualVehicleManager.virtualVehicles || {};
    const virtualIds = Object.keys(virtuals);
    if (virtualIds.length === 0) {
      return res.json({ error: 'No virtual vehicles found' });
    }
    console.log(`Moving ${virtualIds.length} virtual vehicles...`);
    const movementResults = [];
    for (const vehicleId of virtualIds.slice(0, 10)) {
      const vehicle = virtuals[vehicleId];
      if (!vehicle._metadata) {
        vehicle._metadata = {
          progress: 0,
          lastUpdate: Date.now(),
          speedMultiplier: 1.0
        };
      }
      const beforeProgress = vehicle._metadata.progress || 0;
      const beforePosition = vehicle.vehicle?.position ? { ...vehicle.vehicle.position } : null;
      if (vehicle._metadata.progress === undefined) {
        vehicle._metadata.progress = 0.1;
      } else {
        vehicle._metadata.progress += 0.05;
      }
      if (vehicle._metadata.progress > 1.0) {
        vehicle._metadata.progress = 1.0;
      }
      if (typeof virtualVehicleManager.updateVehiclePosition === 'function') {
        virtualVehicleManager.updateVehiclePosition(vehicle, scheduleData);
      } else {
        const shapeId = vehicle._metadata.shapeId;
        if (shapeId && scheduleData.shapes?.[shapeId]) {
          const shapePoints = scheduleData.shapes[shapeId];
          const pointIndex = Math.floor(vehicle._metadata.progress * (shapePoints.length - 1));
          const targetPoint = shapePoints[pointIndex] || shapePoints[0];
          if (vehicle.vehicle.position) {
            vehicle.vehicle.position.latitude = targetPoint.lat;
            vehicle.vehicle.position.longitude = targetPoint.lon;
            vehicle.vehicle.position.bearing = vehicle._metadata.progress * 360;
            vehicle.vehicle.position.speed = 5.0;
          }
        }
      }
      vehicle.vehicle.timestamp = Math.floor(Date.now() / 1000);
      vehicle._metadata.lastUpdate = Date.now();
      movementResults.push({
        vehicle_id: vehicleId,
        before: {
          progress: beforeProgress,
          position: beforePosition
        },
        after: {
          progress: vehicle._metadata.progress,
          position: vehicle.vehicle?.position,
          timestamp: vehicle.vehicle?.timestamp
        },
        moved: beforeProgress !== vehicle._metadata.progress
      });
    }
    res.json({
      moved_vehicles: movementResults.length,
      results: movementResults,
      note: 'Virtual vehicles manually moved. Refresh /api/virtuals to see new positions.'
    });
  } catch (error) {
    console.error('Manual move error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/shapes', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    const { shape_id, simplified } = req.query;
    const scheduleData = scheduleLoader.scheduleData;
    if (shape_id) {
      const shapePoints = scheduleData.shapes?.[shape_id];
      if (!shapePoints) {
        return res.status(404).json({ error: 'Shape not found', shape_id });
      }
      let points = shapePoints;
      if (simplified === 'true') {
        points = shapePoints.filter((_, index) => index % 10 === 0);
      }
      const lats = points.map(p => p.lat);
      const lons = points.map(p => p.lon);
      res.json({
        shape_id,
        point_count: points.length,
        original_count: shapePoints.length,
        bounding_box: {
          min_lat: Math.min(...lats),
          max_lat: Math.max(...lats),
          min_lon: Math.min(...lons),
          max_lon: Math.max(...lons)
        },
        points: points.slice(0, 100)
      });
    } else {
      const shapes = scheduleData.shapes || {};
      const shapeList = Object.keys(shapes).map(id => ({
        shape_id: id,
        point_count: shapes[id].length,
        trips_using_shape: Object.values(scheduleData.tripsMap || {})
          .filter(trip => trip.shape_id === id)
          .map(trip => trip.trip_id)
      }));
      res.json({
        metadata: {
          count: shapeList.length,
          total_points: shapeList.reduce((sum, shape) => sum + shape.point_count, 0)
        },
        shapes: shapeList
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/schedule-verify', async (req, res) => {
  try {
    console.log('Loading schedule data...');
    const scheduleData = await scheduleLoader.loadSchedules();
    const testStops = ['156087', '156011', '156083'];
    const stopResults = {};
    testStops.forEach(stopId => {
      const stopData = scheduleData.stops[stopId];
      stopResults[stopId] = stopData ? {
        found: true,
        lat: stopData.lat,
        lon: stopData.lon,
        name: stopData.name
      } : { found: false };
    });
    const sampleTrips = Object.entries(scheduleData.tripsMap || {}).slice(0, 3);
    res.json({
      status: 'success',
      counts: {
        stops: Object.keys(scheduleData.stops || {}).length,
        trips: Object.keys(scheduleData.tripsMap || {}).length,
        shapes: Object.keys(scheduleData.shapes || {}).length,
        stop_times: Object.keys(scheduleData.stopTimesByTrip || {}).length
      },
      test_stops: stopResults,
      sample_trips: sampleTrips.map(([tripId, trip]) => ({
        trip_id: tripId,
        route_id: trip.route_id,
        shape_id: trip.shape_id,
        block_id: trip.block_id
      })),
      sample_stop_data: scheduleData.stops ?
        Object.entries(scheduleData.stops).slice(0, 5).map(([id, data]) => ({ id, ...data })) :
        []
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

app.get('/api/test_structure', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    if (!vehicleResult.success || !vehicleResult.data?.entity) {
      return res.json({ error: 'No vehicle data' });
    }
    const sampleVehicle = vehicleResult.data.entity[0];
    const fixedVehicle = fixVehicleStructure(sampleVehicle);
    const expectedStructure = {
      vehicle: {
        trip: {
          tripId: "SOME_TRIP_ID",
          routeId: "SOME_ROUTE",
          blockId: "12345"
        },
        vehicle: {
          id: "VEHICLE_ID",
          label: "VEHICLE_LABEL",
          licensePlate: "",
          wheelchairAccessible: 0
        },
        position: {
          latitude: 50.0,
          longitude: -118.0,
          bearing: 0,
          speed: 0
        },
        timestamp: 1234567890,
        currentStopSequence: 1,
        currentStatus: "IN_TRANSIT_TO",
        stopId: "STOP_ID"
      }
    };
    res.json({
      original_structure: {
        vehicle: sampleVehicle.vehicle,
        keys: sampleVehicle.vehicle ? Object.keys(sampleVehicle.vehicle) : [],
        has_vehicle_nested: !!sampleVehicle.vehicle?.vehicle
      },
      fixed_structure: {
        vehicle: fixedVehicle.vehicle,
        keys: fixedVehicle.vehicle ? Object.keys(fixedVehicle.vehicle) : [],
        has_vehicle_at_correct_level: !!fixedVehicle.vehicle?.vehicle
      },
      expected_structure: expectedStructure,
      explanation: "Tracker expects: vehicle.vehicle at same level as vehicle.trip, not nested inside"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/test_tracker_compatibility', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    if (!vehicleResult.success || !vehicleResult.data?.entity) {
      return res.json({ error: 'No vehicle data' });
    }
    const sampleVehicle = vehicleResult.data.entity[0];
    const fixedVehicle = fixVehicleStructure(sampleVehicle);
    const hasCorrectStructure =
      fixedVehicle.vehicle &&
      fixedVehicle.vehicle.trip &&
      fixedVehicle.vehicle.vehicle &&
      fixedVehicle.vehicle.position;
    const structureCheck = {
      has_vehicle: !!fixedVehicle.vehicle,
      has_trip: !!fixedVehicle.vehicle?.trip,
      has_vehicle_at_correct_level: !!fixedVehicle.vehicle?.vehicle,
      has_position: !!fixedVehicle.vehicle?.position,
      vehicle_id: fixedVehicle.vehicle?.vehicle?.id,
      trip_id: fixedVehicle.vehicle?.trip?.tripId,
      block_id: fixedVehicle.vehicle?.trip?.blockId || 'NOT_SET',
      is_correct_structure: hasCorrectStructure
    };
    res.json({
      compatibility_check: structureCheck,
      sample_vehicle_after_fix: {
        id: fixedVehicle.id,
        vehicle: {
          trip: {
            tripId: fixedVehicle.vehicle?.trip?.tripId,
            routeId: fixedVehicle.vehicle?.trip?.routeId,
            blockId: fixedVehicle.vehicle?.trip?.blockId || 'NOT_SET'
          },
          vehicle: {
            id: fixedVehicle.vehicle?.vehicle?.id,
            label: fixedVehicle.vehicle?.vehicle?.label
          },
          position: fixedVehicle.vehicle?.position
        }
      },
      verdict: hasCorrectStructure ?
        "✅ Structure should work with tracker" :
        "❌ Structure still wrong for tracker"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>🚌 BC Transit GTFS-RT Proxy</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; line-height: 1.6; }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        .endpoint { background: #f8f9fa; padding: 15px; margin: 10px 0; border-left: 4px solid #3498db; border-radius: 4px; }
        code { background: #e8f4f8; padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', monospace; }
        a { color: #2980b9; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .note { background: #fffacd; padding: 10px; border-radius: 5px; border-left: 3px solid #ffd700; margin: 15px 0; }
        .warning { background: #fee; padding: 10px; border-radius: 5px; border-left: 3px solid #c00; margin: 15px 0; }
        .param { font-weight: bold; color: #c7254e; }
        .example { background: #f5f5f5; padding: 10px; border-radius: 3px; margin: 5px 0; font-family: monospace; }
      </style>
    </head>
    <body>
      <h1>🚌 BC Transit GTFS-RT Proxy</h1>
      <p>Real-time bus data for BC Transit systems</p>
    
      <div class="note">
        <strong>🔄 Vehicle Structure Fix Applied</strong> - Vehicles should now appear in tracker<br>
        <strong>📦 Block IDs Parsed</strong> - blockId extracted from last numeric part of trip_id<br>
        <strong>👻 Virtual Vehicles Working</strong> - Moving along shapes based on schedule
      </div>
    
      <h2>📡 Main Endpoints</h2>
    
      <div class="endpoint">
        <strong>GET <code>/api/buses</code></strong>
        <p>All feeds combined with virtual vehicles</p>
        <p><span class="param">Parameters:</span></p>
        <ul>
          <li><span class="param">?operatorId=36</span> - Operator ID (default: 36 = Revelstoke)</li>
          <li><span class="param">?no_virtuals</span> - Get only real buses</li>
        </ul>
        <p><span class="param">Examples:</span></p>
        <div class="example">
          <a href="/api/buses" target="_blank">/api/buses</a> - With virtuals<br>
          <a href="/api/buses?no_virtuals" target="_blank">/api/buses?no_virtuals</a> - Real only<br>
          <a href="/api/buses?operatorId=47" target="_blank">/api/buses?operatorId=47</a> - Kelowna
        </div>
      </div>
    
      <div class="endpoint">
        <strong>GET <code>/api/vehicle_positions</code></strong>
        <p>Vehicle positions only (supports <code>?no_virtuals</code>)</p>
      </div>
    
      <div class="endpoint">
        <strong>GET <code>/api/virtuals</code></strong>
        <p>Virtual bus positions feed (missing buses only, moving along shapes)</p>
      </div>
    
      <h2>🔧 Testing & Debug Endpoints</h2>
      <ul>
        <li><a href="/api/virtuals" target="_blank">/api/virtuals</a> - Virtual positions feed</li>
        <li><a href="/api/test_structure" target="_blank">/api/test_structure</a> - Check vehicle structure</li>
        <li><a href="/api/test_tracker_compatibility" target="_blank">/api/test_tracker_compatibility</a> - Tracker compatibility test</li>
        <li><a href="/api/trip_updates" target="_blank">/api/trip_updates</a> - Trip updates only</li>
      </ul>
    
      <h2>🔍 Current Status</h2>
      <p><strong>Working:</strong></p>
      <ul>
        <li>Real vehicle positions with parsed block IDs</li>
        <li>Trip updates with parsed block IDs</li>
        <li>Service alerts</li>
        <li>Vehicle structure fixes for tracker</li>
        <li>Virtual vehicles moving along schedule shapes</li>
      </ul>
    
      <p style="margin-top: 2rem; color: #7f8c8d; font-size: 0.9rem; border-top: 1px solid #eee; padding-top: 1rem;">
        Last updated: January 2026 • For Revelstoke Bus Tracker development
      </p>
    </body>
    </html>
  `);
});

// Improved startup: load schedule once + start updater + hourly refresh
async function initializeSystem() {
  try {
    console.log('🚀 Server startup - initializing system...');

    // 1. Load protobuf schema
    await loadProto();

    // 2. Force-load GTFS schedule at startup
    console.log('Loading GTFS schedule at startup...');
    await scheduleLoader.loadSchedules();
    const counts = {
      trips: Object.keys(scheduleLoader.scheduleData?.tripsMap || {}).length,
      stops: Object.keys(scheduleLoader.scheduleData?.stops || {}).length,
      shapes: Object.keys(scheduleLoader.scheduleData?.shapes || {}).length
    };
    console.log('GTFS schedule loaded at startup:', counts);

    if (counts.trips === 0) {
      console.warn('WARNING: No trips loaded at startup - virtuals may use fallback positions');
    }

    // 3. Start virtual updater
    if (virtualUpdater && typeof virtualUpdater.start === 'function') {
      virtualUpdater.start();
      console.log('✅ Virtual vehicle updater started');
    }

    // 4. Setup hourly background refresh (check for GTFS updates)
    const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
    setInterval(async () => {
      try {
        console.log('[Background] Checking for GTFS updates...');
        // HEAD request to check if updated
        const headRes = await fetch(GTFS_URL, { method: 'HEAD' });
        const lastModified = headRes.headers.get('last-modified');
        
        // Compare with stored lastModified if you add it (for now, always refresh - or add logic)
        await scheduleLoader.loadSchedules(); // Full reload if changed
        console.log('[Background] GTFS refresh complete. New last-modified:', lastModified);
      } catch (err) {
        console.error('[Background] GTFS refresh failed:', err.message);
      }
    }, REFRESH_INTERVAL_MS);

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('🛑 Shutting down...');
      if (virtualUpdater && typeof virtualUpdater.stop === 'function') {
        virtualUpdater.stop();
      }
      process.exit(0);
    });

    console.log('✅ System ready');
  } catch (error) {
    console.error('❌ Startup failed:', error.message, error.stack);
  }
}

// Run startup once
initializeSystem().catch(err => console.error('Startup error:', err));

// Export for Vercel
export default app;
