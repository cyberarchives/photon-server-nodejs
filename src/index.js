// Main exports for the Photon Server library

const PhotonServer = require('./core/PhotonServer');
const PhotonPeer = require('./core/PhotonPeer');
const PhotonRoom = require('./core/PhotonRoom');
const PhotonParser = require('./protocol/PhotonParser');
const PhotonSerializer = require('./protocol/PhotonSerializer');
const OperationHandler = require('./handlers/OperationHandler');
const constants = require('./protocol/constants');

module.exports = {
    // Core classes
    PhotonServer,
    PhotonPeer,
    PhotonRoom,
    
    // Protocol classes
    PhotonParser,
    PhotonSerializer,
    
    // Handlers
    OperationHandler,
    
    // Constants
    ...constants,
    
    // Convenience factory function
    createServer: (options) => new PhotonServer(options),
    
    // Version info
    version: '1.0.0'
};

// For CommonJS default export compatibility
module.exports.default = module.exports;