// virtual-vehicles.js — enhanced shape-based interpolation + realistic GTFS-RT-like fields for virtual buses

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
  return currentTimeSec >= first && currentTimeSec <= last;
}

// 4. Find current segment between stops and exact progress (0–1) - NO BUFFERS
function findCurrentSegmentAndProgress(stopTimes, currentTimeSec) {
  if (!stopTimes || stopTimes.length === 0) return null;
  const stops = stopTimes.map(st => ({
    stop: st,
    time: Number(st.departure?.time || st.arrival?.time || 0)
  })).filter(s => s.time > 0);
  if (stops.length === 0) return null;
  for (let i = 0; i < stops.length - 1; i++) {
    const timeA = stops[i].time;
    const timeB = stops[i + 1].time;
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
  return null;
}

// 5. Get static schedule for a trip (from stop_times.txt)
function getStaticScheduleForTrip(tripId, scheduleData) {
  if (!scheduleData?.stopTimesByTrip) return null;
  const staticStopTimes = scheduleData.stopTimesByTrip[tripId];
  if (!staticStopTimes || staticStopTimes.length === 0) return null;
  return staticStopTimes.sort((a, b) => a.stop_sequence - b.stop_sequence);
}

// 6. Convert current time to schedule time (seconds since midnight IN LOCAL TIME)
function getScheduleTimeInSeconds(operatorId = '36') {
  const now = new Date();
  let timeZone;
  switch(operatorId) {
    case '36': timeZone = 'America/Los_Angeles'; break;
    case '47':
    case '48': timeZone = 'America/Vancouver'; break;
    default:   timeZone = 'America/Los_Angeles';
  }
  const localTime = new Date(now.toLocaleString('en-US', { timeZone }));
  const hours = localTime.getHours();
  const minutes = localTime.getMinutes();
  const seconds = localTime.getSeconds();
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
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
    const adjustedTimeB = timeB < timeA ? timeB + 86400 : timeB;
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
        crossedMidnight: timeB < timeA,
        stopSequence: stopA.stop_sequence || i + 1
      };
    }
  }
  return null;
}

// 8. Estimate realistic speed in km/h from shape distance and scheduled time
function estimateSpeed(distA, distB, timeA, timeB) {
  if (typeof distA !== 'number' || typeof distB !== 'number' || distB <= distA) return 0;
  if (timeB <= timeA || timeB - timeA === 0) return 0;
  const distanceMeters = distB - distA;
  const durationSeconds = timeB - timeA;
  const speedMs = distanceMeters / durationSeconds;
  const speedKmh = speedMs * 3.6;
  return Math.round(Math.max(0, Math.min(90, speedKmh))); // reasonable bus range
}

// 9. Calculate exact position along shape + GTFS-RT-like fields
function calculateExactPositionAlongShape(tripId, scheduleData, currentScheduleSec, operatorId = '36') {
  const staticStopTimes = getStaticScheduleForTrip(tripId, scheduleData);
  if (!staticStopTimes) return null;

  const shapeId = getShapeIdFromTrip(tripId, scheduleData);
  if (!shapeId) return null;

  const shapePoints = scheduleData.shapes?.[shapeId];
  if (!shapePoints || shapePoints.length < 2) return null;

  const segment = findCurrentSegmentInStaticSchedule(staticStopTimes, currentScheduleSec, operatorId);
  if (!segment) return null;

  const timeProgress = segment.progress;
  const targetDistance = segment.distA + timeProgress * (segment.distB - segment.distA);

  const position = interpolateOnShapeAtDistance(shapePoints, targetDistance);
  if (!position) return null;

  const speed = estimateSpeed(segment.distA, segment.distB, segment.timeA, segment.timeB);

  return {
    latitude: position.lat,
    longitude: position.lon,
    bearing: position.bearing,
    speed,
    progress: timeProgress,
    currentStopSequence: segment.stopSequence,
    stopId: segment.stopA.stop_id,
    segment: {
      start: segment.stopA.stop_id,
      end: segment.stopB.stop_id
    },
    crossedMidnight: segment.crossedMidnight
  };
}

