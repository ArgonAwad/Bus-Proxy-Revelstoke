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
async function getEnhancedVehiclePositions(operatorId = DEFAULT_OPERATOR_ID, includeVirtual = true, virtualMode = 'subs') {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }

    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);

    let processedVehicles = [];
    let virtualVehicles = [];

    if (vehicleResult.success && vehicleResult.data?.entity) {
      processedVehicles = addParsedBlockIdToVehicles(vehicleResult.data.entity);
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
            realVehicleIds
          );
        }

        virtualVehicleManager.updateVirtualPositions(scheduleLoader.scheduleData);
        virtualVehicleManager.setMode(originalMode);
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
    const startTime = Date.now();

    console.log(`[${new Date().toISOString()}] /api/buses called for operator ${operatorId} | no_virtuals=${noVirtuals}`);

    const [vehicleResult, tripResult, alertsResult] = await Promise.all([
      fetchGTFSFeed('vehicleupdates.pb', operatorId),
      fetchGTFSFeed('tripupdates.pb', operatorId),
      fetchGTFSFeed('alerts.pb', operatorId)
    ]);

    const enhancedVehicleResult = await getEnhancedVehiclePositions(operatorId, !noVirtuals, 'subs');

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
    const startTime = Date.now();

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

    const processedVehicles = addParsedBlockIdToVehicles(vehicleResult.data?.entity || []);
    const processedTrips = addParsedBlockIdToTripUpdates(tripResult.data?.entity || []);

    const expectedBlocks = getExpectedBlockIdsFromTripUpdates(processedTrips);
    const activeRealBlocks = getActiveRealBlockIds(processedVehicles);

    // Load schedule if needed
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }

    // For now use all missing blocks
    // (uncomment the next lines once you implement isBlockActive in schedule-loader.js)
    // const currentDate = DateTime.now().setZone('America/Vancouver').toFormat('yyyyMMdd');
    // const missingBlocks = expectedBlocks.filter(b => 
    //   !activeRealBlocks.has(b) && scheduleLoader.isBlockActive(b, currentDate)
    // );

    const missingBlocks = expectedBlocks.filter(b => !activeRealBlocks.has(b));

    const virtualEntities = [];
    const seenBlocks = new Set();

    processedTrips.forEach(entity => {
      const tu = entity.tripUpdate;
      if (!tu) return;

      const tripId = tu.trip?.tripId;
      const blockId = extractBlockIdFromTripId(tripId);
      if (!blockId || !missingBlocks.includes(blockId) || seenBlocks.has(blockId)) return;

      seenBlocks.add(blockId);

      const virtualEntity = virtualVehicleManager.createVirtualVehicle(
        tu.trip,
        tu.stopTimeUpdate || [],
        scheduleLoader.scheduleData,
        `VIRT-${blockId}`,
        'Substitute'
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
        missing_blocks_found: missingBlocks.length,
        virtual_entities_generated: virtualEntities.length
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

    console.log(`Generated ${virtualEntities.length} virtual vehicle positions`);
  } catch (error) {
    console.error('Error in /api/virtuals:', error);
    res.status(500).json({
      error: 'Failed to generate virtual positions',
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

// ==================== TESTING ENDPOINTS ====================
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
