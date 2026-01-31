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
   
    return {
      ...vehicleEntity,
      vehicle: fixedVehicle
    };
  }
 
  return vehicleEntity;
}

// Helper to add blockId to vehicle entities from schedule data
function addBlockIdToVehicles(vehicleEntities, scheduleData) {
  if (!Array.isArray(vehicleEntities) || !scheduleData) return vehicleEntities || [];
  
  const tripsMap = scheduleData.tripsMap;
  const tripsArray = scheduleData.trips;
  
  if (!tripsMap && !Array.isArray(tripsArray)) return vehicleEntities;
  
  return vehicleEntities.map((entity) => {
    const fixedEntity = fixVehicleStructure(entity);
    const enrichedEntity = JSON.parse(JSON.stringify(fixedEntity));
    
    if (enrichedEntity.vehicle?.trip?.blockId) return enrichedEntity;
    
    const tripId = enrichedEntity.vehicle?.trip?.tripId;
    if (!tripId) return enrichedEntity;
    
    let scheduledTrip = tripsMap?.[tripId] || 
                       tripsArray?.find(t => t.trip_id === tripId);
    
    if (scheduledTrip?.block_id) {
      if (!enrichedEntity.vehicle.trip) enrichedEntity.vehicle.trip = {};
      enrichedEntity.vehicle.trip.blockId = scheduledTrip.block_id;
    }
    
    return enrichedEntity;
  });
}

