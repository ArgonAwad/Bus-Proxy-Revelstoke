// virtual-vehicles.js — minimal helpers for on-demand virtual bus positions

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

// 2. Get shape ID from trip (match by block_id or partial trip_id, fallback to first shape)
function getShapeIdFromTrip(tripId, scheduleData) {
  if (!scheduleData?.tripsMap) {
    console.log('[getShapeIdFromTrip] No tripsMap in scheduleData');
    return null;
  }
  const blockId = extractBlockIdFromTripId(tripId);
  const parts = tripId.split(':');
  const middleId = parts.length > 1 ? parts[1] : null;  // e.g. middle part for matching

  for (const [key, trip] of Object.entries(scheduleData.tripsMap)) {
    if (trip.block_id === blockId && trip.shape_id) {
      console.log(`[getShapeIdFromTrip] Found shape ${trip.shape_id} via block_id ${blockId}`);
      return trip.shape_id;
    }
    if (middleId && key.includes(middleId) && trip.shape_id) {
      console.log(`[getShapeIdFromTrip] Found shape ${trip.shape_id} via middleId ${middleId}`);
      return trip.shape_id;
    }
  }

  const firstShape = Object.keys(scheduleData.shapes || {})[0];
  if (firstShape) {
    console.log(`[getShapeIdFromTrip] Fallback shape ${firstShape}`);
    return firstShape;
  }
  console.log(`[getShapeIdFromTrip] No shape found for ${tripId}`);
  return null;
}

// 3. Check if trip is active now (±5 min buffer)
function isTripCurrentlyActive(stopTimes, currentTimeSec) {
  if (!stopTimes || stopTimes.length < 2) return false;

  const getTime = (st) => Number(st.departure?.time || st.arrival?.time || 0);
  const first = getTime(stopTimes[0]);
  const last = getTime(stopTimes[stopTimes.length - 1]);

  if (!first || !last || isNaN(first) || isNaN(last)) return false;

  const buffer = 300; // 5 min
  return currentTimeSec >= first - buffer && currentTimeSec <= last + buffer;
}

// 4. Find current stop, next stop, and progress (0–1) — no artificial dwell
function findCurrentStopAndProgress(stopTimes, currentTimeSec) {
  if (!stopTimes || stopTimes.length === 0) return null;

  const stops = stopTimes.map((st, idx) => ({
    idx,
    stop: st,
    time: Number(st.departure?.time || st.arrival?.time || 0)
  })).filter(s => s.time > 0); // skip invalid/zero times

  if (stops.length === 0) return null;

  const firstTime = stops[0].time;
  const lastTime = stops[stops.length - 1].time;

  // Before trip starts (allow small negative buffer)
  if (currentTimeSec < firstTime - 300) {  // 5 min buffer
    return {
      currentStop: stopTimes[0],
      nextStop: stopTimes[1] || null,
      progress: 0
    };
  }

  // After trip ends (allow small overrun buffer)
  if (currentTimeSec > lastTime + 300) {
    return {
      currentStop: stopTimes[stopTimes.length - 1],
      nextStop: null,
      progress: 1
    };
  }

  // Find the current segment
  for (let i = 0; i < stops.length - 1; i++) {
    const depart = stops[i].time;
    const arrive = stops[i + 1].time || depart;

    if (currentTimeSec >= depart && currentTimeSec <= arrive) {
      const duration = arrive - depart;
      const elapsed = currentTimeSec - depart;
      const progress = duration > 0 ? elapsed / duration : 0;
      return {
        currentStop: stopTimes[i],
        nextStop: stopTimes[i + 1],
        progress: Math.max(0, Math.min(1, progress))
      };
    }
  }

  // Fallback: time is after some stops but before others (approaching next)
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].time > currentTimeSec) {
      const prevIdx = i > 0 ? i - 1 : 0;
      const prev = stopTimes[prevIdx];
      const next = stopTimes[i];
      const departPrev = stops[prevIdx].time;
      const arrive = stops[i].time;
      const duration = arrive - departPrev;
      const elapsed = currentTimeSec - departPrev;
      const progress = duration > 0 ? elapsed / duration : 0;
      return {
        currentStop: prev,
        nextStop: next,
        progress: Math.min(1, progress)
      };
    }
  }

  // If we fall through (very rare), treat as end
  return {
    currentStop: stopTimes[stopTimes.length - 1],
    nextStop: null,
    progress: 1
  };
}

  // Approaching next stop
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].time > currentTimeSec) {
      const prev = i > 0 ? stopTimes[i - 1] : stopTimes[0];
      const next = stopTimes[i];
      const departPrev = stops[i - 1]?.time || stops[0].time;
      const arrive = stops[i].time;
      const duration = arrive - departPrev;
      const elapsed = currentTimeSec - departPrev;
      const progress = duration > 0 ? elapsed / duration : 0;
      return { currentStop: prev, nextStop: next, progress: Math.min(1, progress) };
    }
  }

  // Default: at end
  return { currentStop: stopTimes[stopTimes.length - 1], nextStop: null, progress: 1 };
}

