// virtual-vehicles.js
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
    this.setScheduleData(scheduleData);
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

  // Helper: Extract block ID from trip ID
  extractBlockIdFromTripId(tripId) {
    if (!tripId || typeof tripId !== 'string') return null;
    const parts = tripId.split(':');
    if (parts.length >= 3) {
      const lastPart = parts[parts.length - 1];
      if (/^\d+$/.test(lastPart)) {
        return lastPart;
      }
    }
    return null;
  }

  // MODE 1: All scheduled trips as virtual
  generateAllVirtualVehicles(tripUpdates, scheduleData) {
    const virtualVehicles = [];
    if (!tripUpdates || !tripUpdates.entity) return virtualVehicles;
    
    const currentTimeSec = Math.floor(Date.now() / 1000);
    console.log(`👻 ALL VIRTUAL mode: Processing ${tripUpdates.entity.length} trip updates`);
    
    const createdTrips = new Set();
    
    tripUpdates.entity.forEach((tripUpdate) => {
      if (!tripUpdate.tripUpdate) return;
      
      const trip = tripUpdate.tripUpdate.trip;
      const stopTimes = tripUpdate.tripUpdate.stopTimeUpdate || [];
      
      if (!trip || !trip.tripId || stopTimes.length === 0) return;
      
      const tripId = trip.tripId;
      if (createdTrips.has(tripId)) return;
      
      // Check if trip is active or within time window
      if (this.isTripInTimeWindow(stopTimes, currentTimeSec, 7200)) {
        createdTrips.add(tripId);
        
        const blockId = this.extractBlockIdFromTripId(tripId);
        const vehicleId = `VALL${virtualVehicles.length + 1}`.padStart(7, '0');
        
        console.log(`Creating virtual for trip ${tripId}, block ${blockId}`);
        
        const virtualVehicle = this.createVirtualVehicle(
          trip,
          stopTimes,
          scheduleData,
          vehicleId,
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

  // MODE 2: Substitute (missing) or All scheduled
  generateSubstituteVirtualVehicles(tripUpdates, scheduleData, realVehicleIds, allVirtuals = false) {
    const virtualVehicles = [];
    if (!tripUpdates || !tripUpdates.entity) return virtualVehicles;

    const currentTimeSec = Math.floor(Date.now() / 1000);
    const createdTrips = new Set();
    
    console.log(`👻 ${allVirtuals ? 'ALL SCHEDULED' : 'SUBS ONLY'} mode: Processing ${tripUpdates.entity.length} trips`);

    tripUpdates.entity.forEach((tripUpdate) => {
      if (!tripUpdate.tripUpdate) return;
      
      const trip = tripUpdate.tripUpdate.trip;
      const vehicle = tripUpdate.tripUpdate.vehicle;
      const stopTimes = tripUpdate.tripUpdate.stopTimeUpdate || [];

      if (!trip || !trip.tripId || stopTimes.length === 0) return;

      const tripId = trip.tripId;
      const vehicleId = vehicle?.id || tripId;
      
      // Check if trip is currently active
      if (this.isTripCurrentlyActive(stopTimes, currentTimeSec)) {
        const hasRealVehicle = vehicle && vehicle.id && vehicle.id !== '';
        const blockId = this.extractBlockIdFromTripId(tripId);
        
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
          
          const virtualVehicleId = `VIRT-${allVirtuals ? 'ALL-' : ''}${blockId || 'unknown'}`;
          
          console.log(`Creating ${allVirtuals ? 'all scheduled' : 'substitute'} virtual for trip ${tripId}`);
          
          const virtualVehicle = this.createVirtualVehicle(
            trip,
            stopTimes,
            scheduleData,
            virtualVehicleId,
            allVirtuals ? 'AllScheduled' : 'Substitute'
          );
          
          if (virtualVehicle) {
            virtualVehicles.push(virtualVehicle);
          }
        }
      }
    });

    console.log(`👻 ${allVirtuals ? 'ALL SCHEDULED' : 'SUBS ONLY'} mode: ${virtualVehicles.length} virtual buses created`);
    return virtualVehicles;
  }

  isTripCurrentlyActive(stopTimes, currentTimeSec) {
    if (!stopTimes || stopTimes.length === 0) return false;
    
    const getStopTime = (stop) => {
      return stop.departure?.time || stop.arrival?.time;
    };
    
    const firstStopTime = getStopTime(stopTimes[0]);
    const lastStopTime = getStopTime(stopTimes[stopTimes.length - 1]);
    
    if (!firstStopTime || !lastStopTime) return false;
    
    const buffer = 300; // 5 min buffer
    const startTime = parseInt(firstStopTime, 10);
    const endTime = parseInt(lastStopTime, 10);
    
    return currentTimeSec >= (startTime - buffer) && currentTimeSec <= (endTime + buffer);
  }

  isTripInTimeWindow(stopTimes, currentTimeSec, windowSeconds) {
    if (!stopTimes || stopTimes.length === 0) return false;
    
    const getStopTime = (stop) => {
      return stop.departure?.time || stop.arrival?.time;
    };
    
    const firstStopTime = getStopTime(stopTimes[0]);
    const lastStopTime = getStopTime(stopTimes[stopTimes.length - 1]);
    
    if (!firstStopTime || !lastStopTime) return false;
    
    const startTime = parseInt(firstStopTime, 10);
    const endTime = parseInt(lastStopTime, 10);
    
    // Trip is in window if:
    // 1. Current time is within window of start or end time
    // 2. Current time is between start and end times
    return Math.abs(currentTimeSec - startTime) <= windowSeconds ||
           Math.abs(currentTimeSec - endTime) <= windowSeconds ||
           (currentTimeSec >= startTime && currentTimeSec <= endTime);
  }

  createVirtualVehicle(trip, stopTimes, scheduleData, vehicleId, modeType) {
    const currentTimeSec = Math.floor(Date.now() / 1000);
    
    console.log(`\n🚌 Creating virtual vehicle ${vehicleId} for trip ${trip.tripId}`);
    console.log(`   Mode: ${modeType}, Current time: ${currentTimeSec}`);
    
    const currentStopInfo = this.findCurrentStopAndProgress(stopTimes, currentTimeSec);
    if (!currentStopInfo) {
      console.log(`❌ No current stop info for trip ${trip.tripId}`);
      return null;
    }
    
    const { currentStop, nextStop, progress } = currentStopInfo;
    
    console.log(`   Current stop: ${currentStop.stopId}, Next stop: ${nextStop?.stopId || 'none'}`);
    console.log(`   Progress: ${progress.toFixed(3)}`);
    
    const position = this.calculateCurrentPosition(
      currentStop,
      nextStop,
      progress,
      scheduleData,
      trip.tripId
    );
    
    const routeDisplay = this.getRouteDisplayName(trip.routeId);
    const labelPrefix = modeType === 'All Virtual' ? 'Virtual' : 'Ghost';
    
    const virtualVehicle = {
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
        currentStatus: progress === 0 ? 1 : 2, // 1=STOPPED_AT, 2=IN_TRANSIT_TO
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
    
    console.log(`✅ Created virtual vehicle ${vehicleId} at ${position.latitude}, ${position.longitude}`);
    return virtualVehicle;
  }

  findCurrentStopAndProgress(stopTimes, currentTimeSec) {
    console.log(`\n🔍 findCurrentStopAndProgress: ${stopTimes?.length || 0} stops, currentTime: ${currentTimeSec}`);
    
    if (!stopTimes || stopTimes.length === 0) {
      console.log('❌ No stop times provided');
      return null;
    }

    // Helper to get stop time in seconds
    const getStopTime = (stop) => {
      if (stop.departure?.time) return parseInt(stop.departure.time, 10);
      if (stop.arrival?.time) return parseInt(stop.arrival.time, 10);
      return null;
    };

    // Get first and last stop times
    const firstStopTime = getStopTime(stopTimes[0]);
    const lastStopTime = getStopTime(stopTimes[stopTimes.length - 1]);
    
    console.log(`First stop time: ${firstStopTime}, Last stop time: ${lastStopTime}`);

    // If trip hasn't started yet
    if (firstStopTime && currentTimeSec < firstStopTime) {
      const timeUntilStart = firstStopTime - currentTimeSec;
      console.log(`⏰ Trip hasn't started yet. Starts in ${timeUntilStart} seconds`);
      return { 
        currentStop: stopTimes[0], 
        nextStop: stopTimes[1] || null, 
        progress: 0 
      };
    }

    // If trip has ended (with 15 minute buffer)
    if (lastStopTime && currentTimeSec > lastStopTime + 900) {
      console.log(`🏁 Trip ended ${currentTimeSec - lastStopTime} seconds ago`);
      return { 
        currentStop: stopTimes[stopTimes.length - 1], 
        nextStop: null, 
        progress: 1 
      };
    }

    // Find current segment between stops
    for (let i = 0; i < stopTimes.length - 1; i++) {
      const currentStop = stopTimes[i];
      const nextStop = stopTimes[i + 1];
      
      const segmentStartTime = getStopTime(currentStop);
      const segmentEndTime = getStopTime(nextStop);
      
      if (!segmentStartTime || !segmentEndTime) continue;
      
      console.log(`Segment ${i}: ${currentStop.stopId} (${segmentStartTime}) → ${nextStop.stopId} (${segmentEndTime})`);
      
      // Check if we're in this segment
      if (currentTimeSec >= segmentStartTime && currentTimeSec <= segmentEndTime) {
        const segmentDuration = segmentEndTime - segmentStartTime;
        const timeInSegment = currentTimeSec - segmentStartTime;
        const progress = segmentDuration > 0 ? timeInSegment / segmentDuration : 0;
        
        console.log(`✅ In segment! Progress: ${progress.toFixed(3)} (${timeInSegment}/${segmentDuration}s)`);
        return { 
          currentStop, 
          nextStop, 
          progress: Math.max(0, Math.min(1, progress)) 
        };
      }
    }

    // If we're exactly at a stop (within 2 minutes)
    for (let i = 0; i < stopTimes.length; i++) {
      const stopTime = getStopTime(stopTimes[i]);
      if (stopTime && Math.abs(currentTimeSec - stopTime) < 120) {
        console.log(`📍 At stop ${stopTimes[i].stopId} (within 2 minutes)`);
        const nextStop = i < stopTimes.length - 1 ? stopTimes[i + 1] : null;
        return { currentStop: stopTimes[i], nextStop, progress: 0 };
      }
    }

    // If we're between segments but not within the schedule, find nearest upcoming stop
    for (let i = 0; i < stopTimes.length; i++) {
      const stopTime = getStopTime(stopTimes[i]);
      if (stopTime && currentTimeSec < stopTime) {
        console.log(`➡️ Between stops, next stop: ${stopTimes[i].stopId} in ${stopTime - currentTimeSec} seconds`);
        const prevStop = i > 0 ? stopTimes[i - 1] : stopTimes[0];
        const nextStop = stopTimes[i];
        
        // Estimate progress based on time to next stop
        const prevStopTime = getStopTime(prevStop) || stopTime - 60; // Default 1 min gap
        const timeToNextStop = stopTime - currentTimeSec;
        const segmentDuration = stopTime - prevStopTime;
        const progress = segmentDuration > 0 ? 1 - (timeToNextStop / segmentDuration) : 0;
        
        return { 
          currentStop: prevStop, 
          nextStop, 
          progress: Math.max(0, Math.min(1, progress)) 
        };
      }
    }

    // Default: at last stop
    console.log(`🔚 Default to last stop`);
    return { 
      currentStop: stopTimes[stopTimes.length - 1], 
      nextStop: null, 
      progress: 1 
    };
  }

  calculateCurrentPosition(currentStop, nextStop, progress, scheduleData, tripId) {
    console.log(`\n📍 calculateCurrentPosition:`);
    console.log(`   Trip: ${tripId}`);
    console.log(`   Current stop: ${currentStop?.stopId}`);
    console.log(`   Next stop: ${nextStop?.stopId}`);
    console.log(`   Progress: ${progress}`);
    
    if (!scheduleData || !scheduleData.stops) {
      console.warn('❌ No schedule data available');
      return { latitude: 50.9981, longitude: -118.1957, bearing: null, speed: 0 };
    }

    const currentStopId = String(currentStop.stopId).trim();
    const currentCoords = scheduleData.stops[currentStopId];
    
    if (!currentCoords) {
      console.warn(`❌ No coordinates for stop ${currentStopId}`);
      return { latitude: 50.9981, longitude: -118.1957, bearing: null, speed: 0 };
    }

    console.log(`✅ Current stop coords: ${currentCoords.lat}, ${currentCoords.lon}`);

    // Try shape interpolation first (most accurate)
    if (tripId && scheduleData.tripsMap && scheduleData.shapes && progress > 0) {
      const shapePos = this.calculatePositionAlongShape(tripId, progress, scheduleData);
      if (shapePos) {
        console.log(`✅ Using shape interpolation`);
        return shapePos;
      }
    }

    // Fallback: linear interpolation between stops
    let lat = currentCoords.lat;
    let lon = currentCoords.lon;
    let speed = 0;
    let bearing = null;

    if (progress > 0 && nextStop) {
      const nextStopId = String(nextStop.stopId).trim();
      const nextCoords = scheduleData.stops[nextStopId];
      
      if (nextCoords) {
        console.log(`✅ Next stop coords: ${nextCoords.lat}, ${nextCoords.lon}`);
        
        lat = currentCoords.lat + (nextCoords.lat - currentCoords.lat) * progress;
        lon = currentCoords.lon + (nextCoords.lon - currentCoords.lon) * progress;
        speed = 25; // km/h
        bearing = this.calculateBearing(currentCoords.lat, currentCoords.lon, 
                                        nextCoords.lat, nextCoords.lon);
        
        console.log(`📈 Interpolated: ${lat}, ${lon}`);
        console.log(`   Speed: ${speed} km/h, Bearing: ${bearing}°`);
      } else {
        console.warn(`❌ No coordinates for next stop ${nextStopId}`);
      }
    } else {
      console.log(`⏸️ At stop or no progress`);
    }

    return { latitude: lat, longitude: lon, bearing, speed };
  }

  calculatePositionAlongShape(tripId, progress, scheduleData) {
    console.log(`\n🔄 calculatePositionAlongShape: ${tripId}, progress: ${progress}`);
    
    const trip = scheduleData.tripsMap?.[tripId];
    if (!trip || !trip.shape_id) {
      console.log(`❌ No shape_id for trip ${tripId}`);
      return null;
    }

    const shapeId = trip.shape_id;
    const shapePoints = scheduleData.shapes?.[shapeId];
    
    if (!shapePoints || shapePoints.length < 2) {
      console.log(`❌ No shape points for shape ${shapeId}`);
      return null;
    }

    console.log(`✅ Shape ${shapeId} has ${shapePoints.length} points`);

    // Check if shape has distance measurements
    const hasDistances = shapePoints[0].dist !== null && 
                        shapePoints[shapePoints.length - 1].dist !== null;
    
    if (hasDistances) {
      const totalDistance = shapePoints[shapePoints.length - 1].dist;
      const targetDistance = progress * totalDistance;
      
      console.log(`📏 Using distance-based interpolation`);
      console.log(`   Total distance: ${totalDistance}m, Target: ${targetDistance.toFixed(0)}m`);
      
      for (let i = 0; i < shapePoints.length - 1; i++) {
        const p1 = shapePoints[i];
        const p2 = shapePoints[i + 1];
        
        if (targetDistance >= p1.dist && targetDistance <= p2.dist) {
          const segmentDist = p2.dist - p1.dist;
          const segmentProgress = segmentDist > 0 ? (targetDistance - p1.dist) / segmentDist : 0;
          
          const lat = p1.lat + (p2.lat - p1.lat) * segmentProgress;
          const lon = p1.lon + (p2.lon - p1.lon) * segmentProgress;
          
          console.log(`   Segment ${i}/${shapePoints.length}:`);
          console.log(`     p1: ${p1.lat},${p1.lon} (${p1.dist}m)`);
          console.log(`     p2: ${p2.lat},${p2.lon} (${p2.dist}m)`);
          console.log(`     Segment progress: ${segmentProgress.toFixed(3)}`);
          console.log(`     Result: ${lat},${lon}`);
          
          return { 
            latitude: lat, 
            longitude: lon, 
            bearing: this.calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon),
            speed: 25 
          };
        }
      }
    }

    // Fallback: uniform interpolation by point index
    console.log(`📈 Using uniform point interpolation`);
    const totalPoints = shapePoints.length;
    const exactIndex = progress * (totalPoints - 1);
    const index = Math.floor(exactIndex);
    const nextIndex = Math.min(index + 1, totalPoints - 1);
    const segmentProgress = exactIndex - index;
    
    const p1 = shapePoints[index];
    const p2 = shapePoints[nextIndex];
    
    console.log(`   Points: ${index} → ${nextIndex} of ${totalPoints}`);
    console.log(`   Segment progress: ${segmentProgress.toFixed(3)}`);
    
    const lat = p1.lat + (p2.lat - p1.lat) * segmentProgress;
    const lon = p1.lon + (p2.lon - p1.lon) * segmentProgress;
    
    console.log(`   p1: ${p1.lat},${p1.lon}`);
    console.log(`   p2: ${p2.lat},${p2.lon}`);
    console.log(`   Result: ${lat},${lon}`);
    
    return { 
      latitude: lat, 
      longitude: lon, 
      bearing: this.calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon),
      speed: 25 
    };
  }

  calculateBearing(lat1, lon1, lat2, lon2) {
    // Convert degrees to radians
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    
    // Calculate bearing
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    
    // Convert to degrees and normalize to 0-360
    const bearing = (θ * 180 / Math.PI + 360) % 360;
    return Math.round(bearing);
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
      if (age > 30000) { // update every 30 seconds
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
    
    console.log(`🔄 Updated virtual ${vehicle.id} position to ${position.latitude}, ${position.longitude}`);
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
