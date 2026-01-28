import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import protobuf from 'protobufjs';

const app = express();
app.use(cors());

// Base URL for BC Transit GTFS-RT feeds
const BASE_URL = 'https://bct.tmix.se/gtfs-realtime';
const OPERATOR_ID = '36'; // Revelstoke

// GTFS protobuf schema
const GTFS_PROTO_URL = 'https://raw.githubusercontent.com/google/transit/master/gtfs-realtime/proto/gtfs-realtime.proto';

let root = null;

// Available feed types
const FEED_TYPES = {
  VEHICLE_UPDATES: 'vehicleupdates.pb',
  TRIP_UPDATES: 'tripupdates.pb',
  ALERTS: 'alerts.pb'
};

// Parameters to test for occupancy data
const TEST_PARAMETERS = [
  'includeOccupancy=true',
  'passengerCount=true',
  'detailed=true',
  'full=true',
  'verbose=true',
  'showAll=true',
  'withCounts=true',
  'extended=true',
  'debug=true'
];

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

// Decode protobuf feed
function decodeFeed(buffer) {
  try {
    const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
    const message = FeedMessage.decode(new Uint8Array(buffer));
    return FeedMessage.toObject(message, { defaults: true });
  } catch (error) {
    throw new Error(`Failed to decode feed: ${error.message}`);
  }
}

