const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const logger = require('../utils/logger');

/**
 * Professional Plugin Manager
 * Handles dynamic loading, lifecycle management, and event routing
 * for server plugins with sandboxing and error isolation
 */
class PluginManager extends EventEmitter {
    constructor(server, options = {}) {
        super();
        
        this.server = server;
        this.config = this._mergeConfig(options);
        this.plugins = new Map();
        this.pluginConfigs = new Map();
        this.hooks = new Map();
        this.middlewares = new Map();
        this.isInitialized = false;
        
        // Plugin lifecycle states
        this.PLUGIN_STATES = {
            LOADING: 'loading',
            LOADED: 'loaded',
            INITIALIZING: 'initializing',
            ACTIVE: 'active',
            ERROR: 'error',
            DISABLED: 'disabled',
            UNLOADING: 'unloading'
        };
        
        // Available hook points
        this.HOOK_POINTS = {
            // Server lifecycle
            SERVER_STARTING: 'server:starting',
            SERVER_STARTED: 'server:started',
            SERVER_STOPPING: 'server:stopping',
            SERVER_STOPPED: 'server:stopped',
            
            // Peer lifecycle
            PEER_CONNECTING: 'peer:connecting',
            PEER_CONNECTED: 'peer:connected',
            PEER_AUTHENTICATING: 'peer:authenticating',
            PEER_AUTHENTICATED: 'peer:authenticated',
            PEER_DISCONNECTING: 'peer:disconnecting',
            PEER_DISCONNECTED: 'peer:disconnected',
            
            // Room lifecycle
            ROOM_CREATING: 'room:creating',
            ROOM_CREATED: 'room:created',
            ROOM_JOINING: 'room:joining',
            ROOM_JOINED: 'room:joined',
            ROOM_LEAVING: 'room:leaving',
            ROOM_LEFT: 'room:left',
            ROOM_DESTROYING: 'room:destroying',
            ROOM_DESTROYED: 'room:destroyed',
            
            // Operations
            OPERATION_RECEIVED: 'operation:received',
            OPERATION_PROCESSED: 'operation:processed',
            EVENT_RAISED: 'event:raised',
            EVENT_SENT: 'event:sent',
            
            // Data processing
            DATA_RECEIVED: 'data:received',
            DATA_SENDING: 'data:sending',
            MESSAGE_FILTERING: 'message:filtering',
            
            // Security
            AUTHENTICATION_ATTEMPT: 'auth:attempt',
            PERMISSION_CHECK: 'permission:check',
            RATE_LIMIT_CHECK: 'ratelimit:check'
        };
        
        logger.info('PluginManager created', {
            pluginsDir: this.config.pluginsDir,
            enabledPlugins: this.config.enabledPlugins.length,
            sandboxing: this.config.enableSandboxing
        });
    }

    /**
     * Merge configuration with defaults
     * @private
     * @param {Object} options - User options
     * @returns {Object} Merged configuration
     */
    _mergeConfig(options) {
        const defaults = {
            pluginsDir: './plugins',
            configDir: './config/plugins',
            enabledPlugins: [], // Empty = load all found plugins
            disabledPlugins: [],
            enableSandboxing: true,
            enableHotReload: process.env.NODE_ENV === 'development',
            maxExecutionTime: 5000, // 5 seconds max for plugin operations
            enableMetrics: true,
            autoLoad: true,
            validatePlugins: true,
            allowNativeModules: false
        };
        
        return { ...defaults, ...options };
    }