// Helper to add blockId to trip update entities
function addBlockIdToTripUpdates(tripUpdateEntities, scheduleData) {
  if (!Array.isArray(tripUpdateEntities) || !scheduleData) return tripUpdateEntities || [];
  
  const tripsMap = scheduleData.tripsMap;
  const tripsArray = scheduleData.trips;
  
  if (!tripsMap && !Array.isArray(tripsArray)) return tripUpdateEntities;
  
  return tripUpdateEntities.map((entity) => {
    const enrichedEntity = JSON.parse(JSON.stringify(entity));
    
    if (enrichedEntity.tripUpdate?.trip?.blockId) return enrichedEntity;
    
    const tripId = enrichedEntity.tripUpdate?.trip?.tripId;
    if (!tripId) return enrichedEntity;
    
    let scheduledTrip = tripsMap?.[tripId] || 
                       tripsArray?.find(t => t.trip_id === tripId);
    
    if (scheduledTrip?.block_id) {
      if (!enrichedEntity.tripUpdate.trip) enrichedEntity.tripUpdate.trip = {};
      enrichedEntity.tripUpdate.trip.blockId = scheduledTrip.block_id;
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

// Core function to get vehicle positions (now supports no-virtuals mode)
async function getVehiclePositions(operatorId = DEFAULT_OPERATOR_ID, includeVirtual = true, virtualMode = 'subs') {
  try {
    await scheduleLoader.loadSchedules(operatorId);
    
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    let enrichedVehicles = [];
    
    if (vehicleResult.success && vehicleResult.data?.entity) {
      enrichedVehicles = addBlockIdToVehicles(vehicleResult.data.entity, scheduleLoader.scheduleData);
    }
    
    let virtualVehicles = [];
    if (includeVirtual) {
      const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);
      if (tripResult.success) {
        const originalMode = virtualVehicleManager.currentMode;
        virtualVehicleManager.setMode(virtualMode);
        
        const realVehicleIds = new Set(enrichedVehicles.map(v => v.vehicle?.vehicle?.id).filter(Boolean));
        
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
        
        virtualVehicleManager.updateVirtualPositions();
        virtualVehicleManager.setMode(originalMode);
      }
    }
    
    const allEntities = includeVirtual 
      ? [...enrichedVehicles, ...virtualVehicles]
      : enrichedVehicles;
    
    const vehiclesWithBlockId = countEntitiesWithBlockId(allEntities, 'vehicle');
    
    return {
      success: vehicleResult.success,
      data: {
        ...vehicleResult.data,
        entity: allEntities,
        metadata: {
          total_vehicles: allEntities.length,
          virtual_vehicles: virtualVehicles.length,
          real_vehicles: enrichedVehicles.length,
          block_id_enriched: vehiclesWithBlockId,
          block_id_coverage: allEntities.length > 0 
            ? `${Math.round((vehiclesWithBlockId / allEntities.length) * 100)}%` 
            : '0%'
        }
      },
      error: vehicleResult.error
    };
  } catch (error) {
    console.error('Error in getVehiclePositions:', error);
    throw error;
  }
}

// ==================== MAIN ENDPOINTS ====================

// Combined endpoint - supports ?no_virtuals
app.get('/api/buses', async (req, res) => {
  if (!root) return res.status(500).json({ error: 'Proto not loaded' });
  
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const noVirtuals = 'no_virtuals' in req.query;
    const startTime = Date.now();
    
    console.log(`[${new Date().toISOString()}] /api/buses called | operator=${operatorId} | no_virtuals=${noVirtuals}`);
    
    const [vehicleResult, tripResult, alertsResult] = await Promise.all([
      getVehiclePositions(operatorId, !noVirtuals),
      fetchGTFSFeed('tripupdates.pb', operatorId),
      fetchGTFSFeed('alerts.pb', operatorId)
    ]);
    
    let enhancedTripResult = tripResult;
    if (tripResult.success && tripResult.data?.entity) {
      enhancedTripResult = {
        ...tripResult,
        data: {
          ...tripResult.data,
          entity: addBlockIdToTripUpdates(tripResult.data.entity, scheduleLoader.scheduleData)
        }
      };
    }
    
    const responseTime = Date.now() - startTime;
    const vehiclesWithBlockId = countEntitiesWithBlockId(vehicleResult.data?.entity, 'vehicle');
    const tripUpdatesWithBlockId = countEntitiesWithBlockId(enhancedTripResult.data?.entity, 'tripUpdate');
    
    const response = {
      metadata: {
        operatorId,
        location: operatorId === '36' ? 'Revelstoke' : `Operator ${operatorId}`,
        fetchedAt: new Date().toISOString(),
        responseTimeMs: responseTime,
        virtuals_included: !noVirtuals,
        feeds: {
          vehicle_positions: {
            success: vehicleResult.success,
            entities: vehicleResult.data?.entity?.length || 0,
            virtual_vehicles: vehicleResult.data?.metadata?.virtual_vehicles || 0,
            real_vehicles: vehicleResult.data?.metadata?.real_vehicles || 0
          },
          trip_updates: {
            success: tripResult.success,
            entities: enhancedTripResult.data?.entity?.length || 0
          },
          service_alerts: {
            success: alertsResult.success,
            entities: alertsResult.data?.entity?.length || 0
          }
        },
        block_id: {
          enabled: true,
          vehicles_enriched: vehiclesWithBlockId,
          trip_updates_enriched: tripUpdatesWithBlockId,
          vehicle_coverage: vehicleResult.data?.entity?.length > 0 
            ? `${Math.round((vehiclesWithBlockId / vehicleResult.data.entity.length) * 100)}%` 
            : '0%'
        }
      },
      data: {
        vehicle_positions: vehicleResult.success ? vehicleResult.data : null,
        trip_updates: enhancedTripResult.success ? enhancedTripResult.data : null,
        service_alerts: alertsResult.success ? alertsResult.data : null
      }
    };
    
    const errors = [];
    if (!vehicleResult.success) errors.push(`Vehicles: ${vehicleResult.error}`);
    if (!tripResult.success) errors.push(`Trip updates: ${tripResult.error}`);
    if (!alertsResult.success) errors.push(`Alerts: ${alertsResult.error}`);
    if (errors.length) response.metadata.errors = errors;
    
    res.json(response);
  } catch (error) {
    console.error('Error in /api/buses:', error);
    res.status(500).json({ error: 'Failed to fetch combined feeds', details: error.message });
  }
});

// ==================== ROOT PAGE DOCUMENTATION ====================

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>🚌 BC Transit GTFS-RT Proxy</title>
      <style>
        body { font-family: system-ui, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; line-height: 1.6; }
        h1 { color: #1e40af; border-bottom: 3px solid #3b82f6; padding-bottom: 12px; }
        .endpoint { background: #f1f5f9; padding: 16px; margin: 12px 0; border-left: 5px solid #3b82f6; border-radius: 6px; }
        code { background: #e0f2fe; padding: 3px 6px; border-radius: 4px; font-family: 'Consolas', monospace; }
        .param { font-weight: bold; color: #b45309; }
        .note { background: #fefce8; padding: 12px; border-left: 4px solid #ca8a04; border-radius: 6px; margin: 16px 0; }
      </style>
    </head>
    <body>
      <h1>🚌 BC Transit GTFS-RT Proxy</h1>
      <p>Real-time bus data proxy — Revelstoke & other BC Transit systems</p>
      
      <div class="note">
        <strong>Block IDs included</strong> — All vehicle responses now enrich trip.blockId from schedule data<br>
        <strong>Virtual vehicles optional</strong> — Use <code>?no_virtuals</code> to get only real buses
      </div>
      
      <h2>Main Endpoints</h2>
      
      <div class="endpoint">
        <strong>GET <code>/api/buses</code></strong><br>
        Combined vehicle positions + trip updates + alerts<br>
        • Includes virtual vehicles by default<br>
        • <span class="param">?no_virtuals</span> → only real vehicles (recommended while virtuals are being fixed)<br>
        • <span class="param">?operatorId=36</span> (default = Revelstoke)<br>
        <a href="/api/buses" target="_blank">Try combined (with virtuals)</a> • 
        <a href="/api/buses?no_virtuals" target="_blank">Try without virtuals</a>
      </div>
      
      <div class="endpoint">
        <strong>GET <code>/api/vehicle_positions</code></strong><br>
        Vehicle positions only (with block IDs)<br>
        • <span class="param">?virtual=false</span> or <span class="param">?no_virtuals</span> to disable virtuals<br>
        <a href="/api/vehicle_positions?no_virtuals" target="_blank">Test without virtuals</a>
      </div>
      
      <h2>Testing & Debug</h2>
      <ul>
        <li><a href="/api/test_structure" target="_blank">/api/test_structure</a> — Check vehicle object shape</li>
        <li><a href="/api/test_tracker_compatibility" target="_blank">/api/test_tracker_compatibility</a> — Tracker compatibility check</li>
      </ul>
      
      <p style="margin-top: 2rem; color: #64748b; font-size: 0.9rem;">
        Last updated: January 2026 • For Revelstoke Bus Tracker development
      </p>
    </body>
    </html>
  `);
});

// ==================== STARTUP ====================

await loadProto();

// Initialize virtual system (still runs in background, but skipped on no_virtuals requests)
initializeVirtualSystem().catch(console.error);

export default app;
