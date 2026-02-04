// virtual-vehicles.js — exact shape-based interpolation for virtual bus positions

// 1. Extract block ID from trip ID (last numeric part after colon)
function extractBlockIdFromTripId(tripId) {
  if (!tripId || typeof tripId !== 'string') return null;
  const parts = tripId.split(':');
  if (parts.length >= 3) {
    const lastPart = parts[parts.length - 1];
    if (/^\d+$/.test(lastPart)) return lastPart;
  }
  return null;
}

// 2. Get shape ID from trip (match by block_id or partial trip_id)
function getShapeIdFromTrip(tripId, scheduleData) {
  if (!scheduleData?.tripsMap) {
    console.log('[getShapeIdFromTrip] No tripsMap in scheduleData');
    return null;
  }
  
  // First try: exact trip_id match
  if (scheduleData.tripsMap[tripId]?.shape_id) {
    return scheduleData.tripsMap[tripId].shape_id;
  }
  
  // Second try: match by block_id
  const blockId = extractBlockIdFromTripId(tripId);
  if (blockId) {
    for (const trip of Object.values(scheduleData.tripsMap)) {
      if (trip.block_id === blockId && trip.shape_id) {
        return trip.shape_id;
      }
    }
  }
  
  console.log(`[getShapeIdFromTrip] No shape found for ${tripId}`);
  return null;
}

// 3. Check if trip is active now (NO BUFFER - exact times only)
function isTripCurrentlyActive(stopTimes, currentTimeSec) {
  if (!stopTimes || stopTimes.length < 2) return false;
  
  const getTime = (st) => Number(st.departure?.time || st.arrival?.time || 0);
  const first = getTime(stopTimes[0]);
  const last = getTime(stopTimes[stopTimes.length - 1]);
  
  if (!first || !last || isNaN(first) || isNaN(last)) return false;
  
  // NO BUFFER - trip is active only during its scheduled time
  return currentTimeSec >= first && currentTimeSec <= last;
}

// 4. Find current segment between stops and exact progress (0–1) - NO BUFFERS
function findCurrentSegmentAndProgress(stopTimes, currentTimeSec) {
  if (!stopTimes || stopTimes.length === 0) return null;
  
  // Convert GTFS-RT stop times to simple array with times
  const stops = stopTimes.map(st => ({
    stop: st,
    time: Number(st.departure?.time || st.arrival?.time || 0)
  })).filter(s => s.time > 0); // remove invalid times
  
  if (stops.length === 0) return null;
  
  // Find which segment we're in (between stop i and i+1)
  for (let i = 0; i < stops.length - 1; i++) {
    const timeA = stops[i].time;
    const timeB = stops[i + 1].time;
    
    // Exact check - no buffers
    if (currentTimeSec >= timeA && currentTimeSec <= timeB) {
      const duration = timeB - timeA;
      const elapsed = currentTimeSec - timeA;
      const progress = duration > 0 ? elapsed / duration : 0;
      
      return {
        currentStop: stops[i].stop,
        nextStop: stops[i + 1].stop,
        progress: Math.max(0, Math.min(1, progress)),
        segmentStartTime: timeA,
        segmentEndTime: timeB
      };
    }
  }
  
  return null; // Not currently between any scheduled stops
}

// 5. Get static schedule for a trip (from stop_times.txt)
function getStaticScheduleForTrip(tripId, scheduleData) {
  if (!scheduleData?.stopTimesByTrip) return null;
  
  const staticStopTimes = scheduleData.stopTimesByTrip[tripId];
  if (!staticStopTimes || staticStopTimes.length === 0) return null;
  
  // Sort by stop_sequence to ensure correct order
  return staticStopTimes.sort((a, b) => a.stop_sequence - b.stop_sequence);
}

