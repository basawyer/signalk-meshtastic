# Changelog

## [Unreleased] - Sharlie fork
### Added
- `channel` setting: the Meshtastic channel index (0-7, default `1`, `0` = public primary) used for both broadcasting alerts and accepting commands
- `Boat info` text command: reply with live vessel data (battery, depth, wind, water temp, SOG) when received on the configured channel
- `boat_info_battery` setting to pick which `electrical.batteries.<id>` instance the `Boat info` reply reports
- `Ask <question>` text command: forward the question to Claude and reply with a succinct plain-text answer, paginated across multiple messages (each <= 200 bytes, with `(i/n)` markers) when the answer is longer, up to a 5-message cap. Claude returns structured JSON; when the answer references a specific location, an `askWaypoint` waypoint is stored in Signal K (via the Resources API) and the reply is prefixed with `waypoint added`
- `anthropic_api_key` and `ask_model` settings to configure the Claude API used by the `Ask` command

### Changed
- Alerts are now always broadcast on the configured channel
- Commands are accepted from direct messages to the boat node or from the configured channel, except `Boat info` and `Ask`, which are only accepted on the configured channel (so direct messages can't spend Claude API tokens)
- Alerts are prefixed with red siren emoji (🚨🚨) and back-to-normal messages with green light emoji (🟢🟢)

### Removed
- Crew nodes concept: alerts and commands no longer target individually configured crew nodes (removed the `crew` node role, `alert_channel`, and the per-command `crewOnly`/`allowChannel` flags)
- `send_environment_metrics` setting and outgoing environment telemetry to Meshtastic (wind, temperature, battery, etc.)
- `send_alerts` setting: Signal K alerts are now always sent to Meshtastic
- `nodes` ("Related Meshtastic nodes") config and onboard/dinghy role assignments
- `send_position` setting: vessel position is now always pushed to the Meshtastic node
- `digital_switching` setting and the "Turn &lt;switch&gt; on/off" Meshtastic command
- `populate_vessels` setting and synthetic MMSI vessel creation for Meshtastic nodes

## [1.4.0] - 2026-06-19
### Added
- Notifications that clear and reissue rapidly are only sent once

### Changed
- Refactored notification and waypoint sending to their own helper functions

## [1.3.0] - 2026-06-16
### Removed
- Removed support for serial connections as they require post-install scripts

## [1.2.4] - 2026-02-15
### Fixed
- Corrupted Node DB file should no longer crash the plugin

## [1.2.3] - 2025-10-15
### Changed
- Nodes that haven't been seen in last two days are no longer registered to Signal K data structure

### Fixed
- Added safeties for various non-numeric telemetry and coordinate values

## [1.2.2] - 2025-10-01
### Changed
- Set "last seen" timestamp of nodes based on packet payloads, not the time they're received
- Send timestamp with telemetry

### Fixed
- Fixed issue with persising node-to-vessel matches from `DE <callsign>`

## [1.2.1] - 2025-09-28
### Fixed
- Fixed issue with Signal K servers that don't have navigation.position set

## [1.2.0] - 2025-09-28
### Added
- Support for Node.js older than 22.x, for example as seen in Venus OS Large

### Changed
- Safety for nodes in DB that don't have a "last seen" timestamp
- Made connection status notifications clearer

## [1.1.2] - 2025-09-25
### Added
- Added support for the new roles from Meshtastic 2.7 (`ROUTER_LATE` and `CLIENT_BASE`)

### Fixed
- Fixed issue with sending a bell with alerts that have sound enabled

## [1.1.1] - 2025-09-18
### Added
- Added support for the proposed Signal K MOB position specification

### Fixed
- Fixed empty response text message to digital switching actions

## [1.1.0] - 2025-09-11
### Added
- Added support for Serial transport with the Meshtastic device

## [1.0.0] - 2025-09-11
### Changed
- Initial release with HTTP and TCP transports
