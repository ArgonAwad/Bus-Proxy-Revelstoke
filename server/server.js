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

    // Convert to object
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

// Fix vehicle structure to match what tracker expects
function fixVehicleStructure(vehicleEntity) {
  if (!vehicleEntity.vehicle) return vehicleEntity;
  
  const vehicleData = vehicleEntity.vehicle;
  
  // Check if we have the nested vehicle structure
  if (vehicleData.vehicle && vehicleData.trip) {
    // This is the new structure, convert it to the old one
    return {
      ...vehicleEntity,
      vehicle: {
        trip: vehicleData.trip,
        vehicle: vehicleData.vehicle,
        position: vehicleData.position || null,
        timestamp: vehicleData.timestamp || null,
        congestionLevel: vehicleData.congestionLevel || null,
        occupancyStatus: vehicleData.occupancyStatus || null,
        occupancyPercentage: vehicleData.occupancyPercentage || null,
        currentStopSequence: vehicleData.currentStopSequence || null,
        currentStatus: vehicleData.currentStatus || null,
        stopId: vehicleData.stopId || null
      }
    };
  }
  
  // Already in correct structure
  return vehicleEntity;
}

// Helper to add blockId to vehicle entities from schedule data
function addBlockIdToVehicles(vehicleEntities, scheduleData) {
  if (!vehicleEntities || !scheduleData?.trips) return vehicleEntities;

  return vehicleEntities.map(entity => {
    // Fix the vehicle structure first
    const fixedEntity = fixVehicleStructure(entity);
    
    // Create a copy to avoid mutation
    const enrichedEntity = JSON.parse(JSON.stringify(fixedEntity));

    // Skip if already has blockId
    if (enrichedEntity.vehicle?.trip?.blockId) {
      return enrichedEntity;
    }

    // Try to get block_id from schedule data
    if (enrichedEntity.vehicle?.trip?.tripId) {
      const tripId = enrichedEntity.vehicle.trip.tripId;
      const scheduledTrip = scheduleData.trips.find(t => t.trip_id === tripId);

      if (scheduledTrip?.block_id) {
        enrichedEntity.vehicle.trip.blockId = scheduledTrip.block_id;
      }
    }

    return enrichedEntity;
  });
}

// Helper to add blockId to trip update entities from schedule data
function addBlockIdToTripUpdates(tripUpdateEntities, scheduleData) {
  if (!tripUpdateEntities || !scheduleData?.trips) return tripUpdateEntities;

  return tripUpdateEntities.map(entity => {
    // Create a copy to avoid mutation
    const enrichedEntity = JSON.parse(JSON.stringify(entity));

    // Skip if already has blockId
    if (enrichedEntity.tripUpdate?.trip?.blockId) {
      return enrichedEntity;
    }

    // Try to get block_id from schedule data
    if (enrichedEntity.tripUpdate?.trip?.tripId) {
      const tripId = enrichedEntity.tripUpdate.trip.tripId;
      const scheduledTrip = scheduleData.trips.find(t => t.trip_id === tripId);

      if (scheduledTrip?.block_id) {
        enrichedEntity.tripUpdate.trip.blockId = scheduledTrip.block_id;
      }
    }

    return enrichedEntity;
  });
}

// Count entities with blockId
function countEntitiesWithBlockId(entities, entityType = 'vehicle') {
  if (!entities) return 0;

  return entities.filter(entity => {
    if (entityType === 'vehicle') {
      return !!entity.vehicle?.trip?.blockId;
    } else if (entityType === 'tripUpdate') {
      return !!entity.tripUpdate?.trip?.blockId;
    }
    return false;
  }).length;
}

