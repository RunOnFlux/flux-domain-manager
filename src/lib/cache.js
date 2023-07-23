const NodeCache = require('node-cache');

class ApplicationCache {
  constructor() {
    this.cache = new NodeCache();
    this.cacheKey = 'appCache';
  }

  getApplications() {
    const services = this.cache.get(this.cacheKey);
    if (!services) {
      return [];
    }
    return services;
  }

  setApplications(applications) {
    this.cache.set(this.cacheKey, applications);
  }
}

const CacheService = new ApplicationCache();

module.exports = CacheService;
