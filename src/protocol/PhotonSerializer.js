const { PHOTON_TYPES } = require('./constants');

class PhotonSerializer {
    constructor() {
        this.buffer = Buffer.alloc(0);
    }

    reset() {
        this.buffer = Buffer.alloc(0);
    }

    writeUint8(value) {
        const buf = Buffer.allocUnsafe(1);
        buf.writeUInt8(value, 0);
        this.buffer = Buffer.concat([this.buffer, buf]);
    }

    writeUint16(value) {
        const buf = Buffer.allocUnsafe(2);
        buf.writeUInt16BE(value, 0);
        this.buffer = Buffer.concat([this.buffer, buf]);
    }

    writeUint32(value) {
        const buf = Buffer.allocUnsafe(4);
        buf.writeUInt32BE(value, 0);
        this.buffer = Buffer.concat([this.buffer, buf]);
    }

    writeUint64(value) {
        const buf = Buffer.allocUnsafe(8);
        buf.writeBigUInt64BE(BigInt(value), 0);
        this.buffer = Buffer.concat([this.buffer, buf]);
    }

    writeFloat(value) {
        const buf = Buffer.allocUnsafe(4);
        buf.writeFloatBE(value, 0);
        this.buffer = Buffer.concat([this.buffer, buf]);
    }

    writeDouble(value) {
        const buf = Buffer.allocUnsafe(8);
        buf.writeDoubleBE(value, 0);
        this.buffer = Buffer.concat([this.buffer, buf]);
    }

    writeString(str) {
        const strBuf = Buffer.from(str, 'utf8');
        this.writeUint16(strBuf.length);
        this.buffer = Buffer.concat([this.buffer, strBuf]);
    }

    writeByteArray(bytes) {
        this.writeUint32(bytes.length);
        this.buffer = Buffer.concat([this.buffer, Buffer.from(bytes)]);
    }

    writeCustomData(variant, data) {
        this.writeUint8(variant.charCodeAt(0));
        
        const startLength = this.buffer.length;
        
        switch (variant) {
            case 'W': // Vec2
                this.writeFloat(data.x);
                this.writeFloat(data.y);
                break;
            case 'V': // Vec3
                this.writeFloat(data.x);
                this.writeFloat(data.y);
                this.writeFloat(data.z);
                break;
            case 'Q': // Quaternion
                this.writeFloat(data.w);
                this.writeFloat(data.x);
                this.writeFloat(data.y);
                this.writeFloat(data.z);
                break;
            case 'P': // PhotonPlayer
                this.writeUint32(data.player_id);
                break;
            default:
                if (data.data) {
                    this.buffer = Buffer.concat([this.buffer, Buffer.from(data.data)]);
                }
        }
        
        const dataLength = this.buffer.length - startLength - 1; // -1 for variant byte
        
        // Insert length after variant
        const lengthBuf = Buffer.allocUnsafe(2);
        lengthBuf.writeUInt16BE(dataLength, 0);
        
        const beforeLength = this.buffer.slice(0, startLength + 1);
        const afterLength = this.buffer.slice(startLength + 1);
        this.buffer = Buffer.concat([beforeLength, lengthBuf, afterLength]);
    }

