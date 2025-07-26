const { PHOTON_OPERATIONS, PHOTON_RETURN_CODES } = require('../protocol/constants');
const PhotonRoom = require('../core/PhotonRoom');

class OperationHandler {
    constructor(server) {
        this.server = server;
    }

    handleOperation(peer, operation) {
        if (!operation || typeof operation !== 'object') {
            console.warn(`Invalid operation received from peer ${peer.peerId}`);
            return;
        }
        
        const opCode = operation.OperationCode || operation.Code;
        const parameters = operation.Parameters || {};
        
        console.log(`Operation ${opCode} from peer ${peer.peerId}:`, Object.keys(parameters));
        
        try {
            switch (opCode) {
                case PHOTON_OPERATIONS.AUTHENTICATE:
                    this.handleAuthentication(peer, parameters);
                    break;
                    
                case PHOTON_OPERATIONS.JOIN_ROOM:
                    this.handleJoinRoom(peer, parameters);
                    break;
                    
                case PHOTON_OPERATIONS.LEAVE_ROOM:
                    this.handleLeaveRoom(peer, parameters);
                    break;
                    
                case PHOTON_OPERATIONS.CHANGE_PROPERTIES:
                    this.handleChangeProperties(peer, parameters);
                    break;
                    
                case PHOTON_OPERATIONS.GET_ROOMS:
                    this.handleGetRooms(peer, parameters);
                    break;
                    
                case PHOTON_OPERATIONS.RAISE_EVENT:
                    this.handleRaiseEvent(peer, parameters);
                    break;
                    
                case PHOTON_OPERATIONS.CREATE_ROOM:
                    this.handleCreateRoom(peer, parameters);
                    break;
                    
                case PHOTON_OPERATIONS.JOIN_RANDOM_ROOM:
                    this.handleJoinRandomRoom(peer, parameters);
                    break;
                    
                case PHOTON_OPERATIONS.GET_ROOM_LIST:
                    this.handleGetRoomList(peer, parameters);
                    break;
                    
                default:
                    console.warn(`Unknown operation ${opCode} from peer ${peer.peerId}`);
                    peer.sendOperationResponse(opCode, PHOTON_RETURN_CODES.OPERATION_INVALID, {
                        DebugMessage: `Unknown operation: ${opCode}`
                    });
            }
        } catch (error) {
            console.error(`Error handling operation ${opCode} from peer ${peer.peerId}:`, error);
            peer.sendOperationResponse(opCode, PHOTON_RETURN_CODES.PLUGIN_REPORTED_ERROR, {
                DebugMessage: `Server error: ${error.message}`
            });
        }
    }

    handleAuthentication(peer, parameters) {
        const nickname = parameters.nickName || parameters.NickName || `Player${peer.peerId}`;
        const userId = parameters.userId || parameters.UserId || peer.peerId.toString();
        const authData = parameters.authData || parameters.AuthData;
        
        // Simple authentication - in production, you'd validate credentials
        const success = this.validateAuthentication(userId, authData);
        
        if (success) {
            peer.authenticate(nickname, userId, authData);
            console.log(`Peer ${peer.peerId} authenticated as ${nickname}`);
        } else {
            peer.sendOperationResponse(PHOTON_OPERATIONS.AUTHENTICATE, PHOTON_RETURN_CODES.OPERATION_INVALID, {
                DebugMessage: 'Authentication failed'
            });
        }
    }

