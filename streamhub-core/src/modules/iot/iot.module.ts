import { Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { defaultFleetMqttClientFactory } from '../fleet/fleet-mqtt.factory';
import { IotMqttInService } from './iot-mqtt-in.service';
import { IOT_MQTT_FACTORY } from './iot-mqtt.factory';

/**
 * IoT module — the generic per-app MQTT data-IN subscriber (the inbound half of
 * the IoT data plane; internal design notes section 3). Subscribes to each
 * app's `mqtt.subscribe` topic filters and turns every inbound broker message
 * into a single `dispatch(app,'iot.data',…)` event, which powers MQTT-out + the
 * signed webhook + Streamflow's `trigger.mqtt` box through the one funnel.
 *
 * Imports:
 *  - AppsModule -> APPS_SERVICE (app list + resolved mqtt broker config).
 * Db/Logs/Config + CallbacksService (@Global) are injected by token. The MQTT
 * client sits behind IOT_MQTT_FACTORY (the shared SSRF-guarded fleet factory in
 * production; an EventEmitter fake in unit specs). Registered in app.module.ts
 * by the lead.
 */
@Module({
  imports: [AppsModule],
  providers: [
    IotMqttInService,
    { provide: IOT_MQTT_FACTORY, useValue: defaultFleetMqttClientFactory },
  ],
  exports: [IotMqttInService],
})
export class IotModule {}
