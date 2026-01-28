// virtual-vehicles.js
import { DateTime } from 'luxon';
import scheduleLoader from './schedule-loader.js';

class VirtualVehicleManager {
  constructor() {
    this.virtualVehicles = new Map();
    this.lastGenerated = new Map();
    this.virtualBusCounter = 1;
    this.maxVirtualBuses = 3;
  }

  // Process trip updates to identify scheduled but untracked vehicles
  generateVirtualVehicles(tripUpdates, scheduleData) {
    const virtualVehicles = [];
    
    if (!tripUpdates || !tripUpdates.entity) {
      return virtualVehicles;
    }
    
    const now = Date.now();
    const currentTimeSec = Math.floor(now / 1000);
    let virtualCount = 0;
    
    // First, get all ACTIVE trips that need virtual vehicles
    const activeTripsNeedingVirtuals = [];
    
    tripUpdates.entity.forEach((tripUpdate) => {
      if (!tripUpdate.tripUpdate) return;
      
      const trip = tripUpdate.tripUpdate.trip;
      const vehicle = tripUpdate.tripUpdate.vehicle;
      const stopTimes = tripUpdate.tripUpdate.stopTimeUpdate || [];
      
      if (!trip || !trip.tripId || stopTimes.length === 0) return;
      
      const tripId = trip.tripId;
      const vehicleId = vehicle ? vehicle.id : null;
      
      // Skip if trip already has a real vehicle
      if (vehicleId && vehicleId !== '') return;
      
      // Check if trip is CURRENTLY ACTIVE (not future, not past)
      const isCurrentlyActive = this.isTripCurrentlyActive(stopTimes, currentTimeSec);
      
      if (isCurrentlyActive) {
        activeTripsNeedingVirtuals.push({
          tripUpdate: tripUpdate.tripUpdate,
          tripId,
          stopTimes,
          startTime: stopTimes[0]?.departure?.time || stopTimes[0]?.arrival?.time
        });
      }
    });
    
    // Sort by how long they've been active (most recent first)
    activeTripsNeedingVirtuals.sort((a, b) => {
      // Sort by how close to current time (active longest first)
      const aActiveTime = currentTimeSec - (a.startTime || 0);
      const bActiveTime = currentTimeSec - (b.startTime || 0);
      return Math.abs(aActiveTime) - Math.abs(bActiveTime);
    });
    
    // Create virtual vehicles ONLY for currently active trips
    for (let i = 0; i < Math.min(activeTripsNeedingVirtuals.length, this.maxVirtualBuses); i++) {
      const { tripUpdate, tripId, stopTimes } = activeTripsNeedingVirtuals[i];
      
      // Check if we recently generated for this trip
      const lastGenTime = this.lastGenerated.get(tripId) || 0;
      if (now - lastGenTime < 30000) {
        // Use existing virtual vehicle if we have one
        const existing = this.virtualVehicles.get(tripId);
        if (existing) {
          virtualVehicles.push(existing);
          virtualCount++;
          continue;
        }
      }
      
      // Create new virtual vehicle
      console.log(`  ✅ Creating virtual vehicle for ACTIVE trip: ${tripId}`);
      const virtualVehicle = this.createVirtualVehicleFromTripUpdate(
        tripUpdate,
        scheduleData,
        tripId,
        virtualCount + 1
      );
      
      if (virtualVehicle) {
        virtualVehicles.push(virtualVehicle);
        this.virtualVehicles.set(tripId, virtualVehicle);
        this.lastGenerated.set(tripId, now);
        virtualCount++;
      }
    }
    
    console.log(`🎯 Created ${virtualVehicles.length} virtual vehicles for ACTIVE trips`);
    
    // Clean up any virtual vehicles for trips that are no longer active
    this.cleanupInactiveVirtualVehicles(currentTimeSec);
    
    return virtualVehicles;
  }

  // Check if a trip is CURRENTLY active (not future, not past)
  isTripCurrentlyActive(stopTimes, currentTimeSec) {
    if (stopTimes.length === 0) return false;
    
    const firstStop = stopTimes[0];
    const lastStop = stopTimes[stopTimes.length - 1];
    
    const startTime = firstStop.departure?.time || firstStop.arrival?.time;
    const endTime = lastStop.arrival?.time || lastStop.departure?.time;
    
    if (!startTime || !endTime) return false;
    
    // Trip is CURRENTLY active if current time is between start and end
    return currentTimeSec >= startTime && currentTimeSec <= endTime;
  }

  // Clean up virtual vehicles for trips that are no longer active
  cleanupInactiveVirtualVehicles(currentTimeSec) {
    let removed = 0;
    
    for (const [tripId, vehicle] of this.virtualVehicles) {
      if (!vehicle.stopTimes || vehicle.stopTimes.length === 0) {
        this.virtualVehicles.delete(tripId);
        removed++;
        continue;
      }
      
      const lastStop = vehicle.stopTimes[vehicle.stopTimes.length - 1];
      const endTime = lastStop.arrival?.time || lastStop.departure?.time;
      
      // If trip has ended (more than 5 minutes ago), remove it
      if (endTime && (currentTimeSec - endTime) > 300) {
        console.log(`  🗑️ Removing virtual vehicle for ended trip: ${tripId}`);
        this.virtualVehicles.delete(tripId);
        this.lastGenerated.delete(tripId);
        removed++;
      }
    }
    
    if (removed > 0) {
      console.log(`🧹 Cleaned up ${removed} inactive virtual vehicles`);
    }
    
    return removed;
  }

