class WelcomePlugin {
    constructor(context) {
        this.context = context;
        this.config = context.config;
        this.logger = context.logger;
        this.playerCount = 0;
        
        // Default configuration
        this.config = {
            enabled: true,
            welcomeMessage: "Welcome to the Photon Server!",
            showPlayerCount: true,
            logConnections: true,
            ...this.config
        };
    }

    async initialize() {
        this.logger.info('Welcome plugin initializing...');
        
        // Register hooks
        this.context.registerHook('peer:connected', this.onPeerConnected.bind(this), 100);
        this.context.registerHook('peer:disconnected', this.onPeerDisconnected.bind(this), 100);
        
        this.logger.info('Welcome plugin initialized successfully');
    }

    onPeerConnected(data) {
        const { peer } = data;
        this.playerCount++;
        
        if (this.config.logConnections) {
            this.logger.info('🎉 New player connected!', { 
                peerId: peer.peerId,
                playerCount: this.playerCount,
                remoteAddress: peer._socket?.remoteAddress
            });
        }
        
        // Send welcome message after a short delay
        setTimeout(() => {
            this.sendWelcomeMessage(peer);
        }, 1000);
        
        this.context.metrics.increment('players.connected');
        return data;
    }

    onPeerDisconnected(data) {
        const { peer, reason } = data;
        this.playerCount = Math.max(0, this.playerCount - 1);
        
        if (this.config.logConnections) {
            this.logger.info('👋 Player disconnected', { 
                peerId: peer.peerId,
                playerName: peer.playerName || 'Anonymous',
                reason,
                remainingPlayers: this.playerCount
            });
        }
        
        this.context.metrics.increment('players.disconnected');
        return data;
    }

    sendWelcomeMessage(peer) {
        if (!this.config.enabled) return;
        
        try {
            let message = this.config.welcomeMessage;
            
            if (this.config.showPlayerCount) {
                const totalPlayers = this.context.server.getPeers().length;
                message += ` There are currently ${totalPlayers} players online.`;
            }
            
            // Send as a system event (you can customize the event code)
            peer.sendEvent(999, {
                type: 'system_message',
                message: message,
                timestamp: Date.now()
            });
            
            this.logger.debug('Welcome message sent', { peerId: peer.peerId });
            this.context.metrics.increment('welcomes.sent');
            
        } catch (error) {
            this.logger.error('Failed to send welcome message', { 
                peerId: peer.peerId,
                error: error.message 
            });
        }
    }

    async cleanup() {
        this.logger.info('Welcome plugin cleaned up', { 
            totalConnections: this.context.metrics.get('players.connected') || 0
        });
    }

    async onConfigUpdate(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.logger.info('Welcome plugin configuration updated');
    }
}

module.exports = WelcomePlugin;