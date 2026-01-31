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
      const response = await fetch(GTFS_URL, { timeout: 30000 });
      if (!response.ok) {
        throw new Error(`GTFS fetch failed: ${response.status} ${response.statusText}`);
      }

      const zipBuffer = await response.arrayBuffer();
      console.log(`ZIP downloaded, size: ${(zipBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

      const zipStream = Readable.from(Buffer.from(zipBuffer)).pipe(unzipper.Parse({ forceStream: true }));
      const files = {};

      for await (const entry of zipStream) {
        const fileName = entry.path;
        if (entry.type === 'File' && fileName.endsWith('.txt')) {
          let content = '';
          for await (const chunk of entry) {
            content += chunk.toString('utf8');
          }
          files[fileName] = content;
          console.log(` Extracted: ${fileName} (${content.length} chars)`);
        } else {
          entry.autodrain();
        }
      }

      const requiredFiles = ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'shapes.txt'];
      for (const file of requiredFiles) {
        if (!files[file]) {
          throw new Error(`Missing required file in GTFS ZIP: ${file}`);
        }
      }

      const routes = this.parseCSV(files['routes.txt']);
      const trips = this.parseCSV(files['trips.txt']);
      const stops = this.parseCSV(files['stops.txt']);
      const stopTimes = this.parseCSV(files['stop_times.txt']);
      const shapes = this.parseCSV(files['shapes.txt']);

      console.log(`Parsed: ${routes.length} routes | ${trips.length} trips | ${stops.length} stops | ${stopTimes.length} stop_times | ${shapes.length} shapes`);

      this.scheduleData.routesMap = this.createRoutesMap(routes);
      this.scheduleData.tripsMap = this.createTripsMap(trips);
      this.scheduleData.stops = this.createStopsMap(stops);
      this.scheduleData.stopTimesByTrip = this.createStopTimesByTrip(stopTimes);
      this.scheduleData.shapes = this.createShapesMap(shapes);

      console.log(`[${new Date().toISOString()}] Successfully loaded fresh GTFS data from API`);
      console.log(`Stops loaded: ${Object.keys(this.scheduleData.stops).length}`);
      console.log(`Sample stop 156087:`, this.scheduleData.stops['156087'] || 'NOT FOUND');

      return this.scheduleData;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Failed to load dynamic GTFS:`, error.message);
      console.log('Falling back to local static GTFS files...');
      return await this.loadFromLocal();
    }
  }

  async loadFromLocal() {
    try {
      const files = {
        routes: await this.readLocalCSV('routes.txt'),
        trips: await this.readLocalCSV('trips.txt'),
        stops: await this.readLocalCSV('stops.txt'),
        stopTimes: await this.readLocalCSV('stop_times.txt'),
        shapes: await this.readLocalCSV('shapes.txt')
      };

      this.scheduleData.routesMap = this.createRoutesMap(files.routes);
      this.scheduleData.tripsMap = this.createTripsMap(files.trips);
      this.scheduleData.stops = this.createStopsMap(files.stops);
      this.scheduleData.stopTimesByTrip = this.createStopTimesByTrip(files.stopTimes);
      this.scheduleData.shapes = this.createShapesMap(files.shapes);

      console.log(`[${new Date().toISOString()}] Loaded schedule data from local fallback files`);
      console.log(`Stops loaded (local): ${Object.keys(this.scheduleData.stops).length}`);

      return this.scheduleData;
    } catch (localError) {
      console.error('Local fallback failed:', localError.message);
      throw localError;
    }
  }

  async readLocalCSV(filename) {
    const filePath = path.join(SCHEDULE_DIR, filename);
    const content = await fs.readFile(filePath, 'utf-8');
    console.log(` Read local file: ${filename} (${content.length} chars)`);
    return this.parseCSV(content);
  }

  // Improved CSV parser that handles quoted fields properly
  parseCSV(csvString) {
    if (!csvString.trim()) return [];
    const lines = csvString.split(/\r?\n/);
    if (lines.length < 1) return [];

    const headers = this.parseCSVLine(lines[0]);
    console.log(`CSV headers (${headers.length}):`, headers.join(', '));

    const result = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = this.parseCSVLine(line);
      if (values.length !== headers.length) {
        console.warn(`Line ${i+1} skipped: expected ${headers.length} fields, got ${values.length}`);
        continue;
      }

      const obj = {};
      headers.forEach((header, idx) => {
        obj[header] = values[idx].trim();
      });
      result.push(obj);
    }

    console.log(`Parsed ${result.length} rows from CSV`);
    return result;
  }

  // Helper to parse a single CSV line with quoted fields
  parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"' && !inQuotes) {
        inQuotes = true;
      } else if (char === '"' && inQuotes) {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip the next quote
        } else {
          inQuotes = false;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    if (current) result.push(current);
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
    const map = {};
    let validCount = 0;

    stopsArray.forEach(stop => {
      const id = String(stop.stop_id).trim();
      const lat = parseFloat(stop.stop_lat);
      const lon = parseFloat(stop.stop_lon);

      if (!isNaN(lat) && !isNaN(lon) && id) {
        map[id] = {
          lat,
          lon,
          name: stop.stop_name?.trim() || 'Unnamed Stop'
        };
        validCount++;
      } else {
        console.warn(`Invalid stop skipped: id=${stop.stop_id}, lat=${stop.stop_lat}, lon=${stop.stop_lon}`);
      }
    });

    console.log(`[Stops] Loaded ${validCount} valid stops out of ${stopsArray.length} rows`);
    console.log(`[Stops] Sample keys (first 5): ${Object.keys(map).slice(0,5).join(', ')}`);
    console.log(`[Stops] Has 156087? ${!!map['156087']}`);
    console.log(`[Stops] Has 156083? ${!!map['156083']}`);

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
