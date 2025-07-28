const { PhotonServer } = require('../src');
const PluginManager = require('../src/plugins/PluginManager');
const logger = require('../src/utils/logger');
const path = require('path');
const fs = require('fs');

/**
 * Professional Photon Server Startup Script with Plugin System
 * Enterprise-grade server initialization with comprehensive
 * monitoring, error handling, graceful shutdown, and plugin management
 */
class ServerManager {
    constructor() {
        this.server = null;
        this.pluginManager = null;
        this.statsInterval = null;
        this.healthCheckInterval = null;
        this.shutdownInProgress = false;
        this.startTime = Date.now();
        
        // Load configuration
        this.config = this._loadConfiguration();
        
        // Setup process handlers
        this._setupProcessHandlers();
        
        logger.info('ServerManager initialized', { 
            port: this.config.port,
            host: this.config.host,
            maxConnections: this.config.maxConnections,
            logLevel: this.config.logLevel,
            pluginsEnabled: this.config.enablePlugins,
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
            gracefulShutdownTimeout: 10000,
            
            // Plugin configuration
            enablePlugins: true,
            pluginsDir: './plugins',
            pluginConfigDir: './config/plugins',
            enabledPlugins: [], // Empty array = load all discovered plugins
            disabledPlugins: [],
            enablePluginSandboxing: true,
            enablePluginHotReload: process.env.NODE_ENV === 'development',
            pluginExecutionTimeout: 5000
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
            enableHealthCheck: process.env.ENABLE_HEALTH_CHECK !== 'false',
            enablePlugins: process.env.ENABLE_PLUGINS !== 'false',
            pluginsDir: process.env.PLUGINS_DIR || defaultConfig.pluginsDir,
            enablePluginSandboxing: process.env.ENABLE_PLUGIN_SANDBOXING !== 'false'
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
     * Start the Photon server with plugins
     * @returns {Promise<void>}
     */
    async start() {
        try {
            logger.info('Starting Photon Server...', { 
                port: this.config.port,
                host: this.config.host,
                maxConnections: this.config.maxConnections,
                pluginsEnabled: this.config.enablePlugins,
                pid: process.pid,
                memory: this._formatMemoryUsage(process.memoryUsage())
            });

            // Create server instance
            this.server = new PhotonServer(this.config);
            
            // Setup server event listeners
            this._setupServerEvents();
            
            // Initialize plugin system before starting server
            if (this.config.enablePlugins) {
                await this._initializePluginSystem();
            }
            
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
     * Initialize the plugin system
     * @private
     * @returns {Promise<void>}
     */
    async _initializePluginSystem() {
        try {
            logger.info('Initializing plugin system...');
            
            // Create plugin manager
            this.pluginManager = new PluginManager(this.server, {
                pluginsDir: this.config.pluginsDir,
                configDir: this.config.pluginConfigDir,
                enabledPlugins: this.config.enabledPlugins,
                disabledPlugins: this.config.disabledPlugins,
                enableSandboxing: this.config.enablePluginSandboxing,
                enableHotReload: this.config.enablePluginHotReload,
                maxExecutionTime: this.config.pluginExecutionTimeout,
                autoLoad: true,
                validatePlugins: true
            });
            
            // Setup plugin event handlers
            this._setupPluginEvents();
            
            // Initialize plugin manager
            await this.pluginManager.initialize();
            
            const pluginStats = this.pluginManager.getStats();
            logger.info('Plugin system initialized', {
                totalPlugins: pluginStats.totalPlugins,
                activePlugins: pluginStats.activePlugins,
                errorPlugins: pluginStats.errorPlugins,
                totalHooks: pluginStats.totalHooks
            });
            
        } catch (error) {
            logger.error('Failed to initialize plugin system', { error: error.message });
            
            // Decide whether to continue without plugins or fail
            if (this.config.requirePlugins) {
                throw error;
            } else {
                logger.warn('Continuing without plugin system');
                this.pluginManager = null;
            }
        }
    }

    /**
     * Setup plugin event handlers
     * @private
     */
    _setupPluginEvents() {
        // Plugin lifecycle events
        this.pluginManager.on('pluginLoaded', (pluginInfo) => {
            logger.info('Plugin loaded', {
                name: pluginInfo.name,
                version: pluginInfo.manifest.version,
                author: pluginInfo.manifest.author,
                description: pluginInfo.manifest.description
            });
        });

        this.pluginManager.on('pluginUnloaded', (pluginInfo) => {
            logger.info('Plugin unloaded', {
                name: pluginInfo.name
            });
        });

        this.pluginManager.on('initialized', () => {
            logger.info('Plugin system fully initialized');
        });

        // Plugin-specific events (examples)
        this.pluginManager.on('antiCheatViolation', (data) => {
            logger.warn('Anti-cheat violation detected', {
                peerId: data.peer.peerId,
                playerName: data.peer.playerName,
                violationType: data.violationType,
                details: data.details,
                totalViolations: data.totalViolations
            });
        });

        this.pluginManager.on('playerBanned', (data) => {
            logger.error('Player banned by plugin', {
                peerId: data.peer.peerId,
                playerName: data.peer.playerName,
                reason: data.reason
            });
        });

        this.pluginManager.on('chatViolation', (data) => {
            logger.warn('Chat violation detected', {
                peerId: data.peer.peerId,
                playerName: data.peer.playerName,
                violationType: data.violationType,
                warnings: data.warnings
            });
        });
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
                
                // Get plugin stats if available
                const pluginStats = this.pluginManager ? this.pluginManager.getStats() : null;
                
                logger.info('📈 Server Metrics', {
                    connections: stats.currentConnections,
                    rooms: stats.currentRooms,
                    totalMessages: stats.totalMessages,
                    uptime: Math.floor(stats.uptime / 1000),
                    memory: this._formatMemoryUsage(stats.memory),
                    health: health.status,
                    ...(pluginStats && {
                        plugins: {
                            active: pluginStats.activePlugins,
                            total: pluginStats.totalPlugins,
                            hooks: pluginStats.totalHooks,
                            errors: pluginStats.errorPlugins
                        }
                    })
                });

                // Log detailed performance metrics if enabled
                if (logger.isDebugEnabled()) {
                    const metrics = this.server.getMetrics();
                    logger.debug('Detailed metrics', metrics);
                    
                    if (pluginStats) {
                        logger.debug('Plugin metrics', { plugins: pluginStats.plugins });
                    }
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
                    logger.warn('🔶 Unhealthy rooms detected', {
                        count: unhealthyRooms.length,
                        rooms: unhealthyRooms.map(({ room, health }) => ({
                            name: room.name,
                            status: health.status,
                            issues: health.issues
                        }))
                    });
                }

                // Check plugin health if available
                if (this.pluginManager) {
                    const pluginStats = this.pluginManager.getStats();
                    if (pluginStats.errorPlugins > 0) {
                        logger.warn('Plugin errors detected', {
                            errorPlugins: pluginStats.errorPlugins,
                            totalPlugins: pluginStats.totalPlugins
                        });
                    }
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
                logger.warn('High memory usage detected', {
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
        const pluginStats = this.pluginManager ? this.pluginManager.getStats() : null;
        
        logger.info('Photon Server startup completed', {
            startupTime: `${startupTime}ms`,
            version: serverInfo.version,
            host: serverInfo.host,
            port: serverInfo.port,
            maxConnections: this.config.maxConnections,
            features: {
                metrics: this.config.enableMetrics,
                healthCheck: this.config.enableHealthCheck,
                clustering: this.config.enableClustering,
                plugins: this.config.enablePlugins
            },
            ...(pluginStats && {
                plugins: {
                    loaded: pluginStats.totalPlugins,
                    active: pluginStats.activePlugins,
                    hooks: pluginStats.totalHooks
                }
            })
        });

        // Display startup banner
        this._displayStartupBanner(serverInfo, pluginStats);
    }

    /**
     * Display startup banner
     * @private
     * @param {Object} serverInfo - Server information
     * @param {Object} pluginStats - Plugin statistics
     */
    _displayStartupBanner(serverInfo, pluginStats) {
        const pluginInfo = pluginStats ? 
            `${pluginStats.activePlugins}/${pluginStats.totalPlugins} active` : 
            'Disabled';
            
        const banner = `
╔══════════════════════════════════════════════════════════════╗
║                    PHOTON SERVER STARTED                     ║
╠══════════════════════════════════════════════════════════════╣
║ Host: ${serverInfo.host.padEnd(48)}       ║
║ Port: ${serverInfo.port.toString().padEnd(48)}       ║
║ Max Connections: ${this.config.maxConnections.toString().padEnd(37)}       ║
║ Monitoring: ${(this.config.enableMetrics ? 'Enabled' : 'Disabled').padEnd(41)}        ║
║ Health Checks: ${(this.config.enableHealthCheck ? 'Enabled' : 'Disabled').padEnd(38)}        ║
║ Plugins: ${pluginInfo.padEnd(44)}        ║
║ Log Level: ${this.config.logLevel.padEnd(42)}        ║
╚══════════════════════════════════════════════════════════════╝
        `;
        
        console.log(banner);
        
        // Display loaded plugins
        if (pluginStats && pluginStats.totalPlugins > 0) {
            console.log('\n🔌 Loaded Plugins:');
            for (const [name, plugin] of Object.entries(pluginStats.plugins)) {
                const status = plugin.state === 'active' ? '[+]' : 
                             plugin.state === 'error' ? '❌' : '[-]';
                console.log(`   ${status} ${name} (v${plugin.version})`);
            }
            console.log('');
        }
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
        
        logger.info(`Received ${signal}, initiating graceful shutdown...`);

        try {
            // Stop monitoring
            this._stopMonitoring();
            
            // Shutdown plugins first
            if (this.pluginManager) {
                logger.info('Shutting down plugin system...');
                await this.pluginManager.shutdown();
                logger.info('Plugin system shutdown completed');
            }
            
            // Stop server
            if (this.server) {
                await this.server.stop(this.config.gracefulShutdownTimeout);
            }
            
            logger.info('Graceful shutdown completed');
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

    // Plugin Management API

    /**
     * Load a plugin at runtime
     * @param {string} pluginName - Plugin name to load
     * @returns {Promise<boolean>} Success status
     */
    async loadPlugin(pluginName) {
        if (!this.pluginManager) {
            logger.warn('Plugin system not initialized');
            return false;
        }

        try {
            await this.pluginManager.loadPlugin(pluginName);
            logger.info('Plugin loaded successfully', { pluginName });
            return true;
        } catch (error) {
            logger.error('Failed to load plugin', { pluginName, error: error.message });
            return false;
        }
    }

    /**
     * Unload a plugin at runtime
     * @param {string} pluginName - Plugin name to unload
     * @returns {Promise<boolean>} Success status
     */
    async unloadPlugin(pluginName) {
        if (!this.pluginManager) {
            logger.warn('Plugin system not initialized');
            return false;
        }

        try {
            await this.pluginManager.unloadPlugin(pluginName);
            logger.info('Plugin unloaded successfully', { pluginName });
            return true;
        } catch (error) {
            logger.error('Failed to unload plugin', { pluginName, error: error.message });
            return false;
        }
    }

    /**
     * Reload a plugin at runtime
     * @param {string} pluginName - Plugin name to reload
     * @returns {Promise<boolean>} Success status
     */
    async reloadPlugin(pluginName) {
        if (!this.pluginManager) {
            logger.warn('Plugin system not initialized');
            return false;
        }

        try {
            await this.pluginManager.reloadPlugin(pluginName);
            logger.info('Plugin reloaded successfully', { pluginName });
            return true;
        } catch (error) {
            logger.error('Failed to reload plugin', { pluginName, error: error.message });
            return false;
        }
    }

    /**
     * Get plugin information
     * @param {string} [pluginName] - Specific plugin name (optional)
     * @returns {Object} Plugin information
     */
    getPluginInfo(pluginName) {
        if (!this.pluginManager) {
            return null;
        }

        return this.pluginManager.getPluginInfo(pluginName);
    }

    /**
     * Get server status including plugin information
     * @returns {Object} Server status
     */
    getStatus() {
        if (!this.server) {
            return { status: 'not_started' };
        }

        const status = {
            status: this.server.isHealthy() ? 'healthy' : 'unhealthy',
            uptime: Date.now() - this.startTime,
            server: this.server.getServerInfo(),
            stats: this.server.getStats(),
            health: this.server.getHealthStatus()
        };

        // Add plugin information if available
        if (this.pluginManager) {
            status.plugins = this.pluginManager.getStats();
        }

        return status;
    }
}

// Create and start server manager
const serverManager = new ServerManager();

// Export for external access (useful for testing and plugin management)
module.exports = serverManager;

// Start server if this file is run directly
if (require.main === module) {
    serverManager.start().catch((error) => {
        logger.fatal('Failed to start server', { error: error.message });
        process.exit(1);
    });
}