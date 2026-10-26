import { Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PluginsModule } from '../plugins/plugins.module';
import { S3Module } from '../s3/s3.module';
import { StreamsModule } from '../streams/streams.module';
import { AiClient, AI_USAGE_TRACKER } from './ai.client';
import { StreamflowController } from './streamflow.controller';
import { StreamflowRunner } from './streamflow.runner';
import { StreamflowSecretsService } from './streamflow-secrets.service';
import { StreamflowService } from './streamflow.service';
import { StreamflowStore } from './streamflow.store';

/**
 * Streamflow module — the in-core, worker-less engine behind the `streamflow`
 * plugin (an n8n-style event-workflow builder). Hosts the trigger tap +
 * scheduler (StreamflowService), the DAG run executor + BullMQ queue
 * (StreamflowRunner), the OpenAI/DeepSeek client (AiClient) and the per-app
 * streamflow.db (StreamflowStore), exposed at /apps/:app/plugins/streamflow.
 *
 * Imports:
 *  - AppsModule          → APPS_SERVICE (app list + appDir + resolved config/S3).
 *  - PluginsModule       → AppPluginsRepository (install/enabled state + config).
 *  - S3Module            → S3Service (action.s3) + SecretsStore (AI key ref).
 *  - StreamsModule       → STREAMS_SERVICE (action.snapshot).
 *  - NotificationsModule → NOTIFIER_SERVICE (action.notify).
 * CallbacksService (trigger tap + action.emit) is @Global; Config/Db/Logs too.
 *
 * The AI budget usage tracker (AI_USAGE_TRACKER) is bound to StreamflowStore.
 * Exports nothing — the lead registers this module in app.module.ts.
 */
@Module({
  imports: [AppsModule, PluginsModule, S3Module, StreamsModule, NotificationsModule],
  controllers: [StreamflowController],
  providers: [
    StreamflowStore,
    StreamflowRunner,
    StreamflowService,
    StreamflowSecretsService,
    AiClient,
    { provide: AI_USAGE_TRACKER, useExisting: StreamflowStore },
  ],
})
export class StreamflowModule {}
