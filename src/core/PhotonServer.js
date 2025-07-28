const net = require('net');
const EventEmitter = require('events');
const PhotonPeer = require('./PhotonPeer');
const PhotonRoom = require('./PhotonRoom');
const PhotonParser = require('../protocol/PhotonParser');
const OperationHandler = require('../handlers/OperationHandler');
const logger = require('../utils/logger');
const { 
    PHOTON_COMMANDS, 
    PHOTON_PEER_STATE, 
    PHOTON_SIGNATURE,
    DEFAULT_SERVER_CONFIG 
} = require('../protocol/constants');

/**
 * Professional Photon Server Implementation
 * Handles TCP connections, peer management, and room orchestration
 * with enterprise-grade reliability and monitoring
 */
class PhotonServer extends EventEmitter {
    /**
     * @param {Object} options - Server configuration options
     * @param {number} [options.port=5055] - Server port
     * @param {string} [options.host='0.0.0.0'] - Server host
     * @param {number} [options.maxConnections=1000] - Maximum concurrent connections
     * @param {number} [options.pingInterval=30000] - Ping interval in milliseconds
     * @param {number} [options.connectionTimeout=60000] - Connection timeout in milliseconds
     * @param {number} [options.cleanupInterval=60000] - Cleanup interval in milliseconds
     * @param {number} [options.emptyRoomTtl=300000] - Empty room time-to-live in milliseconds
     */
    constructor(options = {}) {
        super();
        
        this._config = this._validateAndMergeConfig(options);
        this._state = this._initializeServerState();
        this._intervals = new Map();
        this._shutdownInProgress = false;
        
        // Initialize components
        this._operationHandler = new OperationHandler(this);
        
        logger.info('PhotonServer instance created', { config: this._config });
    }

    /**
     * Validate and merge configuration options
     * @private
     * @param {Object} options - User provided options
     * @returns {Object} Validated configuration
     */
    _validateAndMergeConfig(options) {
        const config = { ...DEFAULT_SERVER_CONFIG, ...options };
        
        // Validate critical settings
        if (config.port < 1 || config.port > 65535) {
            throw new Error(`Invalid port: ${config.port}. Must be between 1-65535`);
        }
        
        if (config.maxConnections < 1) {
            throw new Error(`Invalid maxConnections: ${config.maxConnections}. Must be positive`);
        }
        
        if (config.pingInterval < 1000) {
            throw new Error(`Invalid pingInterval: ${config.pingInterval}. Must be at least 1000ms`);
        }

        return config;
    }

    /**
     * Initialize server state
     * @private
     * @returns {Object} Initial server state
     */
    _initializeServerState() {
        return {
            server: null,
            peers: new Map(),
            rooms: new Map(),
            nextPeerId: 1,
            isRunning: false,
            startTime: null,
            stats: {
                totalConnections: 0,
                totalDisconnections: 0,
                totalRoomsCreated: 0,
                totalMessages: 0,
                totalErrors: 0,
                peakConnections: 0,
                peakRooms: 0,
                bytesReceived: 0,
                bytesSent: 0
            }
        };
    }

    /**
     * Start the Photon server
     * @returns {Promise<void>} Resolves when server is started
     * @throws {Error} If server is already running or startup fails
     */
    async start() {
        if (this._state.isRunning) {
            throw new Error('Server is already running');
        }

        if (this._shutdownInProgress) {
            throw new Error('Server shutdown is in progress');
        }

        try {
            await this._startTcpServer();
            this._startBackgroundTasks();
            
            logger.info('PhotonServer started successfully', {
                host: this._config.host,
                port: this._config.port,
                maxConnections: this._config.maxConnections
            });

            this.emit('started', this.getServerInfo());
            
        } catch (error) {
            logger.error('Failed to start PhotonServer', { error: error.message });
            await this._cleanup();
            throw error;
        }
    }

