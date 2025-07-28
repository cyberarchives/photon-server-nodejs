class ServerStatsPlugin {
    constructor(context) {
        this.context = context;
        this.config = context.config;
        this.logger = context.logger;
        this.stats = {
            totalConnections: 0,
            totalDisconnections: 0,
            totalRoomsCreated: 0,
            totalRoomsDestroyed: 0,
            peakConnections: 0,
            startTime: Date.now()
        };
        
        this.config = {
            enabled: true,
            reportInterval: 60000, // 1 minute
            logDetailedStats: true,
            ...this.config
        };
    }

    async initialize() {
        this.logger.info('Server Stats plugin initializing...');
        
        // Register hooks for various events
        this.context.registerHook('peer:connected', this.onPeerConnected.bind(this));
        this.context.registerHook('peer:disconnected', this.onPeerDisconnected.bind(this));
        this.context.registerHook('room:created', this.onRoomCreated.bind(this));
        this.context.registerHook('room:destroyed', this.onRoomDestroyed.bind(this));
        
        // Start periodic reporting
        if (this.config.enabled) {
            this.startReporting();
        }
        
        this.logger.info('Server Stats plugin initialized successfully');
    }

    onPeerConnected(data) {
        this.stats.totalConnections++;
        const currentConnections = this.context.server.getPeers().length;
        this.stats.peakConnections = Math.max(this.stats.peakConnections, currentConnections);
        
        this.context.metrics.set('stats.total_connections', this.stats.totalConnections);
        this.context.metrics.set('stats.peak_connections', this.stats.peakConnections);
        
        return data;
    }

    onPeerDisconnected(data) {
        this.stats.totalDisconnections++;
        this.context.metrics.set('stats.total_disconnections', this.stats.totalDisconnections);
        return data;
    }

    onRoomCreated(data) {
        this.stats.totalRoomsCreated++;
        this.context.metrics.set('stats.total_rooms_created', this.stats.totalRoomsCreated);
        return data;
    }

    onRoomDestroyed(data) {
        this.stats.totalRoomsDestroyed++;
        this.context.metrics.set('stats.total_rooms_destroyed', this.stats.totalRoomsDestroyed);
        return data;
    }

    startReporting() {
        this.reportInterval = this.context.setInterval(() => {
            this.generateReport();
        }, this.config.reportInterval);
    }

    generateReport() {
        const serverStats = this.context.server.getStats();
        const uptime = Date.now() - this.stats.startTime;
        const uptimeMinutes = Math.floor(uptime / 60000);
        
        const report = {
            uptime: `${uptimeMinutes} minutes`,
            current: {
                connections: serverStats.currentConnections,
                rooms: serverStats.currentRooms
            },
            totals: {
                connections: this.stats.totalConnections,
                disconnections: this.stats.totalDisconnections,
                roomsCreated: this.stats.totalRoomsCreated,
                roomsDestroyed: this.stats.totalRoomsDestroyed
            },
            peak: {
                connections: this.stats.peakConnections
            },
            messages: serverStats.totalMessages
        };
        
        this.logger.info('📊 Server Statistics Report', report);
        
        if (this.config.logDetailedStats) {
            const memory = process.memoryUsage();
            this.logger.info('📈 Detailed Stats', {
                memory: {
                    heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
                    heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB'
                },
                averageConnectionsPerMinute: uptimeMinutes > 0 ? (this.stats.totalConnections / uptimeMinutes).toFixed(2) : 0
            });
        }
    }

    async cleanup() {
        if (this.reportInterval) {
            clearInterval(this.reportInterval);
        }
        
        // Generate final report
        this.generateReport();
        
        this.logger.info('Server Stats plugin cleaned up');
    }

    async onConfigUpdate(newConfig) {
        this.config = { ...this.config, ...newConfig };
        
        // Restart reporting if interval changed
        if (this.reportInterval) {
            clearInterval(this.reportInterval);
            if (this.config.enabled) {
                this.startReporting();
            }
        }
        
        this.logger.info('Server Stats configuration updated');
    }
}

module.exports = ServerStatsPlugin;