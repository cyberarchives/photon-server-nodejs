const { PHOTON_EVENTS } = require('../protocol/constants');

class PhotonRoom {
    constructor(name, options = {}) {
        this.name = name;
        this.maxPlayers = options.maxPlayers || 4;
        this.peers = new Map();
        this.customProperties = options.customProperties || {};
        this.isOpen = options.isOpen !== false;
        this.isVisible = options.isVisible !== false;
        this.password = options.password || null;
        this.createdAt = Date.now();
        this.lastActivity = Date.now();
        this.masterClientId = null;
        this.expectedUsers = new Set();
        this.playerTtl = options.playerTtl || 0; // Time to live for inactive players
        this.emptyRoomTtl = options.emptyRoomTtl || 0; // Time to live for empty room
        
        // Room state
        this.state = 'open';
        this.gameState = {};
        this.cachedEvents = new Map();
        
        // Statistics
        this.stats = {
            totalJoins: 0,
            totalLeaves: 0,
            eventsRaised: 0,
            maxPlayersReached: 0
        };
    }

    updateActivity() {
        this.lastActivity = Date.now();
    }

    addPeer(peer) {
        if (!this.isOpen) {
            return false;
        }

        if (this.peers.size >= this.maxPlayers) {
            return false;
        }

        if (this.password && !peer.hasValidPassword) {
            return false;
        }

        // Add peer to room
        this.peers.set(peer.peerId, peer);
        peer.room = this;
        
        // Set master client if first player
        if (this.peers.size === 1) {
            this.setMasterClient(peer.peerId);
        }

        this.updateActivity();
        this.stats.totalJoins++;
        this.stats.maxPlayersReached = Math.max(this.stats.maxPlayersReached, this.peers.size);

        // Send join response to the joining peer
        peer.sendOperationResponse(226, 0, {
            actorNr: peer.peerId,
            gameProperties: this.customProperties,
            actorProperties: this.getPlayerList(),
            playerTtl: this.playerTtl,
            emptyRoomTtl: this.emptyRoomTtl,
            masterClientId: this.masterClientId,
            roomName: this.name
        });

        // Notify other players about the join
        this.broadcastEvent(PHOTON_EVENTS.JOIN, {
            actorNr: peer.peerId,
            nickName: peer.playerName,
            props: peer.customProperties,
            masterClientId: this.masterClientId
        }, peer.peerId);

        console.log(`Player ${peer.playerName} (${peer.peerId}) joined room ${this.name}`);
        return true;
    }

    removePeer(peer) {
        if (!this.peers.has(peer.peerId)) {
            return false;
        }

        this.peers.delete(peer.peerId);
        peer.room = null;
        peer.isMasterClient = false;

        this.updateActivity();
        this.stats.totalLeaves++;

        // Handle master client switching
        if (this.masterClientId === peer.peerId) {
            this.selectNewMasterClient();
        }

        // Notify other players about the leave
        this.broadcastEvent(PHOTON_EVENTS.LEAVE, {
            actorNr: peer.peerId,
            masterClientId: this.masterClientId
        });

        console.log(`Player ${peer.playerName} (${peer.peerId}) left room ${this.name}`);
        return true;
    }

    setMasterClient(peerId) {
        const peer = this.peers.get(peerId);
        if (!peer) return false;

        // Clear previous master client
        if (this.masterClientId) {
            const prevMaster = this.peers.get(this.masterClientId);
            if (prevMaster) {
                prevMaster.setMasterClient(false);
            }
        }

        // Set new master client
        this.masterClientId = peerId;
        peer.setMasterClient(true);

        // Notify all players
        this.broadcastEvent(PHOTON_EVENTS.MASTER_CLIENT_SWITCHED, {
            newMasterClientId: peerId,
            actorNr: peerId
        });

        return true;
    }

    selectNewMasterClient() {
        if (this.peers.size === 0) {
            this.masterClientId = null;
            return null;
        }

        // Select the peer with the lowest ID
        const peerIds = Array.from(this.peers.keys()).sort((a, b) => a - b);
        const newMasterId = peerIds[0];
        
        this.setMasterClient(newMasterId);
        return newMasterId;
    }

