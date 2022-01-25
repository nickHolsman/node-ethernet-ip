const { ENIP, CIP } = require("../enip");
const dateFormat = require("dateformat");
const TagGroup = require("../tag-group");
const { delay, promiseTimeout } = require("../utilities");
const Queue = require("task-easy");
const dgram =require("dgram");
const config = require("../config");
const { readEDS } = require("../eds-parser");
const { Types } = require("../enip/cip/data-types");
const { SINT, INT, DINT, UDINT, REAL, BOOL, BIT_STRING } = Types;
const ci = require("correcting-interval");

const compare = (obj1, obj2) => {
    if (obj1.priority > obj2.priority) return true;
    else if (obj1.priority < obj2.priority) return false;
    else return obj1.timestamp.getTime() < obj2.timestamp.getTime();
};

class Controller extends ENIP {
    constructor({ queue_max_size } = {}) {
        super();
        
        this.state = {
            ...this.state,
            controller: {
                name: null,
                serial_number: null,
                slot: null,
                time: null,
                path: null,
                version: null,
                status: null,
                faulted: false,
                minorRecoverableFault: false,
                minorUnrecoverableFault: false,
                majorRecoverableFault: false,
                majorUnrecoverableFault: false,
                io_faulted: false
            },
            ip_address: null,
            subs: new TagGroup(compare),
            scanning: false,
            scan_rate: 200, //ms
            EDS: {}, // EDS data
            inputs: [],
            outputs: [],
            implicit: {
                connectionInfo: {},
                session: null,
                connected: false,
                receiving: false,
                rawInput: null,
                rawOutput: null,
                inputSequence: null,
                inputLength: null,
                outputInterval: null
            }
        };

        this.workers = {
            read: new Queue(compare, queue_max_size),
            write: new Queue(compare, queue_max_size),
            group: new Queue(compare, queue_max_size),
            io: new Queue(compare, queue_max_size),
        };
    }

    // region Property Definitions
    /**
     * Returns the Scan Rate of Subscription Tags
     *
     * @memberof Controller
     * @returns {number} ms
     */
    get scan_rate() {
        return this.state.scan_rate;
    }

    /**
     * Sets the Subsciption Group Scan Rate
     *
     * @memberof Controller
     */
    set scan_rate(rate) {
        if (typeof rate !== "number") throw new Error("scan_rate must be of Type <number>");
        this.state.scan_rate = Math.trunc(rate);
    }

    /**
     * Get the status of Scan Group
     *
     * @readonly
     * @memberof Controller
     */
    get scanning() {
        return this.state.scanning;
    }

    /**
     * Gets the Controller Properties Object
     *
     * @readonly
     * @memberof Controller
     * @returns {object}
     */
    get properties() {
        return this.state.controller;
    }

    /**
     * Fetches the last timestamp retrieved from the controller
     * in human readable form
     *
     * @readonly
     * @memberof Controller
     */
    get time() {
        return dateFormat(this.state.controller.time, "mmmm dd, yyyy - hh:MM:ss TT");
    }
    // endregion

    // region Public Method Definitions
    /**
     * Initializes Session with Desired IP Address
     * and Returns a Promise with the Established Session ID
     *
     * @override
     * @param {string} IP_ADDR - IPv4 Address (can also accept a FQDN, provided port forwarding is configured correctly.)
     * @param {number} SLOT - Controller Slot Number (0 if CompactLogix)
     * @returns {Promise}
     * @memberof ENIP
     */
    async connect(IP_ADDR, EDS_LOCATION = 0, SLOT = 0) {
        const { PORT } = CIP.EPATH.segments;
        const BACKPLANE = 1;

        this.state.controller.slot = SLOT;
        this.state.controller.path = PORT.build(BACKPLANE, SLOT);

        const sessid = await super.connect(IP_ADDR);
        this.ip_address = IP_ADDR;

        if (!sessid) throw new Error("Failed to Register Session with Controller");

        this._initializeControllerEventHandlers();

        // If EDS file is supplied, parse it
        if (EDS_LOCATION != 0) {
            //TODO: check EDS file exists
            this._initializeEDS(EDS_LOCATION);
        }

        // Fetch Controller Properties and Wall Clock
        //await this.readControllerProps();
    }

