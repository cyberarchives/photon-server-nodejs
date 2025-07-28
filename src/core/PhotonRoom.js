const { PHOTON_EVENTS, PHOTON_OPERATIONS, PHOTON_RETURN_CODES } = require('../protocol/constants');
const EventEmitter = require('events');
const logger = require('../utils/logger');

/**
 * Professional Photon Room Implementation
 * Manages peer connections, game state, and room lifecycle
 * with enterprise-grade reliability and monitoring
 */
class PhotonRoom extends EventEmitter {
    /**
     * @param {string} name - Room name
     * @param {Object} [options={}] - Room configuration options
     * @param {number} [options.maxPlayers=4] - Maximum number of players
     * @param {Object} [options.customProperties={}] - Custom room properties
     * @param {boolean} [options.isOpen=true] - Room is open for new players
     * @param {boolean} [options.isVisible=true] - Room is visible in listings
     * @param {string} [options.password] - Room password
     * @param {number} [options.playerTtl=0] - Player time-to-live in milliseconds
     * @param {number} [options.emptyRoomTtl=300000] - Empty room TTL in milliseconds
     * @param {boolean} [options.autoCleanup=true] - Enable automatic cleanup
     * @param {number} [options.maxCachedEvents=100] - Maximum cached events
     */
    constructor(name, options = {}) {
        super();
        
        this._config = this._validateAndMergeConfig(name, options);
        this._state = this._initializeRoomState();
        this._peers = new Map();
        this._cachedEvents = new Map();
        this._expectedUsers = new Set();
        
        logger.info('PhotonRoom created', { 
            roomName: this.name, 
            config: this._config 
        });
    }

    /**
     * Validate and merge room configuration
     * @private
     * @param {string} name - Room name
     * @param {Object} options - Configuration options
     * @returns {Object} Validated configuration
     */
    _validateAndMergeConfig(name, options) {
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            throw new Error('Room name must be a non-empty string');
        }

        const config = {
            name: name.trim(),
            maxPlayers: this._validateMaxPlayers(options.maxPlayers),
            customProperties: this._validateCustomProperties(options.customProperties),
            isOpen: options.isOpen !== false,
            isVisible: options.isVisible !== false,
            password: this._validatePassword(options.password),
            playerTtl: this._validateTtl(options.playerTtl, 0),
            emptyRoomTtl: this._validateTtl(options.emptyRoomTtl, 300000),
            autoCleanup: options.autoCleanup !== false,
            maxCachedEvents: this._validateMaxCachedEvents(options.maxCachedEvents),
            creationTime: Date.now()
        };

