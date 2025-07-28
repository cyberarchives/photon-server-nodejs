const PhotonSerializer = require('../protocol/PhotonSerializer');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const { 
    PHOTON_COMMANDS, 
    PHOTON_PEER_STATE, 
    PHOTON_SIGNATURE,
    PHOTON_OPERATIONS,
    PHOTON_RETURN_CODES,
    DEFAULT_PEER_CONFIG 
} = require('../protocol/constants');

/**
 * Professional Photon Peer Implementation
 * Manages individual client connections with enterprise-grade
 * reliability, monitoring, and state management
 */
class PhotonPeer extends EventEmitter {
    /**
     * @param {net.Socket} socket - TCP socket connection
     * @param {number} peerId - Unique peer identifier
     * @param {Object} [options={}] - Peer configuration options
     * @param {number} [options.timeout=60000] - Connection timeout in milliseconds
     * @param {number} [options.pingInterval=30000] - Ping interval in milliseconds
     * @param {number} [options.maxReliableCommands=1000] - Maximum reliable commands to track
     * @param {boolean} [options.enableCompression=false] - Enable data compression
     */
    constructor(socket, peerId, options = {}) {
        super();
        
        this._config = this._validateAndMergeConfig(options);
        this._socket = this._validateSocket(socket);
        this._peerId = this._validatePeerId(peerId);
        
        this._state = this._initializePeerState();
        this._sequenceNumbers = this._initializeSequenceNumbers();
        this._commands = this._initializeCommandTracking();
        this._auth = this._initializeAuthState();
        this._room = null;
        
        this._setupSocketHandlers();
        
        logger.debug('PhotonPeer created', { 
            peerId: this._peerId,
            remoteAddress: this._socket.remoteAddress 
        });
    }

    /**
     * Validate and merge peer configuration
     * @private
     * @param {Object} options - Configuration options
     * @returns {Object} Validated configuration
     */
    _validateAndMergeConfig(options) {
        const config = { ...DEFAULT_PEER_CONFIG, ...options };
        
        if (config.timeout < 1000) {
            throw new Error('Timeout must be at least 1000ms');
        }
        
        if (config.pingInterval < 1000) {
            throw new Error('Ping interval must be at least 1000ms');
        }
        
        if (config.maxReliableCommands < 10) {
            throw new Error('Max reliable commands must be at least 10');
        }

        return config;
    }

    /**
     * Validate socket instance
     * @private
     * @param {net.Socket} socket - Socket to validate
     * @returns {net.Socket} Validated socket
     */
    _validateSocket(socket) {
        if (!socket || typeof socket.write !== 'function') {
            throw new Error('Invalid socket instance provided');
        }
        return socket;
    }

    /**
     * Validate peer ID
     * @private
     * @param {number} peerId - Peer ID to validate
     * @returns {number} Validated peer ID
     */
    _validatePeerId(peerId) {
        const id = parseInt(peerId);
        if (isNaN(id) || id < 1) {
            throw new Error('Peer ID must be a positive integer');
        }
        return id;
    }

    /**
     * Initialize peer state
     * @private
     * @returns {Object} Initial peer state
     */
    _initializePeerState() {
        return {
            status: PHOTON_PEER_STATE.CONNECTING,
            isActive: true,
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            lastPingTime: Date.now(),
            lastPongTime: 0,
            joinTime: null,
            isMasterClient: false,
            customProperties: {},
            stats: {
                messagesSent: 0,
                messagesReceived: 0,
                bytesReceived: 0,
                bytesSent: 0,
                reliableCommandsSent: 0,
                unreliableCommandsSent: 0,
                eventsSent: 0,
                eventsReceived: 0,
                operationsSent: 0,
                operationsReceived: 0,
                pingsSent: 0,
                pongsReceived: 0,
                errors: 0,
                reconnects: 0
            }
        };
    }

    /**
     * Initialize sequence number tracking
     * @private
     * @returns {Object} Sequence number state
     */
    _initializeSequenceNumbers() {
        return {
            reliableOut: 0,
            unreliableOut: 0,
            reliableIn: -1,
            unreliableIn: -1
        };
    }

    /**
     * Initialize command tracking
     * @private
     * @returns {Object} Command tracking state
     */
    _initializeCommandTracking() {
        return {
            sentReliable: new Map(),
            receivedReliable: new Set(),
            pendingAcks: new Map(),
            retransmissions: new Map()
        };
    }

    /**
     * Initialize authentication state
     * @private
     * @returns {Object} Authentication state
     */
    _initializeAuthState() {
        return {
            isAuthenticated: false,
            playerName: '',
            userId: '',
            authData: null,
            authenticatedAt: null,
            hasValidPassword: false
        };
    }