    handleJoinRoom(peer, parameters) {
        if (!peer.isConnected()) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_ROOM, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                DebugMessage: 'Not authenticated'
            });
            return;
        }

        const roomName = parameters.RoomName || parameters.GameId || 'DefaultRoom';
        const password = parameters.password || parameters.Password;
        
        let room = this.server.getRoom(roomName);
        
        if (!room) {
            // Create room if it doesn't exist
            const roomOptions = {
                maxPlayers: parameters.MaxPlayers || 4,
                isOpen: parameters.IsOpen !== false,
                isVisible: parameters.IsVisible !== false,
                customProperties: parameters.GameProperties || {},
                password: password
            };
            
            room = this.server.createRoom(roomName, roomOptions);
        }

        // Validate password if required
        if (!room.validatePassword(password)) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_ROOM, PHOTON_RETURN_CODES.JOIN_FAILED_DENIED, {
                DebugMessage: 'Invalid room password'
            });
            return;
        }

        // Attempt to join
        if (room.addPeer(peer)) {
            console.log(`Peer ${peer.peerId} joined room ${roomName}`);
        } else {
            let errorCode = PHOTON_RETURN_CODES.ROOM_FULL;
            let message = 'Room is full';
            
            if (!room.isOpen) {
                errorCode = PHOTON_RETURN_CODES.ROOM_CLOSED;
                message = 'Room is closed';
            }
            
            peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_ROOM, errorCode, {
                DebugMessage: message
            });
        }
    }

    handleLeaveRoom(peer, parameters) {
        if (!peer.room) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.LEAVE_ROOM, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                DebugMessage: 'Not in a room'
            });
            return;
        }

        const roomName = peer.room.name;
        peer.leaveRoom();
        
        // Remove empty room
        if (peer.room && peer.room.isEmpty()) {
            this.server.removeRoom(roomName);
        }

        peer.sendOperationResponse(PHOTON_OPERATIONS.LEAVE_ROOM, PHOTON_RETURN_CODES.OK);
        console.log(`Peer ${peer.peerId} left room ${roomName}`);
    }

    handleChangeProperties(peer, parameters) {
        const actorProperties = parameters.actorProperties || parameters.ActorProperties;
        const gameProperties = parameters.gameProperties || parameters.GameProperties;
        const broadcast = parameters.broadcast !== false;

        if (actorProperties) {
            peer.setCustomProperties(actorProperties, broadcast);
        }

        if (gameProperties && peer.room && peer.isMasterClient) {
            peer.room.setCustomProperties(gameProperties, broadcast);
        }

        peer.sendOperationResponse(PHOTON_OPERATIONS.CHANGE_PROPERTIES, PHOTON_RETURN_CODES.OK);
    }

    handleGetRooms(peer, parameters) {
        const rooms = this.server.getVisibleRooms();
        const roomList = rooms.map(room => ({
            name: room.name,
            playerCount: room.peers.size,
            maxPlayers: room.maxPlayers,
            isOpen: room.isOpen,
            customProperties: room.customProperties
        }));

        peer.sendOperationResponse(PHOTON_OPERATIONS.GET_ROOMS, PHOTON_RETURN_CODES.OK, {
            roomList: roomList
        });
    }

    handleRaiseEvent(peer, parameters) {
        if (!peer.room) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.RAISE_EVENT, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                DebugMessage: 'Not in a room'
            });
            return;
        }

        const eventCode = parameters.Code || parameters.EventCode;
        const eventData = parameters.Data || parameters.EventData || {};
        const targetPeers = parameters.TargetActors || parameters.targetActors;
        const cacheEvent = parameters.CacheEvent || false;

        if (peer.room.raiseEvent(peer, eventCode, eventData, targetPeers, cacheEvent)) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.RAISE_EVENT, PHOTON_RETURN_CODES.OK);
        } else {
            peer.sendOperationResponse(PHOTON_OPERATIONS.RAISE_EVENT, PHOTON_RETURN_CODES.OPERATION_INVALID, {
                DebugMessage: 'Failed to raise event'
            });
        }
    }

    handleCreateRoom(peer, parameters) {
        if (!peer.isConnected()) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.CREATE_ROOM, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                DebugMessage: 'Not authenticated'
            });
            return;
        }

        const roomName = parameters.RoomName || parameters.GameId || `Room_${Date.now()}`;
        
        if (this.server.getRoom(roomName)) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.CREATE_ROOM, PHOTON_RETURN_CODES.ROOM_NOT_FOUND, {
                DebugMessage: 'Room already exists'
            });
            return;
        }

        const roomOptions = {
            maxPlayers: parameters.MaxPlayers || 4,
            isOpen: parameters.IsOpen !== false,
            isVisible: parameters.IsVisible !== false,
            customProperties: parameters.GameProperties || {},
            password: parameters.password || parameters.Password
        };

        const room = this.server.createRoom(roomName, roomOptions);
        
        if (room.addPeer(peer)) {
            console.log(`Peer ${peer.peerId} created and joined room ${roomName}`);
        } else {
            peer.sendOperationResponse(PHOTON_OPERATIONS.CREATE_ROOM, PHOTON_RETURN_CODES.PLUGIN_REPORTED_ERROR, {
                DebugMessage: 'Failed to join created room'
            });
        }
    }

    handleJoinRandomRoom(peer, parameters) {
        if (!peer.isConnected()) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_RANDOM_ROOM, PHOTON_RETURN_CODES.OPERATION_NOT_ALLOWED_IN_CURRENT_STATE, {
                DebugMessage: 'Not authenticated'
            });
            return;
        }

        const maxPlayers = parameters.MaxPlayers;
        const customProperties = parameters.GameProperties || {};
        
        const availableRooms = this.server.getVisibleRooms().filter(room => {
            return room.isOpen && 
                   !room.isFull() && 
                   (!maxPlayers || room.maxPlayers <= maxPlayers) &&
                   this.matchesProperties(room.customProperties, customProperties);
        });

        if (availableRooms.length === 0) {
            peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_RANDOM_ROOM, PHOTON_RETURN_CODES.ROOM_NOT_FOUND, {
                DebugMessage: 'No matching rooms available'
            });
            return;
        }

        // Select random room
        const room = availableRooms[Math.floor(Math.random() * availableRooms.length)];
        
        if (room.addPeer(peer)) {
            console.log(`Peer ${peer.peerId} joined random room ${room.name}`);
        } else {
            peer.sendOperationResponse(PHOTON_OPERATIONS.JOIN_RANDOM_ROOM, PHOTON_RETURN_CODES.ROOM_FULL, {
                DebugMessage: 'Selected room became full'
            });
        }
    }

    handleGetRoomList(peer, parameters) {
        this.handleGetRooms(peer, parameters);
    }

    // Utility methods
    validateAuthentication(userId, authData) {
        // Implement your authentication logic here
        // For now, accept all authentication attempts
        return true;
    }

    matchesProperties(roomProperties, filterProperties) {
        for (const [key, value] of Object.entries(filterProperties)) {
            if (roomProperties[key] !== value) {
                return false;
            }
        }
        return true;
    }
}

module.exports = OperationHandler;