    writePhotonType(obj) {
        if (obj === null || obj === undefined) {
            this.writeUint8(PHOTON_TYPES.NULL);
            return;
        }

        switch (typeof obj) {
            case 'string':
                this.writeUint8(PHOTON_TYPES.STRING);
                this.writeString(obj);
                break;
                
            case 'number':
                if (Number.isInteger(obj)) {
                    if (obj >= -128 && obj <= 127) {
                        this.writeUint8(PHOTON_TYPES.BYTE);
                        this.writeUint8(obj < 0 ? obj + 256 : obj);
                    } else if (obj >= -32768 && obj <= 32767) {
                        this.writeUint8(PHOTON_TYPES.SHORT);
                        this.writeUint16(obj < 0 ? obj + 65536 : obj);
                    } else if (obj >= -2147483648 && obj <= 2147483647) {
                        this.writeUint8(PHOTON_TYPES.INTEGER);
                        this.writeUint32(obj < 0 ? obj + 4294967296 : obj);
                    } else {
                        this.writeUint8(PHOTON_TYPES.LONG);
                        this.writeUint64(obj);
                    }
                } else {
                    this.writeUint8(PHOTON_TYPES.FLOAT);
                    this.writeFloat(obj);
                }
                break;
                
            case 'boolean':
                this.writeUint8(PHOTON_TYPES.BOOLEAN);
                this.writeUint8(obj ? 1 : 0);
                break;
                
            case 'object':
                if (Array.isArray(obj)) {
                    // Check if it's a uniform array
                    if (obj.length > 0 && obj.every(item => typeof item === typeof obj[0])) {
                        if (typeof obj[0] === 'string') {
                            this.writeUint8(PHOTON_TYPES.STRING_ARRAY);
                            this.writeUint16(obj.length);
                            obj.forEach(str => this.writeString(str));
                        } else if (typeof obj[0] === 'number' && Number.isInteger(obj[0])) {
                            this.writeUint8(PHOTON_TYPES.INT_ARRAY);
                            this.writeUint32(obj.length);
                            obj.forEach(num => this.writeUint32(num));
                        } else {
                            this.writeUint8(PHOTON_TYPES.OBJECT_ARRAY);
                            this.writeUint16(obj.length);
                            obj.forEach(item => this.writePhotonType(item));
                        }
                    } else {
                        this.writeUint8(PHOTON_TYPES.OBJECT_ARRAY);
                        this.writeUint16(obj.length);
                        obj.forEach(item => this.writePhotonType(item));
                    }
                } else if (obj instanceof Uint8Array || obj instanceof Buffer) {
                    this.writeUint8(PHOTON_TYPES.BYTE_ARRAY);
                    this.writeByteArray(obj);
                } else if (obj.variant && obj.data) {
                    // Custom data type
                    this.writeUint8(PHOTON_TYPES.CUSTOM_DATA);
                    this.writeCustomData(obj.variant, obj.data);
                } else {
                    // Hash table
                    this.writeUint8(PHOTON_TYPES.HASH_TABLE);
                    const keys = Object.keys(obj);
                    this.writeUint16(keys.length);
                    keys.forEach(key => {
                        this.writePhotonType(key);
                        this.writePhotonType(obj[key]);
                    });
                }
                break;
                
            default:
                console.warn('PhotonSerializer: Unsupported type:', typeof obj);
                this.writeUint8(PHOTON_TYPES.NULL);
        }
    }

    writeDictionary(keyType, valueType, map) {
        this.writeUint8(PHOTON_TYPES.DICTIONARY);
        this.writeUint8(keyType);
        this.writeUint8(valueType);
        this.writeUint16(map.size);
        
        for (const [key, value] of map) {
            if (keyType !== PHOTON_TYPES.NULL) {
                this.writePhotonType(key);
            }
            if (valueType !== PHOTON_TYPES.NULL) {
                this.writePhotonType(value);
            }
        }
    }

    writeCommand(command, channelId = 0, flags = 0, timestamp = null, sequenceNumber = null, data = null) {
        this.writeUint8(command);
        this.writeUint8(channelId);
        this.writeUint8(flags);
        this.writeUint8(0); // reserved
        this.writeUint32(timestamp || (Date.now() & 0xFFFFFFFF));
        
        if (sequenceNumber !== null) {
            this.writeUint32(sequenceNumber);
        }
        
        if (data !== null) {
            this.writePhotonType(data);
        }
    }

    getBuffer() {
        return this.buffer;
    }

    getLength() {
        return this.buffer.length;
    }

    static createPacket(peerId, data) {
        const header = Buffer.allocUnsafe(12);
        
        // Photon header: signature + peer ID + CRC + length
        header.writeUInt16BE(0xFB17, 0); // signature
        header.writeUInt16BE(peerId, 2);
        header.writeUInt32BE(0, 4); // CRC placeholder
        header.writeUInt32BE(data.length, 8);
        
        return Buffer.concat([header, data]);
    }
}

module.exports = PhotonSerializer;