// 5. Calculate position along shape (preferred) or linear fallback
function calculateCurrentPosition(currentStop, nextStop, progress, scheduleData, tripId) {
  if (!scheduleData?.stops) {
    console.log('[POSITION] No stops → fallback');
    return { latitude: 50.9981, longitude: -118.1957, bearing: null, speed: 0 };
  }

  const stopId = String(currentStop.stopId).trim();
  const coords = scheduleData.stops[stopId];
  if (!coords) {
    console.log(`[POSITION] No coords for stop ${stopId} → fallback`);
    return { latitude: 50.9981, longitude: -118.1957, bearing: null, speed: 0 };
  }

  if (progress <= 0) {
    return { latitude: coords.lat, longitude: coords.lon, bearing: null, speed: 0 };
  }

  // Try shape
  if (tripId && progress > 0) {
    const pos = calculatePositionAlongShape(tripId, progress, scheduleData);
    if (pos) return pos;
  }

  // Linear fallback
  if (nextStop) {
    const nextId = String(nextStop.stopId).trim();
    const nextCoords = scheduleData.stops[nextId];
    if (nextCoords) {
      const lat = coords.lat + (nextCoords.lat - coords.lat) * progress;
      const lon = coords.lon + (nextCoords.lon - coords.lon) * progress;
      return { latitude: lat, longitude: lon, bearing: null, speed: 25 };
    }
  }

  return { latitude: coords.lat, longitude: coords.lon, bearing: null, speed: 0 };
}

// 6. Interpolate position along shape
function calculatePositionAlongShape(tripId, progress, scheduleData) {
  const trip = scheduleData.tripsMap?.[tripId];
  if (!trip?.shape_id) return null;

  const shapeId = trip.shape_id;
  const points = scheduleData.shapes?.[shapeId];
  if (!points || points.length < 2) return null;

  progress = Math.max(0, Math.min(1, progress));

  if (points[0].dist != null && points[points.length - 1].dist != null) {
    const totalDist = points[points.length - 1].dist;
    const target = progress * totalDist;
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      if (target >= p1.dist && target <= p2.dist) {
        const seg = p2.dist - p1.dist;
        const segProg = seg > 0 ? (target - p1.dist) / seg : 0;
        return {
          latitude: p1.lat + (p2.lat - p1.lat) * segProg,
          longitude: p1.lon + (p2.lon - p1.lon) * segProg,
          bearing: null,
          speed: 25
        };
      }
    }
  }

  const idx = Math.floor(progress * (points.length - 1));
  const nextIdx = Math.min(idx + 1, points.length - 1);
  const frac = progress * (points.length - 1) - idx;
  const p1 = points[idx];
  const p2 = points[nextIdx];
  return {
    latitude: p1.lat + (p2.lat - p1.lat) * frac,
    longitude: p1.lon + (p2.lon - p1.lon) * frac,
    bearing: null,
    speed: 25
  };
}

// 7. Route label helper
function getRouteDisplayName(routeId) {
  if (!routeId) return 'Bus';
  const match = routeId.match(/^(\d+)/);
  return match ? `Bus ${match[1]}` : `Bus ${routeId}`;
}

// Export only what server.js imports
export {
  extractBlockIdFromTripId,
  getShapeIdFromTrip,
  isTripCurrentlyActive,
  findCurrentStopAndProgress,
  calculateCurrentPosition,
  getRouteDisplayName
};
