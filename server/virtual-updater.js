// virtual-updater.js
import virtualVehicleManager from './virtual-vehicles.js';

class VirtualUpdater {
  constructor(updateInterval = 5000) { // 5 seconds (more frequent)
    this.updateInterval = updateInterval;
    this.intervalId = null;
    this.isRunning = false;
    this.lastUpdate = null;
  }

  start() {
    if (this.isRunning) {
      console.log('⚠️ Virtual updater already running');
      return;
    }
    
    console.log(`🚀 Starting virtual vehicle updater (${this.updateInterval}ms interval)...`);
    this.isRunning = true;
    this.lastUpdate = Date.now();
    
    this.intervalId = setInterval(() => {
      try {
        console.log(`⏰ Virtual updater running...`);
        const result = virtualVehicleManager.updateVirtualPositions();
        
        // Only log if something actually changed
        if (result.updated > 0 || result.removed > 0) {
          console.log(`📈 Virtual update: ${result.updated} updated, ${result.removed} removed`);
        }
        
        this.lastUpdate = Date.now();
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

  refresh() {
    console.log('🔄 Manually refreshing virtual positions');
    virtualVehicleManager.updateVirtualPositions();
    this.lastUpdate = Date.now();
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      updateInterval: this.updateInterval,
      lastUpdate: this.lastUpdate,
      virtualVehicles: virtualVehicleManager.virtualVehicles.size
    };
  }
}

// Create and export a singleton instance
const virtualUpdater = new VirtualUpdater();
export default virtualUpdater;