// 6. Convert current time to schedule time (seconds since midnight IN LOCAL TIME)
function getScheduleTimeInSeconds(operatorId = '36') {
  const now = new Date();
  
  let timeZone;
  switch(operatorId) {
    case '36': // Revelstoke
      timeZone = 'America/Los_Angeles'; // Pacific Time
      break;
    case '47': // Kelowna
    case '48': // Victoria
      timeZone = 'America/Vancouver'; // Pacific Time
      break;
    default:
      timeZone = 'America/Los_Angeles'; // Default to Pacific
  }
  
  const localTime = new Date(now.toLocaleString('en-US', { timeZone }));
  
  const hours = localTime.getHours();
  const minutes = localTime.getMinutes();
  const seconds = localTime.getSeconds();
  
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  
  // Debug log
  console.log(`[getScheduleTimeInSeconds] Operator: ${operatorId}, Timezone: ${timeZone}`);
  console.log(`[getScheduleTimeInSeconds] UTC: ${now.getUTCHours()}:${now.getUTCMinutes()}:${now.getUTCSeconds()}`);
  console.log(`[getScheduleTimeInSeconds] Local: ${hours}:${minutes}:${seconds} (${totalSeconds}s)`);
  
  return totalSeconds;
}

// 7. Find current segment in static schedule (WITH MIDNIGHT CROSSING SUPPORT)
function findCurrentSegmentInStaticSchedule(staticStopTimes, currentScheduleSec, operatorId) {
  if (!staticStopTimes || staticStopTimes.length < 2) return null;
  
  for (let i = 0; i < staticStopTimes.length - 1; i++) {
    const stopA = staticStopTimes[i];
    const stopB = staticStopTimes[i + 1];
    
    const timeA = timeStringToSeconds(stopA.departure_time || stopA.arrival_time);
    const timeB = timeStringToSeconds(stopB.arrival_time || stopB.departure_time);
    
    // Handle midnight crossing: if timeB < timeA, assume next day
    const adjustedTimeB = timeB < timeA ? timeB + 86400 : timeB;
    
    // Also check if current time might need adjustment for comparison
    let adjustedCurrentTime = currentScheduleSec;
    if (adjustedTimeB > 86400 && currentScheduleSec < timeA) {
      adjustedCurrentTime = currentScheduleSec + 86400;
    }
    
    if (adjustedCurrentTime >= timeA && adjustedCurrentTime <= adjustedTimeB) {
      const segmentDuration = adjustedTimeB - timeA;
      const elapsed = adjustedCurrentTime - timeA;
      const progress = segmentDuration > 0 ? elapsed / segmentDuration : 0;
      
      return {
        stopA,
        stopB,
        timeA,
        timeB: adjustedTimeB,
        originalTimeB: timeB,
        distA: stopA.shape_dist_traveled || 0,
        distB: stopB.shape_dist_traveled || 0,
        progress: Math.max(0, Math.min(1, progress)),
        crossedMidnight: timeB < timeA
      };
    }
  }
  
  return null; // Not currently between scheduled stops
}

