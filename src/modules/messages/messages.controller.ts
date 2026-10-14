import { Controller, Get, Param, Query } from '@nestjs/common';
import { Audited, RequirePermissions } from '../../common/auth/decorators';
import { ListMessagesDto } from './dto/messages.dto';
import { MessagesService } from './messages.service';

/**
 * The messages customers send through the API. Reading one is recorded in the audit log:
 * message bodies are customer content, and who looked at them should be answerable.
 */
@Controller('messages')
@RequirePermissions('messages.read')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  list(@Query() query: ListMessagesDto) {
    return this.messages.list(query);
  }

  @Get(':id')
  @Audited({
    action: 'messages.view',
    targetType: 'message',
    targetParam: 'id',
  })
  get(@Param('id') id: string) {
    return this.messages.get(id);
  }
}