    /**
     * Start TCP server and handle connections
     * @private
     * @returns {Promise<void>}
     */
    async _startTcpServer() {
        return new Promise((resolve, reject) => {
            this._state.server = net.createServer(this._createConnectionHandler());
            
            this._state.server.on('error', (error) => {
                logger.error('TCP server error', { error: error.message });
                this._state.stats.totalErrors++;
                this.emit('serverError', error);
                reject(error);
            });

            this._state.server.on('close', () => {
                logger.info('TCP server closed');
                this.emit('serverClosed');
            });

            this._state.server.listen(this._config.port, this._config.host, () => {
                this._state.isRunning = true;
                this._state.startTime = Date.now();
                resolve();
            });
        });
    }

    /**
     * Create connection handler function
     * @private
     * @returns {Function} Connection handler
     */
    _createConnectionHandler() {
        return (socket) => {
            try {
                this._handleNewConnection(socket);
            } catch (error) {
                logger.error('Error handling new connection', { 
                    error: error.message,
                    remoteAddress: socket.remoteAddress 
                });
                socket.destroy();
            }
        };
    }

    /**
     * Handle new TCP connection
     * @private
     * @param {net.Socket} socket - Incoming socket connection
     */
    _handleNewConnection(socket) {
        // Check connection limits
        if (!this._canAcceptConnection()) {
            logger.warn('Connection rejected: server at capacity', {
                currentConnections: this._state.peers.size,
                maxConnections: this._config.maxConnections,
                remoteAddress: socket.remoteAddress
            });
            socket.destroy();
            return;
        }

        const peer = this._createPeer(socket);
        this._registerPeer(peer);
        this._setupSocketHandlers(peer, socket);
        this._initializePeerConnection(peer);

        logger.info('New peer connected', {
            peerId: peer.peerId,
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
            totalConnections: this._state.peers.size
        });
    }

    /**
     * Check if server can accept new connections
     * @private
     * @returns {boolean} Can accept connection
     */
    _canAcceptConnection() {
        return this._state.isRunning && 
               this._state.peers.size < this._config.maxConnections &&
               !this._shutdownInProgress;
    }

    /**
     * Create new peer instance
     * @private
     * @param {net.Socket} socket - Socket connection
     * @returns {PhotonPeer} New peer instance
     */
    _createPeer(socket) {
        const peerId = this._generatePeerId();
        return new PhotonPeer(socket, peerId, {
            timeout: this._config.connectionTimeout,
            pingInterval: this._config.pingInterval
        });
    }

    /**
     * Generate unique peer ID
     * @private
     * @returns {number} Unique peer ID
     */
    _generatePeerId() {
        return this._state.nextPeerId++;
    }

    /**
     * Register peer in server state
     * @private
     * @param {PhotonPeer} peer - Peer to register
     */
    _registerPeer(peer) {
        this._state.peers.set(peer.peerId, peer);
        this._state.stats.totalConnections++;
        this._state.stats.peakConnections = Math.max(
            this._state.stats.peakConnections, 
            this._state.peers.size
        );
    }

    /**
     * Setup socket event handlers for peer
     * @private
     * @param {PhotonPeer} peer - Associated peer
     * @param {net.Socket} socket - Socket connection
     */
    _setupSocketHandlers(peer, socket) {
        socket.on('data', (data) => {
            this._handleSocketData(peer, data);
        });

        socket.on('close', (hadError) => {
            this._handlePeerDisconnection(peer, hadError ? 'Socket error' : 'Socket closed');
        });

        socket.on('error', (error) => {
            logger.error('Socket error', { 
                peerId: peer.peerId, 
                error: error.message 
            });
            this._state.stats.totalErrors++;
            this._handlePeerDisconnection(peer, `Socket error: ${error.message}`);
        });

        socket.on('timeout', () => {
            logger.warn('Socket timeout', { peerId: peer.peerId });
            this._handlePeerDisconnection(peer, 'Socket timeout');
        });

        // Configure socket settings
        socket.setKeepAlive(true, this._config.pingInterval);
        socket.setTimeout(this._config.connectionTimeout);
    }

    /**
     * Initialize peer connection
     * @private
     * @param {PhotonPeer} peer - Peer to initialize
     */
    _initializePeerConnection(peer) {
        // Send connection verification after small delay
        process.nextTick(() => {
            try {
                peer.sendVerifyConnect();
                peer.setState(PHOTON_PEER_STATE.CONNECTED);
                this.emit('peerConnected', peer);
            } catch (error) {
                logger.error('Failed to initialize peer connection', {
                    peerId: peer.peerId,
                    error: error.message
                });
                this._handlePeerDisconnection(peer, 'Initialization failed');
            }
        });
    }