// 8. Calculate exact position along shape using distance-based interpolation
function calculateExactPositionAlongShape(tripId, scheduleData, currentScheduleSec, operatorId = '36') {
  // 1. Get static schedule for this trip
  const staticStopTimes = getStaticScheduleForTrip(tripId, scheduleData);
  if (!staticStopTimes) {
    console.log(`[calculateExactPosition] No static schedule for ${tripId}`);
    return null;
  }
  
  // 2. Get shape ID
  const shapeId = getShapeIdFromTrip(tripId, scheduleData);
  if (!shapeId) {
    console.log(`[calculateExactPosition] No shape for ${tripId}`);
    return null;
  }
  
  // 3. Get shape points
  const shapePoints = scheduleData.shapes?.[shapeId];
  if (!shapePoints || shapePoints.length < 2) {
    console.log(`[calculateExactPosition] No shape points for ${shapeId}`);
    return null;
  }
  
  // 4. Find current segment in schedule (with midnight crossing support)
  const segment = findCurrentSegmentInStaticSchedule(staticStopTimes, currentScheduleSec, operatorId);
  if (!segment) {
    console.log(`[calculateExactPosition] Not between scheduled stops for ${tripId} at ${currentScheduleSec}s (${formatTime(currentScheduleSec)})`);
    
    // Debug: show first and last stop times
    const firstStop = staticStopTimes[0];
    const lastStop = staticStopTimes[staticStopTimes.length - 1];
    const firstTime = timeStringToSeconds(firstStop.departure_time || firstStop.arrival_time);
    const lastTime = timeStringToSeconds(lastStop.arrival_time || lastStop.departure_time);
    console.log(`[calculateExactPosition] Debug ${tripId}: First stop at ${firstTime}s (${formatTime(firstTime)}), Last stop at ${lastTime}s (${formatTime(lastTime)})`);
    
    return null;
  }
  
  // 6. Calculate progress along this segment
  const timeProgress = segment.progress;
  const targetDistance = segment.distA + timeProgress * (segment.distB - segment.distA);
  
  // 7. Find point on shape at target distance
  const position = interpolateOnShapeAtDistance(shapePoints, targetDistance);
  if (!position) {
    console.log(`[calculateExactPosition] Could not interpolate at distance ${targetDistance}m`);
    return null;
  }
  
  return {
    latitude: position.lat,
    longitude: position.lon,
    bearing: position.bearing,
    progress: timeProgress,
    segmentStart: segment.stopA.stop_id,
    segmentEnd: segment.stopB.stop_id,
    crossedMidnight: segment.crossedMidnight
  };
}

// 9. Interpolate position on shape at exact distance
function interpolateOnShapeAtDistance(shapePoints, targetDistance) {
  if (!shapePoints || shapePoints.length === 0) return null;
  
  // Ensure points are sorted by sequence
  const sortedPoints = [...shapePoints].sort((a, b) => a.sequence - b.sequence);
  
  // Find segment containing target distance
  for (let i = 0; i < sortedPoints.length - 1; i++) {
    const p1 = sortedPoints[i];
    const p2 = sortedPoints[i + 1];
    
    // Skip if missing distance data
    if (p1.dist == null || p2.dist == null) continue;
    
    if (targetDistance >= p1.dist && targetDistance <= p2.dist) {
      const segmentLength = p2.dist - p1.dist;
      if (segmentLength <= 0) {
        // Zero or negative length segment
        return {
          lat: p1.lat,
          lon: p1.lon,
          bearing: calculateBearing(p1, p2)
        };
      }
      
      const progress = (targetDistance - p1.dist) / segmentLength;
      
      return {
        lat: p1.lat + (p2.lat - p1.lat) * progress,
        lon: p1.lon + (p2.lon - p1.lon) * progress,
        bearing: calculateBearing(p1, p2)
      };
    }
  }
  
  // Target distance outside shape bounds
  if (targetDistance <= sortedPoints[0].dist) {
    return {
      lat: sortedPoints[0].lat,
      lon: sortedPoints[0].lon,
      bearing: calculateBearing(sortedPoints[0], sortedPoints[1])
    };
  }
  
  if (targetDistance >= sortedPoints[sortedPoints.length - 1].dist) {
    const last = sortedPoints.length - 1;
    return {
      lat: sortedPoints[last].lat,
      lon: sortedPoints[last].lon,
      bearing: calculateBearing(sortedPoints[last - 1], sortedPoints[last])
    };
  }
  
  return null;
}

// 10. Calculate bearing (direction) between two points
function calculateBearing(pointA, pointB) {
  if (!pointA || !pointB) return null;
  
  const lat1 = pointA.lat * Math.PI / 180;
  const lat2 = pointB.lat * Math.PI / 180;
  const lon1 = pointA.lon * Math.PI / 180;
  const lon2 = pointB.lon * Math.PI / 180;
  
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
           Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  
  let bearing = Math.atan2(y, x) * 180 / Math.PI;
  bearing = (bearing + 180) % 360;
  
  return Math.round(bearing);
}

