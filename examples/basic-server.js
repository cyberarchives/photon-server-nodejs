const { PhotonServer } = require('../src');
const logger = require('../src/utils/logger');
const path = require('path');
const fs = require('fs');

/**
 * Professional Photon Server Startup Script
 * Enterprise-grade server initialization with comprehensive
 * monitoring, error handling, and graceful shutdown
 */
class ServerManager {
    constructor() {
        this.server = null;
        this.statsInterval = null;
        this.healthCheckInterval = null;
        this.shutdownInProgress = false;
        this.startTime = Date.now();
        
        // Load configuration
        this.config = this._loadConfiguration();
        
        // Setup process handlers
        this._setupProcessHandlers();
        
        logger.info('ServerManager initialized', { 
            config: this.config,
            nodeVersion: process.version,
            platform: process.platform
        });
    }

    /**
     * Load server configuration from environment and config files
     * @private
     * @returns {Object} Server configuration
     */
    _loadConfiguration() {
        const defaultConfig = {
            port: 5055,
            host: '0.0.0.0',
            maxConnections: 100,
            pingInterval: 30000,
            connectionTimeout: 60000,
            cleanupInterval: 60000,
            emptyRoomTtl: 300000,
            enableMetrics: true,
            metricsInterval: 30000,
            enableHealthCheck: true,
            healthCheckInterval: 10000,
            logLevel: 'info',
            enableClustering: false,
            maxMemoryUsage: 1024 * 1024 * 1024, // 1GB
            gracefulShutdownTimeout: 10000
        };

        // Override with environment variables
        const envConfig = {
            port: process.env.PHOTON_PORT ? parseInt(process.env.PHOTON_PORT) : defaultConfig.port,
            host: process.env.PHOTON_HOST || defaultConfig.host,
            maxConnections: process.env.PHOTON_MAX_CONNECTIONS ? parseInt(process.env.PHOTON_MAX_CONNECTIONS) : defaultConfig.maxConnections,
            pingInterval: process.env.PHOTON_PING_INTERVAL ? parseInt(process.env.PHOTON_PING_INTERVAL) : defaultConfig.pingInterval,
            connectionTimeout: process.env.PHOTON_CONNECTION_TIMEOUT ? parseInt(process.env.PHOTON_CONNECTION_TIMEOUT) : defaultConfig.connectionTimeout,
            logLevel: process.env.LOG_LEVEL || defaultConfig.logLevel,
            enableMetrics: process.env.ENABLE_METRICS !== 'false',
            enableHealthCheck: process.env.ENABLE_HEALTH_CHECK !== 'false'
        };

        // Try to load config file
        const configPath = process.env.CONFIG_PATH || path.join(__dirname, '../config/server.json');
        let fileConfig = {};
        
        try {
            if (fs.existsSync(configPath)) {
                const configData = fs.readFileSync(configPath, 'utf8');
                fileConfig = JSON.parse(configData);
                logger.info('Configuration loaded from file', { configPath });
            }
        } catch (error) {
            logger.warn('Failed to load config file', { configPath, error: error.message });
        }

        // Merge configurations (env takes precedence)
        return { ...defaultConfig, ...fileConfig, ...envConfig };
    }

    /**
     * Setup process event handlers
     * @private
     */
    _setupProcessHandlers() {
        // Graceful shutdown handlers
        process.on('SIGINT', () => this._handleShutdown('SIGINT'));
        process.on('SIGTERM', () => this._handleShutdown('SIGTERM'));
        
        // Error handlers
        process.on('uncaughtException', (error) => this._handleUncaughtException(error));
        process.on('unhandledRejection', (reason, promise) => this._handleUnhandledRejection(reason, promise));
        
        // Memory monitoring
        process.on('warning', (warning) => this._handleProcessWarning(warning));
    }

