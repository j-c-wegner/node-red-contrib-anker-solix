module.exports = function(RED) {
    const mqtt = require("mqtt");

    const LEGACY_ALIASES = {
        "SITE_HOME_LOAD": "PD_HAUSLAST", "SITE_GRID_IMPORT": "PD_NETZ_BEZUG",
        "SITE_GRID_EXPORT": "PD_NETZ_EINSP", "SITE_SOC": "PD_SOC",
        "SITE_CHARGE": "PD_LADEN", "SITE_SOLAR": "PD_SOLAR",
        "SITE_DISCHARGE": "PD_ENTLADEN", "SITE_OUTPUT": "PD_AUSGANG",
        "SB1_CHARGE": "SB1_LADEN", "SB2_CHARGE": "SB2_LADEN",
        "SB3_CHARGE": "SB3_LADEN", "SB4_CHARGE": "SB4_LADEN"
    };

    const PERIOD_DE = { "DAY": "TAG", "WEEK": "WOCHE", "MONTH": "MONAT", "YEAR": "JAHR" };
    const METRIC_DE = {
        "SOLAR": "SOLAR", "CHARGE": "LADEN", "DISCHARGE": "ENTLADEN",
        "SOLAR_HOME": "SOLAR_HAUS", "GRID_EXPORT": "EINSP",
        "GRID_IMPORT": "NETZ", "HOME": "HAUS", "BAT_HOME": "BAT_HAUS"
    };

    function getLegacyKey(key) {
        if (LEGACY_ALIASES[key]) { return LEGACY_ALIASES[key]; }
        const mSite = key.match(/^STAT_(DAY|WEEK|MONTH|YEAR)_(.+)$/);
        if (mSite && PERIOD_DE[mSite.at(1)] && METRIC_DE[mSite.at(2)]) {
            return "STAT_GES_" + PERIOD_DE[mSite.at(1)] + "_" + METRIC_DE[mSite.at(2)];
        }
        const mSb = key.match(/^STAT_(SB[1-4])_(DAY|WEEK|MONTH|YEAR)_(.+)$/);
        if (mSb && PERIOD_DE[mSb.at(2)] && METRIC_DE[mSb.at(3)]) {
            return "STAT_" + mSb.at(1) + "_" + PERIOD_DE[mSb.at(2)] + "_" + METRIC_DE[mSb.at(3)];
        }
        return "";
    }

    function AnkerSolixNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server = RED.nodes.getNode(config.server);
        node.wakeupServer = config.wakeupServer ? RED.nodes.getNode(config.wakeupServer) : null;
        if (!node.server) {
            node.status({ fill: "red", shape: "ring", text: "No account config selected" });
            return;
        }

        const nodeTag = String(node.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(-8) || "node";

        function resolveSiteId() {
            return (config.siteId || "").trim()
                || (node.server && node.server.siteId ? String(node.server.siteId).trim() : "")
                || node.context().get("savedSiteId")
                || "";
        }

        node.on("close", function () {
            node.context().set("busySince", 0);
            const activeSiteId = resolveSiteId();
            if (activeSiteId) {
                node.context().global.set("anker_wakeup_reset_" + activeSiteId, true);
            }
            if ((config.siteId || "").trim() !== (node.context().get("savedSiteId") || "")) {
                node.context().set("savedSiteId", "");
                node.context().set("savedPowerdockSn", "");
                node.context().set("savedSolarbanks", new Array());
            }
        });

        let hash = 0;
        for (let i = 0; i < node.id.length; i++) {
            hash = ((hash << 5) - hash) + node.id.charCodeAt(i);
            hash |= 0;
        }
        const startOffsetMs = Math.abs(hash) % 1500;

        node.on("input", function(msg) {
            const context = node.context();
            const global = node.context().global;
            const topic = String(msg.topic || "").toLowerCase().trim();

            if (topic === "set_wakeup") {
                const payloadStr = String(msg.payload).toLowerCase().trim();
                if (payloadStr === "auto") {
                    context.set("wakeupOverride", undefined);
                    node.status({ fill: "blue", shape: "dot", text: "Wakeup: Auto mode" });
                } else {
                    const enable = (msg.payload === true || payloadStr === "true" || payloadStr === "1" || payloadStr === "on" || payloadStr === "ein");
                    context.set("wakeupOverride", enable);
                    node.status({ fill: "blue", shape: "dot", text: "Wakeup manual: " + (enable ? "ON" : "OFF") });
                }
                return;
            }

            const isGetSites = (topic === "get_sites");
            const isGetStats = (topic === "get_stats");

            let sysVars = {};
            try {
                sysVars = JSON.parse(config.sysvarsJson || "{}");
            } catch (e) {
                node.error("Invalid JSON in SysVars mapping: " + e.message);
                return;
            }

            function emitSysVar(key, val) {
                let svName = (sysVars[key] || "").trim();
                if (!svName) {
                    const oldKey = getLegacyKey(key);
                    if (oldKey) { svName = (sysVars[oldKey] || "").trim(); }
                }
                if (!svName || val === null || val === undefined || isNaN(val)) { return; }
                const now = Date.now();
                const lastSent = context.get("lastSent") || {};
                const lastSentTime = context.get("lastSentTime") || {};
                const elapsed = now - (lastSentTime[svName] || 0);
                if (lastSent[svName] !== val || elapsed >= 300000) {
                    lastSent[svName] = val;
                    lastSentTime[svName] = now;
                    context.set("lastSent", lastSent);
                    context.set("lastSentTime", lastSentTime);
                    node.send([{ topic: svName, payload: val }, null, null]);
                }
            }

            function isAnkerSmartMeter(dev) {
                if (!dev) { return false; }
                const pn = String(dev.device_pn || "").toUpperCase();
                const name = String(dev.device_name || "").toLowerCase();
                return new Array("SHEM3", "A17X7", "A17X8", "AE1R0", "AE1X0", "A17X6").indexOf(pn) !== -1
                    || name.indexOf("smart meter") !== -1 || name.indexOf("smartmeter") !== -1;
            }

            function isAcHomeStorage(dev) {
                return dev ? new Array("AE111", "A17E1", "A17E2", "B17E2").indexOf(String(dev.device_pn || "").toUpperCase()) !== -1 : false;
            }

            async function triggerMqttWakeup(defaultSession, siteId, devSn, devPn, modeLabel, forceWake) {
                const now = Date.now();
                const wakeServerNode = node.wakeupServer || node.server;
                let session = defaultSession;
                if (node.wakeupServer) {
                    session = await node.wakeupServer.getAuthSession(false);
                }

                const emailKey = String(session.email || "user").replace(/[^a-zA-Z0-9]/g, "_");
                const wakeKey = "anker_wakeup_" + emailKey + "_" + devSn;
                const resetKey = "anker_wakeup_reset_" + siteId;
                const resetFlag = global.get(resetKey);
                if (resetFlag) {
                    global.set(resetKey, false);
                    forceWake = true;
                }
                const nextAllowed = global.get(wakeKey) || 0;

                if (!forceWake && now < nextAllowed) {
                    return "OK (next wakeup in " + Math.ceil((nextAllowed - now) / 1000) + "s)";
                }

                const randomDelayMs = (180 + Math.floor(Math.random() * 61)) * 1000;
                global.set(wakeKey, now + randomDelayMs);

                wakeServerNode.apiRequest("/power_service/v1/site/get_site_homepage", {}).catch(() => {});
                wakeServerNode.apiRequest("/power_service/v1/site/get_site_detail", { site_id: siteId }).catch(() => {});

                const m = session.mqttInfo;
                if (!m || !m.endpoint_addr || !m.private_key) { return "OK (Cloud active)"; }

                try {
                    const seq = (context.get("mqttSeq") || 1) + 1;
                    context.set("mqttSeq", seq);
                    const cid = "android-anker_power-" + session.user_id + "-" + m.certificate_id + "-" + nodeTag;
                    const randomSess = Math.floor(1000 + Math.random() * 9000) + "-" + Math.floor(1000 + Math.random() * 9000);
                    const opts = {
                        clientId: cid, cert: m.certificate_pem, key: m.private_key,
                        protocolVersion: 4, clean: true, connectTimeout: 8000, reconnectPeriod: 0
                    };
                    if (m.aws_root_ca1_pem) { opts.ca = m.aws_root_ca1_pem; }

                    const client = mqtt.connect("mqtts://" + m.endpoint_addr + ":8883", opts);
                    client.on("connect", function() {
                        const nowSec = Math.floor(Date.now() / 1000);
                        const t = Buffer.alloc(4); t.writeUInt32LE(300, 0);
                        const ts = Buffer.alloc(4); ts.writeUInt32LE(nowSec, 0);
                        const raw = Buffer.concat([Buffer.from("ff09210003000f0057a10101a20502", "hex"), t, Buffer.from("a30503", "hex"), ts]);
                        let xor = 0;
                        for (let i = 0; i < raw.length; i++) { xor ^= raw.readUInt8(i); }
                        const b64 = Buffer.concat([raw, Buffer.of(xor)]).toString("base64");

                        const payloadStr = JSON.stringify({
                            head: { version: "1.0.0.1", client_id: cid, sess_id: randomSess, msg_seq: seq, seed: 1, timestamp: nowSec, cmd_status: 1, cmd: 17, sign_code: 1, device_pn: devPn, device_sn: devSn },
                            payload: JSON.stringify({ account_id: session.user_id, device_sn: devSn, data: b64 })
                        });
                        client.publish("cmd/anker_power/" + devPn + "/" + devSn + "/req", payloadStr, { qos: 1 }, function() {
                            setTimeout(() => { try { client.end(true); } catch (e) {} }, 1500);
                        });
                    });
                    client.on("error", () => {
                        if (wakeServerNode && wakeServerNode.invalidateSession) { wakeServerNode.invalidateSession(); }
                        try { client.end(true); } catch (e) {}
                    });
                    return "OK + Wakeup [" + modeLabel + "] (next in " + Math.round(randomDelayMs / 1000) + "s)";
                } catch (e) {
                    return "OK (Cloud active)";
                }
            }

            async function run() {
                const busySince = context.get("busySince") || 0;
                if (busySince && (Date.now() - busySince < 20000)) { return; }
                context.set("busySince", Date.now());
                try {
                    if (startOffsetMs > 0) { await new Promise((r) => setTimeout(r, startOffsetMs)); }
                    const session = await node.server.getAuthSession(false);

                    let SITE_ID = resolveSiteId();
                    if (!SITE_ID || isGetSites) {
                        const siteRes = await node.server.apiRequest("/power_service/v1/site/get_site_list", {});
                        if (siteRes && siteRes.code === 0 && siteRes.data && siteRes.data.site_list) {
                            const sites = siteRes.data.site_list.map((x) => ({ site_id: x.site_id, site_name: x.site_name, ms_type: x.ms_type }));
                            if (isGetSites) { node.send([null, null, { topic: "site_list", payload: sites }]); }
                            if (!SITE_ID && sites.length > 0) {
                                const ownSite = sites.find((x) => x.ms_type === 1) || sites.at(0);
                                SITE_ID = ownSite.site_id;
                                context.set("savedSiteId", SITE_ID);
                            }
                        }
                    }
                    if (!SITE_ID) { node.status({ fill: "red", shape: "dot", text: "No SITE_ID found" }); return; }

                    const scenRes = await node.server.apiRequest("/power_service/v1/site/get_scen_info", { site_id: SITE_ID });
                    if (!scenRes || scenRes.code !== 0 || !scenRes.data) {
                        const errTxt = "API error: " + (scenRes ? (scenRes.msg || scenRes.code) : "No data");
                        node.status({ fill: "red", shape: "dot", text: errTxt });
                        node.send([null, null, { topic: "error", payload: errTxt }]);
                        return;
                    }
                    const scen = scenRes.data;
                    node.send([null, { topic: "scen_info", payload: scen }, null]);
                    const manualSn = (config.powerdockSn || "").trim();
                    let DEVICE_SN = manualSn || context.get("savedPowerdockSn") || "";
                    let DEVICE_PN = (config.powerdockPn || "").trim() || context.get("savedPowerdockPn") || "AE100";
                    let WAKEUP_MODE = manualSn ? ((DEVICE_PN.toUpperCase() === "AE100") ? "PowerDock" : "Manual") : (context.get("savedWakeupMode") || "");

                    const savedSbs = context.get("savedSolarbanks") || new Array();
                    const SOLARBANKS = new Array(
                        (config.sb1Sn || "").trim() || savedSbs.at(0) || "",
                        (config.sb2Sn || "").trim() || savedSbs.at(1) || "",
                        (config.sb3Sn || "").trim() || savedSbs.at(2) || "",
                        (config.sb4Sn || "").trim() || savedSbs.at(3) || ""
                    );

                    if (!manualSn && (!DEVICE_SN || !WAKEUP_MODE)) {
                        const cbList = (scen.combiner_box_info && scen.combiner_box_info.combiner_box_list) || new Array();
                        const pdList = (scen.powerdock_info && scen.powerdock_info.powerdock_list) || new Array();
                        const gridList = (scen.grid_info && scen.grid_info.grid_list) || new Array();
                        const sbList = (scen.solarbank_info && scen.solarbank_info.solarbank_list) || new Array();
                        const ppsList = (scen.pps_info && scen.pps_info.pps_list) || new Array();

                        let foundPd = cbList.find((x) => String(x.device_pn || "").toUpperCase() === "AE100")
                                   || pdList.find((x) => String(x.device_pn || "").toUpperCase() === "AE100")
                                   || sbList.find((x) => String(x.device_pn || "").toUpperCase() === "AE100");
                        let foundMeter = gridList.find(isAnkerSmartMeter) || sbList.find(isAnkerSmartMeter);
                        let foundAc = sbList.find(isAcHomeStorage) || ppsList.find(isAcHomeStorage);
                        let foundSb = sbList.find((x) => String(x.device_pn || "").toUpperCase() !== "AE100" && !isAnkerSmartMeter(x));

                        if (foundPd && foundPd.device_sn) { DEVICE_SN = foundPd.device_sn; DEVICE_PN = foundPd.device_pn || "AE100"; WAKEUP_MODE = "PowerDock"; }
                        else if (foundMeter && foundMeter.device_sn) { DEVICE_SN = foundMeter.device_sn; DEVICE_PN = foundMeter.device_pn || "SHEM3"; WAKEUP_MODE = "SmartMeter"; }
                        else if (foundAc && foundAc.device_sn) { DEVICE_SN = foundAc.device_sn; DEVICE_PN = foundAc.device_pn || "A17E2"; WAKEUP_MODE = "HomeStorage"; }
                        else if (foundSb && foundSb.device_sn) { DEVICE_SN = foundSb.device_sn; DEVICE_PN = foundSb.device_pn || "A17C1"; WAKEUP_MODE = "Solarbank"; }

                        if (DEVICE_SN) {
                            context.set("savedPowerdockSn", DEVICE_SN);
                            context.set("savedPowerdockPn", DEVICE_PN);
                            context.set("savedWakeupMode", WAKEUP_MODE);
                        }
                    }

                    if (!config.sb1Sn && savedSbs.length === 0 && scen.solarbank_info && scen.solarbank_info.solarbank_list) {
                        const autoSbs = scen.solarbank_info.solarbank_list
                            .filter((x) => String(x.device_pn || "").toUpperCase() !== "AE100" && !isAnkerSmartMeter(x))
                            .map((x) => x.device_sn);
                        if (autoSbs.length > 0) {
                            context.set("savedSolarbanks", autoSbs);
                            SOLARBANKS.splice(0, 4, autoSbs.at(0) || "", autoSbs.at(1) || "", autoSbs.at(2) || "", autoSbs.at(3) || "");
                        }
                    }

                    const gList = (scen.grid_info && scen.grid_info.grid_list) || new Array();
                    const meterObj = gList.find(isAnkerSmartMeter) || gList.at(0);
                    if (meterObj) {
                        const isOnline = (String(meterObj.status) === "1" || meterObj.status === 1 || meterObj.online === true) ? 1 : 0;
                        emitSysVar("SITE_SMARTMETER_ONLINE", isOnline);
                        const prevMeterState = context.get("prevSmartMeterOnline");
                        if (prevMeterState !== undefined && prevMeterState !== isOnline) {
                            node.send([null, null, {
                                topic: isOnline ? "alarm/smartmeter_online" : "alarm/smartmeter_offline",
                                payload: {
                                    online: isOnline === 1,
                                    device_sn: meterObj.device_sn || "",
                                    device_pn: meterObj.device_pn || "",
                                    message: isOnline ? "Smart Meter back online" : "Smart Meter OFFLINE (200W fallback active!)"
                                }
                            }]);
                        }
                        context.set("prevSmartMeterOnline", isOnline);
                    }

                    const liveSig = String(scen.home_load_power) + "|" + String(scen.grid_info && scen.grid_info.grid_to_home_power) + "|" + String(scen.solarbank_info && scen.solarbank_info.total_photovoltaic_power);
                    let lastLiveChange = context.get("lastLiveChange") || Date.now();
                    if (liveSig !== (context.get("lastLiveSig") || "")) {
                        context.set("lastLiveSig", liveSig);
                        lastLiveChange = Date.now();
                        context.set("lastLiveChange", lastLiveChange);
                    }
                    const isStalled = (Date.now() - lastLiveChange > 90000);
                    if (isStalled) { context.set("lastLiveChange", Date.now()); }

                    const wakeupOverride = context.get("wakeupOverride");
                    let wakeupStatus = "OK (Cloud active)";
                    let shouldWakeup = (wakeupOverride === true) || (wakeupOverride !== false && new Array("PowerDock", "SmartMeter", "HomeStorage", "Manual").indexOf(WAKEUP_MODE) !== -1);
                    if (wakeupOverride === false) { wakeupStatus = "OK (Wakeup off)"; }
                    else if (!shouldWakeup) { wakeupStatus = "OK (Battery protection: wakeup off)"; }
                    if (shouldWakeup && DEVICE_SN) {
                        wakeupStatus = await triggerMqttWakeup(session, SITE_ID, DEVICE_SN, DEVICE_PN, WAKEUP_MODE || "Auto", isStalled);
                    }

                    if (scen.home_load_power !== undefined) { emitSysVar("SITE_HOME_LOAD", Number(scen.home_load_power)); }
                    if (scen.grid_info) {
                        if (scen.grid_info.grid_to_home_power !== undefined) { emitSysVar("SITE_GRID_IMPORT", Number(scen.grid_info.grid_to_home_power)); }
                        if (scen.grid_info.photovoltaic_to_grid_power !== undefined) { emitSysVar("SITE_GRID_EXPORT", Number(scen.grid_info.photovoltaic_to_grid_power)); }
                    }
                    const sbInfo = scen.solarbank_info || {};
                    if (sbInfo.total_battery_power !== undefined && sbInfo.total_battery_power !== "") {
                        const tb = Number(sbInfo.total_battery_power);
                        emitSysVar("SITE_SOC", tb <= 1.01 ? Math.round(tb * 100) : Math.round(tb));
                    }
                    if (sbInfo.total_charging_power !== undefined) { emitSysVar("SITE_CHARGE", Number(sbInfo.total_charging_power)); }
                    if (sbInfo.total_photovoltaic_power !== undefined) { emitSysVar("SITE_SOLAR", Number(sbInfo.total_photovoltaic_power)); }
                    if (sbInfo.battery_discharge_power !== undefined) { emitSysVar("SITE_DISCHARGE", Number(sbInfo.battery_discharge_power)); }
                    if (sbInfo.total_output_power !== undefined) { emitSysVar("SITE_OUTPUT", Number(sbInfo.total_output_power)); }
                    const sbList = sbInfo.solarbank_list || new Array();
                    let sumAcCharge = 0;
                    for (let idx = 0; idx < 4; idx++) {
                        if (!SOLARBANKS.at(idx)) { continue; }
                        const sb = sbList.find((item) => item.device_sn === SOLARBANKS.at(idx));
                        if (sb) {
                            const pfx = "SB" + (idx + 1) + "_";
                            if (sb.battery_power !== undefined && sb.battery_power !== "") { emitSysVar(pfx + "SOC", Number(sb.battery_power)); }
                            const pvPwr = Number(sb.photovoltaic_power) || 0;
                            if (sb.photovoltaic_power !== undefined && sb.photovoltaic_power !== "") { emitSysVar(pfx + "SOLAR", pvPwr); }

                            const pvChg = Number(sb.charging_power) || 0;
                            const batChg = Number(sb.bat_charge_power) || 0;
                            const heatPwr = Number(sb.heating_power) || 0;
                            const totalSbChg = Math.max(pvChg, batChg);
                            if (sb.charging_power !== undefined || sb.bat_charge_power !== undefined) {
                                emitSysVar(pfx + "CHARGE", totalSbChg);
                            }

                            let acChg = 0;
                            if (Number(sb.ac_power) > 0) { acChg = Number(sb.ac_power); }
                            else if (Number(sb.grid_to_battery_power) > 0) { acChg = Number(sb.grid_to_battery_power); }
                            else if ((batChg + heatPwr) > (pvPwr + 5)) { acChg = Math.max(0, (batChg + heatPwr) - pvPwr); }
                            emitSysVar(pfx + "AC_CHARGE", acChg);
                            sumAcCharge += acChg;

                            if (sb.output_power !== undefined && sb.output_power !== "") { emitSysVar(pfx + "OUTPUT", Number(sb.output_power)); }
                            if (sb.pv_power) {
                                new Array("pv1", "pv2", "pv3", "pv4").forEach((k, i) => { if (sb.pv_power[k] !== undefined) emitSysVar(pfx + "PV" + (i + 1), Number(sb.pv_power[k])); });
                            }
                            new Array(1, 2, 3, 4).forEach((n) => { if (sb["solar_power_" + n] !== undefined) emitSysVar(pfx + "PV" + n, Number(sb["solar_power_" + n])); });
                        }
                    }

                    const siteGridBat = Number(sbInfo.grid_to_battery_power) || 0;
                    const siteTotalAc = Number(sbInfo.total_ac_power) || 0;
                    emitSysVar("SITE_AC_CHARGE", siteGridBat > 0 ? siteGridBat : (siteTotalAc > 0 ? siteTotalAc : sumAcCharge));

                    if (isGetStats || (Date.now() - (context.get("lastStatFetch") || 0) > 300000)) {
                        context.set("lastStatFetch", Date.now());
                        const dNow = new Date();
                        const pad = (n) => n < 10 ? "0" + n : "" + n;
                        const todayStr = dNow.getFullYear() + "-" + pad(dNow.getMonth() + 1) + "-" + pad(dNow.getDate());
                        const dWeek = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate());
                        dWeek.setDate(dWeek.getDate() - (dWeek.getDay() === 0 ? 6 : dWeek.getDay() - 1));
                        const weekStr = dWeek.getFullYear() + "-" + pad(dWeek.getMonth() + 1) + "-" + pad(dWeek.getDate());
                        const types = new Array(
                            { type: "day", pfx: "DAY_", start: todayStr, end: todayStr },
                            { type: "week", pfx: "WEEK_", start: weekStr, end: todayStr },
                            { type: "month", pfx: "MONTH_", start: dNow.getFullYear() + "-" + pad(dNow.getMonth() + 1), end: "" },
                            { type: "year", pfx: "YEAR_", start: "" + dNow.getFullYear(), end: "" }
                        );
                        const statRawOut = {};
                        for (const tp of types) {
                            const mergedGes = {};
                            for (const dt of new Array("solar_production", "home_usage", "grid")) {
                                const stPart = await node.server.apiRequest("/power_service/v1/site/energy_analysis", { site_id: SITE_ID, device_sn: "", type: tp.type, start_time: tp.start, end_time: tp.end, device_type: dt });
                                if (stPart && stPart.code === 0 && stPart.data) { Object.assign(mergedGes, stPart.data); }
                            }
                            statRawOut[tp.type] = mergedGes;
                            const sbDataList = new Array();
                            for (let sIdx = 0; sIdx < 4; sIdx++) {
                                if (!SOLARBANKS.at(sIdx)) { continue; }
                                const stSb = await node.server.apiRequest("/power_service/v1/site/energy_analysis", { site_id: SITE_ID, device_sn: SOLARBANKS.at(sIdx), type: tp.type, start_time: tp.start, end_time: tp.end, device_type: "solar_production" });
                                if (stSb && stSb.code === 0 && stSb.data) {
                                    sbDataList.push(stSb.data);
                                    statRawOut[tp.type + "_sb" + (sIdx + 1)] = stSb.data;
                                    const pS = "STAT_SB" + (sIdx + 1) + "_" + tp.pfx;
                                    if (stSb.data.solar_total !== undefined && stSb.data.solar_total !== "") { emitSysVar(pS + "SOLAR", Number(stSb.data.solar_total)); }
                                    if (stSb.data.charge_total !== undefined && stSb.data.charge_total !== "") { emitSysVar(pS + "CHARGE", Number(stSb.data.charge_total)); }
                                    if (stSb.data.discharge_total !== undefined && stSb.data.discharge_total !== "") { emitSysVar(pS + "DISCHARGE", Number(stSb.data.discharge_total)); }
                                }
                            }
                            const sbMain = sbDataList.at(0) || {};
                            const pick = (k) => (mergedGes[k] !== undefined && mergedGes[k] !== "") ? Number(mergedGes[k]) : ((sbMain[k] !== undefined && sbMain[k] !== "") ? Number(sbMain[k]) : null);
                            const p = "STAT_" + tp.pfx;
                            const vSol = pick("solar_total"), vLad = pick("charge_total"), vEnt = pick("discharge_total"), vSolH = pick("solar_to_home_total"), vNet = pick("grid_to_home_total"), vBatH = pick("battery_to_home_total");
                            let vEin = pick("grid_out_total") ?? pick("photovoltaic_to_grid_total") ?? pick("solar_to_grid_total");
                            let vHau = pick("home_usage_total") ?? ((vNet !== null || vSolH !== null || vBatH !== null) ? Number(((vNet || 0) + (vSolH || 0) + (vBatH || 0)).toFixed(2)) : null);
                            if (vSol !== null) emitSysVar(p + "SOLAR", vSol);
                            if (vLad !== null) emitSysVar(p + "CHARGE", vLad);
                            if (vEnt !== null) emitSysVar(p + "DISCHARGE", vEnt);
                            if (vSolH !== null) emitSysVar(p + "SOLAR_HOME", vSolH);
                            if (vEin !== null) emitSysVar(p + "GRID_EXPORT", vEin);
                            if (vNet !== null) emitSysVar(p + "GRID_IMPORT", vNet);
                            if (vHau !== null) emitSysVar(p + "HOME", vHau);
                            if (vBatH !== null) emitSysVar(p + "BAT_HOME", vBatH);
                        }
                        node.send([null, { topic: "energy_analysis", payload: statRawOut }, null]);
                    }
                    node.status({ fill: "green", shape: "dot", text: wakeupStatus });
                } catch (err) {
                    const errMsg = (err && err.message) ? String(err.message) : String(err || "Unknown error");
                    node.status({ fill: "red", shape: "dot", text: errMsg.substring(0, 32) });
                    node.send([null, null, { topic: "error", payload: errMsg }]);
                } finally {
                    context.set("busySince", 0);
                }
            }
            run();
        });
    }
    RED.nodes.registerType("anker-solix", AnkerSolixNode);
};