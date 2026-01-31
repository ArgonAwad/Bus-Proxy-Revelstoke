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

// ==================== HELPER FUNCTIONS ====================

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
// Enhanced vehicle positions with virtual vehicles + parsed blockId
async function getEnhancedVehiclePositions(
  operatorId = DEFAULT_OPERATOR_ID,
  includeVirtual = true,
  virtualMode = 'subs',
  allVirtuals = false
) {
  try {
    console.log(`🚀 Enhancing vehicle positions for operator ${operatorId}, virtual=${includeVirtual}, mode=${virtualMode}, allVirtuals=${allVirtuals}`);
  
    // Load schedule data if not already loaded
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
  
    // Fetch real vehicle positions and trip updates
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
  
    // Add virtual vehicles if requested
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
            allVirtuals  // Pass the flag here!
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

// Load the protobuf schema before handling any requests
await loadProto();

// ==================== ENDPOINTS ====================

app.get('/api/buses', async (req, res) => {
  if (!root) return res.status(500).json({ error: 'Proto not loaded' });
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const noVirtuals = 'no_virtuals' in req.query;
    const allVirtuals = req.query.all_virtuals === 'true';  // NEW
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
      allVirtuals   // NEW: passed here
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
        all_virtuals_mode: allVirtuals,          // NEW: visible in response
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

// Virtual buses endpoint – returns moving virtual positions in GTFS-RT format
app.get('/api/virtuals', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const allVirtuals = req.query.all_virtuals === 'true';
    const startTime = Date.now();

    console.log(`[${new Date().toISOString()}] /api/virtuals called | operator=${operatorId} | all_virtuals=${allVirtuals}`);

    const [vehicleResult, tripResult] = await Promise.all([
      fetchGTFSFeed('vehicleupdates.pb', operatorId),
      fetchGTFSFeed('tripupdates.pb', operatorId)
    ]);

    if (!vehicleResult.success || !tripResult.success) {
      return res.status(503).json({
        error: 'One or more feeds unavailable',
        vehicle_success: vehicleResult.success,
        trip_success: tripResult.success
      });
    }

    // THESE TWO LINES ARE CRITICAL — DO NOT DELETE OR MOVE THEM
    const processedVehicles = addParsedBlockIdToVehicles(vehicleResult.data?.entity || []);
    const processedTrips = addParsedBlockIdToTripUpdates(tripResult.data?.entity || []);

    const expectedBlocks = getExpectedBlockIdsFromTripUpdates(processedTrips);
    const activeRealBlocks = getActiveRealBlockIds(processedVehicles);

    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }

    const blocksToUse = allVirtuals 
      ? expectedBlocks 
      : expectedBlocks.filter(b => !activeRealBlocks.has(b));

    const virtualEntities = [];
    const seenBlocks = new Set();

    processedTrips.forEach(entity => {
      const tu = entity.tripUpdate;
      if (!tu) return;

      const tripId = tu.trip?.tripId;
      const blockId = extractBlockIdFromTripId(tripId);
      if (!blockId || !blocksToUse.includes(blockId) || seenBlocks.has(blockId)) return;

      seenBlocks.add(blockId);

      const virtualEntity = virtualVehicleManager.createVirtualVehicle(
        tu.trip,
        tu.stopTimeUpdate || [],
        scheduleLoader.scheduleData,
        `VIRT-${allVirtuals ? 'ALL-' : ''}${blockId}`,
        allVirtuals ? 'AllScheduled' : 'Substitute'
      );

      if (virtualEntity) {
        virtualVehicleManager.updateVehiclePosition(virtualEntity, scheduleLoader.scheduleData);
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
            timestamp: Math.floor(Date.now() / 1000)
          },
          entity: virtualEntities
        }
      }
    });

    console.log(`Generated ${virtualEntities.length} virtual positions (${allVirtuals ? 'ALL mode' : 'missing only'})`);
  } catch (error) {
    console.error('Error in /api/virtuals:', error);
    res.status(500).json({
      error: 'Failed to generate virtuals',
      details: error.message
    });
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

// ==================== ESSENTIAL DEBUGGING ENDPOINTS ====================

// 1. SHAPE DEBUGGING - Most important for virtual bus movement
app.get('/api/debug/shape-movement', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    
    const scheduleData = scheduleLoader.scheduleData;
    const { trip_id, shape_id } = req.query;
    
    // Get a trip that should have virtual movement
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
    
    // Test virtual vehicle position calculation
    const totalDistance = shapePoints.length;
    const testPositions = [
      0.1,  // 10% along route
      0.25, // 25% along route  
      0.5,  // 50% along route
      0.75, // 75% along route
      0.9   // 90% along route
    ];
    
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

// 2. VIRTUAL BUS DEBUGGING - Check actual virtual bus state
app.get('/api/debug/virtual-state', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    
    // Get current virtual vehicles
    const virtualEntities = virtualVehicleManager.virtualVehicles || {};
    const virtualIds = Object.keys(virtualEntities);
    
    // Check positions of virtual vehicles
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
    
    // Check virtual updater
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

// 3. TRIP-SHAPE MAPPING - Check which trips have shapes
app.get('/api/debug/trip-shapes', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    
    const scheduleData = scheduleLoader.scheduleData;
    const trips = Object.entries(scheduleData.tripsMap || {});
    
    // Analyze trip-shape relationships
    const analysis = {
      total_trips: trips.length,
      trips_with_shapes: trips.filter(([id, trip]) => trip.shape_id).length,
      trips_without_shapes: trips.filter(([id, trip]) => !trip.shape_id).length,
      unique_shapes: new Set(trips.map(([id, trip]) => trip.shape_id).filter(Boolean)).size
    };
    
    // Get sample trips with shapes (for virtual buses)
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
    
    // Get trips without shapes (problematic for virtual buses)
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

// 4. TEST VIRTUAL MOVEMENT - Force update and check
app.get('/api/debug/test-virtual-move', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    
    // Create a test virtual vehicle
    const scheduleData = scheduleLoader.scheduleData;
    const trips = Object.entries(scheduleData.tripsMap || {});
    
    // Find a trip with a shape
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
    
    // Create a test virtual vehicle
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
        progress: 0, // Start at beginning
        lastUpdate: Date.now(),
        speedMultiplier: 1.0
      }
    };
    
    // Store in virtual vehicle manager
    if (!virtualVehicleManager.virtualVehicles) {
      virtualVehicleManager.virtualVehicles = {};
    }
    virtualVehicleManager.virtualVehicles['TEST-VIRTUAL-1'] = testVehicle;
    
    // Update position manually
    if (typeof virtualVehicleManager.updateVehiclePosition === 'function') {
      virtualVehicleManager.updateVehiclePosition(testVehicle, scheduleData);
      
      // Update a few more times to simulate movement
      for (let i = 0; i < 3; i++) {
        testVehicle._metadata.progress += 0.1; // Move 10% each update
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

// 5. SIMPLE HEALTH CHECK
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

// 6. Keep this one shape endpoint (it's useful)
app.get('/api/shapes', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    
    const { shape_id, simplified } = req.query;
    const scheduleData = scheduleLoader.scheduleData;
    
    if (shape_id) {
      // Return specific shape
      const shapePoints = scheduleData.shapes?.[shape_id];
      if (!shapePoints) {
        return res.status(404).json({ error: 'Shape not found', shape_id });
      }
      
      let points = shapePoints;
      if (simplified === 'true') {
        // Simplify shape for display (every 10th point)
        points = shapePoints.filter((_, index) => index % 10 === 0);
      }
      
      // Calculate bounding box
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
        points: points.slice(0, 100) // Limit response
      });
    } else {
      // Return all shapes summary
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

// 7. Keep this schedule verify endpoint (it works)
app.get('/api/debug/schedule-verify', async (req, res) => {
  try {
    // Force reload
    console.log('Loading schedule data...');
    const scheduleData = await scheduleLoader.loadSchedules();
    
    // Check specific stops from your virtual bus example
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
    
    // Get a sample trip
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

// ==================== ROOT ENDPOINT WITH DOCUMENTATION ====================
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

// Initialize virtual vehicle system
async function initializeVirtualSystem() {
  try {
    console.log('🚀 Initializing virtual vehicle system...');
    if (virtualUpdater && typeof virtualUpdater.start === 'function') {
      virtualUpdater.start();
      console.log('✅ Virtual vehicle updater started');
    }
    process.on('SIGTERM', () => {
      console.log('🛑 Shutting down virtual vehicle system...');
      if (virtualUpdater && typeof virtualUpdater.stop === 'function') {
        virtualUpdater.stop();
      }
      process.exit(0);
    });
    console.log('✅ Virtual vehicle system ready');
  } catch (error) {
    console.error('❌ Failed to initialize virtual vehicle system:', error);
  }
}

initializeVirtualSystem().catch(console.error);

// Export for Vercel
export default app;
