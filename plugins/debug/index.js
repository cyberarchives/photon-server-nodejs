class DebugPlugin {
    constructor(context) {
        this.context = context;
        this.config = context.config;
        this.logger = context.logger;
        
        this.config = {
            enabled: true,
            logAllEvents: false,
            logOperations: true,
            logRoomEvents: true,
            ...this.config
        };
    }

    async initialize() {
        this.logger.info('Debug plugin initializing...');
        
        if (this.config.logRoomEvents) {
            this.context.registerHook('room:created', this.onRoomCreated.bind(this));
            this.context.registerHook('room:destroyed', this.onRoomDestroyed.bind(this));
        }
        
        if (this.config.logOperations) {
            this.context.registerHook('operation:received', this.onOperationReceived.bind(this));
        }
        
        if (this.config.logAllEvents) {
            this.context.registerHook('event:raised', this.onEventRaised.bind(this));
        }
        
        this.logger.info('Debug plugin initialized successfully');
    }

    onRoomCreated(data) {
        const { room } = data;
        this.logger.debug('🏠 Room Created', {
            roomName: room.name,
            maxPlayers: room.maxPlayers,
            isVisible: room.isVisible,
            hasPassword: !!room.password
        });
        return data;
    }

    onRoomDestroyed(data) {
        const { room } = data;
        this.logger.debug('🗑️ Room Destroyed', {
            roomName: room.name
        });
        return data;
    }

    onOperationReceived(data) {
        const { peer, operation } = data;
        this.logger.debug('📨 Operation Received', {
            peerId: peer.peerId,
            operationCode: operation.OperationCode,
            parametersCount: Object.keys(operation.Parameters || {}).length
        });
        return data;
    }

    onEventRaised(data) {
        const { senderPeer, eventCode, parameters } = data;
        this.logger.debug('📡 Event Raised', {
            senderPeerId: senderPeer?.peerId,
            eventCode,
            hasParameters: !!parameters
        });
        return data;
    }

    async cleanup() {
        this.logger.info('Debug plugin cleaned up');
    }

    async onConfigUpdate(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.logger.info('Debug plugin configuration updated');
    }
}

module.exports = DebugPlugin;