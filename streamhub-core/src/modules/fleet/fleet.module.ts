import { Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { PluginsModule } from '../plugins/plugins.module';
import {
  FLEET_MQTT_FACTORY,
  defaultFleetMqttClientFactory,
} from './fleet-mqtt.factory';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { FleetStore } from './fleet.store';

/**
 * Fleet module — IoT/agent fleet management over MQTT for the `fleet` plugin.
 *
 * Hosts the always-on MQTT subscriber (FleetService) + per-app fleet.db
 * (FleetStore) + the command publisher, exposed at /apps/:app/plugins/fleet.
 * Imports:
 *  - AppsModule    → APPS_SERVICE (app list + appDir + resolved mqtt config).
 *  - PluginsModule → AppPluginsRepository (read the fleet plugin install state
 *    so the subscriber only activates for apps that enabled it).
 * Db/Logs/Config are @Global. The MQTT client is behind FLEET_MQTT_FACTORY
 * (the real `mqtt` package here; an EventEmitter fake in unit specs).
 */
@Module({
  imports: [AppsModule, PluginsModule],
  controllers: [FleetController],
  providers: [
    FleetStore,
    FleetService,
    { provide: FLEET_MQTT_FACTORY, useValue: defaultFleetMqttClientFactory },
  ],
  exports: [FleetService],
})
export class FleetModule {}
