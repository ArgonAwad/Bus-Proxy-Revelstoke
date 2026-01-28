// virtual-updater.js
import virtualVehicleManager from './virtual-vehicles.js';

class VirtualUpdater {
  constructor(updateInterval = 30000) { // 30 seconds
    this.updateInterval = updateInterval;
    this.intervalId = null;
  }

  start() {
    console.log('🚀 Starting virtual vehicle updater...');
    
    this.intervalId = setInterval(() => {
      const updated = virtualVehicleManager.updateVirtualPositions();
      virtualVehicleManager.cleanupOldVehicles();
      
      if (updated.length > 0) {
        console.log(`🔄 Updated ${updated.length} virtual vehicles`);
      }
    }, this.updateInterval);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      console.log('⏹️ Stopped virtual vehicle updater');
    }
  }
}

export default new VirtualUpdater();