// Fetch a specific feed
async function fetchFeed(feedType, params = '') {
  const url = `${BASE_URL}/${feedType}?operatorIds=${OPERATOR_ID}${params ? '&' + params : ''}`;
  console.log(`📡 Fetching: ${url}`);
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    const data = decodeFeed(buffer);
    
    return {
      url,
      status: 'success',
      data,
      headers: Object.fromEntries(response.headers.entries()),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      url,
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// Test all parameter combinations for a feed
async function testParameters(feedType) {
  console.log(`🧪 Testing parameters for ${feedType}`);
  
  const results = [];
  
  // First, fetch without any parameters (baseline)
  const baseline = await fetchFeed(feedType, '');
  results.push({
    test: 'baseline (no params)',
    ...baseline
  });
  
  // Test each parameter
  for (const param of TEST_PARAMETERS) {
    const result = await fetchFeed(feedType, param);
    results.push({
      test: `with ${param}`,
      ...result
    });
  }
  
  return results;
}

// Analyze feed for occupancy data
function analyzeOccupancy(feed) {
  if (!feed.data || !feed.data.entity) {
    return { hasEntities: false, occupancyFound: false };
  }
  
  const vehicles = feed.data.entity.filter(e => e.vehicle);
  const withOccupancy = vehicles.filter(v => 
    v.vehicle.occupancyStatus !== undefined || 
    v.vehicle.occupancyPercentage !== undefined
  );
  
  const occupancyValues = withOccupancy.map(v => ({
    vehicleId: v.vehicle.vehicle?.id || 'unknown',
    status: v.vehicle.occupancyStatus,
    percentage: v.vehicle.occupancyPercentage,
    hasStatus: v.vehicle.occupancyStatus !== undefined,
    hasPercentage: v.vehicle.occupancyPercentage !== undefined
  }));
  
  return {
    hasEntities: vehicles.length > 0,
    totalVehicles: vehicles.length,
    withOccupancy: withOccupancy.length,
    occupancyPercentage: vehicles.length > 0 ? (withOccupancy.length / vehicles.length * 100).toFixed(1) + '%' : '0%',
    sampleValues: occupancyValues.slice(0, 5), // First 5 vehicles
    allZeroStatus: occupancyValues.every(v => v.status === 0),
    allZeroPercentage: occupancyValues.every(v => v.percentage === 0)
  };
}

// Initialize
await loadProto();

// Main endpoint - get all feeds
app.get('/api/buses', async (req, res) => {
  if (!root) return res.status(500).json({ error: 'Proto not loaded' });

  try {
    console.log('🚌 Fetching all feeds for Revelstoke...');
    
    // Fetch all feed types in parallel
    const [vehicleUpdates, tripUpdates, alerts] = await Promise.all([
      fetchFeed(FEED_TYPES.VEHICLE_UPDATES),
      fetchFeed(FEED_TYPES.TRIP_UPDATES),
      fetchFeed(FEED_TYPES.ALERTS)
    ]);
    
    // Analyze occupancy data
    const occupancyAnalysis = analyzeOccupancy(vehicleUpdates);
    
    const result = {
      metadata: {
        operatorId: OPERATOR_ID,
        location: 'Revelstoke',
        fetchedAt: new Date().toISOString(),
        feedsAvailable: Object.keys(FEED_TYPES),
        occupancyAnalysis
      },
      feeds: {
        vehicleUpdates,
        tripUpdates,
        alerts
      }
    };
    
    res.json(result);
  } catch (error) {
    console.error('Error fetching feeds:', error);
    res.status(500).json({ error: 'Failed to fetch GTFS feeds', details: error.message });
  }
});

// Endpoint to test parameter variations
app.get('/api/buses/test-parameters', async (req, res) => {
  if (!root) return res.status(500).json({ error: 'Proto not loaded' });

  try {
    const feedType = req.query.feed || FEED_TYPES.VEHICLE_UPDATES;
    const results = await testParameters(feedType);
    
    // Analyze each result for occupancy
    const analyzedResults = results.map(result => ({
      ...result,
      analysis: result.data ? analyzeOccupancy(result) : null
    }));
    
    res.json({
      metadata: {
        feedType,
        operatorId: OPERATOR_ID,
        testedAt: new Date().toISOString(),
        parametersTested: TEST_PARAMETERS
      },
      results: analyzedResults,
      summary: {
        successfulTests: analyzedResults.filter(r => r.status === 'success').length,
        failedTests: analyzedResults.filter(r => r.status === 'error').length,
        foundOccupancy: analyzedResults.filter(r => 
          r.analysis && r.analysis.withOccupancy > 0
        ).length
      }
    });
  } catch (error) {
    console.error('Error testing parameters:', error);
    res.status(500).json({ error: 'Failed to test parameters', details: error.message });
  }
});

// Endpoint to get raw feed with custom parameters
app.get('/api/buses/raw', async (req, res) => {
  if (!root) return res.status(500).json({ error: 'Proto not loaded' });

  try {
    const feedType = req.query.feed || FEED_TYPES.VEHICLE_UPDATES;
    const customParams = req.query.params || '';
    
    const result = await fetchFeed(feedType, customParams);
    res.json(result);
  } catch (error) {
    console.error('Error fetching raw feed:', error);
    res.status(500).json({ error: 'Failed to fetch raw feed', details: error.message });
  }
});

// Endpoint to check what's available
app.get('/api/buses/info', async (req, res) => {
  res.json({
    operator: {
      id: OPERATOR_ID,
      name: 'Revelstoke (BC Transit)',
      description: 'Revelstoke Transit System'
    },
    availableFeeds: Object.entries(FEED_TYPES).map(([key, value]) => ({
      name: key,
      endpoint: value,
      url: `${BASE_URL}/${value}?operatorIds=${OPERATOR_ID}`,
      description: key === 'VEHICLE_UPDATES' ? 'Real-time vehicle positions and status' :
                   key === 'TRIP_UPDATES' ? 'Trip predictions and schedule updates' :
                   'Service alerts and notifications'
    })),
    occupancyTesting: {
      available: true,
      endpoint: '/api/buses/test-parameters?feed=vehicleupdates.pb',
      parameters: TEST_PARAMETERS
    },
    usage: {
      getAllFeeds: 'GET /api/buses',
      testParameters: 'GET /api/buses/test-parameters?feed=vehicleupdates.pb',
      rawFeed: 'GET /api/buses/raw?feed=vehicleupdates.pb&params=detailed=true',
      thisInfo: 'GET /api/buses/info'
    }
  });
});

// Health check endpoint
app.get('/api/buses/health', async (req, res) => {
  try {
    const test = await fetchFeed(FEED_TYPES.VEHICLE_UPDATES);
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      feedsAvailable: test.status === 'success',
      protoLoaded: root !== null
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>🚌 Revelstoke Bus Proxy Server</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
        h1 { color: #2c3e50; }
        .endpoint { background: #f8f9fa; padding: 15px; margin: 10px 0; border-left: 4px solid #3498db; }
        code { background: #e8f4f8; padding: 2px 6px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <h1>🚌 Revelstoke Bus Proxy Server</h1>
      <p>Real-time BC Transit data for Revelstoke (Operator ID: ${OPERATOR_ID})</p>
      
      <h2>Available Endpoints:</h2>
      
      <div class="endpoint">
        <strong>GET <code>/api/buses</code></strong>
        <p>Get all real-time feeds (vehicle positions, trip updates, alerts)</p>
      </div>
      
      <div class="endpoint">
        <strong>GET <code>/api/buses/test-parameters</code></strong>
        <p>Test different parameters to find occupancy data</p>
        <p>Try: <a href="/api/buses/test-parameters?feed=vehicleupdates.pb" target="_blank">/api/buses/test-parameters?feed=vehicleupdates.pb</a></p>
      </div>
      
      <div class="endpoint">
        <strong>GET <code>/api/buses/raw?feed=vehicleupdates.pb&params=detailed=true</code></strong>
        <p>Fetch raw feed with custom parameters</p>
      </div>
      
      <div class="endpoint">
        <strong>GET <code>/api/buses/info</code></strong>
        <p>Get information about available feeds and endpoints</p>
      </div>
      
      <div class="endpoint">
        <strong>GET <code>/api/buses/health</code></strong>
        <p>Server health check</p>
      </div>
      
      <h2>Quick Links:</h2>
      <ul>
        <li><a href="/api/buses" target="_blank">All Feeds</a></li>
        <li><a href="/api/buses/info" target="_blank">API Info</a></li>
        <li><a href="/api/buses/health" target="_blank">Health Check</a></li>
      </ul>
    </body>
    </html>
  `);
});

// Export for Vercel
export default app;
