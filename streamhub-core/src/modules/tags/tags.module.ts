import { Module } from '@nestjs/common';

import { StreamTagsController } from './stream-tags.controller';
import { TagsController } from './tags.controller';
import { TagsRepository } from './tags.repository';

/**
 * TAGS module (Vision-Edge §E). Owns the per-app `tags` table + the
 * `streams.tags` column: CRUD at `/apps/:app/tags` and stream/room tagging at
 * `/apps/:app/streams/:id/tags` / `/apps/:app/tags/room/:room`.
 *
 * Only needs the @Global DbService, so it has no imports. Hosted by
 * StreamsModule (same "sibling module" pattern as StreamPluginsModule) so the
 * scaffolder-owned app.module.ts stays untouched. Exports TagsRepository so the
 * (wave-2) vision scheduler can resolve a stream's tag configs.
 */
@Module({
  controllers: [TagsController, StreamTagsController],
  providers: [TagsRepository],
  exports: [TagsRepository],
})
export class TagsModule {}
