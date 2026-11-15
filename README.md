\# node-red-contrib-anker-solix



Ein All-in-One Node-RED-Baustein zur direkten Einbindung deiner \*\*Anker SOLIX Anlage\*\* (Power Dock + bis zu 4 Solarbanks) in \*\*OpenCCU / Homematic (RedMatic)\*\* – inklusive automatischem MQTT-Wakeup und Cloud-schonender Statistik-Abfrage.



\---



\## Features



\* \*\*Live-Werte \& Einzel-Strings:\*\* Liest Hauslast, Netzbezug, Netzeinspeisung, Gesamtladezustand sowie die Einzelwerte (SOC, Solarleistung, PV1–PV4) von bis zu 4 Solarbanks aus.

\* \*\*Automatischer MQTT-Wakeup:\*\* Sendet alle 4 Minuten einen Pull-to-Refresh-Impuls an das Power Dock, damit die Cloud-Werte ohne offene Smartphone-App aktuell bleiben.

\* \*\*Statistik-Abfrage (kWh):\*\* Ruft Tages-, Wochen-, Monats- und Jahreswerte gestaffelt alle 20 Minuten (`:01`, `:21`, `:41`) ab, um die Anker-API zu schonen.

\* \*\*Zero-Config Auto-Erkennung:\*\* `Site ID`, `Power Dock SN` und `Solarbank 1–4 SN` werden beim ersten Start automatisch ermittelt und dauerhaft gespeichert, wenn die Felder leer bleiben.

\* \*\*Integrierter RBE-Filter:\*\* Sendet Werte nur dann an die OpenCCU weiter, wenn sich der Messwert tatsächlich geändert hat.

\* \*\*Multi-Anlagen-fähig:\*\* Die Login-Sitzung (Token) wird pro E-Mail-Adresse getrennt verwaltet.



\---



\## Installation



\### Über den Node-RED Palette-Manager (Empfohlen)

1\. Öffne in Node-RED das Menü oben rechts (`≡`) und wähle \*\*Palette verwalten\*\*.

2\. Wechsle auf den Reiter \*\*Installieren\*\* und suche nach `node-red-contrib-anker-solix`.

3\. Klicke auf \*\*Installieren\*\*.



\### Über die Kommandozeile (NPM)

```bash

npm install node-red-contrib-anker-solix

```



\---



\## Verkabelung im Flow



1\. \*\*Eingang:\*\* Mit einem \*\*Inject-Node\*\* verbinden (empfohlenes Abfrage-Intervall: alle \*\*5 Sekunden\*\*).

2\. \*\*Ausgang 1 (`OpenCCU SysVars`):\*\* Direkt mit \*\*einem einzigen blauen OpenCCU-SysVar-Node\*\* verbinden. Im OpenCCU-Node muss das Feld \*\*Variable / Name leer\*\* bleiben, da der Zielname automatisch über `msg.topic` übergeben wird.

3\. \*\*Ausgang 2 (`Status`):\*\* Optionaler Ausgang für Status- und Debug-Meldungen.



\---



\## Konfiguration



Doppelklicke auf den Baustein \*\*Anker SOLIX OpenCCU\*\*, um die Einstellungen zu öffnen:



\* \*\*Anker E-Mail \& Passwort:\*\* Zugangsdaten deines Anker-Hauptkontos (wird für volle Berechtigungen wie den MQTT-Wakeup und alle Statistikdaten benötigt; geteilte Gast-Accounts haben hier oft Einschränkungen). Das Passwort wird von Node-RED verschlüsselt gespeichert.

\* \*\*Site ID / Power Dock SN / Solarbank 1–4 SN:\*\* Können bei einer einzelnen Anlage leer bleiben und werden beim ersten Start automatisch aus der Cloud ausgelesen. (Liegen mehrere Anlagen im selben Konto, hier die gewünschte `Site ID` eintragen.)

\* \*\*SysVars JSON:\*\* Trage hinter dem jeweiligen Schlüssel den exakten Namen deiner OpenCCU-Systemvariable ein (z. B. `"PD\_HAUSLAST": "Anker\_Hauslast"`). Alle Felder, die leer (`""`) bleiben, werden automatisch übersprungen.