// 11. Convert time string (HH:MM:SS) to seconds since midnight
function timeStringToSeconds(timeStr) {
  if (!timeStr) return 0;
  
  const parts = timeStr.split(':');
  if (parts.length !== 3) return 0;
  
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseInt(parts[2], 10);
  
  if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return 0;
  
  return hours * 3600 + minutes * 60 + seconds;
}

// 12. Main function to calculate virtual bus position (for server.js to use)
function calculateVirtualBusPosition(tripId, currentTimeSec, scheduleData, operatorId = '36') {
  // Check if trip is scheduled today
  if (!isTripScheduledToday(tripId, scheduleData)) {
    console.log(`[calculateVirtualBusPosition] ${tripId} not scheduled today`);
    return null;
  }
  
  // CRITICAL FIX: Use the passed currentTimeSec as schedule time
  // This ensures position is calculated with the same time that gets cached
  const scheduleTimeSec = currentTimeSec;
  
  // Calculate position with the consistent schedule time
  const position = calculateExactPositionAlongShape(tripId, scheduleData, scheduleTimeSec, operatorId);
  
  if (!position) {
    // No fallback - better to return null than wrong position
    console.log(`[calculateVirtualBusPosition] No position for ${tripId}`);
    return null;
  }
  
  return {
    latitude: position.latitude,
    longitude: position.longitude,
    bearing: position.bearing,
    speed: 25, // Estimated speed in km/h
    progress: position.progress,
    segment: {
      start: position.segmentStart,
      end: position.segmentEnd
    },
    crossedMidnight: position.crossedMidnight,
    // Store the exact schedule time used for this calculation
    scheduleTimeUsed: scheduleTimeSec
  };
}

// 13. Route label helper
function getRouteDisplayName(routeId) {
  if (!routeId) return 'Bus';
  const match = routeId.match(/^(\d+)/);
  return match ? `Bus ${match[1]}` : `Bus ${routeId}`;
}

// 14. Check if trip is active in static schedule (WITH MIDNIGHT CROSSING SUPPORT)
function isTripActiveInStaticSchedule(staticStopTimes, currentScheduleSec) {
  if (!staticStopTimes || staticStopTimes.length < 2) return false;
  
  const firstStop = staticStopTimes[0];
  const lastStop = staticStopTimes[staticStopTimes.length - 1];
  
  const firstTime = timeStringToSeconds(firstStop.departure_time || firstStop.arrival_time);
  const lastTime = timeStringToSeconds(lastStop.arrival_time || lastStop.departure_time);
  
  if (isNaN(firstTime) || isNaN(lastTime)) return false;
  
  // Handle midnight crossing
  let adjustedLastTime = lastTime;
  let adjustedCurrentTime = currentScheduleSec;
  
  if (lastTime < firstTime) {
    // Schedule crosses midnight
    adjustedLastTime = lastTime + 86400;
    // If current time is before first time, it might be next day
    if (currentScheduleSec < firstTime) {
      adjustedCurrentTime = currentScheduleSec + 86400;
    }
  }
  
  // With 5 minute buffer for practical purposes
  const buffer = 300;
  const isActive = adjustedCurrentTime >= (firstTime - buffer) && adjustedCurrentTime <= (adjustedLastTime + buffer);
  
  // Debug logging
  console.log(`[isTripActiveInStaticSchedule] First: ${formatTime(firstTime)}, Last: ${formatTime(lastTime)}, Current: ${formatTime(currentScheduleSec)}, Active: ${isActive}, Adjusted: ${lastTime < firstTime ? 'YES' : 'NO'}`);
  
  return isActive;
}