    /**
     * Writes Ethernet/IP Data to Socket as an Unconnected Message
     * or a Transport Class 1 Datagram
     *
     * NOTE: Cant Override Socket Write due to net.Socket.write
     *        implementation. =[. Thus, I am spinning up a new Method to
     *        handle it. Dont Use Enip.write, use this function instead.
     *
     * @override
     * @param {buffer} data - Message Router Packet Buffer
     * @param {boolean} [connected=false]
     * @param {number} [timeout=10] - Timeoue (sec)
     * @param {function} [cb=null] - Callback to be Passed to Parent.Write()
     * @memberof ENIP
     */
    write_cip(data, connected = false, timeout = 10, cb = null) {
        const { UnconnectedSend } = CIP;
        const msg = UnconnectedSend.build(data, this.state.controller.path);

        //TODO: Implement Connected Version
        super.write_cip(msg, connected, timeout, cb);
    }    

    /**
     * Starts an implicit connection 
     * @param {string} inputAssem - assembly for inputs as given on EDS (ex: Assem1)
     * @param {string} outputAssem - assembly for outputs as given on EDS (ex: Assem1)
     * @param {*} cycle_time 
     * @param {*} timeout 
     * @param {*} cb 
     * @returns 
     */
    start_implicit(input_assem, output_assem, cycle_time, timeout = 10, cb = null) {

        // Throw error if EDS hasn't been supplied
        if (!this.EDS) {
            throw new Error("Must have EDS data to start implicit messaging");
        }

        let params = this.EDS.Params;
        let bufferIndex = 0;
        let currentParam = {
            Param: null,
            ByteSize: null,
            Name: null,
            Value: null,
            Index: null
        };

        // Setup outputs for implicit messages
        let index = this.EDS.Assembly.findIndex(x => x.Assem == output_assem);

        if (index < 0) {
            throw new Error("Output assembly not found!"); 
        }

        let outputAssem = this.EDS.Assembly[index];
        this.outputs = outputAssem.Data.Members.map( (element) => {
            if (element.Param == "Padding") {
                currentParam = {
                    Param: element.Param,
                    ByteSize: element.Size/8,
                    Type: null,
                    Name: "Padding",
                    Value: null,
                    Index: bufferIndex
                };
            }
            else {
                let paramData = params.find(x => x.Param == element.Param);
                let paramName = paramData.Data.Name.replace(/\s/g, "");  // Remove any whitespace

                currentParam = {
                    Param: element.Param,
                    ByteSize: element.Size / 8,
                    Type: Number(paramData.Data.DataType),
                    Name: paramName,
                    Value: null,
                    Index: bufferIndex
                };
            }
            bufferIndex += element.Size / 8;
            return currentParam;
        });

        // Setup inputs for implicit messages
        index = this.EDS.Assembly.findIndex(x => x.Assem == input_assem);
        bufferIndex = 0;
        currentParam = {
            Param: null,
            ByteSize: null,
            Name: null,
            Value: null,
            Index: null
        };

        if (index < 0) {
            throw new Error("Input assembly not found!"); 
        }

        let inputAssem = this.EDS.Assembly[index];
        this.state.inputs = inputAssem.Data.Members.map( (element) => {
            if (element.Param == "Padding") {
                currentParam = {
                    Param: element.Param,
                    ByteSize: element.Size/8,
                    Type: null,
                    Name: "Padding",
                    Value: null,
                    Index: bufferIndex
                };
            }
            else {
                let paramData = params.find(x => x.Param == element.Param);
                let paramName = paramData.Data.Name.replace(/\s/g, "");  // Remove any whitespace
                // Check if this parameter name exists on outputs, if so mark it as such
                let pairedOutputIndex = this.state.outputs.findIndex(element => element.Name = paramName);

                currentParam = {
                    Param: element.Param,
                    ByteSize: element.Size / 8,
                    Type: Number(paramData.Data.DataType),
                    Name: paramName,
                    Value: null,
                    Index: bufferIndex,
                    pairedOutputIndex: (pairedOutputIndex > -1) ? pairedOutputIndex : null
                };
            }
            bufferIndex += element.Size / 8;
            return currentParam;
        });

        // Schedule the implicit connection
        this._start_implicit(cycle_time);
        return;
        
        /* return this.workers.io.schedule(this._start_implicit.bind(this), [cycle_time], {
            priority: 1,
            timestamp: new Date()
        }); */
    }

    stopImplicit() {

    }

