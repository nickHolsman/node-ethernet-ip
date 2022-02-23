const { EventEmitter } = require("events");
const crypto = require("crypto");
const { CIP } = require("../enip");

// Static Class Property - Tracks Instances
let instances = 0;
class Param extends EventEmitter {
    constructor(controller, paramName, index = null) {
        super();
        instances++;

        this.name = paramName.replace(/\s/g, ""); //remove whitespace
        this.value = null;
        this.isInput = false;
        this.isOutput = false;
        this.timestamp = new Date();
        this.controller = controller;
        
        // find param on controller
        let paramIndex = this.controller.EDS.Params.findIndex(element => element.Data.Name == paramName);
        if (paramIndex == -1) throw new Error(`Parameter ${paramName} not found!`);

        // Determine if input/output
        let inputIndex = this.controller.state.inputs.findIndex(element => element.Name == this.name);
        let outputIndex = this.controller.state.outputs.findIndex(element => element.Name == this.name);
        if (outputIndex > -1) this.isOutput = true;
        if (inputIndex > -1) this.isInput = true;

        // assign tag info to param
        this.controller.addTag(this,this.isInput,this.isOutput);
        
        // Increment Instances
        instances += 1;
    }

    update(value) {
        if (!this.isOutput) throw new Error(`Parameter ${this.name} is not an output`);
        this.controller._setOutputByName(this.name,value);
    }

    changed(value) {
        this.emit("Changed",value);
    }

}

module.exports = Param;