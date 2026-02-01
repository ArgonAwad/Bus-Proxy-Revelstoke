// virtual-vehicles.js - Minimal version: on-demand position calculation

// Plain functions - no class needed

function extractBlockIdFromTripId(tripId) {
  if (!tripId || typeof tripId !== 'string') return null;
  const parts = tripId.split(':');
  if (parts.length >= 3) {
    const lastPart = parts[parts.length - 1];
    if (/^\d+$/.test(lastPart)) return lastPart;
  }
  return null;
}

function getShapeIdFromTrip(tripId, scheduleData) {
  if (!scheduleData?.tripsMap) return null;

  const blockId = extractBlockIdFromTripId(tripId);
  if (blockId) {
    for (const trip of Object.values(scheduleData.tripsMap)) {
      if (trip.block_id === blockId && trip.shape_id) {
        return trip.shape_id;
      }
    }
  }

  // Fallback to first shape if nothing matches
  const firstShape = Object.keys(scheduleData.shapes || {})[0];
  return firstShape || null;
}

function isTripCurrentlyActive(stopTimes, currentTimeSec) {
  if (!stopTimes || stopTimes.length < 2) return false;

  const getTime = (st) => Number(st.departure?.time || st.arrival?.time || 0);
  const first = getTime(stopTimes[0]);
  const last = getTime(stopTimes[stopTimes.length - 1]);

  if (!first || !last) return false;

  const buffer = 300; // 5 min
  return currentTimeSec >= (first - buffer) && currentTimeSec <= (last + buffer);
}

function findCurrentStopAndProgress(stopTimes, currentTimeSec) {
  if (!stopTimes || stopTimes.length === 0) return null;

  const stops = stopTimes.map((st, idx) => ({
    idx,
    stop: st,
    time: Number(st.departure?.time || st.arrival?.time || 0)
  }));

  const firstTime = stops[0].time;
  const lastTime = stops[stops.length - 1].time;

  if (currentTimeSec < firstTime - 300) {
    return { currentStop: stopTimes[0], nextStop: stopTimes[1] || null, progress: 0 };
  }
  if (currentTimeSec > lastTime + 900) {
    return { currentStop: stopTimes[stopTimes.length - 1], nextStop: null, progress: 1 };
  }

  for (let i = 0; i < stops.length - 1; i++) {
    const depart = stops[i].time;
    const arrive = stops[i + 1].time || depart;
    if (currentTimeSec >= depart && currentTimeSec <= arrive) {
      const duration = arrive - depart;
      let progress = duration > 0 ? (currentTimeSec - depart) / duration : 0;
      if (progress < 30 / duration) progress = 0; // dwell
      return {
        currentStop: stopTimes[i],
        nextStop: stopTimes[i + 1],
        progress: Math.max(0, Math.min(1, progress))
      };
    }
  }

  // Approaching next
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

  return { currentStop: stopTimes[stopTimes.length - 1], nextStop: null, progress: 1 };
}

function calculatePositionAlongShape(tripId, progress, scheduleData) {
  const trip = scheduleData.tripsMap?.[tripId];
  if (!trip?.shape_id) return null;

  const shapeId = trip.shape_id;
  const points = scheduleData.shapes?.[shapeId];
  if (!points || points.length < 2) return null;

  // Distance-based if available
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
          bearing: calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon),
          speed: 25
        };
      }
    }
  }

  // Uniform point fallback
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

function calculateBearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = Math.atan2(y, x);
  θ = (θ * 180 / Math.PI + 360) % 360;
  return Math.round(θ);
}

function calculateCurrentPosition(currentStop, nextStop, progress, scheduleData, tripId) {
  if (!scheduleData?.stops) return { latitude: 50.9981, longitude: -118.1957, bearing: null, speed: 0 };

  const stopId = String(currentStop.stopId).trim();
  const coords = scheduleData.stops[stopId];
  if (!coords) return { latitude: 50.9981, longitude: -118.1957, bearing: null, speed: 0 };

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
      return {
        latitude: lat,
        longitude: lon,
        bearing: calculateBearing(coords.lat, coords.lon, nextCoords.lat, nextCoords.lon),
        speed: 25
      };
    }
  }

  return { latitude: coords.lat, longitude: coords.lon, bearing: null, speed: 0 };
}

// Export the minimal helpers
export {
  extractBlockIdFromTripId,
  getShapeIdFromTrip,
  isTripCurrentlyActive,
  findCurrentStopAndProgress,
  calculateCurrentPosition
};