    /**
     * Reads Controller Identity Object
     *
     * @memberof Controller
     * @returns {Promise}
     */
    async readControllerProps() {
        const { GET_ATTRIBUTE_ALL } = CIP.MessageRouter.services;
        const { LOGICAL } = CIP.EPATH.segments;

        // Build Identity Object Logical Path Buffer
        const identityPath = Buffer.concat([
            LOGICAL.build(LOGICAL.types.ClassID, 0x01), // Identity Object (0x01)
            LOGICAL.build(LOGICAL.types.InstanceID, 0x01) // Instance ID (0x01)
        ]);

        // Message Router to Embed in UCMM
        const MR = CIP.MessageRouter.build(GET_ATTRIBUTE_ALL, identityPath, []);

        this.write_cip(MR);

        const readPropsErr = new Error("TIMEOUT occurred while reading Controller Props.");

        // Wait for Response
        const data = await promiseTimeout(
            new Promise((resolve, reject) => {
                this.on("Get Attribute All", (err, data) => {
                    if (err) reject(err);
                    resolve(data);
                });
            }),
            10000,
            readPropsErr
        );

        this.removeAllListeners("Get Attribute All");

        // Parse Returned Buffer
        this.state.controller.serial_number = data.readUInt32LE(10);

        const nameBuf = Buffer.alloc(data.length - 15);
        data.copy(nameBuf, 0, 15);

        this.state.controller.name = nameBuf.toString("utf8");

        const major = data.readUInt8(6);
        const minor = data.readUInt8(7);
        this.state.controller.version = `${major}.${minor}`;

        let status = data.readUInt16LE(8);
        this.state.controller.status = status;

        status &= 0x0ff0;
        this.state.controller.faulted = (status & 0x0f00) === 0 ? false : true;
        this.state.controller.minorRecoverableFault = (status & 0x0100) === 0 ? false : true;
        this.state.controller.minorUnrecoverableFault = (status & 0x0200) === 0 ? false : true;
        this.state.controller.majorRecoverableFault = (status & 0x0400) === 0 ? false : true;
        this.state.controller.majorUnrecoverableFault = (status & 0x0800) === 0 ? false : true;

        status &= 0x0f00;
        this.state.controller.io_faulted = status >> 4 === 2 ? true : false;
        this.state.controller.faulted = status >> 4 === 2 ? true : this.state.controller.faulted;
    }

    /**
     * Reads the Controller Wall Clock Object
     *
     * @memberof Controller
     * @returns {Promise}
     */
    async readWallClock() {
        if (this.state.controller.name.search("L8") === -1)
            throw new Error("WallClock Utilities are not supported by this controller type");

        const { GET_ATTRIBUTE_SINGLE } = CIP.MessageRouter.services;
        const { LOGICAL } = CIP.EPATH.segments;

        // Build Identity Object Logical Path Buffer
        const identityPath = Buffer.concat([
            LOGICAL.build(LOGICAL.types.ClassID, 0x8b), // WallClock Object (0x8B)
            LOGICAL.build(LOGICAL.types.InstanceID, 0x01), // Instance ID (0x01)
            LOGICAL.build(LOGICAL.types.AttributeID, 0x05) // Local Time Attribute ID
        ]);

        // Message Router to Embed in UCMM
        const MR = CIP.MessageRouter.build(GET_ATTRIBUTE_SINGLE, identityPath, []);

        this.write_cip(MR);

        const readPropsErr = new Error("TIMEOUT occurred while reading Controller Clock.");

        // Wait for Response
        const data = await promiseTimeout(
            new Promise((resolve, reject) => {
                this.on("Get Attribute Single", (err, data) => {
                    if (err) reject(err);
                    resolve(data);
                });
            }),
            10000,
            readPropsErr
        );

        this.removeAllListeners("Get Attribute Single");

        // Parse Returned Buffer
        let wallClockArray = [];
        for (let i = 0; i < 7; i++) {
            wallClockArray.push(data.readUInt32LE(i * 4));
        }

        // Massage Data to JS Date Friendly Format
        wallClockArray[6] = Math.trunc(wallClockArray[6] / 1000); // convert to ms from us
        wallClockArray[1] -= 1; // month is 0-based

        const date = new Date(...wallClockArray);
        this.state.controller.time = date;
    }