// Enhanced vehicle positions with virtual vehicles and blockId
async function getEnhancedVehiclePositions(operatorId = DEFAULT_OPERATOR_ID, includeVirtual = true, virtualMode = 'subs') {
  try {
    console.log(`🚀 Enhancing vehicle positions for operator ${operatorId}, virtual=${includeVirtual}, mode=${virtualMode}`);

    // Load schedule data for blockId enrichment
    await scheduleLoader.loadSchedules(operatorId);

    // Fetch real vehicle positions
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);

    console.log(`📊 Raw vehicles from API: ${vehicleResult.data?.entity?.length || 0}`);
    console.log(`📊 Trip updates: ${tripResult.data?.entity?.length || 0}`);

    // Start with enriched real vehicles
    let enrichedVehicles = [];
    let virtualVehicles = [];

    if (vehicleResult.success && vehicleResult.data?.entity) {
      // Fix structure and enrich real vehicles with blockId
      enrichedVehicles = addBlockIdToVehicles(vehicleResult.data.entity, scheduleLoader.scheduleData);
      console.log(`🔄 Fixed structure for ${enrichedVehicles.length} vehicles`);
    }

    // Add virtual vehicles if requested
    if (includeVirtual && tripResult.success) {
      const originalMode = virtualVehicleManager.currentMode;
      virtualVehicleManager.setMode(virtualMode);

      // Get IDs of real vehicles
      const realVehicleIds = new Set();
      enrichedVehicles.forEach(v => {
        if (v.vehicle?.vehicle?.id) realVehicleIds.add(v.vehicle.vehicle.id);
      });

      // Generate virtuals based on mode
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

      // Update positions
      virtualVehicleManager.updateVirtualPositions();
      virtualVehicleManager.setMode(originalMode);

      console.log(`👻 Virtual vehicles: ${virtualVehicles.length}`);
    }

    // Combine real and virtual
    const allEntities = [...enrichedVehicles, ...virtualVehicles];

    // Count blockId coverage
    const vehiclesWithBlockId = countEntitiesWithBlockId(allEntities, 'vehicle');

    return {
      ...vehicleResult,
      data: {
        ...vehicleResult.data,
        entity: allEntities,
        metadata: {
          ...vehicleResult.data.metadata,
          total_vehicles: allEntities.length,
          virtual_vehicles: virtualVehicles.length,
          real_vehicles: enrichedVehicles.length,
          block_id_enriched: vehiclesWithBlockId,
          block_id_coverage: allEntities.length > 0 ?
            `${Math.round((vehiclesWithBlockId / allEntities.length) * 100)}%` : '0%'
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

// Main /api/buses endpoint - ALWAYS includes blockId
app.get('/api/buses', async (req, res) => {
  if (!root) return res.status(500).json({ error: 'Proto not loaded' });

  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const startTime = Date.now();

    console.log(`[${new Date().toISOString()}] /api/buses called for operator ${operatorId}`);

    // Fetch all three feeds in parallel
    const [vehicleResult, tripResult, alertsResult] = await Promise.all([
      fetchGTFSFeed('vehicleupdates.pb', operatorId),
      fetchGTFSFeed('tripupdates.pb', operatorId),
      fetchGTFSFeed('alerts.pb', operatorId)
    ]);

    // Always load schedule for blockId enrichment
    await scheduleLoader.loadSchedules(operatorId);

    // Process vehicle positions (with virtual vehicles and blockId)
    const enhancedVehicleResult = await getEnhancedVehiclePositions(operatorId, true, 'subs');

    // Process trip updates (with blockId)
    let enhancedTripResult = tripResult;
    if (tripResult.success && tripResult.data?.entity) {
      const enrichedTripUpdates = addBlockIdToTripUpdates(
        tripResult.data.entity,
        scheduleLoader.scheduleData
      );

      enhancedTripResult = {
        ...tripResult,
        data: {
          ...tripResult.data,
          entity: enrichedTripUpdates
        }
      };
    }

    // Prepare response - SIMPLIFIED STRUCTURE
    const responseTime = Date.now() - startTime;
    const vehiclesWithBlockId = countEntitiesWithBlockId(enhancedVehicleResult.data?.entity, 'vehicle');
    const tripUpdatesWithBlockId = countEntitiesWithBlockId(enhancedTripResult.data?.entity, 'tripUpdate');

    // DEBUG: Check vehicle structure
    if (enhancedVehicleResult.data?.entity?.length > 0) {
      const sampleVehicle = enhancedVehicleResult.data.entity[0];
      console.log('DEBUG Vehicle structure:', {
        hasVehicle: !!sampleVehicle.vehicle,
        hasNestedVehicle: !!sampleVehicle.vehicle?.vehicle,
        hasTrip: !!sampleVehicle.vehicle?.trip,
        hasPosition: !!sampleVehicle.vehicle?.position,
        structure: Object.keys(sampleVehicle.vehicle || {})
      });
    }

    const response = {
      metadata: {
        operatorId,
        location: operatorId === '36' ? 'Revelstoke' :
          operatorId === '47' ? 'Kelowna' :
            operatorId === '48' ? 'Victoria' : `Operator ${operatorId}`,
        fetchedAt: new Date().toISOString(),
        responseTimeMs: responseTime,
        feeds: {
          vehicle_positions: {
            success: enhancedVehicleResult.success,
            entities: enhancedVehicleResult.success ? enhancedVehicleResult.data.entity?.length || 0 : 0,
            virtual_vehicles: enhancedVehicleResult.data?.metadata?.virtual_vehicles || 0,
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
          vehicles_enriched: vehiclesWithBlockId,
          trip_updates_enriched: tripUpdatesWithBlockId,
          vehicle_coverage: enhancedVehicleResult.data?.entity?.length > 0 ?
            `${Math.round((vehiclesWithBlockId / enhancedVehicleResult.data.entity.length) * 100)}%` : '0%',
          schedule_loaded: !!scheduleLoader.scheduleData,
          schedule_trips_count: scheduleLoader.scheduleData?.trips?.length || 0
        }
      },
      data: {
        vehicle_positions: enhancedVehicleResult.success ? enhancedVehicleResult.data : null,
        trip_updates: enhancedTripResult.success ? enhancedTripResult.data : null,
        service_alerts: alertsResult.success ? alertsResult.data : null
      }
    };

    // Add any errors
    const errors = [];
    if (!enhancedVehicleResult.success) errors.push(`Vehicle positions: ${enhancedVehicleResult.error}`);
    if (!tripResult.success) errors.push(`Trip updates: ${tripResult.error}`);
    if (!alertsResult.success) errors.push(`Service alerts: ${alertsResult.error}`);

    if (errors.length > 0) {
      response.metadata.errors = errors;
    }

    console.log(`[${new Date().toISOString()}] /api/buses completed in ${responseTime}ms`);
    console.log(`   Vehicles: ${enhancedVehicleResult.data?.entity?.length || 0}, with blockId: ${vehiclesWithBlockId}`);

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

// Vehicle positions endpoint
app.get('/api/vehicle_positions', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const includeVirtual = req.query.virtual !== 'false';
    const virtualMode = req.query.virtual_mode || 'subs';

    console.log(`Vehicle positions: operator=${operatorId}, virtual=${includeVirtual}, mode=${virtualMode}`);

    const enhancedVehicleResult = await getEnhancedVehiclePositions(operatorId, includeVirtual, virtualMode);

    res.json({
      metadata: {
        operatorId,
        fetchedAt: new Date().toISOString(),
        block_id_enabled: true,
        block_id_enriched: enhancedVehicleResult.data?.metadata?.block_id_enriched || 0,
        virtual_vehicles: enhancedVehicleResult.data?.metadata?.virtual_vehicles || 0,
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

// Trip updates endpoint
app.get('/api/trip_updates', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const result = await fetchGTFSFeed('tripupdates.pb', operatorId);

    // Load schedule for blockId
    await scheduleLoader.loadSchedules(operatorId);

    let enrichedData = result.data;
    if (result.success && result.data?.entity) {
      enrichedData = {
        ...result.data,
        entity: addBlockIdToTripUpdates(result.data.entity, scheduleLoader.scheduleData)
      };
    }

    if (result.success) {
      res.json({
        metadata: {
          feedType: 'trip_updates',
          operatorId,
          fetchedAt: result.timestamp,
          block_id_enabled: true,
          url: result.url,
          entities: result.data.entity?.length || 0
        },
        data: enrichedData
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

// Service alerts endpoint
app.get('/api/service_alerts', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const result = await fetchGTFSFeed('alerts.pb', operatorId);

    if (result.success) {
      res.json({
        metadata: {
          feedType: 'service_alerts',
          operatorId,
          fetchedAt: result.timestamp,
          url: result.url,
          entities: result.data.entity?.length || 0
        },
        data: result.data
      });
    } else {
      res.status(500).json({
        error: 'Failed to fetch service alerts',
        details: result.error,
        url: result.url,
        timestamp: result.timestamp
      });
    }
  } catch (error) {
    console.error('Error in /api/service_alerts:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// ==================== TESTING ENDPOINTS ====================

// Test endpoint to check vehicle structure
app.get('/api/test_vehicle_structure', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);

    if (!vehicleResult.success || !vehicleResult.data?.entity) {
      return res.json({ error: 'No vehicle data' });
    }

    const sampleVehicle = vehicleResult.data.entity[0];
    const fixedVehicle = fixVehicleStructure(sampleVehicle);

    res.json({
      original_structure: {
        keys: Object.keys(sampleVehicle),
        vehicle_keys: sampleVehicle.vehicle ? Object.keys(sampleVehicle.vehicle) : 'No vehicle',
        has_nested_vehicle: !!sampleVehicle.vehicle?.vehicle,
        nested_vehicle_keys: sampleVehicle.vehicle?.vehicle ? Object.keys(sampleVehicle.vehicle.vehicle) : 'No nested vehicle'
      },
      fixed_structure: {
        keys: Object.keys(fixedVehicle),
        vehicle_keys: fixedVehicle.vehicle ? Object.keys(fixedVehicle.vehicle) : 'No vehicle',
        has_nested_vehicle: !!fixedVehicle.vehicle?.vehicle,
        vehicle_structure_sample: {
          has_trip: !!fixedVehicle.vehicle?.trip,
          has_vehicle: !!fixedVehicle.vehicle?.vehicle,
          has_position: !!fixedVehicle.vehicle?.position,
          trip_id: fixedVehicle.vehicle?.trip?.tripId,
          vehicle_id: fixedVehicle.vehicle?.vehicle?.id
        }
      },
      explanation: fixedVehicle.vehicle?.vehicle ? 
        "✓ Fixed structure: vehicle.vehicle is now at the correct level" :
        "✗ Still has nested vehicle structure"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint for block_id enrichment
app.get('/api/test_block_id', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;

    console.log(`Testing block_id enrichment for operator ${operatorId}`);

    // Fetch real vehicles
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);

    if (!vehicleResult.success) {
      return res.status(500).json({
        error: 'Failed to fetch vehicles',
        details: vehicleResult.error
      });
    }

    // Load schedule
    await scheduleLoader.loadSchedules(operatorId);

    // Analyze vehicles
    const vehicles = vehicleResult.data?.entity || [];
    const fixedVehicles = vehicles.map(v => fixVehicleStructure(v));
    const enrichedVehicles = addBlockIdToVehicles(fixedVehicles, scheduleLoader.scheduleData);

    // Sample some vehicles
    const sampleVehicles = enrichedVehicles.slice(0, 3).map(v => ({
      id: v.vehicle?.vehicle?.id,
      trip_id: v.vehicle?.trip?.tripId,
      route_id: v.vehicle?.trip?.routeId,
      block_id: v.vehicle?.trip?.blockId || 'NONE',
      has_block_id: !!v.vehicle?.trip?.blockId,
      structure: {
        has_vehicle_at_root: !!v.vehicle?.vehicle,
        has_trip: !!v.vehicle?.trip,
        has_position: !!v.vehicle?.position
      }
    }));

    res.json({
      test: 'block_id_enrichment',
      operatorId,
      schedule_loaded: !!scheduleLoader.scheduleData,
      schedule_trips_count: scheduleLoader.scheduleData?.trips?.length || 0,
      vehicle_stats: {
        total_vehicles: vehicles.length,
        with_block_id: countEntitiesWithBlockId(enrichedVehicles, 'vehicle')
      },
      sample_vehicles: sampleVehicles,
      schedule_sample: scheduleLoader.scheduleData?.trips?.slice(0, 3).map(t => ({
        trip_id: t.trip_id,
        block_id: t.block_id || 'NONE',
        route_id: t.route_id
      })) || []
    });

  } catch (error) {
    console.error('Error in /api/test_block_id:', error);
    res.status(500).json({
      error: 'Test failed',
      details: error.message
    });
  }
});

// ==================== EXISTING ENDPOINTS (minimal changes) ====================

// Debug endpoint for virtual vehicles
app.get('/api/debug_virtual', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;

    // Load schedule
    await scheduleLoader.loadSchedules(operatorId);

    // Get trip updates
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);

    const tripsWithoutVehicles = [];
    tripResult.data?.entity?.forEach((trip, index) => {
      if (trip.tripUpdate && !trip.tripUpdate.vehicle?.id) {
        tripsWithoutVehicles.push({
          index,
          tripId: trip.tripUpdate.trip?.tripId,
          routeId: trip.tripUpdate.trip?.routeId,
          stopCount: trip.tripUpdate.stopTimeUpdate?.length || 0,
          startTime: trip.tripUpdate.trip?.startTime,
          vehiclePresent: !!trip.tripUpdate.vehicle?.id
        });
      }
    });

    res.json({
      totalTrips: tripResult.data?.entity?.length || 0,
      tripsWithoutVehicles: tripsWithoutVehicles.length,
      trips: tripsWithoutVehicles,
      virtualVehiclesCreated: virtualVehicleManager.getVirtualVehicleCount(),
      activeVirtualVehicles: virtualVehicleManager.getAllVirtualVehicles().map(v => ({
        tripId: v.vehicle?.trip?.tripId,
        routeId: v.vehicle?.trip?.routeId,
        blockId: v.vehicle?.trip?.blockId || 'NONE',
        position: v.vehicle?.position
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const result = await fetchGTFSFeed('vehicleupdates.pb', DEFAULT_OPERATOR_ID);
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      feedsAvailable: result.success,
      protoLoaded: root !== null,
      defaultOperator: DEFAULT_OPERATOR_ID,
      virtualSystem: 'active',
      blockIdSupported: true
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Root endpoint with HTML interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>🚌 BC Transit GTFS-RT Proxy</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; line-height: 1.6; }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        h2 { color: #34495e; margin-top: 30px; }
        .endpoint { background: #f8f9fa; padding: 15px; margin: 10px 0; border-left: 4px solid #3498db; border-radius: 4px; }
        code { background: #e8f4f8; padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', monospace; }
        a { color: #2980b9; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .note { background: #fffacd; padding: 10px; border-radius: 5px; border-left: 3px solid #ffd700; }
      </style>
    </head>
    <body>
      <h1>🚌 BC Transit GTFS-RT Proxy</h1>
      <p>Real-time bus data for BC Transit systems</p>
     
      <div class="note">
        <strong>⚠️ IMPORTANT:</strong> Vehicle structure has been fixed to match tracker expectations.
      </div>

      <h2>📡 Main Endpoints</h2>

      <div class="endpoint">
        <strong>GET <code>/api/buses</code></strong>
        <p>All feeds combined with virtual vehicles and blockId</p>
        <p>Default: Revelstoke (36)</p>
        <p><a href="/api/buses" target="_blank">Try it</a> | 
           <a href="/api/buses?operatorId=47" target="_blank">Kelowna</a> | 
           <a href="/api/buses?operatorId=48" target="_blank">Victoria</a>
        </p>
      </div>

      <div class="endpoint">
        <strong>GET <code>/api/vehicle_positions</code></strong>
        <p>Vehicle positions only</p>
        <p><a href="/api/vehicle_positions" target="_blank">Try it</a></p>
      </div>

      <div class="endpoint">
        <strong>GET <code>/api/trip_updates</code></strong>
        <p>Trip predictions and schedule updates</p>
        <p><a href="/api/trip_updates" target="_blank">Try it</a></p>
      </div>

      <h2>🔧 Testing Endpoints</h2>
      <ul>
        <li><a href="/api/test_vehicle_structure" target="_blank">/api/test_vehicle_structure</a> - Check vehicle structure fix</li>
        <li><a href="/api/test_block_id" target="_blank">/api/test_block_id</a> - Test blockId enrichment</li>
        <li><a href="/api/debug_virtual" target="_blank">/api/debug_virtual</a> - Debug virtual vehicles</li>
        <li><a href="/api/health" target="_blank">/api/health</a> - Server health check</li>
      </ul>

      <p style="margin-top: 40px; text-align: center; color: #777;">
        Vehicle Structure Fixed • BlockId Supported • <a href="/api/health">Health Check</a>
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

// Call initialization
initializeVirtualSystem().catch(console.error);

// Export for Vercel
export default app;
