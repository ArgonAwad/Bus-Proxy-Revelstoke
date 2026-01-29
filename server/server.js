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

    // Convert to object, preserving blockId if it exists
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

// Helper to add blockId to vehicle entities from schedule data
function addBlockIdToVehicles(vehicleEntities, scheduleData) {
  if (!vehicleEntities || !scheduleData?.trips) return vehicleEntities;

  return vehicleEntities.map(entity => {
    // Create a copy to avoid mutation
    const enrichedEntity = JSON.parse(JSON.stringify(entity));

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

    console.log(`📊 Real vehicles: ${vehicleResult.data?.entity?.length || 0}`);
    console.log(`📊 Trip updates: ${tripResult.data?.entity?.length || 0}`);

    // Start with enriched real vehicles
    let enrichedVehicles = [];
    let virtualVehicles = [];

    if (vehicleResult.success && vehicleResult.data?.entity) {
      // Enrich real vehicles with blockId
      enrichedVehicles = addBlockIdToVehicles(vehicleResult.data.entity, scheduleLoader.scheduleData);
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

    // Prepare response
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
        block_id: {
          enabled: true,
          vehicles_enriched: vehiclesWithBlockId,
          trip_updates_enriched: tripUpdatesWithBlockId,
          total_vehicles: enhancedVehicleResult.data?.entity?.length || 0,
          total_trip_updates: enhancedTripResult.data?.entity?.length || 0,
          vehicle_coverage: enhancedVehicleResult.data?.entity?.length > 0 ?
            `${Math.round((vehiclesWithBlockId / enhancedVehicleResult.data.entity.length) * 100)}%` : '0%',
          schedule_loaded: !!scheduleLoader.scheduleData,
          schedule_trips_count: scheduleLoader.scheduleData?.trips?.length || 0
        },
        feeds: {
          vehicle_positions: {
            success: enhancedVehicleResult.success,
            entities: enhancedVehicleResult.success ? enhancedVehicleResult.data.entity?.length || 0 : 0,
            virtual_vehicles: enhancedVehicleResult.data?.metadata?.virtual_vehicles || 0,
            block_id_enriched: vehiclesWithBlockId,
            url: enhancedVehicleResult.url
          },
          trip_updates: {
            success: tripResult.success,
            entities: tripResult.success ? enhancedTripResult.data.entity?.length || 0 : 0,
            block_id_enriched: tripUpdatesWithBlockId,
            url: tripResult.url
          },
          service_alerts: {
            success: alertsResult.success,
            entities: alertsResult.success ? alertsResult.data.entity?.length || 0 : 0,
            url: alertsResult.url
          }
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

// ==================== VIRTUAL VEHICLE ENDPOINTS ====================

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

// Cleanup endpoint
app.get('/api/cleanup_virtual', (req, res) => {
  const removed = virtualVehicleManager.cleanupOldVehicles();
  res.json({
    status: 'cleaned',
    removed_count: removed,
    remaining_virtual: virtualVehicleManager.getVirtualVehicleCount(),
    timestamp: new Date().toISOString()
  });
});

// Virtual vehicles info
app.get('/api/virtual_info', (req, res) => {
  const virtualVehicles = virtualVehicleManager.getAllVirtualVehicles();

  res.json({
    virtual_vehicles_count: virtualVehicles.length,
    virtual_vehicles: virtualVehicles.map(v => ({
      id: v.id,
      trip_id: v.vehicle?.trip?.tripId,
      route_id: v.vehicle?.trip?.routeId,
      block_id: v.vehicle?.trip?.blockId || 'NONE',
      label: v.vehicle?.vehicle?.label,
      position: v.vehicle?.position,
      last_updated: new Date(v.lastUpdated).toISOString()
    })),
    timestamp: new Date().toISOString()
  });
});

// ==================== BLOCK ID TESTING ====================

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
    const enrichedVehicles = addBlockIdToVehicles(vehicles, scheduleLoader.scheduleData);

    // Sample some vehicles
    const sampleVehicles = enrichedVehicles.slice(0, 5).map(v => ({
      id: v.vehicle?.vehicle?.id,
      trip_id: v.vehicle?.trip?.tripId,
      route_id: v.vehicle?.trip?.routeId,
      block_id: v.vehicle?.trip?.blockId || 'NONE',
      has_block_id: !!v.vehicle?.trip?.blockId
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

// Verify blockId is actually in the feed
app.get('/api/verify_blockid_in_feed', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;

    // Get a fresh response
    const enhancedResult = await getEnhancedVehiclePositions(operatorId, true, 'subs');

    const vehicles = enhancedResult.data?.entity || [];
    const vehiclesWithBlockId = vehicles.filter(v => v.vehicle?.trip?.blockId);

    const sampleVehicles = vehicles.slice(0, 3).map(v => ({
      id: v.vehicle?.vehicle?.id,
      trip_id: v.vehicle?.trip?.tripId,
      route_id: v.vehicle?.trip?.routeId,
      block_id: v.vehicle?.trip?.blockId || 'MISSING',
      has_block_id: !!v.vehicle?.trip?.blockId,
      is_virtual: v.vehicle?.vehicle?.is_virtual || false
    }));

    res.json({
      verification: 'block_id_in_feed_check',
      operatorId,
      total_vehicles: vehicles.length,
      vehicles_with_block_id: vehiclesWithBlockId.length,
      coverage_percentage: vehicles.length > 0 ?
        `${Math.round((vehiclesWithBlockId.length / vehicles.length) * 100)}%` : '0%',
      sample_vehicles: sampleVehicles,
      metadata_block_id_info: enhancedResult.data?.metadata,
      success: vehiclesWithBlockId.length > 0
    });

  } catch (error) {
    res.status(500).json({
      error: 'Verification failed',
      details: error.message
    });
  }
});

// ==================== VIRTUAL-ONLY ENDPOINTS ====================

// All virtual buses (all scheduled trips as virtual)
app.get('/api/virtual_positions', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;

    // Set mode to ALL_VIRTUAL
    virtualVehicleManager.setMode('all');

    // Load schedule
    await scheduleLoader.loadSchedules(operatorId);

    // Get trip updates
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);

    if (!tripResult.success) {
      return res.status(500).json({
        error: 'Failed to fetch trip updates',
        details: tripResult.error
      });
    }

    // Generate ALL virtual vehicles
    const virtualVehicles = virtualVehicleManager.generateAllVirtualVehicles(
      tripResult.data,
      scheduleLoader.scheduleData
    );

    // Update positions
    virtualVehicleManager.updateVirtualPositions();

    // Enrich virtual vehicles with blockId
    const enrichedVirtualVehicles = addBlockIdToVehicles(virtualVehicles, scheduleLoader.scheduleData);

    res.json({
      metadata: {
        feedType: 'virtual_positions',
        operatorId,
        mode: 'all_virtual',
        fetchedAt: new Date().toISOString(),
        entities: enrichedVirtualVehicles.length,
        block_id_enriched: countEntitiesWithBlockId(enrichedVirtualVehicles, 'vehicle'),
        description: 'All scheduled trips shown as virtual buses with blockId'
      },
      data: {
        entity: enrichedVirtualVehicles,
        header: {
          gtfsRealtimeVersion: '1.0',
          incrementality: 0,
          timestamp: Math.floor(Date.now() / 1000),
          feedVersion: 'VIRTUAL-ALL'
        }
      }
    });

  } catch (error) {
    console.error('Error in /api/virtual_positions:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Substitute virtual buses only (for missing real buses)
app.get('/api/virtual_subs', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;

    // Set mode to SUBS_ONLY
    virtualVehicleManager.setMode('subs');

    // Load schedule
    await scheduleLoader.loadSchedules(operatorId);

    // Get real vehicle positions
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);

    if (!tripResult.success) {
      return res.status(500).json({
        error: 'Failed to fetch trip updates',
        details: tripResult.error
      });
    }

    // Get IDs of real vehicles
    const realVehicleIds = new Set();
    if (vehicleResult.success && vehicleResult.data?.entity) {
      vehicleResult.data.entity.forEach(vehicle => {
        if (vehicle.vehicle?.vehicle?.id) {
          realVehicleIds.add(vehicle.vehicle.vehicle.id);
        }
      });
    }

    // Generate substitute virtual vehicles
    const virtualVehicles = virtualVehicleManager.generateSubstituteVirtualVehicles(
      tripResult.data,
      scheduleLoader.scheduleData,
      realVehicleIds
    );

    // Update positions
    virtualVehicleManager.updateVirtualPositions();

    // Enrich virtual vehicles with blockId
    const enrichedVirtualVehicles = addBlockIdToVehicles(virtualVehicles, scheduleLoader.scheduleData);

    res.json({
      metadata: {
        feedType: 'virtual_subs',
        operatorId,
        mode: 'substitute_only',
        fetchedAt: new Date().toISOString(),
        entities: enrichedVirtualVehicles.length,
        real_vehicles_count: realVehicleIds.size,
        block_id_enriched: countEntitiesWithBlockId(enrichedVirtualVehicles, 'vehicle'),
        description: 'Virtual buses only for scheduled trips missing real-time data'
      },
      data: {
        entity: enrichedVirtualVehicles,
        header: {
          gtfsRealtimeVersion: '1.0',
          incrementality: 0,
          timestamp: Math.floor(Date.now() / 1000),
          feedVersion: 'VIRTUAL-SUBS'
        }
      }
    });

  } catch (error) {
    console.error('Error in /api/virtual_subs:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Virtual bus mode configuration
app.get('/api/virtual_config', (req, res) => {
  const mode = req.query.mode;
  const maxBuses = parseInt(req.query.max) || 3;

  let success = false;
  let message = '';

  if (mode) {
    success = virtualVehicleManager.setMode(mode);
    message = success ? `Mode set to: ${mode}` : `Invalid mode: ${mode}`;
  }

  if (maxBuses >= 1 && maxBuses <= 10) {
    virtualVehicleManager.setMaxVirtualBuses(maxBuses);
    message += message ? `, Max buses: ${maxBuses}` : `Max buses set to: ${maxBuses}`;
    success = true;
  }

  res.json({
    success,
    message: message || 'No changes made',
    current_mode: virtualVehicleManager.currentMode,
    max_virtual_buses: virtualVehicleManager.maxVirtualBuses,
    current_virtual_count: virtualVehicleManager.getVirtualVehicleCount(),
    timestamp: new Date().toISOString()
  });
});

// ==================== HEALTH AND INFO ENDPOINTS ====================

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

// API info endpoint
app.get('/api/info', (req, res) => {
  res.json({
    api: {
      name: 'BC Transit GTFS-RT Proxy with Virtual Vehicles',
      version: '3.1',
      description: 'Real-time bus data for BC Transit systems with virtual vehicle support'
    },
    features: {
      block_id_support: {
        available: true,
        description: 'All vehicles (real and virtual) include blockId from schedule data',
        endpoints: ['/api/buses', '/api/vehicle_positions', '/api/trip_updates'],
        note: 'Block IDs come from schedule/trips.txt and are matched by trip_id'
      },
      virtual_vehicles: {
        enabled: true,
        description: 'Creates ghost buses for scheduled trips without real-time tracking',
        identifier: 'VIRTUAL_{TRIP_ID}_{TIMESTAMP}',
        flag: 'vehicle.vehicle.is_virtual: true'
      }
    },
    endpoints: {
      combined: {
        path: '/api/buses',
        description: 'All feeds combined with virtual vehicles and blockId',
        parameters: {
          operatorId: 'Optional. Default: 36 (Revelstoke). Try: 36, 47, 48'
        }
      },
      individual: {
        vehicle_positions: '/api/vehicle_positions?operatorId=36',
        trip_updates: '/api/trip_updates?operatorId=36',
        service_alerts: '/api/service_alerts?operatorId=36'
      },
      testing: {
        block_id_test: '/api/test_block_id',
        verify_blockid: '/api/verify_blockid_in_feed',
        virtual_debug: '/api/debug_virtual',
        virtual_info: '/api/virtual_info'
      }
    },
    operators: {
      '36': 'Revelstoke',
      '47': 'Kelowna',
      '48': 'Victoria'
    }
  });
});

// Debug endpoint to check schedule data
app.get('/api/debug_schedule', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;

    console.log('🔍 Checking schedule data for operator:', operatorId);

    // Load schedule
    const schedule = await scheduleLoader.loadSchedules(operatorId);

    // Check what files exist
    const fs = await import('fs/promises');
    const path = await import('path');

    const schedulePath = path.join(process.cwd(), 'schedules', `operator_${operatorId}`);

    let filesExist = false;
    let fileList = [];

    try {
      const files = await fs.readdir(schedulePath);
      fileList = files;
      filesExist = files.length > 0;
    } catch (error) {
      filesExist = false;
    }

    res.json({
      operatorId,
      scheduleLoaded: !!schedule,
      isFallback: schedule?.isFallback || false,
      schedulePath,
      filesExist,
      files: fileList,
      stopsCount: schedule?.stops ? Object.keys(schedule.stops).length : 0,
      tripsCount: schedule?.trips?.length || 0,
      tripsWithBlockId: schedule?.trips?.filter(t => t.block_id).length || 0,
      sampleTrips: schedule?.trips?.slice(0, 5).map(t => ({
        trip_id: t.trip_id,
        block_id: t.block_id || 'NONE',
        route_id: t.route_id
      })) || [],
      loadedAt: schedule?.loadedAt
    });

  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// ==================== ROOT ENDPOINT ====================

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>🚌 BC Transit GTFS-RT Proxy with Virtual Vehicles</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; line-height: 1.6; }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        h2 { color: #34495e; margin-top: 30px; }
        .endpoint { background: #f8f9fa; padding: 15px; margin: 10px 0; border-left: 4px solid #3498db; border-radius: 4px; }
        .block-feature { background: #e8f4fc; border-left: 4px solid #2e86c1; }
        code { background: #e8f4f8; padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', monospace; }
        .operator { display: inline-block; background: #e8f6f3; padding: 4px 8px; margin: 2px; border-radius: 3px; }
        a { color: #2980b9; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .note { background: #fffacd; padding: 10px; border-radius: 5px; border-left: 3px solid #ffd700; }
        .block-highlight { color: #2e86c1; font-weight: bold; }
      </style>
    </head>
    <body>
      <h1>👻🚌 BC Transit Proxy with Virtual Vehicles</h1>
      <p>Real-time BC Transit data with virtual (ghost) buses for scheduled trips without GPS tracking</p>
     
      <div class="note">
        <strong>📦 NEW: Block ID Support!</strong> All vehicles (real and virtual) now include <span class="block-highlight">blockId</span> from schedule data when available.
      </div>

      <h2>📡 Main Endpoints</h2>

      <div class="endpoint block-feature">
        <strong>GET <code>/api/buses</code></strong>
        <p>All feeds combined (vehicle positions + trip updates + alerts) with virtual vehicles</p>
        <p><span class="block-highlight">✓ ALWAYS includes blockId</span> for real and virtual vehicles</p>
        <p>Default: Revelstoke (36)</p>
        <p>Examples:
          <a href="/api/buses" target="_blank">Revelstoke</a> |
          <a href="/api/buses?operatorId=47" target="_blank">Kelowna</a> |
          <a href="/api/buses?operatorId=48" target="_blank">Victoria</a>
        </p>
      </div>

      <div class="endpoint">
        <strong>GET <code>/api/vehicle_positions</code></strong>
        <p>Vehicle positions only (with optional virtuals)</p>
        <p><span class="block-highlight">✓ Includes blockId</span> when available</p>
        <p>Params: <code>?virtual=false</code> (disable virtuals), <code>?virtual_mode=all</code> or <code>subs</code></p>
        <p><a href="/api/vehicle_positions" target="_blank">Try it</a></p>
      </div>

      <div class="endpoint">
        <strong>GET <code>/api/trip_updates</code></strong>
        <p>Trip predictions and schedule updates</p>
        <p><span class="block-highlight">✓ Includes blockId</span> when available</p>
        <p><a href="/api/trip_updates" target="_blank">Try it</a></p>
      </div>

      <div class="endpoint">
        <strong>GET <code>/api/service_alerts</code></strong>
        <p>Service alerts and notifications</p>
        <p><a href="/api/service_alerts" target="_blank">Try it</a></p>
      </div>

      <h2>🔧 Testing & Debug Endpoints</h2>
      <ul>
        <li><a href="/api/test_block_id" target="_blank">/api/test_block_id</a> - Test blockId enrichment</li>
        <li><a href="/api/verify_blockid_in_feed" target="_blank">/api/verify_blockid_in_feed</a> - Verify blockId in actual feed</li>
        <li><a href="/api/debug_schedule" target="_blank">/api/debug_schedule</a> - Check schedule data</li>
        <li><a href="/api/debug_virtual" target="_blank">/api/debug_virtual</a> - Debug virtual vehicles</li>
        <li><a href="/api/virtual_info" target="_blank">/api/virtual_info</a> - Active virtual vehicles</li>
        <li><a href="/api/health" target="_blank">/api/health</a> - Server health check</li>
        <li><a href="/api/info" target="_blank">/api/info</a> - API documentation</li>
      </ul>

      <h2>👻 Virtual-Only Endpoints</h2>
      <ul>
        <li><a href="/api/virtual_positions" target="_blank">/api/virtual_positions</a> - All trips as virtual buses</li>
        <li><a href="/api/virtual_subs" target="_blank">/api/virtual_subs</a> - Only substitute virtual buses</li>
      </ul>

      <h2>Supported Operators</h2>
      <div>
        <span class="operator">36: Revelstoke</span>
        <span class="operator">47: Kelowna</span>
        <span class="operator">48: Victoria</span>
      </div>

      <p style="margin-top: 40px; text-align: center; color: #777;">
        Proxy Version 3.1 • Virtual Vehicles Active • BlockId Supported • <a href="/api/info">Full API Info</a>
      </p>
    </body>
    </html>
  `);
});

// ==================== INITIALIZATION ====================

// Initialize virtual vehicle system
async function initializeVirtualSystem() {
  try {
    console.log('🚀 Initializing virtual vehicle system...');

    // Start virtual vehicle updater if available
    if (virtualUpdater && typeof virtualUpdater.start === 'function') {
      virtualUpdater.start();
      console.log('✅ Virtual vehicle updater started');
    }

    // Cleanup on exit
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