    /**
     * Start the Photon server
     * @returns {Promise<void>}
     */
    async start() {
        try {
            logger.info('Starting Photon Server...', { 
                config: this.config,
                pid: process.pid,
                memory: process.memoryUsage()
            });

            // Create server instance
            this.server = new PhotonServer(this.config);
            
            // Setup server event listeners
            this._setupServerEvents();
            
            // Start the server
            await this.server.start();
            
            // Start monitoring services
            this._startMonitoring();
            
            // Log successful startup
            this._logStartupSuccess();
            
        } catch (error) {
            logger.error('Failed to start Photon Server', { 
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Setup server event listeners
     * @private
     */
    _setupServerEvents() {
        // Server lifecycle events
        this.server.on('started', () => {
            logger.info('Photon Server started successfully');
        });

        this.server.on('stopped', () => {
            logger.info('Photon Server stopped');
        });

        this.server.on('serverError', (error) => {
            logger.error('Server error occurred', { 
                error: error.message,
                stack: error.stack
            });
        });

        // Peer events
        this.server.on('peerConnected', (peer) => {
            logger.info('Peer connected', {
                peerId: peer.peerId,
                remoteAddress: peer._socket?.remoteAddress,
                totalConnections: this.server.getPeers().length
            });
        });

        this.server.on('peerDisconnected', (peer, reason) => {
            logger.info('Peer disconnected', {
                peerId: peer.peerId,
                playerName: peer.playerName || 'Anonymous',
                reason,
                sessionDuration: peer.connectionTime,
                totalConnections: this.server.getPeers().length
            });
        });

        // Room events
        this.server.on('roomCreated', (room) => {
            logger.info('Room created', {
                roomName: room.name,
                maxPlayers: room.maxPlayers,
                totalRooms: this.server.getRooms().length
            });
        });

        this.server.on('roomRemoved', (room) => {
            logger.info('Room removed', {
                roomName: room.name,
                totalRooms: this.server.getRooms().length
            });
        });

        // Performance events
        this.server.on('performanceWarning', (warning) => {
            logger.warn('⚠️ Performance warning', warning);
        });
    }

    /**
     * Start monitoring services
     * @private
     */
    _startMonitoring() {
        if (this.config.enableMetrics) {
            this._startMetricsReporting();
        }

        if (this.config.enableHealthCheck) {
            this._startHealthMonitoring();
        }

        this._startMemoryMonitoring();
    }

    /**
     * Start metrics reporting
     * @private
     */
    _startMetricsReporting() {
        this.statsInterval = setInterval(() => {
            try {
                const stats = this.server.getStats();
                const health = this.server.getHealthStatus();
                
                logger.info('Server Metrics', {
                    connections: stats.currentConnections,
                    rooms: stats.currentRooms,
                    totalMessages: stats.totalMessages,
                    uptime: Math.floor(stats.uptime / 1000),
                    memory: this._formatMemoryUsage(stats.memory),
                    health: health.status
                });

                // Log detailed performance metrics if enabled
                if (logger.isDebugEnabled()) {
                    const metrics = this.server.getMetrics();
                    logger.debug('Detailed metrics', metrics);
                }

            } catch (error) {
                logger.error('Error collecting metrics', { error: error.message });
            }
        }, this.config.metricsInterval);
    }

    /**
     * Start health monitoring
     * @private
     */
    _startHealthMonitoring() {
        this.healthCheckInterval = setInterval(() => {
            try {
                const health = this.server.getHealthStatus();
                
                if (health.status === 'degraded') {
                    logger.warn('Server health degraded', health);
                } else if (health.status === 'down') {
                    logger.error('Server health critical', health);
                }

                // Check individual room health
                const unhealthyRooms = this.server.getRooms()
                    .map(room => ({ room, health: room.getHealthStatus() }))
                    .filter(({ health }) => health.status !== 'healthy');

                if (unhealthyRooms.length > 0) {
                    logger.warn('Unhealthy rooms detected', {
                        count: unhealthyRooms.length,
                        rooms: unhealthyRooms.map(({ room, health }) => ({
                            name: room.name,
                            status: health.status,
                            issues: health.issues
                        }))
                    });
                }

            } catch (error) {
                logger.error('Error during health check', { error: error.message });
            }
        }, this.config.healthCheckInterval);
    }

    /**
     * Start memory monitoring
     * @private
     */
    _startMemoryMonitoring() {
        setInterval(() => {
            const memUsage = process.memoryUsage();
            
            if (memUsage.heapUsed > this.config.maxMemoryUsage * 0.9) {
                logger.warn('🔶 High memory usage detected', {
                    current: this._formatBytes(memUsage.heapUsed),
                    limit: this._formatBytes(this.config.maxMemoryUsage),
                    percentage: Math.round((memUsage.heapUsed / this.config.maxMemoryUsage) * 100)
                });

                // Trigger garbage collection if available
                if (global.gc) {
                    logger.info('Triggering garbage collection');
                    global.gc();
                }
            }
        }, 60000); // Check every minute
    }

    /**
     * Log successful startup information
     * @private
     */
    _logStartupSuccess() {
        const serverInfo = this.server.getServerInfo();
        const startupTime = Date.now() - this.startTime;
        
        logger.info('Photon Server startup completed', {
            startupTime: `${startupTime}ms`,
            version: serverInfo.version,
            host: serverInfo.host,
            port: serverInfo.port,
            maxConnections: this.config.maxConnections,
            features: {
                metrics: this.config.enableMetrics,
                healthCheck: this.config.enableHealthCheck,
                clustering: this.config.enableClustering
            }
        });

        // Display startup banner
        this._displayStartupBanner(serverInfo);
    }

    /**
     * Display startup banner
     * @private
     * @param {Object} serverInfo - Server information
     */
    _displayStartupBanner(serverInfo) {
        const banner = `
╔══════════════════════════════════════════════════════════════╗
║                    PHOTON SERVER STARTED                     ║
╠══════════════════════════════════════════════════════════════╣
║ Host: ${serverInfo.host.padEnd(48)}       ║
║ Port: ${serverInfo.port.toString().padEnd(48)}       ║
║ Max Connections: ${this.config.maxConnections.toString().padEnd(37)}       ║
║ Monitoring: ${(this.config.enableMetrics ? 'Enabled' : 'Disabled').padEnd(41)}        ║
║ Health Checks: ${(this.config.enableHealthCheck ? 'Enabled' : 'Disabled').padEnd(38)}        ║
║ Log Level: ${this.config.logLevel.padEnd(42)}        ║
╚══════════════════════════════════════════════════════════════╝
        `;
        
        console.log(banner);
    }

    /**
     * Handle graceful shutdown
     * @private
     * @param {string} signal - Shutdown signal
     */
    async _handleShutdown(signal) {
        if (this.shutdownInProgress) {
            logger.warn('Shutdown already in progress, forcing exit');
            process.exit(1);
        }

        this.shutdownInProgress = true;
        
        logger.info(`🛑 Received ${signal}, initiating graceful shutdown...`);

        try {
            // Stop monitoring
            this._stopMonitoring();
            
            // Stop server
            if (this.server) {
                await this.server.stop(this.config.gracefulShutdownTimeout);
            }
            
            logger.info('✅ Graceful shutdown completed');
            process.exit(0);
            
        } catch (error) {
            logger.error('❌ Error during shutdown', { error: error.message });
            process.exit(1);
        }
    }

    /**
     * Stop monitoring services
     * @private
     */
    _stopMonitoring() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }

        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }

        logger.debug('Monitoring services stopped');
    }

    /**
     * Handle uncaught exceptions
     * @private
     * @param {Error} error - Uncaught exception
     */
    _handleUncaughtException(error) {
        logger.fatal('💥 Uncaught Exception - Server will exit', {
            error: error.message,
            stack: error.stack
        });
        
        // Attempt graceful shutdown
        setTimeout(() => {
            process.exit(1);
        }, 1000);
        
        this._handleShutdown('UNCAUGHT_EXCEPTION').catch(() => {
            process.exit(1);
        });
    }

    /**
     * Handle unhandled promise rejections
     * @private
     * @param {*} reason - Rejection reason
     * @param {Promise} promise - Rejected promise
     */
    _handleUnhandledRejection(reason, promise) {
        logger.error('💥 Unhandled Promise Rejection', {
            reason: reason?.message || reason,
            stack: reason?.stack,
            promise: promise.toString()
        });
        
        // Don't exit on unhandled rejections in production, just log them
        if (process.env.NODE_ENV !== 'production') {
            setTimeout(() => {
                process.exit(1);
            }, 1000);
        }
    }

    /**
     * Handle process warnings
     * @private
     * @param {Warning} warning - Process warning
     */
    _handleProcessWarning(warning) {
        logger.warn('⚠️ Process Warning', {
            name: warning.name,
            message: warning.message,
            stack: warning.stack
        });
    }

    /**
     * Format memory usage for display
     * @private
     * @param {Object} memUsage - Memory usage object
     * @returns {Object} Formatted memory usage
     */
    _formatMemoryUsage(memUsage) {
        return {
            rss: this._formatBytes(memUsage.rss),
            heapTotal: this._formatBytes(memUsage.heapTotal),
            heapUsed: this._formatBytes(memUsage.heapUsed),
            external: this._formatBytes(memUsage.external)
        };
    }

    /**
     * Format bytes to human-readable format
     * @private
     * @param {number} bytes - Bytes to format
     * @returns {string} Formatted string
     */
    _formatBytes(bytes) {
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) return '0 Bytes';
        
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    }

    /**
     * Get server status for external monitoring
     * @returns {Object} Server status
     */
    getStatus() {
        if (!this.server) {
            return { status: 'not_started' };
        }

        return {
            status: this.server.isHealthy() ? 'healthy' : 'unhealthy',
            uptime: Date.now() - this.startTime,
            server: this.server.getServerInfo(),
            stats: this.server.getStats(),
            health: this.server.getHealthStatus()
        };
    }
}

// Create and start server manager
const serverManager = new ServerManager();

// Export for external access (useful for testing)
module.exports = serverManager;

// Start server if this file is run directly
if (require.main === module) {
    serverManager.start().catch((error) => {
        logger.fatal('Failed to start server', { error: error.message });
        process.exit(1);
    });
}