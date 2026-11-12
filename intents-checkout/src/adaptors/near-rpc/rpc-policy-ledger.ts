import {
  actions,
  baseDecode,
  createTransaction,
  JsonRpcProvider,
  KeyPairSigner,
  type KeyPairString,
} from 'near-api-js';
import { decodeTxStatus } from './decode-tx-status.js';
import type {
  PolicyCallResult,
  PolicyLedger,
  PolicyOrder,
  PolicyRequestView,
  PolicyView,
  RegisterPaymentInput,
  StorageRegistration,
} from '../../ports/outbound/policy-ledger.js';

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

  async function call(
    methodName: string,
    args: Record<string, string | boolean>,
    receiverId = config.contractId,
  ): Promise<PolicyCallResult> {
    try {
      const publicKey = await signer.getPublicKey();
      const accessKey = await provider.viewAccessKey({
        accountId: config.operatorAccountId,
        publicKey,
      });
      const transaction = createTransaction(
        config.operatorAccountId,
        publicKey,
        receiverId,
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
    getOrder(orderRef) {
      return readOrder(orderRef);
    },
    getRequest(requestId) {
      return readRequest(requestId);
    },
    requestRefund(input) {
      return call('request_refund', { order_ref: input.orderRef, amount: input.amount });
    },
    executeRefund(input) {
      return call('execute_refund', { request_id: input.requestId, deposit_address: input.depositAddress });
    },
    storageBalance(tokenAccountId, accountId) {
      return readStorage(tokenAccountId, accountId);
    },
    storageDeposit(tokenAccountId, accountId) {
      return call('storage_deposit', { account_id: accountId, registration_only: true }, tokenAccountId);
    },
  };

  async function readOrder(orderRef: string): Promise<PolicyView<PolicyOrder | null>> {
    const viewed = await view(config.contractId, 'get_order', { order_ref: orderRef });
    if (!viewed.ok) return { status: 'unavailable' };
    if (viewed.value === null) return { status: 'ok', value: null };
    if (!isRecord(viewed.value) || typeof viewed.value['refund_destination'] !== 'string') {
      return { status: 'unavailable' };
    }
    const refundDestination = viewed.value['refund_destination'];
    if (refundDestination.length === 0) return { status: 'unavailable' };
    return { status: 'ok', value: { refundDestination } };
  }

  async function readRequest(requestId: string): Promise<PolicyView<PolicyRequestView | null>> {
    const viewed = await view(config.contractId, 'get_request', { request_id: requestId });
    if (!viewed.ok) return { status: 'unavailable' };
    if (viewed.value === null) return { status: 'ok', value: null };
    if (!isRecord(viewed.value) || typeof viewed.value['status'] !== 'string' || viewed.value['status'].length === 0) {
      return { status: 'unavailable' };
    }
    return { status: 'ok', value: { status: viewed.value['status'], submitted: viewed.value['submitted'] === true } };
  }

  async function readStorage(tokenAccountId: string, accountId: string): Promise<StorageRegistration> {
    const viewed = await view(tokenAccountId, 'storage_balance_of', { account_id: accountId });
    if (!viewed.ok) return { status: 'unavailable' };
    if (viewed.value === null) return { status: 'unregistered' };
    return isRecord(viewed.value) ? { status: 'registered' } : { status: 'unavailable' };
  }

  async function view(
    contractId: string,
    method: string,
    args: Record<string, string>,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    try {
      const value = await provider.callFunction({ contractId, method, args });
      return { ok: true, value: value ?? null };
    } catch {
      return { ok: false };
    }
  }
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
    async getOrder() {
      return { status: 'unavailable' };
    },
    async getRequest() {
      return { status: 'unavailable' };
    },
    async requestRefund() {
      return { status: 'unavailable' };
    },
    async executeRefund() {
      return { status: 'unavailable' };
    },
    async storageBalance() {
      return { status: 'unavailable' };
    },
    async storageDeposit() {
      return { status: 'unavailable' };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