  // Create from trip update structure
  createVirtualVehicleFromTripUpdate(tripUpdate, scheduleData, tripId, busNumber) {
    const trip = tripUpdate.trip;
    const stopTimes = tripUpdate.stopTimeUpdate || [];
    
    if (stopTimes.length === 0) {
      return null;
    }
    
    const currentTimeSec = Math.floor(Date.now() / 1000);
    
    // Find the current position based on schedule
    const currentStopInfo = this.findCurrentStopAndProgress(stopTimes, currentTimeSec);
    
    if (!currentStopInfo) {
      return null;
    }
    
    const { currentStop, nextStop, progress } = currentStopInfo;
    
    // Generate SIMPLE virtual vehicle ID
    const virtualVehicleId = `V${busNumber.toString().padStart(4, '0')}`;
    
    // Calculate position (interpolate between stops if moving)
    const position = this.calculateCurrentPosition(currentStop, nextStop, progress, scheduleData);
    
    // Create route display name
    const routeDisplay = this.getRouteDisplayName(trip.routeId);
    
    return {
      id: virtualVehicleId,
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
          id: virtualVehicleId,
          label: `Ghost ${routeDisplay}`,
          licensePlate: "",
          wheelchairAccessible: 0,
          is_virtual: true,
          is_scheduled: true,
          virtual_bus_number: busNumber
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
      originalTripId: tripId
    };
  }

  // Find current stop and progress between stops
  findCurrentStopAndProgress(stopTimes, currentTimeSec) {
    for (let i = 0; i < stopTimes.length; i++) {
      const currentStop = stopTimes[i];
      const nextStop = stopTimes[i + 1];
      
      const currentStopTime = currentStop.departure?.time || currentStop.arrival?.time;
      const nextStopTime = nextStop ? (nextStop.arrival?.time || nextStop.departure?.time) : null;
      
      if (!currentStopTime) continue;
      
      // If at the last stop
      if (!nextStop && currentTimeSec >= currentStopTime) {
        return { currentStop, nextStop: null, progress: 0 };
      }
      
      // If between current stop and next stop
      if (nextStopTime && currentTimeSec >= currentStopTime && currentTimeSec <= nextStopTime) {
        const progress = (currentTimeSec - currentStopTime) / (nextStopTime - currentStopTime);
        return { 
          currentStop, 
          nextStop, 
          progress: Math.max(0, Math.min(1, progress))
        };
      }
      
      // If before the first stop (shouldn't happen for active trips)
      if (i === 0 && currentTimeSec < currentStopTime) {
        return { currentStop, nextStop: null, progress: 0 };
      }
    }
    
    // If past all stops, return last stop
    const lastStop = stopTimes[stopTimes.length - 1];
    return { currentStop: lastStop, nextStop: null, progress: 0 };
  }

  // Calculate current position with interpolation
  calculateCurrentPosition(currentStop, nextStop, progress, scheduleData) {
    // Get coordinates for current stop
    let lat, lon;
    
    if (scheduleData && scheduleData.stops) {
      const stopInfo = scheduleData.stops[currentStop.stopId];
      if (stopInfo && stopInfo.lat && stopInfo.lon) {
        lat = stopInfo.lat;
        lon = stopInfo.lon;
      }
    }
    
    // If we don't have coordinates from schedule, use fallback
    if (!lat || !lon) {
      const fallbackCoords = this.getFallbackCoordinates(currentStop.stopId);
      lat = fallbackCoords.lat;
      lon = fallbackCoords.lon;
    }
    
    // If moving to next stop and we have next stop coordinates, interpolate
    if (progress > 0 && nextStop) {
      let nextLat, nextLon;
      
      if (scheduleData && scheduleData.stops) {
        const nextStopInfo = scheduleData.stops[nextStop.stopId];
        if (nextStopInfo && nextStopInfo.lat && nextStopInfo.lon) {
          nextLat = nextStopInfo.lat;
          nextLon = nextStopInfo.lon;
        }
      }
      
      if (!nextLat || !nextLon) {
        const nextFallback = this.getFallbackCoordinates(nextStop.stopId);
        nextLat = nextFallback.lat;
        nextLon = nextFallback.lon;
      }
      
      // Interpolate between stops
      lat = lat + (nextLat - lat) * progress;
      lon = lon + (nextLon - lon) * progress;
      
      // Calculate bearing towards next stop
      const bearing = this.calculateBearing(lat, lon, nextLat, nextLon);
      const speed = 25; // km/h
      
      return { latitude: lat, longitude: lon, bearing, speed };
    }
    
    // At a stop
    return { latitude: lat, longitude: lon, bearing: 0, speed: 0 };
  }

  getFallbackCoordinates(stopId) {
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

  // Update virtual vehicle positions periodically
  updateVirtualPositions() {
    const now = Date.now();
    let updatedCount = 0;
    
    for (const [tripId, vehicle] of this.virtualVehicles) {
      const age = now - vehicle.lastUpdated;
      
      // Update every 15 seconds
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
    
    // Find current position based on schedule
    const currentStopInfo = this.findCurrentStopAndProgress(vehicle.stopTimes, currentTimeSec);
    
    if (!currentStopInfo) return;
    
    const { currentStop, nextStop, progress } = currentStopInfo;
    
    // Update vehicle properties
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
    
    // Update references
    vehicle.currentStop = currentStop;
    vehicle.nextStop = nextStop;
  }

  // Clean up old virtual vehicles
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
