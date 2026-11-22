module.exports = function (RED) {
    const https = require("https");
    const crypto = require("crypto");

    const REGION_URLS = {
        eu: "ankerpower-api-eu." + "anker.com",
        us: "ankerpower-api." + "anker.com",
        au: "ankerpower-api-au." + "anker.com",
        cn: "ankerpower-api-cn." + "anker.com"
    };

    const DEFAULT_PUB_KEY_HEX = "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

    function encryptAnkerPassword(password, hexKey) {
        const ecdh = crypto.createECDH("prime256v1");
        ecdh.generateKeys();
        const sharedSecret = ecdh.computeSecret(Buffer.from(hexKey || DEFAULT_PUB_KEY_HEX, "hex"));
        const cipher = crypto.createCipheriv("aes-256-cbc", sharedSecret.subarray(0, 32), sharedSecret.subarray(0, 16));
        let encrypted = cipher.update(password, "utf8", "base64");
        encrypted += cipher.final("base64");
        return {
            encryptedPassword: encrypted,
            clientPublicKey: ecdh.getPublicKey("hex", "uncompressed")
        };
    }

    function getTimezoneOffsetStr() {
        const offsetMin = -new Date().getTimezoneOffset();
        const sign = offsetMin >= 0 ? "+" : "-";
        const absMin = Math.abs(offsetMin);
        const hh = String(Math.floor(absMin / 60)).padStart(2, "0");
        const mm = String(absMin % 60).padStart(2, "0");
        return "GMT" + sign + hh + ":" + mm;
    }

    function AnkerSolixConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.region = (config.region || "eu").toLowerCase().trim();
        node.timezone = (config.timezone || "Europe/Berlin").trim();
        node.email = (node.credentials && node.credentials.email) ? node.credentials.email.trim() : "";
        node.password = (node.credentials && node.credentials.password) ? node.credentials.password : "";

        const apiHost = REGION_URLS[node.region] || REGION_URLS.eu;
        const countryCode = (node.region === "eu") ? "DE" : node.region.toUpperCase();
        const globalCtx = node.context().global;
        const cacheKey = "anker_session_v111_" + node.region + "_" + node.email.replace(/[^a-zA-Z0-9]/g, "_");

        node.invalidateSession = function () {
            globalCtx.set(cacheKey, null);
        };

        node.on("close", function () {
            globalCtx.set(cacheKey, null);
        });
        function rawHttpsPost(path, bodyObj, headersExtra) {
            return new Promise((resolve, reject) => {
                const payload = JSON.stringify(bodyObj || {});
                const headers = Object.assign({
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                    "Country": countryCode,
                    "Timezone": getTimezoneOffsetStr(),
                    "App-Name": "anker_power",
                    "Os-Type": "android",
                    "Model-Type": "DESKTOP"
                }, headersExtra || {});

                const req = https.request({
                    hostname: apiHost,
                    port: 443,
                    path: path,
                    method: "POST",
                    headers: headers,
                    timeout: 15000
                }, (res) => {
                    let raw = "";
                    res.on("data", (chunk) => { raw += chunk; });
                    res.on("end", () => {
                        try {
                            resolve(JSON.parse(raw));
                        } catch (e) {
                            reject(new Error("Invalid JSON response (" + res.statusCode + ")"));
                        }
                    });
                });
                req.on("timeout", () => { req.destroy(); reject(new Error("Anker Cloud timeout (15s)")); });
                req.on("error", (err) => reject(err));
                req.write(payload);
                req.end();
            });
        }

        node.getAuthSession = async function (forceLogin) {
            if (!node.email || !node.password) {
                throw new Error("Email or password missing in Anker SOLIX Account config.");
            }
            const cached = globalCtx.get(cacheKey);
            if (!forceLogin && cached && cached.auth_token && cached.token_expires_at && (Date.now() < cached.token_expires_at - 300000)) {
                return cached;
            }

            const { encryptedPassword, clientPublicKey } = encryptAnkerPassword(node.password, DEFAULT_PUB_KEY_HEX);
            const loginRes = await rawHttpsPost("/passport/login", {
                ab: countryCode,
                client_secret_info: { public_key: clientPublicKey },
                enc: 1,
                email: node.email,
                password: encryptedPassword
            }, { "gtoken": "" });

            if (!loginRes || loginRes.code !== 0 || !loginRes.data || !loginRes.data.auth_token) {
                throw new Error("Login failed: " + (loginRes ? (loginRes.msg || ("Code " + loginRes.code)) : "No response"));
            }

            const d = loginRes.data;
            const gtoken = crypto.createHash("md5").update(String(d.user_id)).digest("hex");
            let mqttInfo = null;
            try {
                const mqttRes = await rawHttpsPost("/app/devicemanage/get_user_mqtt_info", {}, {
                    "X-Auth-Token": d.auth_token,
                    "gtoken": gtoken
                });
                if (mqttRes && mqttRes.code === 0 && mqttRes.data) {
                    mqttInfo = mqttRes.data;
                }
            } catch (e) {}

            const session = {
                email: node.email,
                region: node.region,
                user_id: d.user_id,
                auth_token: d.auth_token,
                gtoken: gtoken,
                token_expires_at: Math.min(
                    (Number(d.token_expires_at) || (Math.floor(Date.now() / 1000) + 72000)) * 1000,
                    Date.now() + (20 * 3600 * 1000)
                ),
                mqttInfo: mqttInfo
            };
            globalCtx.set(cacheKey, session);
            return session;
        };

        node.apiRequest = async function (path, bodyObj) {
            let session = await node.getAuthSession(false);
            let res = await rawHttpsPost(path, bodyObj, {
                "X-Auth-Token": session.auth_token,
                "gtoken": session.gtoken
            });
            if (res && (res.code === 401 || res.code === 26052 || res.code === 10003)) {
                session = await node.getAuthSession(true);
                res = await rawHttpsPost(path, bodyObj, {
                    "X-Auth-Token": session.auth_token,
                    "gtoken": session.gtoken
                });
            }
            return res;
        };
    }

    RED.nodes.registerType("anker-solix-config", AnkerSolixConfigNode, {
        credentials: {
            email: { type: "text" },
            password: { type: "password" }
        }
    });
};
