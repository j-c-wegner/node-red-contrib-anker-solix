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
            const cmdPayload = String(msg.payload || "").trim().toLowerCase();
            const isGetSites = (cmdTopic === "get_sites" || cmdPayload === "get_sites");

            const EMAIL = (config.email || "").trim();
            const PASSWORD = (node.credentials && node.credentials.password) ? node.credentials.password : "";
            let SITE_ID = (config.siteId || "").trim() || context.get("savedSiteId") || "";
            let DEVICE_SN = (config.powerdockSn || "").trim() || context.get("savedPowerdockSn") || "";
            let DEVICE_PN = (config.powerdockPn || "").trim() || context.get("savedPowerdockPn") || "";

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
            function sendPullToRefresh(s) {
                if (!DEVICE_SN || !DEVICE_PN || Date.now() - (context.get("lastWake") || 0) < 240000 || !s.mqttInfo) { return; }
                context.set("lastWake", Date.now());
                const seq = (context.get("seq") || 1) + 1;
                context.set("seq", seq);
                const authH = { "X-Auth-Token": s.token, "gtoken": s.gtoken };
                req("/power_service/v1/site/get_site_homepage", {}, authH).catch(function() {});
                req("/power_service/v1/site/get_site_detail", { site_id: SITE_ID }, authH).catch(function() {});
                const cid = "android-anker_power-" + s.userId + "-" + s.mqttInfo.certificate_id;
                const randomSess = Math.floor(1000 + Math.random() * 9000) + "-" + Math.floor(1000 + Math.random() * 9000);
                const c = mqtt.connect("mqtts://" + s.mqttInfo.endpoint_addr + ":8883", {
                    clientId: cid, key: s.mqttInfo.private_key, cert: s.mqttInfo.certificate_pem, ca: s.mqttInfo.aws_root_ca1_pem, protocolVersion: 4, clean: true, reconnectPeriod: 0
                });
                c.on("connect", function() {
                    const nowSec = Math.floor(Date.now() / 1000);
                    const t = Buffer.alloc(4); t.writeUInt32LE(300, 0);
                    const ts = Buffer.alloc(4); ts.writeUInt32LE(nowSec, 0);
                    const raw = Buffer.concat([Buffer.from("ff09210003000f0057a10101a20502", "hex"), t, Buffer.from("a30503", "hex"), ts]);
                    let xor = 0; for (let i = 0; i < raw.length; i++) { xor ^= raw.readUInt8(i); }
                    const b64 = Buffer.concat([raw, Buffer.from([xor])]).toString("base64");
                    const msgObj = JSON.stringify({
                        head: { version: "1.0.0.1", client_id: cid, sess_id: randomSess, msg_seq: seq, seed: 1, timestamp: nowSec, cmd_status: 1, cmd: 17, sign_code: 1, device_pn: DEVICE_PN, device_sn: DEVICE_SN },
                        payload: JSON.stringify({ account_id: s.userId, device_sn: DEVICE_SN, data: b64 })
                    });
                    c.publish("cmd/anker_power/" + DEVICE_PN + "/" + DEVICE_SN + "/req", msgObj, { qos: 0 });
                    setTimeout(function() { try { c.end(true); } catch (e) {} }, 1500);
                });
                c.on("error", function() { try { c.end(true); } catch (e) {} });
            }

            function processLive(d) {
                if (!d || !d.grid_info || !d.solarbank_info) { return; }
                const list = d.solarbank_info.solarbank_list || [];
                if (!DEVICE_SN) {
                    const pd = d.powerdock_info || (d.powerpanel_info && d.powerpanel_info.powerdock_info);
                    if (pd && pd.device_sn) {
                        DEVICE_SN = pd.device_sn;
                        DEVICE_PN = pd.device_pn || DEVICE_PN || "AE100";
                        context.set("savedPowerdockSn", DEVICE_SN);
                        context.set("savedPowerdockPn", DEVICE_PN);
                    } else if (list.length > 0 && list.device_sn) {
                        DEVICE_SN = list.device_sn;
                        DEVICE_PN = list.device_pn || DEVICE_PN || "A17C1";
                        context.set("savedPowerdockSn", DEVICE_SN);
                        context.set("savedPowerdockPn", DEVICE_PN);
                    }
                }
                if (!SOLARBANKS && list.length > 0) {
                    for (let idx = 0; idx < 4; idx++) {
                        SOLARBANKS[idx] = list[idx] ? (list[idx].device_sn || "") : "";
                    }
                    context.set("savedSolarbanks", SOLARBANKS);
                }
                emitSysVar("PD_HAUSLAST", Number(d.home_load_power || 0));
                emitSysVar("PD_NETZ_BEZUG", Number(d.grid_info.grid_to_home_power || 0));
                emitSysVar("PD_NETZ_EINSP", Number(d.grid_info.photovoltaic_to_grid_power || 0));
                emitSysVar("PD_SOC", Math.round(Number(d.solarbank_info.total_battery_power || 0) * 100));
                emitSysVar("PD_LADEN", Number(d.solarbank_info.total_charging_power || 0));
                emitSysVar("PD_SOLAR", Number(d.solarbank_info.total_photovoltaic_power || 0));
                emitSysVar("PD_ENTLADEN", Number(d.solarbank_info.battery_discharge_power || 0));
                for (let i = 0; i < 4; i++) {
                    const sn = SOLARBANKS[i];
                    if (!sn) { continue; }
                    const sb = list.find(function(item) { return item.device_sn === sn; });
                    if (!sb) { continue; }
                    const pv = sb.pv_power || {};
                    const pfx = "SB" + (i + 1) + "_";
                    emitSysVar(pfx + "SOC", Number(sb.battery_power || 0));
                    emitSysVar(pfx + "SOLAR", Number(sb.photovoltaic_power || 0));
                    emitSysVar(pfx + "LADEN", Number(sb.bat_charge_power || 0));
                    emitSysVar(pfx + "OUTPUT", Number(sb.output_power || 0));
                    emitSysVar(pfx + "PV1", Number(pv.pv1 || 0));
                    emitSysVar(pfx + "PV2", Number(pv.pv2 || 0));
                    emitSysVar(pfx + "PV3", Number(pv.pv3 || 0));
                    emitSysVar(pfx + "PV4", Number(pv.pv4 || 0));
                }
            }
            function processStats(cache) {
                const periods = [ { k: "day", l: "TAG" }, { k: "week", l: "WOCHE" }, { k: "month", l: "MONAT" }, { k: "year", l: "JAHR" } ];
                for (let p = 0; p < periods.length; p++) {
                    const pk = periods[p].k, pl = periods[p].l;
                    if (cache.gesamt && cache.gesamt[pk]) {
                        const g = cache.gesamt[pk];
                        if (g.solar_total !== "") emitSysVar("STAT_GES_" + pl + "_SOLAR", Number(g.solar_total));
                        if (g.charge_total !== "") emitSysVar("STAT_GES_" + pl + "_LADEN", Number(g.charge_total));
                        if (g.discharge_total !== "") emitSysVar("STAT_GES_" + pl + "_ENTLADEN", Number(g.discharge_total));
                        if (g.solar_to_home_total !== "") emitSysVar("STAT_GES_" + pl + "_SOLAR_HAUS", Number(g.solar_to_home_total));
                        if (g.solar_to_grid_total !== "") emitSysVar("STAT_GES_" + pl + "_EINSP", Number(g.solar_to_grid_total));
                    }
                    if (cache.gesamt_home && cache.gesamt_home[pk]) {
                        const gh = cache.gesamt_home[pk];
                        if (gh.grid_to_home_total !== "") emitSysVar("STAT_GES_" + pl + "_NETZ", Number(gh.grid_to_home_total));
                        if (gh.home_usage_total !== "") emitSysVar("STAT_GES_" + pl + "_HAUS", Number(gh.home_usage_total));
                        if (gh.battery_to_home_total !== "") emitSysVar("STAT_GES_" + pl + "_BAT_HAUS", Number(gh.battery_to_home_total));
                    }
                    for (let i = 0; i < 4; i++) {
                        const sn = SOLARBANKS[i];
                        if (sn && cache[sn] && cache[sn][pk]) {
                            const sb = cache[sn][pk], pfx = "STAT_SB" + (i + 1) + "_" + pl + "_";
                            if (sb.solar_total !== "") emitSysVar(pfx + "SOLAR", Number(sb.solar_total));
                            if (sb.charge_total !== "") emitSysVar(pfx + "LADEN", Number(sb.charge_total));
                            if (sb.discharge_total !== "") emitSysVar(pfx + "ENTLADEN", Number(sb.discharge_total));
                        }
                    }
                }
            }

            function fetchNextEnergyJob(s) {
                const now = new Date(), nowMs = now.getTime(), min = now.getMinutes();
                if (min % 20 < 1) { return; }
                const slotIndex = Math.floor(min / 20), today = now.toISOString().slice(0, 10);
                const currentSlot = today + "_" + now.getHours() + "_slot" + slotIndex;
                if (context.get("lastEnergySlot") === currentSlot) { return; }
                const dayOfWeek = now.getDay() || 7, monday = new Date(now);
                monday.setDate(now.getDate() - dayOfWeek + 1);
                const weekStart = monday.toISOString().slice(0, 10), monthStart = today.slice(0, 7) + "-01", yearStart = today.slice(0, 4) + "-01-01";
                const targets = [ { key: "gesamt", sn: "", devType: "solar_production" }, { key: "gesamt_home", sn: "", devType: "home_usage" } ];
                for (let k = 0; k < 4; k++) { if (SOLARBANKS[k]) { targets.push({ key: SOLARBANKS[k], sn: SOLARBANKS[k], devType: "solar_production" }); } }
                const periods = [ { name: "day", apiType: "week", start: today, interval: 1140000 }, { name: "week", apiType: "week", start: weekStart, interval: 1140000 }, { name: "month", apiType: "month", start: monthStart, interval: 7200000 }, { name: "year", apiType: "year", start: yearStart, interval: 7200000 } ];
                const jobTimes = context.get("jobTimes") || {}, cache = context.get("energyCache") || {};
                let nextJob = null;
                for (let i = 0; i < targets.length; i++) {
                    if (!cache[targets[i].key]) { cache[targets[i].key] = {}; }
                    for (let j = 0; j < periods.length; j++) {
                        const jobId = targets[i].key + "_" + periods[j].name;
                        if (nowMs - (jobTimes[jobId] || 0) >= periods[j].interval) { nextJob = { id: jobId, target: targets[i], period: periods[j] }; break; }
                    }
                    if (nextJob) { break; }
                }
                if (!nextJob) { return; }
                context.set("lastEnergySlot", currentSlot); jobTimes[nextJob.id] = nowMs; context.set("jobTimes", jobTimes);
                const authH = { "X-Auth-Token": s.token, "gtoken": s.gtoken };
                req("/power_service/v1/site/energy_analysis", { site_id: SITE_ID, device_sn: nextJob.target.sn, type: nextJob.period.apiType, start_time: nextJob.period.start, end_time: today, device_type: nextJob.target.devType }, authH).then(function(res) {
                    if (res.code === 0 && res.data) { cache[nextJob.target.key][nextJob.period.name] = res.data; context.set("energyCache", cache); processStats(cache); }
                }).catch(function() {});
            }

            function fetchSiteList(s) {
                req("/power_service/v1/site/get_site_list", {}, { "X-Auth-Token": s.token, "gtoken": s.gtoken }).then(function(siteRes) {
                    if (siteRes && siteRes.code === 0 && siteRes.data && siteRes.data.site_list) {
                        const anlagenListe = siteRes.data.site_list.map(function(x) {
                            return { Name: x.site_name, SITE_ID: x.site_id, Rolle: x.ms_type };
                        });
                        node.warn("Anker SOLIX – Gefundene Anlagen: " + JSON.stringify(anlagenListe));
                        node.send([null, null, { topic: "site_list", payload: anlagenListe }]);
                    } else {
                        node.warn("Keine Anlagen gefunden oder Fehler beim Abruf.");
                    }
                }).catch(function(e) { node.error(e.message); });
            }

            function runFetch(s) {
                if (isGetSites) {
                    fetchSiteList(s);
                    return;
                }
                sendPullToRefresh(s); fetchNextEnergyJob(s);
                req("/power_service/v1/site/get_scen_info", { site_id: SITE_ID }, { "X-Auth-Token": s.token, "gtoken": s.gtoken }).then(function(res) {
                    if (res.code === 0 && res.data) {
                        processLive(res.data);
                        node.status({ fill: "green", shape: "dot", text: "OK (" + new Date().toLocaleTimeString() + ")" });
                        node.send([null, { topic: "raw_data", payload: res.data }, { topic: "status", payload: "OK + PullToRefresh" }]);
                    } else {
                        global.set("ankerSession_" + EMAIL, null);
                        node.status({ fill: "yellow", shape: "ring", text: "Session erneuern..." });
                    }
                }).catch(function(e) {
                    if (String(e.message).indexOf("ECONNRESET") === -1) {
                        node.status({ fill: "red", shape: "ring", text: "API Fehler" });
                        node.error(e.message);
                    }
                });
            }
            const saved = global.get("ankerSession_" + EMAIL);
            if (saved && saved.token && saved.mqttInfo && (SITE_ID || saved.siteId || isGetSites)) {
                if (!SITE_ID && saved.siteId) {
                    SITE_ID = saved.siteId;
                    context.set("savedSiteId", SITE_ID);
                }
                runFetch(saved);
                return;
            }
            if (!EMAIL || !PASSWORD) {
                node.status({ fill: "red", shape: "dot", text: "Zugangsdaten fehlen" });
                node.warn("Bitte E-Mail und Passwort in der Node eintragen");
                return;
            }
            if (Date.now() - (context.get("lastLoginAttempt") || 0) < 3600000) {
                node.status({ fill: "yellow", shape: "dot", text: "Login-Schutz (1h)" });
                return;
            }
            context.set("lastLoginAttempt", Date.now());
            node.status({ fill: "blue", shape: "dot", text: "Login läuft..." });

            const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
            const sec = ecdh.computeSecret(Buffer.from(PUB_KEY, "hex"));
            const cip = crypto.createCipheriv("aes-256-cbc", sec.subarray(0, 32), sec.subarray(0, 16));
            const pwd = cip.update(PASSWORD, "utf8", "base64") + cip.final("base64");
            const s = { token: "", gtoken: "", userId: "", mqttInfo: null, siteId: SITE_ID };

            req("/passport/login", { ab: "DE", client_secret_info: { public_key: ecdh.getPublicKey("hex", "uncompressed") }, enc: 1, email: EMAIL, password: pwd, time_zone: -3600000, transaction: String(Date.now()) }).then(function(r) {
                if (r.code !== 0) { throw new Error("Login: " + JSON.stringify(r)); }
                s.token = r.data.auth_token; s.userId = r.data.user_id; s.gtoken = crypto.createHash("md5").update(s.userId).digest("hex");
                return req("/app/devicemanage/get_user_mqtt_info", {}, { "X-Auth-Token": s.token, "gtoken": s.gtoken });
            }).then(function(c) {
                s.mqttInfo = c.data;
                if (!SITE_ID || isGetSites) { return req("/power_service/v1/site/get_site_list", {}, { "X-Auth-Token": s.token, "gtoken": s.gtoken }); }
                return null;
            }).then(function(siteRes) {
                if (siteRes && siteRes.code === 0 && siteRes.data && siteRes.data.site_list && siteRes.data.site_list.length > 0) {
                    const anlagenListe = siteRes.data.site_list.map(function(x) {
                        return { Name: x.site_name, SITE_ID: x.site_id, Rolle: x.ms_type };
                    });
                    node.warn("Anker SOLIX – Gefundene Anlagen: " + JSON.stringify(anlagenListe));
                    if (isGetSites) {
                        node.send([null, null, { topic: "site_list", payload: anlagenListe }]);
                    }
                    if (!SITE_ID) {
                        SITE_ID = siteRes.data.site_list.site_id;
                        s.siteId = SITE_ID;
                        context.set("savedSiteId", SITE_ID);
                    }
                } else if (!SITE_ID) {
                    throw new Error("Keine SITE_ID gefunden.");
                }
                if (isGetSites) {
                    global.set("ankerSession_" + EMAIL, s);
                    node.status({ fill: "green", shape: "dot", text: "Anlagenliste abgerufen" });
                    return null;
                }
                if (!DEVICE_SN) { return req("/power_service/v1/site/get_site_detail", { site_id: SITE_ID }, { "X-Auth-Token": s.token, "gtoken": s.gtoken }); }
                return null;
            }).then(function(detailRes) {
                if (isGetSites) { return; }
                if (detailRes && detailRes.code === 0 && detailRes.data && detailRes.data.site_info) {
                    const si = detailRes.data.site_info;
                    const pd = si.powerdock_info || (si.powerpanel_info && si.powerpanel_info.powerdock_info);
                    if (pd && pd.device_sn) {
                        DEVICE_SN = pd.device_sn;
                        DEVICE_PN = pd.device_pn || DEVICE_PN || "AE100";
                        context.set("savedPowerdockSn", DEVICE_SN);
                        context.set("savedPowerdockPn", DEVICE_PN);
                    }
                }
                global.set("ankerSession_" + EMAIL, s);
                runFetch(s);
            }).catch(function(e) {
                node.status({ fill: "red", shape: "dot", text: "Login fehlgeschlagen" });
                node.error(e.message);
            });
        });
    }

    RED.nodes.registerType("anker-solix", AnkerSolixNode, {
        credentials: {
            password: { type: "password" }
        }
    });
};
