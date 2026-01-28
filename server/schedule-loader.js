// schedule-loader.js - GTFS Static Schedule Data Loader
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ScheduleLoader {
  constructor() {
    this.scheduleData = null;
    this.stopsMap = null;
    this.tripsMap = null;
    this.stopTimesByTrip = null;
  }

  async loadSchedule(operatorId) {
    try {
      console.log(`📂 Loading schedule data for operator ${operatorId}...`);
      
      // Try multiple possible paths for schedule files
      const possiblePaths = [
        path.join(__dirname, 'schedules', `operator_${operatorId}`),
        path.join(__dirname, 'gtfs-static', `operator_${operatorId}`),
        path.join(__dirname, 'static-data', `operator_${operatorId}`),
        path.join(process.cwd(), 'schedules', `operator_${operatorId}`)
      ];

      let schedulePath = null;
      for (const possiblePath of possiblePaths) {
        try {
          await fs.access(possiblePath);
          schedulePath = possiblePath;
          console.log(`Found schedule data at: ${schedulePath}`);
          break;
        } catch {
          // Path doesn't exist, try next one
          continue;
        }
      }

      if (!schedulePath) {
        console.warn(`⚠️ No schedule directory found for operator ${operatorId}. Using fallback data.`);
        return this.getFallbackSchedule(operatorId);
      }

      // Load GTFS static files (only the essential ones)
      const [tripsRaw, stopsRaw, stopTimesRaw, routesRaw] = await Promise.all([
        this.readOrCreateFile(path.join(schedulePath, 'trips.txt')),
        this.readOrCreateFile(path.join(schedulePath, 'stops.txt')),
        this.readOrCreateFile(path.join(schedulePath, 'stop_times.txt')),
        this.readOrCreateFile(path.join(schedulePath, 'routes.txt'))
      ]);

      // Parse the CSV data
      const trips = this.parseCSV(tripsRaw);
      const stops = this.parseCSV(stopsRaw);
      const stopTimes = this.parseCSV(stopTimesRaw);
      const routes = this.parseCSV(routesRaw);

      this.scheduleData = {
        trips,
        stops: this.createStopsMap(stops),
        stop_times: stopTimes,
        routes,
        loadedAt: new Date().toISOString(),
        operatorId
      };

      // Create lookup maps for fast access
      this.createLookupMaps();

      console.log(`✅ Schedule data loaded successfully!`);
      console.log(`   - ${stops.length} stops`);
      console.log(`   - ${trips.length} trips`);
      console.log(`   - ${stopTimes.length} stop times`);
      
      return this.scheduleData;

    } catch (error) {
      console.warn(`❌ Error loading schedule data: ${error.message}`);
      console.warn('Using fallback schedule data...');
      return this.getFallbackSchedule(operatorId);
    }
  }

  createStopsMap(stopsArray) {
    const stopsMap = {};
    stopsArray.forEach(stop => {
      stopsMap[stop.stop_id] = {
        stop_id: stop.stop_id,
        stop_name: stop.stop_name,
        lat: parseFloat(stop.stop_lat) || 0,
        lon: parseFloat(stop.stop_lon) || 0
      };
    });
    return stopsMap;
  }

  async readOrCreateFile(filePath) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.warn(`File not found: ${filePath}`);
        
        // Create minimal stub files if they don't exist
        if (filePath.endsWith('stops.txt')) {
          return this.createStopsStub();
        } else if (filePath.endsWith('trips.txt')) {
          return this.createTripsStub();
        } else if (filePath.endsWith('stop_times.txt')) {
          return this.createStopTimesStub();
        } else if (filePath.endsWith('routes.txt')) {
          return this.createRoutesStub();
        }
      }
      throw error;
    }
  }

  createStopsStub() {
    return `stop_id,stop_name,stop_lat,stop_lon
stop_001,Main Street Station,49.2827,-123.1207
stop_002,Broadway Station,49.2631,-123.1144
stop_003,Granville Station,49.2830,-123.1150
stop_004,Waterfront Station,49.2859,-123.1115`;
  }

  createTripsStub() {
    return `route_id,service_id,trip_id,trip_headsign,direction_id
route_001,weekday,trip_001,To Downtown,0
route_001,weekday,trip_002,To Uptown,1
route_002,weekday,trip_003,East Loop,0`;
  }

  createStopTimesStub() {
    return `trip_id,arrival_time,departure_time,stop_id,stop_sequence
trip_001,08:00:00,08:00:00,stop_001,1
trip_001,08:10:00,08:10:00,stop_002,2
trip_001,08:20:00,08:20:00,stop_003,3
trip_002,08:30:00,08:30:00,stop_003,1
trip_002,08:40:00,08:40:00,stop_002,2
trip_002,08:50:00,08:50:00,stop_001,3`;
  }

  createRoutesStub() {
    return `route_id,route_short_name,route_long_name,route_type
route_001,1,Main Street Line,3
route_002,2,Broadway Line,3`;
  }

  parseCSV(csvText) {
    if (!csvText || csvText.trim() === '') {
      return [];
    }
    
    const lines = csvText.split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) return [];
    
    const headers = lines[0].split(',').map(h => h.trim());
    
    return lines.slice(1).map(line => {
      // Handle quoted fields and commas within values
      const values = this.parseCSVLine(line);
      const obj = {};
      
      headers.forEach((header, index) => {
        if (index < values.length) {
          obj[header] = values[index] ? values[index].trim() : '';
        } else {
          obj[header] = '';
        }
      });
      
      return obj;
    });
  }

  parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];
      
      if (char === '"' && !inQuotes) {
        inQuotes = true;
      } else if (char === '"' && inQuotes && nextChar === '"') {
        current += '"';
        i++; // Skip next quote
      } else if (char === '"' && inQuotes) {
        inQuotes = false;
      } else if (char === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    
    values.push(current);
    return values;
  }

  createLookupMaps() {
    // Create stops lookup map
    this.stopsMap = this.scheduleData.stops;

    // Create trips lookup map
    this.tripsMap = {};
    this.scheduleData.trips.forEach(trip => {
      this.tripsMap[trip.trip_id] = trip;
    });

    // Group stop times by trip
    this.stopTimesByTrip = {};
    this.scheduleData.stop_times.forEach(stopTime => {
      const tripId = stopTime.trip_id;
      if (!this.stopTimesByTrip[tripId]) {
        this.stopTimesByTrip[tripId] = [];
      }
      this.stopTimesByTrip[tripId].push({
        stop_id: stopTime.stop_id,
        arrival_time: stopTime.arrival_time,
        departure_time: stopTime.departure_time,
        stop_sequence: parseInt(stopTime.stop_sequence) || 0
      });
    });

    // Sort stop times by sequence for each trip
    Object.keys(this.stopTimesByTrip).forEach(tripId => {
      this.stopTimesByTrip[tripId].sort((a, b) => a.stop_sequence - b.stop_sequence);
    });
  }

  getFallbackSchedule(operatorId) {
    console.log(`Using fallback schedule for operator ${operatorId}`);
    
    // Fallback coordinates for major BC cities based on operator ID
    const fallbackLocations = {
      '36': { 
        name: 'Revelstoke',
        center: { lat: 50.9981, lon: -118.1957 },
        stops: {
          '156011': { stop_id: '156011', stop_name: 'Downtown Exchange', lat: 50.9981, lon: -118.1957 },
          '156087': { stop_id: '156087', stop_name: 'Big Eddy', lat: 51.0050, lon: -118.2150 },
          '156083': { stop_id: '156083', stop_name: 'Uptown', lat: 50.9975, lon: -118.2020 },
          '156101': { stop_id: '156101', stop_name: 'Highway 23', lat: 50.9910, lon: -118.1890 }
        }
      },
      '47': { 
        name: 'Kelowna',
        center: { lat: 49.8880, lon: -119.4960 },
        stops: {
          'stop_001': { stop_id: 'stop_001', stop_name: 'Kelowna Downtown', lat: 49.8880, lon: -119.4960 },
          'stop_002': { stop_id: 'stop_002', stop_name: 'Uptown Kelowna', lat: 49.8830, lon: -119.4900 }
        }
      },
      '48': { 
        name: 'Victoria',
        center: { lat: 48.4284, lon: -123.3656 },
        stops: {
          'stop_001': { stop_id: 'stop_001', stop_name: 'Victoria Downtown', lat: 48.4284, lon: -123.3656 },
          'stop_002': { stop_id: 'stop_002', stop_name: 'Uptown Victoria', lat: 48.4350, lon: -123.3550 }
        }
      }
    };
    
    const location = fallbackLocations[operatorId] || { 
      name: 'Unknown',
      center: { lat: 49.2827, lon: -123.1207 },
      stops: {
        'stop_001': { stop_id: 'stop_001', stop_name: 'Downtown', lat: 49.2827, lon: -123.1207 },
        'stop_002': { stop_id: 'stop_002', stop_name: 'Uptown', lat: 49.2830, lon: -123.1150 }
      }
    };
    
    this.scheduleData = {
      trips: [
        { trip_id: 'trip_001', route_id: 'route_001', direction_id: '0', service_id: 'weekday' },
        { trip_id: 'trip_002', route_id: 'route_001', direction_id: '1', service_id: 'weekday' },
        { trip_id: 'trip_003', route_id: 'route_002', direction_id: '0', service_id: 'weekday' }
      ],
      stops: location.stops,
      stop_times: [
        { trip_id: 'trip_001', stop_id: Object.keys(location.stops)[0], arrival_time: '08:00:00', departure_time: '08:00:00', stop_sequence: '1' },
        { trip_id: 'trip_001', stop_id: Object.keys(location.stops)[1], arrival_time: '08:30:00', departure_time: '08:30:00', stop_sequence: '2' },
        { trip_id: 'trip_002', stop_id: Object.keys(location.stops)[1], arrival_time: '09:00:00', departure_time: '09:00:00', stop_sequence: '1' },
        { trip_id: 'trip_002', stop_id: Object.keys(location.stops)[0], arrival_time: '09:30:00', departure_time: '09:30:00', stop_sequence: '2' },
        { trip_id: 'trip_003', stop_id: Object.keys(location.stops)[2], arrival_time: '10:00:00', departure_time: '10:00:00', stop_sequence: '1' },
        { trip_id: 'trip_003', stop_id: Object.keys(location.stops)[3], arrival_time: '10:30:00', departure_time: '10:30:00', stop_sequence: '2' }
      ],
      routes: [
        { route_id: 'route_001', route_short_name: '1', route_long_name: `${location.name} Main Line`, route_type: '3' },
        { route_id: 'route_002', route_short_name: '2', route_long_name: `${location.name} Loop Line`, route_type: '3' }
      ],
      loadedAt: new Date().toISOString(),
      operatorId,
      isFallback: true,
      locationName: location.name
    };

    this.createLookupMaps();
    return this.scheduleData;
  }

  getStopInfo(stopId) {
    return this.stopsMap?.[stopId] || null;
  }

  getTripInfo(tripId) {
    return this.tripsMap?.[tripId] || null;
  }

  getStopTimesForTrip(tripId) {
    return this.stopTimesByTrip?.[tripId] || [];
  }
}

// Create and export a singleton instance
const scheduleLoader = new ScheduleLoader();
export default scheduleLoader;
