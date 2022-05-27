const { ENIP, CIP } = require("../enip");
const dateFormat = require("dateformat");
const TagGroup = require("../tag-group");
const { delay, promiseTimeout } = require("../utilities");
const Queue = require("task-easy");
const dgram =require("dgram");
const config = require("../config");
const { readEDS } = require("../eds-parser");
const { Types } = require("../enip/cip/data-types");
const { SINT, UINT, INT, DINT, UDINT, REAL, BOOL, BIT_STRING } = Types;
const ci = require("correcting-interval");
//const structuredClone = require("@ungap/structured-clone");

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
                sending: false,
                rawInput: null,
                rawOutput: null,
                inputSequence: null,
                outputSequence: 0,
                inputLength: null,
                outputLength: null,
                outputInterval: null,
                cycleTime: null,
                timeout: null,
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
     * @param {*} EDS_LOCATION - location of EDS file for parsing
     * @param {number} SLOT - Controller Slot Number (0 if CompactLogix)
     * @returns {Promise}
     * @memberof ENIP
     */
    async connect(IP_ADDR, EDS_LOCATION = 0, SLOT = 0) {
        const { PORT } = CIP.EPATH.segments;
        const BACKPLANE = 1;

        // If EDS file is supplied, parse it
        if (EDS_LOCATION != 0 && !this.EDS) {
            //TODO: check EDS file exists
            this._initializeEDS(EDS_LOCATION);
        }

        this.state.controller.slot = SLOT;
        this.state.controller.path = PORT.build(BACKPLANE, SLOT);
        this.state.ip_address = IP_ADDR;
        let sessid;

        try {
            sessid = await super.connect(IP_ADDR);
        } catch(err) {
            throw new Error("Failed to Register Session with Controller");
        }

        if (!sessid) throw new Error("Failed to Register Session with Controller");

        this._initializeControllerEventHandlers();

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
     * @returns 
     */
    async start_implicit(input_assem, output_assem, cycle_time = 1000, timeout = 2000) {
        this.state.implicit.cycleTime = cycle_time;
        this.state.implicit.timeout = timeout;

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

        /////////////////////////////////////////////////////////////////////////////////
        // Setup outputs for implicit messages
        /////////////////////////////////////////////////////////////////////////////////
        this.state.outputs = [];
        let index = this.EDS.Assembly.findIndex(x => x.Assem == output_assem);  //Find index of output assem
        if (index < 0) {
            throw new Error("Output assembly not found!"); 
        }
        let outputAssem = this.EDS.Assembly[index];
        outputAssem.Data.Members.forEach( (element) => {
            let paramData;
            let paramName;
            if (element.Param == "Padding") {
                currentParam = {
                    Param: element.Param,
                    ByteSize: element.Size/8,
                    Type: null,
                    Name: "Padding",
                    Value: null,
                    Index: bufferIndex,
                    //pairedOutputIndex: null,
                    tag: []
                };
            }
            else {
                paramData = params.find(x => x.Param == element.Param);
                paramName = paramData.Data.Name.replace(/\s/g, "");  // Remove any whitespace
                // Check if this parameter name exists on outputs, if so mark it as such
                //let pairedOutputIndex = this.state.outputs.findIndex(element => element.Name == paramName);

                currentParam = {
                    Param: element.Param,
                    ByteSize: element.Size / 8,
                    Type: Number(paramData.Data.DataType),
                    Name: paramName,
                    Value: 0,
                    Index: bufferIndex,
                    //pairedOutputIndex: (pairedOutputIndex > -1) ? pairedOutputIndex : null,
                    tag: []
                };
            }
            // If bit string then allocate bit and tag arrays
            if (currentParam.Type === BIT_STRING) {
                currentParam.ParentName = currentParam.Name;

                // If the bit string has enumerated values,
                // create an entry for each
                if (paramData.Enum !== undefined) {
                    if (paramData.Enum.length == 1) {
                        let currentItem = paramData.Enum[0];
                        let thisItem = structuredClone(currentParam);   //Using structured clone to remove reference to origin object
                        let bitSize = element.Size;
                        thisItem.Name = currentItem.value;
                        thisItem.BitIndex = parseInt(currentItem.index,10);
                        thisItem.BitSize = parseInt(bitSize,10); 
                        this.state.outputs.push(thisItem);
                    }
                    paramData.Enum.reduce((prevItem,currentItem,currentIndex) => {
                        let thisItem = structuredClone(currentParam);   //Using structured clone to remove reference to origin object
                        let bitSize = currentItem.index - prevItem.index;
                        thisItem.Name = prevItem.value;
                        thisItem.BitIndex = parseInt(prevItem.index,10);
                        thisItem.BitSize = parseInt(bitSize,10); 
                        this.state.outputs.push(thisItem);

                        // If last item, assume it has the same BitSize as previous
                        if (currentIndex == paramData.Enum.length - 1) {
                            thisItem = structuredClone(currentParam);
                            thisItem.Name = currentItem.value;
                            thisItem.BitIndex = parseInt(currentItem.index,10);
                            thisItem.BitSize = parseInt(bitSize,10);
                            this.state.outputs.push(thisItem);
                        }
                        return currentItem;
                    });
                    bufferIndex += currentParam.ByteSize;
                    return;
                }
                for (let i = 0; i < currentParam.ByteSize * 8; i++) {
                    let thisItem = structuredClone(currentParam);
                    thisItem.Name = currentParam.ParentName + "_" + i;     //TODO: remove any numbers from name with regex
                    thisItem.BitIndex = i;
                    thisItem.BitSize = 1;
                    this.state.outputs.push(thisItem);
                }
                bufferIndex += currentParam.ByteSize;
                return;
            }
            bufferIndex += currentParam.ByteSize;
            this.state.outputs.push(currentParam);
            return;
        });
        this.state.implicit.rawOutput = Buffer.alloc(bufferIndex);


        /////////////////////////////////////////////////////////////////////////////////
        // Setup inputs for implicit messages
        /////////////////////////////////////////////////////////////////////////////////
        this.state.inputs = [];
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
        inputAssem.Data.Members.forEach( (element) => {
            let paramData;
            let paramName;
            if (element.Param == "Padding") {
                currentParam = {
                    Param: element.Param,
                    ByteSize: element.Size/8,
                    Type: null,
                    Name: "Padding",
                    Value: null,
                    Index: bufferIndex,
                    //pairedOutputIndex: null,
                    tag: []
                };
            }
            else {
                paramData = params.find(x => x.Param == element.Param);
                paramName = paramData.Data.Name.replace(/\s/g, "");  // Remove any whitespace
                // Check if this parameter name exists on outputs, if so mark it as such
                //let pairedOutputIndex = this.state.outputs.findIndex(element => element.Name == paramName);

                currentParam = {
                    Param: element.Param,
                    ByteSize: element.Size / 8,
                    Type: Number(paramData.Data.DataType),
                    Name: paramName,
                    Value: 0,
                    Index: bufferIndex,
                    //pairedOutputIndex: (pairedOutputIndex > -1) ? pairedOutputIndex : null,
                    tag: []
                };
            }

            // If bit string then allocate bit and tag arrays
            if (currentParam.Type === BIT_STRING) {
                currentParam.ParentName = currentParam.Name;

                // If the bit string has enumerated values,
                // create an entry for each
                if (paramData.Enum !== undefined) {
                    if (paramData.Enum.length == 1) {
                        let currentItem = paramData.Enum[0];
                        let thisItem = structuredClone(currentParam);   //Using structured clone to remove reference to origin object
                        let bitSize = element.Size;
                        thisItem.Name = currentItem.value;
                        thisItem.BitIndex = parseInt(currentItem.index,10);
                        thisItem.BitSize = parseInt(bitSize,10); 
                        this.state.outputs.push(thisItem);
                    }
                    paramData.Enum.reduce((prevItem,currentItem,currentIndex) => {
                        let thisItem = structuredClone(currentParam);   //Using structured clone to remove reference to origin object
                        let bitSize = currentItem.index - prevItem.index;
                        thisItem.Name = prevItem.value;
                        thisItem.BitIndex = parseInt(prevItem.index,10);
                        thisItem.BitSize = parseInt(bitSize,10);  
                        this.state.inputs.push(thisItem);

                        // If last item, assume it has the same BitSize as previous
                        if (currentIndex == paramData.Enum.length - 1) {
                            thisItem = structuredClone(currentParam);
                            thisItem.Name = currentItem.value;
                            thisItem.BitIndex = parseInt(currentItem.index,10);
                            thisItem.BitSize = parseInt(bitSize,10);
                            this.state.inputs.push(thisItem);
                        }
                        return currentItem;
                    });
                    bufferIndex += currentParam.ByteSize;
                    return;
                }

                for (let i = 0; i < currentParam.ByteSize * 8; i++) {
                    let thisItem = structuredClone(currentParam);
                    thisItem.Name = currentParam.ParentName + "_" + i;     //TODO: remove any numbers from name with regex
                    thisItem.BitIndex = i;
                    thisItem.BitSize = 1;
                    this.state.inputs.push(thisItem);
                }
                bufferIndex += currentParam.ByteSize;
                return;
            }
            bufferIndex += currentParam.ByteSize;
            this.state.inputs.push(currentParam);
            return;
        });

        //console.info("Available inputs: ", this.state.inputs);
        //console.info("Available outputs: ", this.state.outputs);

        // Schedule the implicit connection
        await this._start_implicit(cycle_time,timeout);
        return;
        
        /* return this.workers.io.schedule(this._start_implicit.bind(this), [cycle_time], {
            priority: 1,
            timestamp: new Date()
        }); */
    }

    async stop_implicit() {
        // Send FORWARD CLOSE request
        // stop UDP server
        
        if (this.state.implicit.receiving) {
            clearTimeout(this.state.implicit.inputTimer);
            this.state.implicit.session.close();
        }

        if (this.state.implicit.sending) {
            ci.clearCorrectingInterval(this.state.implicit.outputInterval);
        }
        
        this.state.implicit.connected = false;
        this.state.implicit.receiving = false;
        this.state.implicit.sending = false;
        return;
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

    addTag(tag, isInput, isOutput) {
        if (isInput) {
            let inputIndex = this.state.inputs.findIndex(element => element.Name == tag.name);
            let input = this.state.inputs[inputIndex];
            input.tag.push(tag);
            this.state.inputs[inputIndex] = input;
        }

        if (isOutput) {
            let outputIndex = this.state.outputs.findIndex(element => element.Name == tag.name);
            let output = this.state.outputs[outputIndex];
            output.tag.push(tag);
            this.state.outputs[outputIndex] = output;
        }
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

    async _start_implicit(cycle_time=1000, timeout=2000) {
        const { ForwardOpen } = CIP;
        const msg = ForwardOpen.build(cycle_time,timeout);

        super.write_cip(msg);

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
        /* this.state.implicit.session.on("error", function (error) {
            console.info("Implicit IO Server error");
            ci.clearCorrectingInterval(this.state.implicit.outputInterval);
            this.state.implicit.connected = false;
            this.state.implicit.receiving = false;
            this.state.implicit.sending = false;
            this.state.implicit.session.close();
            //this.emit('error')
        }); */

        this.state.implicit.session.on("close", () => {
            console.error("Implicit IO Server Closed");
            console.info("Attempting to reconnect implicit");
            this.stop_implicit();
            //this.emit('error');
        });

        this.state.implicit.session.on("listening", () => {
            const address = this.state.implicit.session.address();
            this.state.implicit.connected = true;
            console.info(`Implicit IO Server listening on UDP port ${address.address}:${address.port}`);

            // Start input timeout (this will reset after each received message)
            this._inputTimeout(timeout);

        });

        this.state.implicit.session.on("message", async (msg) => {
            //TODO: convert to streams
            //console.info(`Implicit IO Message from ${rinfo.address}:${rinfo.port}: ${msg.toString("hex")}`);
            //console.info(`Implicit IO Message from ${rinfo.address}:${rinfo.port}`);

            if (!this.state.implicit.receiving) {
                // Update state variables for tracking
                this.state.implicit.rawInput = msg;
                this.state.implicit.inputLength = msg.readUInt16LE(16) - 2; // subtract 2 for sequence number
                this.state.implicit.rawInput =  Buffer.alloc(this.state.implicit.inputLength); 
            }

            // Get new data from incoming buffer
            let newData = Buffer.alloc(this.state.implicit.inputLength);
            msg.copy(newData,0,20,20+this.state.implicit.inputLength);
            //console.debug("DATA: ",newData.toString("hex"));

            // Clear and re-aply timeout
            clearTimeout(this.state.implicit.inputTimer);
            this._inputTimeout(timeout);

            this._processImplicitInput(newData);

            if (!this.state.implicit.receiving) {
                // Update receiving state variable so outputs can be sent
                // this way any paired outputs will not get overridden by null values
                this.state.implicit.receiving = true;

                this.state.implicit.outputLength = this.state.implicit.rawOutput.length;

                // Start sending output at specified O->T API from Forward Open response
                // Check for at least one received inputs so duplicate parameters have been matched
                this._startSendingOutputs();
            }

            return;
        });

        // Bind the UDP port to start listening
        this.state.implicit.session.bind(config.UDP_PORT);

    }

    async _inputTimeout(timeout = 2000) {
        this.state.implicit.inputTimer = setTimeout(() => {
            console.error("Implicit message timeout");
            this.stop_implicit();
            //TODO: Reconnect handling
            //this.connect(this.state.ip_address)

        }, timeout);
    }

    async _startSendingOutputs() {
        this.state.implicit.outputInterval = ci.setCorrectingInterval(this._sendOutput.bind(this),this.state.implicit.connectionInfo.ot_api);
        return;
    }

    async _sendOutput() {     
        // Package IO message with stored rawOutput
        let buf = Buffer.alloc(18+2+4+this.state.implicit.outputLength);

        // Item Count
        buf.writeUInt16LE(2,0);

        // Type ID Sequenced Address Item (0x8002)
        buf.writeUInt16LE(32770,2);

        // Length
        buf.writeUInt16LE(8,4);

        // Connection ID
        buf.writeUInt32LE(this.state.implicit.connectionInfo.ot_connectionId,6);

        // Sequence Number
        this.state.implicit.outputSequence++;
        if (this.state.implicit.outputSequence > 65535) this.state.implicit.outputSequence = 1;
        buf.writeUInt32LE(this.state.implicit.outputSequence,10);

        // Type ID Connected Data Item (0x00B1)
        buf.writeUInt16LE(177,14);

        // Length
        buf.writeUInt16LE(this.state.implicit.rawOutput.length+2+4,16);

        // CIP Sequence Count
        buf.writeUInt16LE(this.state.implicit.outputSequence-1,18);

        //TODO: this needs to be read from the EDS connection manager section
        //for whether modeless or 32-bit header is expected. same for parsing incoming
        // Add 32-bit header for UR robot
        buf.writeUInt32LE(1,20);

        // Raw output data buffer
        this.state.implicit.rawOutput.copy(buf,24);

        await this.state.implicit.session.send(buf,config.UDP_PORT,this.state.ip_address);
        if (!this.state.implicit.sending) {this.state.implicit.sending = true;}
        //console.debug("Outputs sent!",this.state.implicit.rawOutput.toString("hex"));
        return;
    }

    _processImplicitInput(new_data) {
        // If data hasn't changed from last, do not process
        if (new_data.equals(this.state.implicit.rawInput)) { 
            console.debug("No new data");
            return; 
        }

        // Define block function to use in switch state
        // Used to update a single input
        let updateInput = (input) => {
            //console.debug(`${input.Name} updated to: ${input.Value}`);
            // Emit event for listeners of this parameter
            if (input.tag.length > 0) {
                // emit any events for the change
                input.tag.forEach((tag) => {
                    tag.changed(input.Value);
                });
            }
            return;
        };  

        this.state.inputs.forEach((inputItem) => {

            // Update value based on data type
            /* eslint-disable indent */
            switch (inputItem.Type) {
                case SINT:
                    inputItem.Value = new_data.readInt8(inputItem.Index);
                    // Check if new data matches old from raw input buffer
                    if (inputItem.Value != this.state.implicit.rawInput.readInt8(inputItem.Index)) updateInput(inputItem);
                    break;
                case UINT:
                    inputItem.Value = new_data.readUInt8(inputItem.Index);
                    // Check if new data matches old from raw input buffer
                    if (inputItem.Value != this.state.implicit.rawInput.readUInt8(inputItem.Index)) updateInput(inputItem);
                    break;
                case INT:
                    inputItem.Value = new_data.readInt16LE(inputItem.Index);
                    // Check if new data matches old from raw input buffer
                    if (inputItem.Value != this.state.implicit.rawInput.readInt16LE(inputItem.Index)) updateInput(inputItem);
                    break;
                case DINT:
                    inputItem.Value = new_data.readInt32LE(inputItem.Index);
                    // Check if new data matches old from raw input buffer
                    if (inputItem.Value != this.state.implicit.rawInput.readInt32LE(inputItem.Index)) updateInput(inputItem);
                    break;
                case UDINT:
                    inputItem.Value = new_data.readUInt32LE(inputItem.Index);
                    // Check if new data matches old from raw input buffer
                    if (inputItem.Value != this.state.implicit.rawInput.readUInt32LE(inputItem.Index)) updateInput(inputItem);
                    break;
                case REAL:
                    inputItem.Value = new_data.readFloatLE(inputItem.Index);
                    // Check if new data matches old from raw input buffer
                    if (inputItem.Value != this.state.implicit.rawInput.readFloatLE(inputItem.Index)) updateInput(inputItem);
                    break;
                case BIT_STRING: {
                    // Store this bitstring data from new and old buffers 
                    let newBuf = new_data.subarray(inputItem.Index, inputItem.Index + inputItem.ByteSize);
                    let oldBuf = this.state.implicit.rawInput.subarray(inputItem.Index, inputItem.Index + inputItem.ByteSize);

                    // skip if new equal to old
                    if (newBuf.equals(oldBuf)) break;

                    let oldValue = inputItem.Value;

                    switch (inputItem.BitSize) {
                        case 1:
                            // If boolean (bit size == 1) then just assign the index value
                            inputItem.Value = (newBuf.readInt32LE() & (1 << inputItem.BitIndex)) == 0 ? 0 : 1;
                            break;
                        case 8:
                            inputItem.Value = newBuf.readInt8(inputItem.BitIndex / 8);
                            break;
                        case 16:
                            inputItem.Value = newBuf.readInt16LE(inputItem.BitIndex / 8);
                            break;
                        default:
                            throw new Error(
                                `Bit Parsing error: ${inputItem}`
                            );
                    }

                    // If value updated, report it
                    if (inputItem.Value != oldValue) {
                        updateInput(inputItem);
                    }

                    break;
                }
                case BOOL:
                    inputItem.Value = new_data.readUInt8(inputItem.Index) !== 0;
                    updateInput(inputItem);
                    break;
                case null:
                    // 
                    break;
                default:
                    throw new Error(
                        `Unrecognized Type Passed: ${inputItem.Type}`
                    );
            }
            /* eslint-enable indent */

            return;
        });

        // Copy new data to rawinput buffer
        new_data.copy(this.state.implicit.rawInput, 0, 0);
        return;
    }

    _setOutput(outputIndex,newValue) {

        // Check if output is index number or variable name
        if (typeof outputIndex !== "number") {
            throw new Error(`Output index must be of type number, received: ${outputIndex}`);
        }

        let outputItem = this.state.outputs[outputIndex];

        // Find buffer index
        let bufferIndex = outputItem.Index;

        // Update raw buffer and state output
        /* eslint-disable indent */
        switch (outputItem.Type) {
            case SINT:
                if (typeof newValue !== "number") {
                    throw new Error("Value must be given as a number for type: ", outputItem.Type);
                }
                this.state.implicit.rawOutput.writeInt8(newValue,bufferIndex);
                // Update state output
                outputItem.Value = newValue;
                break;
            case UINT:
                if (typeof newValue !== "number") {
                    throw new Error("Value must be given as a number for type: ", outputItem.Type);
                }
                this.state.implicit.rawOutput.writeUInt8(newValue, bufferIndex);
                // Update state output
                outputItem.Value = newValue;
                break;
            case INT:
                if (typeof newValue !== "number") {
                    throw new Error("Value must be given as a number for type: ", outputItem.Type);
                }
                this.state.implicit.rawOutput.writeInt16LE(newValue,bufferIndex);
                // Update state output
                outputItem.Value = newValue;
                break;
            case DINT:
                if (typeof newValue !== "number") {
                    throw new Error("Value must be given as a number for type: ", outputItem.Type);
                }
                this.state.implicit.rawOutput.writeInt32LE(newValue,bufferIndex);
                // Update state output
                outputItem.Value = newValue;
                break;
            case UDINT:
                if (typeof newValue !== "number") {
                    throw new Error("Value must be given as a number for type: ", outputItem.Type);
                }
                this.state.implicit.rawOutput.writeUInt32LE(newValue,bufferIndex);
                // Update state output
                outputItem.Value = newValue;
                break;
            case REAL:
                if (typeof newValue !== "number") {
                    throw new Error("Value must be given as a number for type: ", outputItem.Type);
                }
                this.state.implicit.rawOutput.writeFloatLE(newValue,bufferIndex);
                // Update state output
                outputItem.Value = newValue;
                break;
            case BIT_STRING: {
                // Store this section of raw buffer to manipulate and eventually return
                let buf = this.state.implicit.rawOutput.subarray(outputItem.Index,outputItem.Index + outputItem.ByteSize);

                switch (outputItem.BitSize) {
                    case 1: {
                        //let newBuf = Buffer.alloc(4);
                        let val = this.state.implicit.rawOutput.readInt32LE(outputItem.Index);
                        // Set value depending on if true (and mask) or false (or mask)
                        buf.writeInt32LE(newValue ? val | (1 << outputItem.BitIndex) : val & ~(1 << outputItem.BitIndex));
                        break;
                    }
                    case 8: 
                        buf.writeInt8(newValue,outputItem.BitIndex);
                        break;
                    case 16:
                        buf.writeInt16LE(newValue,outputItem.BitIndex);
                        break;
                    default:
                        throw new Error(
                            `Bit Parsing error: ${outputItem}`
                        );
                }

                // Update state output
                buf.copy(this.state.implicit.rawOutput, bufferIndex);
                break;
            }
            case BOOL:
                this.state.implicit.rawOutput.writeUInt8(newValue,bufferIndex);
                // Update state output
                outputItem.Value = newValue;
                break;
            default:
                throw new Error(
                    `Unrecognized Type Passed: ${outputItem.Type}`
                );
        }
        /* eslint-enable indent */

        return;
    }

    _setOutputByName(outputName,newValue) {
        let index;

        /* if (typeof outputName !== "string" || !(outputName instanceof String)) {
            throw new Error("Output index must be of type number");  
        } */

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
