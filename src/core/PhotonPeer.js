const PhotonSerializer = require('../protocol/PhotonSerializer');
const { PHOTON_COMMANDS, PHOTON_PEER_STATE, PHOTON_SIGNATURE } = require('../protocol/constants');

class PhotonPeer {
    constructor(socket, peerId) {
        this.socket = socket;
        this.peerId = peerId;
        this.state = PHOTON_PEER_STATE.CONNECTING;
        this.reliableSequenceNumber = 0;
        this.unreliableSequenceNumber = 0;
        this.sentReliableCommands = new Map();
        this.room = null;
        this.playerName = '';
        this.customProperties = {};
        this.lastPingTime = Date.now();
        this.isActive = true;
        this.userId = '';
        this.isMasterClient = false;
        
        // Connection info
        this.connectedAt = Date.now();
        this.lastActivity = Date.now();
        
        // Statistics
        this.stats = {
            messagesSent: 0,
            messagesReceived: 0,
            bytesReceived: 0,
            bytesSent: 0
        };
    }

    updateActivity() {
        this.lastActivity = Date.now();
    }

    sendCommand(commandType, data = null, channelId = 0, flags = 0) {
        if (!this.socket || this.socket.destroyed) {
            return false;
        }

        const serializer = new PhotonSerializer();
        let sequenceNumber = null;
        
        if (commandType === PHOTON_COMMANDS.SEND_RELIABLE) {
            sequenceNumber = this.reliableSequenceNumber++;
        } else if (commandType === PHOTON_COMMANDS.SEND_UNRELIABLE) {
            sequenceNumber = this.unreliableSequenceNumber++;
        }
        
        serializer.writeCommand(
            commandType, 
            channelId, 
            flags, 
            Date.now() & 0xFFFFFFFF, 
            sequenceNumber, 
            data
        );

        const buffer = serializer.getBuffer();
        const packet = PhotonSerializer.createPacket(this.peerId, buffer);
        
        try {
            this.socket.write(packet);
            this.stats.messagesSent++;
            this.stats.bytesSent += packet.length;
            return true;
        } catch (error) {
            console.error(`Failed to send command to peer ${this.peerId}:`, error);
            return false;
        }
    }

    sendOperationResponse(opCode, returnCode = 0, parameters = {}, debugMessage = '') {
        const response = {
            OperationCode: opCode,
            ReturnCode: returnCode,
            Parameters: parameters
        };
        
        if (debugMessage) {
            response.DebugMessage = debugMessage;
        }
        
        return this.sendCommand(PHOTON_COMMANDS.SEND_RELIABLE, response);
    }

    sendEvent(eventCode, parameters = {}, targetPeers = null, cacheEventId = null) {
        const event = {
            Code: eventCode,
            Parameters: parameters
        };
        
        if (cacheEventId !== null) {
            event.CacheEventId = cacheEventId;
        }
        
        return this.sendCommand(PHOTON_COMMANDS.SEND_RELIABLE, event);
    }

    sendPing() {
        return this.sendCommand(PHOTON_COMMANDS.PING);
    }

    sendVerifyConnect() {
        return this.sendCommand(PHOTON_COMMANDS.VERIFY_CONNECT);
    }

    sendDisconnect() {
        this.sendCommand(PHOTON_COMMANDS.DISCONNECT);
        this.state = PHOTON_PEER_STATE.DISCONNECTING;
    }

    // Authentication methods
    authenticate(nickname, userId = null, customAuthData = null) {
        this.playerName = nickname || `Player${this.peerId}`;
        this.userId = userId || this.peerId.toString();
        this.state = PHOTON_PEER_STATE.CONNECTED;
        
        return this.sendOperationResponse(230, 0, {
            nickname: this.playerName,
            userid: this.userId,
            secret: 'authenticated'
        });
    }

    // Property management
    setCustomProperties(properties, broadcast = true) {
        Object.assign(this.customProperties, properties);
        
        if (broadcast && this.room) {
            this.room.broadcastEvent(253, {
                targetActor: this.peerId,
                properties: this.customProperties
            }, this.peerId);
        }
    }

    getCustomProperties() {
        return { ...this.customProperties };
    }

    // Room-related methods
    joinRoom(room) {
        if (this.room) {
            this.leaveRoom();
        }
        
        this.room = room;
        return room.addPeer(this);
    }

    leaveRoom() {
        if (this.room) {
            this.room.removePeer(this);
            this.room = null;
            this.isMasterClient = false;
        }
    }

    setMasterClient(isMaster = true) {
        this.isMasterClient = isMaster;
    }

    // Connection management
    disconnect(reason = 'Client disconnected') {
        this.isActive = false;
        this.state = PHOTON_PEER_STATE.DISCONNECTING;
        
        if (this.room) {
            this.leaveRoom();
        }
        
        if (this.socket && !this.socket.destroyed) {
            this.sendDisconnect();
            setTimeout(() => {
                this.socket.end();
            }, 100);
        }
    }

    isConnected() {
        return this.state === PHOTON_PEER_STATE.CONNECTED && 
               this.socket && 
               !this.socket.destroyed && 
               this.isActive;
    }

    // Statistics and monitoring
    getConnectionTime() {
        return Date.now() - this.connectedAt;
    }

    getLastActivityTime() {
        return Date.now() - this.lastActivity;
    }

    getStats() {
        return {
            ...this.stats,
            connectionTime: this.getConnectionTime(),
            lastActivity: this.getLastActivityTime(),
            state: this.state,
            isActive: this.isActive,
            room: this.room ? this.room.name : null,
            isMasterClient: this.isMasterClient
        };
    }

    // Utility methods
    toJSON() {
        return {
            peerId: this.peerId,
            playerName: this.playerName,
            userId: this.userId,
            customProperties: this.customProperties,
            state: this.state,
            isActive: this.isActive,
            isMasterClient: this.isMasterClient,
            room: this.room ? this.room.name : null,
            connectionTime: this.getConnectionTime(),
            stats: this.stats
        };
    }

    toString() {
        return `PhotonPeer[${this.peerId}:${this.playerName}]`;
    }
}

module.exports = PhotonPeer;