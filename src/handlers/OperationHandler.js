const { PHOTON_OPERATIONS, PHOTON_RETURN_CODES } = require('../protocol/constants');
const PhotonRoom = require('../core/PhotonRoom');
const logger = require('../utils/logger');

/**
 * Handles all Photon operations from connected peers
 * Provides secure, validated processing of client requests
 */
class OperationHandler {
    /**
     * @param {PhotonServer} server - The Photon server instance
     */
    constructor(server) {
        if (!server) {
            throw new Error('Server instance is required');
        }
        this.server = server;
        this._operationHandlers = this._initializeHandlers();
    }

    /**
     * Initialize operation handler mappings
     * @private
     * @returns {Map<number, Function>} Handler mappings
     */
    _initializeHandlers() {
        return new Map([
            [PHOTON_OPERATIONS.AUTHENTICATE, this._handleAuthentication.bind(this)],
            [PHOTON_OPERATIONS.JOIN_ROOM, this._handleJoinRoom.bind(this)],
            [PHOTON_OPERATIONS.LEAVE_ROOM, this._handleLeaveRoom.bind(this)],
            [PHOTON_OPERATIONS.CHANGE_PROPERTIES, this._handleChangeProperties.bind(this)],
            [PHOTON_OPERATIONS.GET_ROOMS, this._handleGetRooms.bind(this)],
            [PHOTON_OPERATIONS.RAISE_EVENT, this._handleRaiseEvent.bind(this)],
            [PHOTON_OPERATIONS.CREATE_ROOM, this._handleCreateRoom.bind(this)],
            [PHOTON_OPERATIONS.JOIN_RANDOM_ROOM, this._handleJoinRandomRoom.bind(this)],
            [PHOTON_OPERATIONS.GET_ROOM_LIST, this._handleGetRoomList.bind(this)]
        ]);
    }

    /**
     * Process incoming operation from peer
     * @param {PhotonPeer} peer - The peer sending the operation
     * @param {Object} operation - The operation data
     */
    async handleOperation(peer, operation) {
        try {
            this._validateOperation(operation);
            this._validatePeer(peer);

            const opCode = operation.OperationCode || operation.Code;
            const parameters = operation.Parameters || {};

            logger.debug(`Processing operation ${opCode} from peer ${peer.peerId}`, {
                peerId: peer.peerId,
                opCode,
                parameterKeys: Object.keys(parameters)
            });

            const handler = this._operationHandlers.get(opCode);
            if (!handler) {
                this._handleUnknownOperation(peer, opCode);
                return;
            }

            await handler(peer, parameters);

        } catch (error) {
            this._handleOperationError(peer, operation, error);
        }
    }

    /**
     * Validate operation structure
     * @private
     * @param {Object} operation - Operation to validate
     * @throws {Error} If operation is invalid
     */
    _validateOperation(operation) {
        if (!operation || typeof operation !== 'object') {
            throw new Error('Invalid operation structure');
        }

        const opCode = operation.OperationCode || operation.Code;
        if (typeof opCode !== 'number') {
            throw new Error('Operation code must be a number');
        }
    }

    /**
     * Validate peer instance
     * @private
     * @param {PhotonPeer} peer - Peer to validate
     * @throws {Error} If peer is invalid
     */
    _validatePeer(peer) {
        if (!peer || typeof peer.peerId === 'undefined') {
            throw new Error('Invalid peer instance');
        }
    }

    /**
     * Handle unknown operation codes
     * @private
     * @param {PhotonPeer} peer - The peer that sent the operation
     * @param {number} opCode - The unknown operation code
     */
    _handleUnknownOperation(peer, opCode) {
        logger.warn(`Unknown operation ${opCode} from peer ${peer.peerId}`);
        
        peer.sendOperationResponse(opCode, PHOTON_RETURN_CODES.OPERATION_INVALID, {
            DebugMessage: `Unsupported operation: ${opCode}`
        });
    }

