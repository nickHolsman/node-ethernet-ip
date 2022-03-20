const { EventEmitter } = require("events");
const crypto = require("crypto");
const { CIP } = require("../enip");
const { Types } = require("../enip/cip/data-types");

// Static Class Property - Tracks Instances
let instances = 0;
class Param extends EventEmitter {
    constructor(controller, paramName, bitIndex = null) {
        super();
        instances++;

        this.name = paramName.replace(/\s/g, ""); //remove whitespace
        this.value = null;
        this.isInput = false;
        this.isOutput = false;
        this.inputIndex = null;
        this.outputIndex = null;
        this.input = null;
        this.output = null;
        this.bitIndex = bitIndex;
        this.timestamp = new Date();
        this.controller = controller;
        
        // Determine if input/output
        let inputIndex = this.controller.state.inputs.findIndex(element => element.Name == this.name);
        let outputIndex = this.controller.state.outputs.findIndex(element => element.Name == this.name);
        if (outputIndex > -1) {
            this.isOutput = true;
            this.output = this.controller.state.outputs[outputIndex];
            this.value = this.output.Value;
        }
        if (inputIndex > -1) {
            this.isInput = true;
            this.input = this.controller.state.inputs[inputIndex];
            this.value = this.input.Value;
        }

        if (outputIndex == -1 && inputIndex == -1) {
            throw new Error(`Parameter ${paramName} not found!`);
        }

        // Throw error if incorret bit index
        /* let inputBitSize = this.input.ByteSize*4;
        let outputBitSize = this.output.ByteSize*4;
        if (this.bitIndex !== null && (this.bitIndex > inputBitSize || this.bitIndex > outputBitSize)) {
            throw new Error(`Parameter ${paramName} must have bit index between 0 !`);
        } */

        // assign tag info to param
        this.controller.addTag(this,this.isInput,this.isOutput);
        
        // Increment Instances
        instances += 1;
    }

    update(value) {
        if (!this.isOutput) throw new Error(`Parameter ${this.name} is not an output`);

        // If param has overriden bit index than update via bitwise
        if (this.bitIndex !== null) {
            let newValue = this.output.Value | ( 1 << this.bitIndex);
            if (this.output.Type === Types.SINT) {
                newValue = (newValue << 24) >> 24;
            }
            this.controller._setOutputByName(this.name,newValue);
            return;
        }
        this.controller._setOutputByName(this.name,value);
        this.value = value;
        return;
    }

    changed(value) {
        let newValue = value;
        let oldValue = this.value;

        if (this.bitIndex !== null) {
            newValue = (value & (1 << this.bitIndex)) == 0 ? 0 : 1;
        }

        if (this.value == newValue) return;

        this.value = newValue;
        this.emit("Changed",newValue,oldValue);
        return;
    }

}

module.exports = Param;