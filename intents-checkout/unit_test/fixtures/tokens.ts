/** Captured from GET /v0/tokens on 2026-11-09. Price stays here because that is the vendor shape. */
export const USDT_TRON_ASSET_ID = 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near';
export const USDC_BASE_ASSET_ID = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';

export const tokenFixture = [
  {
    assetId: USDT_TRON_ASSET_ID,
    decimals: 6,
    blockchain: 'tron',
    symbol: 'USDT',
    price: 0.999157,
    priceUpdatedAt: '2026-11-09T18:52:00.985Z',
    contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  },
  {
    assetId: USDC_BASE_ASSET_ID,
    decimals: 6,
    blockchain: 'base',
    symbol: 'USDC',
    price: 0.999489,
    priceUpdatedAt: '2026-11-09T18:52:00.985Z',
    contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  },
  {
    assetId: 'nep141:wrap.near',
    decimals: 24,
    blockchain: 'near',
    symbol: 'wNEAR',
    price: 3.61,
    priceUpdatedAt: '2026-11-09T18:52:00.985Z',
    contractAddress: 'wrap.near',
  },
  { assetId: 'missing-the-rest' },
];
