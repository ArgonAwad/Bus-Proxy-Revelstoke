// virtual-vehicles.js
import { DateTime } from 'luxon';
import scheduleLoader from './schedule-loader.js';

class VirtualVehicleManager {
  constructor() {
    this.virtualVehicles = new Map();
    this.lastGenerated = new Map(); // Track when we last generated for each trip
  }

  // Process trip updates to identify scheduled but untracked vehicles
  generateVirtualVehicles(tripUpdates, scheduleData) {
    const virtualVehicles = [];
    
    if (!tripUpdates || !tripUpdates.entity) {
      return virtualVehicles;
    }
    
    const now = Date.now();
    
    tripUpdates.entity.forEach((tripUpdate) => {
      if (!tripUpdate.tripUpdate) return;
      
      const trip = tripUpdate.tripUpdate.trip;
      const vehicle = tripUpdate.tripUpdate.vehicle;
      
      if (!trip || !trip.tripId) return;
      
      const tripId = trip.tripId;
      const vehicleId = vehicle ? vehicle.id : null;
      
      // Skip if trip already has a real vehicle
      if (vehicleId && vehicleId !== '') return;
      
      // Check if we recently generated for this trip (within 30 seconds)
      const lastGenTime = this.lastGenerated.get(tripId) || 0;
      if (now - lastGenTime < 30000) {
        // Use existing virtual vehicle if we have one
        const existing = this.virtualVehicles.get(tripId);
        if (existing) {
          virtualVehicles.push(existing);
          return;
        }
      }
      
      // Create new virtual vehicle
      console.log(`  ✅ Creating virtual vehicle for trip: ${tripId}`);
      const virtualVehicle = this.createVirtualVehicleFromTripUpdate(
        tripUpdate.tripUpdate,
        scheduleData,
        tripId
      );
      
      if (virtualVehicle) {
        virtualVehicles.push(virtualVehicle);
        this.virtualVehicles.set(tripId, virtualVehicle);
        this.lastGenerated.set(tripId, now);
      }
    });
    
    console.log(`🎯 Returning ${virtualVehicles.length} virtual vehicles`);
    return virtualVehicles;
  }

