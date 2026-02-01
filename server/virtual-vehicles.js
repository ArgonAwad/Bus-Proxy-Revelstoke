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
    
    console.log('✅ VirtualVehicleManager initialized');
  }

  // Add this method to debug schedule data
  debugScheduleData() {
    console.log('🔍 DEBUG Schedule Data:');
    console.log(`- Has scheduleData: ${!!this.scheduleData}`);
    console.log(`- Has tripsMap: ${!!this.scheduleData?.tripsMap}`);
    console.log(`- Trips count: ${Object.keys(this.scheduleData?.tripsMap || {}).length}`);
    console.log(`- Shapes count: ${Object.keys(this.scheduleData?.shapes || {}).length}`);
    
    // Show first few trip IDs to see format
    const tripIds = Object.keys(this.scheduleData?.tripsMap || {});
    console.log('Sample trip IDs:', tripIds.slice(0, 5));
    
    // Show first few shapes
    const shapeIds = Object.keys(this.scheduleData?.shapes || {});
    console.log('Sample shape IDs:', shapeIds.slice(0, 5));
    
    return {
      hasData: !!this.scheduleData,
      trips: tripIds.length,
      shapes: shapeIds.length,
      sampleTrips: tripIds.slice(0, 3),
      sampleShapes: shapeIds.slice(0, 3)
    };
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

  // Helper: Get shape ID from trip ID
  getShapeIdFromTrip(tripId, scheduleData) {
    if (!tripId || !scheduleData?.tripsMap) {
      console.log(`❌ Missing tripId or scheduleData for: ${tripId}`);
      return null;
    }
    
    console.log(`🔍 Looking for shape ID for trip: ${tripId}`);
    
    // Check if schedule data is empty
    const tripKeys = Object.keys(scheduleData.tripsMap);
    if (tripKeys.length === 0) {
      console.log('⚠️ tripsMap is EMPTY! Schedule data not loaded properly.');
      return null;
    }
    
    // Your trip IDs are like "2369311:11648788:11653669"
    // The block ID is the last part after colon
    const parts = tripId.split(':');
    
    // Try finding by block ID (last numeric part)
    if (parts.length >= 3) {
      const blockId = parts[parts.length - 1];
      console.log(`📋 Extracted block ID: ${blockId} from trip ID: ${tripId}`);
      
      // Look for any trip with this block ID
      for (const [tripKey, trip] of Object.entries(scheduleData.tripsMap)) {
        if (trip.block_id === blockId && trip.shape_id) {
          console.log(`✅ Found shape ID via block match: ${trip.shape_id}`);
          return trip.shape_id;
        }
      }
    }
    
    // Try matching the numeric part
    const numericPart = tripId.split(':').pop();
    if (numericPart) {
      // Check if any trip key contains this numeric part
      for (const [tripKey, trip] of Object.entries(scheduleData.tripsMap)) {
        if (tripKey.includes(numericPart) && trip.shape_id) {
          console.log(`✅ Found shape ID via numeric match: ${trip.shape_id}`);
          return trip.shape_id;
        }
      }
    }
    
    // Try exact match (unlikely but worth trying)
    if (scheduleData.tripsMap[tripId]) {
      const shapeId = scheduleData.tripsMap[tripId].shape_id;
      console.log(`✅ Found shape ID via exact match: ${shapeId}`);
      return shapeId;
    }
    
    console.log(`❌ No shape ID found for trip ${tripId}`);
    console.log(`   Available trip keys: ${Object.keys(scheduleData.tripsMap).slice(0, 5).join(', ')}...`);
    
    // Return a default shape ID if available
    const firstShapeId = Object.keys(scheduleData.shapes || {})[0];
    if (firstShapeId) {
      console.log(`⚠️ Using default shape ID: ${firstShapeId}`);
      return firstShapeId;
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
    
    // Get shape ID for this trip
    const shapeId = this.getShapeIdFromTrip(trip.tripId, scheduleData);
    
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
          modifiedTrip: null,
          blockId: this.extractBlockIdFromTripId(trip.tripId) || 'unknown'
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
      modeType: modeType,
      
      // CRITICAL: Add metadata for movement tracking
      _metadata: {
        progress: progress,
        shapeId: shapeId,
        lastUpdate: Date.now(),
        startTime: currentTimeSec,
        stopTimes: stopTimes,
        currentStop: currentStop,
        nextStop: nextStop,
        currentStopInfo: currentStopInfo,
        positionHistory: [{
          lat: position.latitude,
          lng: position.longitude,
          time: currentTimeSec
        }]
      }
    };
    
    // STORE THE VEHICLE IN THE MANAGER'S MAP
    this.virtualVehicles.set(vehicleId, virtualVehicle);
    console.log(`✅ Created and stored virtual vehicle ${vehicleId} at ${position.latitude}, ${position.longitude}`);
    console.log(`   Shape ID: ${shapeId || 'none'}, Progress: ${progress}`);
    
    return virtualVehicle;
  }

  findCurrentStopAndProgress(stopTimes, currentTimeSec) {
  console.log(`\n🔍 findCurrentStopAndProgress called | stops: ${stopTimes?.length || 0} | unix now: ${currentTimeSec}`);

  if (!stopTimes || stopTimes.length === 0) {
    console.log('❌ No stop times provided');
    return null;
  }

  // Helper: Convert GTFS "HH:MM:SS" string (possibly >24:00) to seconds since midnight
  const timeToSeconds = (timeStr) => {
    if (!timeStr || typeof timeStr !== 'string') return null;
    let [hours, minutes, seconds = 0] = timeStr.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) return null;
    // Handle overnight times (GTFS allows >24:00)
    const extraDays = Math.floor(hours / 24);
    hours = hours % 24;
    return extraDays * 86400 + hours * 3600 + minutes * 60 + seconds;
  };

  // Force timezone to Revelstoke (America/Vancouver = PST/PDT)
  const nowUTC = new Date(currentTimeSec * 1000);
  // PST = UTC-8 (simple offset; DST auto-handled by toLocaleString)
  const localDate = new Date(nowUTC.toLocaleString('en-US', { timeZone: 'America/Vancouver' }));
  const currentSecondsToday = localDate.getHours() * 3600 +
                              localDate.getMinutes() * 60 +
                              localDate.getSeconds();

  console.log(`[TIME DEBUG] Server UTC: ${nowUTC.toISOString()}`);
  console.log(`[TIME DEBUG] Local PST/PDT: ${localDate.toLocaleString('en-CA', { timeZone: 'America/Vancouver' })} (${currentSecondsToday}s since midnight local)`);

  // Log first and last stop times for comparison
  const firstTimeStr = stopTimes[0]?.departure?.time || stopTimes[0]?.arrival?.time || 'none';
  const lastTimeStr = stopTimes[stopTimes.length - 1]?.departure?.time || stopTimes[stopTimes.length - 1]?.arrival?.time || 'none';
  console.log(`[TIME DEBUG] First stop time string: ${firstTimeStr}`);
  console.log(`[TIME DEBUG] Last stop time string: ${lastTimeStr}`);

  // Parse all stop times to seconds
  const stopsWithTimes = stopTimes.map((st, idx) => {
    const arrivalSec = timeToSeconds(st.arrival?.time);
    const departureSec = timeToSeconds(st.departure?.time);
    const effectiveSec = departureSec ?? arrivalSec ?? null;
    return {
      idx,
      stop: st,
      arrivalSec,
      departureSec,
      effectiveSec,
      isFirst: idx === 0,
      isLast: idx === stopTimes.length - 1
    };
  });

  const firstDepartureSec = stopsWithTimes[0]?.effectiveSec;
  const lastDepartureSec = stopsWithTimes[stopTimes.length - 1]?.effectiveSec;

  console.log(`[TIME DEBUG] First departure seconds: ${firstDepartureSec}, Last: ${lastDepartureSec}`);

  // Before trip starts (5 min buffer before first departure)
  if (firstDepartureSec !== null && currentSecondsToday < firstDepartureSec - 300) {
    console.log(`⏳ Before start - at first stop (current: ${currentSecondsToday}s < ${firstDepartureSec - 300}s)`);
    return {
      currentStop: stopTimes[0],
      nextStop: stopTimes[1] || null,
      progress: 0,
      status: 'pre_start'
    };
  }

  // After trip ends (15 min buffer after last departure)
  if (lastDepartureSec !== null && currentSecondsToday > lastDepartureSec + 900) {
    console.log(`🏁 Trip ended (current: ${currentSecondsToday}s > ${lastDepartureSec + 900}s)`);
    return {
      currentStop: stopTimes[stopTimes.length - 1],
      nextStop: null,
      progress: 1,
      status: 'completed'
    };
  }

  // Find current segment
  for (let i = 0; i < stopsWithTimes.length - 1; i++) {
    const current = stopsWithTimes[i];
    const next = stopsWithTimes[i + 1];

    const departSec = current.effectiveSec;
    const arriveSec = next.arrivalSec ?? next.effectiveSec;

    if (departSec === null || arriveSec === null) continue;

    if (currentSecondsToday >= departSec && currentSecondsToday <= arriveSec) {
      const duration = arriveSec - departSec;
      const elapsed = currentSecondsToday - departSec;
      let progress = duration > 0 ? elapsed / duration : 0;

      // Small dwell realism: stay at stop for first 30 seconds of segment
      if (progress < 30 / duration) progress = 0;

      progress = Math.max(0, Math.min(1, progress));

      console.log(`✅ In segment ${i} → ${i+1} | depart: ${departSec}s arrive: ${arriveSec}s | elapsed: ${elapsed}/${duration} | progress: ${progress.toFixed(3)}`);

      return {
        currentStop: current.stop,
        nextStop: next.stop,
        progress,
        status: progress < 0.05 ? 'departing' : 'in_transit'
      };
    }
  }

  // Fallback: approaching next stop
  for (let i = 0; i < stopsWithTimes.length; i++) {
    const st = stopsWithTimes[i];
    if (st.effectiveSec && currentSecondsToday < st.effectiveSec) {
      const prev = i > 0 ? stopsWithTimes[i - 1] : null;
      if (prev && prev.effectiveSec) {
        const departPrev = prev.effectiveSec;
        const arriveHere = st.arrivalSec ?? st.effectiveSec;
        const duration = arriveHere - departPrev;
        const elapsed = currentSecondsToday - departPrev;
        let progress = duration > 0 ? elapsed / duration : 0;
        progress = Math.max(0, Math.min(1, progress));
        console.log(`➡️ Approaching stop ${st.stop.stopId} | progress ${progress.toFixed(3)}`);
        return {
          currentStop: prev.stop,
          nextStop: st.stop,
          progress,
          status: 'approaching'
        };
      }
      break;
    }
  }

  // Default to last stop
  console.log(`🔚 Defaulting to last stop`);
  return {
    currentStop: stopTimes[stopTimes.length - 1],
    nextStop: null,
    progress: 1,
    status: 'at_end'
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

  updateVehiclePosition(vehicle, scheduleData) {
    if (!vehicle) {
      console.log('❌ updateVehiclePosition: No vehicle provided');
      return;
    }
    
    console.log(`\n🔄 Updating position for virtual vehicle ${vehicle.id}`);
    
    // Get metadata - check both possible locations
    const metadata = vehicle._metadata || 
                     (vehicle.vehicle && vehicle.vehicle._metadata) || 
                     {};
    
    if (!metadata.stopTimes && !vehicle.stopTimes) {
      console.log(`❌ No stop times for vehicle ${vehicle.id}`);
      return;
    }
    
    const stopTimes = metadata.stopTimes || vehicle.stopTimes;
    const currentTimeSec = Math.floor(Date.now() / 1000);
    
    console.log(`   Current time: ${currentTimeSec}, Last update: ${metadata.lastUpdate || 'never'}`);
    
    // Find current progress based on time
    const currentStopInfo = this.findCurrentStopAndProgress(stopTimes, currentTimeSec);
    
    if (!currentStopInfo) {
      console.log(`❌ Could not find current stop info for ${vehicle.id}`);
      
      // If trip has likely ended, remove it
      const lastStopTime = stopTimes[stopTimes.length - 1];
      const lastTime = lastStopTime.departure?.time || lastStopTime.arrival?.time;
      
      if (lastTime && currentTimeSec > parseInt(lastTime) + 1800) { // 30 min after end
        console.log(`🗑️ Removing completed virtual vehicle ${vehicle.id}`);
        this.virtualVehicles.delete(vehicle.id);
      }
      return;
    }
    
    const { currentStop, nextStop, progress } = currentStopInfo;
    
    console.log(`   New progress: ${progress.toFixed(3)}, Current stop: ${currentStop.stopId}`);
    
    // Update metadata
    metadata.progress = progress;
    metadata.currentStop = currentStop;
    metadata.nextStop = nextStop;
    metadata.lastUpdate = Date.now();
    metadata.currentStopInfo = currentStopInfo;
    
    // Store metadata back in the right place
    if (!vehicle._metadata) {
      vehicle._metadata = metadata;
    }
    
    // Calculate new position
    const position = this.calculateCurrentPosition(
      currentStop,
      nextStop,
      progress,
      scheduleData,
      vehicle.vehicle.trip.tripId
    );
    
    console.log(`   New position: ${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}`);
    
    // Update vehicle position
    if (vehicle.vehicle && vehicle.vehicle.position) {
      vehicle.vehicle.position.latitude = position.latitude;
      vehicle.vehicle.position.longitude = position.longitude;
      vehicle.vehicle.position.bearing = position.bearing;
      vehicle.vehicle.position.speed = position.speed;
    }
    
    // Update other vehicle properties
    if (vehicle.vehicle) {
      vehicle.vehicle.timestamp = currentTimeSec;
      vehicle.vehicle.currentStatus = progress === 0 ? 1 : 2;
      vehicle.vehicle.stopId = currentStop.stopId;
      vehicle.vehicle.currentStopSequence = currentStop.stopSequence || 1;
      vehicle.vehicle.progress = progress;
    }
    
    vehicle.lastUpdated = Date.now();
    
    // Add to position history
    if (!metadata.positionHistory) {
      metadata.positionHistory = [];
    }
    metadata.positionHistory.push({
      lat: position.latitude,
      lng: position.longitude,
      time: currentTimeSec,
      progress: progress
    });
    
    // Keep only last 10 positions
    if (metadata.positionHistory.length > 10) {
      metadata.positionHistory = metadata.positionHistory.slice(-10);
    }
    
    console.log(`✅ Updated ${vehicle.id} to progress: ${progress.toFixed(3)}, bearing: ${position.bearing}°`);
  }

  updateVirtualPositions(scheduleData) {
    const now = Date.now();
    let updatedCount = 0;
    let removedCount = 0;
    
    console.log(`\n📊 Updating virtual positions (${this.virtualVehicles.size} vehicles total)`);
    
    // Create array copy to avoid modification during iteration issues
    const vehicles = Array.from(this.virtualVehicles.entries());
    
    for (const [vehicleId, vehicle] of vehicles) {
      try {
        const age = now - (vehicle.lastUpdated || 0);
        
        // Update every 5 seconds (more frequent for smoother movement)
        if (age > 5000) {
          this.updateVehiclePosition(vehicle, scheduleData);
          
          // Update the stored vehicle
          this.virtualVehicles.set(vehicleId, vehicle);
          updatedCount++;
        }
        
        // Check if vehicle should be removed (trip ended + buffer)
        const metadata = vehicle._metadata || {};
        if (metadata.stopTimes) {
          const lastStop = metadata.stopTimes[metadata.stopTimes.length - 1];
          const lastTime = lastStop.departure?.time || lastStop.arrival?.time;
          const currentTimeSec = Math.floor(Date.now() / 1000);
          
          if (lastTime && currentTimeSec > parseInt(lastTime) + 1800) { // 30 min after end
            console.log(`🗑️ Removing expired virtual vehicle ${vehicleId}`);
            this.virtualVehicles.delete(vehicleId);
            removedCount++;
          }
        }
        
      } catch (error) {
        console.error(`❌ Error updating vehicle ${vehicleId}:`, error.message);
      }
    }
    
    // Cleanup old vehicles (60 minutes)
    const cutoff = Date.now() - (60 * 60 * 1000);
    for (const [vehicleId, vehicle] of this.virtualVehicles.entries()) {
      if ((vehicle.lastUpdated || 0) < cutoff) {
        console.log(`🗑️ Removing stale virtual vehicle ${vehicleId}`);
        this.virtualVehicles.delete(vehicleId);
        removedCount++;
      }
    }
    
    if (updatedCount > 0 || removedCount > 0) {
      console.log(`📈 Virtual update complete: ${updatedCount} updated, ${removedCount} removed, ${this.virtualVehicles.size} remaining`);
    }
    
    return { updated: updatedCount, removed: removedCount };
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

  // Add this method to manually trigger updates (for debugging)
  forceUpdateAllVirtuals(scheduleData) {
    console.log(`🚀 Force updating all ${this.virtualVehicles.size} virtual vehicles`);
    
    const results = {
      updated: 0,
      errors: 0,
      details: []
    };
    
    for (const [vehicleId, vehicle] of this.virtualVehicles.entries()) {
      try {
        console.log(`\n🔄 Force updating ${vehicleId}...`);
        const beforeProgress = vehicle._metadata?.progress || 0;
        
        this.updateVehiclePosition(vehicle, scheduleData);
        
        const afterProgress = vehicle._metadata?.progress || 0;
        
        results.details.push({
          vehicleId,
          beforeProgress,
          afterProgress,
          moved: Math.abs(afterProgress - beforeProgress) > 0.001
        });
        
        results.updated++;
        
      } catch (error) {
        console.error(`❌ Error force updating ${vehicleId}:`, error.message);
        results.errors++;
      }
    }
    
    console.log(`📊 Force update complete: ${results.updated} updated, ${results.errors} errors`);
    return results;
  }
}

// Singleton instance
const virtualVehicleManager = new VirtualVehicleManager();
export default virtualVehicleManager;
