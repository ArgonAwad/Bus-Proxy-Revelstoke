import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import protobuf from 'protobufjs';
import virtualVehicleManager from './virtual-vehicles.js';
import virtualUpdater from './virtual-updater.js';
import ScheduleLoader from './schedule-loader.js';

const scheduleLoader = new ScheduleLoader();
export { scheduleLoader };
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

// CORRECTED: Fix vehicle structure to match what tracker expects
function fixVehicleStructure(vehicleEntity) {
  if (!vehicleEntity.vehicle) return vehicleEntity;
  
  const vehicleData = vehicleEntity.vehicle;
  
  // DEBUG: Log the structure
  console.log('DEBUG fixVehicleStructure:', {
    hasVehicle: !!vehicleData,
    hasNestedVehicle: !!vehicleData.vehicle,
    vehicleKeys: Object.keys(vehicleData),
    nestedVehicleKeys: vehicleData.vehicle ? Object.keys(vehicleData.vehicle) : 'none'
  });
  
  // Check if we have the problematic nested structure
  // Current structure: vehicle.vehicle is nested inside vehicle object
  // Desired structure: vehicle.vehicle should be at the same level as vehicle.trip, vehicle.position
  if (vehicleData.vehicle && typeof vehicleData.vehicle === 'object') {
    // Extract the nested vehicle info
    const nestedVehicle = vehicleData.vehicle;
    
    // Create new structure matching what tracker expects
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
      // Copy other fields that might be needed
      multiCarriageDetails: vehicleData.multiCarriageDetails || []
    };
    
    // Return the fixed entity
    return {
      ...vehicleEntity,
      vehicle: fixedVehicle
    };
  }
  
  // Already in correct structure (virtual vehicles usually are)
  return vehicleEntity;
}

// Helper to add blockId to vehicle entities from schedule data
function addBlockIdToVehicles(vehicleEntities, scheduleData) {
  if (!Array.isArray(vehicleEntities) || !scheduleData) {
    console.warn('addBlockIdToVehicles: Invalid input (no entities or scheduleData)');
    return vehicleEntities || [];
  }

  const tripsMap = scheduleData.tripsMap;   // preferred fast lookup
  const tripsArray = scheduleData.trips;    // fallback slow lookup

  if (!tripsMap && !Array.isArray(tripsArray)) {
    console.warn('addBlockIdToVehicles: No tripsMap or trips array in scheduleData');
    return vehicleEntities;
  }

  return vehicleEntities.map((entity) => {
    // Fix structure first (your existing helper)
    const fixedEntity = fixVehicleStructure(entity);

    // Defensive deep copy to prevent mutation of protobuf objects
    const enrichedEntity = JSON.parse(JSON.stringify(fixedEntity));

    // Already has blockId - skip
    if (enrichedEntity.vehicle?.trip?.blockId) {
      return enrichedEntity;
    }

    const tripId = enrichedEntity.vehicle?.trip?.tripId;
    if (!tripId) {
      return enrichedEntity; // No trip - nothing to enrich
    }

    let scheduledTrip = null;

    // Preferred: use map lookup
    if (tripsMap && typeof tripsMap === 'object') {
      scheduledTrip = tripsMap[tripId];
    } 
    // Fallback: linear search on array (slower, but works)
    else if (Array.isArray(tripsArray)) {
      scheduledTrip = tripsArray.find(t => t.trip_id === tripId);
    }

    if (scheduledTrip?.block_id) {
      // Ensure trip object exists
      if (!enrichedEntity.vehicle.trip) {
        enrichedEntity.vehicle.trip = {};
      }
      enrichedEntity.vehicle.trip.blockId = scheduledTrip.block_id;
      // Optional: also add route_id / other fields if useful later
      // enrichedEntity.vehicle.trip.routeId = scheduledTrip.route_id;
    } else {
      // Debug why it failed
      if (!scheduledTrip) {
        console.debug(`BlockId skip: trip_id ${tripId} not found in schedule`);
      } else {
        console.debug(`BlockId skip: trip_id ${tripId} has no block_id`);
      }
    }

    return enrichedEntity;
  });
}