// 15. Get today's date in YYYYMMDD format
function getCurrentDateStr() {
  const today = new Date();
  const year = today.getFullYear();
  const month = (today.getMonth() + 1).toString().padStart(2, '0');
  const day = today.getDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

// 16. Check if a trip should run today based on service_id
function isTripScheduledToday(tripId, scheduleData) {
  if (!scheduleData?.tripsMap || !scheduleData?.calendarDates) {
    console.log(`[isTripScheduledToday] Missing schedule data for ${tripId}`);
    return true; // Default to true if we can't check (backward compatibility)
  }
  
  const trip = scheduleData.tripsMap[tripId];
  if (!trip || !trip.service_id) {
    console.log(`[isTripScheduledToday] No service_id for ${tripId}`);
    return false; // If no service_id, assume not scheduled
  }
  
  const todayStr = getCurrentDateStr();
  const serviceDates = scheduleData.calendarDates[trip.service_id];
  
  if (!serviceDates) {
    console.log(`[isTripScheduledToday] No calendar dates for service ${trip.service_id} (trip ${tripId})`);
    return false; // If no calendar dates for this service, assume it doesn't run
  }
  
  const isRunningToday = serviceDates.has(todayStr);
  
  // Log occasional checks (1% of the time) to avoid spam
  if (Math.random() < 0.01 || isRunningToday === false) {
    console.log(`[isTripScheduledToday] ${tripId} (service ${trip.service_id}) on ${todayStr}: ${isRunningToday ? '✅ RUNS' : '❌ NOT TODAY'}`);
  }
  
  return isRunningToday;
}

// 17. Enhanced version that checks both time AND date
function isTripActiveAndScheduled(tripId, scheduleData, currentScheduleSec, operatorId = '36') {
  // First check if trip is scheduled today
  if (!isTripScheduledToday(tripId, scheduleData)) {
    return false;
  }
  
  // Then check if it's active in the schedule (time-wise)
  const staticStopTimes = getStaticScheduleForTrip(tripId, scheduleData);
  if (!staticStopTimes || staticStopTimes.length === 0) {
    return false;
  }
  
  return isTripActiveInStaticSchedule(staticStopTimes, currentScheduleSec);
}

// NEW: Calculate schedule time from a Unix timestamp
function getScheduleTimeFromUnix(unixTimestamp, operatorId = '36') {
  const date = new Date(unixTimestamp * 1000);
  
  let timeZone;
  switch(operatorId) {
    case '36': // Revelstoke
      timeZone = 'America/Los_Angeles'; // Pacific Time
      break;
    case '47': // Kelowna
    case '48': // Victoria
      timeZone = 'America/Vancouver'; // Pacific Time
      break;
    default:
      timeZone = 'America/Los_Angeles'; // Default to Pacific
  }
  
  const localTime = new Date(date.toLocaleString('en-US', { timeZone }));
  
  const hours = localTime.getHours();
  const minutes = localTime.getMinutes();
  const seconds = localTime.getSeconds();
  
  return hours * 3600 + minutes * 60 + seconds;
}

// NEW: Check if block is active (with 5-minute buffer before first trip)
function isBlockActive(blockId, scheduleData, currentScheduleSec, operatorId = '36') {
  // Get all trips in this block
  const tripsInBlock = [];
  for (const [tripId, trip] of Object.entries(scheduleData.tripsMap)) {
    if (trip.block_id === blockId) {
      const staticStopTimes = getStaticScheduleForTrip(tripId, scheduleData);
      if (staticStopTimes && staticStopTimes.length > 0) {
        const firstTime = timeStringToSeconds(staticStopTimes[0]?.departure_time || staticStopTimes[0]?.arrival_time);
        const lastTime = timeStringToSeconds(staticStopTimes[staticStopTimes.length - 1]?.arrival_time || staticStopTimes[staticStopTimes.length - 1]?.departure_time);
        
        if (!isNaN(firstTime) && !isNaN(lastTime)) {
          tripsInBlock.push({
            tripId,
            route_id: trip.route_id,
            firstTime,
            lastTime
          });
        }
      }
    }
  }
  
  if (tripsInBlock.length === 0) return false;
  
  // Sort trips by start time
  tripsInBlock.sort((a, b) => a.firstTime - b.firstTime);
  
  const firstTrip = tripsInBlock[0];
  const lastTrip = tripsInBlock[tripsInBlock.length - 1];
  
  // Handle midnight crossing
  let adjustedLastTime = lastTrip.lastTime;
  let adjustedCurrentTime = currentScheduleSec;
  
  if (lastTrip.lastTime < firstTrip.firstTime) {
    adjustedLastTime = lastTrip.lastTime + 86400;
    if (currentScheduleSec < firstTrip.firstTime) {
      adjustedCurrentTime = currentScheduleSec + 86400;
    }
  }
  
  // Block is active if current time is between (first trip start - 5 minutes) and last trip end
  const buffer = 300; // 5 minutes before first trip
  return adjustedCurrentTime >= (firstTrip.firstTime - buffer) && adjustedCurrentTime <= adjustedLastTime;
}

// NEW: Find current or most recent trip in block
function findCurrentOrRecentTripInBlock(blockId, scheduleData, currentScheduleSec, operatorId = '36') {
  const tripsInBlock = [];
  
  // Collect all trips in block with their times
  for (const [tripId, trip] of Object.entries(scheduleData.tripsMap)) {
    if (trip.block_id === blockId) {
      const staticStopTimes = getStaticScheduleForTrip(tripId, scheduleData);
      if (staticStopTimes && staticStopTimes.length > 0) {
        const firstTime = timeStringToSeconds(staticStopTimes[0]?.departure_time || staticStopTimes[0]?.arrival_time);
        const lastTime = timeStringToSeconds(staticStopTimes[staticStopTimes.length - 1]?.arrival_time || staticStopTimes[staticStopTimes.length - 1]?.departure_time);
        
        if (!isNaN(firstTime) && !isNaN(lastTime)) {
          tripsInBlock.push({
            tripId,
            route_id: trip.route_id,
            firstTime,
            lastTime
          });
        }
      }
    }
  }
  
  if (tripsInBlock.length === 0) return null;
  
  // Sort trips by start time
  tripsInBlock.sort((a, b) => a.firstTime - b.firstTime);
  
  // Handle midnight crossing for comparisons
  let adjustedCurrentTime = currentScheduleSec;
  const lastTrip = tripsInBlock[tripsInBlock.length - 1];
  
  if (lastTrip.lastTime < tripsInBlock[0].firstTime && currentScheduleSec < tripsInBlock[0].firstTime) {
    adjustedCurrentTime = currentScheduleSec + 86400;
  }
  
  // Find which trip we're in
  for (const trip of tripsInBlock) {
    let adjustedLastTime = trip.lastTime;
    if (trip.lastTime < trip.firstTime) {
      adjustedLastTime = trip.lastTime + 86400;
    }
    
    if (adjustedCurrentTime >= trip.firstTime && adjustedCurrentTime <= adjustedLastTime) {
      return {
        tripId: trip.tripId,
        routeId: trip.route_id,
        isActive: true,
        isDuringTrip: true
      };
    }
  }
  
  // If not during a trip, find the most recent completed trip
  let mostRecentTrip = null;
  let smallestTimeSince = Infinity;
  
  for (const trip of tripsInBlock) {
    let adjustedLastTime = trip.lastTime;
    let tripAdjustedCurrentTime = currentScheduleSec;
    
    // Handle midnight crossing
    if (trip.lastTime < trip.firstTime) {
      adjustedLastTime = trip.lastTime + 86400;
      if (currentScheduleSec < trip.firstTime) {
        tripAdjustedCurrentTime = currentScheduleSec + 86400;
      }
    }
    
    if (tripAdjustedCurrentTime > adjustedLastTime) {
      const timeSince = tripAdjustedCurrentTime - adjustedLastTime;
      if (timeSince < smallestTimeSince) {
        smallestTimeSince = timeSince;
        mostRecentTrip = trip;
      }
    }
  }
  
  if (mostRecentTrip) {
    return {
      tripId: mostRecentTrip.tripId,
      routeId: mostRecentTrip.route_id,
      isActive: true, // Still show during layover
      isDuringTrip: false,
      timeSinceLastTrip: smallestTimeSince
    };
  }
  
  // Check if we're before the first trip (with 5-minute buffer)
  const firstTrip = tripsInBlock[0];
  const buffer = 300; // 5 minutes
  if (adjustedCurrentTime >= (firstTrip.firstTime - buffer) && adjustedCurrentTime < firstTrip.firstTime) {
    return {
      tripId: firstTrip.tripId,
      routeId: firstTrip.route_id,
      isActive: true,
      isDuringTrip: false,
      timeUntilTrip: firstTrip.firstTime - adjustedCurrentTime
    };
  }
  
  return null;
}

// NEW: Block-based virtual bus position calculation
function calculateVirtualBusPositionForBlock(blockId, scheduleData, currentTimeSec, operatorId = '36') {
  const scheduleTimeSec = getScheduleTimeFromUnix(currentTimeSec, operatorId);
  
  // Check if block should be active
  if (!isBlockActive(blockId, scheduleData, scheduleTimeSec, operatorId)) {
    console.log(`[calculateVirtualBusPositionForBlock] Block ${blockId} not active`);
    return null;
  }
  
  // Find current or most recent trip
  const tripInfo = findCurrentOrRecentTripInBlock(blockId, scheduleData, scheduleTimeSec, operatorId);
  if (!tripInfo) {
    console.log(`[calculateVirtualBusPositionForBlock] No trip found for block ${blockId}`);
    return null;
  }
  
  // If during a trip, calculate normal position
  if (tripInfo.isDuringTrip) {
    const position = calculateVirtualBusPosition(tripInfo.tripId, scheduleTimeSec, scheduleData, operatorId);
    if (position) {
      return {
        ...position,
        tripId: tripInfo.tripId,
        routeId: tripInfo.routeId,
        blockId: blockId,
        status: 'IN_TRANSIT',
        layover: false
      };
    }
  } else {
    // During layover or before first trip
    // Get last stop of the trip
    const staticStopTimes = getStaticScheduleForTrip(tripInfo.tripId, scheduleData);
    if (staticStopTimes && staticStopTimes.length > 0) {
      const lastStop = staticStopTimes[staticStopTimes.length - 1];
      const stopCoords = scheduleData.stops[lastStop.stop_id];
      if (stopCoords) {
        return {
          latitude: stopCoords.lat,
          longitude: stopCoords.lon,
          bearing: null,
          speed: 0,
          progress: 1,
          segment: {
            start: lastStop.stop_id,
            end: lastStop.stop_id
          },
          tripId: tripInfo.tripId,
          routeId: tripInfo.routeId,
          blockId: blockId,
          status: tripInfo.timeUntilTrip ? 'BEFORE_FIRST_TRIP' : 'LAYOVER',
          layover: true,
          timeInfo: tripInfo.timeSinceLastTrip ? 
            `Layover: ${Math.round(tripInfo.timeSinceLastTrip / 60)} min` :
            tripInfo.timeUntilTrip ? 
            `Starts in ${Math.round(tripInfo.timeUntilTrip / 60)} min` : 'Layover'
        };
      }
    }
  }
  
  return null;
}

// Helper function to format seconds as HH:MM:SS
function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Export functions - make sure this matches what server.js imports
export {
  extractBlockIdFromTripId,
  getShapeIdFromTrip,
  isTripCurrentlyActive,
  findCurrentSegmentAndProgress,
  calculateVirtualBusPosition,
  calculateVirtualBusPositionForBlock, // NEW: Block-based calculation
  getRouteDisplayName,
  timeStringToSeconds,            
  getScheduleTimeInSeconds,
  isTripActiveInStaticSchedule,
  getStaticScheduleForTrip,
  isTripScheduledToday,
  isTripActiveAndScheduled,
  getScheduleTimeFromUnix,
  isBlockActive,                    // NEW
  findCurrentOrRecentTripInBlock    // NEW
};
