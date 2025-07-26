const { PhotonServer } = require('../src');

// Create server with custom options
const server = new PhotonServer({
    port: 5055,
    host: '0.0.0.0',
    maxConnections: 100,
    pingInterval: 30000,
    connectionTimeout: 60000
});

// Event listeners
server.on('started', () => {
    console.log('🚀 Photon Server started successfully!');
    console.log(`📊 Server Info:`);
    console.log(`   - Host: ${server.host}`);
    console.log(`   - Port: ${server.port}`);
    console.log(`   - Max Connections: ${server.maxConnections}`);
});

server.on('peerConnected', (peer) => {
    console.log(`✅ Peer connected: ${peer.peerId} (${peer.socket.remoteAddress})`);
});

server.on('peerDisconnected', (peer) => {
    console.log(`❌ Peer disconnected: ${peer.peerId} (${peer.playerName || 'Anonymous'})`);
});

server.on('roomCreated', (room) => {
    console.log(`🏠 Room created: ${room.name} (${room.maxPlayers} max players)`);
});

server.on('roomRemoved', (room) => {
    console.log(`🗑️  Room removed: ${room.name}`);
});

server.on('error', (error) => {
    console.error('❌ Server error:', error);
});

// Statistics reporting every 30 seconds
setInterval(() => {
    const stats = server.getStats();
    console.log(`📈 Server Stats: ${stats.currentConnections} peers, ${stats.currentRooms} rooms, ${stats.totalMessages} messages processed`);
}, 30000);

// Start the server
async function startServer() {
    try {
        await server.start();
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down Photon Server...');
    await server.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down Photon Server...');
    await server.stop();
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Start the server
startServer();