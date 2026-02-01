// virtual-vehicles.js — complete minimal helper functions for on-demand virtual positions

// 1. Extract block ID from trip ID (last numeric part after colon)
export function extractBlockIdFromTripId(tripId) {
  if (!tripId || typeof tripId !== 'string') return null;
  const parts = tripId.split(':');
  if (parts.length >= 3) {
    const lastPart = parts[parts.length - 1];
    if (/^\d+$/.test(lastPart)) return lastPart;
  }
  return null;
}

// 2. Get shape ID from trip (match by block_id, fallback to first shape)
export function getShapeIdFromTrip(tripId, scheduleData) {
  if (!scheduleData?.tripsMap) {
    console.log('[getShapeIdFromTrip] No tripsMap in scheduleData');
    return null;
  }

  const blockId = extractBlockIdFromTripId(tripId);
  if (blockId) {
    for (const trip of Object.values(scheduleData.tripsMap)) {
      if (trip.block_id === blockId && trip.shape_id) {
        console.log(`[getShapeIdFromTrip] Found shape ${trip.shape_id} via block_id ${blockId}`);
        return trip.shape_id;
      }
    }
  }

  // Fallback: first available shape
  const firstShape = Object.keys(scheduleData.shapes || {})[0];
  if (firstShape) {
    console.log(`[getShapeIdFromTrip] Using fallback shape ${firstShape}`);
    return firstShape;
  }

  console.log(`[getShapeIdFromTrip] No shape found for ${tripId}`);
  return null;
}

// 3. Check if trip is active now (±5 min buffer)
export function isTripCurrentlyActive(stopTimes, currentTimeSec) {
  if (!stopTimes || stopTimes.length < 2) return false;

  const getTime = (st) => Number(st.departure?.time || st.arrival?.time || 0);
  const first = getTime(stopTimes[0]);
  const last = getTime(stopTimes[stopTimes.length - 1]);

  if (!first || !last || isNaN(first) || isNaN(last)) return false;

  const buffer = 300; // 5 minutes
  return currentTimeSec >= first - buffer && currentTimeSec <= last + buffer;
}

