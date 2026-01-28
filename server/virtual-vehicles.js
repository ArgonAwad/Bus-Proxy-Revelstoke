// virtual-vehicles.js
import { DateTime } from 'luxon';

class VirtualVehicleManager {
  constructor() {
    this.virtualVehicles = new Map();
    this.scheduledTrips = new Map();
  }

  // Process trip updates to identify scheduled but untracked vehicles
  generateVirtualVehicles(tripUpdates, scheduleData) {
    const virtualVehicles = [];
    
    if (!tripUpdates || !tripUpdates.entity) {
      console.log('❌ No trip updates data available');
      return virtualVehicles;
    }
    
    console.log(`🔍 Checking ${tripUpdates.entity.length} trip updates for virtual vehicles...`);
    
    tripUpdates.entity.forEach((tripUpdate, index) => {
      // Check if this is a trip_update entity
      if (!tripUpdate.tripUpdate) {
        console.log(`  Skipping entity ${index} - not a trip update`);
        return;
      }
      
      const trip = tripUpdate.tripUpdate.trip;
      const vehicle = tripUpdate.tripUpdate.vehicle;
      
      if (!trip || !trip.tripId) {
        console.log(`  Skipping entity ${index} - no trip ID`);
        return;
      }
      
      const tripId = trip.tripId;
      const vehicleId = vehicle ? vehicle.id : null;
      
      console.log(`  Trip ${index}: ${tripId}, Vehicle: ${vehicleId || 'NULL'}`);
      
      // If trip exists but vehicle is null or empty
      if (tripId && (!vehicleId || vehicleId === '' || vehicleId === null)) {
        console.log(`  ✅ Creating virtual vehicle for trip: ${tripId}`);
        
        const virtualVehicle = this.createVirtualVehicleFromTripUpdate(
          tripUpdate.tripUpdate,
          scheduleData
        );
        
        if (virtualVehicle) {
          virtualVehicles.push(virtualVehicle);
          this.virtualVehicles.set(tripId, {
            ...virtualVehicle,
            lastUpdated: Date.now()
          });
        }
      }
    });
    
    console.log(`🎯 Created ${virtualVehicles.length} virtual vehicles`);
    return virtualVehicles;
  }

