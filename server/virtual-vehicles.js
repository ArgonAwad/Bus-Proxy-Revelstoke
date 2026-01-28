// virtual-vehicles.js
import { DateTime } from 'luxon';
import scheduleLoader from './schedule-loader.js';

class VirtualVehicleManager {
  constructor() {
    this.virtualVehicles = new Map();
    this.lastGenerated = new Map();
    this.virtualBusCounter = 1;
    
    // Virtual bus modes
    this.MODE = {
      ALL_VIRTUAL: 'all',        // All scheduled trips as virtual
      SUBS_ONLY: 'subs',         // Only virtual for missing real buses
      NONE: 'none'               // No virtual buses
    };
    
    this.currentMode = this.MODE.SUBS_ONLY; // Default mode
  }

  // Set the virtual bus mode
  setMode(mode) {
    if (Object.values(this.MODE).includes(mode)) {
      this.currentMode = mode;
      console.log(`🔧 Virtual bus mode set to: ${mode}`);
      return true;
    }
    return false;
  }

  // Get virtual vehicles based on current mode
  getVirtualVehicles(tripUpdates, scheduleData, realVehicleIds = new Set()) {
    switch (this.currentMode) {
      case this.MODE.ALL_VIRTUAL:
        return this.generateAllVirtualVehicles(tripUpdates, scheduleData);
      case this.MODE.SUBS_ONLY:
        return this.generateSubstituteVirtualVehicles(tripUpdates, scheduleData, realVehicleIds);
      case this.MODE.NONE:
        return [];
      default:
        return [];
    }
  }

  // MODE 1: All scheduled trips as virtual (for testing/debugging)
  generateAllVirtualVehicles(tripUpdates, scheduleData) {
    const virtualVehicles = [];
    
    if (!tripUpdates || !tripUpdates.entity) {
      return virtualVehicles;
    }
    
    const currentTimeSec = Math.floor(Date.now() / 1000);
    
    tripUpdates.entity.forEach((tripUpdate, index) => {
      if (!tripUpdate.tripUpdate) return;
      
      const trip = tripUpdate.tripUpdate.trip;
      const stopTimes = tripUpdate.tripUpdate.stopTimeUpdate || [];
      
      if (!trip || !trip.tripId || stopTimes.length === 0) return;
      
      // Check if trip is active (within ±2 hours)
      if (this.isTripInTimeWindow(stopTimes, currentTimeSec, 7200)) {
        const virtualBusNumber = virtualVehicles.length + 1;
        const virtualVehicle = this.createVirtualVehicle(
          trip,
          stopTimes,
          scheduleData,
          `VALL${virtualBusNumber.toString().padStart(3, '0')}`,
          'All Virtual'
        );
        
        if (virtualVehicle) {
          virtualVehicles.push(virtualVehicle);
        }
      }
    });
    
    console.log(`👻 ALL VIRTUAL mode: Created ${virtualVehicles.length} virtual buses`);
    return virtualVehicles;
  }

  // MODE 2: Only virtual buses for missing real buses
  generateSubstituteVirtualVehicles(tripUpdates, scheduleData, realVehicleIds) {
    const virtualVehicles = [];
    
    if (!tripUpdates || !tripUpdates.entity) {
      return virtualVehicles;
    }
    
    const currentTimeSec = Math.floor(Date.now() / 1000);
    let subCount = 0;
    
    // Get trips that are currently active
    const activeTrips = [];
    
    tripUpdates.entity.forEach((tripUpdate) => {
      if (!tripUpdate.tripUpdate) return;
      
      const trip = tripUpdate.tripUpdate.trip;
      const vehicle = tripUpdate.tripUpdate.vehicle;
      const stopTimes = tripUpdate.tripUpdate.stopTimeUpdate || [];
      
      if (!trip || !trip.tripId || stopTimes.length === 0) return;
      
      // Check if trip is currently active
      if (this.isTripCurrentlyActive(stopTimes, currentTimeSec)) {
        const hasRealVehicle = vehicle && vehicle.id && vehicle.id !== '';
        const tripVehicleId = vehicle?.id || trip.tripId;
        
        activeTrips.push({
          trip,
          stopTimes,
          hasRealVehicle,
          tripVehicleId,
          vehicleData: vehicle
        });
      }
    });
    
    // For each active trip without a real vehicle, create a substitute
    activeTrips.forEach((activeTrip, index) => {
      const { trip, stopTimes, hasRealVehicle, tripVehicleId } = activeTrip;
      
      // Check if this vehicle is in the real vehicles list
      const isRealVehicleTracked = realVehicleIds.has(tripVehicleId);
      
      // Create virtual substitute if no real vehicle
      if (!hasRealVehicle && !isRealVehicleTracked) {
        subCount++;
        const virtualVehicle = this.createVirtualVehicle(
          trip,
          stopTimes,
          scheduleData,
          `VSUB${subCount.toString().padStart(3, '0')}`,
          'Substitute'
        );
        
        if (virtualVehicle) {
          virtualVehicles.push(virtualVehicle);
        }
      }
    });
    
    console.log(`👻 SUBS ONLY mode: ${virtualVehicles.length} substitute buses for ${activeTrips.length} active trips`);
    return virtualVehicles;
  }

