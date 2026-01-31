import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import unzipper from 'unzipper';
import { Readable } from 'stream';

const SCHEDULE_DIR = path.join(process.cwd(), 'schedules', 'operator_36');
const GTFS_URL = 'https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=36';

class ScheduleLoader {
  constructor() {
    this.scheduleData = {
      routesMap: {},
      tripsMap: {},
      stops: {},
      stopTimesByTrip: {},
      shapes: {}
    };
  }

  /**
 * Main method to load schedule data
 * Tries API first → falls back to local files if anything fails
 */
async loadSchedules() {
  try {
    console.log(`[${new Date().toISOString()}] 🚀 Fetching fresh GTFS from BC Transit for operator 36...`);
    const response = await fetch(GTFS_URL, { timeout: 30000 });
    
    if (!response.ok) {
      throw new Error(`GTFS fetch failed: ${response.status} ${response.statusText}`);
    }

    const zipBuffer = await response.arrayBuffer();
    console.log(`📦 ZIP downloaded, size: ${(zipBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

    // Use unzipper to extract files
    const directory = await unzipper.Open.buffer(Buffer.from(zipBuffer));
    console.log(`📁 ZIP contains ${directory.files.length} files`);
    
    const requiredFiles = ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'shapes.txt'];
    const files = {};
    
    // Extract required files
    for (const fileName of requiredFiles) {
      const fileEntry = directory.files.find(f => f.path === fileName);
      if (!fileEntry) {
        console.warn(`⚠️ File not found in ZIP: ${fileName}`);
        files[fileName] = '';
        continue;
      }
      
      try {
        const content = await fileEntry.buffer();
        const text = content.toString('utf8');
        files[fileName] = text;
        console.log(`✅ Extracted ${fileName}: ${text.length} chars`);
        
        // Log first line for verification
        const firstLine = text.split('\n')[0];
        console.log(`   First line: ${firstLine?.substring(0, 80)}${firstLine?.length > 80 ? '...' : ''}`);
        
      } catch (fileError) {
        console.error(`❌ Failed to extract ${fileName}:`, fileError.message);
        files[fileName] = '';
      }
    }

    // Parse each file
    console.log('\n📊 Parsing GTFS files:');
    const routes = this.parseCSV(files['routes.txt']);
    const trips = this.parseCSV(files['trips.txt']);
    const stops = this.parseCSV(files['stops.txt']);
    const stopTimes = this.parseCSV(files['stop_times.txt']);
    const shapes = this.parseCSV(files['shapes.txt']);

    console.log(`\n📈 Parsed counts:`);
    console.log(`   Routes: ${routes.length}`);
    console.log(`   Trips: ${trips.length}`);
    console.log(`   Stops: ${stops.length}`);
    console.log(`   Stop Times: ${stopTimes.length}`);
    console.log(`   Shapes: ${shapes.length}`);

    // Build data structures
    this.scheduleData.routesMap = this.createRoutesMap(routes);
    this.scheduleData.tripsMap = this.createTripsMap(trips);
    this.scheduleData.stops = this.createStopsMap(stops);
    this.scheduleData.stopTimesByTrip = this.createStopTimesByTrip(stopTimes);
    this.scheduleData.shapes = this.createShapesMap(shapes);

    console.log(`\n🎉 [${new Date().toISOString()}] Successfully loaded fresh GTFS data from API`);
    console.log(`   Stops loaded: ${Object.keys(this.scheduleData.stops).length}`);
    console.log(`   Trips loaded: ${Object.keys(this.scheduleData.tripsMap).length}`);
    console.log(`   Shapes loaded: ${Object.keys(this.scheduleData.shapes).length}`);
    
    // Verify specific stops from your example
    console.log(`\n🔍 Verifying key stops:`);
    const keyStops = ['156087', '156011', '156083'];
    keyStops.forEach(stopId => {
      const stop = this.scheduleData.stops[stopId];
      console.log(`   ${stopId}: ${stop ? `✓ "${stop.name}" at ${stop.lat},${stop.lon}` : '✗ NOT FOUND'}`);
    });

    return this.scheduleData;
    
  } catch (error) {
    console.error(`\n❌ [${new Date().toISOString()}] Failed to load dynamic GTFS:`, error.message);
    console.error('Stack trace:', error.stack);
    
    console.log('\n🔄 Falling back to local static GTFS files...');
    return await this.loadFromLocal();
  }
}

  async loadFromLocal() {
  try {
    console.log('Attempting to load from local GTFS files...');
    
    const fileNames = ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'shapes.txt'];
    const files = {};
    
    for (const fileName of fileNames) {
      try {
        const filePath = path.join(SCHEDULE_DIR, fileName);
        const content = await fs.readFile(filePath, 'utf-8');
        files[fileName] = content;
        console.log(`Read local ${fileName}: ${content.length} chars`);
        
        // Show first line
        const firstLine = content.split('\n')[0];
        console.log(`  First line: ${firstLine?.substring(0, 100)}...`);
      } catch (fileError) {
        console.error(`Failed to read local file ${fileName}:`, fileError.message);
      }
    }
    
    const routes = this.parseCSV(files['routes.txt'] || '');
    const trips = this.parseCSV(files['trips.txt'] || '');
    const stops = this.parseCSV(files['stops.txt'] || '');
    const stopTimes = this.parseCSV(files['stop_times.txt'] || '');
    const shapes = this.parseCSV(files['shapes.txt'] || '');
    
    console.log(`Local parsed counts: ${routes.length} routes, ${trips.length} trips, ${stops.length} stops`);
    
    this.scheduleData.routesMap = this.createRoutesMap(routes);
    this.scheduleData.tripsMap = this.createTripsMap(trips);
    this.scheduleData.stops = this.createStopsMap(stops);
    this.scheduleData.stopTimesByTrip = this.createStopTimesByTrip(stopTimes);
    this.scheduleData.shapes = this.createShapesMap(shapes);
    
    console.log(`[${new Date().toISOString()}] Loaded schedule data from local fallback files`);
    
    return this.scheduleData;
  } catch (localError) {
    console.error('Local fallback failed:', localError.message);
    console.error('Stack:', localError.stack);
    throw localError;
  }
}
  // Improved CSV parser that handles quoted fields properly
  // Improved CSV parser that handles your file format
parseCSV(csvString) {
  if (!csvString || csvString.trim().length === 0) {
    console.warn('⚠️ parseCSV: Empty CSV string');
    return [];
  }
  
  const lines = csvString.split(/\r?\n/).filter(line => line.trim() !== '');
  console.log(`📄 parseCSV: Found ${lines.length} lines`);
  
  if (lines.length < 2) {
    console.warn('⚠️ parseCSV: Not enough lines (need at least header + 1 data row)');
    return [];
  }

  // Parse headers from first line
  const headers = lines[0].split(',').map(h => h.trim());
  console.log(`📋 Headers (${headers.length}): ${headers.join(', ')}`);

  const result = [];
  let skippedRows = 0;
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      skippedRows++;
      continue;
    }

    // Simple split - your files don't have quoted commas
    const values = line.split(',').map(v => v.trim());
    
    if (values.length !== headers.length) {
      console.warn(`⚠️ Line ${i}: Column mismatch. Expected ${headers.length}, got ${values.length}`);
      console.warn(`   Line: "${line.substring(0, 100)}..."`);
      skippedRows++;
      continue;
    }

    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[j] || '';
    }
    
    result.push(obj);
  }
  
  console.log(`✅ parseCSV: Parsed ${result.length} rows, skipped ${skippedRows}`);
  
  if (result.length > 0) {
    console.log('📝 First row sample:');
    Object.entries(result[0]).forEach(([key, value]) => {
      console.log(`   ${key}: ${value}`);
    });
  }
  
  return result;
}

  // ────────────────────────────────────────────────
  // Map-building methods
  // ────────────────────────────────────────────────

  createRoutesMap(routesArray) {
    const map = {};
    routesArray.forEach(route => {
      map[route.route_id] = route;
    });
    return map;
  }

  createTripsMap(tripsArray) {
    const map = {};
    tripsArray.forEach(trip => {
      map[trip.trip_id] = trip;
    });
    return map;
  }

  createStopsMap(stopsArray) {
  console.log(`createStopsMap: Processing ${stopsArray?.length || 0} stops`);
  
  const map = {};
  let validCount = 0;
  
  if (!stopsArray || stopsArray.length === 0) {
    console.error('createStopsMap: No stops data provided');
    return map;
  }
  
  // Show first stop structure
  console.log('Sample stop structure:', stopsArray[0]);
  
  stopsArray.forEach((stop, index) => {
    try {
      // Use the exact field names from your sample
      const stopId = stop.stop_id;
      const lat = parseFloat(stop.stop_lat);
      const lon = parseFloat(stop.stop_lon);
      const name = stop.stop_name || 'Unknown';
      
      if (!stopId) {
        console.warn(`Stop at index ${index} has no ID`);
        return;
      }
      
      if (isNaN(lat) || isNaN(lon)) {
        console.warn(`Stop ${stopId} has invalid coordinates: lat=${stop.stop_lat}, lon=${stop.stop_lon}`);
        return;
      }
      
      // Store with the exact ID from the file
      map[stopId] = {
        lat,
        lon,
        name
      };
      validCount++;
      
      // Log a few for verification
      if (validCount <= 3) {
        console.log(`✓ Added stop ${stopId}: "${name}" at ${lat}, ${lon}`);
      }
    } catch (err) {
      console.warn(`Error processing stop at index ${index}:`, err.message);
    }
  });
  
  console.log(`createStopsMap: Successfully loaded ${validCount} stops out of ${stopsArray.length}`);
  
  // Verify we found the stops from your virtual bus example
  const testStops = ['156087', '156011', '156083'];
  testStops.forEach(id => {
    console.log(`Stop ${id} in map: ${map[id] ? 'YES' : 'NO'}`);
  });
  
  return map;
}

  createStopTimesByTrip(stopTimesArray) {
    const byTrip = {};
    stopTimesArray.forEach(st => {
      const tripId = st.trip_id;
      if (!byTrip[tripId]) byTrip[tripId] = [];
      byTrip[tripId].push({
        trip_id: st.trip_id,
        arrival_time: st.arrival_time,
        departure_time: st.departure_time,
        stop_id: st.stop_id,
        stop_sequence: parseInt(st.stop_sequence, 10),
        shape_dist_traveled: st.shape_dist_traveled ? parseFloat(st.shape_dist_traveled) : null,
      });
    });
    console.log(`[StopTimes] Indexed ${Object.keys(byTrip).length} trips`);
    return byTrip;
  }

  createShapesMap(shapesArray) {
    const shapes = {};
    shapesArray.forEach(pt => {
      const sid = pt.shape_id;
      if (!shapes[sid]) shapes[sid] = [];
      shapes[sid].push({
        lat: parseFloat(pt.shape_pt_lat),
        lon: parseFloat(pt.shape_pt_lon),
        sequence: parseInt(pt.shape_pt_sequence, 10),
        dist: pt.shape_dist_traveled ? parseFloat(pt.shape_dist_traveled) : null
      });
    });

    Object.values(shapes).forEach(points => {
      points.sort((a, b) => a.sequence - b.sequence);
    });

    console.log(`[Shapes] Loaded ${Object.keys(shapes).length} shape IDs`);
    return shapes;
  }
}

export default ScheduleLoader;
