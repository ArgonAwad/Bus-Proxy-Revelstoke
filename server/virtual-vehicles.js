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
    
    tripUpdates.entity?.forEach(tripUpdate => {
      const tripId = tripUpdate.trip?.trip_id;
      const vehicleId = tripUpdate.vehicle?.vehicle_id;
      
      // If trip exists but no vehicle is assigned/transmitting
      if (tripId && !vehicleId) {
        const virtualVehicle = this.createVirtualVehicle(
          tripUpdate,
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
    
    return virtualVehicles;
  }

  createVirtualVehicle(tripUpdate, scheduleData) {
    const trip = tripUpdate.trip;
    const stopTimes = tripUpdate.stop_time_update || [];
    
    if (stopTimes.length === 0) return null;
    
    // Calculate current position based on schedule
    const currentTime = Math.floor(Date.now() / 1000);
    const upcomingStop = this.findCurrentStop(stopTimes, currentTime);
    
    if (!upcomingStop) return null;

    // Generate virtual vehicle ID
    const virtualVehicleId = `VIRTUAL_${trip.trip_id}_${Date.now()}`;
    
    return {
      id: virtualVehicleId,
      trip: {
        trip_id: trip.trip_id,
        route_id: trip.route_id,
        direction_id: trip.direction_id || 0,
        start_time: trip.start_time,
        start_date: trip.start_date,
        schedule_relationship: 0 // SCHEDULED
      },
      vehicle: {
        id: virtualVehicleId,
        label: trip.route_id ? `Virtual ${trip.route_id}` : 'Virtual Vehicle',
        license_plate: '',
        is_virtual: true
      },
      position: this.calculatePosition(upcomingStop, scheduleData),
      current_stop_sequence: upcomingStop.stop_sequence,
      stop_id: upcomingStop.stop_id,
      timestamp: currentTime,
      congestion_level: 0,
      occupancy_status: 0
    };
  }

  findCurrentStop(stopTimes, currentTime) {
    for (let i = 0; i < stopTimes.length - 1; i++) {
      const currentStop = stopTimes[i];
      const nextStop = stopTimes[i + 1];
      
      const arrivalTime = currentStop.arrival?.time || currentStop.departure?.time;
      const nextArrivalTime = nextStop.arrival?.time || nextStop.departure?.time;
      
      if (arrivalTime && nextArrivalTime && 
          currentTime >= arrivalTime && currentTime <= nextArrivalTime) {
        return currentStop;
      }
    }
    
    // Return first stop if before trip start
    const firstStop = stopTimes[0];
    const firstTime = firstStop.arrival?.time || firstStop.departure?.time;
    
    if (firstTime && currentTime < firstTime) {
      return firstStop;
    }
    
    // Return last stop if after trip end
    return stopTimes[stopTimes.length - 1] || null;
  }

  calculatePosition(stopUpdate, scheduleData) {
    // Use stop coordinates from schedule data
    const stopInfo = scheduleData?.stops?.[stopUpdate.stop_id];
    
    if (stopInfo) {
      return {
        latitude: stopInfo.lat,
        longitude: stopInfo.lon,
        bearing: 0, // Default bearing
        speed: 0    // Stationary at stop
      };
    }
    
    // Fallback coordinates
    return {
      latitude: 49.2827, // Example: Vancouver
      longitude: -123.1207,
      bearing: 0,
      speed: 0
    };
  }

  // Update virtual vehicle positions periodically
  updateVirtualPositions() {
    const updatedVehicles = [];
    
    for (const [tripId, vehicle] of this.virtualVehicles) {
      const age = Date.now() - vehicle.lastUpdated;
      
      // Update every 30 seconds
      if (age > 30000) {
        // Simulate movement to next stop
        const updatedVehicle = this.simulateMovement(vehicle);
        updatedVehicle.lastUpdated = Date.now();
        this.virtualVehicles.set(tripId, updatedVehicle);
        updatedVehicles.push(updatedVehicle);
      }
    }
    
    return updatedVehicles;
  }

  simulateMovement(vehicle) {
    // Simple linear movement simulation
    const newVehicle = { ...vehicle };
    
    // Add slight position variation
    if (newVehicle.position) {
      newVehicle.position.latitude += (Math.random() - 0.5) * 0.0001;
      newVehicle.position.longitude += (Math.random() - 0.5) * 0.0001;
      newVehicle.position.bearing = Math.floor(Math.random() * 360);
      newVehicle.position.speed = 10 + Math.random() * 30; // km/h
    }
    
    newVehicle.timestamp = Math.floor(Date.now() / 1000);
    return newVehicle;
  }

  // Clean up old virtual vehicles
  cleanupOldVehicles(maxAgeMinutes = 60) {
    const cutoff = Date.now() - (maxAgeMinutes * 60 * 1000);
    
    for (const [tripId, vehicle] of this.virtualVehicles) {
      if (vehicle.lastUpdated < cutoff) {
        this.virtualVehicles.delete(tripId);
      }
    }
  }
}

export default new VirtualVehicleManager();
