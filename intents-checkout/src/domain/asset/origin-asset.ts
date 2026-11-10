/** A 1Click token the merchant may use as an origin asset. Price is intentionally absent. */
export type OriginAsset = {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
};