    /**
     * Setup socket event handlers
     * @private
     */
    _setupSocketHandlers() {
        this._socket.on('close', (hadError) => {
            this._handleSocketClose(hadError);
        });

        this._socket.on('error', (error) => {
            this._handleSocketError(error);
        });

        this._socket.on('timeout', () => {
            this._handleSocketTimeout();
        });
    }

    /**
     * Handle socket close event
     * @private
     * @param {boolean} hadError - Whether close was due to error
     */
    _handleSocketClose(hadError) {
        logger.info('Peer socket closed', { 
            peerId: this._peerId,
            hadError,
            wasActive: this._state.isActive
        });

        this._state.isActive = false;
        this._state.status = PHOTON_PEER_STATE.DISCONNECTED;
        this.emit('disconnected', this, hadError ? 'Socket error' : 'Socket closed');
    }

    /**
     * Handle socket error event
     * @private
     * @param {Error} error - Socket error
     */
    _handleSocketError(error) {
        logger.error('Peer socket error', { 
            peerId: this._peerId,
            error: error.message 
        });

        this._state.stats.errors++;
        this.emit('error', error, this);
    }

    /**
     * Handle socket timeout event
     * @private
     */
    _handleSocketTimeout() {
        logger.warn('Peer socket timeout', { peerId: this._peerId });
        this.disconnect('Socket timeout');
    }

    // Public API Properties

    /**
     * Get peer ID
     * @returns {number} Peer ID
     */
    get peerId() {
        return this._peerId;
    }

    /**
     * Get player name
     * @returns {string} Player name
     */
    get playerName() {
        return this._auth.playerName;
    }

    /**
     * Get user ID
     * @returns {string} User ID
     */
    get userId() {
        return this._auth.userId;
    }

    /**
     * Get custom properties (read-only copy)
     * @returns {Object} Custom properties
     */
    get customProperties() {
        return { ...this._state.customProperties };
    }

    /**
     * Get peer state
     * @returns {string} Current peer state
     */
    get state() {
        return this._state.status;
    }

    /**
     * Get master client status
     * @returns {boolean} Is master client
     */
    get isMasterClient() {
        return this._state.isMasterClient;
    }

    /**
     * Get current room
     * @returns {PhotonRoom|null} Current room
     */
    get room() {
        return this._room;
    }

    /**
     * Get join time
     * @returns {number|null} Join timestamp
     */
    get joinTime() {
        return this._state.joinTime;
    }

    /**
     * Get connection time in milliseconds
     * @returns {number} Connection duration
     */
    get connectionTime() {
        return Date.now() - this._state.connectedAt;
    }

    /**
     * Get time since last activity in milliseconds
     * @returns {number} Time since last activity
     */
    get timeSinceLastActivity() {
        return Date.now() - this._state.lastActivity;
    }

    /**
     * Check if peer has valid password
     * @returns {boolean} Has valid password
     */
    get hasValidPassword() {
        return this._auth.hasValidPassword;
    }

    // Connection Management

    /**
     * Check if peer is connected
     * @returns {boolean} True if peer is connected and active
     */
    isConnected() {
        return this._state.status === PHOTON_PEER_STATE.CONNECTED && 
               this._state.isActive && 
               this._socket && 
               !this._socket.destroyed;
    }

    /**
     * Check if peer is authenticated
     * @returns {boolean} True if peer is authenticated
     */
    isAuthenticated() {
        return this._auth.isAuthenticated;
    }

    /**
     * Update peer activity timestamp
     */
    updateActivity() {
        this._state.lastActivity = Date.now();
    }

    /**
     * Update last ping time
     */
    updateLastPingTime() {
        this._state.lastPingTime = Date.now();
        this._state.stats.pingsSent++;
    }

    /**
     * Record pong received
     */
    recordPongReceived() {
        this._state.lastPongTime = Date.now();
        this._state.stats.pongsReceived++;
    }

    /**
     * Check if peer should send ping
     * @param {number} [currentTime] - Current timestamp
     * @returns {boolean} Should send ping
     */
    shouldSendPing(currentTime = Date.now()) {
        return (currentTime - this._state.lastPingTime) > this._config.pingInterval;
    }

    /**
     * Check if peer is timed out
     * @param {number} [currentTime] - Current timestamp
     * @returns {boolean} Is timed out
     */
    isTimedOut(currentTime = Date.now()) {
        return (currentTime - this._state.lastActivity) > this._config.timeout;
    }

    /**
     * Set peer state
     * @param {string} newState - New peer state
     */
    setState(newState) {
        if (this._state.status !== newState) {
            const oldState = this._state.status;
            this._state.status = newState;
            
            logger.debug('Peer state changed', { 
                peerId: this._peerId,
                from: oldState,
                to: newState
            });

            this.emit('stateChanged', newState, oldState, this);
        }
    }

