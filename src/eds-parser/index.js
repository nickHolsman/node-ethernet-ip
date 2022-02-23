const fs = require("fs");

const sections = {
    FILE: "File",
    DEVICE: "Device",
    DEVICE_CLASSIFICATION: "Device Classification",
    PARAMS: "Params",
    GROUPS: "Groups",
    ASSEMBLY: "Assembly",
    CONNECTION_MANAGER: "Connection Manager",
    PORT: "Port",
    CAPACITY: "Capacity",
    TCP_IP_INTERFACE_CLASS: "TCP/IP Interface Class",
    ETHERNET_LINK_CLASS: "Ethernet Link Class",
};

const readEDS = async (file_path) => {

    let promise = new Promise(function(resolve, reject){
        fs.readFile(file_path, "ascii", (err, data) => {

            // Guard clause for EDS file
            if (!data) {
                reject("EDS file not found");
            }
            
            let regex = /\[|\]/gm;
            
    
            // Remove comments and split by [ or ]
            let array = data.replace(/\$.*/gm,"").split(regex);
            let prevItem;
            let objEDS = {};
    
            array.slice(1).forEach((item,index) => {
                if (index % 2 == 0) {
                    objEDS[item] = null;
                    prevItem = item;
                }
                else {
    
                    // Parse section by name
                    /* eslint-disable indent */
                    switch (prevItem) {
                        case sections.FILE:
                            break;
                        case sections.DEVICE:
                            break;
                        case sections.PARAMS:
                            // Add parameters to the EDS Object
                            objEDS[prevItem] = parseParamsSection(item);
                            break;
                        case sections.ASSEMBLY:
                            // Add assemblies to the EDS Object
                            objEDS[prevItem] = parseAssemblySection(item);
                            break;
                    }
                    /* eslint-enable indent */
                }
            });
            resolve(objEDS);
        });
    });
    return promise; 
};

const parseFileSection = (data) => {

};

/**
 * 
 * @param {string} data - to be parsed for EDS params
 */
const parseParamsSection = (data) => {
    let array = data.split(/\=|;/);
    let objParam = [];
    let currentParam, enumFlag;

    // Split by param or enum
    array.forEach((element,index) => {
        // Remove whitespace and line feeds from begining or each string
        //item.replace(//)
        let item = element.trim();

        let paramRegex = new RegExp("^Param");
        let enumRegex = new RegExp("^Enum");
        if (paramRegex.test(item)) {
            // Set the parameter value in object
            let paramName = item.replace(/\s/g,"");  // Remove any whitespace
            currentParam = paramName;
        }
        else if (enumFlag) {
            // Add enum info to parameter object
            let paramIndex = objParam.findIndex( p => p.Param == currentParam );

            // Add enum data to param
            objParam[paramIndex] = {
                ...objParam[paramIndex],
                Enum: parseEnumItem(item)
            };

            // Reset enum flag
            enumFlag = false;
        }
        else if (enumRegex.test(item)) {
            enumFlag = true;    // Set enum flag to parse enum data on next loop
        }
        else {
            // Add the param info to parameter object
            let param = {
                Param: currentParam,
                Data: parseParamsItem(item)
            };
            
            // Push to parameter holding object
            objParam.push(param);
        }
    });
    return objParam;
};

const parseAssemblySection = (data) => {
    let objAssem = [];
    let currentAssem;

    // Split assembly items
    let array = data.split(/\=|;/);
    array.forEach((element,index) => {
        // Remove whitespace and line feeds from begining or each string
        //item.replace(//)
        let item = element.trim();

        if (item === "") {
            return;
        }

        let paramRegex = new RegExp("^Assem");
        if (paramRegex.test(item)) {
            // Set the assem value in object
            let assemName = item.replace(/\s/g,"");  // Remove any whitespace
            currentAssem = assemName;
        }
        else {
            // Add the assem info to parameter object
            let assem = {
                Assem: currentAssem,
                Data: parseAssemItem(item)
            };
            
            // Push to assembly holding object
            objAssem.push(assem);
        }
    });
    return objAssem;
};

const parseParamsItem = (data) => {
    let array = data.split(/,|;/);
    let param = {};

    // Split param contents
    array.forEach((element,index) => {
        let item = element.trim();
        /* eslint-disable indent */
        switch(index) {
            case 0:
                // Reserved
                break;
            case 1:
                // Link Path Size
                param["LinkPathSize"] = item;
                break;
            case 2:
                // Link Path
                param["LinkPath"] = item.replace(/"/g,"");
                break;
            case 3:
                // Descriptor
                param["Descriptor"] = item;
                break;
            case 4:
                // Data Type
                param["DataType"] = item;
                break;
            case 5:
                // Data Size in bytes
                param["DataSize"] = item;
                break;
            case 6:
                // Name
                param["Name"] = item.replace(/"/g,"");
                break;
            case 7:
                // Units
                param["Units"] = item.replace(/"/g,"");
                break;
            case 8:
                // Help String
                param["HelpString"] = item.replace(/"/g,"");
                break;
            case 9:
                // min data values
                param["MinDataValues"] = item;
                break;
            case 10:
                // max data values
                param["MaxDataValues"] = item;
                break;
            case 11:
                // default data values
                param["DefaultDataValues"] = item;
                break;
            case 12: 
                // mult scaling
                param["MultScaling"] = item;
                break;
            case 13:
                // div scaling
                param["DivScaling"] = item;
                break;
            case 14:
                // base scaling
                param["BaseScaling"] = item;
                break;
            case 15:
                // offset scaling
                param["OffsetScaling"] = item;
                break;
            case 16:
                // mult links
                param["MultLinks"] = item;
                break;
            case 17:
                // div links
                param["DivLinks"] = item;
                break;
            case 18:
                // base links
                param["BaseLinks"] = item;
                break;
            case 19:
                // offset links
                param["OffsetLinks"] = item;
                break;
            case 20:
                // decimal places
                param["DecimalPlaces"] = item.replace(/;/,"");
                break;
        }
        /* eslint-enable indent */
    });
    return param;
};

const parseEnumItem = (data) => {
    let array = data.split(/,|;/);
    let enumData = {};
    let currentEnum;

    // Split enum contents
    array.forEach((element,index) => {
        let item = element.trim();
        if (index % 2 == 0) {
            enumData[item] = null;
            currentEnum = item;
        }
        else {
            enumData[currentEnum] = item.replace(/"/g,"");
        }
    });
    return enumData;
};

const parseAssemItem = (data) => {
    let array = data.split(/,|;/);
    let assem = {
        Members: []
    };
    let currentSize;

    // Split assembly contents
    array.forEach((element,index) => {
        let item = element.trim();
        
        let regex1 = new RegExp("[A-Za-z]","g");
        /* eslint-disable indent */
        switch(index) {
            case 0:
                // Name
                assem["Name"] = item.replace(/"/g,"");
                break;
            case 1:
                // Link Path
                assem["LinkPath"] = item.replace(/"/g,"");
                break;
            case 2:
                // Data Block Size
                assem["DataBlockSize"] = item;
                break;
            case 3:
                // Options
                assem["Options"] = item;
                break;
            case 4:
                // Res
                break;
            case 5:
                // Res
                break;
            default:
                if (item === "") {
                    assem.Members.push({
                        Param: "Padding",
                        Size: currentSize
                    });
                }
                else if (regex1.test(item)) {
                    assem.Members.push({
                        Param: item,
                        Size: currentSize
                    });
                }
                else {
                    currentSize = item;
                }
                break;
        }
        /* eslint-enable indent */
    });
    return assem;
};

module.exports = { readEDS };