// 10. Interpolate position on shape at exact distance
function interpolateOnShapeAtDistance(shapePoints, targetDistance) {
  if (!shapePoints || shapePoints.length === 0) return null;
  const sortedPoints = [...shapePoints].sort((a, b) => a.sequence - b.sequence);
  for (let i = 0; i < sortedPoints.length - 1; i++) {
    const p1 = sortedPoints[i];
    const p2 = sortedPoints[i + 1];
    if (p1.dist == null || p2.dist == null) continue;
    if (targetDistance >= p1.dist && targetDistance <= p2.dist) {
      const segmentLength = p2.dist - p1.dist;
      if (segmentLength <= 0) {
        return { lat: p1.lat, lon: p1.lon, bearing: calculateBearing(p1, p2) };
      }
      const progress = (targetDistance - p1.dist) / segmentLength;
      return {
        lat: p1.lat + (p2.lat - p1.lat) * progress,
        lon: p1.lon + (p2.lon - p1.lon) * progress,
        bearing: calculateBearing(p1, p2)
      };
    }
  }
  if (targetDistance <= sortedPoints[0].dist) {
    return {
      lat: sortedPoints[0].lat,
      lon: sortedPoints[0].lon,
      bearing: calculateBearing(sortedPoints[0], sortedPoints[1] || sortedPoints[0])
    };
  }
  if (targetDistance >= sortedPoints[sortedPoints.length - 1].dist) {
    const last = sortedPoints.length - 1;
    return {
      lat: sortedPoints[last].lat,
      lon: sortedPoints[last].lon,
      bearing: calculateBearing(sortedPoints[last - 1] || sortedPoints[last], sortedPoints[last])
    };
  }
  return null;
}

// 11. Calculate bearing between two points
function calculateBearing(pointA, pointB) {
  if (!pointA || !pointB) return null;
  const lat1 = pointA.lat * Math.PI / 180;
  const lat2 = pointB.lat * Math.PI / 180;
  const lon1 = pointA.lon * Math.PI / 180;
  const lon2 = pointB.lon * Math.PI / 180;
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  let bearing = Math.atan2(y, x) * 180 / Math.PI;
  bearing = (bearing + 180) % 360;
  return Math.round(bearing);
}

// 12. Convert time string (HH:MM:SS) to seconds since midnight
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

// 13. Main function — single trip position (used internally by block function)
function calculateVirtualBusPosition(tripId, currentTimeSec, scheduleData, operatorId = '36') {
  if (!isTripScheduledToday(tripId, scheduleData)) {
    console.log(`[calculateVirtualBusPosition] ${tripId} not scheduled today`);
    return null;
  }

  const scheduleTimeSec = getScheduleTimeFromUnix(currentTimeSec, operatorId);
  const pos = calculateExactPositionAlongShape(tripId, scheduleData, scheduleTimeSec, operatorId);
  if (!pos) {
    console.log(`[calculateVirtualBusPosition] No valid position for trip ${tripId}`);
    return null;
  }

  const tripRecord = scheduleData.tripsMap?.[tripId] || {};

  // Get first stop time for meaningful startTime
  const staticStopTimes = getStaticScheduleForTrip(tripId, scheduleData);
  const firstStop = staticStopTimes?.[0];
  let startTime = '';
  if (firstStop) {
    const depOrArr = firstStop.departure_time || firstStop.arrival_time || '00:00:00';
    const sec = timeStringToSeconds(depOrArr);
    startTime = formatTime(sec);
  }

  return {
    latitude: pos.latitude,
    longitude: pos.longitude,
    bearing: pos.bearing ?? null,
    speed: pos.speed,
    currentStopSequence: pos.currentStopSequence ?? 1,
    stopId: pos.stopId ?? null,
    timestamp: Math.floor(currentTimeSec),
    currentStatus: pos.progress < 0.01 ? 1 : pos.progress >= 0.99 ? 0 : 2,
    progress: pos.progress,
    segment: pos.segment,
    crossedMidnight: pos.crossedMidnight,
    trip: {
      tripId,
      routeId: tripRecord.route_id || 'UNKNOWN',
      directionId: Number(tripRecord.direction_id) || 0,
      blockId: tripRecord.block_id || extractBlockIdFromTripId(tripId),
      tripHeadsign: tripRecord.trip_headsign || null,
      startDate: getCurrentDateStr(),   // YYYYMMDD
      startTime: startTime || '—'       // e.g. "05:20:00"
    },
    metadata: {
      source: 'static_schedule',
      isVirtual: true,
      speedSource: 'calculated_from_shape_and_time'
    }
  };
}

