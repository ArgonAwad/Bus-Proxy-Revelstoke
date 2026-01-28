import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import protobuf from 'protobufjs';
import virtualVehicleManager from './virtual-vehicles.js';
import scheduleLoader from './schedule-loader.js';
import virtualUpdater from './virtual-updater.js';

const app = express();
app.use(cors());

// URL of the GTFS-Realtime protobuf schema
const GTFS_PROTO_URL = 'https://raw.githubusercontent.com/google/transit/master/gtfs-realtime/proto/gtfs-realtime.proto';
const BASE_URL = 'https://bct.tmix.se/gtfs-realtime';

// Default operator ID (Revelstoke = 36, can be overridden via query param)
const DEFAULT_OPERATOR_ID = '36';

let root = null;

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
    const data = FeedMessage.toObject(message, { defaults: true });
    
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

// Enhanced vehicle positions with virtual vehicles
async function getEnhancedVehiclePositions(operatorId = DEFAULT_OPERATOR_ID) {
  try {
    console.log(`🚀 Enhancing vehicle positions for operator ${operatorId}`);
    
    // Load schedule data
    await scheduleLoader.loadSchedule(operatorId);
    console.log('✅ Schedule loaded');
    
    // Fetch real vehicle positions
    const vehicleResult = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    const tripResult = await fetchGTFSFeed('tripupdates.pb', operatorId);
    
    console.log(`📊 Real vehicles: ${vehicleResult.data?.entity?.length || 0}`);
    console.log(`📊 Trip updates: ${tripResult.data?.entity?.length || 0}`);
    
    if (!tripResult.success) {
      console.log('⚠️ No trip updates available');
      return vehicleResult;
    }
    
    // Generate virtual vehicles
    const virtualVehicles = virtualVehicleManager.generateVirtualVehicles(
      tripResult.data,
      scheduleLoader.scheduleData
    );
    
    console.log(`👻 Generated ${virtualVehicles.length} virtual vehicles`);
    
    // Combine real and virtual
    const realEntities = vehicleResult.data?.entity || [];
    const allEntities = [
      ...realEntities,
      ...virtualVehicles
    ];
    
    // Update virtual positions
    virtualVehicleManager.updateVirtualPositions();
    
    // Clean up old virtual vehicles
    virtualVehicleManager.cleanupOldVehicles();
    
    return {
      ...vehicleResult,
      data: {
        ...vehicleResult.data,
        entity: allEntities,
        metadata: {
          ...vehicleResult.data.metadata,
          total_vehicles: allEntities.length,
          virtual_vehicles: virtualVehicles.length,
          real_vehicles: realEntities.length
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

// ====== INDIVIDUAL FEED ENDPOINTS ======

// Vehicle positions only (with virtual vehicles)
app.get('/api/vehicle_positions', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const includeVirtual = req.query.virtual !== 'false';
    
    let result;
    if (includeVirtual) {
      result = await getEnhancedVehiclePositions(operatorId);
    } else {
      result = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    }
    
    if (result.success) {
      res.json({
        metadata: {
          feedType: 'vehicle_positions',
          operatorId,
          fetchedAt: result.timestamp,
          url: result.url,
          entities: result.data.entity?.length || 0,
          virtual_vehicles: result.data.metadata?.virtual_vehicles || 0
        },
        data: result.data
      });
    } else {
      res.status(500).json({
        error: 'Failed to fetch vehicle positions',
        details: result.error,
        url: result.url,
        timestamp: result.timestamp
      });
    }
  } catch (error) {
    console.error('Error in /api/vehicle_positions:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Trip updates only
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

// Service alerts only
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

// ====== COMBINED FEED ENDPOINT ======

// All feeds combined (legacy /api/buses endpoint)
app.get('/api/buses', async (req, res) => {
  if (!root) return res.status(500).json({ error: 'Proto not loaded' });

  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    
    // Fetch all three feeds in parallel
    const [vehicleResult, tripResult, alertsResult] = await Promise.all([
      fetchGTFSFeed('vehicleupdates.pb', operatorId),
      fetchGTFSFeed('tripupdates.pb', operatorId),
      fetchGTFSFeed('alerts.pb', operatorId)
    ]);
    
    // Enhance vehicle positions with virtual vehicles
    let enhancedVehicleResult = vehicleResult;
    if (vehicleResult.success && tripResult.success) {
      await scheduleLoader.loadSchedule(operatorId);
      const virtualVehicles = virtualVehicleManager.generateVirtualVehicles(
        tripResult.data,
        scheduleLoader.scheduleData
      );
      
      if (virtualVehicles.length > 0) {
        const realEntities = vehicleResult.data?.entity || [];
        const allEntities = [...realEntities, ...virtualVehicles];
        
        enhancedVehicleResult = {
          ...vehicleResult,
          data: {
            ...vehicleResult.data,
            entity: allEntities,
            metadata: {
              ...vehicleResult.data.metadata,
              total_vehicles: allEntities.length,
              virtual_vehicles: virtualVehicles.length,
              real_vehicles: realEntities.length
            }
          }
        };
      }
    }
    
    // Prepare combined response
    const response = {
      metadata: {
        operatorId,
        location: operatorId === '36' ? 'Revelstoke' : 
                  operatorId === '47' ? 'Kelowna' : 
                  operatorId === '48' ? 'Victoria' : `Operator ${operatorId}`,
        fetchedAt: new Date().toISOString(),
        feeds: {
          vehicle_positions: {
            success: enhancedVehicleResult.success,
            entities: enhancedVehicleResult.success ? enhancedVehicleResult.data.entity?.length || 0 : 0,
            virtual_vehicles: enhancedVehicleResult.data?.metadata?.virtual_vehicles || 0,
            url: enhancedVehicleResult.url
          },
          trip_updates: {
            success: tripResult.success,
            entities: tripResult.success ? tripResult.data.entity?.length || 0 : 0,
            url: tripResult.url
          },
          service_alerts: {
            success: alertsResult.success,
            entities: alertsResult.success ? alertsResult.data.entity?.length || 0 : 0,
            url: alertsResult.url
          }
        }
      },
      data: {}
    };
    
    // Add successful feeds to response
    if (enhancedVehicleResult.success) {
      response.data.vehicle_positions = enhancedVehicleResult.data;
    }
    
    if (tripResult.success) {
      response.data.trip_updates = tripResult.data;
    }
    
    if (alertsResult.success) {
      response.data.service_alerts = alertsResult.data;
    }
    
    // Add any errors
    const errors = [];
    if (!enhancedVehicleResult.success) errors.push(`Vehicle positions: ${enhancedVehicleResult.error}`);
    if (!tripResult.success) errors.push(`Trip updates: ${tripResult.error}`);
    if (!alertsResult.success) errors.push(`Service alerts: ${alertsResult.error}`);
    
    if (errors.length > 0) {
      response.metadata.errors = errors;
    }
    
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

// ====== VIRTUAL VEHICLE ENDPOINTS ======

// Debug endpoint for virtual vehicles
app.get('/api/debug_virtual', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    
    // Load schedule
    await scheduleLoader.loadSchedule(operatorId);
    
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
      label: v.vehicle?.vehicle?.label,
      position: v.vehicle?.position,
      last_updated: new Date(v.lastUpdated).toISOString()
    })),
    timestamp: new Date().toISOString()
  });
});

// ====== HEALTH AND INFO ENDPOINTS ======

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
      virtualSystem: 'active'
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
      version: '3.0',
      description: 'Real-time bus data for BC Transit systems with virtual vehicle support'
    },
    endpoints: {
      combined: {
        path: '/api/buses',
        description: 'All feeds combined with virtual vehicles',
        parameters: {
          operatorId: 'Optional. Default: 36 (Revelstoke). Try: 36, 47, 48'
        }
      },
      individual: {
        vehicle_positions: '/api/vehicle_positions?operatorId=36',
        trip_updates: '/api/trip_updates?operatorId=36',
        service_alerts: '/api/service_alerts?operatorId=36'
      },
      virtual_vehicles: {
        debug: '/api/debug_virtual',
        info: '/api/virtual_info',
        cleanup: '/api/cleanup_virtual'
      },
      utility: {
        health: '/api/health',
        info: '/api/info'
      }
    },
    operators: {
      '36': 'Revelstoke',
      '47': 'Kelowna', 
      '48': 'Victoria'
    },
    feeds: {
      vehicleupdates: 'Real-time vehicle positions and status (with virtual vehicles)',
      tripupdates: 'Trip predictions and schedule updates',
      alerts: 'Service alerts and notifications'
    },
    virtual_vehicles: {
      enabled: true,
      description: 'Creates ghost buses for scheduled trips without real-time tracking',
      identifier: 'VIRTUAL_{TRIP_ID}_{TIMESTAMP}',
      flag: 'vehicle.vehicle.is_virtual: true'
    }
  });
});

