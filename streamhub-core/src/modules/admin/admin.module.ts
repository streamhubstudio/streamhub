import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';

/** Admin / process control (wave-4 §1). POST /admin/restart via systemd. */
@Module({
  controllers: [AdminController],
})
export class AdminModule {}