// 4. Find current stop, next stop, and progress (0–1)
export function findCurrentStopAndProgress(stopTimes, currentTimeSec) {
  if (!stopTimes || stopTimes.length === 0) return null;

  const stops = stopTimes.map((st, idx) => ({
    idx,
    stop: st,
    time: Number(st.departure?.time || st.arrival?.time || 0)
  }));

  const firstTime = stops[0].time;
  const lastTime = stops[stops.length - 1].time;

  if (isNaN(firstTime) || isNaN(lastTime)) return null;

  // Before trip starts
  if (currentTimeSec < firstTime - 300) {
    return { currentStop: stopTimes[0], nextStop: stopTimes[1] || null, progress: 0 };
  }

  // After trip ends
  if (currentTimeSec > lastTime + 900) {
    return { currentStop: stopTimes[stopTimes.length - 1], nextStop: null, progress: 1 };
  }

  // In a segment
  for (let i = 0; i < stops.length - 1; i++) {
    const depart = stops[i].time;
    const arrive = stops[i + 1].time || depart;

    if (currentTimeSec >= depart && currentTimeSec <= arrive) {
      const duration = arrive - depart;
      let progress = duration > 0 ? (currentTimeSec - depart) / duration : 0;
      // Dwell at start of segment for 30 seconds
      if (progress < 30 / duration) progress = 0;
      return {
        currentStop: stopTimes[i],
        nextStop: stopTimes[i + 1],
        progress: Math.max(0, Math.min(1, progress))
      };
    }
  }

  // Approaching next stop (after last departure)
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
export function calculateCurrentPosition(currentStop, nextStop, progress, scheduleData, tripId) {
  if (!scheduleData?.stops) {
    console.log('[POSITION] No stops in scheduleData → fallback');
    return { latitude: 50.9981, longitude: -118.1957, bearing: null, speed: 0 };
  }

  const stopId = String(currentStop.stopId).trim();
  const coords = scheduleData.stops[stopId];
  if (!coords) {
    console.log(`[POSITION] No coordinates for stop ${stopId} → fallback`);
    return { latitude: 50.9981, longitude: -118.1957, bearing: null, speed: 0 };
  }

  if (progress <= 0) {
    return { latitude: coords.lat, longitude: coords.lon, bearing: null, speed: 0 };
  }

  // Try shape interpolation
  if (tripId && progress > 0) {
    const pos = calculatePositionAlongShape(tripId, progress, scheduleData);
    if (pos) {
      console.log(`[POSITION] Shape success: ${pos.latitude.toFixed(6)}, ${pos.longitude.toFixed(6)}`);
      return pos;
    }
    console.log('[POSITION] Shape failed → falling back to linear');
  }

  // Linear fallback between stops
  if (nextStop) {
    const nextId = String(nextStop.stopId).trim();
    const nextCoords = scheduleData.stops[nextId];
    if (nextCoords) {
      const lat = coords.lat + (nextCoords.lat - coords.lat) * progress;
      const lon = coords.lon + (nextCoords.lon - coords.lon) * progress;
      const bearing = calculateBearing(coords.lat, coords.lon, nextCoords.lat, nextCoords.lon);
      return { latitude: lat, longitude: lon, bearing, speed: 25 };
    }
  }

  // Ultimate fallback: stay at current stop
  return { latitude: coords.lat, longitude: coords.lon, bearing: null, speed: 0 };
}

// 6. Interpolate position along shape (distance-based or uniform)
export function calculatePositionAlongShape(tripId, progress, scheduleData) {
  const trip = scheduleData.tripsMap?.[tripId];
  if (!trip?.shape_id) {
    console.log(`[SHAPE] No trip or shape_id for ${tripId}`);
    return null;
  }

  const shapeId = trip.shape_id;
  const points = scheduleData.shapes?.[shapeId];
  if (!points || points.length < 2) {
    console.log(`[SHAPE] Invalid shape ${shapeId}: ${points?.length || 0} points`);
    return null;
  }

  // Clamp progress
  progress = Math.max(0, Math.min(1, progress));

  // Distance-based interpolation if distances exist
  if (points[0].dist != null && points[points.length - 1].dist != null) {
    const totalDist = points[points.length - 1].dist;
    const target = progress * totalDist;

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      if (target >= p1.dist && target <= p2.dist) {
        const seg = p2.dist - p1.dist;
        const segProg = seg > 0 ? (target - p1.dist) / seg : 0;
        const lat = p1.lat + (p2.lat - p1.lat) * segProg;
        const lon = p1.lon + (p2.lon - p1.lon) * segProg;
        return {
          latitude: lat,
          longitude: lon,
          bearing: calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon),
          speed: 25
        };
      }
    }
  }

  // Uniform point-based fallback
  const idx = Math.floor(progress * (points.length - 1));
  const nextIdx = Math.min(idx + 1, points.length - 1);
  const frac = progress * (points.length - 1) - idx;
  const p1 = points[idx];
  const p2 = points[nextIdx];
  return {
    latitude: p1.lat + (p2.lat - p1.lat) * frac,
    longitude: p1.lon + (p2.lon - p1.lon) * frac,
    bearing: calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon),
    speed: 25
  };
}

// 7. Bearing calculation
export function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = deg => deg * Math.PI / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = Math.atan2(y, x);
  θ = (θ * 180 / Math.PI + 360) % 360;
  return Math.round(θ);
}

// 8. Route label helper
export function getRouteDisplayName(routeId) {
  if (!routeId) return 'Bus';
  const match = routeId.match(/^(\d+)/);
  return match ? `Bus ${match[1]}` : `Bus ${routeId}`;
}

// Export everything
export {
  extractBlockIdFromTripId,
  getShapeIdFromTrip,
  isTripCurrentlyActive,
  findCurrentStopAndProgress,
  calculateCurrentPosition,
  calculatePositionAlongShape,
  calculateBearing,
  getRouteDisplayName
};