    /**
     * Initialize the plugin manager
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) {
            throw new Error('PluginManager is already initialized');
        }

        try {
            logger.info('Initializing PluginManager...');
            
            // Ensure directories exist
            this._ensureDirectories();
            
            // Setup server hooks
            this._setupServerHooks();
            
            // Load plugins if auto-load is enabled
            if (this.config.autoLoad) {
                await this.loadAllPlugins();
            }
            
            this.isInitialized = true;
            
            logger.info('PluginManager initialized successfully', {
                loadedPlugins: this.plugins.size,
                hooks: this.hooks.size,
                middlewares: this.middlewares.size
            });
            
            this.emit('initialized');
            
        } catch (error) {
            logger.error('Failed to initialize PluginManager', { error: error.message });
            throw error;
        }
    }

    /**
     * Ensure required directories exist
     * @private
     */
    _ensureDirectories() {
        const dirs = [this.config.pluginsDir, this.config.configDir];
        
        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                logger.debug('Created directory', { directory: dir });
            }
        }
    }

    /**
     * Setup server event hooks
     * @private
     */
    _setupServerHooks() {
        // Server lifecycle hooks
        this.server.on('started', () => this.executeHook(this.HOOK_POINTS.SERVER_STARTED));
        this.server.on('stopping', () => this.executeHook(this.HOOK_POINTS.SERVER_STOPPING));
        this.server.on('stopped', () => this.executeHook(this.HOOK_POINTS.SERVER_STOPPED));
        
        // Peer lifecycle hooks
        this.server.on('peerConnected', (peer) => {
            this.executeHook(this.HOOK_POINTS.PEER_CONNECTED, { peer });
        });
        
        this.server.on('peerDisconnected', (peer, reason) => {
            this.executeHook(this.HOOK_POINTS.PEER_DISCONNECTED, { peer, reason });
        });
        
        // Room lifecycle hooks
        this.server.on('roomCreated', (room) => {
            this.executeHook(this.HOOK_POINTS.ROOM_CREATED, { room });
        });
        
        this.server.on('roomRemoved', (room) => {
            this.executeHook(this.HOOK_POINTS.ROOM_DESTROYED, { room });
        });
    }

    /**
     * Load all plugins from the plugins directory
     * @returns {Promise<void>}
     */
    async loadAllPlugins() {
        try {
            const pluginDirs = this._discoverPlugins();
            
            logger.info('Discovered plugins', { 
                count: pluginDirs.length,
                plugins: pluginDirs
            });
            
            for (const pluginDir of pluginDirs) {
                try {
                    await this.loadPlugin(pluginDir);
                } catch (error) {
                    logger.error('Failed to load plugin', { 
                        plugin: pluginDir,
                        error: error.message
                    });
                }
            }
            
        } catch (error) {
            logger.error('Failed to load plugins', { error: error.message });
            throw error;
        }
    }

    /**
     * Discover plugins in the plugins directory
     * @private
     * @returns {string[]} Plugin directory names
     */
    _discoverPlugins() {
        if (!fs.existsSync(this.config.pluginsDir)) {
            return [];
        }
        
        const items = fs.readdirSync(this.config.pluginsDir);
        const pluginDirs = [];
        
        for (const item of items) {
            const itemPath = path.join(this.config.pluginsDir, item);
            const stat = fs.statSync(itemPath);
            
            if (stat.isDirectory()) {
                const manifestPath = path.join(itemPath, 'plugin.json');
                const indexPath = path.join(itemPath, 'index.js');
                
                if (fs.existsSync(manifestPath) && fs.existsSync(indexPath)) {
                    // Check if plugin is explicitly disabled
                    if (!this.config.disabledPlugins.includes(item)) {
                        // If enabledPlugins is specified, only load those
                        if (this.config.enabledPlugins.length === 0 || 
                            this.config.enabledPlugins.includes(item)) {
                            pluginDirs.push(item);
                        }
                    }
                }
            }
        }
        
        return pluginDirs;
    }

    /**
     * Load a specific plugin
     * @param {string} pluginName - Plugin directory name
     * @returns {Promise<void>}
     */
    async loadPlugin(pluginName) {
        if (this.plugins.has(pluginName)) {
            throw new Error(`Plugin '${pluginName}' is already loaded`);
        }

        const pluginDir = path.join(this.config.pluginsDir, pluginName);
        const manifestPath = path.join(pluginDir, 'plugin.json');
        const indexPath = path.join(pluginDir, 'index.js');

        try {
            // Load and validate manifest
            const manifest = this._loadPluginManifest(manifestPath);
            this._validatePluginManifest(manifest);
            
            // Load plugin configuration
            const config = this._loadPluginConfig(pluginName);
            
            // Create plugin context
            const context = this._createPluginContext(pluginName, manifest, config);
            
            // Load plugin code
            const PluginClass = require(path.resolve(indexPath));
            
            // Validate plugin class
            this._validatePluginClass(PluginClass, manifest);
            
            // Create plugin instance
            const plugin = new PluginClass(context);
            
            // Store plugin info
            const pluginInfo = {
                name: pluginName,
                manifest,
                config,
                instance: plugin,
                context,
                state: this.PLUGIN_STATES.LOADED,
                loadedAt: Date.now(),
                metrics: {
                    hooksExecuted: 0,
                    errors: 0,
                    lastError: null,
                    executionTime: 0
                }
            };
            
            this.plugins.set(pluginName, pluginInfo);
            this.pluginConfigs.set(pluginName, config);
            
            // Initialize plugin
            await this._initializePlugin(pluginInfo);
            
            logger.info('Plugin loaded successfully', {
                name: pluginName,
                version: manifest.version,
                author: manifest.author
            });
            
            this.emit('pluginLoaded', pluginInfo);
            
        } catch (error) {
            logger.error('Failed to load plugin', {
                plugin: pluginName,
                error: error.message,
                stack: error.stack
            });
            
            // Mark plugin as error state if partially loaded
            if (this.plugins.has(pluginName)) {
                this.plugins.get(pluginName).state = this.PLUGIN_STATES.ERROR;
                this.plugins.get(pluginName).metrics.lastError = error.message;
            }
            
            throw error;
        }
    }

    /**
     * Load plugin manifest file
     * @private
     * @param {string} manifestPath - Path to plugin.json
     * @returns {Object} Plugin manifest
     */
    _loadPluginManifest(manifestPath) {
        try {
            const manifestData = fs.readFileSync(manifestPath, 'utf8');
            return JSON.parse(manifestData);
        } catch (error) {
            throw new Error(`Failed to load plugin manifest: ${error.message}`);
        }
    }

    /**
     * Validate plugin manifest
     * @private
     * @param {Object} manifest - Plugin manifest
     */
    _validatePluginManifest(manifest) {
        const required = ['name', 'version', 'main', 'photonVersion'];
        
        for (const field of required) {
            if (!manifest[field]) {
                throw new Error(`Plugin manifest missing required field: ${field}`);
            }
        }
        
        // Validate version format (basic semver check)
        if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
            throw new Error(`Invalid plugin version format: ${manifest.version}`);
        }
        
        // Check Photon version compatibility
        if (manifest.photonVersion && !this._isVersionCompatible(manifest.photonVersion)) {
            logger.warn('Plugin version compatibility warning', {
                plugin: manifest.name,
                requiredVersion: manifest.photonVersion,
                serverVersion: this.server.getServerInfo().version
            });
        }
    }

    /**
     * Check version compatibility
     * @private
     * @param {string} requiredVersion - Required Photon version
     * @returns {boolean} Is compatible
     */
    _isVersionCompatible(requiredVersion) {
        // Simple compatibility check - in production you'd want proper semver comparison
        const serverVersion = this.server.getServerInfo().version;
        return serverVersion >= requiredVersion;
    }

    /**
     * Load plugin configuration
     * @private
     * @param {string} pluginName - Plugin name
     * @returns {Object} Plugin configuration
     */
    _loadPluginConfig(pluginName) {
        const configPath = path.join(this.config.configDir, `${pluginName}.json`);
        
        if (fs.existsSync(configPath)) {
            try {
                const configData = fs.readFileSync(configPath, 'utf8');
                return JSON.parse(configData);
            } catch (error) {
                logger.warn('Failed to load plugin config, using defaults', {
                    plugin: pluginName,
                    error: error.message
                });
            }
        }
        
        return {};
    }

    /**
     * Create plugin execution context
     * @private
     * @param {string} name - Plugin name
     * @param {Object} manifest - Plugin manifest
     * @param {Object} config - Plugin configuration
     * @returns {Object} Plugin context
     */
    _createPluginContext(name, manifest, config) {
        const context = {
            // Plugin info
            name,
            version: manifest.version,
            config,
            
            // Server access (limited API)
            server: this._createServerAPI(),
            
            // Logging
            logger: logger.child({ plugin: name }),
            
            // Hook system
            registerHook: (hookPoint, handler, priority = 0) => {
                this.registerHook(name, hookPoint, handler, priority);
            },
            
            unregisterHook: (hookPoint, handler) => {
                this.unregisterHook(name, hookPoint, handler);
            },
            
            // Middleware system
            registerMiddleware: (type, handler, priority = 0) => {
                this.registerMiddleware(name, type, handler, priority);
            },
            
            // Event system
            on: (event, handler) => this.on(event, handler),
            emit: (event, data) => this.emit(event, data),
            
            // Utilities
            setTimeout: (callback, delay) => setTimeout(callback, delay),
            setInterval: (callback, interval) => setInterval(callback, interval),
            
            // Storage API
            storage: this._createStorageAPI(name),
            
            // Metrics
            metrics: this._createMetricsAPI(name)
        };
        
        return this.config.enableSandboxing ? this._sandboxContext(context) : context;
    }

    /**
     * Create limited server API for plugins
     * @private
     * @returns {Object} Server API
     */
    _createServerAPI() {
        return {
            // Read-only server info
            getInfo: () => this.server.getServerInfo(),
            getStats: () => this.server.getStats(),
            getHealthStatus: () => this.server.getHealthStatus(),
            
            // Peer management
            getPeers: () => this.server.getPeers(),
            getPeer: (peerId) => this.server.getPeer(peerId),
            disconnectPeer: (peerId, reason) => this.server.disconnectPeer(peerId, reason),
            
            // Room management
            getRooms: () => this.server.getRooms(),
            getRoom: (name) => this.server.getRoom(name),
            createRoom: (name, options) => this.server.createRoom(name, options),
            removeRoom: (name) => this.server.removeRoom(name),
            
            // Broadcasting
            broadcast: (eventCode, data, excludePeer) => this.server.broadcast(eventCode, data, excludePeer),
            broadcastToRoom: (roomName, eventCode, data, excludePeer) => 
                this.server.broadcastToRoom(roomName, eventCode, data, excludePeer)
        };
    }

    /**
     * Create storage API for plugins
     * @private
     * @param {string} pluginName - Plugin name
     * @returns {Object} Storage API
     */
    _createStorageAPI(pluginName) {
        const storageDir = path.join(this.config.pluginsDir, pluginName, 'storage');
        
        return {
            set: async (key, value) => {
                if (!fs.existsSync(storageDir)) {
                    fs.mkdirSync(storageDir, { recursive: true });
                }
                
                const filePath = path.join(storageDir, `${key}.json`);
                await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2));
            },
            
            get: async (key, defaultValue = null) => {
                try {
                    const filePath = path.join(storageDir, `${key}.json`);
                    const data = await fs.promises.readFile(filePath, 'utf8');
                    return JSON.parse(data);
                } catch (error) {
                    return defaultValue;
                }
            },
            
            delete: async (key) => {
                try {
                    const filePath = path.join(storageDir, `${key}.json`);
                    await fs.promises.unlink(filePath);
                } catch (error) {
                    // File doesn't exist, ignore
                }
            },
            
            list: async () => {
                try {
                    if (!fs.existsSync(storageDir)) return [];
                    const files = await fs.promises.readdir(storageDir);
                    return files.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
                } catch (error) {
                    return [];
                }
            }
        };
    }

    /**
     * Create metrics API for plugins
     * @private
     * @param {string} pluginName - Plugin name
     * @returns {Object} Metrics API
     */
    _createMetricsAPI(pluginName) {
        const metrics = new Map();
        
        return {
            increment: (metric, value = 1) => {
                metrics.set(metric, (metrics.get(metric) || 0) + value);
            },
            
            set: (metric, value) => {
                metrics.set(metric, value);
            },
            
            get: (metric) => {
                return metrics.get(metric) || 0;
            },
            
            getAll: () => {
                return Object.fromEntries(metrics);
            },
            
            reset: (metric) => {
                if (metric) {
                    metrics.delete(metric);
                } else {
                    metrics.clear();
                }
            }
        };
    }

    /**
     * Sandbox plugin context (basic implementation)
     * @private
     * @param {Object} context - Plugin context
     * @returns {Object} Sandboxed context
     */
    _sandboxContext(context) {
        // In a production environment, you might use vm.createContext()
        // or other sandboxing techniques for better isolation
        return context;
    }

    /**
     * Validate plugin class
     * @private
     * @param {Function} PluginClass - Plugin constructor
     * @param {Object} manifest - Plugin manifest
     */
    _validatePluginClass(PluginClass, manifest) {
        if (typeof PluginClass !== 'function') {
            throw new Error('Plugin must export a constructor function');
        }
        
        // Check for required methods
        const requiredMethods = ['initialize'];
        const prototype = PluginClass.prototype;
        
        for (const method of requiredMethods) {
            if (typeof prototype[method] !== 'function') {
                throw new Error(`Plugin must implement ${method}() method`);
            }
        }
    }

    /**
     * Initialize a loaded plugin
     * @private
     * @param {Object} pluginInfo - Plugin information
     */
    async _initializePlugin(pluginInfo) {
        try {
            pluginInfo.state = this.PLUGIN_STATES.INITIALIZING;
            
            // Set execution timeout
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Plugin initialization timeout')), 
                          this.config.maxExecutionTime);
            });
            
            // Initialize plugin with timeout
            await Promise.race([
                pluginInfo.instance.initialize(),
                timeoutPromise
            ]);
            
            pluginInfo.state = this.PLUGIN_STATES.ACTIVE;
            pluginInfo.initializedAt = Date.now();
            
            logger.debug('Plugin initialized', { plugin: pluginInfo.name });
            
        } catch (error) {
            pluginInfo.state = this.PLUGIN_STATES.ERROR;
            pluginInfo.metrics.errors++;
            pluginInfo.metrics.lastError = error.message;
            
            logger.error('Plugin initialization failed', {
                plugin: pluginInfo.name,
                error: error.message
            });
            
            throw error;
        }
    }

    /**
     * Register a hook handler
     * @param {string} pluginName - Plugin name
     * @param {string} hookPoint - Hook point identifier
     * @param {Function} handler - Hook handler function
     * @param {number} [priority=0] - Handler priority (higher = earlier execution)
     */
    registerHook(pluginName, hookPoint, handler, priority = 0) {
        if (!this.hooks.has(hookPoint)) {
            this.hooks.set(hookPoint, []);
        }
        
        const hookInfo = {
            plugin: pluginName,
            handler,
            priority,
            registeredAt: Date.now()
        };
        
        this.hooks.get(hookPoint).push(hookInfo);
        
        // Sort by priority (descending)
        this.hooks.get(hookPoint).sort((a, b) => b.priority - a.priority);
        
        logger.debug('Hook registered', {
            plugin: pluginName,
            hookPoint,
            priority,
            totalHandlers: this.hooks.get(hookPoint).length
        });
    }

    /**
     * Unregister a hook handler
     * @param {string} pluginName - Plugin name
     * @param {string} hookPoint - Hook point identifier
     * @param {Function} handler - Handler to remove
     */
    unregisterHook(pluginName, hookPoint, handler) {
        if (!this.hooks.has(hookPoint)) {
            return;
        }
        
        const handlers = this.hooks.get(hookPoint);
        const index = handlers.findIndex(h => h.plugin === pluginName && h.handler === handler);
        
        if (index !== -1) {
            handlers.splice(index, 1);
            logger.debug('Hook unregistered', { plugin: pluginName, hookPoint });
        }
    }

    /**
     * Execute hooks for a specific point
     * @param {string} hookPoint - Hook point identifier
     * @param {Object} [data={}] - Data to pass to hooks
     * @returns {Promise<Object>} Modified data
     */
    async executeHook(hookPoint, data = {}) {
        if (!this.hooks.has(hookPoint)) {
            return data;
        }
        
        const handlers = this.hooks.get(hookPoint);
        let result = { ...data };
        
        for (const hookInfo of handlers) {
            try {
                const plugin = this.plugins.get(hookInfo.plugin);
                
                if (!plugin || plugin.state !== this.PLUGIN_STATES.ACTIVE) {
                    continue;
                }
                
                const startTime = Date.now();
                
                // Execute hook with timeout
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Hook execution timeout')), 
                              this.config.maxExecutionTime);
                });
                
                const hookResult = await Promise.race([
                    hookInfo.handler(result),
                    timeoutPromise
                ]);
                
                const executionTime = Date.now() - startTime;
                
                // Update metrics
                plugin.metrics.hooksExecuted++;
                plugin.metrics.executionTime += executionTime;
                
                // Merge result if hook returns data
                if (hookResult && typeof hookResult === 'object') {
                    result = { ...result, ...hookResult };
                }
                
            } catch (error) {
                const plugin = this.plugins.get(hookInfo.plugin);
                if (plugin) {
                    plugin.metrics.errors++;
                    plugin.metrics.lastError = error.message;
                }
                
                logger.error('Hook execution failed', {
                    plugin: hookInfo.plugin,
                    hookPoint,
                    error: error.message
                });
                
                // Continue executing other hooks
            }
        }
        
        return result;
    }

    /**
     * Register middleware
     * @param {string} pluginName - Plugin name
     * @param {string} type - Middleware type
     * @param {Function} handler - Middleware handler
     * @param {number} [priority=0] - Handler priority
     */
    registerMiddleware(pluginName, type, handler, priority = 0) {
        if (!this.middlewares.has(type)) {
            this.middlewares.set(type, []);
        }
        
        const middlewareInfo = {
            plugin: pluginName,
            handler,
            priority,
            registeredAt: Date.now()
        };
        
        this.middlewares.get(type).push(middlewareInfo);
        this.middlewares.get(type).sort((a, b) => b.priority - a.priority);
        
        logger.debug('Middleware registered', { plugin: pluginName, type, priority });
    }

    /**
     * Execute middleware chain
     * @param {string} type - Middleware type
     * @param {Object} context - Middleware context
     * @returns {Promise<Object>} Modified context
     */
    async executeMiddleware(type, context) {
        if (!this.middlewares.has(type)) {
            return context;
        }
        
        const middlewares = this.middlewares.get(type);
        let result = { ...context };
        
        for (const middleware of middlewares) {
            try {
                const plugin = this.plugins.get(middleware.plugin);
                
                if (!plugin || plugin.state !== this.PLUGIN_STATES.ACTIVE) {
                    continue;
                }
                
                result = await middleware.handler(result);
                
                // If middleware returns false or sets stop flag, halt chain
                if (result === false || result.stop === true) {
                    break;
                }
                
            } catch (error) {
                logger.error('Middleware execution failed', {
                    plugin: middleware.plugin,
                    type,
                    error: error.message
                });
            }
        }
        
        return result;
    }

    /**
     * Unload a plugin
     * @param {string} pluginName - Plugin name
     * @returns {Promise<void>}
     */
    async unloadPlugin(pluginName) {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            throw new Error(`Plugin '${pluginName}' is not loaded`);
        }
        
        try {
            plugin.state = this.PLUGIN_STATES.UNLOADING;
            
            // Call plugin cleanup if available
            if (typeof plugin.instance.cleanup === 'function') {
                await plugin.instance.cleanup();
            }
            
            // Remove all hooks for this plugin
            for (const [hookPoint, handlers] of this.hooks) {
                this.hooks.set(hookPoint, handlers.filter(h => h.plugin !== pluginName));
            }
            
            // Remove all middlewares for this plugin
            for (const [type, middlewares] of this.middlewares) {
                this.middlewares.set(type, middlewares.filter(m => m.plugin !== pluginName));
            }
            
            // Clear plugin from cache
            this.plugins.delete(pluginName);
            this.pluginConfigs.delete(pluginName);
            
            // Clear from require cache for hot reload
            if (this.config.enableHotReload) {
                const pluginPath = path.resolve(this.config.pluginsDir, pluginName, 'index.js');
                delete require.cache[pluginPath];
            }
            
            logger.info('Plugin unloaded', { plugin: pluginName });
            this.emit('pluginUnloaded', { name: pluginName });
            
        } catch (error) {
            plugin.state = this.PLUGIN_STATES.ERROR;
            logger.error('Failed to unload plugin', { plugin: pluginName, error: error.message });
            throw error;
        }
    }

    /**
     * Reload a plugin
     * @param {string} pluginName - Plugin name
     * @returns {Promise<void>}
     */
    async reloadPlugin(pluginName) {
        if (this.plugins.has(pluginName)) {
            await this.unloadPlugin(pluginName);
        }
        
        await this.loadPlugin(pluginName);
    }

    /**
     * Get plugin information
     * @param {string} [pluginName] - Specific plugin name (optional)
     * @returns {Object|Map} Plugin info
     */
    getPluginInfo(pluginName) {
        if (pluginName) {
            return this.plugins.get(pluginName) || null;
        }
        
        return this.plugins;
    }

    /**
     * Get plugin statistics
     * @returns {Object} Plugin statistics
     */
    getStats() {
        const stats = {
            totalPlugins: this.plugins.size,
            activePlugins: 0,
            errorPlugins: 0,
            totalHooks: 0,
            totalMiddlewares: 0,
            plugins: {}
        };
        
        for (const [name, plugin] of this.plugins) {
            if (plugin.state === this.PLUGIN_STATES.ACTIVE) {
                stats.activePlugins++;
            } else if (plugin.state === this.PLUGIN_STATES.ERROR) {
                stats.errorPlugins++;
            }
            
            stats.plugins[name] = {
                state: plugin.state,
                version: plugin.manifest.version,
                loadedAt: plugin.loadedAt,
                metrics: plugin.metrics
            };
        }
        
        for (const handlers of this.hooks.values()) {
            stats.totalHooks += handlers.length;
        }
        
        for (const middlewares of this.middlewares.values()) {
            stats.totalMiddlewares += middlewares.length;
        }
        
        return stats;
    }

    /**
     * Enable a plugin
     * @param {string} pluginName - Plugin name
     * @returns {Promise<void>}
     */
    async enablePlugin(pluginName) {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            throw new Error(`Plugin '${pluginName}' is not loaded`);
        }
        
        if (plugin.state === this.PLUGIN_STATES.DISABLED) {
            await this._initializePlugin(plugin);
            logger.info('Plugin enabled', { plugin: pluginName });
        }
    }

    /**
     * Disable a plugin
     * @param {string} pluginName - Plugin name
     */
    disablePlugin(pluginName) {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            throw new Error(`Plugin '${pluginName}' is not loaded`);
        }
        
        plugin.state = this.PLUGIN_STATES.DISABLED;
        logger.info('Plugin disabled', { plugin: pluginName });
    }

    /**
     * Shutdown the plugin manager
     * @returns {Promise<void>}
     */
    async shutdown() {
        logger.info('Shutting down PluginManager...');
        
        const shutdownPromises = [];
        
        for (const [name, plugin] of this.plugins) {
            if (plugin.state === this.PLUGIN_STATES.ACTIVE) {
                shutdownPromises.push(this.unloadPlugin(name).catch(error => {
                    logger.error('Error unloading plugin during shutdown', { 
                        plugin: name,
                        error: error.message
                    });
                }));
            }
        }
        
        await Promise.allSettled(shutdownPromises);
        
        this.plugins.clear();
        this.hooks.clear();
        this.middlewares.clear();
        this.isInitialized = false;
        
        logger.info('PluginManager shutdown completed');
        this.emit('shutdown');
    }

    /**
     * Get available hook points
     * @returns {Object} Hook points
     */
    getHookPoints() {
        return { ...this.HOOK_POINTS };
    }

    /**
     * Check if a plugin is active
     * @param {string} pluginName - Plugin name
     * @returns {boolean} Is active
     */
    isPluginActive(pluginName) {
        const plugin = this.plugins.get(pluginName);
        return plugin && plugin.state === this.PLUGIN_STATES.ACTIVE;
    }

    /**
     * Get plugin configuration
     * @param {string} pluginName - Plugin name
     * @returns {Object} Plugin configuration
     */
    getPluginConfig(pluginName) {
        return this.pluginConfigs.get(pluginName) || {};
    }

    /**
     * Update plugin configuration
     * @param {string} pluginName - Plugin name
     * @param {Object} newConfig - New configuration
     * @returns {Promise<void>}
     */
    async updatePluginConfig(pluginName, newConfig) {
        const configPath = path.join(this.config.configDir, `${pluginName}.json`);
        
        try {
            await fs.promises.writeFile(configPath, JSON.stringify(newConfig, null, 2));
            this.pluginConfigs.set(pluginName, newConfig);
            
            // Update plugin context config
            const plugin = this.plugins.get(pluginName);
            if (plugin) {
                plugin.context.config = newConfig;
                plugin.config = newConfig;
                
                // Call plugin config update handler if available
                if (typeof plugin.instance.onConfigUpdate === 'function') {
                    await plugin.instance.onConfigUpdate(newConfig);
                }
            }
            
            logger.info('Plugin configuration updated', { plugin: pluginName });
            
        } catch (error) {
            logger.error('Failed to update plugin configuration', {
                plugin: pluginName,
                error: error.message
            });
            throw error;
        }
    }
}

module.exports = PluginManager;