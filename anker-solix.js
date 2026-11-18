module.exports = function(RED) {
    const https = require("https");
    const crypto = require("crypto");
    const mqtt = require("mqtt");

    const PUB_KEY = "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

    function AnkerSolixNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.on("input", function(msg) {
            const EMAIL = (config.email || "").trim();
            const PASSWORD = (node.credentials && node.credentials.password) ? node.credentials.password : "";
            let SITE_ID = (config.siteId || "").trim() || node.context().get("savedSiteId") || "";
            const manualSn = (config.powerdockSn || "").trim();
            const manualPn = (config.powerdockPn || "").trim();
            let DEVICE_SN = manualSn || node.context().get("savedPowerdockSn") || "";
            let DEVICE_PN = manualPn || node.context().get("savedPowerdockPn") || "AE100";
            let WAKEUP_MODE = manualSn ? ((DEVICE_PN.toUpperCase() === "AE100") ? "PowerDock" : "Manuell") : (node.context().get("savedWakeupMode") || "");

            const savedSbs = node.context().get("savedSolarbanks") || [];
            const SOLARBANKS = [
                (config.sb1Sn || "").trim() || savedSbs[0] || "",
                (config.sb2Sn || "").trim() || savedSbs[1] || "",
                (config.sb3Sn || "").trim() || savedSbs[2] || "",
                (config.sb4Sn || "").trim() || savedSbs[3] || ""
            ];

            let sysVars = {};
            try {
                sysVars = JSON.parse(config.sysvarsJson || "{}");
            } catch (e) {
                node.error("Ungültiges JSON in SysVars-Zuordnung: " + e.message);
                return;
            }

            const context = node.context();
            const global = node.context().global;
            const topic = String(msg.topic || "").toLowerCase().trim();

            if (topic === "set_wakeup") {
                const payloadStr = String(msg.payload).toLowerCase().trim();
                if (payloadStr === "auto") {
                    context.set("wakeupOverride", undefined);
                    node.status({ fill: "blue", shape: "dot", text: "Wakeup: Auto-Modus" });
                } else {
                    const enable = (msg.payload === true || payloadStr === "true" || payloadStr === "1" || payloadStr === "on" || payloadStr === "ein");
                    context.set("wakeupOverride", enable);
                    node.status({ fill: "blue", shape: "dot", text: "Wakeup manuell: " + (enable ? "EIN" : "AUS") });
                }
                return;
            }

            const isGetSites = (topic === "get_sites");

            function emitSysVar(key, val) {
                const svName = (sysVars[key] || "").trim();
                if (!svName || val === null || val === undefined || isNaN(val)) { return; }
                const lastSent = context.get("lastSent") || {};
                if (lastSent[svName] !== val) {
                    lastSent[svName] = val;
                    context.set("lastSent", lastSent);
                    node.send([{ topic: svName, payload: val }, null, null]);
                }
            }

            function req(path, bodyObj, hdrs) {
                return new Promise(function(resolve, reject) {
                    const bodyStr = JSON.stringify(bodyObj);
                    const headers = Object.assign({
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(bodyStr),
                        "Country": "DE",
                        "Timezone": "GMT+01:00",
                        "App-Name": "anker_power",
                        "Os-Type": "android"
                    }, hdrs || {});
                    const r = https.request({
                        hostname: "ankerpower-api-eu." + "anker.com",
                        port: 443,
                        path: path,
                        method: "POST",
                        headers: headers
                    }, function(res) {
                        let d = "";
                        res.on("data", function(c) { d += c; });
                        res.on("end", function() {
                            try { resolve(JSON.parse(d)); } catch (e) { resolve({ code: -1, raw: d }); }
                        });
                    });
                    r.on("error", reject);
                    r.write(bodyStr);
                    r.end();
                });
            }
            function isAnkerSmartMeter(dev) {
                if (!dev) { return false; }
                const pn = String(dev.device_pn || "").toUpperCase();
                const name = String(dev.device_name || "").toLowerCase();
                const meterPns = ["SHEM3", "A17X7", "A17X8", "AE1R0", "AE1X0", "A17X6"];
                return meterPns.indexOf(pn) !== -1 || name.indexOf("smart meter") !== -1 || name.indexOf("smartmeter") !== -1;
            }

            function isAcHomeStorage(dev) {
                if (!dev) { return false; }
                const pn = String(dev.device_pn || "").toUpperCase();
                return ["AE111", "A17E2", "B17E2"].indexOf(pn) !== -1;
            }

            function buildPullToRefreshBytes(devicePn) {
                const pnStr = String(devicePn || "AE100");
                const pnBuf = Buffer.from(pnStr, "utf8");
                const valBuf = Buffer.from([0x01]);
                const f1 = Buffer.concat([Buffer.from([0xa1, 0x01]), Buffer.from([pnBuf.length]), pnBuf]);
                const f2 = Buffer.concat([Buffer.from([0xa2, 0x02]), Buffer.from([valBuf.length]), valBuf]);
                const payload = Buffer.concat([f1, f2]);

                const ts = Math.floor(Date.now() / 1000);
                const header = Buffer.from([
                    0xff, 0x09,
                    0x00, 0x00,
                    0x03, 0x00, 0x0f,
                    0x00, 0x57,
                    0x01, 0x01, 0x11,
                    0x00, 0x00, 0x00, 0x00
                ]);
                header.writeUInt32BE(ts, 12);

                const body = Buffer.concat([header, payload]);
                body.writeUInt16LE(body.length + 1, 2);

                let xor = 0;
                for (let i = 0; i < body.length; i++) { xor ^= body[i]; }
                return Buffer.concat([body, Buffer.from([xor])]);
            }

            function triggerMqttWakeup(session, devSn, devPn, modeLabel) {
                const now = Date.now();
                const nextAllowed = context.get("nextWakeupTime") || 0;
                if (now < nextAllowed) {
                    const remSec = Math.ceil((nextAllowed - now) / 1000);
                    return "OK (nächster Wakeup in " + remSec + "s)";
                }

                const randomDelayMs = (210 + Math.floor(Math.random() * 211)) * 1000;
                context.set("nextWakeupTime", now + randomDelayMs);

                if (!session.mqttInfo || !session.mqttInfo.endpoint_addr || !session.mqttInfo.private_key) {
                    return "OK (Cloud aktiv)";
                }
                try {
                    const m = session.mqttInfo;
                    const clientId = "android-" + m.app_name + "-" + session.userId + "-" + m.thing_name + "-" + Math.floor(Math.random() * 100000);
                    const client = mqtt.connect("mqtts://" + m.endpoint_addr + ":8883", {
                        clientId: clientId,
                        cert: m.certificate_pem,
                        key: m.private_key,
                        rejectUnauthorized: false,
                        connectTimeout: 8000,
                        reconnectPeriod: 0
                    });
                    client.on("connect", function() {
                        const topicPub = "cmd/anker_power/" + devPn + "/" + devSn + "/req";
                        const hexPayload = buildPullToRefreshBytes(devPn).toString("hex");
                        const msgObj = {
                            head: {
                                version: "1.0.0.1",
                                client_id: clientId,
                                sess_id: "5678-1234",
                                msg_seq: 1,
                                seed: 1,
                                timestamp: Math.floor(Date.now() / 1000),
                                cmd_status: 2,
                                cmd: 17,
                                sign_code: 1,
                                device_pn: devPn,
                                device_sn: devSn
                            },
                            payload: JSON.stringify({
                                packet: {
                                    data: hexPayload
                                }
                            })
                        };
                        client.publish(topicPub, JSON.stringify(msgObj), { qos: 0 }, function() {
                            setTimeout(function() { client.end(true); }, 600);
                        });
                    });
                    client.on("error", function() {
                        try { client.end(true); } catch (e) {}
                    });
                    const nextSec = Math.round(randomDelayMs / 1000);
                    return "OK + Wakeup [" + modeLabel + "] (nächster in " + nextSec + "s)";
                } catch (e) {
                    return "OK (Cloud aktiv)";
                }
            }
            async function run() {
                if (context.get("isBusy")) {
                    return;
                }
                context.set("isBusy", true);
                try {
                    if (!EMAIL || !PASSWORD) {
                        node.status({ fill: "red", shape: "ring", text: "Zugangsdaten fehlen" });
                        return;
                    }

                    const sessionKey = "anker_session_" + EMAIL.replace(/[^a-zA-Z0-9]/g, "_");
                    let s = global.get(sessionKey);

                    if (!s || !s.token || Date.now() > (s.expires || 0)) {
                        const blockedUntil = context.get("loginBlockedUntil") || 0;
                        if (Date.now() < blockedUntil) {
                            const waitSec = Math.ceil((blockedUntil - Date.now()) / 1000);
                            node.status({ fill: "yellow", shape: "ring", text: "Login-Schutz (" + waitSec + "s)" });
                            return;
                        }

                        node.status({ fill: "yellow", shape: "dot", text: "Login läuft..." });
                        const ecdh = crypto.createECDH("prime256v1");
                        ecdh.generateKeys();
                        const sec = ecdh.computeSecret(Buffer.from(PUB_KEY, "hex"));
                        const cip = crypto.createCipheriv("aes-256-cbc", sec.subarray(0, 32), sec.subarray(0, 16));
                        const pwd = cip.update(PASSWORD, "utf8", "base64") + cip.final("base64");

                        const loginRes = await req("/passport/login", {
                            ab: "DE",
                            client_secret_info: { public_key: ecdh.getPublicKey("hex", "uncompressed") },
                            enc: 1,
                            email: EMAIL,
                            password: pwd
                        }, { "gtoken": "" });

                        if (!loginRes || loginRes.code !== 0 || !loginRes.data) {
                            const errCode = loginRes ? loginRes.code : -1;
                            const pauseMs = (errCode === 10019) ? (11 * 60 * 1000) : ((errCode === 26108) ? (5 * 60 * 1000) : (60 * 1000));
                            context.set("loginBlockedUntil", Date.now() + pauseMs);
                            const errMsg = "Login-Fehler (" + errCode + "): " + (loginRes ? loginRes.msg : "Keine Antwort");
                            node.status({ fill: "red", shape: "dot", text: errMsg });
                            node.send([null, null, { topic: "error", payload: errMsg }]);
                            return;
                        }

                        context.set("loginBlockedUntil", 0);
                        const d = loginRes.data;
                        const gtoken = crypto.createHash("md5").update(String(d.user_id)).digest("hex");
                        const authHdrsInit = { "X-Auth-Token": d.auth_token, "gtoken": gtoken };

                        let mqttInfo = null;
                        try {
                            const profRes = await req("/app/devicemanage/get_user_mqtt_info", {}, authHdrsInit);
                            if (profRes && profRes.code === 0) { mqttInfo = profRes.data; }
                        } catch (e) {}

                        s = {
                            token: d.auth_token,
                            userId: d.user_id,
                            gtoken: gtoken,
                            mqttInfo: mqttInfo,
                            expires: Date.now() + (20 * 3600 * 1000)
                        };
                        global.set(sessionKey, s);
                    }

                    const authHdrs = { "X-Auth-Token": s.token, "gtoken": s.gtoken };

                    if (!SITE_ID || isGetSites) {
                        const siteRes = await req("/power_service/v1/site/get_site_list", {}, authHdrs);
                        if (siteRes && (siteRes.code === 401 || siteRes.code === 10003)) {
                            global.set(sessionKey, null);
                            context.set("loginBlockedUntil", Date.now() + 30000);
                            node.status({ fill: "yellow", shape: "dot", text: "Sitzung erneuert..." });
                            return;
                        }
                        if (siteRes && siteRes.code === 0 && siteRes.data && siteRes.data.site_list) {
                            const sites = siteRes.data.site_list.map(function(x) {
                                return { site_id: x.site_id, site_name: x.site_name, ms_type: x.ms_type };
                            });
                            if (isGetSites) {
                                node.status({ fill: "blue", shape: "dot", text: sites.length + " Anlage(n) gefunden" });
                                node.send([null, null, { topic: "site_list", payload: sites }]);
                                return;
                            }
                            if (sites.length > 0) {
                                const ownSite = sites.find(function(x) { return x.ms_type === 1; }) || sites[0];
                                SITE_ID = ownSite.site_id;
                                context.set("savedSiteId", SITE_ID);
                            }
                        }
                    }

                    if (!SITE_ID) {
                        node.status({ fill: "red", shape: "dot", text: "Keine SITE_ID gefunden" });
                        return;
                    }

                    const scenRes = await req("/power_service/v1/site/get_scen_info", { site_id: SITE_ID }, authHdrs);
                    if (scenRes && (scenRes.code === 401 || scenRes.code === 10003)) {
                        global.set(sessionKey, null);
                        context.set("loginBlockedUntil", Date.now() + 30000);
                        node.status({ fill: "yellow", shape: "dot", text: "Sitzung erneuert..." });
                        return;
                    }
                    if (!scenRes || scenRes.code !== 0 || !scenRes.data) {
                        const errTxt = "API-Fehler: " + (scenRes ? scenRes.code : "Keine Daten");
                        node.status({ fill: "red", shape: "dot", text: errTxt });
                        node.send([null, null, { topic: "error", payload: errTxt }]);
                        return;
                    }

                    const scen = scenRes.data;
                    node.send([null, { topic: "scen_info", payload: scen }, null]);

                    if (!manualSn && (!DEVICE_SN || !WAKEUP_MODE)) {
                        const pdList = (scen.powerdock_info && scen.powerdock_info.powerdock_list) || [];
                        const gridList = (scen.grid_info && scen.grid_info.grid_list) || [];
                        const sbList = (scen.solarbank_info && scen.solarbank_info.solarbank_list) || [];
                        const ppsList = (scen.pps_info && scen.pps_info.pps_list) || [];

                        let foundPd = pdList.find(function(x) { return String(x.device_pn || "").toUpperCase() === "AE100"; })
                                   || sbList.find(function(x) { return String(x.device_pn || "").toUpperCase() === "AE100"; });
                        let foundMeter = gridList.find(isAnkerSmartMeter) || sbList.find(isAnkerSmartMeter);
                        let foundAcStorage = sbList.find(isAcHomeStorage) || ppsList.find(isAcHomeStorage);
                        let foundSb = sbList.find(function(x) { return String(x.device_pn || "").toUpperCase() !== "AE100" && !isAnkerSmartMeter(x); });

                        if (foundPd && foundPd.device_sn) {
                            DEVICE_SN = foundPd.device_sn;
                            DEVICE_PN = foundPd.device_pn || "AE100";
                            WAKEUP_MODE = "PowerDock";
                        } else if (foundMeter && foundMeter.device_sn) {
                            DEVICE_SN = foundMeter.device_sn;
                            DEVICE_PN = foundMeter.device_pn || "SHEM3";
                            WAKEUP_MODE = "SmartMeter";
                        } else if (foundAcStorage && foundAcStorage.device_sn) {
                            DEVICE_SN = foundAcStorage.device_sn;
                            DEVICE_PN = foundAcStorage.device_pn || "A17E2";
                            WAKEUP_MODE = "HomeStorage";
                        } else if (foundSb && foundSb.device_sn) {
                            DEVICE_SN = foundSb.device_sn;
                            DEVICE_PN = foundSb.device_pn || "A17C1";
                            WAKEUP_MODE = "Solarbank";
                        }

                        if (DEVICE_SN) {
                            context.set("savedPowerdockSn", DEVICE_SN);
                            context.set("savedPowerdockPn", DEVICE_PN);
                            context.set("savedWakeupMode", WAKEUP_MODE);
                        }
                    }

                    if (!config.sb1sn && savedSbs.length === 0 && scen.solarbank_info && scen.solarbank_info.solarbank_list) {
                        const autoSbs = scen.solarbank_info.solarbank_list
                            .filter(function(x) { return String(x.device_pn || "").toUpperCase() !== "AE100" && !isAnkerSmartMeter(x); })
                            .map(function(x) { return x.device_sn; });
                        if (autoSbs.length > 0) {
                            context.set("savedSolarbanks", autoSbs);
                            for (let i = 0; i < 4; i++) { SOLARBANKS[i] = autoSbs[i] || ""; }
                        }
                    }
                    let wakeupStatus = "OK (Cloud aktiv)";
                    const wakeupOverride = context.get("wakeupOverride");
                    let shouldWakeup = false;

                    if (wakeupOverride === true) {
                        shouldWakeup = true;
                    } else if (wakeupOverride === false) {
                        shouldWakeup = false;
                        wakeupStatus = "OK (Wakeup aus)";
                    } else if (WAKEUP_MODE === "PowerDock" || WAKEUP_MODE === "SmartMeter" || WAKEUP_MODE === "HomeStorage" || WAKEUP_MODE === "Manuell") {
                        shouldWakeup = true;
                    } else {
                        shouldWakeup = false;
                        wakeupStatus = "OK (Akkuschutz: Wakeup aus)";
                    }

                    if (shouldWakeup && DEVICE_SN) {
                        wakeupStatus = triggerMqttWakeup(s, DEVICE_SN, DEVICE_PN, WAKEUP_MODE || "Auto");
                    }

                    if (scen.home_load_power !== undefined) { emitSysVar("PD_HAUSLAST", Number(scen.home_load_power)); }
                    if (scen.grid_info) {
                        if (scen.grid_info.grid_to_home_power !== undefined) { emitSysVar("PD_NETZ_BEZUG", Number(scen.grid_info.grid_to_home_power)); }
                        if (scen.grid_info.photovoltaic_to_grid_power !== undefined) { emitSysVar("PD_NETZ_EINSP", Number(scen.grid_info.photovoltaic_to_grid_power)); }
                    }

                    const sbInfo = scen.solarbank_info || {};
                    if (sbInfo.total_battery_power !== undefined && sbInfo.total_battery_power !== "") {
                        const tb = Number(sbInfo.total_battery_power);
                        emitSysVar("PD_SOC", tb <= 1.01 ? Math.round(tb * 100) : Math.round(tb));
                    }
                    if (sbInfo.total_charging_power !== undefined) { emitSysVar("PD_LADEN", Number(sbInfo.total_charging_power)); }
                    if (sbInfo.total_photovoltaic_power !== undefined) { emitSysVar("PD_SOLAR", Number(sbInfo.total_photovoltaic_power)); }
                    if (sbInfo.battery_discharge_power !== undefined) { emitSysVar("PD_ENTLADEN", Number(sbInfo.battery_discharge_power)); }
                    if (sbInfo.total_output_power !== undefined) { emitSysVar("PD_AUSGANG", Number(sbInfo.total_output_power)); }

                    const sbList = sbInfo.solarbank_list || [];
                    for (let idx = 0; idx < 4; idx++) {
                        const targetSn = SOLARBANKS[idx];
                        if (!targetSn) { continue; }
                        const sb = sbList.find(function(item) { return item.device_sn === targetSn; });
                        if (sb) {
                            const pfx = "SB" + (idx + 1) + "_";
                            if (sb.battery_power !== undefined && sb.battery_power !== "") { emitSysVar(pfx + "SOC", Number(sb.battery_power)); }
                            if (sb.photovoltaic_power !== undefined && sb.photovoltaic_power !== "") { emitSysVar(pfx + "SOLAR", Number(sb.photovoltaic_power)); }
                            if (sb.charging_power !== undefined && sb.charging_power !== "") { emitSysVar(pfx + "LADEN", Number(sb.charging_power)); }
                            if (sb.output_power !== undefined && sb.output_power !== "") { emitSysVar(pfx + "OUTPUT", Number(sb.output_power)); }
                            if (sb.temperature !== undefined && sb.temperature !== "") { emitSysVar(pfx + "TEMP", Number(sb.temperature)); }
                            if (sb.pv_power) {
                                if (sb.pv_power.pv1 !== undefined) { emitSysVar(pfx + "PV1", Number(sb.pv_power.pv1)); }
                                if (sb.pv_power.pv2 !== undefined) { emitSysVar(pfx + "PV2", Number(sb.pv_power.pv2)); }
                                if (sb.pv_power.pv3 !== undefined) { emitSysVar(pfx + "PV3", Number(sb.pv_power.pv3)); }
                                if (sb.pv_power.pv4 !== undefined) { emitSysVar(pfx + "PV4", Number(sb.pv_power.pv4)); }
                            }
                            if (sb.solar_power_1 !== undefined) { emitSysVar(pfx + "PV1", Number(sb.solar_power_1)); }
                            if (sb.solar_power_2 !== undefined) { emitSysVar(pfx + "PV2", Number(sb.solar_power_2)); }
                            if (sb.solar_power_3 !== undefined) { emitSysVar(pfx + "PV3", Number(sb.solar_power_3)); }
                            if (sb.solar_power_4 !== undefined) { emitSysVar(pfx + "PV4", Number(sb.solar_power_4)); }
                        }
                    }
                    const lastStatFetch = context.get("lastStatFetch") || 0;
                    if (Date.now() - lastStatFetch > 300000) {
                        context.set("lastStatFetch", Date.now());
                        const dNow = new Date();
                        const pad = function(n) { return n < 10 ? "0" + n : "" + n; };
                        const todayStr = dNow.getFullYear() + "-" + pad(dNow.getMonth() + 1) + "-" + pad(dNow.getDate());
                        const yearStartStr = dNow.getFullYear() + "-01-01";
                        const types = [
                            { type: "day", pfx: "TAG_", start: todayStr, end: todayStr },
                            { type: "week", pfx: "WOCHE_", start: todayStr, end: todayStr },
                            { type: "month", pfx: "MONAT_", start: yearStartStr, end: todayStr },
                            { type: "year", pfx: "JAHR_", start: yearStartStr, end: todayStr }
                        ];

                        for (let t = 0; t < types.length; t++) {
                            const tp = types[t];
                            const stGes = await req("/power_service/v1/site/energy_analysis", {
                                site_id: SITE_ID, device_sn: "", type: tp.type,
                                start_time: tp.start, end_time: tp.end, device_type: "solar_production"
                            }, authHdrs);
                            if (stGes && stGes.code === 0 && stGes.data) {
                                const dG = stGes.data;
                                const p = "STAT_GES_" + tp.pfx;
                                if (dG.solar_total !== undefined) { emitSysVar(p + "SOLAR", Number(dG.solar_total)); }
                                if (dG.charge_total !== undefined) { emitSysVar(p + "LADEN", Number(dG.charge_total)); }
                                if (dG.discharge_total !== undefined) { emitSysVar(p + "ENTLADEN", Number(dG.discharge_total)); }
                                if (dG.solar_to_home_total !== undefined) { emitSysVar(p + "SOLAR_HAUS", Number(dG.solar_to_home_total)); }
                                if (dG.grid_to_home_total !== undefined) { emitSysVar(p + "NETZ", Number(dG.grid_to_home_total)); }
                                if (dG.home_usage_total !== undefined) { emitSysVar(p + "HAUS", Number(dG.home_usage_total)); }
                                if (dG.battery_to_home_total !== undefined) { emitSysVar(p + "BAT_HAUS", Number(dG.battery_to_home_total)); }
                                if (dG.grid_out_total !== undefined) { emitSysVar(p + "EINSP", Number(dG.grid_out_total)); }
                                if (dG.photovoltaic_to_grid_total !== undefined) { emitSysVar(p + "EINSP", Number(dG.photovoltaic_to_grid_total)); }
                            }

                            for (let sIdx = 0; sIdx < 4; sIdx++) {
                                const sbSn = SOLARBANKS[sIdx];
                                if (!sbSn) { continue; }
                                const stSb = await req("/power_service/v1/site/energy_analysis", {
                                    site_id: SITE_ID, device_sn: sbSn, type: tp.type,
                                    start_time: tp.start, end_time: tp.end, device_type: "solar_production"
                                }, authHdrs);
                                if (stSb && stSb.code === 0 && stSb.data) {
                                    const dS = stSb.data;
                                    const pS = "STAT_SB" + (sIdx + 1) + "_" + tp.pfx;
                                    if (dS.solar_total !== undefined) { emitSysVar(pS + "SOLAR", Number(dS.solar_total)); }
                                    if (dS.charge_total !== undefined) { emitSysVar(pS + "LADEN", Number(dS.charge_total)); }
                                    if (dS.discharge_total !== undefined) { emitSysVar(pS + "ENTLADEN", Number(dS.discharge_total)); }
                                }
                            }
                        }
                    }

                    node.status({ fill: "green", shape: "dot", text: wakeupStatus });
                } catch (err) {
                    node.status({ fill: "red", shape: "dot", text: "Verbindungsfehler" });
                    node.send([null, null, { topic: "error", payload: err.message }]);
                } finally {
                    context.set("isBusy", false);
                }
            }

            run();
        });
    }

    RED.nodes.registerType("anker-solix", AnkerSolixNode, {
        credentials: {
            password: { type: "password" }
        }
    });
};