    /**
     * Update peer statistics
     * @param {string} metric - Metric name
     * @param {number} [value=1] - Value to add
     */
    updateStats(metric, value = 1) {
        if (this._state.stats.hasOwnProperty(metric)) {
            this._state.stats[metric] += value;
        }
    }

    // Command Sending

    /**
     * Send command to peer
     * @param {number} commandType - Command type
     * @param {Object} [data=null] - Command data
     * @param {number} [channelId=0] - Channel ID
     * @param {number} [flags=0] - Command flags
     * @returns {boolean} True if command was sent successfully
     */
    sendCommand(commandType, data = null, channelId = 0, flags = 0) {
        if (!this._canSendCommand()) {
            logger.debug('Cannot send command: peer not ready', { 
                peerId: this._peerId,
                commandType,
                state: this._state.status
            });
            return false;
        }

        try {
            const packet = this._buildCommandPacket(commandType, data, channelId, flags);
            const success = this._transmitPacket(packet);
            
            if (success) {
                this._updateSendStats(commandType, packet.length);
                this._trackReliableCommand(commandType, data);
            }

            return success;

        } catch (error) {
            logger.error('Failed to send command', { 
                peerId: this._peerId,
                commandType,
                error: error.message
            });
            this._state.stats.errors++;
            return false;
        }
    }

    /**
     * Check if peer can send commands
     * @private
     * @returns {boolean} Can send command
     */
    _canSendCommand() {
        return this._socket && 
               !this._socket.destroyed && 
               this._state.isActive &&
               this._state.status !== PHOTON_PEER_STATE.DISCONNECTED;
    }

    /**
     * Build command packet
     * @private
     * @param {number} commandType - Command type
     * @param {Object} data - Command data
     * @param {number} channelId - Channel ID
     * @param {number} flags - Command flags
     * @returns {Buffer} Command packet
     */
    _buildCommandPacket(commandType, data, channelId, flags) {
        const serializer = new PhotonSerializer();
        const sequenceNumber = this._getNextSequenceNumber(commandType);
        const timestamp = Date.now() & 0xFFFFFFFF;
        
        serializer.writeCommand(
            commandType, 
            channelId, 
            flags, 
            timestamp, 
            sequenceNumber, 
            data
        );

        const buffer = serializer.getBuffer();
        return PhotonSerializer.createPacket(this._peerId, buffer);
    }

    /**
     * Get next sequence number for command type
     * @private
     * @param {number} commandType - Command type
     * @returns {number|null} Sequence number
     */
    _getNextSequenceNumber(commandType) {
        switch (commandType) {
            case PHOTON_COMMANDS.SEND_RELIABLE:
                return this._sequenceNumbers.reliableOut++;
            case PHOTON_COMMANDS.SEND_UNRELIABLE:
                return this._sequenceNumbers.unreliableOut++;
            default:
                return null;
        }
    }

