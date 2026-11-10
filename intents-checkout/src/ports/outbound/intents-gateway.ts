import type { OriginAsset } from '../../domain/asset/origin-asset.js';

export type IntentsGateway = {
  listTokens(): Promise<OriginAsset[]>;
};
