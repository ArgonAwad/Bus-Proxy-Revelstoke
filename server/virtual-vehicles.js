// virtual-vehicles.js
import { DateTime } from 'luxon';

class VirtualVehicleManager {
  constructor() {
    this.virtualVehicles = new Map();
    this.lastGenerated = new Map();
    this.virtualBusCounter = 1;
    // Virtual bus modes
    this.MODE = {
      ALL_VIRTUAL: 'all', // All scheduled trips as virtual
      SUBS_ONLY: 'subs', // Only virtual for missing real buses
      NONE: 'none' // No virtual buses
    };
    this.currentMode = this.MODE.SUBS_ONLY; // Default mode
    
    // We'll get scheduleLoader passed in functions, not imported
    this.scheduleData = null;
  }

  // Set schedule data (called from server.js)
  setScheduleData(scheduleData) {
    this.scheduleData = scheduleData;
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
    this.setScheduleData(scheduleData); // Store schedule data
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
    if (!tripUpdates || !tripUpdates.entity) return virtualVehicles;
    const currentTimeSec = Math.floor(Date.now() / 1000);
    tripUpdates.entity.forEach((tripUpdate) => {
      if (!tripUpdate.tripUpdate) return;
      const trip = tripUpdate.tripUpdate.trip;
      const stopTimes = tripUpdate.tripUpdate.stopTimeUpdate || [];
      if (!trip || !trip.tripId || stopTimes.length === 0) return;
      if (this.isTripInTimeWindow(stopTimes, currentTimeSec, 7200)) {
        const virtualBusNumber = virtualVehicles.length + 1;
        const virtualVehicle = this.createVirtualVehicle(
          trip,
          stopTimes,
          scheduleData,
          `VALL${virtualBusNumber.toString().padStart(3, '0')}`,
          'All Virtual'
        );
        if (virtualVehicle) virtualVehicles.push(virtualVehicle);
      }
    });
    console.log(`👻 ALL VIRTUAL mode: Created ${virtualVehicles.length} virtual buses`);
    return virtualVehicles;
  }

  // MODE 2: Substitute (missing) or All scheduled
generateSubstituteVirtualVehicles(tripUpdates, scheduleData, realVehicleIds, allVirtuals = false) {
  const virtualVehicles = [];
  if (!tripUpdates || !tripUpdates.entity) return virtualVehicles;

  const currentTimeSec = Math.floor(Date.now() / 1000);
  const createdTrips = new Set();

  tripUpdates.entity.forEach((tripUpdate) => {
    if (!tripUpdate.tripUpdate) return;
    const trip = tripUpdate.tripUpdate.trip;
    const vehicle = tripUpdate.tripUpdate.vehicle;
    const stopTimes = tripUpdate.tripUpdate.stopTimeUpdate || [];

    if (!trip || !trip.tripId || stopTimes.length === 0) return;

    if (this.isTripCurrentlyActive(stopTimes, currentTimeSec)) {
      const hasRealVehicle = vehicle && vehicle.id && vehicle.id !== '';
      const tripId = trip.tripId;
      const vehicleId = vehicle?.id || tripId;

      // === CHANGE HERE ===
      let shouldGenerate = false;

      if (allVirtuals) {
        // All scheduled mode: generate regardless of real vehicle
        shouldGenerate = !createdTrips.has(tripId);
      } else {
        // Normal substitute mode: only if missing real vehicle
        const isTracked = realVehicleIds.has(vehicleId) || realVehicleIds.has(tripId);
        shouldGenerate = !hasRealVehicle && !isTracked && !createdTrips.has(tripId);
      }

      if (shouldGenerate) {
        createdTrips.add(tripId);
        const virtualVehicle = this.createVirtualVehicle(
          trip,
          stopTimes,
          scheduleData,
          `VIRT-${allVirtuals ? 'ALL-' : ''}${extractBlockIdFromTripId(tripId) || 'unknown'}`,
          allVirtuals ? 'AllScheduled' : 'Substitute'
        );
        if (virtualVehicle) virtualVehicles.push(virtualVehicle);
      }
    }
  });

  console.log(`👻 ${allVirtuals ? 'ALL SCHEDULED' : 'SUBS ONLY'} mode: ${virtualVehicles.length} virtual buses created`);
  return virtualVehicles;
}

