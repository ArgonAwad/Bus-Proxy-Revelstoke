// server/schedule-loader.js
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
      console.log(`[${new Date().toISOString()}] Fetching fresh GTFS from BC Transit for operator 36...`);
      const response = await fetch(GTFS_URL, {
        timeout: 30000 // 30 seconds timeout
      });

      if (!response.ok) {
        throw new Error(`GTFS fetch failed: ${response.status} ${response.statusText}`);
      }

      // Get the ZIP as buffer
      const zipBuffer = await response.arrayBuffer();

      // Unzip in memory
      const zipStream = Readable.from(Buffer.from(zipBuffer)).pipe(
        unzipper.Parse({ forceStream: true })
      );

      const files = {};

      for await (const entry of zipStream) {
        const fileName = entry.path;
        if (entry.type === 'File' && fileName.endsWith('.txt')) {
          let content = '';
          for await (const chunk of entry) {
            content += chunk.toString('utf8');
          }
          files[fileName] = content;
          console.log(`  Extracted: ${fileName} (${content.length} chars)`);
        } else {
          entry.autodrain();
        }
      }

      // Check required files
      const requiredFiles = ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'shapes.txt'];
      for (const file of requiredFiles) {
        if (!files[file]) {
          throw new Error(`Missing required file in GTFS ZIP: ${file}`);
        }
      }

      // Parse all CSVs
      const routes = this.parseCSV(files['routes.txt']);
      const trips = this.parseCSV(files['trips.txt']);
      const stops = this.parseCSV(files['stops.txt']);
      const stopTimes = this.parseCSV(files['stop_times.txt']);
      const shapes = this.parseCSV(files['shapes.txt']);

      // Build lookup maps - REPLACE THESE CALLS WITH YOUR ACTUAL IMPLEMENTATION
      this.scheduleData.routesMap = this.createRoutesMap(routes);
      this.scheduleData.tripsMap = this.createTripsMap(trips);
      this.scheduleData.stops = this.createStopsMap(stops);
      this.scheduleData.stopTimesByTrip = this.createStopTimesByTrip(stopTimes);
      this.scheduleData.shapes = this.createShapesMap(shapes);

      console.log(`[${new Date().toISOString()}] Successfully loaded fresh GTFS data from API`);
      return this.scheduleData;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Failed to load dynamic GTFS:`, error.message);
      console.log('Falling back to local static GTFS files...');
      return await this.loadFromLocal();
    }
  }

  /**
   * Fallback: load from local ./schedules/operator_36/*.txt files
   */
  async loadFromLocal() {
    try {
      const files = {
        routes: await this.readLocalCSV('routes.txt'),
        trips: await this.readLocalCSV('trips.txt'),
        stops: await this.readLocalCSV('stops.txt'),
        stopTimes: await this.readLocalCSV('stop_times.txt'),
        shapes: await this.readLocalCSV('shapes.txt')
      };

      // Build maps - REPLACE WITH YOUR ACTUAL CODE
      this.scheduleData.routesMap = this.createRoutesMap(files.routes);
      this.scheduleData.tripsMap = this.createTripsMap(files.trips);
      this.scheduleData.stops = this.createStopsMap(files.stops);
      this.scheduleData.stopTimesByTrip = this.createStopTimesByTrip(files.stopTimes);
      this.scheduleData.shapes = this.createShapesMap(files.shapes);

      console.log(`[${new Date().toISOString()}] Loaded schedule data from local fallback files`);
      return this.scheduleData;
    } catch (localError) {
      console.error('Local fallback also failed:', localError.message);
      throw localError; // Let caller handle fatal error
    }
  }

  /**
   * Helper: read and parse a local .txt file
   */
  async readLocalCSV(filename) {
    const filePath = path.join(SCHEDULE_DIR, filename);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      console.log(`  Read local file: ${filename} (${content.length} chars)`);
      return this.parseCSV(content);
    } catch (err) {
      console.error(`Failed to read local file ${filename}:`, err.message);
      throw err;
    }
  }

  /**
   * CSV parser - replace this with your existing parser if it's different
   * Assumes first line is headers, returns array of objects
   */
  parseCSV(csvString) {
    if (!csvString.trim()) return [];

    const lines = csvString.trim().split('\n');
    if (lines.length < 1) return [];

    const headers = lines[0].split(',').map(h => h.trim());
    const result = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = [];
      let current = '';
      let inQuotes = false;

      for (let char of line + ',') {
        if (char === '"' && !inQuotes) {
          inQuotes = true;
        } else if (char === '"' && inQuotes) {
          inQuotes = false;
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }

      if (values.length === headers.length) {
        const obj = {};
        headers.forEach((header, idx) => {
          obj[header] = values[idx];
        });
        result.push(obj);
      }
    }

    return result;
  }

  // ────────────────────────────────────────────────
  //  REPLACE THE FOLLOWING METHODS WITH YOUR ACTUAL IMPLEMENTATIONS
  // ────────────────────────────────────────────────

  createRoutesMap(routesArray) {
    // Your existing logic here
    // Example placeholder:
    const map = {};
    routesArray.forEach(r => {
      map[r.route_id] = r;
    });
    return map;
  }

  createTripsMap(tripsArray) {
    // Your existing logic
    const map = {};
    tripsArray.forEach(t => {
      map[t.trip_id] = t;
    });
    return map;
  }

  createStopsMap(stopsArray) {
    // Your existing logic (usually stop_id → {lat, lon, name, ...})
    const map = {};
    stopsArray.forEach(s => {
      map[s.stop_id] = {
        lat: parseFloat(s.stop_lat),
        lon: parseFloat(s.stop_lon),
        name: s.stop_name
      };
    });
    return map;
  }

  createStopTimesByTrip(stopTimesArray) {
    // Your existing logic (trip_id → array of stop times)
    const byTrip = {};
    stopTimesArray.forEach(st => {
      if (!byTrip[st.trip_id]) byTrip[st.trip_id] = [];
      byTrip[st.trip_id].push(st);
    });
    return byTrip;
  }

  createShapesMap(shapesArray) {
    // Your existing logic (shape_id → sorted array of points)
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
    return shapes;
  }
}

export default ScheduleLoader;
