import { Global, Module } from '@nestjs/common';

import { ConfigService } from '../../shared/config/config.service';
import { MQTT_SERVICE } from '../../shared/contracts';
import { AppsModule } from '../apps/apps.module';
import {
  MQTT_CLIENT_FACTORY,
  defaultMqttClientFactory,
} from './mqtt-client.factory';
import { MqttService } from './mqtt.service';
import {
  LATENCY_PROBE,
  LatencyMonitorService,
  makeLivekitLatencyProbe,
} from './latency-monitor.service';

/**
 * MQTT module — per-app event publishing over MQTT + the stream latency
 * monitor. Global so the callbacks/logs taps can @Optional()-inject
 * MQTT_SERVICE without importing this module. Outbound only: no controller
 * (the per-app config endpoints live in the apps module, mirroring S3).
 *
 * Seams:
 *  - MQTT_CLIENT_FACTORY → real `mqtt.connect` here; a fake in unit tests.
 *  - LATENCY_PROBE → LiveKit listParticipants RTT here; a fake in unit tests.
 */
@Global()
@Module({
  imports: [AppsModule],
  providers: [
    { provide: MQTT_CLIENT_FACTORY, useValue: defaultMqttClientFactory },
    MqttService,
    { provide: MQTT_SERVICE, useExisting: MqttService },
    {
      provide: LATENCY_PROBE,
      useFactory: (config: ConfigService) => makeLivekitLatencyProbe(config),
      inject: [ConfigService],
    },
    LatencyMonitorService,
  ],
  exports: [MqttService, MQTT_SERVICE],
})
export class MqttModule {}