    broadcastEvent(eventCode, parameters, excludePeer = null) {
        this.stats.eventsRaised++;
        
        for (const [peerId, peer] of this.peers) {
            if (excludePeer && peerId === excludePeer) continue;
            if (!peer.isConnected()) continue;
            
            peer.sendEvent(eventCode, parameters);
        }
    }

    raiseEvent(senderPeer, eventCode, parameters, targetPeers = null, cacheEvent = false) {
        if (!this.peers.has(senderPeer.peerId)) {
            return false;
        }

        // Cache event if requested
        if (cacheEvent) {
            this.cachedEvents.set(eventCode, {
                eventCode,
                parameters,
                senderId: senderPeer.peerId,
                timestamp: Date.now()
            });
        }

        // Send to target peers or all peers
        if (targetPeers && Array.isArray(targetPeers)) {
            targetPeers.forEach(peerId => {
                const peer = this.peers.get(peerId);
                if (peer && peer.isConnected()) {
                    peer.sendEvent(eventCode, parameters);
                }
            });
        } else {
            this.broadcastEvent(eventCode, parameters, senderPeer.peerId);
        }

        this.updateActivity();
        return true;
    }

    setCustomProperties(properties, broadcast = true) {
        Object.assign(this.customProperties, properties);
        
        if (broadcast) {
            this.broadcastEvent(PHOTON_EVENTS.PROPERTIES_CHANGED, {
                gameProperties: this.customProperties
            });
        }
    }

    getPlayerList() {
        const players = {};
        for (const [peerId, peer] of this.peers) {
            players[peerId] = {
                nickName: peer.playerName,
                props: peer.customProperties,
                userId: peer.userId,
                isMasterClient: peer.isMasterClient,
                isActive: peer.isActive
            };
        }
        return players;
    }

    getActivePeers() {
        return Array.from(this.peers.values()).filter(peer => peer.isConnected());
    }

    getPeer(peerId) {
        return this.peers.get(peerId);
    }

    isEmpty() {
        return this.peers.size === 0;
    }

    isFull() {
        return this.peers.size >= this.maxPlayers;
    }

    canJoin(peer) {
        if (!this.isOpen) return false;
        if (this.isFull()) return false;
        if (this.password && !peer.hasValidPassword) return false;
        return true;
    }

    setPassword(password) {
        this.password = password;
    }

    validatePassword(password) {
        return !this.password || this.password === password;
    }

    close() {
        this.isOpen = false;
        this.state = 'closed';
    }

    open() {
        this.isOpen = true;
        this.state = 'open';
    }

    hide() {
        this.isVisible = false;
    }

    show() {
        this.isVisible = true;
    }

    destroy() {
        // Disconnect all peers
        for (const peer of this.peers.values()) {
            peer.leaveRoom();
        }
        
        this.peers.clear();
        this.state = 'destroyed';
        this.cachedEvents.clear();
    }

    getStats() {
        return {
            ...this.stats,
            name: this.name,
            playerCount: this.peers.size,
            maxPlayers: this.maxPlayers,
            isOpen: this.isOpen,
            isVisible: this.isVisible,
            hasPassword: !!this.password,
            masterClientId: this.masterClientId,
            createdAt: this.createdAt,
            lastActivity: this.lastActivity,
            age: Date.now() - this.createdAt,
            timeSinceLastActivity: Date.now() - this.lastActivity,
            state: this.state,
            cachedEventsCount: this.cachedEvents.size
        };
    }

    // Utility methods
    toJSON() {
        return {
            name: this.name,
            playerCount: this.peers.size,
            maxPlayers: this.maxPlayers,
            isOpen: this.isOpen,
            isVisible: this.isVisible,
            hasPassword: !!this.password,
            customProperties: this.customProperties,
            masterClientId: this.masterClientId,
            players: this.getPlayerList(),
            stats: this.getStats()
        };
    }

    toString() {
        return `PhotonRoom[${this.name}:${this.peers.size}/${this.maxPlayers}]`;
    }
}

module.exports = PhotonRoom;