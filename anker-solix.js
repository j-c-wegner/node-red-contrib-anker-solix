const https = require("https");
const crypto = require("crypto");
const mqtt = require("mqtt");

module.exports = function(RED) {
    function AnkerSolixNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const context = node.context();
        const global = node.context().global;

        const API_HOST = "ankerpower-api-eu" + "." + "anker" + "." + "com";
        const PUB_KEY = "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

        node.on("input", function(msg) {
            const cmdTopic = String(msg.topic || "").trim().toLowerCase();
            const rawPayload = msg.payload;
            const cmdPayload = String(rawPayload !== undefined && rawPayload !== null ? rawPayload : "").trim().toLowerCase();
            const isGetSites = (cmdTopic === "get_sites" || cmdPayload === "get_sites");

            if (cmdTopic === "set_wakeup") {
                const enableWakeup = (rawPayload === true || cmdPayload === "true" || cmdPayload === "1" || cmdPayload === "ein" || cmdPayload === "on");
                context.set("wakeupOverride", enableWakeup);
                const stateTxt = enableWakeup ? "AKTIVIERT (manuell)" : "DEAKTIVIERT (Nacht-/Akkuschutz)";
                node.status({ fill: enableWakeup ? "green" : "yellow", shape: "dot", text: "Wakeup: " + stateTxt });
                node.send([null, null, { topic: "set_wakeup", payload: enableWakeup, status: stateTxt }]);
                return;
            }

            const EMAIL = (config.email || "").trim();
            const PASSWORD = (node.credentials && node.credentials.password) ? node.credentials.password : "";
            let SITE_ID = (config.siteId || "").trim() || context.get("savedSiteId") || "";
            let DEVICE_SN = (config.powerdockSn || "").trim() || context.get("savedPowerdockSn") || "";
            let DEVICE_PN = (config.powerdockPn || "").trim() || context.get("savedPowerdockPn") || "";
            let WAKEUP_MODE = context.get("savedWakeupMode") || "";

            let SV_MAP = {};
            if (config.sysvarsJson) {
                try { SV_MAP = JSON.parse(config.sysvarsJson); } catch (e) { SV_MAP = {}; }
            }

            const savedSbs = context.get("savedSolarbanks") || [];
            const SOLARBANKS = [
                (config.sb1Sn || "").trim() || savedSbs[0] || "",
                (config.sb2Sn || "").trim() || savedSbs[1] || "",
                (config.sb3Sn || "").trim() || savedSbs[2] || "",
                (config.sb4Sn || "").trim() || savedSbs[3] || ""
            ];

            function emitSysVar(key, val) {
                const svName = (SV_MAP[key] || "").trim();
                if (!svName || val === null || val === undefined || isNaN(val)) { return; }
                const lastSent = context.get("lastSent") || {};
                if (lastSent[svName] === val) { return; }
                lastSent[svName] = val;
                context.set("lastSent", lastSent);
                node.send([{ topic: svName, payload: val }, null, null]);
            }

            function req(apiPath, body, hdrs) {
                return new Promise(function(resolve, reject) {
                    const d = JSON.stringify(body);
                    const h = Object.assign({
                        "Content-Type": "application/json",
                        "User-Agent": "AnkerPower/3.1.0 (Linux; U; Android 14; SM-S918B Build/UP1A.231005.007)",
                        "Country": "DE",
                        "Timezone": "GMT+01:00",
                        "Model-Type": "PHONE",
                        "App-Version": "3.1.0",
                        "App-Name": "anker_power",
                        "Os-Type": "android",
                        "Content-Length": Buffer.byteLength(d)
                    }, hdrs || {});
                    const opts = { hostname: API_HOST, path: apiPath, method: "POST", headers: h };
                    const r = https.request(opts, function(res) {
                        let b = "";
                        res.on("data", function(c) { b += c; });
                        res.on("end", function() { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
                    });
                    r.on("error", reject); r.write(d); r.end();
                });
            }
            function isAnkerSmartMeter(dev) {
                if (!dev) { return false; }
                const pn = String(dev.device_pn || "").toUpperCase();
                const name = String(dev.device_name || "").toLowerCase();
                if (pn.indexOf("SH3EM") !== -1 || pn.indexOf("SHPRO") !== -1 || name.indexOf("shelly") !== -1) {
                    return false;
                }
                const meterPns = ["SHEM3", "A17X7", "A17X8", "AE1R0", "A17X6"];
                if (meterPns.indexOf(pn) !== -1) { return true; }
                if (name.indexOf("smart meter") !== -1 || name.indexOf("smartmeter") !== -1) { return true; }
                return false;
            }

            function triggerMqttWakeup(s, targetSn, targetPn, modeLabel) {
                const now = Date.now();
                const nextAllowed = context.get("nextWakeupTime") || 0;
                if (now < nextAllowed) {
                    const remSec = Math.round((nextAllowed - now) / 1000);
                    return "OK (nächster Wakeup in " + remSec + "s)";
                }

                const nextJitterSec = 210 + Math.floor(Math.random() * 211);
                context.set("nextWakeupTime", now + (nextJitterSec * 1000));

                if (!s.mqttInfo || !s.mqttInfo.endpoint_addr) {
                    return "OK (kein MQTT-Endpunkt)";
                }

                try {
                    const clientId = "android-ankerpower-" + crypto.randomBytes(8).toString("hex");
                    const brokerUrl = "mqtts://" + s.mqttInfo.endpoint_addr + ":8883";
                    const client = mqtt.connect(brokerUrl, {
                        clientId: clientId,
                        ca: s.mqttInfo.aws_root_ca || undefined,
                        cert: s.mqttInfo.certificate_pem || undefined,
                        key: s.mqttInfo.private_key || undefined,
                        rejectUnauthorized: false,
                        connectTimeout: 8000
                    });

                    client.on("connect", function() {
                        const topic = "cmd/dev/" + targetPn + "/" + targetSn + "/pull_to_refresh";
                        const payload = JSON.stringify({
                            account_id: s.userId || "",
                            device_sn: targetSn,
                            command: "pull_to_refresh",
                            timestamp: Math.floor(Date.now() / 1000)
                        });
                        client.publish(topic, payload, { qos: 0 }, function() {
                            setTimeout(function() { try { client.end(true); } catch (e) {} }, 500);
                        });
                    });

                    client.on("error", function() {
                        try { client.end(true); } catch (e) {}
                    });

                    return "OK + Wakeup [" + modeLabel + "] (nächster in " + nextJitterSec + "s)";
                } catch (e) {
                    return "OK (Wakeup-Fehler)";
                }
            }
            async function run() {
                if (!EMAIL || !PASSWORD) {
                    node.status({ fill: "red", shape: "ring", text: "E-Mail/Passwort fehlt" });
                    return;
                }

                const cacheKey = "anker_session_" + EMAIL.toLowerCase();
                let s = global.get(cacheKey) || {};

                if (!s.token || !s.userId || (s.expires && Date.now() > s.expires)) {
                    const ecdh = crypto.createECDH("prime256v1");
                    ecdh.generateKeys();
                    const pubHex = ecdh.getPublicKey("hex");
                    const shared = ecdh.computeSecret(Buffer.from(PUB_KEY, "hex"));
                    const key = shared.slice(0, 16);
                    const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
                    let enc = cipher.update(PASSWORD, "utf8", "base64");
                    enc += cipher.final("base64");

                    const loginRes = await req("/passport/login", {
                        ab: "DE",
                        client_secret_info: { public_key: pubHex },
                        enc: 0,
                        email: EMAIL,
                        password: enc,
                        time_zone: 3600000,
                        transaction: String(Date.now())
                    });

                    if (!loginRes || loginRes.code !== 0 || !loginRes.data) {
                        const errMsg = (loginRes && loginRes.msg) ? loginRes.msg : "Login fehlgeschlagen";
                        node.status({ fill: "red", shape: "dot", text: errMsg });
                        node.send([null, null, { topic: "error", payload: loginRes }]);
                        return;
                    }

                    const d = loginRes.data;
                    const gAuth = crypto.createHash("md5").update(d.user_id).digest("hex");
                    s = {
                        token: d.auth_token,
                        userId: d.user_id,
                        gtoken: gAuth,
                        expires: Date.now() + (20 * 3600 * 1000)
                    };

                    try {
                        const certRes = await req("/app/devicemanage/get_user_mqtt_info", {}, {
                            "X-Auth-Token": s.token,
                            "gtoken": s.gtoken
                        });
                        if (certRes && certRes.code === 0 && certRes.data) {
                            s.mqttInfo = certRes.data;
                        }
                    } catch (e) {}

                    global.set(cacheKey, s);
                }

                const authHdrs = { "X-Auth-Token": s.token, "gtoken": s.gtoken };

                if (!SITE_ID || isGetSites) {
                    const siteRes = await req("/power_service/v1/site/get_site_list", {}, authHdrs);
                    if (!siteRes || siteRes.code !== 0 || !siteRes.data || !siteRes.data.site_list) {
                        node.status({ fill: "red", shape: "dot", text: "Site-Liste Fehler" });
                        return;
                    }
                    const list = siteRes.data.site_list;
                    if (isGetSites) {
                        const summary = list.map(function(item) {
                            return { Name: item.site_name, SITE_ID: item.site_id, Rolle: item.ms_type };
                        });
                        const outTxt = "Anker SOLIX – Gefundene Anlagen: " + JSON.stringify(summary);
                        node.status({ fill: "blue", shape: "dot", text: list.length + " Anlage(n) gefunden" });
                        node.send([null, null, { topic: "get_sites", payload: outTxt, sites: summary }]);
                        return;
                    }
                    const ownSite = list.find(function(x) { return x.ms_type === 1; }) || list;
                    if (ownSite && ownSite.site_id) {
                        SITE_ID = ownSite.site_id;
                        context.set("savedSiteId", SITE_ID);
                    }
                }

                const scenRes = await req("/power_service/v1/site/get_scen_info", { site_id: SITE_ID }, authHdrs);
                if (!scenRes || scenRes.code !== 0 || !scenRes.data) {
                    if (scenRes && (scenRes.code === 401 || scenRes.code === 10003)) {
                        global.set(cacheKey, null);
                    }
                    node.status({ fill: "red", shape: "dot", text: "Abruf-Fehler (" + (scenRes ? scenRes.code : "?") + ")" });
                    return;
                }

                const scen = scenRes.data;
                node.send([null, { topic: "scen_info", payload: scen }, null]);

                if (!DEVICE_SN || !WAKEUP_MODE) {
                    const sbList = (scen.solarbank_info && scen.solarbank_info.solarbank_list) ? scen.solarbank_info.solarbank_list : [];
                    const gridList = (scen.grid_info && scen.grid_info.grid_list) ? scen.grid_info.grid_list : [];
                    const ppsList = (scen.pps_info && scen.pps_info.pps_list) ? scen.pps_info.pps_list : [];

                    let foundDock = null;
                    if (scen.combiner_box_info && scen.combiner_box_info.combiner_box_list && scen.combiner_box_info.combiner_box_list.length > 0) {
                        foundDock = scen.combiner_box_info.combiner_box_list;
                    } else {
                        foundDock = sbList.find(function(x) { return String(x.device_pn || "").toUpperCase() === "AE100"; }) ||
                                    ppsList.find(function(x) { return String(x.device_pn || "").toUpperCase() === "AE100"; });
                    }

                    let foundMeter = gridList.find(isAnkerSmartMeter) ||
                                     sbList.find(isAnkerSmartMeter) ||
                                     ppsList.find(isAnkerSmartMeter);

                    const realSbs = sbList.filter(function(x) {
                        return String(x.device_pn || "").toUpperCase() !== "AE100" && !isAnkerSmartMeter(x);
                    });

                    if (realSbs.length > 0) {
                        const detectedSns = realSbs.map(function(x) { return x.device_sn || ""; });
                        context.set("savedSolarbanks", detectedSns);
                        for (let i = 0; i < 4; i++) {
                            if (!SOLARBANKS[i] && detectedSns[i]) { SOLARBANKS[i] = detectedSns[i]; }
                        }
                    }

                    if (foundDock && foundDock.device_sn) {
                        DEVICE_SN = foundDock.device_sn;
                        DEVICE_PN = foundDock.device_pn || "AE100";
                        WAKEUP_MODE = "PowerDock";
                    } else if (foundMeter && foundMeter.device_sn) {
                        DEVICE_SN = foundMeter.device_sn;
                        DEVICE_PN = foundMeter.device_pn || "SHEM3";
                        WAKEUP_MODE = "SmartMeter";
                    } else if (realSbs.length > 0 && realSbs.device_sn) {
                        DEVICE_SN = realSbs.device_sn;
                        DEVICE_PN = realSbs.device_pn || "A17C1";
                        WAKEUP_MODE = "Solarbank";
                    }

                    if (DEVICE_SN) {
                        context.set("savedPowerdockSn", DEVICE_SN);
                        context.set("savedPowerdockPn", DEVICE_PN);
                        context.set("savedWakeupMode", WAKEUP_MODE);
                    }
                }
                let wakeupStatus = "OK";
                const manualOverride = context.get("wakeupOverride");
                let shouldWakeup = false;

                if (manualOverride !== undefined) {
                    shouldWakeup = Boolean(manualOverride);
                } else if (WAKEUP_MODE === "PowerDock" || WAKEUP_MODE === "SmartMeter") {
                    shouldWakeup = true;
                } else {
                    shouldWakeup = false;
                }

                if (DEVICE_SN && shouldWakeup) {
                    wakeupStatus = triggerMqttWakeup(s, DEVICE_SN, DEVICE_PN, WAKEUP_MODE || "Auto");
                } else if (WAKEUP_MODE === "Solarbank" && !shouldWakeup) {
                    wakeupStatus = "OK (Akkuschutz: Wakeup aus)";
                }

                const num = function(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
                const sbInfo = scen.solarbank_info || {};
                const gridInfo = scen.grid_info || {};

                emitSysVar("PD_SOLAR", num(sbInfo.total_photovoltaic_power));
                emitSysVar("PD_HAUSLAST", num(scen.home_load_power));
                emitSysVar("PD_AKKU_LEISTUNG", num(sbInfo.total_charging_power));
                emitSysVar("PD_AUSGANG", num(sbInfo.total_output_power));
                emitSysVar("PD_SOC", Math.round(num(sbInfo.total_battery_power) * 100));
                emitSysVar("PD_NETZ_BEZUG", num(gridInfo.total_grid_input_power));
                emitSysVar("PD_NETZ_EINSP", num(gridInfo.total_grid_output_power));

                const allSbs = (sbInfo.solarbank_list || []).filter(function(x) {
                    return String(x.device_pn || "").toUpperCase() !== "AE100" && !isAnkerSmartMeter(x);
                });

                for (let idx = 0; idx < 4; idx++) {
                    const targetSn = SOLARBANKS[idx];
                    let sb = null;
                    if (targetSn) {
                        sb = allSbs.find(function(x) { return x.device_sn === targetSn; });
                    } else if (allSbs[idx]) {
                        sb = allSbs[idx];
                    }
                    if (sb) {
                        const p = "SB" + (idx + 1) + "_";
                        emitSysVar(p + "SOC", Math.round(num(sb.battery_power) * 100));
                        emitSysVar(p + "SOLAR", num(sb.photovoltaic_power));
                        emitSysVar(p + "AUSGANG", num(sb.output_power));
                        emitSysVar(p + "AKKU", num(sb.charging_power));
                        emitSysVar(p + "TEMP", num(sb.device_temperature));
                    }
                }

                const lastStat = context.get("lastStatTime") || 0;
                if (Date.now() - lastStat > 20 * 60 * 1000) {
                    context.set("lastStatTime", Date.now());
                    const todayStr = new Date().toISOString().slice(0, 10);
                    const yearStr = todayStr.slice(0, 4);
                    const statTypes = [
                        { type: "day", start: todayStr, end: todayStr, prefix: "STAT_TAG_" },
                        { type: "week", start: todayStr, end: todayStr, prefix: "STAT_WOCHE_" },
                        { type: "month", start: todayStr, end: todayStr, prefix: "STAT_MONAT_" },
                        { type: "year", start: yearStr + "-01-01", end: todayStr, prefix: "STAT_JAHR_" }
                    ];

                    for (let stIdx = 0; stIdx < statTypes.length; stIdx++) {
                        const st = statTypes[stIdx];
                        try {
                            const stRes = await req("/power_service/v1/site/energy_analysis", {
                                site_id: SITE_ID,
                                device_sn: "",
                                type: st.type,
                                start_time: st.start,
                                end_time: st.end,
                                device_type: "solarbank"
                            }, authHdrs);
                            if (stRes && stRes.code === 0 && stRes.data) {
                                const sd = stRes.data;
                                emitSysVar(st.prefix + "SOLAR", num(sd.solar_production));
                                emitSysVar(st.prefix + "VERBRAUCH", num(sd.home_usage));
                                emitSysVar(st.prefix + "NETZ_BEZUG", num(sd.grid_to_home));
                                emitSysVar(st.prefix + "NETZ_EINSP", num(sd.solar_to_grid));
                            }
                        } catch (e) {}
                    }
                }

                const timeStr = new Date().toLocaleTimeString("de-DE");
                node.status({ fill: "green", shape: "dot", text: wakeupStatus + " (" + timeStr + ")" });
                node.send([null, null, { topic: "status", payload: wakeupStatus, wakeupMode: WAKEUP_MODE || "Auto" }]);
            }

            run().catch(function(err) {
                const msgTxt = (err && err.message) ? err.message : String(err);
                node.status({ fill: "red", shape: "dot", text: "Fehler: " + msgTxt });
                node.send([null, null, { topic: "error", payload: msgTxt }]);
            });
        });
    }
    RED.nodes.registerType("anker-solix", AnkerSolixNode, {
        credentials: {
            password: { type: "password" }
        }
    });
};