    /**
     * Handle incoming socket data
     * @private
     * @param {PhotonPeer} peer - Source peer
     * @param {Buffer} buffer - Incoming data buffer
     */
    async _handleSocketData(peer, buffer) {
        try {
            await this._processIncomingData(peer, buffer);
        } catch (error) {
            logger.error('Error processing socket data', {
                peerId: peer.peerId,
                error: error.message,
                bufferLength: buffer.length
            });
            this._state.stats.totalErrors++;
            
            // Don't disconnect on single data processing errors
            // but track them for monitoring
        }
    }

    /**
     * Process incoming data from peer
     * @private
     * @param {PhotonPeer} peer - Source peer
     * @param {Buffer} buffer - Data buffer
     */
    async _processIncomingData(peer, buffer) {
        if (!this._validatePacketStructure(buffer, peer.peerId)) {
            return;
        }

        this._updatePeerActivity(peer, buffer);
        
        const commands = this._parseCommands(buffer, peer.peerId);
        if (!commands || commands.length === 0) {
            return;
        }

        // Process commands sequentially to maintain order
        for (const command of commands) {
            await this._processCommand(peer, command);
        }
    }

    /**
     * Validate packet structure and signature
     * @private
     * @param {Buffer} buffer - Packet buffer
     * @param {number} peerId - Peer ID for logging
     * @returns {boolean} Is valid packet
     */
    _validatePacketStructure(buffer, peerId) {
        if (buffer.length < 12) {
            logger.warn('Invalid packet size', { peerId, size: buffer.length });
            return false;
        }

        const signature = buffer.readUInt16BE(0);
        if (signature !== PHOTON_SIGNATURE) {
            logger.warn('Invalid packet signature', { 
                peerId, 
                signature: `0x${signature.toString(16)}` 
            });
            return false;
        }

        return true;
    }

    /**
     * Update peer activity metrics
     * @private
     * @param {PhotonPeer} peer - Target peer
     * @param {Buffer} buffer - Received buffer
     */
    _updatePeerActivity(peer, buffer) {
        peer.updateActivity();
        peer.updateStats('messagesReceived', 1);
        peer.updateStats('bytesReceived', buffer.length);
        
        this._state.stats.totalMessages++;
        this._state.stats.bytesReceived += buffer.length;
    }

    /**
     * Parse commands from buffer
     * @private
     * @param {Buffer} buffer - Data buffer
     * @param {number} peerId - Peer ID for logging
     * @returns {Array|null} Parsed commands
     */
    _parseCommands(buffer, peerId) {
        try {
            const dataBuffer = buffer.slice(12); // Skip header
            if (dataBuffer.length === 0) {
                return [];
            }

            const parser = new PhotonParser(dataBuffer.buffer);
            const commands = [];
            
            while (parser.offset < parser.view.byteLength - 1) {
                const command = parser.parseCommand();
                if (!command) break;
                commands.push(command);
            }

            return commands;
            
        } catch (error) {
            logger.error('Failed to parse commands', { 
                peerId, 
                error: error.message 
            });
            return null;
        }
    }

