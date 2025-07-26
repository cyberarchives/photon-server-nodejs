const net = require('net');
const EventEmitter = require('events');
const PhotonPeer = require('./PhotonPeer');
const PhotonRoom = require('./PhotonRoom');
const PhotonParser = require('../protocol/PhotonParser');
const OperationHandler = require('../handlers/OperationHandler');
const { PHOTON_COMMANDS, PHOTON_PEER_STATE, PHOTON_SIGNATURE } = require('../protocol/constants');

class PhotonServer extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.port = options.port || 5055;
        this.host = options.host || '0.0.0.0';
        this.maxConnections = options.maxConnections || 1000;
        this.pingInterval = options.pingInterval || 30000;
        this.connectionTimeout = options.connectionTimeout || 60000;
        
        // Server state
        this.server = null;
        this.peers = new Map();
        this.rooms = new Map();
        this.nextPeerId = 1;
        this.isRunning = false;
        this.startTime = null;
        
        // Handlers
        this.operationHandler = new OperationHandler(this);
        
        // Statistics
        this.stats = {
            totalConnections: 0,
            totalDisconnections: 0,
            totalRoomsCreated: 0,
            totalMessages: 0,
            peakConnections: 0,
            peakRooms: 0
        };
        
        // Intervals
        this.pingIntervalId = null;
        this.cleanupIntervalId = null;
    }

    start() {
        if (this.isRunning) {
            throw new Error('Server is already running');
        }

        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => {
                this.handleConnection(socket);
            });

            this.server.on('error', (error) => {
                console.error('Server error:', error);
                this.emit('error', error);
                reject(error);
            });

            this.server.listen(this.port, this.host, () => {
                this.isRunning = true;
                this.startTime = Date.now();
                
                console.log(`Photon Server listening on ${this.host}:${this.port}`);
                
                // Start background tasks
                this.startPingInterval();
                this.startCleanupInterval();
                
                this.emit('started');
                resolve();
            });
        });
    }

    stop() {
        if (!this.isRunning) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            // Stop intervals
            if (this.pingIntervalId) {
                clearInterval(this.pingIntervalId);
                this.pingIntervalId = null;
            }
            
            if (this.cleanupIntervalId) {
                clearInterval(this.cleanupIntervalId);
                this.cleanupIntervalId = null;
            }

            // Disconnect all peers
            for (const peer of this.peers.values()) {
                peer.disconnect('Server shutting down');
            }

            // Close server
            this.server.close(() => {
                this.isRunning = false;
                console.log('Photon Server stopped');
                this.emit('stopped');
                resolve();
            });
        });
    }

    handleConnection(socket) {
        if (this.peers.size >= this.maxConnections) {
            console.log(`Connection rejected: max connections (${this.maxConnections}) reached`);
            socket.end();
            return;
        }

        const peer = new PhotonPeer(socket, this.nextPeerId++);
        this.peers.set(peer.peerId, peer);
        
        this.stats.totalConnections++;
        this.stats.peakConnections = Math.max(this.stats.peakConnections, this.peers.size);

        console.log(`New connection from ${socket.remoteAddress}:${socket.remotePort} (Peer ID: ${peer.peerId})`);

        // Set up socket event handlers
        socket.on('data', (data) => {
            this.handleData(peer, data);
        });

        socket.on('close', () => {
            this.handleDisconnection(peer);
        });

        socket.on('error', (error) => {
            console.error(`Socket error for peer ${peer.peerId}:`, error);
            this.handleDisconnection(peer);
        });

        // Set connection timeout
        socket.setTimeout(this.connectionTimeout, () => {
            console.log(`Connection timeout for peer ${peer.peerId}`);
            peer.disconnect('Connection timeout');
        });

        // Send initial connection response
        setTimeout(() => {
            peer.sendVerifyConnect();
            peer.state = PHOTON_PEER_STATE.CONNECTED;
        }, 100);

        this.emit('peerConnected', peer);
    }

    handleDisconnection(peer) {
        if (!this.peers.has(peer.peerId)) {
            return;
        }

        console.log(`Peer ${peer.peerId} disconnected`);
        
        // Remove from room if in one
        if (peer.room) {
            peer.room.removePeer(peer);
            
            // Remove empty room
            if (peer.room.isEmpty()) {
                this.removeRoom(peer.room.name);
            }
        }

        // Remove peer
        this.peers.delete(peer.peerId);
        this.stats.totalDisconnections++;

        this.emit('peerDisconnected', peer);
    }

    handleData(peer, buffer) {
        try {
            peer.updateActivity();
            peer.stats.messagesReceived++;
            peer.stats.bytesReceived += buffer.length;
            this.stats.totalMessages++;

            // Validate Photon header
            if (buffer.length < 12) {
                console.warn(`Invalid packet size from peer ${peer.peerId}: ${buffer.length}`);
                return;
            }

            const signature = buffer.readUInt16BE(0);
            if (signature !== PHOTON_SIGNATURE) {
                console.warn(`Invalid signature from peer ${peer.peerId}: 0x${signature.toString(16)}`);
                return;
            }

            const peerIdFromPacket = buffer.readUInt16BE(2);
            const crc = buffer.readUInt32BE(4);
            const length = buffer.readUInt32BE(8);

            // Skip header and parse data
            const dataBuffer = buffer.slice(12);
            if (dataBuffer.length === 0) return;

            const parser = new PhotonParser(dataBuffer.buffer);
            
            while (parser.offset < parser.view.byteLength - 1) {
                const commandData = parser.parseCommand();
                if (!commandData) break;
                
                this.handleCommand(peer, commandData);
            }
        } catch (error) {
            console.error(`Error handling data from peer ${peer.peerId}:`, error);
        }
    }

    handleCommand(peer, commandData) {
        const { command, data } = commandData;
        
        switch (command) {
            case PHOTON_COMMANDS.PING:
                peer.sendPing();
                peer.lastPingTime = Date.now();
                break;
                
            case PHOTON_COMMANDS.SEND_RELIABLE:
            case PHOTON_COMMANDS.SEND_UNRELIABLE:
                if (data && data.data) {
                    this.operationHandler.handleOperation(peer, data.data);
                }
                break;
                
            case PHOTON_COMMANDS.DISCONNECT:
                peer.disconnect('Client requested disconnect');
                break;
                
            default:
                console.log(`Unknown command ${command} from peer ${peer.peerId}`);
        }
    }

    // Room management
    createRoom(name, options = {}) {
        if (this.rooms.has(name)) {
            return this.rooms.get(name);
        }

        const room = new PhotonRoom(name, options);
        this.rooms.set(name, room);
        this.stats.totalRoomsCreated++;
        this.stats.peakRooms = Math.max(this.stats.peakRooms, this.rooms.size);

        console.log(`Room created: ${name}`);
        this.emit('roomCreated', room);
        return room;
    }

    removeRoom(name) {
        const room = this.rooms.get(name);
        if (!room) return false;

        // Ensure room is empty
        if (!room.isEmpty()) {
            console.warn(`Attempting to remove non-empty room: ${name}`);
            return false;
        }

        room.destroy();
        this.rooms.delete(name);
        
        console.log(`Room removed: ${name}`);
        this.emit('roomRemoved', room);
        return true;
    }

    getRoom(name) {
        return this.rooms.get(name);
    }

    getRooms() {
        return Array.from(this.rooms.values());
    }

    getVisibleRooms() {
        return Array.from(this.rooms.values()).filter(room => room.isVisible);
    }

    // Peer management
    getPeer(peerId) {
        return this.peers.get(peerId);
    }

    getPeers() {
        return Array.from(this.peers.values());
    }

    getActivePeers() {
        return Array.from(this.peers.values()).filter(peer => peer.isConnected());
    }

    disconnectPeer(peerId, reason = 'Disconnected by server') {
        const peer = this.peers.get(peerId);
        if (peer) {
            peer.disconnect(reason);
        }
    }

    // Background tasks
    startPingInterval() {
        this.pingIntervalId = setInterval(() => {
            const now = Date.now();
            
            for (const peer of this.peers.values()) {
                if (!peer.isConnected()) continue;
                
                if (now - peer.lastPingTime > this.pingInterval) {
                    peer.sendPing();
                    peer.lastPingTime = now;
                }
                
                // Disconnect inactive peers
                if (now - peer.lastActivity > this.connectionTimeout) {
                    console.log(`Disconnecting inactive peer ${peer.peerId}`);
                    peer.disconnect('Inactivity timeout');
                }
            }
        }, 10000); // Check every 10 seconds
    }

    startCleanupInterval() {
        this.cleanupIntervalId = setInterval(() => {
            // Clean up empty rooms
            const emptyRooms = [];
            for (const [name, room] of this.rooms) {
                if (room.isEmpty() && room.emptyRoomTtl > 0) {
                    const timeSinceLastActivity = Date.now() - room.lastActivity;
                    if (timeSinceLastActivity > room.emptyRoomTtl) {
                        emptyRooms.push(name);
                    }
                }
            }
            
            emptyRooms.forEach(name => this.removeRoom(name));
            
            if (emptyRooms.length > 0) {
                console.log(`Cleaned up ${emptyRooms.length} empty rooms`);
            }
        }, 60000); // Check every minute
    }

    // Statistics and monitoring
    getStats() {
        return {
            ...this.stats,
            currentConnections: this.peers.size,
            currentRooms: this.rooms.size,
            uptime: this.startTime ? Date.now() - this.startTime : 0,
            isRunning: this.isRunning,
            port: this.port,
            host: this.host
        };
    }

    getRoomStats() {
        return this.getRooms().map(room => room.getStats());
    }

    getPeerStats() {
        return this.getPeers().map(peer => peer.getStats());
    }

    // Utility methods
    broadcast(eventCode, parameters, excludePeer = null) {
        for (const peer of this.peers.values()) {
            if (!peer.isConnected()) continue;
            if (excludePeer && peer.peerId === excludePeer) continue;
            
            peer.sendEvent(eventCode, parameters);
        }
    }

    broadcastToRoom(roomName, eventCode, parameters, excludePeer = null) {
        const room = this.getRoom(roomName);
        if (room) {
            room.broadcastEvent(eventCode, parameters, excludePeer);
        }
    }

    toJSON() {
        return {
            stats: this.getStats(),
            rooms: this.getRooms().map(room => room.toJSON()),
            peers: this.getPeers().map(peer => peer.toJSON())
        };
    }
}

module.exports = PhotonServer;