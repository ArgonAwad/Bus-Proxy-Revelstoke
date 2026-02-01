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
  // Before trip starts (at first stop)
  if (currentTimeSec < firstTime) {
    return { currentStop: stopTimes[0], nextStop: stopTimes[1] || null, progress: 0 };
  }
  // After trip ends (at last stop)
  if (currentTimeSec > lastTime) {
    return { currentStop: stopTimes[stopTimes.length - 1], nextStop: null, progress: 1 };
  }
  // Find current segment
  for (let i = 0; i < stops.length - 1; i++) {
    const depart = stops[i].time;
    const arrive = stops[i + 1].time || depart; // fallback if no arrival
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
export {
  extractBlockIdFromTripId,
  getShapeIdFromTrip,
  isTripCurrentlyActive,
  findCurrentStopAndProgress,
  calculateCurrentPosition,
  getRouteDisplayName
};