    /**
     * Process individual command
     * @private
     * @param {PhotonPeer} peer - Source peer
     * @param {Object} commandData - Command data
     */
    async _processCommand(peer, commandData) {
        try {
            const { command, data } = commandData;
            
            logger.debug('Processing command', { 
                peerId: peer.peerId, 
                command 
            });

            switch (command) {
                case PHOTON_COMMANDS.PING:
                    await this._handlePingCommand(peer);
                    break;
                    
                case PHOTON_COMMANDS.SEND_RELIABLE:
                case PHOTON_COMMANDS.SEND_UNRELIABLE:
                    await this._handleDataCommand(peer, data);
                    break;
                    
                case PHOTON_COMMANDS.DISCONNECT:
                    this._handleDisconnectCommand(peer);
                    break;
                    
                default:
                    logger.warn('Unknown command received', { 
                        peerId: peer.peerId, 
                        command 
                    });
            }
            
        } catch (error) {
            logger.error('Error processing command', {
                peerId: peer.peerId,
                command: commandData.command,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Handle ping command
     * @private
     * @param {PhotonPeer} peer - Source peer
     */
    async _handlePingCommand(peer) {
        peer.sendPong();
        peer.updateLastPingTime();
    }

    /**
     * Handle data command (operations)
     * @private
     * @param {PhotonPeer} peer - Source peer
     * @param {Object} data - Command data
     */
    async _handleDataCommand(peer, data) {
        if (data?.data) {
            await this._operationHandler.handleOperation(peer, data.data);
        }
    }

    /**
     * Handle disconnect command
     * @private
     * @param {PhotonPeer} peer - Disconnecting peer
     */
    _handleDisconnectCommand(peer) {
        this._handlePeerDisconnection(peer, 'Client requested disconnect');
    }

    /**
     * Handle peer disconnection
     * @private
     * @param {PhotonPeer} peer - Disconnecting peer
     * @param {string} reason - Disconnection reason
     */
    _handlePeerDisconnection(peer, reason = 'Unknown') {
        if (!this._state.peers.has(peer.peerId)) {
            return; // Already handled
        }

        try {
            this._cleanupPeerResources(peer);
            this._unregisterPeer(peer);
            
            logger.info('Peer disconnected', { 
                peerId: peer.peerId, 
                reason,
                totalConnections: this._state.peers.size
            });

            this.emit('peerDisconnected', peer, reason);
            
        } catch (error) {
            logger.error('Error during peer disconnection', {
                peerId: peer.peerId,
                error: error.message
            });
        }
    }

    /**
     * Clean up peer-related resources
     * @private
     * @param {PhotonPeer} peer - Peer to clean up
     */
    _cleanupPeerResources(peer) {
        // Remove from room if present
        if (peer.room) {
            const roomName = peer.room.name;
            peer.room.removePeer(peer);
            
            // Schedule room cleanup if empty
            if (peer.room.isEmpty()) {
                this._scheduleRoomCleanup(roomName);
            }
        }

        // Clean up peer resources
        peer.cleanup();
    }

    /**
     * Unregister peer from server
     * @private
     * @param {PhotonPeer} peer - Peer to unregister
     */
    _unregisterPeer(peer) {
        this._state.peers.delete(peer.peerId);
        this._state.stats.totalDisconnections++;
    }

    /**
     * Schedule room cleanup
     * @private
     * @param {string} roomName - Room to clean up
     */
    _scheduleRoomCleanup(roomName) {
        // Use next tick to avoid immediate cleanup during peer disconnection
        process.nextTick(() => {
            const room = this._state.rooms.get(roomName);
            if (room && room.isEmpty()) {
                this.removeRoom(roomName);
            }
        });
    }

    /**
     * Stop the Photon server gracefully
     * @param {number} [timeout=10000] - Shutdown timeout in milliseconds
     * @returns {Promise<void>} Resolves when server is stopped
     */
    async stop(timeout = 10000) {
        if (!this._state.isRunning) {
            return;
        }

        if (this._shutdownInProgress) {
            logger.warn('Shutdown already in progress');
            return;
        }

        this._shutdownInProgress = true;
        
        logger.info('Beginning server shutdown', { 
            connectedPeers: this._state.peers.size,
            activeRooms: this._state.rooms.size
        });

        try {
            await this._gracefulShutdown(timeout);
            logger.info('Server shutdown completed successfully');
            this.emit('stopped');
            
        } catch (error) {
            logger.error('Error during server shutdown', { error: error.message });
            throw error;
        } finally {
            this._shutdownInProgress = false;
        }
    }

    /**
     * Perform graceful shutdown
     * @private
     * @param {number} timeout - Shutdown timeout
     * @returns {Promise<void>}
     */
    async _gracefulShutdown(timeout) {
        const shutdownPromise = this._performShutdownSequence();
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Shutdown timeout')), timeout);
        });

        try {
            await Promise.race([shutdownPromise, timeoutPromise]);
        } catch (error) {
            logger.warn('Forced shutdown due to timeout');
            await this._forceShutdown();
        }
    }

    /**
     * Perform shutdown sequence
     * @private
     * @returns {Promise<void>}
     */
    async _performShutdownSequence() {
        // Stop accepting new connections
        this._state.server.close();
        
        // Stop background tasks
        this._stopBackgroundTasks();
        
        // Disconnect all peers gracefully
        await this._disconnectAllPeers();
        
        // Clean up resources
        await this._cleanup();
        
        this._state.isRunning = false;
    }

    /**
     * Force immediate shutdown
     * @private
     * @returns {Promise<void>}
     */
    async _forceShutdown() {
        this._stopBackgroundTasks();
        
        // Force disconnect all peers
        for (const peer of this._state.peers.values()) {
            try {
                peer.forceDisconnect();
            } catch (error) {
                // Ignore errors during force disconnect
            }
        }
        
        await this._cleanup();
        this._state.isRunning = false;
    }

    /**
     * Disconnect all peers gracefully
     * @private
     * @returns {Promise<void>}
     */
    async _disconnectAllPeers() {
        const disconnectPromises = Array.from(this._state.peers.values()).map(peer => 
            this._disconnectPeerGracefully(peer)
        );
        
        await Promise.allSettled(disconnectPromises);
    }

    /**
     * Disconnect single peer gracefully
     * @private
     * @param {PhotonPeer} peer - Peer to disconnect
     * @returns {Promise<void>}
     */
    async _disconnectPeerGracefully(peer) {
        try {
            peer.disconnect('Server shutting down');
            // Give peer time to process disconnect
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            logger.error('Error disconnecting peer gracefully', {
                peerId: peer.peerId,
                error: error.message
            });
        }
    }

    /**
     * Start background maintenance tasks
     * @private
     */
    _startBackgroundTasks() {
        this._intervals.set('ping', setInterval(() => {
            this._performPingCycle();
        }, Math.floor(this._config.pingInterval / 3)));

        this._intervals.set('cleanup', setInterval(() => {
            this._performCleanupCycle();
        }, this._config.cleanupInterval));

        logger.debug('Background tasks started');
    }

    /**
     * Stop all background tasks
     * @private
     */
    _stopBackgroundTasks() {
        for (const [name, intervalId] of this._intervals) {
            clearInterval(intervalId);
            logger.debug(`Stopped background task: ${name}`);
        }
        this._intervals.clear();
    }

    /**
     * Perform ping cycle for all peers
     * @private
     */
    _performPingCycle() {
        const now = Date.now();
        const peersToDisconnect = [];

        for (const peer of this._state.peers.values()) {
            if (!peer.isConnected()) continue;

            try {
                // Send ping if needed
                if (peer.shouldSendPing(now)) {
                    peer.sendPing();
                }

                // Check for timeout
                if (peer.isTimedOut(now)) {
                    peersToDisconnect.push(peer);
                }
                
            } catch (error) {
                logger.error('Error in ping cycle', {
                    peerId: peer.peerId,
                    error: error.message
                });
                peersToDisconnect.push(peer);
            }
        }

        // Disconnect timed out peers
        for (const peer of peersToDisconnect) {
            logger.info('Disconnecting inactive peer', { peerId: peer.peerId });
            this._handlePeerDisconnection(peer, 'Inactivity timeout');
        }
    }

    /**
     * Perform cleanup cycle
     * @private
     */
    _performCleanupCycle() {
        const emptyRooms = this._findEmptyRoomsForCleanup();
        
        for (const roomName of emptyRooms) {
            this.removeRoom(roomName);
        }

        if (emptyRooms.length > 0) {
            logger.info('Cleaned up empty rooms', { count: emptyRooms.length });
        }
    }

    /**
     * Find empty rooms eligible for cleanup
     * @private
     * @returns {string[]} Room names to clean up
     */
    _findEmptyRoomsForCleanup() {
        const now = Date.now();
        const emptyRooms = [];

        for (const [name, room] of this._state.rooms) {
            if (room.isEmpty() && room.shouldCleanup(now)) {
                emptyRooms.push(name);
            }
        }

        return emptyRooms;
    }

    /**
     * Clean up server resources
     * @private
     * @returns {Promise<void>}
     */
    async _cleanup() {
        // Clear all rooms
        for (const room of this._state.rooms.values()) {
            try {
                room.destroy();
            } catch (error) {
                logger.error('Error destroying room', { error: error.message });
            }
        }
        this._state.rooms.clear();

        // Clear peers
        this._state.peers.clear();

        logger.debug('Server cleanup completed');
    }

    // Public API Methods

    /**
     * Create a new room
     * @param {string} name - Room name
     * @param {Object} [options={}] - Room options
     * @returns {PhotonRoom} Created room
     * @throws {Error} If room already exists
     */
    createRoom(name, options = {}) {
        if (!name || typeof name !== 'string') {
            throw new Error('Room name must be a non-empty string');
        }

        if (this._state.rooms.has(name)) {
            throw new Error(`Room '${name}' already exists`);
        }

        try {
            const room = new PhotonRoom(name, {
                ...options,
                emptyRoomTtl: options.emptyRoomTtl || this._config.emptyRoomTtl
            });

            this._state.rooms.set(name, room);
            this._state.stats.totalRoomsCreated++;
            this._state.stats.peakRooms = Math.max(
                this._state.stats.peakRooms, 
                this._state.rooms.size
            );

            logger.info('Room created', { roomName: name, options });
            this.emit('roomCreated', room);
            
            return room;
            
        } catch (error) {
            logger.error('Failed to create room', { 
                roomName: name, 
                error: error.message 
            });
            throw error;
        }
    }

    /**
     * Remove a room
     * @param {string} name - Room name
     * @returns {boolean} True if room was removed
     */
    removeRoom(name) {
        const room = this._state.rooms.get(name);
        if (!room) {
            return false;
        }

        if (!room.isEmpty()) {
            logger.warn('Attempting to remove non-empty room', { 
                roomName: name,
                peerCount: room.getPeerCount()
            });
            return false;
        }

        try {
            room.destroy();
            this._state.rooms.delete(name);
            
            logger.info('Room removed', { roomName: name });
            this.emit('roomRemoved', room);
            
            return true;
            
        } catch (error) {
            logger.error('Error removing room', { 
                roomName: name, 
                error: error.message 
            });
            return false;
        }
    }

    /**
     * Get room by name
     * @param {string} name - Room name
     * @returns {PhotonRoom|undefined} Room instance
     */
    getRoom(name) {
        return this._state.rooms.get(name);
    }

    /**
     * Get all rooms
     * @returns {PhotonRoom[]} Array of all rooms
     */
    getRooms() {
        return Array.from(this._state.rooms.values());
    }

    /**
     * Get visible rooms
     * @returns {PhotonRoom[]} Array of visible rooms
     */
    getVisibleRooms() {
        return this.getRooms().filter(room => room.isVisible);
    }

    /**
     * Get peer by ID
     * @param {number} peerId - Peer ID
     * @returns {PhotonPeer|undefined} Peer instance
     */
    getPeer(peerId) {
        return this._state.peers.get(peerId);
    }

    /**
     * Get all peers
     * @returns {PhotonPeer[]} Array of all peers
     */
    getPeers() {
        return Array.from(this._state.peers.values());
    }

    /**
     * Get connected peers
     * @returns {PhotonPeer[]} Array of connected peers
     */
    getConnectedPeers() {
        return this.getPeers().filter(peer => peer.isConnected());
    }

    /**
     * Disconnect peer by ID
     * @param {number} peerId - Peer ID
     * @param {string} [reason='Disconnected by server'] - Disconnect reason
     * @returns {boolean} True if peer was disconnected
     */
    disconnectPeer(peerId, reason = 'Disconnected by server') {
        const peer = this._state.peers.get(peerId);
        if (!peer) {
            return false;
        }

        try {
            this._handlePeerDisconnection(peer, reason);
            return true;
        } catch (error) {
            logger.error('Error disconnecting peer', { 
                peerId, 
                error: error.message 
            });
            return false;
        }
    }

    /**
     * Broadcast event to all connected peers
     * @param {number} eventCode - Event code
     * @param {Object} [data={}] - Event data
     * @param {number} [excludePeerId] - Peer ID to exclude
     */
    broadcast(eventCode, data = {}, excludePeerId = null) {
        if (typeof eventCode !== 'number') {
            throw new Error('Event code must be a number');
        }

        let sentCount = 0;
        const errors = [];

        for (const peer of this._state.peers.values()) {
            if (!peer.isConnected() || peer.peerId === excludePeerId) {
                continue;
            }

            try {
                peer.sendEvent(eventCode, data);
                sentCount++;
            } catch (error) {
                errors.push({ peerId: peer.peerId, error: error.message });
            }
        }

        if (errors.length > 0) {
            logger.warn('Broadcast errors', { 
                eventCode, 
                errors: errors.length,
                sent: sentCount 
            });
        }

        logger.debug('Broadcast sent', { eventCode, sentCount });
    }

    /**
     * Broadcast event to room
     * @param {string} roomName - Room name
     * @param {number} eventCode - Event code
     * @param {Object} [data={}] - Event data
     * @param {number} [excludePeerId] - Peer ID to exclude
     * @returns {boolean} True if room exists and broadcast was attempted
     */
    broadcastToRoom(roomName, eventCode, data = {}, excludePeerId = null) {
        const room = this.getRoom(roomName);
        if (!room) {
            logger.warn('Attempted broadcast to non-existent room', { roomName });
            return false;
        }

        try {
            room.broadcastEvent(eventCode, data, excludePeerId);
            logger.debug('Room broadcast sent', { roomName, eventCode });
            return true;
        } catch (error) {
            logger.error('Room broadcast failed', { 
                roomName, 
                eventCode, 
                error: error.message 
            });
            return false;
        }
    }

    /**
     * Get comprehensive server statistics
     * @returns {Object} Server statistics
     */
    getStats() {
        return {
            ...this._state.stats,
            currentConnections: this._state.peers.size,
            currentRooms: this._state.rooms.size,
            uptime: this._state.startTime ? Date.now() - this._state.startTime : 0,
            isRunning: this._state.isRunning,
            config: {
                port: this._config.port,
                host: this._config.host,
                maxConnections: this._config.maxConnections,
                pingInterval: this._config.pingInterval,
                connectionTimeout: this._config.connectionTimeout
            },
            memory: process.memoryUsage(),
            timestamp: Date.now()
        };
    }

    /**
     * Get server information
     * @returns {Object} Server info
     */
    getServerInfo() {
        return {
            version: (() => {
                try {
                    return require('../../package.json').version;
                } catch (error) {
                    return '1.0.0';
                }
            })(),
            host: this._config.host,
            port: this._config.port,
            isRunning: this._state.isRunning,
            startTime: this._state.startTime,
            uptime: this._state.startTime ? Date.now() - this._state.startTime : 0
        };
    }

    /**
     * Get detailed room statistics
     * @returns {Array} Array of room statistics
     */
    getRoomStats() {
        return this.getRooms().map(room => ({
            name: room.name,
            ...room.getStats()
        }));
    }

    /**
     * Get detailed peer statistics
     * @returns {Array} Array of peer statistics
     */
    getPeerStats() {
        return this.getPeers().map(peer => ({
            peerId: peer.peerId,
            ...peer.getStats()
        }));
    }

    /**
     * Get health check information
     * @returns {Object} Health status
     */
    getHealthStatus() {
        const stats = this.getStats();
        const errors = stats.totalErrors;
        const connections = stats.currentConnections;
        const maxConnections = this._config.maxConnections;
        
        const health = {
            status: 'healthy',
            uptime: stats.uptime,
            connections: `${connections}/${maxConnections}`,
            rooms: stats.currentRooms,
            errors: errors,
            timestamp: Date.now()
        };

        // Determine health status
        if (!this._state.isRunning) {
            health.status = 'down';
        } else if (errors > 100 || connections >= maxConnections * 0.95) {
            health.status = 'degraded';
        } else if (errors > 10 || connections >= maxConnections * 0.8) {
            health.status = 'warning';
        }

        return health;
    }

    /**
     * Force garbage collection and cleanup
     * @returns {Promise<void>}
     */
    async performMaintenance() {
        logger.info('Performing server maintenance');
        
        try {
            // Force cleanup cycle
            this._performCleanupCycle();
            
            // Force ping cycle
            this._performPingCycle();
            
            // Trigger garbage collection if available
            if (global.gc) {
                global.gc();
            }
            
            logger.info('Server maintenance completed');
            
        } catch (error) {
            logger.error('Error during maintenance', { error: error.message });
            throw error;
        }
    }

    /**
     * Export server state for debugging
     * @returns {Object} Serializable server state
     */
    exportState() {
        return {
            stats: this.getStats(),
            rooms: this.getRoomStats(),
            peers: this.getPeerStats(),
            config: this._config
        };
    }

    /**
     * JSON serialization for server state
     * @returns {Object} Serialized server data
     */
    toJSON() {
        return {
            serverInfo: this.getServerInfo(),
            stats: this.getStats(),
            health: this.getHealthStatus(),
            rooms: this.getRooms().map(room => room.toJSON()),
            peers: this.getPeers().map(peer => peer.toJSON())
        };
    }

    /**
     * Check if server is healthy and operational
     * @returns {boolean} Server health status
     */
    isHealthy() {
        return this._state.isRunning && 
               !this._shutdownInProgress &&
               this._state.peers.size < this._config.maxConnections;
    }

    /**
     * Get server capacity information
     * @returns {Object} Capacity metrics
     */
    getCapacity() {
        const connections = this._state.peers.size;
        const maxConnections = this._config.maxConnections;
        
        return {
            connections: {
                current: connections,
                max: maxConnections,
                utilization: connections / maxConnections,
                available: maxConnections - connections
            },
            rooms: {
                current: this._state.rooms.size,
                // No hard limit on rooms, but track for monitoring
            },
            memory: process.memoryUsage()
        };
    }

    /**
     * Set server configuration at runtime (limited settings)
     * @param {Object} config - Configuration updates
     * @returns {boolean} True if config was updated
     */
    updateConfig(config) {
        const allowedUpdates = ['pingInterval', 'connectionTimeout', 'cleanupInterval'];
        let updated = false;

        for (const [key, value] of Object.entries(config)) {
            if (allowedUpdates.includes(key) && typeof value === 'number' && value > 0) {
                this._config[key] = value;
                updated = true;
                logger.info('Configuration updated', { key, value });
            }
        }

        if (updated) {
            // Restart background tasks with new intervals
            this._stopBackgroundTasks();
            this._startBackgroundTasks();
        }

        return updated;
    }

    /**
     * Register event listener with error handling
     * @param {string} event - Event name
     * @param {Function} listener - Event listener
     * @returns {PhotonServer} Server instance for chaining
     */
    on(event, listener) {
        const wrappedListener = (...args) => {
            try {
                listener(...args);
            } catch (error) {
                logger.error('Event listener error', { 
                    event, 
                    error: error.message 
                });
                this._state.stats.totalErrors++;
            }
        };
        
        super.on(event, wrappedListener);
        return this;
    }

    /**
     * Get server metrics for monitoring systems
     * @returns {Object} Monitoring metrics
     */
    getMetrics() {
        const stats = this.getStats();
        const capacity = this.getCapacity();
        
        return {
            // Connection metrics
            'photon.connections.current': stats.currentConnections,
            'photon.connections.total': stats.totalConnections,
            'photon.connections.peak': stats.peakConnections,
            'photon.connections.utilization': capacity.connections.utilization,
            
            // Room metrics
            'photon.rooms.current': stats.currentRooms,
            'photon.rooms.total': stats.totalRoomsCreated,
            'photon.rooms.peak': stats.peakRooms,
            
            // Traffic metrics
            'photon.messages.total': stats.totalMessages,
            'photon.bytes.received': stats.bytesReceived,
            'photon.bytes.sent': stats.bytesSent,
            
            // Error metrics
            'photon.errors.total': stats.totalErrors,
            
            // System metrics
            'photon.uptime': stats.uptime,
            'photon.memory.rss': stats.memory.rss,
            'photon.memory.heapUsed': stats.memory.heapUsed,
            'photon.memory.heapTotal': stats.memory.heapTotal
        };
    }
}

module.exports = PhotonServer;