  // Create from trip update structure
  createVirtualVehicleFromTripUpdate(tripUpdate, scheduleData) {
    const trip = tripUpdate.trip;
    const stopTimes = tripUpdate.stopTimeUpdate || [];
    
    if (stopTimes.length === 0) {
      console.log(`  ⚠️ No stop times for trip ${trip.tripId}`);
      return null;
    }
    
    // Find the upcoming stop based on current time
    const currentTime = Math.floor(Date.now() / 1000);
    const upcomingStop = this.findUpcomingStop(stopTimes, currentTime);
    
    if (!upcomingStop) {
      console.log(`  ⚠️ No upcoming stop found for trip ${trip.tripId}`);
      return null;
    }
    
    // Generate virtual vehicle ID
    const virtualVehicleId = `VIRTUAL_${trip.tripId}_${Date.now()}`;
    
    // Get position from stop
    const position = this.getPositionFromStop(upcomingStop.stopId, scheduleData);
    
    console.log(`  🚌 Virtual ${trip.tripId} at stop ${upcomingStop.stopId}, position: ${position.latitude},${position.longitude}`);
    
    // Create the vehicle object in the correct GTFS-RT format
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
        currentStatus: 2, // 2 = IN_TRANSIT_TO
        timestamp: currentTime,
        congestionLevel: 0,
        stopId: upcomingStop.stopId,
        vehicle: {
          id: virtualVehicleId,
          label: `Virtual ${trip.routeId || 'Bus'}`,
          licensePlate: "",
          wheelchairAccessible: 0,
          is_virtual: true,
          is_scheduled: true
        },
        occupancyStatus: 0,
        occupancyPercentage: 0,
        multiCarriageDetails: []
      },
      alert: null,
      shape: null,
      stop: null,
      tripModifications: null
    };
  }

  // Helper to find upcoming stop
  findUpcomingStop(stopTimes, currentTime) {
    // First, check if we're at or past the last stop
    const lastStop = stopTimes[stopTimes.length - 1];
    const lastStopTime = lastStop.arrival?.time || lastStop.departure?.time;
    
    if (lastStopTime && currentTime >= lastStopTime) {
      return lastStop;
    }
    
    // Find the next upcoming stop
    for (const stop of stopTimes) {
      const arrivalTime = stop.arrival?.time || stop.departure?.time;
      if (arrivalTime && arrivalTime > currentTime) {
        return stop;
      }
    }
    
    // Return first stop if before trip start
    return stopTimes[0] || null;
  }

  // Get position from stop ID
  getPositionFromStop(stopId, scheduleData) {
    // Try to get from schedule data first
    if (scheduleData && scheduleData.stops) {
      const stopInfo = scheduleData.stops[stopId];
      if (stopInfo && stopInfo.lat && stopInfo.lon) {
        return {
          latitude: stopInfo.lat,
          longitude: stopInfo.lon,
          bearing: Math.floor(Math.random() * 360), // Random bearing
          speed: 0
        };
      }
    }
    
    // Fallback: Use some Revelstoke coordinates based on stop ID patterns
    let fallbackLat = 50.9981; // Default Revelstoke center
    let fallbackLon = -118.1957;
    
    // Common Revelstoke stop IDs from your data
    if (stopId && stopId.startsWith('156')) {
      // Map known stop IDs to approximate locations
      const stopMap = {
        '156011': [50.9981, -118.1957], // Downtown Exchange
        '156087': [51.0050, -118.2150], // Big Eddy
        '156083': [50.9975, -118.2020], // Uptown
        '156101': [50.9910, -118.1890], // Highway 23
        '156056': [50.9930, -118.1980],
        '156089': [50.9940, -118.2000],
        '156090': [50.9950, -118.2010],
        '156091': [50.9960, -118.2020],
        '156092': [50.9970, -118.2030],
        '156094': [50.9990, -118.1970],
        '156095': [51.0000, -118.1960]
      };
      
      const coords = stopMap[stopId];
      if (coords) {
        fallbackLat = coords[0];
        fallbackLon = coords[1];
      }
    }
    
    return {
      latitude: fallbackLat,
      longitude: fallbackLon,
      bearing: Math.floor(Math.random() * 360),
      speed: Math.random() * 10 + 5 // 5-15 km/h
    };
  }

  // Update virtual vehicle positions periodically
  updateVirtualPositions() {
    const updatedVehicles = [];
    const now = Date.now();
    
    for (const [tripId, vehicle] of this.virtualVehicles) {
      const age = now - vehicle.lastUpdated;
      
      // Update every 30 seconds
      if (age > 30000) {
        // Simulate movement
        const updatedVehicle = this.simulateMovement(vehicle);
        updatedVehicle.lastUpdated = now;
        this.virtualVehicles.set(tripId, updatedVehicle);
        updatedVehicles.push(updatedVehicle);
      }
    }
    
    if (updatedVehicles.length > 0) {
      console.log(`🔄 Updated ${updatedVehicles.length} virtual vehicles`);
    }
    
    return updatedVehicles;
  }

  simulateMovement(vehicle) {
    const newVehicle = { ...vehicle };
    
    // Add slight position variation (simulate movement)
    if (newVehicle.vehicle && newVehicle.vehicle.position) {
      // Move ~10-30 meters in random direction
      const latOffset = (Math.random() - 0.5) * 0.0003;
      const lonOffset = (Math.random() - 0.5) * 0.0003;
      
      newVehicle.vehicle.position.latitude += latOffset;
      newVehicle.vehicle.position.longitude += lonOffset;
      newVehicle.vehicle.position.bearing = Math.floor(Math.random() * 360);
      newVehicle.vehicle.position.speed = Math.random() * 15 + 5; // 5-20 km/h
      newVehicle.vehicle.timestamp = Math.floor(Date.now() / 1000);
    }
    
    return newVehicle;
  }

  // Clean up old virtual vehicles
  cleanupOldVehicles(maxAgeMinutes = 60) {
    const cutoff = Date.now() - (maxAgeMinutes * 60 * 1000);
    let removed = 0;
    
    for (const [tripId, vehicle] of this.virtualVehicles) {
      if (vehicle.lastUpdated < cutoff) {
        this.virtualVehicles.delete(tripId);
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
export default virtualVehicleManager;
