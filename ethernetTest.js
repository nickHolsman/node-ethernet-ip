//import { Controller, Tag } from "ethernet-ip";
const { Controller } = require("./src");
const { Param } = require("./src");
//const { DINT, SINT, BOOL } = EthernetIP.CIP.DataTypes.Types;
//const { on, EventEmitter } = require('events');



const controller = new Controller();



console.info("Connecting...");

controller.connect("192.168.56.102", "../UniversalRobot.eds",0).then(async () => {

    console.info("Ethernet-ip client: connected successfully");
    
    //await Delay(1000);

    await controller.start_implicit("Assem1","Assem2",1000,2000);
    console.info("Done");
    const processFlag = new Param(controller, "DINT Output Register 0");
    const startFlag = new Param(controller,"DINT Input Register 0");
    const robotSpeed = new Param(controller,"Speed Slider Fraction");
    processFlag.on("Changed", (value) => {
        console.info("Process flag has been updated to: ", value);
    });
    //await Delay(3000);
    console.info("Changing the outputs");
    robotSpeed.update(1);
    startFlag.update(999);
    //controller._setOutputByName("StandardDigitalOutputMask",1);
    //controller._setOutputByName("StandardDigitalOutputs",1);
    //controller._setOutputByName("DINTInputRegister0",0);
    //controller._setOutputByName("SpeedSliderFraction",1);
    
});

async function Delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
} 