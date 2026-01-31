import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import protobuf from 'protobufjs';
import virtualVehicleManager from './virtual-vehicles.js';
import virtualUpdater from './virtual-updater.js';
import ScheduleLoader from './schedule-loader.js';
import fs from 'fs/promises';
import path from 'path';

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

// ==================== TESTING ENDPOINTS ====================
import fs from 'fs/promises';
import path from 'path';

// Add this to your debugging endpoints section
app.get('/api/debug/csv-raw', async (req, res) => {
  try {
    const { file, limit, showall } = req.query;
    const SCHEDULE_DIR = path.join(process.cwd(), 'schedules', 'operator_36');
    
    // List available files
    const files = await fs.readdir(SCHEDULE_DIR);
    const txtFiles = files.filter(f => f.endsWith('.txt'));
    
    // If specific file requested
    if (file) {
      if (!txtFiles.includes(file)) {
        return res.status(404).json({
          error: 'File not found',
          available_files: txtFiles,
          requested: file
        });
      }
      
      const filePath = path.join(SCHEDULE_DIR, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const headers = lines[0] ? lines[0].split(',') : [];
      
      const rowLimit = parseInt(limit) || (showall === 'true' ? lines.length : 50);
      const limitedLines = lines.slice(0, Math.min(rowLimit, lines.length));
      
      // Parse CSV rows
      const data = limitedLines.map((line, index) => {
        if (index === 0) return { row: 0, type: 'header', values: headers };
        
        const values = line.split(',');
        const rowData = {};
        headers.forEach((header, i) => {
          rowData[header.trim()] = values[i] ? values[i].trim() : '';
        });
        
        return {
          row: index,
          type: 'data',
          values: values,
          parsed: rowData
        };
      });
      
      return res.json({
        file,
        path: filePath,
        stats: {
          total_lines: lines.length,
          data_rows: lines.length - 1,
          showing_rows: limitedLines.length - 1,
          headers_count: headers.length,
          file_size_bytes: content.length
        },
        headers: headers,
        sample_data: data
      });
    }
    
    // Return list of files with previews
    const filePreviews = {};
    
    for (const fileName of txtFiles.slice(0, 10)) { // Limit to 10 files
      try {
        const filePath = path.join(SCHEDULE_DIR, fileName);
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const headers = lines[0] ? lines[0].split(',') : [];
        
        filePreviews[fileName] = {
          lines: lines.length,
          headers: headers,
          first_data_row: lines[1] ? lines[1].split(',') : [],
          sample: lines.slice(0, 3).map(line => line.split(','))
        };
      } catch (err) {
        filePreviews[fileName] = { error: err.message };
      }
    }
    
    // Check for specific critical files
    const criticalFiles = ['stops.txt', 'trips.txt', 'stop_times.txt', 'shapes.txt', 'routes.txt'];
    const criticalStatus = {};
    
    for (const criticalFile of criticalFiles) {
      const filePath = path.join(SCHEDULE_DIR, criticalFile);
      try {
        await fs.access(filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        criticalStatus[criticalFile] = {
          exists: true,
          lines: lines.length,
          has_data: lines.length > 1
        };
      } catch {
        criticalStatus[criticalFile] = { exists: false };
      }
    }
    
    res.json({
      schedule_dir: SCHEDULE_DIR,
      files_found: txtFiles,
      total_files: txtFiles.length,
      critical_files_status: criticalStatus,
      file_previews: filePreviews,
      usage_note: 'Use ?file=stops.txt to see specific file contents'
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      stack: error.stack,
      schedule_dir_exists: await fs.access(path.join(process.cwd(), 'schedules')).then(() => true).catch(() => false)
    });
  }
});

app.get('/api/debug/csv-structure', async (req, res) => {
  try {
    const SCHEDULE_DIR = path.join(process.cwd(), 'schedules', 'operator_36');
    const criticalFiles = ['stops.txt', 'trips.txt', 'stop_times.txt', 'shapes.txt', 'routes.txt'];
    
    const analysis = {};
    
    for (const file of criticalFiles) {
      const filePath = path.join(SCHEDULE_DIR, file);
      try {
        await fs.access(filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        
        if (lines.length === 0) {
          analysis[file] = { exists: true, empty: true };
          continue;
        }
        
        const headers = lines[0].split(',');
        const sampleRows = lines.slice(1, 6).map(line => {
          const values = line.split(',');
          const row = {};
          headers.forEach((header, i) => {
            row[header.trim()] = values[i] ? values[i].trim() : '';
          });
          return row;
        });
        
        analysis[file] = {
          exists: true,
          lines: lines.length,
          data_rows: lines.length - 1,
          headers: headers,
          header_count: headers.length,
          sample_rows: sampleRows,
          field_types: headers.map(header => {
            const sampleValues = sampleRows.map(row => row[header]);
            return {
              field: header,
              sample_values: sampleValues,
              likely_type: determineFieldType(sampleValues)
            };
          })
        };
        
      } catch (err) {
        analysis[file] = { exists: false, error: err.message };
      }
    }
    
    // Check for data consistency
    const stopsFile = analysis['stops.txt'];
    const tripsFile = analysis['trips.txt'];
    const stopTimesFile = analysis['stop_times.txt'];
    
    const consistency = {};
    
    if (stopsFile.exists && tripsFile.exists && stopTimesFile.exists) {
      const stopIds = new Set();
      const tripIds = new Set();
      const routeIds = new Set();
      
      // Extract IDs from sample data
      if (stopsFile.sample_rows) {
        stopsFile.sample_rows.forEach(row => {
          if (row.stop_id) stopIds.add(row.stop_id);
        });
      }
      
      if (tripsFile.sample_rows) {
        tripsFile.sample_rows.forEach(row => {
          if (row.trip_id) tripIds.add(row.trip_id);
          if (row.route_id) routeIds.add(row.route_id);
        });
      }
      
      consistency.stops = {
        unique_ids_in_sample: stopIds.size,
        sample_ids: Array.from(stopIds).slice(0, 5)
      };
      
      consistency.trips = {
        unique_ids_in_sample: tripIds.size,
        unique_routes_in_sample: routeIds.size,
        sample_trip_ids: Array.from(tripIds).slice(0, 5)
      };
    }
    
    res.json({
      analysis,
      consistency,
      summary: {
        all_critical_files_exist: criticalFiles.every(f => analysis[f]?.exists),
        total_records: Object.values(analysis).reduce((sum, file) => 
          sum + (file.data_rows || 0), 0
        )
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function determineFieldType(values) {
  if (values.length === 0) return 'unknown';
  
  const sample = values.filter(v => v !== '');
  if (sample.length === 0) return 'empty';
  
  // Check for numeric
  if (sample.every(v => !isNaN(v) && v.trim() !== '')) {
    // Check if all are integers
    if (sample.every(v => Number.isInteger(parseFloat(v)))) {
      return 'integer';
    }
    return 'float';
  }
  
  // Check for coordinates
  if (sample.every(v => {
    const num = parseFloat(v);
    return !isNaN(num) && num >= -180 && num <= 180;
  })) {
    return 'coordinate';
  }
  
  // Check for time (HH:MM:SS format)
  const timeRegex = /^\d{1,2}:\d{2}:\d{2}$/;
  if (sample.every(v => timeRegex.test(v))) {
    return 'time';
  }
  
  // Check for IDs (often numeric or alphanumeric)
  const idRegex = /^[A-Za-z0-9:_\-]+$/;
  if (sample.every(v => idRegex.test(v))) {
    return 'id';
  }
  
  return 'text';
}

app.get('/api/debug/csv-validate', async (req, res) => {
  try {
    const SCHEDULE_DIR = path.join(process.cwd(), 'schedules', 'operator_36');
    const files = ['stops.txt', 'trips.txt', 'stop_times.txt', 'shapes.txt'];
    
    const validationResults = {};
    const issues = [];
    
    for (const file of files) {
      const filePath = path.join(SCHEDULE_DIR, file);
      try {
        await fs.access(filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        
        if (lines.length === 0) {
          validationResults[file] = { valid: false, error: 'File is empty' };
          issues.push(`${file}: Empty file`);
          continue;
        }
        
        const headers = lines[0].split(',');
        const dataLines = lines.slice(1);
        
        // Check for consistent column count
        const inconsistentRows = [];
        dataLines.forEach((line, index) => {
          const columns = line.split(',');
          if (columns.length !== headers.length) {
            inconsistentRows.push({
              line: index + 2, // +2 for header line and 1-based index
              expected: headers.length,
              actual: columns.length,
              content: line.substring(0, 100)
            });
          }
        });
        
        // Check for required fields based on file type
        const requiredFields = {
          'stops.txt': ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
          'trips.txt': ['trip_id', 'route_id', 'service_id'],
          'stop_times.txt': ['trip_id', 'stop_id', 'stop_sequence'],
          'shapes.txt': ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence']
        };
        
        const missingFields = [];
        if (requiredFields[file]) {
          requiredFields[file].forEach(field => {
            if (!headers.includes(field)) {
              missingFields.push(field);
            }
          });
        }
        
        validationResults[file] = {
          valid: inconsistentRows.length === 0 && missingFields.length === 0,
          stats: {
            total_lines: lines.length,
            data_rows: dataLines.length,
            header_count: headers.length,
            inconsistent_rows: inconsistentRows.length,
            missing_required_fields: missingFields.length
          },
          headers: headers,
          issues: {
            inconsistent_rows: inconsistentRows.slice(0, 5),
            missing_fields: missingFields
          }
        };
        
        if (inconsistentRows.length > 0) {
          issues.push(`${file}: ${inconsistentRows.length} rows with inconsistent column count`);
        }
        if (missingFields.length > 0) {
          issues.push(`${file}: Missing required fields: ${missingFields.join(', ')}`);
        }
        
      } catch (err) {
        validationResults[file] = { valid: false, error: err.message };
        issues.push(`${file}: ${err.message}`);
      }
    }
    
    // Check referential integrity
    const integrityIssues = await checkReferentialIntegrity(SCHEDULE_DIR);
    issues.push(...integrityIssues);
    
    res.json({
      validation_time: new Date().toISOString(),
      overall_valid: issues.length === 0,
      total_issues: issues.length,
      validation_results: validationResults,
      issues: issues,
      recommendations: issues.length === 0 ? 
        ['All CSV files are valid'] : 
        ['Fix the issues listed above']
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function checkReferentialIntegrity(scheduleDir) {
  const issues = [];
  
  try {
    // Read stops
    const stopsPath = path.join(scheduleDir, 'stops.txt');
    const stopsContent = await fs.readFile(stopsPath, 'utf-8');
    const stopsLines = stopsContent.split('\n').filter(line => line.trim());
    const stopIds = new Set();
    
    if (stopsLines.length > 1) {
      const headers = stopsLines[0].split(',');
      const stopIdIndex = headers.indexOf('stop_id');
      if (stopIdIndex !== -1) {
        stopsLines.slice(1).forEach(line => {
          const values = line.split(',');
          if (values[stopIdIndex]) {
            stopIds.add(values[stopIdIndex].trim());
          }
        });
      }
    }
    
    // Read trips
    const tripsPath = path.join(scheduleDir, 'trips.txt');
    const tripsContent = await fs.readFile(tripsPath, 'utf-8');
    const tripsLines = tripsContent.split('\n').filter(line => line.trim());
    const tripIds = new Set();
    
    if (tripsLines.length > 1) {
      const headers = tripsLines[0].split(',');
      const tripIdIndex = headers.indexOf('trip_id');
      if (tripIdIndex !== -1) {
        tripsLines.slice(1).forEach(line => {
          const values = line.split(',');
          if (values[tripIdIndex]) {
            tripIds.add(values[tripIdIndex].trim());
          }
        });
      }
    }
    
    // Read stop_times and check references
    const stopTimesPath = path.join(scheduleDir, 'stop_times.txt');
    const stopTimesContent = await fs.readFile(stopTimesPath, 'utf-8');
    const stopTimesLines = stopTimesContent.split('\n').filter(line => line.trim());
    
    if (stopTimesLines.length > 1) {
      const headers = stopTimesLines[0].split(',');
      const tripIdIndex = headers.indexOf('trip_id');
      const stopIdIndex = headers.indexOf('stop_id');
      
      const missingTripRefs = new Set();
      const missingStopRefs = new Set();
      
      stopTimesLines.slice(1, 100).forEach((line, index) => { // Check first 100 rows
        const values = line.split(',');
        const tripId = tripIdIndex !== -1 ? values[tripIdIndex]?.trim() : null;
        const stopId = stopIdIndex !== -1 ? values[stopIdIndex]?.trim() : null;
        
        if (tripId && !tripIds.has(tripId)) {
          missingTripRefs.add(tripId);
        }
        
        if (stopId && !stopIds.has(stopId)) {
          missingStopRefs.add(stopId);
        }
      });
      
      if (missingTripRefs.size > 0) {
        issues.push(`stop_times.txt: ${missingTripRefs.size} trip_id references not found in trips.txt`);
      }
      if (missingStopRefs.size > 0) {
        issues.push(`stop_times.txt: ${missingStopRefs.size} stop_id references not found in stops.txt`);
      }
    }
    
  } catch (err) {
    issues.push(`Referential integrity check failed: ${err.message}`);
  }
  
  return issues;
}

app.get('/api/debug/csv-export', async (req, res) => {
  try {
    const { file, format } = req.query;
    const SCHEDULE_DIR = path.join(process.cwd(), 'schedules', 'operator_36');
    
    if (!file) {
      return res.status(400).json({
        error: 'File parameter required',
        example: '/api/debug/csv-export?file=stops.txt&format=json'
      });
    }
    
    const filePath = path.join(SCHEDULE_DIR, file);
    await fs.access(filePath);
    
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    
    if (lines.length === 0) {
      return res.json({ file, empty: true });
    }
    
    const headers = lines[0].split(',');
    const data = lines.slice(1).map((line, index) => {
      const values = line.split(',');
      const row = { _row: index + 1 };
      headers.forEach((header, i) => {
        row[header.trim()] = values[i] ? values[i].trim() : '';
      });
      return row;
    }).filter(row => Object.values(row).some(val => val !== ''));
    
    if (format === 'csv') {
      // Return as CSV download
      res.header('Content-Type', 'text/csv');
      res.header('Content-Disposition', `attachment; filename="${file}"`);
      return res.send(content);
    } else if (format === 'raw') {
      // Return raw content
      res.header('Content-Type', 'text/plain');
      return res.send(content);
    } else {
      // Return as JSON (default)
      return res.json({
        file,
        headers,
        row_count: data.length,
        data: data.slice(0, 1000), // Limit to 1000 rows
        truncated: data.length > 1000 ? data.length - 1000 : 0
      });
    }
    
  } catch (error) {
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
app.get('/api/debug/gtfs-files', async (req, res) => {
  try {
    const SCHEDULE_DIR = path.join(process.cwd(), 'schedules', 'operator_36');
    
    // Check what files exist locally
    const files = await fs.readdir(SCHEDULE_DIR);
    const txtFiles = files.filter(f => f.endsWith('.txt'));
    
    const fileContents = {};
    
    for (const fileName of txtFiles) {
      try {
        const filePath = path.join(SCHEDULE_DIR, fileName);
        const content = await fs.readFile(filePath, 'utf-8');
        fileContents[fileName] = {
          size: content.length,
          first_100_chars: content.substring(0, 100),
          line_count: content.split('\n').length
        };
      } catch (err) {
        fileContents[fileName] = { error: err.message };
      }
    }
    
    res.json({
      schedule_dir: SCHEDULE_DIR,
      files_found: txtFiles,
      file_contents: fileContents
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
});

app.get('/api/debug/gtfs-structure', async (req, res) => {
  try {
    // Force reload to see what happens
    console.log('Forcing schedule reload...');
    await scheduleLoader.loadSchedules();
    
    const scheduleData = scheduleLoader.scheduleData;
    
    // Check local directory for files
    let localFiles = {};
    try {
      const files = await fs.readdir(SCHEDULE_DIR);
      localFiles = {
        exists: true,
        file_count: files.length,
        files: files.filter(f => f.endsWith('.txt'))
      };
    } catch (err) {
      localFiles = { exists: false, error: err.message };
    }
    
    res.json({
      schedule_status: {
        loaded: !!scheduleData,
        trips_count: Object.keys(scheduleData?.tripsMap || {}).length,
        stops_count: Object.keys(scheduleData?.stops || {}).length,
        shapes_count: Object.keys(scheduleData?.shapes || {}).length,
        stop_times_count: Object.keys(scheduleData?.stopTimesByTrip || {}).length
      },
      local_files: localFiles,
      sample_data: {
        first_trip_key: Object.keys(scheduleData?.tripsMap || {})[0],
        first_stop_key: Object.keys(scheduleData?.stops || {})[0],
        first_shape_key: Object.keys(scheduleData?.shapes || {})[0]
      }
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
});

app.get('/api/debug/gtfs-raw', async (req, res) => {
  try {
    // Fetch GTFS directly
    const response = await fetch('https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=36');
    const zipBuffer = await response.arrayBuffer();
    
    const zipStream = Readable.from(Buffer.from(zipBuffer)).pipe(unzipper.Parse({ forceStream: true }));
    const files = {};
    
    for await (const entry of zipStream) {
      const fileName = entry.path;
      if (entry.type === 'File' && fileName.endsWith('.txt')) {
        let content = '';
        for await (const chunk of entry) {
          content += chunk.toString('utf8');
        }
        files[fileName] = content.substring(0, 1000); // First 1000 chars
        console.log(`Extracted ${fileName}: ${content.length} chars`);
      } else {
        entry.autodrain();
      }
    }
    
    res.json({
      files_available: Object.keys(files),
      stops_preview: files['stops.txt'] ? files['stops.txt'].split('\n').slice(0, 10) : 'NOT FOUND',
      trips_preview: files['trips.txt'] ? files['trips.txt'].split('\n').slice(0, 10) : 'NOT FOUND'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/schedule', async (req, res) => {
  try {
    if (!scheduleLoader.scheduleData?.tripsMap) {
      await scheduleLoader.loadSchedules();
    }
    
    // Test the exact stops from your virtual buses
    const testStops = ['156087', '156011', '156083'];
    const stopResults = {};
    
    testStops.forEach(stopId => {
      stopResults[stopId] = scheduleLoader.scheduleData?.stops?.[stopId] || 'NOT FOUND';
    });
    
    res.json({
      schedule_loaded: !!scheduleLoader.scheduleData,
      stops_count: Object.keys(scheduleLoader.scheduleData?.stops || {}).length,
      test_stops: stopResults,
      sample_stops: Object.entries(scheduleLoader.scheduleData?.stops || {})
        .slice(0, 5)
        .map(([id, data]) => ({ id, ...data }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