  isTripCurrentlyActive(stopTimes, currentTimeSec) {
    if (stopTimes.length === 0) return false;
    const firstStop = stopTimes[0];
    const lastStop = stopTimes[stopTimes.length - 1];
    const startTime = firstStop.departure?.time || firstStop.arrival?.time;
    const endTime = lastStop.arrival?.time || lastStop.departure?.time;
    if (!startTime || !endTime) return false;
    const buffer = 300; // 5 min buffer
    return currentTimeSec >= (startTime - buffer) && currentTimeSec <= (endTime + buffer);
  }

  isTripInTimeWindow(stopTimes, currentTimeSec, windowSeconds) {
    if (stopTimes.length === 0) return false;
    const firstStop = stopTimes[0];
    const lastStop = stopTimes[stopTimes.length - 1];
    const startTime = firstStop.departure?.time || firstStop.arrival?.time;
    const endTime = lastStop.arrival?.time || lastStop.departure?.time;
    if (!startTime || !endTime) return false;
    return Math.abs(currentTimeSec - startTime) <= windowSeconds ||
           Math.abs(currentTimeSec - endTime) <= windowSeconds ||
           (currentTimeSec >= startTime && currentTimeSec <= endTime);
  }

  createVirtualVehicle(trip, stopTimes, scheduleData, vehicleId, modeType) {
    const currentTimeSec = Math.floor(Date.now() / 1000);
    const currentStopInfo = this.findCurrentStopAndProgress(stopTimes, currentTimeSec);
    if (!currentStopInfo) return null;
    const { currentStop, nextStop, progress } = currentStopInfo;
    const position = this.calculateCurrentPosition(
      currentStop,
      nextStop,
      progress,
      scheduleData,
      trip.tripId
    );
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
        currentStatus: progress === 0 ? 1 : 2,
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

  calculateCurrentPosition(currentStop, nextStop, progress, scheduleData, tripId) {
  console.log('='.repeat(50));
  console.log('📍 CALCULATING VIRTUAL BUS POSITION');
  console.log(`Trip ID: ${tripId}`);
  console.log(`Current Stop ID: ${currentStop.stopId}`);
  console.log(`Progress: ${progress}`);
  console.log(`Schedule Data Provided: ${!!scheduleData}`);
  console.log(`Schedule Stops Available: ${scheduleData ? Object.keys(scheduleData.stops || {}).length : 0}`);
    if (!scheduleData || !scheduleData.stops) {
      console.warn('No scheduleData.stops available for position calculation');
      return { latitude: 50.9981, longitude: -118.1957, bearing: null, speed: 0 };
    }

    // Try shape interpolation first (smooth along route)
    if (tripId && scheduleData.tripsMap && scheduleData.shapes) {
      const shapePos = this.calculatePositionAlongShape(tripId, progress, scheduleData);
      if (shapePos) {
        console.log(`Using smooth shape interpolation for trip ${tripId}`);
        return shapePos;
      } else {
        console.log(`No shape available for trip ${tripId} — falling back to stop-to-stop`);
      }
    }

    // Fallback: straight line between stops
    const currentCoords = scheduleData.stops[currentStop.stopId];
    if (!currentCoords || !currentCoords.lat || !currentCoords.lon) {
      console.warn(`No coordinates for stop ${currentStop.stopId}`);
      return { latitude: 50.9981, longitude: -118.1957, bearing: null, speed: 0 };
    }

    let lat = currentCoords.lat;
    let lon = currentCoords.lon;
    let speed = 0;

    if (progress > 0 && nextStop) {
      const nextCoords = scheduleData.stops[nextStop.stopId];
      if (nextCoords && nextCoords.lat && nextCoords.lon) {
        lat += (nextCoords.lat - lat) * progress;
        lon += (nextCoords.lon - lon) * progress;
        speed = 25;
      }
    }

    return { latitude: lat, longitude: lon, bearing: null, speed };
  }

  calculatePositionAlongShape(tripId, progress, scheduleData) {
    const trip = scheduleData.tripsMap?.[tripId];
    if (!trip || !trip.shape_id) return null;

    const shapeId = trip.shape_id;
    const shapePoints = scheduleData.shapes?.[shapeId];
    if (!shapePoints || shapePoints.length < 2) return null;

    // Use shape_dist_traveled if available for accurate progress
    const totalDistance = shapePoints[shapePoints.length - 1].dist || null;
    if (totalDistance && totalDistance > 0) {
      const targetDist = progress * totalDistance;
      for (let i = 0; i < shapePoints.length - 1; i++) {
        const p1 = shapePoints[i];
        const p2 = shapePoints[i + 1];
        if (targetDist >= p1.dist && targetDist <= p2.dist) {
          const segDist = p2.dist - p1.dist;
          const segProgress = (targetDist - p1.dist) / segDist;
          const lat = p1.lat + (p2.lat - p1.lat) * segProgress;
          const lon = p1.lon + (p2.lon - p1.lon) * segProgress;
          return { latitude: lat, longitude: lon, bearing: null, speed: 25 };
        }
      }
    }

    // Fallback: uniform point index
    const totalPoints = shapePoints.length;
    const index = Math.floor(progress * (totalPoints - 1));
    const nextIndex = Math.min(index + 1, totalPoints - 1);
    const p1 = shapePoints[index];
    const p2 = shapePoints[nextIndex];
    const segProgress = (progress * (totalPoints - 1)) % 1;
    const lat = p1.lat + (p2.lat - p1.lat) * segProgress;
    const lon = p1.lon + (p2.lon - p1.lon) * segProgress;
    return { latitude: lat, longitude: lon, bearing: null, speed: 25 };
  }

  calculateBearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    return (θ * 180 / Math.PI + 360) % 360;
  }