// 14. Route label helper
function getRouteDisplayName(routeId) {
  if (!routeId) return 'Bus';
  const match = routeId.match(/^(\d+)/);
  return match ? `Bus ${match[1]}` : `Bus ${routeId}`;
}

// 15. Check if trip is active in static schedule (WITH MIDNIGHT CROSSING SUPPORT)
function isTripActiveInStaticSchedule(staticStopTimes, currentScheduleSec) {
  if (!staticStopTimes || staticStopTimes.length < 2) return false;
  const firstStop = staticStopTimes[0];
  const lastStop = staticStopTimes[staticStopTimes.length - 1];
  const firstTime = timeStringToSeconds(firstStop.departure_time || firstStop.arrival_time);
  const lastTime = timeStringToSeconds(lastStop.arrival_time || lastStop.departure_time);
  if (isNaN(firstTime) || isNaN(lastTime)) return false;
  let adjustedLastTime = lastTime;
  let adjustedCurrentTime = currentScheduleSec;
  if (lastTime < firstTime) {
    adjustedLastTime = lastTime + 86400;
    if (currentScheduleSec < firstTime) adjustedCurrentTime += 86400;
  }
  const buffer = 300;
  return adjustedCurrentTime >= (firstTime - buffer) && adjustedCurrentTime <= (adjustedLastTime + buffer);
}