// Helper to add blockId to trip update entities from schedule data
function addBlockIdToTripUpdates(tripUpdateEntities, scheduleData) {
  if (!Array.isArray(tripUpdateEntities) || !scheduleData) {
    console.warn('addBlockIdToTripUpdates: Invalid input (no entities or scheduleData)');
    return tripUpdateEntities || [];
  }

  const tripsMap = scheduleData.tripsMap;   // preferred
  const tripsArray = scheduleData.trips;    // fallback

  if (!tripsMap && !Array.isArray(tripsArray)) {
    console.warn('addBlockIdToTripUpdates: No tripsMap or trips array in scheduleData');
    return tripUpdateEntities;
  }

  return tripUpdateEntities.map((entity) => {
    // Defensive deep copy
    const enrichedEntity = JSON.parse(JSON.stringify(entity));

    // Already enriched → skip
    if (enrichedEntity.tripUpdate?.trip?.blockId) {
      return enrichedEntity;
    }

    const tripId = enrichedEntity.tripUpdate?.trip?.tripId;
    if (!tripId) {
      return enrichedEntity;
    }

    let scheduledTrip = null;

    if (tripsMap && typeof tripsMap === 'object') {
      scheduledTrip = tripsMap[tripId];
    } else if (Array.isArray(tripsArray)) {
      scheduledTrip = tripsArray.find(t => t.trip_id === tripId);
    }

    if (scheduledTrip?.block_id) {
      if (!enrichedEntity.tripUpdate.trip) {
        enrichedEntity.tripUpdate.trip = {};
      }
      enrichedEntity.tripUpdate.trip.blockId = scheduledTrip.block_id;
    } else {
      if (!scheduledTrip) {
        console.debug(`BlockId skip (trip update): trip_id ${tripId} not found`);
      } else {
        console.debug(`BlockId skip (trip update): trip_id ${tripId} no block_id`);
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
      // Log first vehicle structure before fixing
      if (vehicleResult.data.entity.length > 0) {
        const firstVehicle = vehicleResult.data.entity[0];
        console.log('BEFORE FIX - First vehicle structure:', {
          hasVehicle: !!firstVehicle.vehicle,
          hasNestedVehicle: !!firstVehicle.vehicle?.vehicle,
          vehicleKeys: firstVehicle.vehicle ? Object.keys(firstVehicle.vehicle) : 'none'
        });
      }
      
      // Fix structure and enrich real vehicles with blockId
      enrichedVehicles = addBlockIdToVehicles(vehicleResult.data.entity, scheduleLoader.scheduleData);
      
      // Log first vehicle structure after fixing
      if (enrichedVehicles.length > 0) {
        const firstFixedVehicle = enrichedVehicles[0];
        console.log('AFTER FIX - First vehicle structure:', {
          hasVehicle: !!firstFixedVehicle.vehicle,
          hasVehicleVehicle: !!firstFixedVehicle.vehicle?.vehicle,
          vehicleKeys: firstFixedVehicle.vehicle ? Object.keys(firstFixedVehicle.vehicle) : 'none'
        });
      }
      
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

// ==================== TESTING ENDPOINTS ====================

// Simple test endpoint to check the actual vehicle structure
app.get('/api/test_structure', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);

    if (!vehicleResult.success || !vehicleResult.data?.entity) {
      return res.json({ error: 'No vehicle data' });
    }

    const sampleVehicle = vehicleResult.data.entity[0];
    const fixedVehicle = fixVehicleStructure(sampleVehicle);
    
    // Sample what a vehicle should look like for the tracker
    const expectedStructure = {
      vehicle: {
        trip: {
          tripId: "SOME_TRIP_ID",
          routeId: "SOME_ROUTE",
          // blockId: "SOME_BLOCK" // This is what we want to add
        },
        vehicle: {  // This should be at this level, not nested inside another vehicle object
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

// Quick test to see if vehicles will show in tracker
app.get('/api/test_tracker_compatibility', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);

    if (!vehicleResult.success || !vehicleResult.data?.entity) {
      return res.json({ error: 'No vehicle data' });
    }

    const sampleVehicle = vehicleResult.data.entity[0];
    const fixedVehicle = fixVehicleStructure(sampleVehicle);
    
    // Check if structure matches what tracker needs
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

// ==================== EXISTING ENDPOINTS (simplified) ====================

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

    if (result.success) {
      res.json({
        metadata: {
          feedType: 'trip_updates',
          operatorId,
          fetchedAt: result.timestamp,
          url: result.url,
          entities: result.data.entity?.length || 0
        },
        data: result.data
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

// Root endpoint with HTML
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
        .note { background: #fffacd; padding: 10px; border-radius: 5px; border-left: 3px solid #ffd700; }
      </style>
    </head>
    <body>
      <h1>🚌 BC Transit GTFS-RT Proxy</h1>
      <p>Real-time bus data for BC Transit systems</p>
     
      <div class="note">
        <strong>🔄 Vehicle Structure Fix Applied</strong> - Vehicles should now appear in tracker
      </div>

      <h2>📡 Main Endpoints</h2>

      <div class="endpoint">
        <strong>GET <code>/api/buses</code></strong>
        <p>All feeds combined with virtual vehicles</p>
        <p>Default: Revelstoke (36)</p>
        <p><a href="/api/buses" target="_blank">Try it</a></p>
      </div>

      <h2>🔧 Testing Endpoints</h2>
      <ul>
        <li><a href="/api/test_structure" target="_blank">/api/test_structure</a> - Check vehicle structure</li>
        <li><a href="/api/test_tracker_compatibility" target="_blank">/api/test_tracker_compatibility</a> - Test tracker compatibility</li>
        <li><a href="/api/vehicle_positions" target="_blank">/api/vehicle_positions</a> - Vehicle positions only</li>
      </ul>
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
