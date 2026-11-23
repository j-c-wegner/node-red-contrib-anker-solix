module.exports = function (RED) {
    const VALID_COMMANDS = new Array("set_usage_mode", "set_output_power", "get_params");

    function AnkerSolixControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server = RED.nodes.getNode(config.server);
        node.siteId = (config.siteId || "").trim();
        node.command = config.command || "set_usage_mode";
        node.usageMode = parseInt(config.usageMode, 10) || 1;
        node.powerWatt = parseInt(config.powerWatt, 10) || 0;
        node.deviceSn = (config.deviceSn || "").trim();

        if (!node.server) {
            node.status({ fill: "red", shape: "ring", text: "No account config selected" });
            return;
        }

        function isSmartMeter(dev) {
            if (!dev) return false;
            const pn = String(dev.device_pn || "").toUpperCase();
            return new Array("SHEM3", "A17X7", "A17X8", "AE1R0", "AE1X0", "A17X6").indexOf(pn) !== -1;
        }

        function clampPower(rawVal, maxCap) {
            const num = Number(rawVal);
            const safeNum = Number.isFinite(num) ? num : 0;
            const upper = Number.isFinite(Number(maxCap)) && Number(maxCap) > 0 ? Number(maxCap) : 4800;
            return Math.max(0, Math.min(upper, safeNum));
        }

        async function resolveMasterDevice() {
            const siteListRes = await node.server.apiRequest("/power_service/v1/site/get_site_list", {});
            const sites = (siteListRes && siteListRes.data && siteListRes.data.site_list) || new Array();
            if (sites.length === 0) throw new Error("No site found in this Anker account.");

            const wantedSiteId = node.siteId || node.server.siteId || "";
            const targetSite = (wantedSiteId
                ? sites.find((s) => s.site_id === wantedSiteId)
                : null) || sites.at(0);
            const siteId = targetSite.site_id;

            if (targetSite.ms_type !== undefined && Number(targetSite.ms_type) !== 1) {
                throw new Error("Site '" + (targetSite.site_name || siteId) + "' is shared (member) - control requires primary owner account!");
            }

            const scenRes = await node.server.apiRequest("/power_service/v1/site/get_scen_info", { site_id: siteId });
            const scen = (scenRes && scenRes.data) || {};
            const cbList = (scen.combiner_box_info && scen.combiner_box_info.combiner_box_list) || new Array();
            const pdList = (scen.powerdock_info && scen.powerdock_info.powerdock_list) || new Array();
            const sbList = (scen.solarbank_info && scen.solarbank_info.solarbank_list) || new Array();
            const realSbs = sbList.filter((x) => String(x.device_pn || "").toUpperCase() !== "AE100" && !isSmartMeter(x));

            let sn = node.deviceSn;
            let pn = "";

            if (sn) {
                const allDevs = cbList.concat(pdList, sbList);
                const match = allDevs.find((x) => x.device_sn === sn);
                pn = (match && match.device_pn) ? String(match.device_pn).toUpperCase() : "AE100";
            } else {
                const pd = cbList.find((x) => String(x.device_pn || "").toUpperCase() === "AE100")
                        || pdList.find((x) => String(x.device_pn || "").toUpperCase() === "AE100")
                        || sbList.find((x) => String(x.device_pn || "").toUpperCase() === "AE100");
                const sbMaster = realSbs.at(0);
                const dev = pd || sbMaster;
                if (dev && dev.device_sn) {
                    sn = dev.device_sn;
                    pn = String(dev.device_pn || "A17C1").toUpperCase();
                }
            }

            if (!sn) throw new Error("No master device (Power Dock / Solarbank 1-4) found.");

            let family = "SB_GEN234";
            if (pn === "AE100") family = "POWERDOCK";
            else if (pn === "A17C0") family = "SB_GEN1";

            return { siteId, deviceSn: sn, devicePn: pn, family };
        }

        function updatePlanPower(planList, watt) {
            if (!Array.isArray(planList) || planList.length === 0) {
                return new Array({ index: 1, week: new Array(1, 2, 3, 4, 5, 6, 0), ranges: new Array({ start_time: "00:00", end_time: "24:00", power: watt, charging_type: 0 }) });
            }
            planList.forEach((p) => {
                if (Array.isArray(p.ranges)) {
                    p.ranges.forEach((r) => { r.power = watt; });
                }
            });
            return planList;
        }

        node.on("input", async function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };

            try {
                if (typeof msg.payload === "string" && msg.payload.toLowerCase().trim() === "polling") {
                    if (done) done();
                    return;
                }
                if (node.command === "from_msg" && typeof msg.payload === "number" && msg.payload > 1000000000 && !msg.topic) {
                    node.status({ fill: "yellow", shape: "ring", text: "Timestamp inject ignored" });
                    if (done) done();
                    return;
                }

                let cmd = node.command;
                let val = (cmd === "set_output_power") ? node.powerWatt : node.usageMode;

                const topicCmd = String(msg.topic || "").toLowerCase().trim();
                if (VALID_COMMANDS.indexOf(topicCmd) !== -1) {
                    cmd = topicCmd;
                    if (msg.payload !== undefined && msg.payload !== "" && typeof msg.payload !== "object") {
                        val = msg.payload;
                    }
                } else if (cmd === "from_msg") {
                    if (msg.payload && typeof msg.payload === "object" && msg.payload.command) {
                        cmd = String(msg.payload.command).toLowerCase().trim();
                        val = msg.payload.value;
                    } else {
                        throw new Error("Dynamic mode requires msg.topic or { command, value }.");
                    }
                } else if (msg.payload !== undefined && msg.payload !== "" && typeof msg.payload !== "object") {
                    val = msg.payload;
                }

                if (cmd === "set_output_power") {
                    val = clampPower(val, 4800);
                }

                node.status({ fill: "blue", shape: "dot", text: "Sending " + cmd + "..." });
                const { siteId, deviceSn, devicePn, family } = await resolveMasterDevice();
                const paramType = (family === "POWERDOCK") ? "6" : "4";
                const baseBody = { site_id: siteId, device_sn: deviceSn, param_type: paramType, cmd: 17 };

                if (cmd === "get_params") {
                    const pMain = await node.server.apiRequest("/power_service/v1/site/get_site_device_param", baseBody);
                    node.status({ fill: "green", shape: "dot", text: `Params loaded (${devicePn})` });
                    send({ payload: { site_id: siteId, device_sn: deviceSn, device_pn: devicePn, family, params: pMain }, topic: "anker/control/params" });
                    if (done) done();
                    return;
                }

                if (family === "SB_GEN1" && cmd === "set_output_power") {
                    const watt = Math.round(clampPower(val, 800));
                    const v1Res = await node.server.apiRequest("/power_service/v1/site/set_home_load", {
                        site_id: siteId, device_sn: deviceSn, home_load_data: JSON.stringify({ power: watt })
                    });
                    if (!v1Res || v1Res.code !== 0) throw new Error("Anker V1 error: " + (v1Res ? (v1Res.msg || v1Res.code) : "No response"));
                    node.context().global.set("anker_wakeup_reset_" + siteId, true);
                    node.status({ fill: "green", shape: "dot", text: `${cmd}: ${watt}W OK (${devicePn})` });
                    send({ payload: { ok: true, command: cmd, value: watt, device_sn: deviceSn, response: v1Res }, topic: "anker/control" });
                    if (done) done();
                    return;
                }

                const curRes = await node.server.apiRequest("/power_service/v1/site/get_site_device_param", baseBody);
                let paramData = {};
                if (curRes && curRes.code === 0 && curRes.data && curRes.data.param_data) {
                    paramData = typeof curRes.data.param_data === "string" ? JSON.parse(curRes.data.param_data) : curRes.data.param_data;
                }

                if (cmd === "set_usage_mode") {
                    const mode = parseInt(val, 10) || 1;
                    paramData.mode_type = mode;
                    if (paramData.ai_ems && typeof paramData.ai_ems === "object") {
                        paramData.ai_ems.enable = (mode === 7);
                    }
                    if (mode === 2) {
                        const fallbackW = Number(paramData.default_home_load) || 200;
                        if (!Array.isArray(paramData.custom_rate_plan) || paramData.custom_rate_plan.length === 0) {
                            paramData.custom_rate_plan = updatePlanPower(null, fallbackW);
                        }
                        if (!Array.isArray(paramData.blend_plan) || paramData.blend_plan.length === 0) {
                            paramData.blend_plan = updatePlanPower(null, fallbackW);
                        }
                    }
                } else if (cmd === "set_output_power") {
                    const maxLoad = Number(paramData.max_load) || 4800;
                    const step = Number(paramData.step) || 10;
                    let watt = clampPower(val, maxLoad);
                    watt = Math.round(watt / step) * step;
                    paramData.default_home_load = watt;
                    paramData.custom_rate_plan = updatePlanPower(paramData.custom_rate_plan, watt);
                    paramData.blend_plan = updatePlanPower(paramData.blend_plan, watt);
                } else {
                    throw new Error("Unknown control command: " + cmd);
                }

                const writeBody = Object.assign({}, baseBody, { param_data: JSON.stringify(paramData) });
                const apiRes = await node.server.apiRequest("/power_service/v1/site/set_site_device_param", writeBody);

                if (!apiRes || apiRes.code !== 0) {
                    throw new Error("Anker API error: " + (apiRes ? (apiRes.msg || apiRes.code) : "No response"));
                }

                node.context().global.set("anker_wakeup_reset_" + siteId, true);
                node.status({ fill: "green", shape: "dot", text: `${cmd}: ${val} OK (${devicePn})` });
                send({ payload: { ok: true, command: cmd, value: val, device_sn: deviceSn, device_pn: devicePn, response: apiRes }, topic: "anker/control" });
                if (done) done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: err.message.substring(0, 32) });
                node.error(err.message, msg);
                if (done) done(err);
            }
        });
    }

    RED.nodes.registerType("anker-solix-control", AnkerSolixControlNode);
};