// 16. Get today's date in YYYYMMDD format
function getCurrentDateStr() {
  const today = new Date();
  const year = today.getFullYear();
  const month = (today.getMonth() + 1).toString().padStart(2, '0');
  const day = today.getDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

// 17. Check if a trip should run today based on service_id
function isTripScheduledToday(tripId, scheduleData) {
  if (!scheduleData?.tripsMap) {
    console.log(`[isTripScheduledToday] Missing tripsMap for ${tripId}`);
    return false;
  }

  const trip = scheduleData.tripsMap[tripId];
  if (!trip || !trip.service_id) {
    console.log(`[isTripScheduledToday] No service_id for trip ${tripId}`);
    return false;
  }

  const serviceId = trip.service_id;
  const todayStr = getCurrentDateStr();
  const todayNum = parseInt(todayStr, 10);
  const today = new Date();
  const dayOfWeek = today.getDay();
  const currentSec = getScheduleTimeInSeconds();

  let isScheduled = false;

  // 1. Weekly pattern (calendar.txt) - if exists
  const weekly = scheduleData.calendars?.[serviceId];
  if (weekly) {
    const start = parseInt(weekly.start_date, 10);
    const end = parseInt(weekly.end_date, 10);
    if (todayNum >= start && todayNum <= end) {
      const days = [
        weekly.sunday, weekly.monday, weekly.tuesday, weekly.wednesday,
        weekly.thursday, weekly.friday, weekly.saturday
      ];
      isScheduled = !!days[dayOfWeek];
    }
  }

  // 2. Explicit exceptions (calendar_dates.txt)
  const dateExceptions = scheduleData.calendarDates?.[serviceId];
  if (dateExceptions) {
    // Check if today is explicitly added
    if (dateExceptions.added && dateExceptions.added.has(todayStr)) {
      isScheduled = true;
    }
    // Check if today is explicitly removed (overrides weekly pattern)
    if (dateExceptions.removed && dateExceptions.removed.has(todayStr)) {
      isScheduled = false;
    }
  }

  // 3. Midnight-crossing continuation: allow yesterday's service if early morning
  if (!isScheduled && currentSec < 21600) { // before 6:00 AM
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
    
    // Check yesterday's weekly pattern
    if (weekly) {
      const yesterdayDay = (dayOfWeek - 1 + 7) % 7;
      const days = [
        weekly.sunday, weekly.monday, weekly.tuesday, weekly.wednesday,
        weekly.thursday, weekly.friday, weekly.saturday
      ];
      if (days[yesterdayDay]) {
        isScheduled = true;
      }
    }
    
    // Check yesterday's explicit exceptions
    if (dateExceptions) {
      // Yesterday was explicitly added
      if (dateExceptions.added && dateExceptions.added.has(yesterdayStr)) {
        isScheduled = true;
      }
      // Yesterday was explicitly removed (should already be false from above)
      if (dateExceptions.removed && dateExceptions.removed.has(yesterdayStr)) {
        isScheduled = false;
      }
    }
  }

  // 4. SPECIAL CASE: If there's NO weekly pattern but there ARE date exceptions,
  // then the trip ONLY runs on explicitly added dates
  if (!weekly && dateExceptions) {
    // Only check added dates (removed dates don't apply if no weekly pattern)
    if (dateExceptions.added && dateExceptions.added.has(todayStr)) {
      isScheduled = true;
    } else if (currentSec < 21600) { // Check yesterday for early morning
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
      if (dateExceptions.added && dateExceptions.added.has(yesterdayStr)) {
        isScheduled = true;
      }
    } else {
      isScheduled = false; // Not explicitly added today
    }
  }

  console.log(`[isTripScheduledToday] ${tripId} (svc ${serviceId}) on ${todayStr} (${formatTime(currentSec)}): ${isScheduled ? 'YES' : 'NO'}`);
  return isScheduled;
}

// 18. Enhanced version that checks both time AND date
function isTripActiveAndScheduled(tripId, scheduleData, currentScheduleSec, operatorId = '36') {
  if (!isTripScheduledToday(tripId, scheduleData)) return false;
  const staticStopTimes = getStaticScheduleForTrip(tripId, scheduleData);
  if (!staticStopTimes || staticStopTimes.length === 0) return false;
  return isTripActiveInStaticSchedule(staticStopTimes, currentScheduleSec);
}

// 19. Calculate schedule time from a Unix timestamp
function getScheduleTimeFromUnix(unixTimestamp, operatorId = '36') {
  const date = new Date(unixTimestamp * 1000);
  let timeZone;
  switch(operatorId) {
    case '36': timeZone = 'America/Los_Angeles'; break;
    case '47':
    case '48': timeZone = 'America/Vancouver'; break;
    default:   timeZone = 'America/Los_Angeles';
  }
  const localTime = new Date(date.toLocaleString('en-US', { timeZone }));
  return localTime.getHours() * 3600 + localTime.getMinutes() * 60 + localTime.getSeconds();
}

// 20. Check if block is active (with 10-minute buffer before first trip)
function isBlockActive(blockId, scheduleData, currentScheduleSec, operatorId = '36') {
  const tripsInBlock = [];
  for (const [tripId, trip] of Object.entries(scheduleData.tripsMap)) {
    if (trip.block_id === blockId) {
      const staticStopTimes = getStaticScheduleForTrip(tripId, scheduleData);
      if (staticStopTimes && staticStopTimes.length > 0) {
        const firstTime = timeStringToSeconds(staticStopTimes[0]?.departure_time || staticStopTimes[0]?.arrival_time);
        const lastTime = timeStringToSeconds(staticStopTimes[staticStopTimes.length - 1]?.arrival_time || staticStopTimes[staticStopTimes.length - 1]?.departure_time);
        if (!isNaN(firstTime) && !isNaN(lastTime)) {
          tripsInBlock.push({ tripId, route_id: trip.route_id, firstTime, lastTime });
        }
      }
    }
  }
  if (tripsInBlock.length === 0) return false;
  tripsInBlock.sort((a, b) => a.firstTime - b.firstTime);
  const firstTrip = tripsInBlock[0];
  const lastTrip = tripsInBlock[tripsInBlock.length - 1];
  let adjustedLastTime = lastTrip.lastTime;
  let adjustedCurrentTime = currentScheduleSec;
  if (lastTrip.lastTime < firstTrip.firstTime) {
    adjustedLastTime = lastTrip.lastTime + 86400;
    if (currentScheduleSec < firstTrip.firstTime) adjustedCurrentTime += 86400;
  }
  const buffer = 600; // 10 minutes
  return adjustedCurrentTime >= (firstTrip.firstTime - buffer) && adjustedCurrentTime <= adjustedLastTime;
}

// 21. Find current or most recent trip in block
function findCurrentOrRecentTripInBlock(blockId, scheduleData, currentScheduleSec, operatorId = '36') {
  const tripsInBlock = [];
  for (const [tripId, trip] of Object.entries(scheduleData.tripsMap)) {
    if (trip.block_id === blockId) {
      const staticStopTimes = getStaticScheduleForTrip(tripId, scheduleData);
      if (staticStopTimes && staticStopTimes.length > 0) {
        const firstTime = timeStringToSeconds(staticStopTimes[0]?.departure_time || staticStopTimes[0]?.arrival_time);
        const lastTime = timeStringToSeconds(staticStopTimes[staticStopTimes.length - 1]?.arrival_time || staticStopTimes[staticStopTimes.length - 1]?.departure_time);
        if (!isNaN(firstTime) && !isNaN(lastTime)) {
          tripsInBlock.push({ tripId, route_id: trip.route_id, firstTime, lastTime });
        }
      }
    }
  }
  if (tripsInBlock.length === 0) return null;
  tripsInBlock.sort((a, b) => a.firstTime - b.firstTime);
  let adjustedCurrentTime = currentScheduleSec;
  if (tripsInBlock[tripsInBlock.length - 1].lastTime < tripsInBlock[0].firstTime && currentScheduleSec < tripsInBlock[0].firstTime) {
    adjustedCurrentTime += 86400;
  }
  for (const trip of tripsInBlock) {
    let adjustedLastTime = trip.lastTime;
    if (trip.lastTime < trip.firstTime) adjustedLastTime += 86400;
    if (adjustedCurrentTime >= trip.firstTime && adjustedCurrentTime <= adjustedLastTime) {
      return { tripId: trip.tripId, routeId: trip.route_id, isActive: true, isDuringTrip: true };
    }
  }
  let mostRecentTrip = null;
  let smallestTimeSince = Infinity;
  for (const trip of tripsInBlock) {
    let adjustedLastTime = trip.lastTime;
    let tripAdjustedCurrentTime = currentScheduleSec;
    if (trip.lastTime < trip.firstTime) {
      adjustedLastTime += 86400;
      if (currentScheduleSec < trip.firstTime) tripAdjustedCurrentTime += 86400;
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
      isActive: true,
      isDuringTrip: false,
      timeSinceLastTrip: smallestTimeSince
    };
  }
  const firstTrip = tripsInBlock[0];
  const buffer = 600;
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

// 22. Block-based virtual bus — returns richer GTFS-RT-like object
function calculateVirtualBusPositionForBlock(blockId, scheduleData, currentTimeSec, operatorId = '36') {
  const scheduleTimeSec = getScheduleTimeFromUnix(currentTimeSec, operatorId);

  if (!isBlockActive(blockId, scheduleData, scheduleTimeSec, operatorId)) {
    console.log(`[calculateVirtualBusPositionForBlock] Block ${blockId} not active`);
    return null;
  }

  const tripInfo = findCurrentOrRecentTripInBlock(blockId, scheduleData, scheduleTimeSec, operatorId);
  if (!tripInfo) {
    console.log(`[calculateVirtualBusPositionForBlock] No trip found for block ${blockId}`);
    return null;
  }

  const tripId = tripInfo.tripId;
  const tripRecord = scheduleData.tripsMap?.[tripId] || {};

  // Get first stop time (used for both in-transit and layover cases)
  const staticStopTimes = getStaticScheduleForTrip(tripId, scheduleData);
  const firstStop = staticStopTimes?.[0];
  let startTime = '';
  if (firstStop) {
    const depOrArr = firstStop.departure_time || firstStop.arrival_time || '00:00:00';
    const sec = timeStringToSeconds(depOrArr);
    startTime = formatTime(sec);
  }

  if (tripInfo.isDuringTrip) {
    const pos = calculateExactPositionAlongShape(tripId, scheduleData, scheduleTimeSec, operatorId);
    if (!pos) return null;

    return {
      latitude: pos.latitude,
      longitude: pos.longitude,
      bearing: pos.bearing ?? null,
      speed: pos.speed,
      currentStopSequence: pos.currentStopSequence ?? 1,
      stopId: pos.stopId ?? null,
      timestamp: Math.floor(currentTimeSec),
      currentStatus: pos.progress < 0.01 ? 1 : pos.progress >= 0.99 ? 0 : 2,
      progress: pos.progress,
      segment: pos.segment,
      crossedMidnight: pos.crossedMidnight,
      trip: {
        tripId,
        routeId: tripRecord.route_id || 'UNKNOWN',
        directionId: Number(tripRecord.direction_id) || 0,
        blockId,
        tripHeadsign: tripRecord.trip_headsign || null,
        startDate: getCurrentDateStr(),
        startTime: startTime || '—'
      },
      status: 'IN_TRANSIT',
      layover: false,
      metadata: {
        source: 'static_schedule',
        isVirtual: true,
        speedSource: 'calculated_from_shape_and_time'
      }
    };
  }

  // Layover or before first trip
  if (!staticStopTimes || staticStopTimes.length === 0) return null;

  let stop, progress, status, timeInfo, currentStatus;

  if (tripInfo.timeUntilTrip) {
    stop = staticStopTimes[0];
    progress = 0;
    status = 'BEFORE_FIRST_TRIP';
    timeInfo = `Starts in ${Math.round(tripInfo.timeUntilTrip / 60)} min`;
    currentStatus = 1; // STOPPED_AT
  } else {
    stop = staticStopTimes[staticStopTimes.length - 1];
    progress = 1;
    status = 'LAYOVER';
    timeInfo = `Layover: ${Math.round(tripInfo.timeSinceLastTrip / 60)} min`;
    currentStatus = 1; // STOPPED_AT
  }

  const stopCoords = scheduleData.stops?.[stop.stop_id];
  if (!stopCoords) return null;

  return {
    latitude: stopCoords.lat,
    longitude: stopCoords.lon,
    bearing: null,
    speed: 0,
    progress,
    currentStopSequence: stop.stop_sequence || 1,
    stopId: stop.stop_id,
    timestamp: Math.floor(currentTimeSec),
    currentStatus,
    trip: {
      tripId,
      routeId: tripRecord.route_id || 'UNKNOWN',
      directionId: Number(tripRecord.direction_id) || 0,
      blockId,
      tripHeadsign: tripRecord.trip_headsign || null,
      startDate: getCurrentDateStr(),
      startTime: startTime || '—'
    },
    segment: {
      start: stop.stop_id,
      end: stop.stop_id
    },
    status,
    layover: true,
    timeInfo,
    metadata: {
      source: 'static_schedule',
      isVirtual: true
    }
  };
}

// Helper: format seconds → HH:MM:SS
function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Exports — unchanged set (all needed functions are still here)
export {
  extractBlockIdFromTripId,
  getShapeIdFromTrip,
  isTripCurrentlyActive,
  findCurrentSegmentAndProgress,
  calculateVirtualBusPosition,
  calculateVirtualBusPositionForBlock,
  getRouteDisplayName,
  timeStringToSeconds,
  getScheduleTimeInSeconds,
  isTripActiveInStaticSchedule,
  getStaticScheduleForTrip,
  isTripScheduledToday,
  isTripActiveAndScheduled,
  getScheduleTimeFromUnix,
  isBlockActive,
  findCurrentOrRecentTripInBlock
};