\---



\## Verfügbare Datenpunkte



\### Power Dock / Gesamtanlage Live (`W` bzw. `%`)



| Schlüssel | Beschreibung | Einheit |

| :--- | :--- | :--- |

| `PD\_HAUSLAST` | Aktuelle Hauslast gesamt | W |

| `PD\_NETZ\_BEZUG` | Aktueller Netzbezug vom Versorger | W |

| `PD\_NETZ\_EINSP` | Aktuelle Netzeinspeisung | W |

| `PD\_SOC` | Gesamter Akkustand aller Speicher | % |

| `PD\_LADEN` | Aktuelle Gesamtladeleistung aller Akkus | W |

| `PD\_SOLAR` | Aktuelle Gesamtsolarleistung aller Speicher | W |

| `PD\_ENTLADEN` | Aktuelle Gesamtentladeleistung aller Akkus | W |



\### Einzelne Solarbanks Live (`SB1\_` bis `SB4\_`, `W` bzw. `%`)



| Schlüssel | Beschreibung | Einheit |

| :--- | :--- | :--- |

| `SBx\_SOC` | Akkustand der jeweiligen Solarbank (`SB1`–`SB4`) | % |

| `SBx\_SOLAR` | Gesamte Solarleistung dieser Solarbank | W |

| `SBx\_LADEN` | Aktuelle Ladeleistung | W |

| `SBx\_OUTPUT` | Aktuelle Ausgangsleistung ins Haus / Power Dock | W |

| `SBx\_PV1` bis `SBx\_PV4` | Leistung der einzelnen Solar-Eingänge 1 bis 4 | W |



\### Statistik Gesamt \& Einzel-Solarbanks (`kWh`)

Zeiträume (`<ZEITRAUM>`): `TAG`, `WOCHE`, `MONAT`, `JAHR`

\* `STAT\_GES\_<ZEITRAUM>\_SOLAR`: Solarertrag gesamt (kWh)

\* `STAT\_GES\_<ZEITRAUM>\_LADEN`: Batterie-Ladung gesamt (kWh)

\* `STAT\_GES\_<ZEITRAUM>\_ENTLADEN`: Batterie-Entladung gesamt (kWh)

\* `STAT\_GES\_<ZEITRAUM>\_SOLAR\_HAUS`: Solar direkt ins Haus (kWh)

\* `STAT\_GES\_<ZEITRAUM>\_EINSP`: Netzeinspeisung gesamt (kWh)

\* `STAT\_GES\_<ZEITRAUM>\_NETZ`: Netzbezug vom Versorger (kWh)

\* `STAT\_GES\_<ZEITRAUM>\_HAUS`: Gesamter Hausverbrauch (kWh)

\* `STAT\_GES\_<ZEITRAUM>\_BAT\_HAUS`: Batterie direkt ins Haus (kWh)

\* `STAT\_SBx\_<ZEITRAUM>\_SOLAR`: Solarertrag der jeweiligen Solarbank `SB1`–`SB4` (kWh)

\* `STAT\_SBx\_<ZEITRAUM>\_LADEN`: Batterie-Ladung der jeweiligen Solarbank `SB1`–`SB4` (kWh)

\* `STAT\_SBx\_<ZEITRAUM>\_ENTLADEN`: Batterie-Entladung der jeweiligen Solarbank `SB1`–`SB4` (kWh)



\---



\## Hinweise für OpenCCU \& CCU-Historian



\* \*\*Variablentyp in OpenCCU:\*\* Alle Systemvariablen als \*\*Zahl (Gleitkommazahl)\*\* anlegen und das Maximum hoch genug wählen (z. B. `999999` für Jahreswerte).

\* \*\*CCU-Historian:\*\* Statistik-Systemvariablen in der Historian-Datenpunkt-Konfiguration auf \*\*Deaktiviert\*\* setzen, um die Datenbank schlank zu halten. Für Live-Werte im 5-Sekunden-Takt empfiehlt sich in der `ccu-historian.config` der Eintrag `devices.device1.sysvarCycle=5000`.



\---



\## Lizenz



MIT



