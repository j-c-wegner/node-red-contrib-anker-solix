# node-red-contrib-anker-solix

Ein All-in-One Node-RED-Baustein zur direkten Einbindung deiner **Anker SOLIX Anlage** (mit oder ohne Power Dock + bis zu 4 Solarbanks) in **OpenCCU / Homematic (RedMatic)** – inklusive automatischem MQTT-Wakeup und Cloud-schonender Statistik-Abfrage.

---

## Screenshots & Aufbau

*(Tipp: Lade deine Screenshots unter `images/flow.png` und `images/config.png` in dieses Repository hoch, damit sie hier direkt angezeigt werden.)*

![Flow Aufbau](https://githubusercontent.com)

---

## Features

* **Live-Werte & Einzel-Strings:** Liest Hauslast, Netzbezug, Netzeinspeisung, Gesamtladezustand sowie die Einzelwerte (SOC, Solarleistung, PV1–PV4) von bis zu 4 Solarbanks aus.
* **Automatischer MQTT-Wakeup:** Sendet alle 4 Minuten einen Pull-to-Refresh-Impuls an das Power Dock (oder automatisch an die erste Solarbank, falls kein Power Dock vorhanden ist), damit die Cloud-Werte ohne offene App aktuell bleiben.
* **Statistik-Abfrage (kWh):** Ruft Tages-, Wochen-, Monats- und Jahreswerte gestaffelt alle 20 Minuten (`:01`, `:21`, `:41`) ab, um die Anker-API zu schonen.
* **Zero-Config Auto-Erkennung & `get_sites`-Befehl:** `Site ID`, `Wakeup Gerät SN` und `Solarbank 1–4 SN` werden beim ersten Start automatisch ermittelt. Mit `msg.topic = "get_sites"` am Eingang lassen sich jederzeit alle Anlagen im Konto abrufen.
* **3 getrennte Ausgänge:** Ausgang 1 für gefilterte OpenCCU-Systemvariablen (`rbe`), Ausgang 2 für die kompletten Cloud-Rohdaten (`get_scen_info`), Ausgang 3 für Status- und Debug-Meldungen.
* **Integrierter Beispiel-Flow:** Nach der Installation direkt in Node-RED unter **Menü > Import > Beispiele > `node-red-contrib-anker-solix`** verfügbar.

---

## Installation

### Über den Node-RED Palette-Manager (Empfohlen)
1. Öffne in Node-RED das Menü oben rechts (`≡`) und wähle **Palette verwalten**.
2. Wechsle auf den Reiter **Installieren** und suche nach `node-red-contrib-anker-solix`.
3. Klicke auf **Installieren**.

### Über die Kommandozeile (NPM)
```bash
npm install node-red-contrib-anker-solix
```

---

## Verkabelung & Ausgänge

1. **Eingang:** Mit einem **Inject-Node** verbinden (empfohlenes Intervall: alle **5 Sekunden**).
   * *Spezialbefehl:* Wird eine Nachricht mit `msg.topic = "get_sites"` (oder `msg.payload = "get_sites"`) gesendet, gibt der Baustein sofort alle im Konto verfügbaren Anlagen inkl. Name und `SITE_ID` auf Ausgang 3 und im Debug-Fenster aus.
2. **Ausgang 1 (`OpenCCU SysVars`):** Direkt mit **einem einzigen blauen OpenCCU-SysVar-Node** verbinden. Im OpenCCU-Node muss das Feld **Variable / Name leer** bleiben, da der Zielname automatisch über `msg.topic` übergeben wird.
3. **Ausgang 2 (`Cloud Rohdaten`):** Gibt das komplette JSON-Objekt (`get_scen_info`) der Anker-Cloud zur freien Weiterverarbeitung aus.
4. **Ausgang 3 (`Debug / Status`):** Gibt Statusmeldungen sowie bei `get_sites` die Liste aller gefundenen Anlagen aus.

---

## Konfiguration

* **Anker E-Mail & Passwort:** Zugangsdaten deines Anker-Hauptkontos (wird für volle Berechtigungen wie den MQTT-Wakeup und alle Statistikdaten benötigt). Das Passwort wird verschlüsselt gespeichert.
* **Site ID / Wakeup Gerät SN & PN / Solarbank 1–4 SN:** Können bei einer einzelnen Anlage leer bleiben und werden automatisch ausgelesen. (Liegen mehrere Anlagen im selben Konto, hier die gewünschte `Site ID` eintragen.)
* **SysVars JSON:** Trage hinter dem jeweiligen Schlüssel den exakten Namen deiner OpenCCU-Systemvariable ein (z. B. `"PD_HAUSLAST": "Anker_Hauslast"`). Leere Felder (`""`) werden übersprungen.

---

## Verfügbare Datenpunkte

### Power Dock / Gesamtanlage Live (`W` bzw. `%`)
* `PD_HAUSLAST`: Aktuelle Hauslast gesamt (W)
* `PD_NETZ_BEZUG`: Aktueller Netzbezug vom Versorger (W)
* `PD_NETZ_EINSP`: Aktuelle Netzeinspeisung (W)
* `PD_SOC`: Gesamter Akkustand aller Speicher (%)
* `PD_LADEN`: Aktuelle Gesamtladeleistung aller Akkus (W)
* `PD_SOLAR`: Aktuelle Gesamtsolarleistung aller Speicher (W)
* `PD_ENTLADEN`: Aktuelle Gesamtentladeleistung aller Akkus (W)

### Einzelne Solarbanks Live (`SB1_` bis `SB4_`, `W` bzw. `%`)
* `SBx_SOC`: Akkustand der jeweiligen Solarbank (`SB1`–`SB4`) (%)
* `SBx_SOLAR`: Gesamte Solarleistung dieser Solarbank (W)
* `SBx_LADEN`: Aktuelle Ladeleistung (W)
* `SBx_OUTPUT`: Aktuelle Ausgangsleistung ins Haus / Power Dock (W)
* `SBx_PV1` bis `SBx_PV4`: Leistung der einzelnen Solar-Eingänge 1 bis 4 (W)

### Statistik Gesamt & Einzel-Solarbanks (`kWh`)
Zeiträume (`<ZEITRAUM>`): `TAG`, `WOCHE`, `MONAT`, `JAHR`
* `STAT_GES_<ZEITRAUM>_SOLAR` / `_LADEN` / `_ENTLADEN` / `_SOLAR_HAUS` / `_EINSP` / `_NETZ` / `_HAUS` / `_BAT_HAUS`
* `STAT_SBx_<ZEITRAUM>_SOLAR` / `_LADEN` / `_ENTLADEN` (für `SB1` bis `SB4`)

---

## Hinweise für OpenCCU & CCU-Historian

* **Variablentyp in OpenCCU:** Alle Systemvariablen als **Zahl (Gleitkommazahl)** anlegen und das Maximum hoch genug wählen (z. B. `999999` für Jahreswerte).
* **CCU-Historian:** Statistik-Systemvariablen in der Historian-Datenpunkt-Konfiguration auf **Deaktiviert** setzen. Für Live-Werte empfiehlt sich in der `ccu-historian.config` der Eintrag `devices.device1.sysvarCycle=5000`.

---

## Versionshistorie (Changelog)

* **v1.0.7**
  * **3 Ausgänge:** Ausgang 1 für gefilterte OpenCCU-Systemvariablen (`rbe`), Ausgang 2 für die kompletten Cloud-Rohdaten (`get_scen_info`), Ausgang 3 für Status- und Debug-Meldungen.
  * **Gezielter `SITE_ID`-Abruf (`get_sites`):** Sendet bei `msg.topic = "get_sites"` sofort alle im Konto verfügbaren Anlagen (`Name` & `SITE_ID`) an Ausgang 3 und das Debug-Fenster.
  * **Solarbank-Fallback für MQTT-Wakeup:** Unterstützt jetzt auch Einzelanlagen ohne Power Dock vollautomatisch mit dem 4-Minuten-Echtzeit-Trigger.
  * **Beispielflow:** Fertiger Flow unter *Menü > Import > Beispiele* hinzugefügt.
* **v1.0.0**
  * Erstveröffentlichung mit ECDH-Login, 4-Minuten-MQTT-Wakeup, gestaffelter Statistik-Abfrage und OpenCCU-SysVar-Zuordnung.

---

## Lizenz

MIT
