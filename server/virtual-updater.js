// virtual-updater.js
import virtualVehicleManager from './virtual-vehicles.js';

class VirtualUpdater {
  constructor(updateInterval = 10000) { // 10 seconds (was 30)
    this.updateInterval = updateInterval;
    this.intervalId = null;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) {
      console.log('⚠️ Virtual updater already running');
      return;
    }
    
    console.log(`🚀 Starting virtual vehicle updater (${this.updateInterval}ms interval)...`);
    this.isRunning = true;
    
    this.intervalId = setInterval(() => {
      try {
        const updated = virtualVehicleManager.updateVirtualPositions();
        virtualVehicleManager.cleanupOldVehicles(60); // Clean up after 60 minutes
        
        // Only log if something actually changed
        if (updated > 0) {
          console.log(`🔄 Updated ${updated} virtual vehicle positions`);
        }
      } catch (error) {
        console.error('❌ Error in virtual vehicle update:', error);
      }
    }, this.updateInterval);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      console.log('⏹️ Stopped virtual vehicle updater');
    }
  }

  setUpdateInterval(interval) {
    this.updateInterval = interval;
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      updateInterval: this.updateInterval,
      virtualVehicles: virtualVehicleManager.getVirtualVehicleCount()
    };
  }
}

// Create and export a singleton instance
const virtualUpdater = new VirtualUpdater();
export default virtualUpdater;
