import {
  actions,
  baseDecode,
  createTransaction,
  JsonRpcProvider,
  KeyPairSigner,
  type KeyPairString,
} from 'near-api-js';
import { decodeTxStatus } from './decode-tx-status.js';
import type { PolicyCallResult, PolicyLedger, RegisterPaymentInput } from '../../ports/outbound/policy-ledger.js';

const GAS = 30_000_000_000_000n;

export type RpcPolicyLedgerConfig = {
  rpcUrl: string;
  contractId: string;
  operatorAccountId: string;
  operatorPrivateKey: string;
};

/** Signs `register_payment` and `mark_fulfilled` and broadcasts them with near-api-js. */
export function createRpcPolicyLedger(config: RpcPolicyLedgerConfig): PolicyLedger {
  let signer: KeyPairSigner;
  try {
    signer = KeyPairSigner.fromSecretKey(asSecretKey(config.operatorPrivateKey));
  } catch {
    return unavailableLedger();
  }
  const provider = new JsonRpcProvider({ url: config.rpcUrl }, { retries: 1, wait: 0, backoff: 1 });

  async function call(methodName: string, args: Record<string, string>): Promise<PolicyCallResult> {
    try {
      const publicKey = await signer.getPublicKey();
      const accessKey = await provider.viewAccessKey({
        accountId: config.operatorAccountId,
        publicKey,
      });
      const transaction = createTransaction(
        config.operatorAccountId,
        publicKey,
        config.contractId,
        accessKey.nonce + 1n,
        [actions.functionCall(methodName, args, GAS, 0n)],
        blockHashBytes(accessKey.block_hash),
      );
      const signed = await signer.signTransaction(transaction);
      return decodeTxStatus(await provider.sendTransaction(signed.signedTransaction));
    } catch (error) {
      const decoded = decodeTxStatus(error);
      return decoded.status === 'unavailable' ? { status: 'unavailable' } : decoded;
    }
  }

  return {
    registerPayment(input: RegisterPaymentInput) {
      return call('register_payment', {
        order_ref: input.orderRef,
        amount_received: input.amountReceived,
        refund_destination: input.refundDestination,
        origin_asset: input.originAsset,
      });
    },
    markFulfilled(input) {
      return call('mark_fulfilled', { order_ref: input.orderRef });
    },
  };
}

function asSecretKey(value: string): KeyPairString {
  if (!value.startsWith('ed25519:')) throw new Error('operator key must be an ed25519 secret');
  return value as KeyPairString;
}

function blockHashBytes(hash: unknown): Uint8Array {
  if (hash instanceof Uint8Array) return hash;
  if (typeof hash === 'string') return baseDecode(hash);
  throw new Error('access key is missing a block hash');
}

function unavailableLedger(): PolicyLedger {
  return {
    async registerPayment() {
      return { status: 'unavailable' };
    },
    async markFulfilled() {
      return { status: 'unavailable' };
    },
  };
}