  getRouteDisplayName(routeId) {
    if (!routeId) return 'Bus';
    const match = routeId.match(/^(\d+)/);
    return match ? `Bus ${match[1]}` : `Bus ${routeId}`;
  }

  updateVirtualPositions(scheduleData) {
    const now = Date.now();
    let updatedCount = 0;
    for (const [tripId, vehicle] of this.virtualVehicles) {
      const age = now - vehicle.lastUpdated;
      if (age > 30000) { // update every 30 seconds to reduce jitter
        this.updateVehiclePosition(vehicle, scheduleData);
        vehicle.lastUpdated = now;
        updatedCount++;
      }
    }
    return updatedCount;
  }

  updateVehiclePosition(vehicle, scheduleData) {
    if (!vehicle.stopTimes || vehicle.stopTimes.length === 0) {
      console.log(`Removing virtual ${vehicle.id} - no stop times`);
      this.virtualVehicles.delete(vehicle.id);
      return;
    }
    const currentTimeSec = Math.floor(Date.now() / 1000);
    const currentStopInfo = this.findCurrentStopAndProgress(vehicle.stopTimes, currentTimeSec);
    if (!currentStopInfo) {
      console.log(`Removing virtual ${vehicle.id} - no active stop segment`);
      this.virtualVehicles.delete(vehicle.id);
      return;
    }
    const { currentStop, nextStop, progress } = currentStopInfo;

    // Check if the trip has ended
    if (!nextStop) {
      const lastStop = vehicle.stopTimes[vehicle.stopTimes.length - 1];
      const lastArrivalTime = lastStop.arrival?.time || lastStop.departure?.time || 0;
      const bufferSeconds = 600; // 10 min buffer
      if (currentTimeSec > lastArrivalTime + bufferSeconds) {
        console.log(`Removing completed virtual bus ${vehicle.id} (ended at ${lastArrivalTime})`);
        this.virtualVehicles.delete(vehicle.id);
        return;
      }
    }

    // Normal update
    vehicle.vehicle.currentStopSequence = currentStop.stopSequence || 1;
    vehicle.vehicle.stopId = currentStop.stopId;
    vehicle.vehicle.currentStatus = progress === 0 ? 1 : 2;
    vehicle.vehicle.timestamp = currentTimeSec;
    vehicle.vehicle.progress = progress;

    const position = this.calculateCurrentPosition(
      currentStop,
      nextStop,
      progress,
      scheduleData,
      vehicle.vehicle.trip.tripId
    );

    vehicle.vehicle.position.latitude = position.latitude;
    vehicle.vehicle.position.longitude = position.longitude;
    vehicle.vehicle.position.bearing = position.bearing;
    vehicle.vehicle.position.speed = position.speed;

    vehicle.currentStop = currentStop;
    vehicle.nextStop = nextStop;
  }

  cleanupOldVehicles(maxAgeMinutes = 60) {
    const cutoff = Date.now() - (maxAgeMinutes * 60 * 1000);
    let removed = 0;
    for (const [key, vehicle] of this.virtualVehicles) {
      if (vehicle.lastUpdated < cutoff) {
        console.log(`Age-based cleanup: removing stale virtual ${vehicle.id}`);
        this.virtualVehicles.delete(key);
        this.lastGenerated.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`Cleaned up ${removed} old virtual vehicles`);
    }
    return removed;
  }
}

// Singleton instance
const virtualVehicleManager = new VirtualVehicleManager();
export default virtualVehicleManager;
