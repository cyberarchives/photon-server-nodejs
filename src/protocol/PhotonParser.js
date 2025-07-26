const { PHOTON_TYPES } = require('./constants');

class PhotonParser {
    constructor(buffer) {
        this.view = new DataView(buffer);
        this.offset = 0;
    }

    /* Helpers */

    increment(inc) {
        // increment offset without leaving the bounds
        this.offset = Math.min(this.offset + inc, this.view.byteLength - 1);
    }

    // returns Uint8Array with padding bytes
    readFixedBytes(len) {
        if (len === 0) { return new Uint8Array([]); }

        this.increment(len);
        return new Uint8Array(this.view.buffer.slice(this.offset - len, this.offset));
    }

    #extendMap(map) {
        map.rawGet = map.get;
        map.rawSet = map.set;

        // workaround for object equality not working in JS
        map.get = function (key) {
            return map.rawGet([...map.keys()].find(x => x.type === key.type && x.data === key.data));
        }
        map.set = function (key, value) {
            return map.rawSet([...map.keys()].find(x => x.type === key.type && x.data === key.data), value);
        }
        map.byIndex = function (idx) {
            let i = 0;
            for (const value of map.values()) {
                if (i === idx) return value;
                i++;
            }
            return undefined;
        }
    }

    /* Primitives */

    readUint8() {
        let value = this.view.getUint8(this.offset);
        this.increment(1);
        return value;
    }

    readUint16() {
        let value = this.view.getUint16(this.offset, false);
        this.increment(2);
        return value;
    }

    readUint32() {
        let value = this.view.getUint32(this.offset, false);
        this.increment(4);
        return value;
    }

    readUint64() {
        let value = this.view.getBigUint64(this.offset, false);
        this.increment(8);
        return value;
    }

    readFloat() {
        let value = this.view.getFloat32(this.offset, false);
        this.increment(4);
        return value;
    }

    readDouble() {
        let value = this.view.getFloat64(this.offset, false);
        this.increment(8);
        return value;
    }

    /* Photon Types */

    // 0x44 (Dictionary)
    parseDictionary() {
        let keyType = this.readUint8();
        let valType = this.readUint8();
        let len = this.readUint16();

        let readKey = keyType === 0 || keyType === PHOTON_TYPES.NULL;
        let readVal = valType === 0 || valType === PHOTON_TYPES.NULL;

        let map = new Map();

        for (let i = 0; i < len; i++) {
            let key = this.parsePhotonType(readKey ? null : keyType);
            let val = this.parsePhotonType(readVal ? null : valType);

            if (key.data != null) {
                map.set(key, val);
            }
        }

        // adds Photon helpers to the map
        this.#extendMap(map);

        return {keyType, valType, map};
    }

    // 0x61 (StringArray)
    parseStringArray() {
        let len = this.readUint16();
        let strings = [];

        for (let i = 0; i < len; i++) {
            strings.push(this.parseString());
        }

        return strings;
    }

    // 0x62 (Byte)
    parseByte() {
        return this.readUint8();
    }

    // 0x63 (CustomData)
    parseCustomData() {
        const variant = String.fromCharCode(this.readUint8());
        const len = this.readUint16();
        let data;

        switch (variant) {
            case 'W': data = this.parseVec2(); break;
            case 'V': data = this.parseVec3(); break;
            case 'Q': data = this.parseQuat(); break;
            case 'P': data = this.parsePhotonPlayer(); break;
            default: data = this.parseUnknownCustom(len);
        }

        return { variant, data };
    }

    // 0x63 (CustomData), "W" (Vec2)
    parseVec2() {
        return {
            x: this.readFloat(),
            y: this.readFloat(),
        };
    }

    // 0x63 (CustomData), "V" (Vec3)
    parseVec3() {
        return {
            x: this.readFloat(),
            y: this.readFloat(),
            z: this.readFloat(),
        };
    }

    // 0x63 (CustomData), "Q" (Quat)
    parseQuat() {
        return {
            w: this.readFloat(),
            x: this.readFloat(),
            y: this.readFloat(),
            z: this.readFloat(),
        };
    }

    // 0x63 (CustomData), "P" (PhotonPlayer)
    parsePhotonPlayer() {
        return {
            player_id: this.readUint32(),
        }
    }

    // 0x63 (CustomData), unknown
    parseUnknownCustom(len) {
        return {
            data: this.readFixedBytes(len),
        }
    }

    // 0x64 (Double)
    parseDouble() {
        return this.readDouble();
    }

    // 0x66 (Float)
    parseFloat() {
        return this.readFloat();
    }

    // 0x68 (HashTable)
    parseHashTable() {
        let len = this.readUint16();
        let map = new Map();

        for (let i = 0; i < len; i++) {
            let key = this.parsePhotonType();
            let val = this.parsePhotonType();

            if (key.data != null) {
                map.set(key, val);
            }
        }

        // adds Photon helpers to the map
        this.#extendMap(map);
        return map;
    }

    // 0x69 (Integer)
    parseInteger() {
        return this.readUint32();
    }

    // 0x6B (Short)
    parseShort() {
        return this.readUint16();
    }

    // 0x6C (Long)
    parseLong() {
        return this.readUint64();
    }

    // 0x6E (IntArray)
    parseIntArray() {
        let len = this.readUint32();
        let ints = []

        for (let i = 0; i < len; i++) {
            ints.push(this.readUint32());
        }

        return ints;
    }

    // 0x6F (Boolean)
    parseBool() {
        return !!this.readUint8();
    }

    // 0x73 (String)
    parseString() {
        let len = this.readUint16();
        let decoder = new TextDecoder();
        return decoder.decode(this.readFixedBytes(len));
    }

    // 0x78 (ByteArray)
    parseByteArray() {
        let len = this.readUint32();
        return this.readFixedBytes(len);
    }

    // 0x79 (Array)
    parseArray() {
        let len = this.readUint16();
        let type = this.readUint8();
        let arr = [];

        for (let i = 0; i < len; i++) {
            arr.push(this.parsePhotonType(type));
        }

        return {type, arr};
    }

    // 0x7A (ObjectArray)
    parseObjectArray() {
        let len = this.readUint16();
        let arr = [];

        for (let i = 0; i < len; i++) {
            arr.push(this.parsePhotonType());
        }

        return arr;
    }

    /* Logic */

    parsePhotonType(fixedType = null) {
        let type = fixedType ?? this.readUint8();
        var data = null;
        
        switch (type) {
            case PHOTON_TYPES.NULL:
                data = null; break;
            case PHOTON_TYPES.DICTIONARY:
                data = this.parseDictionary(); break;
            case PHOTON_TYPES.STRING_ARRAY:
                data = this.parseStringArray(); break;
            case PHOTON_TYPES.BYTE:
                data = this.parseByte(); break;
            case PHOTON_TYPES.CUSTOM_DATA:
                data = this.parseCustomData(); break;
            case PHOTON_TYPES.DOUBLE:
                data = this.parseDouble(); break;
            case PHOTON_TYPES.FLOAT:
                data = this.parseFloat(); break;
            case PHOTON_TYPES.HASH_TABLE:
                data = this.parseHashTable(); break;
            case PHOTON_TYPES.INTEGER:
                data = this.parseInteger(); break;
            case PHOTON_TYPES.SHORT:
                data = this.parseShort(); break;
            case PHOTON_TYPES.LONG:
                data = this.parseLong(); break;
            case PHOTON_TYPES.INT_ARRAY:
                data = this.parseIntArray(); break;
            case PHOTON_TYPES.BOOLEAN:
                data = this.parseBool(); break;
            case PHOTON_TYPES.STRING:
                data = this.parseString(); break;
            case PHOTON_TYPES.BYTE_ARRAY:
                data = this.parseByteArray(); break;
            case PHOTON_TYPES.ARRAY:
                data = this.parseArray(); break;
            case PHOTON_TYPES.OBJECT_ARRAY:
                data = this.parseObjectArray(); break;
            default:
                console.warn("Photon Parser: Unknown type '%d' at offset '%d'", type, this.offset);
        }

        return { type, data };
    }

    // Parse a complete Photon command from buffer
    parseCommand() {
        if (this.offset >= this.view.byteLength - 1) {
            return null;
        }

        const command = this.readUint8();
        const channelId = this.readUint8();
        const flags = this.readUint8();
        const reserved = this.readUint8();
        const timestamp = this.readUint32();

        let sequenceNumber = null;
        let data = null;

        // Read sequence number for reliable/unreliable commands
        if (command === 6 || command === 7) { // SEND_RELIABLE or SEND_UNRELIABLE
            sequenceNumber = this.readUint32();
        }

        // Parse remaining data if available
        if (this.offset < this.view.byteLength - 1) {
            data = this.parsePhotonType();
        }

        return {
            command,
            channelId,
            flags,
            reserved,
            timestamp,
            sequenceNumber,
            data
        };
    }
}

module.exports = PhotonParser;