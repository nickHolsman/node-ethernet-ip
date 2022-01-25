//import { Controller, Tag } from "ethernet-ip";
const { Controller } = require("./src");
//const { DINT, SINT, BOOL } = EthernetIP.CIP.DataTypes.Types;
//const { on, EventEmitter } = require('events');



const controller = new Controller();

controller.on("ControllerMajorRevision",(value) => {
    console.log("Value Updated to: ",value);
});

console.info("Connecting...");

controller.connect("192.168.56.102", "../UniversalRobot.eds",0).then(async () => {

    console.info("Ethernet-ip client: connected successfully");
    console.info(controller.properties);
    await Delay(1000);

    controller.start_implicit("Assem1","Assem2");
    console.info("Done");
});

async function Delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
} 