        return config;
    }

    /**
     * Validate max players setting
     * @private
     * @param {number} maxPlayers - Max players value
     * @returns {number} Validated max players
     */
    _validateMaxPlayers(maxPlayers) {
        const value = parseInt(maxPlayers) || 4;
        if (value < 1 || value > 500) {
            throw new Error('maxPlayers must be between 1 and 500');
        }
        return value;
    }

    /**
     * Validate custom properties
     * @private
     * @param {Object} properties - Custom properties
     * @returns {Object} Validated properties
     */
    _validateCustomProperties(properties) {
        if (!properties) return {};
        
        if (typeof properties !== 'object' || Array.isArray(properties)) {
            throw new Error('customProperties must be an object');
        }

        // Deep clone to prevent external mutations
        return JSON.parse(JSON.stringify(properties));
    }

    /**
     * Validate password setting
     * @private
     * @param {string} password - Password value
     * @returns {string|null} Validated password
     */
    _validatePassword(password) {
        if (!password) return null;
        
        if (typeof password !== 'string') {
            throw new Error('Password must be a string');
        }

        if (password.length > 50) {
            throw new Error('Password cannot exceed 50 characters');
        }

        return password;
    }

    /**
     * Validate TTL setting
     * @private
     * @param {number} ttl - TTL value
     * @param {number} defaultValue - Default TTL
     * @returns {number} Validated TTL
     */
    _validateTtl(ttl, defaultValue) {
        if (ttl === undefined || ttl === null) return defaultValue;
        
        const value = parseInt(ttl);
        if (isNaN(value) || value < 0) {
            throw new Error('TTL must be a non-negative number');
        }

        return value;
    }

    /**
     * Validate max cached events setting
     * @private
     * @param {number} maxEvents - Max cached events
     * @returns {number} Validated max events
     */
    _validateMaxCachedEvents(maxEvents) {
        const value = parseInt(maxEvents) || 100;
        if (value < 0 || value > 1000) {
            throw new Error('maxCachedEvents must be between 0 and 1000');
        }
        return value;
    }

    /**
     * Initialize room state
     * @private
     * @returns {Object} Initial room state
     */
    _initializeRoomState() {
        return {
            status: 'active',
            masterClientId: null,
            lastActivity: Date.now(),
            gameState: {},
            stats: {
                totalJoins: 0,
                totalLeaves: 0,
                eventsRaised: 0,
                maxPlayersReached: 0,
                totalDataTransferred: 0,
                averageSessionDuration: 0,
                masterClientChanges: 0
            }
        };
    }

    // Public API Properties

    /**
     * Get room name
     * @returns {string} Room name
     */
    get name() {
        return this._config.name;
    }

    /**
     * Get maximum players
     * @returns {number} Maximum players
     */
    get maxPlayers() {
        return this._config.maxPlayers;
    }

    /**
     * Get room open status
     * @returns {boolean} Is room open
     */
    get isOpen() {
        return this._config.isOpen;
    }

    /**
     * Get room visibility status
     * @returns {boolean} Is room visible
     */
    get isVisible() {
        return this._config.isVisible;
    }

    /**
     * Get custom properties (read-only copy)
     * @returns {Object} Custom properties
     */
    get customProperties() {
        return { ...this._config.customProperties };
    }

    /**
     * Get peer count
     * @returns {number} Number of peers
     */
    get peerCount() {
        return this._peers.size;
    }

    /**
     * Get master client ID
     * @returns {number|null} Master client ID
     */
    get masterClientId() {
        return this._state.masterClientId;
    }

    /**
     * Get room age in milliseconds
     * @returns {number} Room age
     */
    get age() {
        return Date.now() - this._config.creationTime;
    }

    /**
     * Get time since last activity
     * @returns {number} Time since last activity in milliseconds
     */
    get timeSinceLastActivity() {
        return Date.now() - this._state.lastActivity;
    }

    // Peer Management

    /**
     * Add peer to room
     * @param {PhotonPeer} peer - Peer to add
     * @returns {boolean} True if peer was added successfully
     */
    addPeer(peer) {
        try {
            this._validatePeerForJoin(peer);
            this._addPeerToRoom(peer);
            this._handlePeerJoinEvents(peer);
            
            logger.info('Peer joined room', {
                roomName: this.name,
                peerId: peer.peerId,
                playerName: peer.playerName,
                peerCount: this._peers.size
            });

            this.emit('peerJoined', peer, this);
            return true;

        } catch (error) {
            logger.warn('Failed to add peer to room', {
                roomName: this.name,
                peerId: peer?.peerId,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Validate peer can join room
     * @private
     * @param {PhotonPeer} peer - Peer to validate
     * @throws {Error} If peer cannot join
     */
    _validatePeerForJoin(peer) {
        if (!peer || typeof peer.peerId === 'undefined') {
            throw new Error('Invalid peer instance');
        }

        if (this._state.status !== 'active') {
            throw new Error('Room is not active');
        }

        if (!this._config.isOpen) {
            throw new Error('Room is closed to new players');
        }

        if (this._peers.has(peer.peerId)) {
            throw new Error('Peer is already in the room');
        }

        if (this.isFull()) {
            throw new Error('Room is at maximum capacity');
        }

        if (!this._validatePeerPassword(peer)) {
            throw new Error('Invalid room password');
        }
    }

    /**
     * Validate peer password
     * @private
     * @param {PhotonPeer} peer - Peer to validate
     * @returns {boolean} Password is valid
     */
    _validatePeerPassword(peer) {
        if (!this._config.password) return true;
        return peer.hasValidPassword && peer.validatePassword(this._config.password);
    }

    /**
     * Add peer to room data structures
     * @private
     * @param {PhotonPeer} peer - Peer to add
     */
    _addPeerToRoom(peer) {
        this._peers.set(peer.peerId, peer);
        peer.setRoom(this);

        // Set master client if first player
        if (this._peers.size === 1) {
            this._setMasterClient(peer.peerId);
        }

        this._updateActivity();
        this._updateJoinStats();
    }

    /**
     * Handle peer join events and notifications
     * @private
     * @param {PhotonPeer} peer - Joining peer
     */
    _handlePeerJoinEvents(peer) {
        // Send join response to joining peer
        this._sendJoinResponse(peer);

        // Send cached events to new peer
        this._sendCachedEventsToNewPeer(peer);

        // Notify other peers about the join
        this._broadcastPeerJoin(peer);
    }

    /**
     * Send join response to peer
     * @private
     * @param {PhotonPeer} peer - Target peer
     */
    _sendJoinResponse(peer) {
        try {
            peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_ROOM, PHOTON_RETURN_CODES.OK, {
                actorNr: peer.peerId,
                gameProperties: this.customProperties,
                actorProperties: this._getPlayerList(),
                playerTtl: this._config.playerTtl,
                emptyRoomTtl: this._config.emptyRoomTtl,
                masterClientId: this._state.masterClientId,
                roomName: this.name,
                maxPlayers: this.maxPlayers,
                isOpen: this.isOpen,
                isVisible: this.isVisible
            });
        } catch (error) {
            logger.error('Failed to send join response', {
                roomName: this.name,
                peerId: peer.peerId,
                error: error.message
            });
        }
    }

    /**
     * Send cached events to new peer
     * @private
     * @param {PhotonPeer} peer - Target peer
     */
    _sendCachedEventsToNewPeer(peer) {
        try {
            for (const cachedEvent of this._cachedEvents.values()) {
                peer.sendEvent(cachedEvent.eventCode, cachedEvent.parameters);
            }
        } catch (error) {
            logger.error('Failed to send cached events', {
                roomName: this.name,
                peerId: peer.peerId,
                error: error.message
            });
        }
    }

    /**
     * Broadcast peer join to other peers
     * @private
     * @param {PhotonPeer} peer - Joining peer
     */
    _broadcastPeerJoin(peer) {
        this._broadcastEvent(PHOTON_EVENTS.JOIN, {
            actorNr: peer.peerId,
            nickName: peer.playerName,
            props: peer.customProperties,
            masterClientId: this._state.masterClientId
        }, peer.peerId);
    }

    /**
     * Remove peer from room
     * @param {PhotonPeer} peer - Peer to remove
     * @returns {boolean} True if peer was removed
     */
    removePeer(peer) {
        if (!peer || !this._peers.has(peer.peerId)) {
            return false;
        }

        try {
            const sessionDuration = this._calculateSessionDuration(peer);
            this._removePeerFromRoom(peer);
            this._handlePeerLeaveEvents(peer);
            this._updateLeaveStats(sessionDuration);

            logger.info('Peer left room', {
                roomName: this.name,
                peerId: peer.peerId,
                playerName: peer.playerName,
                sessionDuration,
                peerCount: this._peers.size
            });

            this.emit('peerLeft', peer, this);
            return true;

        } catch (error) {
            logger.error('Error removing peer from room', {
                roomName: this.name,
                peerId: peer.peerId,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Calculate peer session duration
     * @private
     * @param {PhotonPeer} peer - Target peer
     * @returns {number} Session duration in milliseconds
     */
    _calculateSessionDuration(peer) {
        return peer.joinTime ? Date.now() - peer.joinTime : 0;
    }

    /**
     * Remove peer from room data structures
     * @private
     * @param {PhotonPeer} peer - Peer to remove
     */
    _removePeerFromRoom(peer) {
        this._peers.delete(peer.peerId);
        peer.setRoom(null);
        peer.setMasterClient(false);

        this._updateActivity();

        // Handle master client transition
        if (this._state.masterClientId === peer.peerId) {
            this._selectNewMasterClient();
        }
    }

    /**
     * Handle peer leave events and notifications
     * @private
     * @param {PhotonPeer} peer - Leaving peer
     */
    _handlePeerLeaveEvents(peer) {
        // Notify remaining peers about the leave
        this._broadcastEvent(PHOTON_EVENTS.LEAVE, {
            actorNr: peer.peerId,
            masterClientId: this._state.masterClientId,
            isInactive: false
        });
    }

    /**
     * Get peer by ID
     * @param {number} peerId - Peer ID
     * @returns {PhotonPeer|undefined} Peer instance
     */
    getPeer(peerId) {
        return this._peers.get(peerId);
    }

    /**
     * Get all peers
     * @returns {PhotonPeer[]} Array of all peers
     */
    getPeers() {
        return Array.from(this._peers.values());
    }

    /**
     * Get active peers
     * @returns {PhotonPeer[]} Array of connected peers
     */
    getActivePeers() {
        return this.getPeers().filter(peer => peer.isConnected());
    }

    /**
     * Get peer count
     * @returns {number} Number of peers in room
     */
    getPeerCount() {
        return this._peers.size;
    }

    // Master Client Management

    /**
     * Set master client
     * @param {number} peerId - Peer ID to set as master
     * @returns {boolean} True if master client was set
     */
    setMasterClient(peerId) {
        const peer = this._peers.get(peerId);
        if (!peer) {
            logger.warn('Cannot set master client: peer not found', {
                roomName: this.name,
                peerId
            });
            return false;
        }

        return this._setMasterClient(peerId);
    }

    /**
     * Internal master client setting
     * @private
     * @param {number} peerId - Peer ID
     * @returns {boolean} Success status
     */
    _setMasterClient(peerId) {
        try {
            // Clear previous master client
            if (this._state.masterClientId) {
                const prevMaster = this._peers.get(this._state.masterClientId);
                if (prevMaster) {
                    prevMaster.setMasterClient(false);
                }
            }

            // Set new master client
            this._state.masterClientId = peerId;
            const newMaster = this._peers.get(peerId);
            if (newMaster) {
                newMaster.setMasterClient(true);
            }

            this._state.stats.masterClientChanges++;

            // Notify all peers
            this._broadcastEvent(PHOTON_EVENTS.MASTER_CLIENT_SWITCHED, {
                newMasterClientId: peerId,
                actorNr: peerId
            });

            logger.info('Master client changed', {
                roomName: this.name,
                newMasterClientId: peerId
            });

            this.emit('masterClientChanged', peerId, this);
            return true;

        } catch (error) {
            logger.error('Failed to set master client', {
                roomName: this.name,
                peerId,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Select new master client automatically
     * @private
     * @returns {number|null} New master client ID
     */
    _selectNewMasterClient() {
        if (this._peers.size === 0) {
            this._state.masterClientId = null;
            return null;
        }

        // Select the peer with the lowest ID (most stable approach)
        const peerIds = Array.from(this._peers.keys()).sort((a, b) => a - b);
        const newMasterId = peerIds[0];
        
        this._setMasterClient(newMasterId);
        return newMasterId;
    }

    // Event Management

    /**
     * Broadcast event to all peers in room
     * @param {number} eventCode - Event code
     * @param {Object} [parameters={}] - Event parameters
     * @param {number} [excludePeerId] - Peer ID to exclude from broadcast
     * @returns {number} Number of peers that received the event
     */
    broadcastEvent(eventCode, parameters = {}, excludePeerId = null) {
        return this._broadcastEvent(eventCode, parameters, excludePeerId);
    }

    /**
     * Internal broadcast implementation
     * @private
     * @param {number} eventCode - Event code
     * @param {Object} parameters - Event parameters
     * @param {number} excludePeerId - Excluded peer ID
     * @returns {number} Number of successful sends
     */
    _broadcastEvent(eventCode, parameters, excludePeerId = null) {
        let successCount = 0;
        const errors = [];

        this._state.stats.eventsRaised++;

        for (const [peerId, peer] of this._peers) {
            if (excludePeerId && peerId === excludePeerId) continue;
            if (!peer.isConnected()) continue;

            try {
                peer.sendEvent(eventCode, parameters);
                successCount++;
            } catch (error) {
                errors.push({ peerId, error: error.message });
            }
        }

        if (errors.length > 0) {
            logger.warn('Broadcast errors', {
                roomName: this.name,
                eventCode,
                errors: errors.length,
                successful: successCount
            });
        }

        return successCount;
    }

    /**
     * Raise event from a peer
     * @param {PhotonPeer} senderPeer - Peer raising the event
     * @param {number} eventCode - Event code
     * @param {Object} [parameters={}] - Event parameters
     * @param {number[]} [targetPeers] - Target peer IDs (null for all)
     * @param {boolean} [cacheEvent=false] - Whether to cache the event
     * @returns {boolean} True if event was raised successfully
     */
    raiseEvent(senderPeer, eventCode, parameters = {}, targetPeers = null, cacheEvent = false) {
        if (!this._validateEventRaise(senderPeer, eventCode)) {
            return false;
        }

        try {
            // Cache event if requested
            if (cacheEvent) {
                this._cacheEvent(eventCode, parameters, senderPeer.peerId);
            }

            // Send event to targets
            const sentCount = this._sendEventToTargets(eventCode, parameters, targetPeers, senderPeer.peerId);
            
            this._updateActivity();
            this._state.stats.totalDataTransferred += this._estimateEventSize(parameters);

            logger.debug('Event raised', {
                roomName: this.name,
                senderPeerId: senderPeer.peerId,
                eventCode,
                targetCount: sentCount,
                cached: cacheEvent
            });

            this.emit('eventRaised', {
                senderPeer,
                eventCode,
                parameters,
                targetPeers,
                sentCount
            });

            return true;

        } catch (error) {
            logger.error('Failed to raise event', {
                roomName: this.name,
                senderPeerId: senderPeer.peerId,
                eventCode,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Validate event raise request
     * @private
     * @param {PhotonPeer} senderPeer - Sender peer
     * @param {number} eventCode - Event code
     * @returns {boolean} Is valid
     */
    _validateEventRaise(senderPeer, eventCode) {
        if (!senderPeer || !this._peers.has(senderPeer.peerId)) {
            logger.warn('Event raise rejected: peer not in room', {
                roomName: this.name,
                peerId: senderPeer?.peerId
            });
            return false;
        }

        if (typeof eventCode !== 'number') {
            logger.warn('Event raise rejected: invalid event code', {
                roomName: this.name,
                peerId: senderPeer.peerId,
                eventCode
            });
            return false;
        }

        return true;
    }

    /**
     * Cache event for new players
     * @private
     * @param {number} eventCode - Event code
     * @param {Object} parameters - Event parameters
     * @param {number} senderId - Sender peer ID
     */
    _cacheEvent(eventCode, parameters, senderId) {
        // Remove oldest cached event if at limit
        if (this._cachedEvents.size >= this._config.maxCachedEvents) {
            const firstKey = this._cachedEvents.keys().next().value;
            this._cachedEvents.delete(firstKey);
        }

        this._cachedEvents.set(`${eventCode}_${Date.now()}`, {
            eventCode,
            parameters: JSON.parse(JSON.stringify(parameters)),
            senderId,
            timestamp: Date.now()
        });
    }

    /**
     * Send event to target peers
     * @private
     * @param {number} eventCode - Event code
     * @param {Object} parameters - Event parameters
     * @param {number[]} targetPeers - Target peer IDs
     * @param {number} senderPeerId - Sender peer ID
     * @returns {number} Number of successful sends
     */
    _sendEventToTargets(eventCode, parameters, targetPeers, senderPeerId) {
        if (targetPeers && Array.isArray(targetPeers)) {
            return this._sendEventToSpecificPeers(eventCode, parameters, targetPeers);
        } else {
            return this._broadcastEvent(eventCode, parameters, senderPeerId);
        }
    }

    /**
     * Send event to specific peers
     * @private
     * @param {number} eventCode - Event code
     * @param {Object} parameters - Event parameters
     * @param {number[]} targetPeerIds - Target peer IDs
     * @returns {number} Number of successful sends
     */
    _sendEventToSpecificPeers(eventCode, parameters, targetPeerIds) {
        let successCount = 0;

        for (const peerId of targetPeerIds) {
            const peer = this._peers.get(peerId);
            if (peer && peer.isConnected()) {
                try {
                    peer.sendEvent(eventCode, parameters);
                    successCount++;
                } catch (error) {
                    logger.debug('Failed to send event to specific peer', {
                        roomName: this.name,
                        peerId,
                        eventCode,
                        error: error.message
                    });
                }
            }
        }

        return successCount;
    }

    /**
     * Estimate event size for statistics
     * @private
     * @param {Object} parameters - Event parameters
     * @returns {number} Estimated size in bytes
     */
    _estimateEventSize(parameters) {
        try {
            return JSON.stringify(parameters).length;
        } catch {
            return 100; // Default estimate
        }
    }

    // Properties Management

    /**
     * Set custom properties
     * @param {Object} properties - Properties to set
     * @param {boolean} [broadcast=true] - Whether to broadcast changes
     * @returns {boolean} True if properties were set
     */
    setCustomProperties(properties, broadcast = true) {
        if (!properties || typeof properties !== 'object') {
            logger.warn('Invalid properties provided', {
                roomName: this.name,
                properties
            });
            return false;
        }

        try {
            // Merge properties
            Object.assign(this._config.customProperties, properties);
            
            if (broadcast) {
                this._broadcastEvent(PHOTON_EVENTS.PROPERTIES_CHANGED, {
                    gameProperties: this.customProperties
                });
            }

            logger.debug('Room properties updated', {
                roomName: this.name,
                properties: Object.keys(properties)
            });

            this.emit('propertiesChanged', properties, this);
            return true;

        } catch (error) {
            logger.error('Failed to set custom properties', {
                roomName: this.name,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Get player list for protocol responses
     * @private
     * @returns {Object} Player list object
     */
    _getPlayerList() {
        const players = {};
        
        for (const [peerId, peer] of this._peers) {
            players[peerId] = {
                nickName: peer.playerName || `Player${peerId}`,
                props: peer.customProperties || {},
                userId: peer.userId || peerId.toString(),
                isMasterClient: peer.isMasterClient || false,
                isActive: peer.isConnected()
            };
        }
        
        return players;
    }

    // Room State Management

    /**
     * Check if room is empty
     * @returns {boolean} True if room has no peers
     */
    isEmpty() {
        return this._peers.size === 0;
    }

    /**
     * Check if room is full
     * @returns {boolean} True if room is at capacity
     */
    isFull() {
        return this._peers.size >= this._config.maxPlayers;
    }

    /**
     * Check if peer can join room
     * @param {PhotonPeer} peer - Peer to check
     * @returns {boolean} True if peer can join
     */
    canJoin(peer) {
        try {
            this._validatePeerForJoin(peer);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Validate password
     * @param {string} password - Password to validate
     * @returns {boolean} True if password is valid
     */
    validatePassword(password) {
        return !this._config.password || this._config.password === password;
    }

    /**
     * Set room password
     * @param {string|null} password - New password (null to remove)
     * @returns {boolean} True if password was set
     */
    setPassword(password) {
        try {
            this._config.password = this._validatePassword(password);
            
            logger.info('Room password changed', {
                roomName: this.name,
                hasPassword: !!password
            });

            this.emit('passwordChanged', !!password, this);
            return true;

        } catch (error) {
            logger.error('Failed to set room password', {
                roomName: this.name,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Close room to new players
     */
    close() {
        this._config.isOpen = false;
        this._state.status = 'closed';
        
        logger.info('Room closed', { roomName: this.name });
        this.emit('roomClosed', this);
    }

    /**
     * Open room to new players
     */
    open() {
        this._config.isOpen = true;
        this._state.status = 'active';
        
        logger.info('Room opened', { roomName: this.name });
        this.emit('roomOpened', this);
    }

    /**
     * Hide room from listings
     */
    hide() {
        this._config.isVisible = false;
        
        logger.info('Room hidden', { roomName: this.name });
        this.emit('roomHidden', this);
    }

    /**
     * Show room in listings
     */
    show() {
        this._config.isVisible = true;
        
        logger.info('Room shown', { roomName: this.name });
        this.emit('roomShown', this);
    }

    /**
     * Check if room should be cleaned up
     * @param {number} [currentTime] - Current timestamp
     * @returns {boolean} True if room should be cleaned up
     */
    shouldCleanup(currentTime = Date.now()) {
        if (!this._config.autoCleanup || !this.isEmpty()) {
            return false;
        }

        if (this._config.emptyRoomTtl <= 0) {
            return false;
        }

        return (currentTime - this._state.lastActivity) > this._config.emptyRoomTtl;
    }

    /**
     * Destroy room and clean up all resources
     * @param {string} [reason='Room destroyed'] - Destruction reason
     * @returns {Promise<void>}
     */
    async destroy(reason = 'Room destroyed') {
        if (this._state.status === 'destroyed') {
            return;
        }

        logger.info('Destroying room', { 
            roomName: this.name, 
            reason,
            peerCount: this._peers.size 
        });

        try {
            this._state.status = 'destroyed';

            // Disconnect all peers gracefully
            await this._disconnectAllPeers(reason);

            // Clear all data structures
            this._cleanup();

            logger.info('Room destroyed successfully', { roomName: this.name });
            this.emit('roomDestroyed', this, reason);

        } catch (error) {
            logger.error('Error during room destruction', {
                roomName: this.name,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Disconnect all peers from room
     * @private
     * @param {string} reason - Disconnection reason
     * @returns {Promise<void>}
     */
    async _disconnectAllPeers(reason) {
        const disconnectPromises = [];

        for (const peer of this._peers.values()) {
            disconnectPromises.push(this._disconnectPeerGracefully(peer, reason));
        }

        await Promise.allSettled(disconnectPromises);
    }

    /**
     * Disconnect single peer gracefully
     * @private
     * @param {PhotonPeer} peer - Peer to disconnect
     * @param {string} reason - Disconnection reason
     * @returns {Promise<void>}
     */
    async _disconnectPeerGracefully(peer, reason) {
        try {
            peer.leaveRoom(reason);
            // Give peer time to process the leave
            await new Promise(resolve => setTimeout(resolve, 50));
        } catch (error) {
            logger.debug('Error disconnecting peer gracefully', {
                roomName: this.name,
                peerId: peer.peerId,
                error: error.message
            });
        }
    }

    /**
     * Clean up room resources
     * @private
     */
    _cleanup() {
        this._peers.clear();
        this._cachedEvents.clear();
        this._expectedUsers.clear();
        this._state.masterClientId = null;
        this.removeAllListeners();
    }

    // Statistics and Monitoring

    /**
     * Update activity timestamp
     * @private
     */
    _updateActivity() {
        this._state.lastActivity = Date.now();
    }

    /**
     * Update join statistics
     * @private
     */
    _updateJoinStats() {
        this._state.stats.totalJoins++;
        this._state.stats.maxPlayersReached = Math.max(
            this._state.stats.maxPlayersReached,
            this._peers.size
        );
    }

    /**
     * Update leave statistics
     * @private
     * @param {number} sessionDuration - Session duration in milliseconds
     */
    _updateLeaveStats(sessionDuration) {
        this._state.stats.totalLeaves++;
        
        // Update average session duration
        const totalSessions = this._state.stats.totalLeaves;
        const currentAverage = this._state.stats.averageSessionDuration;
        this._state.stats.averageSessionDuration = 
            ((currentAverage * (totalSessions - 1)) + sessionDuration) / totalSessions;
    }

    /**
     * Get comprehensive room statistics
     * @returns {Object} Room statistics
     */
    getStats() {
        return {
            // Basic info
            name: this.name,
            status: this._state.status,
            
            // Capacity info
            playerCount: this._peers.size,
            maxPlayers: this._config.maxPlayers,
            utilizationPercentage: (this._peers.size / this._config.maxPlayers) * 100,
            
            // State info
            isOpen: this._config.isOpen,
            isVisible: this._config.isVisible,
            hasPassword: !!this._config.password,
            masterClientId: this._state.masterClientId,
            
            // Timing info
            createdAt: this._config.creationTime,
            lastActivity: this._state.lastActivity,
            age: this.age,
            timeSinceLastActivity: this.timeSinceLastActivity,
            
            // Cache info
            cachedEventsCount: this._cachedEvents.size,
            maxCachedEvents: this._config.maxCachedEvents,
            
            // Activity stats
            ...this._state.stats,
            
            // Configuration
            config: {
                playerTtl: this._config.playerTtl,
                emptyRoomTtl: this._config.emptyRoomTtl,
                autoCleanup: this._config.autoCleanup
            }
        };
    }

    /**
     * Get room health status
     * @returns {Object} Health information
     */
    getHealthStatus() {
        const stats = this.getStats();
        const health = {
            status: 'healthy',
            issues: [],
            metrics: {
                utilization: stats.utilizationPercentage,
                activity: stats.timeSinceLastActivity,
                stability: this._calculateStabilityScore()
            }
        };

        // Check for issues
        if (stats.status === 'destroyed') {
            health.status = 'destroyed';
        } else if (stats.status === 'closed') {
            health.status = 'closed';
        } else {
            // Check various health indicators
            if (stats.utilizationPercentage > 90) {
                health.issues.push('High capacity utilization');
            }

            if (stats.timeSinceLastActivity > 300000) { // 5 minutes
                health.issues.push('Long inactivity period');
                health.status = 'inactive';
            }

            if (this._state.stats.masterClientChanges > 10) {
                health.issues.push('Frequent master client changes');
            }

            if (health.issues.length > 0 && health.status === 'healthy') {
                health.status = 'warning';
            }
        }

        return health;
    }

    /**
     * Calculate room stability score
     * @private
     * @returns {number} Stability score (0-100)
     */
    _calculateStabilityScore() {
        const stats = this._state.stats;
        let score = 100;

        // Penalize frequent master client changes
        if (stats.totalJoins > 0) {
            const changeRatio = stats.masterClientChanges / stats.totalJoins;
            score -= Math.min(changeRatio * 50, 30);
        }

        // Penalize high churn rate
        if (stats.totalJoins > 0) {
            const churnRate = stats.totalLeaves / stats.totalJoins;
            if (churnRate > 0.8) {
                score -= 20;
            }
        }

        // Bonus for longevity
        const ageInHours = this.age / (1000 * 60 * 60);
        if (ageInHours > 1) {
            score += Math.min(ageInHours * 2, 10);
        }

        return Math.max(0, Math.min(100, Math.round(score)));
    }

    /**
     * Get room performance metrics
     * @returns {Object} Performance metrics
     */
    getPerformanceMetrics() {
        return {
            // Traffic metrics
            eventsPerMinute: this._calculateEventsPerMinute(),
            dataTransferRate: this._calculateDataTransferRate(),
            
            // Efficiency metrics
            averageSessionDuration: this._state.stats.averageSessionDuration,
            retentionRate: this._calculateRetentionRate(),
            
            // Resource usage
            memoryUsage: this._estimateMemoryUsage(),
            cacheEfficiency: this._calculateCacheEfficiency()
        };
    }

    /**
     * Calculate events per minute
     * @private
     * @returns {number} Events per minute
     */
    _calculateEventsPerMinute() {
        const ageInMinutes = this.age / (1000 * 60);
        return ageInMinutes > 0 ? this._state.stats.eventsRaised / ageInMinutes : 0;
    }

    /**
     * Calculate data transfer rate
     * @private
     * @returns {number} Bytes per second
     */
    _calculateDataTransferRate() {
        const ageInSeconds = this.age / 1000;
        return ageInSeconds > 0 ? this._state.stats.totalDataTransferred / ageInSeconds : 0;
    }

    /**
     * Calculate retention rate
     * @private
     * @returns {number} Retention rate percentage
     */
    _calculateRetentionRate() {
        if (this._state.stats.totalJoins === 0) return 0;
        const activeUsers = this.getActivePeers().length;
        return (activeUsers / this._state.stats.totalJoins) * 100;
    }

    /**
     * Estimate memory usage
     * @private
     * @returns {Object} Memory usage estimate
     */
    _estimateMemoryUsage() {
        const peerMemory = this._peers.size * 1024; // ~1KB per peer
        const eventMemory = this._cachedEvents.size * 512; // ~512B per cached event
        const baseMemory = 2048; // ~2KB base room overhead
        
        return {
            total: peerMemory + eventMemory + baseMemory,
            peers: peerMemory,
            cachedEvents: eventMemory,
            base: baseMemory
        };
    }

    /**
     * Calculate cache efficiency
     * @private
     * @returns {number} Cache efficiency percentage
     */
    _calculateCacheEfficiency() {
        if (this._config.maxCachedEvents === 0) return 0;
        return (this._cachedEvents.size / this._config.maxCachedEvents) * 100;
    }

    // Utility Methods

    /**
     * Export room state for debugging
     * @returns {Object} Complete room state
     */
    exportState() {
        return {
            config: this._config,
            state: this._state,
            peers: this.getPeers().map(peer => ({
                peerId: peer.peerId,
                playerName: peer.playerName,
                isConnected: peer.isConnected(),
                isMasterClient: peer.isMasterClient,
                customProperties: peer.customProperties
            })),
            cachedEvents: Array.from(this._cachedEvents.entries()),
            stats: this.getStats(),
            health: this.getHealthStatus(),
            performance: this.getPerformanceMetrics()
        };
    }

    /**
     * JSON serialization for API responses
     * @returns {Object} Serialized room data
     */
    toJSON() {
        return {
            name: this.name,
            playerCount: this._peers.size,
            maxPlayers: this._config.maxPlayers,
            isOpen: this._config.isOpen,
            isVisible: this._config.isVisible,
            hasPassword: !!this._config.password,
            customProperties: this.customProperties,
            masterClientId: this._state.masterClientId,
            players: this._getPlayerList(),
            stats: this.getStats(),
            health: this.getHealthStatus()
        };
    }

    /**
     * String representation for debugging
     * @returns {string} Room string representation
     */
    toString() {
        return `PhotonRoom[${this.name}:${this._peers.size}/${this._config.maxPlayers}:${this._state.status}]`;
    }

    /**
     * Create room snapshot for monitoring
     * @returns {Object} Room snapshot
     */
    createSnapshot() {
        return {
            timestamp: Date.now(),
            name: this.name,
            status: this._state.status,
            playerCount: this._peers.size,
            maxPlayers: this._config.maxPlayers,
            isOpen: this._config.isOpen,
            isVisible: this._config.isVisible,
            masterClientId: this._state.masterClientId,
            lastActivity: this._state.lastActivity,
            stats: { ...this._state.stats },
            activePeers: this.getActivePeers().length,
            cachedEvents: this._cachedEvents.size
        };
    }

    /**
     * Validate room integrity
     * @returns {Object} Validation result
     */
    validateIntegrity() {
        const issues = [];
        const warnings = [];

        // Check peer consistency
        for (const [peerId, peer] of this._peers) {
            if (peer.room !== this) {
                issues.push(`Peer ${peerId} has inconsistent room reference`);
            }
        }

        // Check master client consistency
        if (this._state.masterClientId) {
            const masterPeer = this._peers.get(this._state.masterClientId);
            if (!masterPeer) {
                issues.push('Master client ID references non-existent peer');
            } else if (!masterPeer.isMasterClient) {
                issues.push('Master client peer not marked as master');
            }
        }

        // Check for orphaned master clients
        let masterCount = 0;
        for (const peer of this._peers.values()) {
            if (peer.isMasterClient) {
                masterCount++;
            }
        }

        if (masterCount > 1) {
            issues.push('Multiple peers marked as master client');
        } else if (masterCount === 0 && this._peers.size > 0) {
            warnings.push('No master client assigned with peers present');
        }

        // Check capacity consistency
        if (this._peers.size > this._config.maxPlayers) {
            issues.push('Peer count exceeds maximum capacity');
        }

        return {
            isValid: issues.length === 0,
            issues,
            warnings,
            checkedAt: Date.now()
        };
    }

    /**
     * Repair room integrity issues
     * @returns {Object} Repair result
     */
    repairIntegrity() {
        const validation = this.validateIntegrity();
        const repairs = [];

        if (validation.isValid) {
            return { repairs, success: true };
        }

        try {
            // Fix master client issues
            if (this._peers.size > 0 && !this._state.masterClientId) {
                const newMaster = this._selectNewMasterClient();
                repairs.push(`Assigned new master client: ${newMaster}`);
            }

            // Clear invalid master client
            if (this._state.masterClientId && !this._peers.has(this._state.masterClientId)) {
                this._state.masterClientId = null;
                const newMaster = this._selectNewMasterClient();
                repairs.push(`Cleared invalid master client, assigned new: ${newMaster}`);
            }

            // Fix peer room references
            for (const peer of this._peers.values()) {
                if (peer.room !== this) {
                    peer.setRoom(this);
                    repairs.push(`Fixed room reference for peer ${peer.peerId}`);
                }
            }

            logger.info('Room integrity repaired', {
                roomName: this.name,
                repairs: repairs.length
            });

            return { repairs, success: true };

        } catch (error) {
            logger.error('Failed to repair room integrity', {
                roomName: this.name,
                error: error.message
            });
            return { repairs, success: false, error: error.message };
        }
    }
}

module.exports = PhotonRoom;