  // Create from trip update structure
  createVirtualVehicleFromTripUpdate(tripUpdate, scheduleData, tripId) {
    const trip = tripUpdate.trip;
    const stopTimes = tripUpdate.stopTimeUpdate || [];
    
    if (stopTimes.length === 0) {
      return null;
    }
    
    // Find the upcoming stop based on current time
    const currentTime = Math.floor(Date.now() / 1000);
    const upcomingStop = this.findUpcomingStop(stopTimes, currentTime);
    
    if (!upcomingStop) {
      return null;
    }
    
    // Generate CONSISTENT virtual vehicle ID (no timestamp)
    const virtualVehicleId = `VIRTUAL_${tripId}`;
    
    // Get position from stop
    const position = this.getPositionFromStop(upcomingStop.stopId, scheduleData);
    
    // Calculate progress to next stop for movement simulation
    const progress = this.calculateProgress(stopTimes, upcomingStop, currentTime);
    
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
        currentStopSequence: upcomingStop.stopSequence || 1,
        currentStatus: this.getVehicleStatus(stopTimes, upcomingStop, currentTime),
        timestamp: currentTime,
        congestionLevel: 0,
        stopId: upcomingStop.stopId,
        vehicle: {
          id: virtualVehicleId,
          label: this.getVehicleLabel(trip.routeId, trip.tripId),
          licensePlate: "",
          wheelchairAccessible: 0,
          is_virtual: true,
          is_scheduled: true
        },
        occupancyStatus: 0,
        occupancyPercentage: 0,
        multiCarriageDetails: [],
        progress: progress // Store progress for movement updates
      },
      alert: null,
      shape: null,
      stop: null,
      tripModifications: null,
      lastUpdated: Date.now(),
      stopTimes: stopTimes, // Store for movement calculation
      currentStopIndex: this.findStopIndex(stopTimes, upcomingStop)
    };
  }

  getVehicleLabel(routeId, tripId) {
    // Extract route number from routeId (e.g., "5-REVY" -> "5")
    const routeNumber = routeId ? routeId.split('-')[0] : '?';
    return `Ghost Bus ${routeNumber}`;
  }

  getVehicleStatus(stopTimes, currentStop, currentTime) {
    const arrivalTime = currentStop.arrival?.time || currentStop.departure?.time;
    
    if (!arrivalTime) return 2; // IN_TRANSIT_TO
    
    // Check if at stop (within 60 seconds of arrival)
    if (Math.abs(currentTime - arrivalTime) < 60) {
      return 1; // STOPPED_AT
    }
    
    return 2; // IN_TRANSIT_TO
  }

  calculateProgress(stopTimes, currentStop, currentTime) {
    const currentIndex = this.findStopIndex(stopTimes, currentStop);
    if (currentIndex >= stopTimes.length - 1) return 1; // At last stop
    
    const currentStopTime = currentStop.arrival?.time || currentStop.departure?.time;
    const nextStop = stopTimes[currentIndex + 1];
    const nextStopTime = nextStop.arrival?.time || nextStop.departure?.time;
    
    if (!currentStopTime || !nextStopTime || nextStopTime <= currentStopTime) {
      return 0;
    }
    
    // Calculate progress 0-1 between stops
    const progress = (currentTime - currentStopTime) / (nextStopTime - currentStopTime);
    return Math.max(0, Math.min(1, progress));
  }

  findStopIndex(stopTimes, stop) {
    return stopTimes.findIndex(s => 
      s.stopId === stop.stopId && s.stopSequence === stop.stopSequence
    );
  }

  // Helper to find upcoming stop
  findUpcomingStop(stopTimes, currentTime) {
    // Find the next stop that hasn't passed yet
    for (const stop of stopTimes) {
      const departureTime = stop.departure?.time || stop.arrival?.time;
      if (departureTime && departureTime > currentTime) {
        return stop;
      }
    }
    
    // If all stops passed, return the last one
    return stopTimes[stopTimes.length - 1] || null;
  }

  // Get position from stop ID with interpolation between stops
  getPositionFromStop(stopId, scheduleData, progress = 0) {
    // Try to get from schedule data first
    if (scheduleData && scheduleData.stops) {
      const stopInfo = scheduleData.stops[stopId];
      if (stopInfo && stopInfo.lat && stopInfo.lon) {
        return {
          latitude: stopInfo.lat,
          longitude: stopInfo.lon,
          bearing: 0,
          speed: 0
        };
      }
    }
    
    // Fallback coordinates
    const fallbackCoords = {
      '156011': [50.9981, -118.1957], // Downtown Exchange
      '156087': [51.0050, -118.2150], // Big Eddy
      '156083': [50.9975, -118.2020], // Uptown
      '156101': [50.9910, -118.1890], // Highway 23
      '156047': [50.9990, -118.1960],
      '156051': [50.9960, -118.2010]
    };
    
    const coords = fallbackCoords[stopId] || [50.9981, -118.1957];
    
    return {
      latitude: coords[0],
      longitude: coords[1],
      bearing: Math.floor(Math.random() * 360),
      speed: 10 + Math.random() * 20 // 10-30 km/h
    };
  }

  // Update virtual vehicle positions periodically
  updateVirtualPositions() {
    const now = Date.now();
    let updatedCount = 0;
    
    for (const [tripId, vehicle] of this.virtualVehicles) {
      const age = now - vehicle.lastUpdated;
      
      // Update every 10 seconds for smooth movement
      if (age > 10000) {
        this.updateVehiclePosition(vehicle);
        vehicle.lastUpdated = now;
        updatedCount++;
      }
    }
    
    if (updatedCount > 0) {
      console.log(`🔄 Updated ${updatedCount} virtual vehicle positions`);
    }
    
    return updatedCount;
  }

  updateVehiclePosition(vehicle) {
    if (!vehicle.stopTimes || vehicle.stopTimes.length === 0) return;
    
    const currentTime = Math.floor(Date.now() / 1000);
    
    // Find current stop based on schedule
    const upcomingStop = this.findUpcomingStop(vehicle.stopTimes, currentTime);
    if (!upcomingStop) return;
    
    // Update stop info
    vehicle.vehicle.currentStopSequence = upcomingStop.stopSequence || 1;
    vehicle.vehicle.stopId = upcomingStop.stopId;
    vehicle.vehicle.currentStatus = this.getVehicleStatus(
      vehicle.stopTimes, 
      upcomingStop, 
      currentTime
    );
    
    // Calculate progress
    const progress = this.calculateProgress(
      vehicle.stopTimes, 
      upcomingStop, 
      currentTime
    );
    
    // Update position (with interpolation if between stops)
    if (progress > 0 && progress < 1) {
      // Interpolate between current and next stop
      const currentIndex = this.findStopIndex(vehicle.stopTimes, upcomingStop);
      if (currentIndex < vehicle.stopTimes.length - 1) {
        const nextStop = vehicle.stopTimes[currentIndex + 1];
        const currentPos = this.getPositionFromStop(upcomingStop.stopId, null, 0);
        const nextPos = this.getPositionFromStop(nextStop.stopId, null, 0);
        
        // Linear interpolation
        vehicle.vehicle.position.latitude = 
          currentPos.latitude + (nextPos.latitude - currentPos.latitude) * progress;
        vehicle.vehicle.position.longitude = 
          currentPos.longitude + (nextPos.longitude - currentPos.longitude) * progress;
        
        // Calculate bearing towards next stop
        const bearing = this.calculateBearing(
          currentPos.latitude, currentPos.longitude,
          nextPos.latitude, nextPos.longitude
        );
        vehicle.vehicle.position.bearing = bearing;
        vehicle.vehicle.position.speed = 20 + Math.random() * 10; // 20-30 km/h
      }
    } else {
      // At a stop
      const position = this.getPositionFromStop(upcomingStop.stopId, null, 0);
      vehicle.vehicle.position.latitude = position.latitude;
      vehicle.vehicle.position.longitude = position.longitude;
      vehicle.vehicle.position.bearing = position.bearing;
      vehicle.vehicle.position.speed = 0; // Stopped
    }
    
    vehicle.vehicle.timestamp = currentTime;
    vehicle.vehicle.progress = progress;
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

  // Clean up old virtual vehicles (trips that have ended)
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
    
    if (removed > 0) {
      console.log(`🗑️ Cleaned up ${removed} old virtual vehicles`);
    }
    
    return removed;
  }

  // Get count of active virtual vehicles
  getVirtualVehicleCount() {
    return this.virtualVehicles.size;
  }

  // Get all virtual vehicles
  getAllVirtualVehicles() {
    return Array.from(this.virtualVehicles.values());
  }
}

// Create and export a singleton instance
const virtualVehicleManager = new VirtualVehicleManager();
export default virtualVehicleManager;;