  // Check if trip is currently active (within schedule)
  isTripCurrentlyActive(stopTimes, currentTimeSec) {
    if (stopTimes.length === 0) return false;
    
    const firstStop = stopTimes[0];
    const lastStop = stopTimes[stopTimes.length - 1];
    
    const startTime = firstStop.departure?.time || firstStop.arrival?.time;
    const endTime = lastStop.arrival?.time || lastStop.departure?.time;
    
    if (!startTime || !endTime) return false;
    
    // Add 5-minute buffer for early/late buses
    const buffer = 300;
    return currentTimeSec >= (startTime - buffer) && currentTimeSec <= (endTime + buffer);
  }

  // Check if trip is within time window (±window seconds)
  isTripInTimeWindow(stopTimes, currentTimeSec, windowSeconds) {
    if (stopTimes.length === 0) return false;
    
    const firstStop = stopTimes[0];
    const lastStop = stopTimes[stopTimes.length - 1];
    
    const startTime = firstStop.departure?.time || firstStop.arrival?.time;
    const endTime = lastStop.arrival?.time || lastStop.departure?.time;
    
    if (!startTime || !endTime) return false;
    
    // Check if current time is within window of trip
    return Math.abs(currentTimeSec - startTime) <= windowSeconds || 
           Math.abs(currentTimeSec - endTime) <= windowSeconds ||
           (currentTimeSec >= startTime && currentTimeSec <= endTime);
  }

  // Create a virtual vehicle
  createVirtualVehicle(trip, stopTimes, scheduleData, vehicleId, modeType) {
    const currentTimeSec = Math.floor(Date.now() / 1000);
    
    // Find current position based on schedule
    const currentStopInfo = this.findCurrentStopAndProgress(stopTimes, currentTimeSec);
    
    if (!currentStopInfo) {
      return null;
    }
    
    const { currentStop, nextStop, progress } = currentStopInfo;
    
    // Calculate position
    const position = this.calculateCurrentPosition(currentStop, nextStop, progress, scheduleData);
    
    // Create route display
    const routeDisplay = this.getRouteDisplayName(trip.routeId);
    const labelPrefix = modeType === 'All Virtual' ? 'Virtual' : 'Ghost';
    
    return {
      id: vehicleId,
      isDeleted: false,
      tripUpdate: null,
      vehicle: {
        trip: {
          tripId: trip.tripId,
          startTime: trip.startTime,
          startDate: trip.startDate,
          scheduleRelationship: 0,
          routeId: trip.routeId,
          directionId: trip.directionId || 0,
          modifiedTrip: null
        },
        position: {
          latitude: position.latitude,
          longitude: position.longitude,
          bearing: position.bearing,
          odometer: 0,
          speed: position.speed
        },
        currentStopSequence: currentStop.stopSequence || 1,
        currentStatus: progress === 0 ? 1 : 2, // 1 = STOPPED_AT, 2 = IN_TRANSIT_TO
        timestamp: currentTimeSec,
        congestionLevel: 0,
        stopId: currentStop.stopId,
        vehicle: {
          id: vehicleId,
          label: `${labelPrefix} ${routeDisplay}`,
          licensePlate: "",
          wheelchairAccessible: 0,
          is_virtual: true,
          virtual_mode: modeType,
          original_trip_id: trip.tripId
        },
        occupancyStatus: 0,
        occupancyPercentage: 0,
        multiCarriageDetails: [],
        progress: progress
      },
      alert: null,
      shape: null,
      stop: null,
      tripModifications: null,
      lastUpdated: Date.now(),
      stopTimes: stopTimes,
      currentStop: currentStop,
      nextStop: nextStop,
      modeType: modeType
    };
  }

  // Find current stop and progress (same as before)
  findCurrentStopAndProgress(stopTimes, currentTimeSec) {
    for (let i = 0; i < stopTimes.length; i++) {
      const currentStop = stopTimes[i];
      const nextStop = stopTimes[i + 1];
      
      const currentStopTime = currentStop.departure?.time || currentStop.arrival?.time;
      const nextStopTime = nextStop ? (nextStop.arrival?.time || nextStop.departure?.time) : null;
      
      if (!currentStopTime) continue;
      
      if (!nextStop && currentTimeSec >= currentStopTime) {
        return { currentStop, nextStop: null, progress: 0 };
      }
      
      if (nextStopTime && currentTimeSec >= currentStopTime && currentTimeSec <= nextStopTime) {
        const progress = (currentTimeSec - currentStopTime) / (nextStopTime - currentStopTime);
        return { 
          currentStop, 
          nextStop, 
          progress: Math.max(0, Math.min(1, progress))
        };
      }
      
      if (i === 0 && currentTimeSec < currentStopTime) {
        return { currentStop, nextStop: null, progress: 0 };
      }
    }
    
    const lastStop = stopTimes[stopTimes.length - 1];
    return { currentStop: lastStop, nextStop: null, progress: 0 };
  }

