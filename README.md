# node-red-contrib-anker-solix

Ein All-in-One Node-RED-Baustein zur direkten Einbindung deiner **Anker SOLIX Anlage** in **OpenCCU / Homematic (RedMatic)** – inklusive automatischem MQTT-Wakeup und Cloud-schonender Statistik-Abfrage.

---

## Screenshots & Aufbau

### Flow-Verkabelung
![Flow Aufbau](https://githubusercontent.com)

### Konfiguration im Baustein
![Konfiguration](https://githubusercontent.com)

---

## Unterstützte Hardware & Anlagen-Konfigurationen

* **Mit Anker SOLIX Power Dock (AE100):** Unterstützt **bis zu 4 Solarbanks** (Solarbank 2 Pro/Plus, Solarbank 3 Pro und Solarbank 4 Pro – auch gemischt) in einer gemeinsamen Anlage (`SITE_ID`).
* **Ohne Power Dock – Solarbank 2 & Solarbank 3:** Unterstützt **1 Solarbank** pro Anlage (`SITE_ID`). Mehrere Geräte ohne Power Dock können über getrennte Bausteine mit ihrer jeweiligen `SITE_ID` eingebunden werden.
* **Ohne Power Dock – Solarbank 4 (E5000 Pro):** Unterstützt im **DIY-Parallelmodus bis zu 3 Solarbanks** ohne Power Dock in einer gemeinsamen Anlage.