    /**
     * Write to PLC Wall Clock
     *
     * @param {Date} [date=new Date()]
     * @memberof Controller
     * @returns {Promise}
     */
    async writeWallClock(date = new Date()) {
        if (this.state.controller.name.search("L8") === -1)
            throw new Error("WallClock Utilities are not supported by this controller type");

        const { SET_ATTRIBUTE_SINGLE } = CIP.MessageRouter.services;
        const { LOGICAL } = CIP.EPATH.segments;
        const arr = [];

        arr.push(date.getFullYear());
        arr.push(date.getMonth() + 1);
        arr.push(date.getDate());
        arr.push(date.getHours());
        arr.push(date.getMinutes());
        arr.push(date.getSeconds());
        arr.push(date.getMilliseconds() * 1000);

        let buf = Buffer.alloc(28);
        for (let i = 0; i < 7; i++) {
            buf.writeUInt32LE(arr[i], 4 * i);
        }

        // Build Identity Object Logical Path Buffer
        const identityPath = Buffer.concat([
            LOGICAL.build(LOGICAL.types.ClassID, 0x8b), // WallClock Object (0x8B)
            LOGICAL.build(LOGICAL.types.InstanceID, 0x01), // Instance ID (0x01)
            LOGICAL.build(LOGICAL.types.AttributeID, 0x05) // Local Time Attribute ID
        ]);

        // Message Router to Embed in UCMM
        const MR = CIP.MessageRouter.build(SET_ATTRIBUTE_SINGLE, identityPath, buf);

        this.write_cip(MR);

        const writeClockErr = new Error("TIMEOUT occurred while writing Controller Clock.");

        // Wait for Response
        await promiseTimeout(
            new Promise((resolve, reject) => {
                this.on("Set Attribute Single", (err, data) => {
                    if (err) reject(err);
                    resolve(data);
                });
            }),
            10000,
            writeClockErr
        );

        this.removeAllListeners("Set Attribute Single");

        this.state.controller.time = date;
    }

    /**
     * Reads Value of Tag and Type from Controller
     *
     * @param {Tag} tag - Tag Object to Write
     * @param {number} [size=null]
     * @returns {Promise}
     * @memberof Controller
     */
    readTag(tag, size = null) {
        return this.workers.read.schedule(this._readTag.bind(this), [tag, size], {
            priority: 1,
            timestamp: new Date()
        });
    }

    /**
     * Writes value to Tag
     *
     * @param {Tag} tag - Tag Object to Write
     * @param {number|boolean|object|string} [value=null] - If Omitted, Tag.value will be used
     * @param {number} [size=0x01]
     * @returns {Promise}
     * @memberof Controller
     */
    writeTag(tag, value = null, size = 0x01) {
        return this.workers.write.schedule(this._writeTag.bind(this), [tag, value, size], {
            priority: 1,
            timestamp: new Date()
        });
    }

    /**
     * Reads All Tags in the Passed Tag Group
     *
     * @param {TagGroup} group
     * @returns {Promise}
     * @memberof Controller
     */
    readTagGroup(group) {
        return this.workers.group.schedule(this._readTagGroup.bind(this), [group], {
            priority: 1,
            timestamp: new Date()
        });
    }

    /**
     * Writes to Tag Group Tags
     *
     * @param {TAgGroup} group
     * @returns {Promise}
     * @memberof Controller
     */
    writeTagGroup(group) {
        return this.workers.group.schedule(this._writeTagGroup.bind(this), [group], {
            priority: 1,
            timestamp: new Date()
        });
    }

    /**
     * Adds Tag to Subscription Group
     *
     * @param {Tagany} tag
     * @memberof Controller
     */
    subscribe(tag) {
        this.state.subs.add(tag);
    }

    /**
     * Begin Scanning Subscription Group
     *
     * @memberof Controller
     */
    async scan() {
        this.state.scanning = true;

        while (this.state.scanning) {
            await this.workers.group
                .schedule(this._readTagGroup.bind(this), [this.state.subs], {
                    priority: 10,
                    timestamp: new Date()
                })
                .catch(e => {
                    if (e.message) {
                        throw new Error(`<SCAN_GROUP>\n ${e.message}`);
                    } else {
                        throw e;
                    }
                });

            await this.workers.group
                .schedule(this._writeTagGroup.bind(this), [this.state.subs], {
                    priority: 10,
                    timestamp: new Date()
                })
                .catch(e => {
                    if (e.message) {
                        throw new Error(`<SCAN_GROUP>\n ${e.message}`);
                    } else {
                        throw e;
                    }
                });

            await delay(this.state.scan_rate);
        }
    }

