const MessageRouter = require("../message-router");
const { LOGICAL } = require("../epath").segments;
const { generateEncodedTimeout } = require("../unconnected-send");
const crypto = require("crypto");
const config = require("../../../config");

const FORWARD_OPEN_SERVICE = 0x54;
const FORWARD_OPEN_PATH = Buffer.concat([
    LOGICAL.build(LOGICAL.types.ClassID, 0x06),
    LOGICAL.build(LOGICAL.types.InstanceID, 1)
]);

const generateConnectionId = () => {
    // generate random bytes
    return crypto.randomBytes(4).readUInt32BE(0, true);
    //TODO: compare to any current connection IDs, redo if needed
}

const generateConnectionSerial = () => {
    // generate random bytes
    return crypto.randomBytes(2).readUInt16BE(0, true);
    //TODO: compare to any current connection serial numbers, redo if needed
}

/**
 * Builds a Forward Open Packet Buffer
 *
 * @param {buffer} message_request - Message Request Encoded Buffer
 * @param {buffer} path - Padded EPATH Buffer
 * @param {number} [timeout=2000] - timeout in milliseconds
 * @returns {buffer}
 */
/**
 * 
 * @param {number} [cycle_time=1000] - time interval for data exchange 
 * @param {number} [timeout=2000] - timeout in milliseconds 
 * @returns 
 */
 const build = (cycle_time = 1000, timeout = 2000) => {
    let buf = Buffer.alloc(42);

    // Get Encoded Timeout
    const encTimeout = generateEncodedTimeout(timeout);

    // Write Encoded Timeout to Output Buffer
    buf.writeUInt8(encTimeout.time_tick, 0);
    buf.writeUInt8(encTimeout.ticks, 1);

    // O->T Conneciton ID
    buf.writeUInt32LE(generateConnectionId(),2);

    // T->O Connection ID
    buf.writeUInt32LE(generateConnectionId(),6);

    // Connection Serial Number
    buf.writeUInt16LE(generateConnectionSerial(),10);

    // Originator Vendor ID
    buf.writeUInt16LE(config.DEVICE_VENDOR_ID,12);

    // Originator Serial Number
    buf.writeUInt32LE(config.DEVICE_SERIAL_NUMBER,14);

    // Connection Timeout Multiplier
    let timeoutMultiplier = 0;
    buf.writeUInt8(timeoutMultiplier,18);

    // Reserved
    const nullBuf = Buffer.alloc(1);
    buf.writeUInt8(nullBuf,19);
    buf.writeUInt8(nullBuf,20);
    buf.writeUInt8(nullBuf,21);

    // O->T RPI
    let rpi = cycle_time*1000;
    buf.writeUInt32LE(rpi,22);

    // O->T Network Connection Parameters
    //TODO: get these values from vendor EDS
    //      Owner: exclusive
    //      Connection Type: Point to Point
    //      Priority: High Priority
    //      Connection Size Type: Variable
    //      Connection Size: 230 bytes (max is 512, use Large_Forward_Open for larger)
    buf.writeUInt16LE(18150,26);

    // T->O RPI
    buf.writeUInt32LE(rpi,28);

    // T->O Network Connection Parameters
    //TODO: get these values from vendor EDS
    //      Owner: exclusive
    //      Connection Type: Point to Point
    //      Priority: High Priority
    //      Connection Size Type: Variable
    //      Connection Size: 482 bytes (max is 512, use Large_Forward_Open for larger)
    buf.writeUInt16LE(16866,32);

    // Transport Type/Trigger
    //      Direction: Client
    //      Trigger: Cyclic
    //      Class: 1
    buf.writeUInt8(1,34);

    // Connection Path Size
    buf.writeUInt8(3,35);

    // Connection Path
    //TODO: get this info from EDS
    //      Class Id: assembly
    //      Connection Point: 0x70 (112)
    //      Connection Point: 0x62 (100)
    let assembly = 4;
    buf.writeUInt8(32,36);
    buf.writeUInt8(assembly,37);
    
    let connectionPoint1 = 112;
    buf.writeUInt8(44,38);
    buf.writeUInt8(connectionPoint1,39);

    let connectionPoint2 = 100;
    buf.writeUInt8(44,40);
    buf.writeUInt8(connectionPoint2,41);

    return MessageRouter.build(FORWARD_OPEN_SERVICE, FORWARD_OPEN_PATH, buf);
};

const parse = (data) => {
    let ot_connectionId = data.readUInt32LE(0);
    let to_connectionId = data.readUInt32LE(4);
    let connectionSerialNumber = data.readUInt16LE(8);
    let originatorVendorId = data.readUInt16LE(10);
    let originatorSerialNumber = data.readUInt32LE(12);
    let ot_api = data.readUInt32LE(16)/1000;    // in ms
    let to_api = data.readUInt32LE(20)/1000;    // in ms
    let applicationReply = data.readUInt8(24);

    return {
        ot_connectionId: ot_connectionId,
        to_connectionId: to_connectionId,
        connectionSerialNumber: connectionSerialNumber,
        originatorVendorId: originatorVendorId,
        originatorSerialNumber: originatorSerialNumber,
        ot_api: ot_api,
        to_api: to_api,
        applicationReply: applicationReply
    }
}



module.exports = { generateConnectionId, build, parse, FORWARD_OPEN_SERVICE };