    /**
     * Handle operation processing errors
     * @private
     * @param {PhotonPeer} peer - The peer that sent the operation
     * @param {Object} operation - The operation that failed
     * @param {Error} error - The error that occurred
     */
    _handleOperationError(peer, operation, error) {
        const opCode = operation?.OperationCode || operation?.Code || 'unknown';
        
        logger.error(`Error processing operation ${opCode} from peer ${peer?.peerId}`, {
            peerId: peer?.peerId,
            opCode,
            error: error.message,
            stack: error.stack
        });

        if (peer && typeof peer.sendOperationResponse === 'function') {
            peer.sendOperationResponse(opCode, PHOTON_RETURN_CODES.PLUGIN_REPORTED_ERROR, {
                DebugMessage: 'Internal server error occurred'
            });
        }
    }

    /**
     * Handle peer authentication
     * @private
     * @param {PhotonPeer} peer - The authenticating peer
     * @param {Object} parameters - Authentication parameters
     */
    async _handleAuthentication(peer, parameters) {
        const { nickname, userId, authData } = this._extractAuthParams(parameters);

        try {
            const isValid = await this._validateAuthentication(userId, authData);
            
            if (!isValid) {
                peer.sendOperationResponse(PHOTON_OPERATIONS.AUTHENTICATE, PHOTON_RETURN_CODES.OPERATION_INVALID, {
                    DebugMessage: 'Authentication credentials invalid'
                });
                return;
            }

            peer.authenticate(nickname, userId, authData);
            
            logger.info(`Peer authenticated successfully`, {
                peerId: peer.peerId,
                nickname,
                userId
            });

            peer.sendOperationResponse(PHOTON_OPERATIONS.AUTHENTICATE, PHOTON_RETURN_CODES.OK, {
                nickname,
                userId
            });

        } catch (error) {
            logger.error('Authentication error', { peerId: peer.peerId, error: error.message });
            throw error;
        }
    }

    /**
     * Extract authentication parameters with defaults
     * @private
     * @param {Object} parameters - Raw parameters
     * @returns {Object} Normalized auth parameters
     */
    _extractAuthParams(parameters) {
        return {
            nickname: parameters.nickName || parameters.NickName || `Guest_${Date.now()}`,
            userId: parameters.userId || parameters.UserId || `user_${Date.now()}`,
            authData: parameters.authData || parameters.AuthData
        };
    }

