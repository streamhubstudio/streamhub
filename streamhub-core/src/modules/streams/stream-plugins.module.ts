import { Module } from '@nestjs/common';
import { StreamPluginOverridesService } from './stream-plugins.service';

/**
 * Tiny standalone module for the per-stream plugin opt-out resolver.
 *
 * Kept separate (rather than living inside StreamsModule) so BOTH StreamsModule
 * and PluginsModule can import it without forming a circular module dependency:
 * PipelineModule already imports PluginsModule and StreamsModule imports
 * PipelineModule, so PluginsModule → StreamsModule would cycle. This module
 * depends on nothing but the @Global DbService, so it is a safe leaf both sides
 * can share.
 */
@Module({
  providers: [StreamPluginOverridesService],
  exports: [StreamPluginOverridesService],
})
export class StreamPluginsModule {}
