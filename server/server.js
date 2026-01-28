import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import protobuf from 'protobufjs';

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

// Load the protobuf schema before handling any requests
await loadProto();

// ====== INDIVIDUAL FEED ENDPOINTS ======

// Vehicle positions only
app.get('/api/vehicle_positions', async (req, res) => {
  try {
    const operatorId = req.query.operatorId || DEFAULT_OPERATOR_ID;
    const result = await fetchGTFSFeed('vehicleupdates.pb', operatorId);
    
    if (result.success) {
      res.json({
        metadata: {
          feedType: 'vehicle_positions',
          operatorId,
          fetchedAt: result.timestamp,
          url: result.url,
          entities: result.data.entity?.length || 0
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
            success: vehicleResult.success,
            entities: vehicleResult.success ? vehicleResult.data.entity?.length || 0 : 0,
            url: vehicleResult.url
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
    if (vehicleResult.success) {
      response.data.vehicle_positions = vehicleResult.data;
    }
    
    if (tripResult.success) {
      response.data.trip_updates = tripResult.data;
    }
    
    if (alertsResult.success) {
      response.data.service_alerts = alertsResult.data;
    }
    
    // Add any errors
    const errors = [];
    if (!vehicleResult.success) errors.push(`Vehicle positions: ${vehicleResult.error}`);
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
      defaultOperator: DEFAULT_OPERATOR_ID
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
      name: 'BC Transit GTFS-RT Proxy',
      version: '2.0',
      description: 'Real-time bus data for BC Transit systems'
    },
    endpoints: {
      combined: {
        path: '/api/buses',
        description: 'All feeds combined',
        parameters: {
          operatorId: 'Optional. Default: 36 (Revelstoke). Try: 36, 47, 48'
        }
      },
      individual: {
        vehicle_positions: '/api/vehicle_positions?operatorId=36',
        trip_updates: '/api/trip_updates?operatorId=36',
        service_alerts: '/api/service_alerts?operatorId=36'
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
      vehicleupdates: 'Real-time vehicle positions and status',
      tripupdates: 'Trip predictions and schedule updates',
      alerts: 'Service alerts and notifications'
    }
  });
});

// Root endpoint with HTML interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>🚌 BC Transit GTFS-RT Proxy</title>
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
        code { 
          background: #e8f4f8; 
          padding: 2px 6px; 
          border-radius: 3px; 
          font-family: 'Courier New', monospace;
        }
        .operator { display: inline-block; background: #e8f6f3; padding: 4px 8px; margin: 2px; border-radius: 3px; }
        a { color: #2980b9; text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <h1>🚌 BC Transit GTFS-RT Proxy Server</h1>
      <p>Real-time BC Transit data with support for multiple operators</p>
      
      <h2>📡 Available Endpoints:</h2>
      
      <div class="endpoint">
        <strong>GET <code>/api/buses</code></strong>
        <p>Get all real-time feeds combined (vehicle positions, trip updates, alerts)</p>
        <p>Default: Revelstoke (36)</p>
        <p>Try: 
          <a href="/api/buses" target="_blank">Revelstoke</a> | 
          <a href="/api/buses?operatorId=47" target="_blank">Kelowna</a> | 
          <a href="/api/buses?operatorId=48" target="_blank">Victoria</a>
        </p>
      </div>
      
      <div class="endpoint">
        <strong>GET <code>/api/vehicle_positions</code></strong>
        <p>Vehicle positions and status only</p>
        <p><a href="/api/vehicle_positions" target="_blank">Try it</a></p>
      </div>
      
      <div class="endpoint">
        <strong>GET <code>/api/trip_updates</code></strong>
        <p>Trip predictions and schedule updates</p>
        <p><a href="/api/trip_updates" target="_blank">Try it</a></p>
      </div>
      
      <div class="endpoint">
        <strong>GET <code>/api/service_alerts</code></strong>
        <p>Service alerts and notifications</p>
        <p><a href="/api/service_alerts" target="_blank">Try it</a></p>
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
      </ul>
      
      <h2>📚 Usage Examples:</h2>
      <pre><code>// Get Revelstoke buses (default)
fetch('/api/buses')
  .then(r => r.json())
  .then(data => console.log(data))

// Get Kelowna vehicle positions
fetch('/api/vehicle_positions?operatorId=47')
  .then(r => r.json())
  .then(data => console.log(data))

// Get Victoria alerts
fetch('/api/service_alerts?operatorId=48')
  .then(r => r.json())
  .then(data => console.log(data))</code></pre>
    </body>
    </html>
  `);
});

// Export for Vercel
export default app;