    /**
     * Handle room joining requests
     * @private
     * @param {PhotonPeer} peer - The peer requesting to join
     * @param {Object} parameters - Join parameters
     */
    async _handleJoinRoom(peer, parameters) {
        if (!peer.isAuthenticated()) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_ROOM, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                DebugMessage: 'Authentication required before joining rooms'
            });
            return;
        }

        const roomName = parameters.RoomName || parameters.GameId;
        if (!roomName) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_ROOM, PHOTON_RETURN_CODES.OPERATION_INVALID, {
                DebugMessage: 'Room name is required'
            });
            return;
        }

        const joinResult = await this._processRoomJoin(peer, roomName, parameters);
        this._sendJoinResponse(peer, joinResult);
    }

    /**
     * Process room join logic
     * @private
     * @param {PhotonPeer} peer - The joining peer
     * @param {string} roomName - Name of room to join
     * @param {Object} parameters - Join parameters
     * @returns {Object} Join result
     */
    async _processRoomJoin(peer, roomName, parameters) {
        try {
            let room = this.server.getRoom(roomName);
            
            if (!room) {
                room = await this._createRoomForJoin(roomName, parameters);
            }

            if (!this._validateRoomAccess(room, parameters.password || parameters.Password)) {
                return {
                    success: false,
                    code: PHOTON_RETURN_CODES.JOIN_FAILED_DENIED,
                    message: 'Invalid room credentials'
                };
            }

            const joinSuccessful = room.addPeer(peer);
            if (!joinSuccessful) {
                return {
                    success: false,
                    code: room.isOpen ? PHOTON_RETURN_CODES.ROOM_FULL : PHOTON_RETURN_CODES.ROOM_CLOSED,
                    message: room.isOpen ? 'Room is at capacity' : 'Room is closed to new players'
                };
            }

            logger.info(`Peer joined room successfully`, {
                peerId: peer.peerId,
                roomName,
                playerCount: room.peers.size
            });

            return {
                success: true,
                code: PHOTON_RETURN_CODES.OK,
                room
            };

        } catch (error) {
            logger.error('Room join error', { peerId: peer.peerId, roomName, error: error.message });
            return {
                success: false,
                code: PHOTON_RETURN_CODES.PLUGIN_REPORTED_ERROR,
                message: 'Unable to process room join request'
            };
        }
    }

    /**
     * Create room for join operation
     * @private
     * @param {string} roomName - Room name
     * @param {Object} parameters - Room parameters
     * @returns {PhotonRoom} Created room
     */
    async _createRoomForJoin(roomName, parameters) {
        const roomOptions = {
            maxPlayers: Math.max(1, Math.min(parameters.MaxPlayers || 4, 100)),
            isOpen: parameters.IsOpen !== false,
            isVisible: parameters.IsVisible !== false,
            customProperties: parameters.GameProperties || {},
            password: parameters.password || parameters.Password
        };

        return this.server.createRoom(roomName, roomOptions);
    }

    /**
     * Validate room access permissions
     * @private
     * @param {PhotonRoom} room - Room to validate
     * @param {string} password - Provided password
     * @returns {boolean} Access granted
     */
    _validateRoomAccess(room, password) {
        return room.validatePassword(password);
    }

    /**
     * Send join response to peer
     * @private
     * @param {PhotonPeer} peer - Target peer
     * @param {Object} result - Join result
     */
    _sendJoinResponse(peer, result) {
        peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_ROOM, result.code, {
            DebugMessage: result.message || (result.success ? 'Successfully joined room' : 'Failed to join room')
        });
    }

    /**
     * Handle room leaving requests
     * @private
     * @param {PhotonPeer} peer - The peer leaving
     * @param {Object} parameters - Leave parameters
     */
    async _handleLeaveRoom(peer, parameters) {
        if (!peer.room) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.LEAVE_ROOM, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                DebugMessage: 'Not currently in a room'
            });
            return;
        }

        const roomName = peer.room.name;
        const wasEmpty = peer.leaveRoom();

        if (wasEmpty) {
            this.server.removeRoom(roomName);
            logger.info(`Empty room removed`, { roomName });
        }

        peer.sendOperationResponse(PHOTON_OPERATIONS.LEAVE_ROOM, PHOTON_RETURN_CODES.OK);
        
        logger.info(`Peer left room`, {
            peerId: peer.peerId,
            roomName
        });
    }

    /**
     * Handle property change requests
     * @private
     * @param {PhotonPeer} peer - The requesting peer
     * @param {Object} parameters - Property parameters
     */
    async _handleChangeProperties(peer, parameters) {
        const actorProperties = parameters.actorProperties || parameters.ActorProperties;
        const gameProperties = parameters.gameProperties || parameters.GameProperties;
        const broadcast = parameters.broadcast !== false;

        try {
            if (actorProperties && Object.keys(actorProperties).length > 0) {
                peer.setCustomProperties(actorProperties, broadcast);
            }

            if (gameProperties && Object.keys(gameProperties).length > 0) {
                if (!peer.room) {
                    peer.sendOperationResponse(PHOTON_OPERATIONS.CHANGE_PROPERTIES, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                        DebugMessage: 'Must be in a room to change game properties'
                    });
                    return;
                }

                if (!peer.isMasterClient) {
                    peer.sendOperationResponse(PHOTON_OPERATIONS.CHANGE_PROPERTIES, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                        DebugMessage: 'Only master client can change game properties'
                    });
                    return;
                }

                peer.room.setCustomProperties(gameProperties, broadcast);
            }

            peer.sendOperationResponse(PHOTON_OPERATIONS.CHANGE_PROPERTIES, PHOTON_RETURN_CODES.OK);

        } catch (error) {
            logger.error('Property change error', { peerId: peer.peerId, error: error.message });
            throw error;
        }
    }

    /**
     * Handle room list requests
     * @private
     * @param {PhotonPeer} peer - The requesting peer
     * @param {Object} parameters - Request parameters
     */
    async _handleGetRooms(peer, parameters) {
        try {
            const rooms = this.server.getVisibleRooms();
            const roomList = rooms.map(room => this._serializeRoomInfo(room));

            peer.sendOperationResponse(PHOTON_OPERATIONS.GET_ROOMS, PHOTON_RETURN_CODES.OK, {
                roomList
            });

            logger.debug(`Room list sent to peer`, {
                peerId: peer.peerId,
                roomCount: roomList.length
            });

        } catch (error) {
            logger.error('Get rooms error', { peerId: peer.peerId, error: error.message });
            throw error;
        }
    }

    /**
     * Serialize room information for client
     * @private
     * @param {PhotonRoom} room - Room to serialize
     * @returns {Object} Serialized room data
     */
    _serializeRoomInfo(room) {
        return {
            name: room.name,
            playerCount: room.peers.size,
            maxPlayers: room.maxPlayers,
            isOpen: room.isOpen,
            isVisible: room.isVisible,
            customProperties: { ...room.customProperties }
        };
    }

    /**
     * Handle event raising requests
     * @private
     * @param {PhotonPeer} peer - The peer raising the event
     * @param {Object} parameters - Event parameters
     */
    async _handleRaiseEvent(peer, parameters) {
        if (!peer.room) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.RAISE_EVENT, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                DebugMessage: 'Must be in a room to raise events'
            });
            return;
        }

        const eventCode = parameters.Code || parameters.EventCode;
        if (typeof eventCode !== 'number') {
            peer.sendOperationResponse(PHOTON_OPERATIONS.RAISE_EVENT, PHOTON_RETURN_CODES.OPERATION_INVALID, {
                DebugMessage: 'Event code must be a number'
            });
            return;
        }

        try {
            const eventData = parameters.Data || parameters.EventData || {};
            const targetPeers = parameters.TargetActors || parameters.targetActors;
            const cacheEvent = Boolean(parameters.CacheEvent);

            const success = peer.room.raiseEvent(peer, eventCode, eventData, targetPeers, cacheEvent);
            
            if (success) {
                peer.sendOperationResponse(PHOTON_OPERATIONS.RAISE_EVENT, PHOTON_RETURN_CODES.OK);
                logger.debug(`Event raised successfully`, {
                    peerId: peer.peerId,
                    eventCode,
                    roomName: peer.room.name
                });
            } else {
                peer.sendOperationResponse(PHOTON_OPERATIONS.RAISE_EVENT, PHOTON_RETURN_CODES.OPERATION_INVALID, {
                    DebugMessage: 'Event could not be processed'
                });
            }

        } catch (error) {
            logger.error('Raise event error', { peerId: peer.peerId, eventCode, error: error.message });
            throw error;
        }
    }

    /**
     * Handle room creation requests
     * @private
     * @param {PhotonPeer} peer - The peer creating the room
     * @param {Object} parameters - Creation parameters
     */
    async _handleCreateRoom(peer, parameters) {
        if (!peer.isAuthenticated()) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.CREATE_ROOM, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                DebugMessage: 'Authentication required before creating rooms'
            });
            return;
        }

        const roomName = parameters.RoomName || parameters.GameId || `Room_${Date.now()}_${peer.peerId}`;
        
        if (this.server.getRoom(roomName)) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.CREATE_ROOM, PHOTON_RETURN_CODES.ROOM_NOT_FOUND, {
                DebugMessage: 'Room name already exists'
            });
            return;
        }

        try {
            const roomOptions = this._buildRoomOptions(parameters);
            const room = this.server.createRoom(roomName, roomOptions);
            
            const joinSuccessful = room.addPeer(peer);
            if (!joinSuccessful) {
                this.server.removeRoom(roomName);
                peer.sendOperationResponse(PHOTON_OPERATIONS.CREATE_ROOM, PHOTON_RETURN_CODES.PLUGIN_REPORTED_ERROR, {
                    DebugMessage: 'Failed to join newly created room'
                });
                return;
            }

            peer.sendOperationResponse(PHOTON_OPERATIONS.CREATE_ROOM, PHOTON_RETURN_CODES.OK);
            
            logger.info(`Room created and joined`, {
                peerId: peer.peerId,
                roomName,
                maxPlayers: room.maxPlayers
            });

        } catch (error) {
            logger.error('Create room error', { peerId: peer.peerId, roomName, error: error.message });
            throw error;
        }
    }

    /**
     * Build room options from parameters
     * @private
     * @param {Object} parameters - Creation parameters
     * @returns {Object} Room options
     */
    _buildRoomOptions(parameters) {
        return {
            maxPlayers: Math.max(1, Math.min(parameters.MaxPlayers || 4, 100)),
            isOpen: parameters.IsOpen !== false,
            isVisible: parameters.IsVisible !== false,
            customProperties: parameters.GameProperties || {},
            password: parameters.password || parameters.Password
        };
    }

    /**
     * Handle random room join requests
     * @private
     * @param {PhotonPeer} peer - The peer requesting random join
     * @param {Object} parameters - Join parameters
     */
    async _handleJoinRandomRoom(peer, parameters) {
        if (!peer.isAuthenticated()) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_RANDOM_ROOM, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                DebugMessage: 'Authentication required before joining rooms'
            });
            return;
        }

        try {
            const availableRooms = this._findMatchingRooms(parameters);
            
            if (availableRooms.length === 0) {
                peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_RANDOM_ROOM, PHOTON_RETURN_CODES.ROOM_NOT_FOUND, {
                    DebugMessage: 'No suitable rooms available'
                });
                return;
            }

            const selectedRoom = this._selectRandomRoom(availableRooms);
            const joinSuccessful = selectedRoom.addPeer(peer);
            
            if (joinSuccessful) {
                peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_RANDOM_ROOM, PHOTON_RETURN_CODES.OK);
                logger.info(`Peer joined random room`, {
                    peerId: peer.peerId,
                    roomName: selectedRoom.name
                });
            } else {
                peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_RANDOM_ROOM, PHOTON_RETURN_CODES.ROOM_FULL, {
                    DebugMessage: 'Selected room became unavailable'
                });
            }

        } catch (error) {
            logger.error('Join random room error', { peerId: peer.peerId, error: error.message });
            throw error;
        }
    }

    /**
     * Find rooms matching join criteria
     * @private
     * @param {Object} parameters - Filter parameters
     * @returns {PhotonRoom[]} Matching rooms
     */
    _findMatchingRooms(parameters) {
        const maxPlayers = parameters.MaxPlayers;
        const customProperties = parameters.GameProperties || {};
        
        return this.server.getVisibleRooms().filter(room => {
            return room.isOpen && 
                   !room.isFull() && 
                   (!maxPlayers || room.maxPlayers <= maxPlayers) &&
                   this._matchesCustomProperties(room.customProperties, customProperties);
        });
    }

    /**
     * Select random room from available options
     * @private
     * @param {PhotonRoom[]} rooms - Available rooms
     * @returns {PhotonRoom} Selected room
     */
    _selectRandomRoom(rooms) {
        const randomIndex = Math.floor(Math.random() * rooms.length);
        return rooms[randomIndex];
    }

    /**
     * Handle room list requests (alias for getrooms)
     * @private
     * @param {PhotonPeer} peer - The requesting peer
     * @param {Object} parameters - Request parameters
     */
    async _handleGetRoomList(peer, parameters) {
        return this._handleGetRooms(peer, parameters);
    }

    /**
     * Validate authentication credentials
     * @private
     * @param {string} userId - User identifier
     * @param {*} authData - Authentication data
     * @returns {Promise<boolean>} Authentication result
     */
    async _validateAuthentication(userId, authData) {
        // TODO: Implement proper authentication logic
        // This should validate against your authentication system
        
        // Basic validation
        if (!userId || typeof userId !== 'string' || userId.length === 0) {
            return false;
        }

        // Additional validation can be added here
        return true;
    }

    /**
     * Check if room properties match filter criteria
     * @private
     * @param {Object} roomProperties - Room's custom properties
     * @param {Object} filterProperties - Required properties
     * @returns {boolean} Properties match
     */
    _matchesCustomProperties(roomProperties, filterProperties) {
        return Object.entries(filterProperties).every(([key, value]) => 
            roomProperties[key] === value
        );
    }
}

module.exports = OperationHandler;