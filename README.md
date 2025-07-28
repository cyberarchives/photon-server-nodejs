# Photon Server Node.js

A GPBinaryV16 Photon Server implementation in Node.js for real-time multiplayer games.

<img width="1414" height="684" alt="image" src="https://github.com/user-attachments/assets/2f756d23-3846-4027-adda-79a209935836" />

## What is this?

This is a custom implementation of a Photon server that lets you host your own multiplayer game servers instead of relying on Photon Cloud. It handles the networking protocol that Unity's Photon PUN uses, so your games can connect to your own servers.

## Why use this?

- Host your own game servers without monthly fees
- Full control over your multiplayer infrastructure  
- No player limits or bandwidth restrictions
- Keep your game data on your own servers
- Works with existing PUN client code (mostly)

## Getting it running

```bash
git clone https://github.com/cyberarchives/photon-server-nodejs.git
cd photon-server-nodejs
npm install
node examples/basic-server.js
```

Your server will start on port 5055. Point your Unity game clients to `your-server-ip:5055`.

## Basic setup

```javascript
const { PhotonServer } = require('./src');

const server = new PhotonServer({ 
    port: 5055,
    maxConnections: 500
});

server.on('peerConnected', (peer) => {
    console.log(`Player ${peer.peerId} connected`);
});

server.start();
```

## How it works

The server handles these main things:

**Rooms** - Players join rooms to play together. Rooms can have custom properties, player limits, passwords, etc.

**Events** - Players send events (like "I moved", "I shot") which get broadcast to other players in the room.

**Operations** - Protocol-level stuff like joining rooms, authentication, getting room lists.

**Master Client** - One player in each room is the "master" and can control room settings.

## Project structure

```
src/
├── protocol/           # Binary protocol parsing/serialization
├── core/              # Server, rooms, and peer management
├── handlers/          # Handles different operation types
└── utils/             # Logging and utilities
```

## Supported features

Most of the standard Photon operations work:

- Join/leave rooms
- Create rooms with settings
- Player authentication  
- Custom room/player properties
- Event broadcasting
- Master client switching
- Room lists and lobbies

## Protocol support

The binary protocol implementation handles all the data types Unity PUN sends:

- Basic types (int, float, string, bool, etc.)
- Arrays and dictionaries
- Unity types (Vector3, Quaternion)
- Custom serializable objects

Most PUN features should work out of the box.

## Configuration options

```javascript
new PhotonServer({
    port: 5055,                // What port to listen on
    host: '0.0.0.0',          // What interface to bind to
    maxConnections: 1000,      // Connection limit
    pingInterval: 30000,       // How often to ping clients
    connectionTimeout: 60000   // When to drop inactive clients
})
```

## Room management

```javascript
// Create a room
const room = server.createRoom('MyRoom', {
    maxPlayers: 8,
    isVisible: true,
    customProperties: {
        gameMode: 'deathmatch',
        map: 'dust2'
    }
});

// Rooms clean themselves up when empty
// You can also manually remove them
server.removeRoom('MyRoom');
```

## Events and messaging

```javascript
// In your game logic
peer.sendEvent(100, { 
    action: 'playerMove',
    position: { x: 10, y: 0, z: 5 }
});

// This gets broadcast to all other players in the room
// Your Unity client code receives it like a normal PUN event
```

## Running in production

For production use:

- Run behind a reverse proxy (nginx)
- Set up proper logging
- Monitor memory usage and connections
- Use PM2 or similar for process management
- Set NODE_ENV=production

The server includes built-in metrics and health monitoring.

## Performance notes

- Handles 1000+ concurrent connections on decent hardware
- Memory usage is roughly 1KB per connected player
- Event processing is very fast (sub-millisecond)
- File logging is async and won't block gameplay

## Limitations

This isn't a 1:1 Photon replacement. Some differences:

- No built-in matchmaking algorithms
- No Photon Cloud integration obviously
- Some advanced PUN features might not work
- You'll need to handle server scaling yourself

## Common issues

**"Cannot find module" errors** - Make sure you ran `npm install` and have a package.json file.

**Clients can't connect** - Check firewall settings and make sure the port is open.

**High memory usage** - Monitor your room cleanup settings and connection limits.

## Client connection (Unity)

In your Unity game, change the Photon settings to connect to your server:

```csharp
PhotonNetwork.PhotonServerSettings.HostType = ServerHostType.SelfHosted;
PhotonNetwork.PhotonServerSettings.ServerAddress = "your-server-ip";
PhotonNetwork.PhotonServerSettings.ServerPort = 5055;
```

## Contributing

Feel free to submit issues and pull requests. The codebase is pretty straightforward to work with.

## Credits

The binary protocol implementation is based on work from the [Photon-PUN-Base](https://github.com/eelstork/Photon-PUN-Base) project. Thanks to eelstork for figuring out the protocol details.

## License

MIT License - use it however you want.