    /**
     * Transmit packet over socket
     * @private
     * @param {Buffer} packet - Packet to transmit
     * @returns {boolean} Transmission success
     */
    _transmitPacket(packet) {
        try {
            return this._socket.write(packet);
        } catch (error) {
            logger.error('Socket write failed', { 
                peerId: this._peerId,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Update send statistics
     * @private
     * @param {number} commandType - Command type
     * @param {number} packetSize - Packet size in bytes
     */
    _updateSendStats(commandType, packetSize) {
        this._state.stats.messagesSent++;
        this._state.stats.bytesSent += packetSize;

        switch (commandType) {
            case PHOTON_COMMANDS.SEND_RELIABLE:
                this._state.stats.reliableCommandsSent++;
                break;
            case PHOTON_COMMANDS.SEND_UNRELIABLE:
                this._state.stats.unreliableCommandsSent++;
                break;
        }
    }

    /**
     * Track reliable command for acknowledgment
     * @private
     * @param {number} commandType - Command type
     * @param {Object} data - Command data
     */
    _trackReliableCommand(commandType, data) {
        if (commandType === PHOTON_COMMANDS.SEND_RELIABLE) {
            const sequenceNumber = this._sequenceNumbers.reliableOut - 1;
            this._commands.sentReliable.set(sequenceNumber, {
                data,
                timestamp: Date.now(),
                retransmissions: 0
            });

            // Cleanup old commands
            this._cleanupOldReliableCommands();
        }
    }

    /**
     * Cleanup old reliable commands
     * @private
     */
    _cleanupOldReliableCommands() {
        if (this._commands.sentReliable.size > this._config.maxReliableCommands) {
            const entries = Array.from(this._commands.sentReliable.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            
            const toRemove = entries.slice(0, entries.length - this._config.maxReliableCommands);
            for (const [sequenceNumber] of toRemove) {
                this._commands.sentReliable.delete(sequenceNumber);
            }
        }
    }

    // High-level Communication Methods

    /**
     * Send operation response to peer
     * @param {number} opCode - Operation code
     * @param {number} [returnCode=0] - Return code
     * @param {Object} [parameters={}] - Response parameters
     * @param {string} [debugMessage] - Debug message
     * @returns {boolean} True if response was sent
     */
    sendOperationResponse(opCode, returnCode = PHOTON_RETURN_CODES.OK, parameters = {}, debugMessage = null) {
        const response = {
            OperationCode: opCode,
            ReturnCode: returnCode,
            Parameters: { ...parameters }
        };
        
        if (debugMessage) {
            response.DebugMessage = debugMessage;
        }
        
        const success = this.sendCommand(PHOTON_COMMANDS.SEND_RELIABLE, response);
        if (success) {
            this._state.stats.operationsSent++;
        }
        
        return success;
    }

    /**
     * Send event to peer
     * @param {number} eventCode - Event code
     * @param {Object} [parameters={}] - Event parameters
     * @param {number} [cacheEventId] - Cache event ID
     * @returns {boolean} True if event was sent
     */
    sendEvent(eventCode, parameters = {}, cacheEventId = null) {
        const event = {
            Code: eventCode,
            Parameters: { ...parameters }
        };
        
        if (cacheEventId !== null) {
            event.CacheEventId = cacheEventId;
        }
        
        const success = this.sendCommand(PHOTON_COMMANDS.SEND_RELIABLE, event);
        if (success) {
            this._state.stats.eventsSent++;
        }
        
        return success;
    }

    /**
     * Send ping to peer
     * @returns {boolean} True if ping was sent
     */
    sendPing() {
        const success = this.sendCommand(PHOTON_COMMANDS.PING);
        if (success) {
            this.updateLastPingTime();
        }
        return success;
    }

    /**
     * Send pong response
     * @returns {boolean} True if pong was sent
     */
    sendPong() {
        return this.sendCommand(PHOTON_COMMANDS.PONG);
    }

    /**
     * Send connection verification
     * @returns {boolean} True if verification was sent
     */
    sendVerifyConnect() {
        const success = this.sendCommand(PHOTON_COMMANDS.VERIFY_CONNECT);
        if (success) {
            logger.debug('Verification sent to peer', { peerId: this._peerId });
        }
        return success;
    }

    /**
     * Send disconnect command
     * @returns {boolean} True if disconnect was sent
     */
    sendDisconnect() {
        const success = this.sendCommand(PHOTON_COMMANDS.DISCONNECT);
        if (success) {
            this.setState(PHOTON_PEER_STATE.DISCONNECTING);
        }
        return success;
    }

    // Authentication

    /**
     * Authenticate peer
     * @param {string} nickname - Player nickname
     * @param {string} [userId] - User ID
     * @param {*} [customAuthData] - Custom authentication data
     * @returns {boolean} True if authentication response was sent
     */
    authenticate(nickname, userId = null, customAuthData = null) {
        try {
            this._validateAuthenticationInput(nickname, userId);
            
            this._auth.playerName = nickname.trim();
            this._auth.userId = userId || this._peerId.toString();
            this._auth.authData = customAuthData;
            this._auth.isAuthenticated = true;
            this._auth.authenticatedAt = Date.now();
            
            this.setState(PHOTON_PEER_STATE.CONNECTED);
            
            const success = this.sendOperationResponse(PHOTON_OPERATIONS.AUTHENTICATE, PHOTON_RETURN_CODES.OK, {
                nickname: this._auth.playerName,
                userid: this._auth.userId,
                secret: 'authenticated'
            });

            if (success) {
                logger.info('Peer authenticated', { 
                    peerId: this._peerId,
                    nickname: this._auth.playerName,
                    userId: this._auth.userId
                });

                this.emit('authenticated', this);
            }

            return success;

        } catch (error) {
            logger.error('Authentication failed', { 
                peerId: this._peerId,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Validate authentication input
     * @private
     * @param {string} nickname - Nickname to validate
     * @param {string} userId - User ID to validate
     */
    _validateAuthenticationInput(nickname, userId) {
        if (!nickname || typeof nickname !== 'string' || nickname.trim().length === 0) {
            throw new Error('Nickname must be a non-empty string');
        }

        if (nickname.trim().length > 50) {
            throw new Error('Nickname cannot exceed 50 characters');
        }

        if (userId && typeof userId !== 'string') {
            throw new Error('User ID must be a string');
        }

        if (userId && userId.length > 100) {
            throw new Error('User ID cannot exceed 100 characters');
        }
    }

    /**
     * Validate password
     * @param {string} password - Password to validate
     * @returns {boolean} True if password is valid
     */
    validatePassword(password) {
        // This would typically validate against stored credentials
        // For now, we'll use a simple comparison
        this._auth.hasValidPassword = true; // Implement actual validation
        return this._auth.hasValidPassword;
    }

    // Property Management

    /**
     * Set custom properties
     * @param {Object} properties - Properties to set
     * @param {boolean} [broadcast=true] - Whether to broadcast changes
     * @returns {boolean} True if properties were set
     */
    setCustomProperties(properties, broadcast = true) {
        if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
            logger.warn('Invalid properties provided', { 
                peerId: this._peerId,
                properties
            });
            return false;
        }

        try {
            // Merge properties (deep clone to prevent external mutations)
            Object.assign(this._state.customProperties, JSON.parse(JSON.stringify(properties)));
            
            if (broadcast && this._room) {
                this._room.broadcastEvent(253, {
                    targetActor: this._peerId,
                    properties: this.customProperties
                }, this._peerId);
            }

            logger.debug('Peer properties updated', { 
                peerId: this._peerId,
                properties: Object.keys(properties)
            });

            this.emit('propertiesChanged', properties, this);
            return true;

        } catch (error) {
            logger.error('Failed to set custom properties', { 
                peerId: this._peerId,
                error: error.message
            });
            return false;
        }
    }

    // Room Management

    /**
     * Set peer's room
     * @param {PhotonRoom|null} room - Room to set
     */
    setRoom(room) {
        const oldRoom = this._room;
        this._room = room;
        
        if (room) {
            this._state.joinTime = Date.now();
            logger.debug('Peer set to room', { 
                peerId: this._peerId,
                roomName: room.name
            });
        } else {
            this._state.joinTime = null;
            this._state.isMasterClient = false;
            logger.debug('Peer removed from room', { peerId: this._peerId });
        }

        this.emit('roomChanged', room, oldRoom, this);
    }

    /**
     * Leave current room
     * @param {string} [reason='Left room'] - Leave reason
     * @returns {boolean} True if peer left room
     */
    leaveRoom(reason = 'Left room') {
        if (!this._room) {
            return false;
        }

        const room = this._room;
        const sessionDuration = this._state.joinTime ? Date.now() - this._state.joinTime : 0;
        
        try {
            room.removePeer(this);
            
            logger.info('Peer left room', { 
                peerId: this._peerId,
                roomName: room.name,
                reason,
                sessionDuration
            });

            this.emit('leftRoom', room, reason, sessionDuration, this);
            return true;

        } catch (error) {
            logger.error('Error leaving room', { 
                peerId: this._peerId,
                roomName: room.name,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Set master client status
     * @param {boolean} [isMaster=true] - Master client status
     */
    setMasterClient(isMaster = true) {
        if (this._state.isMasterClient !== isMaster) {
            this._state.isMasterClient = isMaster;
            
            logger.debug('Peer master client status changed', { 
                peerId: this._peerId,
                isMasterClient: isMaster
            });

            this.emit('masterClientChanged', isMaster, this);
        }
    }

    // Connection Lifecycle

    /**
     * Disconnect peer gracefully
     * @param {string} [reason='Disconnected'] - Disconnect reason
     * @returns {Promise<void>}
     */
    async disconnect(reason = 'Disconnected') {
        if (!this._state.isActive) {
            return;
        }

        logger.info('Disconnecting peer', { 
            peerId: this._peerId,
            reason
        });

        try {
            this._state.isActive = false;
            this.setState(PHOTON_PEER_STATE.DISCONNECTING);
            
            // Leave room if in one
            if (this._room) {
                this.leaveRoom(reason);
            }
            
            // Send disconnect command
            this.sendDisconnect();
            
            // Close socket after short delay
            await new Promise(resolve => setTimeout(resolve, 100));
            await this._closeSocket();
            
            this.emit('disconnected', this, reason);

        } catch (error) {
            logger.error('Error during disconnect', { 
                peerId: this._peerId,
                error: error.message
            });
            await this._forceDisconnect();
        }
    }

    /**
     * Force immediate disconnection
     * @returns {Promise<void>}
     */
    async forceDisconnect() {
        logger.warn('Force disconnecting peer', { peerId: this._peerId });
        await this._forceDisconnect();
    }

    /**
     * Force disconnect implementation
     * @private
     * @returns {Promise<void>}
     */
    async _forceDisconnect() {
        this._state.isActive = false;
        this.setState(PHOTON_PEER_STATE.DISCONNECTED);
        
        if (this._room) {
            try {
                this.leaveRoom('Force disconnect');
            } catch (error) {
                // Ignore errors during force disconnect
            }
        }
        
        await this._closeSocket();
        this.emit('disconnected', this, 'Force disconnect');
    }

    /**
     * Close socket connection
     * @private
     * @returns {Promise<void>}
     */
    async _closeSocket() {
        if (this._socket && !this._socket.destroyed) {
            try {
                this._socket.destroy();
            } catch (error) {
                logger.debug('Error destroying socket', { 
                    peerId: this._peerId,
                    error: error.message
                });
            }
        }
    }

    /**
     * Clean up peer resources
     */
    cleanup() {
        try {
            // Clear command tracking
            this._commands.sentReliable.clear();
            this._commands.receivedReliable.clear();
            this._commands.pendingAcks.clear();
            this._commands.retransmissions.clear();
            
            // Clear room reference
            this._room = null;
            
            // Remove all event listeners
            this.removeAllListeners();
            
            logger.debug('Peer cleanup completed', { peerId: this._peerId });

        } catch (error) {
            logger.error('Error during peer cleanup', { 
                peerId: this._peerId,
                error: error.message
            });
        }
    }

    // Statistics and Monitoring

    /**
     * Get comprehensive peer statistics
     * @returns {Object} Peer statistics
     */
    getStats() {
        const now = Date.now();
        
        return {
            // Identity
            peerId: this._peerId,
            playerName: this._auth.playerName,
            userId: this._auth.userId,
            
            // State
            state: this._state.status,
            isActive: this._state.isActive,
            isAuthenticated: this._auth.isAuthenticated,
            isMasterClient: this._state.isMasterClient,
            
            // Room info
            room: this._room ? this._room.name : null,
            
            // Timing
            connectedAt: this._state.connectedAt,
            authenticatedAt: this._auth.authenticatedAt,
            joinTime: this._state.joinTime,
            connectionTime: this.connectionTime,
            timeSinceLastActivity: this.timeSinceLastActivity,
            sessionDuration: this._state.joinTime ? now - this._state.joinTime : 0,
            
            // Network stats
            ...this._state.stats,
            
            // Performance metrics
            averageLatency: this._calculateAverageLatency(),
            reliabilityScore: this._calculateReliabilityScore(),
            
            // Connection health
            lastPingTime: this._state.lastPingTime,
            lastPongTime: this._state.lastPongTime,
            pingLatency: this._state.lastPongTime > 0 ? this._state.lastPongTime - this._state.lastPingTime : null
        };
    }

    /**
     * Calculate average latency
     * @private
     * @returns {number} Average latency in milliseconds
     */
    _calculateAverageLatency() {
        // Simple ping-pong latency calculation
        if (this._state.lastPongTime > 0 && this._state.lastPingTime > 0) {
            return Math.max(0, this._state.lastPongTime - this._state.lastPingTime);
        }
        return 0;
    }

    /**
     * Calculate reliability score
     * @private
     * @returns {number} Reliability score (0-100)
     */
    _calculateReliabilityScore() {
        const stats = this._state.stats;
        let score = 100;

        // Penalize errors
        if (stats.messagesSent > 0) {
            const errorRate = stats.errors / stats.messagesSent;
            score -= Math.min(errorRate * 100, 50);
        }

        // Penalize reconnects
        score -= Math.min(stats.reconnects * 10, 30);

        // Bonus for successful pongs
        if (stats.pingsSent > 0) {
            const pongRate = stats.pongsReceived / stats.pingsSent;
            score += Math.min(pongRate * 10, 10);
        }

        return Math.max(0, Math.min(100, Math.round(score)));
    }

    /**
     * Get peer health status
     * @returns {Object} Health information
     */
    getHealthStatus() {
        const stats = this.getStats();
        const health = {
            status: 'healthy',
            issues: [],
            metrics: {
                connectivity: this._assessConnectivity(),
                performance: this._assessPerformance(),
                stability: this._assessStability()
            }
        };

        // Determine overall health
        if (!this.isConnected()) {
            health.status = 'disconnected';
        } else if (!this.isAuthenticated()) {
            health.status = 'unauthenticated';
        } else {
            // Check for issues
            if (this.timeSinceLastActivity > 60000) { // 1 minute
                health.issues.push('Long inactivity period');
                health.status = 'inactive';
            }

            if (this._state.stats.errors > 10) {
                health.issues.push('High error count');
                health.status = 'degraded';
            }

            if (this.isTimedOut()) {
                health.issues.push('Connection timeout');
                health.status = 'timeout';
            }

            if (health.issues.length > 0 && health.status === 'healthy') {
                health.status = 'warning';
            }
        }

        return health;
    }

    /**
     * Assess connectivity metrics
     * @private
     * @returns {Object} Connectivity assessment
     */
    _assessConnectivity() {
        return {
            isConnected: this.isConnected(),
            isActive: this._state.isActive,
            socketState: this._socket ? (this._socket.destroyed ? 'destroyed' : 'open') : 'null',
            timeSinceLastActivity: this.timeSinceLastActivity
        };
    }

    /**
     * Assess performance metrics
     * @private
     * @returns {Object} Performance assessment
     */
    _assessPerformance() {
        const stats = this._state.stats;
        return {
            latency: this._calculateAverageLatency(),
            throughput: this._calculateThroughput(),
            errorRate: stats.messagesSent > 0 ? (stats.errors / stats.messagesSent) * 100 : 0,
            reliabilityScore: this._calculateReliabilityScore()
        };
    }

    /**
     * Calculate throughput
     * @private
     * @returns {Object} Throughput metrics
     */
    _calculateThroughput() {
        const connectionTimeSeconds = this.connectionTime / 1000;
        if (connectionTimeSeconds === 0) return { messagesPerSecond: 0, bytesPerSecond: 0 };

        return {
            messagesPerSecond: (this._state.stats.messagesSent + this._state.stats.messagesReceived) / connectionTimeSeconds,
            bytesPerSecond: (this._state.stats.bytesSent + this._state.stats.bytesReceived) / connectionTimeSeconds
        };
    }

    /**
     * Assess stability metrics
     * @private
     * @returns {Object} Stability assessment
     */
    _assessStability() {
        return {
            connectionTime: this.connectionTime,
            reconnects: this._state.stats.reconnects,
            errors: this._state.stats.errors,
            stateChanges: this._countStateChanges(),
            isStable: this._isConnectionStable()
        };
    }

    /**
     * Count state changes (simplified implementation)
     * @private
     * @returns {number} State change count
     */
    _countStateChanges() {
        // This would track actual state changes in a real implementation
        return this._state.stats.reconnects;
    }

    /**
     * Check if connection is stable
     * @private
     * @returns {boolean} Is connection stable
     */
    _isConnectionStable() {
        return this.isConnected() && 
               this._state.stats.errors < 5 && 
               this._state.stats.reconnects === 0 &&
               this.timeSinceLastActivity < 30000; // 30 seconds
    }

    /**
     * Get performance metrics for monitoring
     * @returns {Object} Performance metrics
     */
    getPerformanceMetrics() {
        const throughput = this._calculateThroughput();
        
        return {
            // Latency metrics
            'peer.latency.current': this._calculateAverageLatency(),
            'peer.latency.average': this._calculateAverageLatency(), // Would be rolling average in real implementation
            
            // Throughput metrics
            'peer.throughput.messages': throughput.messagesPerSecond,
            'peer.throughput.bytes': throughput.bytesPerSecond,
            
            // Reliability metrics
            'peer.reliability.score': this._calculateReliabilityScore(),
            'peer.reliability.errors': this._state.stats.errors,
            'peer.reliability.reconnects': this._state.stats.reconnects,
            
            // Activity metrics
            'peer.activity.lastSeen': this.timeSinceLastActivity,
            'peer.activity.connectionTime': this.connectionTime,
            'peer.activity.sessionTime': this._state.joinTime ? Date.now() - this._state.joinTime : 0
        };
    }

    // Utility Methods

    /**
     * Export peer state for debugging
     * @returns {Object} Complete peer state
     */
    exportState() {
        return {
            peerId: this._peerId,
            config: this._config,
            state: this._state,
            auth: this._auth,
            sequenceNumbers: this._sequenceNumbers,
            commands: {
                sentReliableCount: this._commands.sentReliable.size,
                receivedReliableCount: this._commands.receivedReliable.size,
                pendingAcksCount: this._commands.pendingAcks.size
            },
            room: this._room ? this._room.name : null,
            socket: {
                destroyed: this._socket ? this._socket.destroyed : true,
                remoteAddress: this._socket ? this._socket.remoteAddress : null,
                remotePort: this._socket ? this._socket.remotePort : null
            },
            stats: this.getStats(),
            health: this.getHealthStatus(),
            performance: this.getPerformanceMetrics()
        };
    }

    /**
     * JSON serialization for API responses
     * @returns {Object} Serialized peer data
     */
    toJSON() {
        return {
            peerId: this._peerId,
            playerName: this._auth.playerName,
            userId: this._auth.userId,
            customProperties: this.customProperties,
            state: this._state.status,
            isActive: this._state.isActive,
            isAuthenticated: this._auth.isAuthenticated,
            isMasterClient: this._state.isMasterClient,
            room: this._room ? this._room.name : null,
            connectionTime: this.connectionTime,
            timeSinceLastActivity: this.timeSinceLastActivity,
            stats: this._state.stats,
            health: this.getHealthStatus()
        };
    }

    /**
     * String representation for debugging
     * @returns {string} Peer string representation
     */
    toString() {
        const room = this._room ? `:${this._room.name}` : '';
        return `PhotonPeer[${this._peerId}:${this._auth.playerName}:${this._state.status}${room}]`;
    }

    /**
     * Create peer snapshot for monitoring
     * @returns {Object} Peer snapshot
     */
    createSnapshot() {
        return {
            timestamp: Date.now(),
            peerId: this._peerId,
            playerName: this._auth.playerName,
            state: this._state.status,
            isActive: this._state.isActive,
            isAuthenticated: this._auth.isAuthenticated,
            isMasterClient: this._state.isMasterClient,
            room: this._room ? this._room.name : null,
            connectionTime: this.connectionTime,
            timeSinceLastActivity: this.timeSinceLastActivity,
            stats: { ...this._state.stats },
            latency: this._calculateAverageLatency(),
            reliabilityScore: this._calculateReliabilityScore()
        };
    }

    /**
     * Validate peer integrity
     * @returns {Object} Validation result
     */
    validateIntegrity() {
        const issues = [];
        const warnings = [];

        // Check socket state
        if (!this._socket) {
            issues.push('Socket is null');
        } else if (this._socket.destroyed && this._state.isActive) {
            issues.push('Socket is destroyed but peer is marked as active');
        }

        // Check authentication state
        if (this._state.status === PHOTON_PEER_STATE.CONNECTED && !this._auth.isAuthenticated) {
            warnings.push('Peer is connected but not authenticated');
        }

        // Check room consistency
        if (this._room && this._state.isMasterClient) {
            if (this._room.masterClientId !== this._peerId) {
                issues.push('Peer is marked as master client but room has different master');
            }
        }

        // Check sequence number consistency
        if (this._sequenceNumbers.reliableOut < 0 || this._sequenceNumbers.unreliableOut < 0) {
            issues.push('Negative sequence numbers detected');
        }

        // Check statistics consistency
        if (this._state.stats.messagesSent < 0 || this._state.stats.messagesReceived < 0) {
            issues.push('Negative statistics detected');
        }

        return {
            isValid: issues.length === 0,
            issues,
            warnings,
            checkedAt: Date.now()
        };
    }

    /**
     * Repair peer integrity issues
     * @returns {Object} Repair result
     */
    repairIntegrity() {
        const validation = this.validateIntegrity();
        const repairs = [];

        if (validation.isValid) {
            return { repairs, success: true };
        }

        try {
            // Fix socket state inconsistencies
            if (this._socket && this._socket.destroyed && this._state.isActive) {
                this._state.isActive = false;
                this.setState(PHOTON_PEER_STATE.DISCONNECTED);
                repairs.push('Fixed socket/activity state inconsistency');
            }

            // Fix negative sequence numbers
            if (this._sequenceNumbers.reliableOut < 0) {
                this._sequenceNumbers.reliableOut = 0;
                repairs.push('Reset negative reliable sequence number');
            }

            if (this._sequenceNumbers.unreliableOut < 0) {
                this._sequenceNumbers.unreliableOut = 0;
                repairs.push('Reset negative unreliable sequence number');
            }

            // Fix negative statistics
            for (const [key, value] of Object.entries(this._state.stats)) {
                if (typeof value === 'number' && value < 0) {
                    this._state.stats[key] = 0;
                    repairs.push(`Reset negative statistic: ${key}`);
                }
            }

            logger.info('Peer integrity repaired', {
                peerId: this._peerId,
                repairs: repairs.length
            });

            return { repairs, success: true };

        } catch (error) {
            logger.error('Failed to repair peer integrity', {
                peerId: this._peerId,
                error: error.message
            });
            return { repairs, success: false, error: error.message };
        }
    }

    /**
     * Reset peer statistics
     */
    resetStats() {
        this._state.stats = {
            messagesSent: 0,
            messagesReceived: 0,
            bytesReceived: 0,
            bytesSent: 0,
            reliableCommandsSent: 0,
            unreliableCommandsSent: 0,
            eventsSent: 0,
            eventsReceived: 0,
            operationsSent: 0,
            operationsReceived: 0,
            pingsSent: 0,
            pongsReceived: 0,
            errors: 0,
            reconnects: 0
        };

        logger.debug('Peer statistics reset', { peerId: this._peerId });
        this.emit('statsReset', this);
    }

    /**
     * Get connection summary
     * @returns {Object} Connection summary
     */
    getConnectionSummary() {
        return {
            peerId: this._peerId,
            playerName: this._auth.playerName,
            state: this._state.status,
            isConnected: this.isConnected(),
            isAuthenticated: this.isAuthenticated(),
            connectionTime: this.connectionTime,
            room: this._room ? this._room.name : null,
            isMasterClient: this._state.isMasterClient,
            lastActivity: this.timeSinceLastActivity,
            messagesSent: this._state.stats.messagesSent,
            messagesReceived: this._state.stats.messagesReceived,
            errors: this._state.stats.errors,
            latency: this._calculateAverageLatency(),
            reliabilityScore: this._calculateReliabilityScore()
        };
    }
}

module.exports = PhotonPeer;