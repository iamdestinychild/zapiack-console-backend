import { CampaignStatuses, ChannelType } from '../../generated/zapiack/client';

/**
 * prisma/zapiack/schema.prisma is this app's copy of the product database's schema. When the product adds a value to an enum
 * and this copy is not updated, reading any row that carries it fails: the Products page returned a 500 ("Value 'WHATSAPP' not
 * found in enum 'ChannelType'") once a WhatsApp product existed. Keep these in step with the product's schema.prisma.
 */
describe('the product database enums this app reads', () => {
  it('knows every channel a product can be billed on', () => {
    expect(Object.values(ChannelType).sort()).toEqual([
      'EMAIL',
      'SMS',
      'WHATSAPP',
    ]);
  });

  it('knows every state a campaign can be in', () => {
    expect(Object.values(CampaignStatuses).sort()).toEqual([
      'CANCELLED',
      'COMPLETED',
      'DRAFT',
      'FAILED',
      'PAUSED',
      'PROCESSING',
      'SCHEDULED',
    ]);
  });
});
