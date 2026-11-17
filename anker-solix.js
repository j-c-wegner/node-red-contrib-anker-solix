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
                    const seq = (context.get("seq") || 1) + 1;
                    context.set("seq", seq);
                    const authH = { "X-Auth-Token": s.token, "gtoken": s.gtoken };
                    req("/power_service/v1/site/get_site_homepage", {}, authH).catch(function() {});
                    req("/power_service/v1/site/get_site_detail", { site_id: SITE_ID }, authH).catch(function() {});

                    const cid = "android-anker_power-" + s.userId + "-" + s.mqttInfo.certificate_id;
                    const randomSess = Math.floor(1000 + Math.random() * 9000) + "-" + Math.floor(1000 + Math.random() * 9000);
                    const brokerUrl = "mqtts://" + s.mqttInfo.endpoint_addr + ":8883";

                    const client = mqtt.connect(brokerUrl, {
                        clientId: cid,
                        key: s.mqttInfo.private_key,
                        cert: s.mqttInfo.certificate_pem,
                        ca: s.mqttInfo.aws_root_ca1_pem || s.mqttInfo.aws_root_ca || undefined,
                        protocolVersion: 4,
                        clean: true,
                        reconnectPeriod: 0,
                        connectTimeout: 8000
                    });

                    client.on("connect", function() {
                        const nowSec = Math.floor(Date.now() / 1000);
                        const t = Buffer.alloc(4); t.writeUInt32LE(300, 0);
                        const ts = Buffer.alloc(4); ts.writeUInt32LE(nowSec, 0);
                        const raw = Buffer.concat(Array.of(Buffer.from("ff09210003000f0057a10101a20502", "hex"), t, Buffer.from("a30503", "hex"), ts));
                        let xor = 0;
                        for (let i = 0; i < raw.length; i++) { xor ^= raw.readUInt8(i); }
                        const b64 = Buffer.concat(Array.of(raw, Buffer.from(Array.of(xor)))).toString("base64");
                        const msgObj = JSON.stringify({
                            head: {
                                version: "1.0.0.1",
                                client_id: cid,
                                sess_id: randomSess,
                                msg_seq: seq,
                                seed: 1,
                                timestamp: nowSec,
                                cmd_status: 1,
                                cmd: 17,
                                sign_code: 1,
                                device_pn: targetPn,
                                device_sn: targetSn
                            },
                            payload: JSON.stringify({ account_id: s.userId, device_sn: targetSn, data: b64 })
                        });
                        client.publish("cmd/anker_power/" + targetPn + "/" + targetSn + "/req", msgObj, { qos: 0 });
                        setTimeout(function() { try { client.end(true); } catch (e) {} }, 1500);
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

                if (context.get("isBusy")) {
                    return;
                }

                const blockedUntil = context.get("loginBlockedUntil") || 0;
                if (Date.now() < blockedUntil) {
                    const waitMin = Math.ceil((blockedUntil - Date.now()) / 60000);
                    node.status({ fill: "yellow", shape: "ring", text: "Login-Pause (" + waitMin + " Min. Schutz)" });
                    return;
                }

                context.set("isBusy", true);
                try {
                    const cacheKey = "anker_session_" + EMAIL.toLowerCase();
                    let s = global.get(cacheKey) || {};

                    if (!s.token || !s.userId || !s.mqttInfo || (s.expires && Date.now() > s.expires)) {
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
                            password: pwd,
                            time_zone: -3600000,
                            transaction: String(Date.now())
                        });

                        if (!loginRes || loginRes.code !== 0 || !loginRes.data) {
                            const errCode = loginRes ? loginRes.code : 0;
                            const errMsg = (loginRes && loginRes.msg) ? loginRes.msg : "Login fehlgeschlagen";
                            const pauseMs = (errCode === 10019) ? (11 * 60 * 1000) : (60 * 1000);
                            context.set("loginBlockedUntil", Date.now() + pauseMs);
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
                            mqttInfo: null,
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
                            context.set("loginBlockedUntil", Date.now() + (30 * 1000));
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

                        let foundDock = scen.powerdock_info || (scen.powerpanel_info && scen.powerpanel_info.powerdock_info) || null;
                        if (!foundDock && scen.combiner_box_info && scen.combiner_box_info.combiner_box_list && scen.combiner_box_info.combiner_box_list.length > 0) {
                            foundDock = scen.combiner_box_info.combiner_box_list;
                        }
                        if (!foundDock) {
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

                    const sbInfo = scen.solarbank_info || {};
                    const gridInfo = scen.grid_info || {};

                    emitSysVar("PD_HAUSLAST", Number(scen.home_load_power || 0));
                    emitSysVar("PD_NETZ_BEZUG", Number(gridInfo.grid_to_home_power || gridInfo.total_grid_input_power || 0));
                    emitSysVar("PD_NETZ_EINSP", Number(gridInfo.photovoltaic_to_grid_power || gridInfo.total_grid_output_power || 0));
                    emitSysVar("PD_SOC", Math.round(Number(sbInfo.total_battery_power || 0) * 100));
                    emitSysVar("PD_LADEN", Number(sbInfo.total_charging_power || 0));
                    emitSysVar("PD_AKKU_LEISTUNG", Number(sbInfo.total_charging_power || 0));
                    emitSysVar("PD_SOLAR", Number(sbInfo.total_photovoltaic_power || 0));
                    emitSysVar("PD_ENTLADEN", Number(sbInfo.battery_discharge_power || 0));
                    emitSysVar("PD_AUSGANG", Number(sbInfo.total_output_power || 0));

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
                            const pv = sb.pv_power || {};
                            const pfx = "SB" + (idx + 1) + "_";
                            const socVal = Number(sb.battery_power || 0);
                            emitSysVar(pfx + "SOC", socVal <= 1 ? Math.round(socVal * 100) : Math.round(socVal));
                            emitSysVar(pfx + "SOLAR", Number(sb.photovoltaic_power || 0));
                            emitSysVar(pfx + "LADEN", Number(sb.bat_charge_power || sb.charging_power || 0));
                            emitSysVar(pfx + "AKKU", Number(sb.bat_charge_power || sb.charging_power || 0));
                            emitSysVar(pfx + "OUTPUT", Number(sb.output_power || 0));
                            emitSysVar(pfx + "AUSGANG", Number(sb.output_power || 0));
                            emitSysVar(pfx + "TEMP", Number(sb.device_temperature || 0));
                            emitSysVar(pfx + "PV1", Number(pv.pv1 || 0));
                            emitSysVar(pfx + "PV2", Number(pv.pv2 || 0));
                            emitSysVar(pfx + "PV3", Number(pv.pv3 || 0));
                            emitSysVar(pfx + "PV4", Number(pv.pv4 || 0));
                        }
                    }
                    const now = new Date();
                    const nowMs = now.getTime();
                    const min = now.getMinutes();
                    if (min % 20 >= 1) {
                        const slotIndex = Math.floor(min / 20);
                        const today = now.toISOString().slice(0, 10);
                        const currentSlot = today + "_" + now.getHours() + "_slot" + slotIndex;
                        if (context.get("lastEnergySlot") !== currentSlot) {
                            const dayOfWeek = now.getDay() || 7;
                            const monday = new Date(now);
                            monday.setDate(now.getDate() - dayOfWeek + 1);
                            const weekStart = monday.toISOString().slice(0, 10);
                            const monthStart = today.slice(0, 7) + "-01";
                            const yearStart = today.slice(0, 4) + "-01-01";

                            const targets = [
                                { key: "gesamt", sn: "", devType: "solar_production" },
                                { key: "gesamt_home", sn: "", devType: "home_usage" }
                            ];
                            for (let k = 0; k < 4; k++) {
                                if (SOLARBANKS[k]) {
                                    targets.push({ key: SOLARBANKS[k], sn: SOLARBANKS[k], devType: "solar_production" });
                                }
                            }

                            const periods = [
                                { name: "day", label: "TAG", apiType: "week", start: today, interval: 1140000 },
                                { name: "week", label: "WOCHE", apiType: "week", start: weekStart, interval: 1140000 },
                                { name: "month", label: "MONAT", apiType: "month", start: monthStart, interval: 7200000 },
                                { name: "year", label: "JAHR", apiType: "year", start: yearStart, interval: 7200000 }
                            ];

                            const jobTimes = context.get("jobTimes") || {};
                            const cache = context.get("energyCache") || {};
                            let nextJob = null;

                            for (let i = 0; i < targets.length; i++) {
                                if (!cache[targets[i].key]) { cache[targets[i].key] = {}; }
                                for (let j = 0; j < periods.length; j++) {
                                    const jobId = targets[i].key + "_" + periods[j].name;
                                    if (nowMs - (jobTimes[jobId] || 0) >= periods[j].interval) {
                                        nextJob = { id: jobId, target: targets[i], period: periods[j] };
                                        break;
                                    }
                                }
                                if (nextJob) { break; }
                            }

                            if (nextJob) {
                                context.set("lastEnergySlot", currentSlot);
                                jobTimes[nextJob.id] = nowMs;
                                context.set("jobTimes", jobTimes);
                                try {
                                    const stRes = await req("/power_service/v1/site/energy_analysis", {
                                        site_id: SITE_ID,
                                        device_sn: nextJob.target.sn,
                                        type: nextJob.period.apiType,
                                        start_time: nextJob.period.start,
                                        end_time: today,
                                        device_type: nextJob.target.devType
                                    }, authHdrs);
                                    if (stRes && stRes.code === 0 && stRes.data) {
                                        cache[nextJob.target.key][nextJob.period.name] = stRes.data;
                                        context.set("energyCache", cache);
                                        for (let p = 0; p < periods.length; p++) {
                                            const pk = periods[p].name;
                                            const pl = periods[p].label;
                                            if (cache.gesamt && cache.gesamt[pk]) {
                                                const g = cache.gesamt[pk];
                                                if (g.solar_total !== "") { emitSysVar("STAT_GES_" + pl + "_SOLAR", Number(g.solar_total)); }
                                                if (g.charge_total !== "") { emitSysVar("STAT_GES_" + pl + "_LADEN", Number(g.charge_total)); }
                                                if (g.discharge_total !== "") { emitSysVar("STAT_GES_" + pl + "_ENTLADEN", Number(g.discharge_total)); }
                                                if (g.solar_to_home_total !== "") { emitSysVar("STAT_GES_" + pl + "_SOLAR_HAUS", Number(g.solar_to_home_total)); }
                                                if (g.solar_to_grid_total !== "") { emitSysVar("STAT_GES_" + pl + "_EINSP", Number(g.solar_to_grid_total)); }
                                            }
                                            if (cache.gesamt_home && cache.gesamt_home[pk]) {
                                                const gh = cache.gesamt_home[pk];
                                                if (gh.grid_to_home_total !== "") { emitSysVar("STAT_GES_" + pl + "_NETZ", Number(gh.grid_to_home_total)); }
                                                if (gh.home_usage_total !== "") { emitSysVar("STAT_GES_" + pl + "_HAUS", Number(gh.home_usage_total)); }
                                                if (gh.battery_to_home_total !== "") { emitSysVar("STAT_GES_" + pl + "_BAT_HAUS", Number(gh.battery_to_home_total)); }
                                            }
                                            for (let sIdx = 0; sIdx < 4; sIdx++) {
                                                const sSn = SOLARBANKS[sIdx];
                                                if (sSn && cache[sSn] && cache[sSn][pk]) {
                                                    const sbStat = cache[sSn][pk];
                                                    const sPfx = "STAT_SB" + (sIdx + 1) + "_" + pl + "_";
                                                    if (sbStat.solar_total !== "") { emitSysVar(sPfx + "SOLAR", Number(sbStat.solar_total)); }
                                                    if (sbStat.charge_total !== "") { emitSysVar(sPfx + "LADEN", Number(sbStat.charge_total)); }
                                                    if (sbStat.discharge_total !== "") { emitSysVar(sPfx + "ENTLADEN", Number(sbStat.discharge_total)); }
                                                }
                                            }
                                        }
                                    }
                                } catch (e) {}
                            }
                        }
                    }

                    const timeStr = new Date().toLocaleTimeString("de-DE");
                    node.status({ fill: "green", shape: "dot", text: wakeupStatus + " (" + timeStr + ")" });
                    node.send([null, null, { topic: "status", payload: wakeupStatus, wakeupMode: WAKEUP_MODE || "Auto" }]);
                } finally {
                    context.set("isBusy", false);
                }
            }

            run().catch(function(err) {
                context.set("isBusy", false);
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
