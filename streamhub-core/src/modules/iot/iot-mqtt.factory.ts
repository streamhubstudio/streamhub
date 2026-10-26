/**
 * IoT MQTT-in client factory token. The subscribe side needs `subscribe` +
 * inbound `message` events, exactly like the fleet subscriber — so this module
 * REUSES the fleet client surface (FleetMqttClientLike) and the SAME production
 * factory (`defaultFleetMqttClientFactory`), which already TLS-resolves +
 * SSRF-checks the broker URL via the mqtt module's helpers (single source of
 * truth for the scheme allowlist + private-address rejection). No new security
 * policy is added here. Unit specs bind IOT_MQTT_FACTORY to an EventEmitter
 * fake, so nothing in a spec opens a socket (CLAUDE.md testing rule).
 */
export const IOT_MQTT_FACTORY = Symbol('IOT_MQTT_FACTORY');