    /**
     * Pauses Scanning of Subscription Group
     *
     * @memberof Controller
     */
    pauseScan() {
        this.state.scanning = false;
    }

    /**
     * Iterates of each tag in Subscription Group
     *
     * @param {function} callback
     * @memberof Controller
     */
    forEach(callback) {
        this.state.subs.forEach(callback);
    }
    // endregion

    // region Private Methods
    /**
     * Initialized Controller Specific Event Handlers
     *
     * @memberof Controller
     */
    _initializeControllerEventHandlers() {
        this.on("SendRRData Received", this._handleSendRRDataReceived);
    }

    async _initializeEDS(file_location) {
        this.EDS = await readEDS(file_location);
        // Setup inputs and output
    }

    async _start_implicit(cycle_time, connected = false, timeout = 10, cb = null) {
        const { ForwardOpen } = CIP;
        const msg = ForwardOpen.build();

        super.write_cip(msg, connected, timeout, cb);

        const forwardOpenErr = new Error("TIMEOUT occurred during forward open.");

        // Wait for Response
        const data = await promiseTimeout(
            new Promise((resolve, reject) => {
                this.on("Forward Open", (err, data) => {
                    if (err) reject(err);
                    resolve(data);
                });
            }),
            10000,
            forwardOpenErr
        );

        this.removeAllListeners("Forward Open");
        this.state.implicit.connectionInfo = ForwardOpen.parse(data);
        console.info(`Connection ID ${this.state.implicit.connectionInfo.to_connectionId} successfully established!`);

        // Start UDP socket to receive I/O messaging datagrams
        this.state.implicit.session = dgram.createSocket("udp4");
        console.info("Connecting Implicit IO via UDP...");

        // emits when any error occurs
        this.state.implicit.session.on("error", function (error) {
            console.info("Implicit IO Server Error: " + error);
            this.state.implicit.connected = false;
            this.state.implicit.receiving = false;
            this.state.implicit.session.close();
        });

        this.state.implicit.session.on("close", () => {
            console.info("Implicit IO Server Closed");
            this.state.implicit.connected = false;
            this.state.implicit.receiving = false;
        });

        this.state.implicit.session.on("listening", () => {
            const address = this.state.implicit.session.address();
            this.state.implicit.connected = true;
            console.info(`Implicit IO Server listening on UDP port ${address.address}:${address.port}`);

            // Start input timeout (this will reset after each received message)
            /* this.state.implicit.inputTimer = this.setTimeout(() => {
                
            }, 100000); */

            // Start sending output at specified O->T API from Forward Open response
            // Check for at least one received inputs so duplicate parameters have been matched
            /* this.state.implicit.outputInterval = ci.setCorrectingInterval( () => {
                // Send stored rawOutput
                this.state.implicit.session.send(this.state.implicit.rawOutput);

            },this.state.implicit.connectionInfo.ot_api); */
        });

        this.state.implicit.session.on("message", (msg, rinfo) => {
            //TODO: convert to streams
            console.info(`Implicit IO Message from ${rinfo.address}:${rinfo.port}: ${msg.toString("hex")}`);

            if (!this.state.implicit.receiving) {
                // Update state variables for tracking
                this.state.implicit.rawInput = msg;
                this.state.implicit.inputLength = msg.readUInt16LE(16) - 2; // subtract 2 for sequence number
                this.state.implicit.rawInput =  Buffer.alloc(this.state.implicit.inputLength); 
                
            }
            // Get new data from incoming buffer
            let newData = Buffer.alloc(this.state.implicit.inputLength);
            msg.copy(newData,0,20,20+this.state.implicit.inputLength);
            console.debug("DATA: ",newData.toString("hex"));

            this._processImplicitInput(newData);

            if (!this.state.implicit.receiving) {
                // Update receiving state variable so outputs can be sent
                // this way any paired outputs will not get overridden by null values
                this.state.implicit.receiving = true; 
            }

            return;
        });

        // Bind the UDP port to start listening
        this.state.implicit.session.bind(config.UDP_PORT);

    }