// Root endpoint with HTML interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>🚌 BC Transit GTFS-RT Proxy with Virtual Vehicles</title>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
          max-width: 800px; 
          margin: 40px auto; 
          padding: 20px; 
          line-height: 1.6;
        }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        h2 { color: #34495e; margin-top: 30px; }
        .endpoint { 
          background: #f8f9fa; 
          padding: 15px; 
          margin: 10px 0; 
          border-left: 4px solid #3498db; 
          border-radius: 4px;
        }
        .ghost-endpoint { 
          background: #f0f8ff; 
          border-left: 4px solid #7b68ee;
        }
        code { 
          background: #e8f4f8; 
          padding: 2px 6px; 
          border-radius: 3px; 
          font-family: 'Courier New', monospace;
        }
        .operator { display: inline-block; background: #e8f6f3; padding: 4px 8px; margin: 2px; border-radius: 3px; }
        a { color: #2980b9; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .ghost { color: #7b68ee; font-weight: bold; }
        .note { background: #fffacd; padding: 10px; border-radius: 5px; border-left: 3px solid #ffd700; }
      </style>
    </head>
    <body>
      <h1>👻🚌 BC Transit Proxy with Virtual Vehicles</h1>
      <p>Real-time BC Transit data with virtual (ghost) buses for scheduled trips without GPS tracking</p>
      
      <div class="note">
        <strong>✨ New Feature:</strong> Virtual vehicles automatically appear as ghost buses for scheduled trips that don't have real-time tracking.
        Look for <span class="ghost">"is_virtual": true</span> in the vehicle data.
      </div>
      
      <h2>📡 Available Endpoints:</h2>
      
      <div class="endpoint">
        <strong>GET <code>/api/buses</code></strong>
        <p>Get all real-time feeds combined (vehicle positions, trip updates, alerts) with virtual vehicles</p>
        <p>Default: Revelstoke (36)</p>
        <p>Try: 
          <a href="/api/buses" target="_blank">Revelstoke</a> | 
          <a href="/api/buses?operatorId=47" target="_blank">Kelowna</a> | 
          <a href="/api/buses?operatorId=48" target="_blank">Victoria</a>
        </p>
      </div>
      
      <div class="endpoint">
        <strong>GET <code>/api/vehicle_positions</code></strong>
        <p>Vehicle positions and status only (with virtual vehicles)</p>
        <p>Add <code>?virtual=false</code> to disable virtual vehicles</p>
        <p><a href="/api/vehicle_positions" target="_blank">Try it</a></p>
      </div>
      
      <div class="endpoint ghost-endpoint">
        <strong>GET <code>/api/debug_virtual</code></strong>
        <p>Debug information about virtual vehicles</p>
        <p><a href="/api/debug_virtual" target="_blank">Try it</a></p>
      </div>
      
      <div class="endpoint ghost-endpoint">
        <strong>GET <code>/api/virtual_info</code></strong>
        <p>Information about active virtual vehicles</p>
        <p><a href="/api/virtual_info" target="_blank">Try it</a></p>
      </div>
      
      <h2>🏙️ Supported Operators:</h2>
      <div>
        <span class="operator">36: Revelstoke</span>
        <span class="operator">47: Kelowna</span>
        <span class="operator">48: Victoria</span>
      </div>
      
      <h2>🔧 Utility Endpoints:</h2>
      <ul>
        <li><a href="/api/health" target="_blank">/api/health</a> - Server health check</li>
        <li><a href="/api/info" target="_blank">/api/info</a> - API documentation</li>
        <li><a href="/api/cleanup_virtual" target="_blank">/api/cleanup_virtual</a> - Clean up old virtual vehicles</li>
      </ul>
      
      <h2>👻 Virtual Vehicles:</h2>
      <p>Virtual vehicles appear when:</p>
      <ul>
        <li>A trip is scheduled (in trip updates)</li>
        <li>No real vehicle is transmitting GPS for that trip</li>
        <li>Position is estimated from schedule data</li>
      </ul>
      <p>They appear in the feed with <code>"is_virtual": true</code> and can be styled as ghost buses on your map.</p>
      
      <h2>📚 Usage Examples:</h2>
      <pre><code>// Get Revelstoke buses with virtual vehicles (default)
fetch('/api/buses')
  .then(r => r.json())
  .then(data => {
    const allBuses = data.data.vehicle_positions.entity || [];
    const realBuses = allBuses.filter(b => !b.vehicle?.vehicle?.is_virtual);
    const ghostBuses = allBuses.filter(b => b.vehicle?.vehicle?.is_virtual);
    console.log(realBuses.length + ' real buses, ' + ghostBuses.length + ' ghost buses');
  })

// Get vehicle positions without virtual vehicles
fetch('/api/vehicle_positions?virtual=false')
  .then(r => r.json())
  .then(data => console.log(data))

// Debug virtual vehicle system
fetch('/api/debug_virtual')
  .then(r => r.json())
  .then(data => console.log('Trips needing ghost buses:', data.tripsWithoutVehicles))</code></pre>
    </body>
    </html>
  `);
});

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
