# Changelog

All notable changes to `node-red-contrib-anker-solix` are documented in this file.

## - 2026-11-21

### Added
- **3-Node Architecture & Central Account Config (`anker-solix-config`):**
  - Shared account configuration node supporting dropdown selection across multiple data and control nodes (share one account across multiple sites via `SITE_ID` or separate primary owner and secondary read-only accounts).
  - Global **server region selector** (`EU`, `US`, `AU`, `CN`) and configurable timezone.
  - Automatic multi-instance start offset (`0–1,500 ms` derived from node ID) when triggering multiple nodes from a single inject.
- **Device Control Node (`anker-solix-control`):**
  - Automatic master device routing for Power Dock (`AE100`), Solarbank 4 E5000 Pro (`AE103`), Solarbank 3 Pro (`A17C5`), Solarbank 2, and Solarbank 1 (`A17C0`).
  - `set_usage_mode`: Switch between `1` (Self-Consumption / Smart Meter), `2` (Custom Mode / Schedule — automatically creates a 24h fallback schedule `00:00–24:00` if none exists), `3` (Smart Plug / Time-of-Use), and `7` (Smart Mode / AI EMS).
  - `set_output_power`: Set AC output power in Watts (primarily for standalone solarbanks without Power Dock).
  - `from_msg` & `get_params` diagnostics, automatic instant wake-up trigger (`anker_wakeup_reset_<siteId>`) after write commands, and clear error detection when targeting shared member sites (`ms_type !== 1`).
- **New Data Points & Smart Meter Offline Alarm (126 Keys Total):**
  - Added AC grid-to-battery charging power keys (`SITE_AC_CHARGE`, `SB1_AC_CHARGE` .. `SB4_AC_CHARGE`) using `grid_to_battery_power` and `bat_charge_power` (essential for Solarbank 3 Pro `A17C5` and Solarbank 4 `AE103`).
  - Added `SITE_SMARTMETER_ONLINE` (`1` = online, `0` = offline / 200W fallback active) plus one-shot alarm messages (`alarm/smartmeter_offline` & `alarm/smartmeter_online`) on Output 3.
- **Expanded Hardware & Internationalization:**
  - Added explicit support for **Anker SOLIX Solarbank 4 E5000 Pro (`AE103`)** and **Anker SOLIX E10 (`A17E1`)**.
  - Standardized all internal UI labels, help texts, status messages, error messages, and data keys to English.

### Changed
- **Standardized English Data Keys + Full Legacy Compatibility:**
  - Replaced German keys (`PD_*`, `SBx_LADEN`, `STAT_GES_*`) with clean English keys (`SITE_*`, `SBx_CHARGE`, `STAT_DAY_*` .. `STAT_YEAR_*`).
  - Built-in automatic legacy alias bridge in `emitSysVar` ensures existing `v1.0.x` flows continue to work without any manual changes to SysVars mappings.
- **Improved Stability:**
  - Replaced static `isBusy` lock with a self-healing 20-second `busySince` timeout guard and fixed binary XOR buffer construction (`Buffer.of(xor)`) in MQTT wake-up.

### Migration Note (`v1.0.x` -> `v1.1.0`)
- After updating from `v1.0.x` to `v1.1.0`, open your existing `Anker SOLIX` node once, click the pencil icon next to **Account**, and enter your **Email**, **Password**, and **Region** in the new `anker-solix-config` node. All existing SysVars mappings (including legacy German keys), `SITE_ID`, serial numbers, and flow wires are preserved automatically.

---

## - 2026-11-18
- Fixed monthly and yearly `energy_analysis` statistics (`STAT_GES_MONAT_*` & `STAT_GES_JAHR_*`), mapped total solar/battery yields from solarbank statistics on Power Dock (`AE100`) setups, and added automatic fallback calculation for total home usage (`STAT_GES_*_HAUS`).
- Added primary `AE100` Power Dock auto-detection via `combiner_box_info.combiner_box_list`.
- Removed unsupported `SB1_TEMP`–`SB4_TEMP` keys for 120 clean, reliable data points and fixed documentation links.

## - 2026-11-17
- Extended `energy_analysis` statistics queries across `"solar_production"`, `"home_usage"`, and `"grid"` so Power Dock (`AE100`) and Smart Meter systems reliably report grid import, home usage, and grid export in `kWh`.
- Fixed weekly statistics start date calculation (Monday of the current week), added raw `energy_analysis` JSON output on Output 2, and added `msg.topic = "get_stats"` on-demand refresh.

## - 2026-11-15
- Improved 24/7 MQTT wake-up (`cmd: 17`, `qos: 1`, official `clientId`, REST app pings `get_site_homepage` & `get_site_detail`, 90-second stall re-trigger, and per-device wake-up lock).
- Added 300-second heartbeat in `emitSysVar` to prevent spline wave interpolation artifacts in CCU-Historian during constant phases.
- Made `get_sites` non-blocking during active polling.

## - - 2026-11-12
- Refined session token caching across multiple node instances sharing one account and stabilized MQTT reconnect handling.

## - 2026-11-10
- Added explicit hardware support for **Anker Smart Meter 2nd Gen (1-phase, `AE1X0`)** and AC-coupled home storage systems (**Solarbank Max `AE111`**, **Solarbank Max AC `A17E2` / `B17E2`**).
- Prioritized manually entered Wakeup Device SN/PN over automatic detection.
- Increased login protection cooldown to 5 minutes on wrong password errors (`26108`) to prevent account lockouts (`10019`).
- Added structured section headers (`_ANLEITUNG_1`, `_BEREICH_...`) to the default SysVars JSON template and example flow.
- Introduced multilingual documentation (`README.md`, `README.en.md`, `README.de.md`).

## - 2026-11-08
- Implemented binary MQTT `pull_to_refresh` (`cmd: 17`) with randomized jitter and automatic battery protection for standalone solarbanks.

## - 2026-11-05
- Added `set_wakeup` runtime command (`true` / `false` / `"auto"`) and `get_sites` multi-site discovery.

## - 2026-10-30
- Initial public release of `node-red-contrib-anker-solix` for OpenCCU / HomeMatic, MQTT, InfluxDB, and KNX/Loxone.