  // Calculate position (same as before)
  calculateCurrentPosition(currentStop, nextStop, progress, scheduleData) {
    // Get coordinates
    const coords = this.getStopCoordinates(currentStop.stopId, scheduleData);
    let lat = coords.lat;
    let lon = coords.lon;
    
    // Interpolate if moving to next stop
    if (progress > 0 && nextStop) {
      const nextCoords = this.getStopCoordinates(nextStop.stopId, scheduleData);
      
      // Interpolate between stops
      lat = lat + (nextCoords.lat - lat) * progress;
      lon = lon + (nextCoords.lon - lon) * progress;
      
      // Calculate bearing and speed
      const bearing = this.calculateBearing(lat, lon, nextCoords.lat, nextCoords.lon);
      const speed = 25; // km/h
      
      return { latitude: lat, longitude: lon, bearing, speed };
    }
    
    return { latitude: lat, longitude: lon, bearing: 0, speed: 0 };
  }

  getStopCoordinates(stopId, scheduleData) {
    // Try schedule data first
    if (scheduleData && scheduleData.stops) {
      const stopInfo = scheduleData.stops[stopId];
      if (stopInfo && stopInfo.lat && stopInfo.lon) {
        return { lat: stopInfo.lat, lon: stopInfo.lon };
      }
    }
    
    // Fallback coordinates
    const fallbackCoords = {
      '156011': { lat: 50.9981, lon: -118.1957 }, // Downtown Exchange
      '156087': { lat: 51.0050, lon: -118.2150 }, // Big Eddy
      '156083': { lat: 50.9975, lon: -118.2020 }, // Uptown
      '156101': { lat: 50.9910, lon: -118.1890 }, // Highway 23
      '156047': { lat: 50.9990, lon: -118.1960 },
      '156051': { lat: 50.9960, lon: -118.2010 },
      '156099': { lat: 50.9970, lon: -118.2000 },
      '156074': { lat: 50.9950, lon: -118.1980 },
      '156010': { lat: 50.9970, lon: -118.1970 },
      '156009': { lat: 50.9965, lon: -118.1965 }
    };
    
    return fallbackCoords[stopId] || { lat: 50.9981, lon: -118.1957 };
  }

  calculateBearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
            Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    
    return (θ * 180 / Math.PI + 360) % 360;
  }

  getRouteDisplayName(routeId) {
    if (!routeId) return 'Bus';
    const match = routeId.match(/^(\d+)/);
    return match ? `Bus ${match[1]}` : `Bus ${routeId}`;
  }

  // Update positions
  updateVirtualPositions() {
    const now = Date.now();
    let updatedCount = 0;
    
    for (const [tripId, vehicle] of this.virtualVehicles) {
      const age = now - vehicle.lastUpdated;
      
      if (age > 15000) {
        this.updateVehiclePosition(vehicle);
        vehicle.lastUpdated = now;
        updatedCount++;
      }
    }
    
    return updatedCount;
  }

  updateVehiclePosition(vehicle) {
    if (!vehicle.stopTimes || vehicle.stopTimes.length === 0) return;
    
    const currentTimeSec = Math.floor(Date.now() / 1000);
    const currentStopInfo = this.findCurrentStopAndProgress(vehicle.stopTimes, currentTimeSec);
    
    if (!currentStopInfo) return;
    
    const { currentStop, nextStop, progress } = currentStopInfo;
    
    // Update properties
    vehicle.vehicle.currentStopSequence = currentStop.stopSequence || 1;
    vehicle.vehicle.stopId = currentStop.stopId;
    vehicle.vehicle.currentStatus = progress === 0 ? 1 : 2;
    vehicle.vehicle.timestamp = currentTimeSec;
    vehicle.vehicle.progress = progress;
    
    // Update position
    const position = this.calculateCurrentPosition(currentStop, nextStop, progress, null);
    vehicle.vehicle.position.latitude = position.latitude;
    vehicle.vehicle.position.longitude = position.longitude;
    vehicle.vehicle.position.bearing = position.bearing;
    vehicle.vehicle.position.speed = position.speed;
    
    vehicle.currentStop = currentStop;
    vehicle.nextStop = nextStop;
  }

  // Cleanup
  cleanupOldVehicles(maxAgeMinutes = 120) {
    const cutoff = Date.now() - (maxAgeMinutes * 60 * 1000);
    let removed = 0;
    
    for (const [tripId, vehicle] of this.virtualVehicles) {
      if (vehicle.lastUpdated < cutoff) {
        this.virtualVehicles.delete(tripId);
        this.lastGenerated.delete(tripId);
        removed++;
      }
    }
    
    return removed;
  }

  setMaxVirtualBuses(max) {
    this.maxVirtualBuses = max;
  }

  getVirtualVehicleCount() {
    return this.virtualVehicles.size;
  }

  getAllVirtualVehicles() {
    return Array.from(this.virtualVehicles.values());
  }
}

// Create and export a singleton instance
const virtualVehicleManager = new VirtualVehicleManager();
export default virtualVehicleManager;