    async _processImplicitInput(new_data) {
        // If data hasn't changed from last, do not process
        if (new_data.equals(this.state.implicit.rawInput)) { return; }

        let dataIndex = 0;

        // Check which inputs changed, update the state parameters, and emit events for each that changed
        for (const pair of new_data.entries()) {

            // Compare to dataIndex, used to skip ahead to the next data once size is known
            if (pair[0] != dataIndex) { continue; }

            // Test if new data is different from last
            if (pair[1] == this.state.implicit.rawInput[pair[0]]) { continue; }

            // Find corresponding parameter for given buffer index and update
            let inputIndex = this.state.inputs.findIndex((element) => element.Index == pair[0]);
            let inputItem = this.state.inputs[inputIndex];

            // Update value based on data type
            /* eslint-disable indent */
            switch (inputItem.Type) {
                case SINT:
                    inputItem.Value = new_data.readInt8(pair[0]);
                    dataIndex += 1;
                    break;
                case INT:
                    inputItem.Value = new_data.readInt16LE(pair[0]);
                    dataIndex += 2;
                    break;
                case DINT:
                    inputItem.Value = new_data.readInt32LE(pair[0]);
                    dataIndex += 4;
                    break;
                case UDINT:
                    inputItem.Value = new_data.readUInt32LE(pair[0]);
                    dataIndex += 4;
                    break;
                case REAL:
                    inputItem.Value = new_data.readFloatLE(pair[0]);
                    dataIndex += 4;
                    break;
                case BIT_STRING:
                    inputItem.Value.alloc(inputItem.ByteSize);
                    new_data.copy(inputItem.Value, 0, pair[0], pair[0] + inputItem.ByteSize);
                    dataIndex += inputItem.ByteSize;
                    break;
                case BOOL:
                    inputItem.Value = new_data.readUInt8(pair[0]) !== 0;
                    dataIndex += 1;
                    break;
                default:
                    throw new Error(
                        `Unrecognized Type Passed: ${inputItem.Type}`
                    );
            }
            /* eslint-enable indent */

            // Emit event for listeners of this parameter (use controller.on)
            this.emit(inputItem.Name, inputItem.Value);

            // Update state input
            this.state.inputs[inputIndex] = inputItem;

            // Update paired output if exists
            if (inputItem.pairedOutputIndex !== null) {
                this.state.outputs[inputItem.pairedOutputIndex].Value = inputItem.Value;
            }
            console.debug(inputItem.ByteSize);
        }

        // Copy new data to rawinput buffer
        new_data.copy(this.state.implicit.rawInput, 0, 0);
        return;
    }

    _setOutput(outputIndex,newValue) {

        // Check if output is index number or variable name
        if (typeof outputIndex !== "number") {
            throw new Error("Output index must be of type number");
        }    

        // Find buffer index
        let bufferIndex = this.state.outputs[outputIndex].Index;

        // Update state output
        this.state.outputs[outputIndex].Value = newValue;

        // Update raw buffer
        /* eslint-disable indent */
        switch (this.state.outputs[outputIndex].Type) {
            case SINT:
                this.state.implicit.rawOutput.writeInt8(newValue,bufferIndex);
                break;
            case INT:
                this.state.implicit.rawOutput.writeInt16LE(newValue,bufferIndex);
                break;
            case DINT:
                this.state.implicit.rawOutput.writeInt32LE(newValue,bufferIndex);
                break;
            case UDINT:
                this.state.implicit.rawOutput.writeUInt32LE(newValue,bufferIndex);
                break;
            case REAL:
                this.state.implicit.rawOutput.writeFloatLE(newValue,bufferIndex);
                break;
            case BIT_STRING:
                //TODO: not yet working
                throw new Error("Not Yet Implemented");
                /* this.state.outputs[outputIndex].Value.alloc(inputItem.ByteSize);
                new_data.copy(inputItem.Value, 0, pair[0], pair[0] + inputItem.ByteSize);
                break; */
            case BOOL:
                this.state.implicit.rawOutput.writeUInt8(newValue,bufferIndex);
                break;
            default:
                throw new Error(
                    `Unrecognized Type Passed: ${this.state.outputs[outputIndex].Type}`
                );
        }
        /* eslint-enable indent */

        return;
    }

    _setOutputByName(outputName,newValue) {
        let index;

        if (typeof outputName !== "string" || !(outputName instanceof String)) {
            throw new Error("Output index must be of type number");  
        }

        index = this.state.outputs.findIndex(element => element.Name == outputName);

        this._setOutput(index,newValue);
        return;
    }

    /**
     * Reads Value of Tag and Type from Controller
     *
     * @param {Tag} tag - Tag Object to Write
     * @param {number} [size=null]
     * @returns {Promise}
     * @memberof Controller
     */
    async _readTag(tag, size = null) {
        const MR = tag.generateReadMessageRequest(size);

        this.write_cip(MR);

        const readTagErr = new Error(`TIMEOUT occurred while writing Reading Tag: ${tag.name}.`);

        // Wait for Response
        const data = await promiseTimeout(
            new Promise((resolve, reject) => {
                this.on("Read Tag", (err, data) => {
                    if (err) reject(err);
                    resolve(data);
                });
            }),
            10000,
            readTagErr
        );

        this.removeAllListeners("Read Tag");

        tag.parseReadMessageResponse(data);
    }

    /**
     * Writes value to Tag
     *
     * @param {Tag} tag - Tag Object to Write
     * @param {number|boolean|object|string} [value=null] - If Omitted, Tag.value will be used
     * @param {number} [size=0x01]
     * @returns {Promise}
     * @memberof Controller
     */
    async _writeTag(tag, value = null, size = 0x01) {
        const MR = tag.generateWriteMessageRequest(value, size);

        this.write_cip(MR);

        const writeTagErr = new Error(`TIMEOUT occurred while writing Writing Tag: ${tag.name}.`);

        // Wait for Response
        await promiseTimeout(
            new Promise((resolve, reject) => {

                // Full Tag Writing
                this.on("Write Tag", (err, data) => {
                    if (err) reject(err);

                    tag.unstageWriteRequest();
                    resolve(data);
                });

                // Masked Bit Writing
                this.on("Read Modify Write Tag", (err, data) => {
                    if (err) reject(err);

                    tag.unstageWriteRequest();
                    resolve(data);
                });
            }),
            10000,
            writeTagErr
        );

        this.removeAllListeners("Write Tag");
        this.removeAllListeners("Read Modify Write Tag");
    }

    /**
     * Reads All Tags in the Passed Tag Group
     *
     * @param {TagGroup} group
     * @returns {Promise}
     * @memberof Controller
     */
    async _readTagGroup(group) {
        const messages = group.generateReadMessageRequests();

        const readTagGroupErr = new Error("TIMEOUT occurred while writing Reading Tag Group.");

        // Send Each Multi Service Message
        for (let msg of messages) {
            this.write_cip(msg.data);

            // Wait for Controller to Respond
            const data = await promiseTimeout(
                new Promise((resolve, reject) => {
                    this.on("Multiple Service Packet", (err, data) => {
                        if (err) reject(err);

                        resolve(data);
                    });
                }),
                10000,
                readTagGroupErr
            );

            this.removeAllListeners("Multiple Service Packet");

            // Parse Messages
            group.parseReadMessageResponses(data, msg.tag_ids);
        }
    }

    /**
     * Writes to Tag Group Tags
     *
     * @param {TagGroup} group
     * @returns {Promise}
     * @memberof Controller
     */
    async _writeTagGroup(group) {
        const messages = group.generateWriteMessageRequests();

        const writeTagGroupErr = new Error("TIMEOUT occurred while writing Writing Tag Group.");

        // Send Each Multi Service Message
        for (let msg of messages) {
            this.write_cip(msg.data);

            // Wait for Controller to Respond
            const data = await promiseTimeout(
                new Promise((resolve, reject) => {
                    this.on("Multiple Service Packet", (err, data) => {
                        if (err) reject(err);

                        resolve(data);
                    });
                }),
                10000,
                writeTagGroupErr
            );

            this.removeAllListeners("Multiple Service Packet");

            group.parseWriteMessageRequests(data, msg.tag_ids);
        }
    }
    // endregion

    // region Event Handlers
    /**
     * @typedef EncapsulationData
     * @type {Object}
     * @property {number} commandCode - Ecapsulation Command Code
     * @property {string} command - Encapsulation Command String Interpretation
     * @property {number} length - Length of Encapsulated Data
     * @property {number} session - Session ID
     * @property {number} statusCode - Status Code
     * @property {string} status - Status Code String Interpretation
     * @property {number} options - Options (Typically 0x00)
     * @property {Buffer} data - Encapsulated Data Buffer
     */
    /*****************************************************************/

    /**
     * @typedef MessageRouter
     * @type {Object}
     * @property {number} service - Reply Service Code
     * @property {number} generalStatusCode - General Status Code (Vol 1 - Appendix B)
     * @property {number} extendedStatusLength - Length of Extended Status (In 16-bit Words)
     * @property {Array} extendedStatus - Extended Status
     * @property {Buffer} data - Status Code
     */
    /*****************************************************************/

    /**
     * Handles SendRRData Event Emmitted by Parent and Routes
     * incoming Message
     *
     * @param {Array} srrd - Array of Common Packet Formatted Objects
     * @memberof Controller
     */
    _handleSendRRDataReceived(srrd) {
        const { service, generalStatusCode, extendedStatus, data } = CIP.MessageRouter.parse(
            srrd[1].data
        );

        const {
            GET_ATTRIBUTE_SINGLE,
            GET_ATTRIBUTE_ALL,
            SET_ATTRIBUTE_SINGLE,
            READ_TAG,
            READ_TAG_FRAGMENTED,
            WRITE_TAG,
            WRITE_TAG_FRAGMENTED,
            READ_MODIFY_WRITE_TAG,
            MULTIPLE_SERVICE_PACKET
        } = CIP.MessageRouter.services;

        const { FORWARD_OPEN_SERVICE } = CIP.ForwardOpen;

        let error = generalStatusCode !== 0 ? { generalStatusCode, extendedStatus } : null;

        // Route Incoming Message Responses
        /* eslint-disable indent */
        switch (service - 0x80) {
            case GET_ATTRIBUTE_SINGLE:
                this.emit("Get Attribute Single", error, data);
                break;
            case GET_ATTRIBUTE_ALL:
                this.emit("Get Attribute All", error, data);
                break;
            case SET_ATTRIBUTE_SINGLE:
                this.emit("Set Attribute Single", error, data);
                break;
            case READ_TAG:
                this.emit("Read Tag", error, data);
                break;
            case READ_TAG_FRAGMENTED:
                this.emit("Read Tag Fragmented", error, data);
                break;
            case WRITE_TAG:
                this.emit("Write Tag", error, data);
                break;
            case WRITE_TAG_FRAGMENTED:
                this.emit("Write Tag Fragmented", error, data);
                break;            
            case READ_MODIFY_WRITE_TAG:
                this.emit("Read Modify Write Tag", error, data);
                break;
            case MULTIPLE_SERVICE_PACKET: {
                // If service errored then propogate error
                if (error) {
                    this.emit("Multiple Service Packet", error, data);
                    break;
                }

                // Get Number of Services to be Enclosed
                let services = data.readUInt16LE(0);
                let offsets = [];
                let responses = [];

                // Build Array of Buffer Offsets
                for (let i = 0; i < services; i++) {
                    offsets.push(data.readUInt16LE(i * 2 + 2));
                }

                // Gather Messages within Buffer
                for (let i = 0; i < offsets.length - 1; i++) {
                    const length = offsets[i + 1] - offsets[i];

                    let buf = Buffer.alloc(length);
                    data.copy(buf, 0, offsets[i], offsets[i + 1]);

                    // Parse Message Data
                    const msgData = CIP.MessageRouter.parse(buf);

                    if (msgData.generalStatusCode !== 0) {
                        error = {
                            generalStatusCode: msgData.generalStatusCode,
                            extendedStatus: msgData.extendedStatus
                        };
                    }

                    responses.push(msgData);
                }

                // Handle Final Message
                const length = data.length - offsets[offsets.length - 1];

                let buf = Buffer.alloc(length);
                data.copy(buf, 0, offsets[offsets.length - 1]);

                const msgData = CIP.MessageRouter.parse(buf);

                if (msgData.generalStatusCode !== 0) {
                    error = {
                        generalStatusCode: msgData.generalStatusCode,
                        extendedStatus: msgData.extendedStatus
                    };
                }

                responses.push(msgData);

                this.emit("Multiple Service Packet", error, responses);
                break;
            }
            case FORWARD_OPEN_SERVICE: {
                this.emit("Forward Open", error, data);
                break;
            }
            default:
                this.emit("Unknown Reply", { generalStatusCode: 0x99, extendedStatus: [] }, data);
                break;
        }
        /* eslint-enable indent */
    }

    // _handleSendUnitDataReceived(data) {
    //     // TODO: Implement when ready for Connected Messaging
    // }

    // _handleSessionRegistrationFailed(error) {
    //     // TODO: Implement Handler if Necessary
    // }
    // endregion
}

module.exports = Controller;
