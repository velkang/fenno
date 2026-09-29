import { arc, arcTestnet } from "@actora/chain";
import {
  createPublicClient,
  http,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";
import { importWrappingKey } from "./crypto";
import { D1ProofStore } from "./proof-store";
import { D1WalletLifecycleStore } from "./wallet-lifecycle-store";
import { D1MainnetEvaluationStore } from "./mainnet-evaluation-store";
import { D1MainnetRehearsalStore } from "./mainnet-rehearsal-store";
import { D1MainnetReconciliationStore } from "./mainnet-reconciliation-store";
import { D1MainnetSubmissionStore } from "./mainnet-submission-store";
import {
  evaluateMainnetIntent,
  MainnetEvaluationError,
  type MainnetAuditClient,
} from "./mainnet-evaluator";
import {
  executeMainnetIntent,
  MainnetExecutionError,
} from "./mainnet-executor";
import {
  MainnetRehearsalError,
  rehearseMainnetExecution,
} from "./mainnet-rehearsal";
import {
  MainnetReconciliationError,
  reconcileMainnetAttempt,
} from "./mainnet-reconciler";
import { MainnetSubmissionError } from "./mainnet-submission";
import {
  closeEmptyTestnetProofWallet,
  rotateManagedWalletKey,
  WalletLifecycleError,
} from "./lifecycle";
import {
  executeTestnetProof,
  ProofExecutionError,
  type ProofRpc,
} from "./proof";
import {
  D1WalletProvisioningStore,
  ProvisioningError,
  provisionWallet,
} from "./provision";

export {
  generateWrappingKey,
  importWrappingKey,
  provisionEncryptedWallet,
  rotateEncryptedWallet,
  withManagedAccount,
  type EncryptedWallet,
} from "./crypto";
export {
  validateSigningRequest,
  type PolicyDecision,
  type SigningPolicy,
  type SigningRequest,
  type WalletState,
} from "./policy";
export {
  D1WalletProvisioningStore,
  ProvisioningError,
  provisionWallet,
  type ProvisionedWallet,
  type StoredManagedWallet,
  type WalletProvisioningStore,
} from "./provision";
export {
  executeTestnetProof,
  ProofExecutionError,
  type ProofExecution,
  type ProofResult,
  type ProofRpc,
  type ProofStore,
} from "./proof";
export { D1ProofStore } from "./proof-store";
export { D1WalletLifecycleStore } from "./wallet-lifecycle-store";
export {
  closeEmptyTestnetProofWallet,
  rotateManagedWalletKey,
  WalletLifecycleError,
  type LifecycleWallet,
  type WalletLifecycleStore,
} from "./lifecycle";
export { SigningRejectedError, signAllowedTransaction } from "./sign";
export { D1MainnetEvaluationStore } from "./mainnet-evaluation-store";
export {
  evaluateLoadedMainnetIntent,
  evaluateMainnetIntent,
  MainnetEvaluationError,
  type LoadedMainnetIntent,
  type MainnetAuditClient,
  type MainnetEvaluation,
  type MainnetEvaluationStore,
} from "./mainnet-evaluator";
export {
  executeMainnetIntent,
  MainnetExecutionError,
  type MainnetExecutionResult,
  type MainnetExecutionRpc,
} from "./mainnet-executor";
export { D1MainnetRehearsalStore } from "./mainnet-rehearsal-store";
export {
  MainnetRehearsalError,
  rehearseMainnetExecution,
  type ExecutionRehearsal,
  type ExecutionRehearsalStore,
  type PendingNonceRpc,
  type RehearsalWallet,
} from "./mainnet-rehearsal";
export { D1MainnetReconciliationStore } from "./mainnet-reconciliation-store";
export {
  MainnetReconciliationError,
  reconcileMainnetAttempt,
  recordMainnetReplacement,
  type MainnetAttempt,
  type MainnetAttemptStatus,
  type MainnetReceiptRpc,
  type MainnetReconciliation,
  type MainnetReconciliationStore,
  type MainnetReplacementStore,
  type ReconciliationOutcome,
} from "./mainnet-reconciler";
export { D1MainnetSubmissionStore } from "./mainnet-submission-store";
export {
  handoffMainnetSubmission,
  MainnetSubmissionError,
  type MainnetSubmission,
  type MainnetSubmissionReservation,
  type MainnetSubmissionStore,
} from "./mainnet-submission";

type Env = {
  DB: D1Database;
  WALLET_KEK_V1: string;
  WALLET_KEK_V2?: string;
  ARC_TESTNET_RPC_URL: string;
  ARC_MAINNET_RPC_URL: string;
  ALPHA_MAX_USDC_RAW: string;
  ALPHA_MAX_CIRBTC_RAW: string;
  ALPHA_MAX_TX_FEE_RAW: string;
  MAINNET_EMERGENCY_STOP: string;
  MAINNET_EXECUTION_ENABLED: string;
};

type InternalRequest = {
  userId?: unknown;
  walletId?: unknown;
  intentId?: unknown;
  attemptId?: unknown;
};

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

async function body(request: Request): Promise<InternalRequest | Response> {
  try {
    return await request.json<InternalRequest>();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
}

async function wrappingKeys(env: Env): Promise<Map<number, CryptoKey>> {
  const keys = new Map<number, CryptoKey>();
  keys.set(1, await importWrappingKey(env.WALLET_KEK_V1));
  if (env.WALLET_KEK_V2) {
    keys.set(2, await importWrappingKey(env.WALLET_KEK_V2));
  }
  return keys;
}

function mainnetLimits(env: Env): {
  maxUsdc: bigint;
  maxCirBtc: bigint;
  maxTransactionFee: bigint;
} | null {
  try {
    const limits = {
      maxUsdc: BigInt(env.ALPHA_MAX_USDC_RAW),
      maxCirBtc: BigInt(env.ALPHA_MAX_CIRBTC_RAW),
      maxTransactionFee: BigInt(env.ALPHA_MAX_TX_FEE_RAW),
    };
    return limits.maxUsdc < 0n || limits.maxCirBtc < 0n ||
      limits.maxTransactionFee < 0n ? null : limits;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/internal/v1/wallets/provision") {
      const input = await body(request);
      if (input instanceof Response) return input;
      if (!isIdentifier(input.userId) || !isIdentifier(input.walletId)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }

      try {
        const result = await provisionWallet(
          new D1WalletProvisioningStore(env.DB),
          await importWrappingKey(env.WALLET_KEK_V1),
          {
            userId: input.userId,
            walletId: input.walletId,
            keyVersion: 1,
            now: Date.now(),
          },
        );
        return Response.json(result, { status: result.created ? 201 : 200 });
      } catch (error) {
        if (error instanceof ProvisioningError) {
          const status = error.code === "VERIFIED_OWNER_NOT_FOUND" ? 404 : 409;
          return Response.json({ error: error.code }, { status });
        }
        return Response.json({ error: "PROVISIONING_FAILED" }, { status: 500 });
      }
    }

    if (url.pathname === "/internal/v1/intents/execute-testnet-proof") {
      const input = await body(request);
      if (input instanceof Response) return input;
      if (!isIdentifier(input.intentId) || !isIdentifier(input.walletId)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }

      const client = createPublicClient({
        chain: arcTestnet,
        transport: http(env.ARC_TESTNET_RPC_URL),
      });
      const rpc: ProofRpc = {
        getTransactionCount: (address) =>
          client.getTransactionCount({ address, blockTag: "pending" }),
        estimateFees: async () => {
          const fees = await client.estimateFeesPerGas({ type: "eip1559" });
          return {
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          };
        },
        sendRawTransaction: (serializedTransaction) =>
          client.sendRawTransaction({ serializedTransaction }),
        waitForReceipt: (transactionHash) =>
          client.waitForTransactionReceipt({
            hash: transactionHash,
            confirmations: 1,
            timeout: 45_000,
          }),
      };

      try {
        const result = await executeTestnetProof(
          new D1ProofStore(env.DB),
          rpc,
          await wrappingKeys(env),
          { intentId: input.intentId, walletId: input.walletId, now: Date.now() },
        );
        return Response.json(result);
      } catch (error) {
        if (error instanceof ProofExecutionError) {
          const status =
            error.code === "PROOF_INTENT_NOT_FOUND"
              ? 404
              : error.code === "TESTNET_WALLET_NEEDS_GAS"
                ? 409
                : 422;
          return Response.json({ error: error.code }, { status });
        }
        return Response.json({ error: "PROOF_EXECUTION_FAILED" }, { status: 500 });
      }
    }

    if (url.pathname === "/internal/v1/intents/evaluate-mainnet") {
      const input = await body(request);
      if (input instanceof Response) return input;
      if (!isIdentifier(input.intentId)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }
      const limits = mainnetLimits(env);
      if (!limits) {
        return Response.json({ error: "MAINNET_POLICY_CONFIG_INVALID" }, { status: 503 });
      }
      const client = createPublicClient({
        chain: arc,
        transport: http(env.ARC_MAINNET_RPC_URL),
      }) as unknown as MainnetAuditClient;
      try {
        const evaluation = await evaluateMainnetIntent({
          intentId: input.intentId,
          store: new D1MainnetEvaluationStore(env.DB),
          client,
          limits,
          emergencyStop: env.MAINNET_EMERGENCY_STOP !== "false",
        });
        return Response.json(evaluation);
      } catch (error) {
        if (error instanceof MainnetEvaluationError) {
          return Response.json({ error: error.code }, { status: error.status });
        }
        return Response.json({ error: "MAINNET_EVALUATION_FAILED" }, { status: 500 });
      }
    }

    if (url.pathname === "/internal/v1/intents/rehearse-mainnet") {
      const input = await body(request);
      if (input instanceof Response) return input;
      if (!isIdentifier(input.intentId)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }
      const limits = mainnetLimits(env);
      if (!limits) {
        return Response.json({ error: "MAINNET_POLICY_CONFIG_INVALID" }, { status: 503 });
      }
      const client = createPublicClient({
        chain: arc,
        transport: http(env.ARC_MAINNET_RPC_URL),
      });
      try {
        const evaluationStore = new D1MainnetEvaluationStore(env.DB);
        const rehearsal = await rehearseMainnetExecution({
          intentId: input.intentId,
          store: new D1MainnetRehearsalStore(env.DB),
          rpc: client,
          evaluate: () => evaluateMainnetIntent({
            intentId: input.intentId as string,
            store: evaluationStore,
            client: client as unknown as MainnetAuditClient,
            limits,
            emergencyStop: env.MAINNET_EMERGENCY_STOP !== "false",
          }),
        });
        return Response.json(rehearsal);
      } catch (error) {
        if (error instanceof MainnetEvaluationError || error instanceof MainnetRehearsalError) {
          return Response.json({ error: error.code }, { status: error.status });
        }
        return Response.json({ error: "MAINNET_REHEARSAL_FAILED" }, { status: 500 });
      }
    }

    if (url.pathname === "/internal/v1/intents/execute-mainnet") {
      const input = await body(request);
      if (input instanceof Response) return input;
      if (!isIdentifier(input.intentId)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }
      if (env.MAINNET_EXECUTION_ENABLED !== "true") {
        return Response.json({ error: "MAINNET_EXECUTION_DISABLED" }, { status: 503 });
      }
      const limits = mainnetLimits(env);
      if (!limits) {
        return Response.json({ error: "MAINNET_POLICY_CONFIG_INVALID" }, { status: 503 });
      }
      const client = createPublicClient({
        chain: arc,
        transport: http(env.ARC_MAINNET_RPC_URL),
      });
      try {
        const auditClient = client as unknown as MainnetAuditClient;
        const result = await executeMainnetIntent({
          intentId: input.intentId,
          evaluationStore: new D1MainnetEvaluationStore(env.DB),
          reservationStore: new D1MainnetRehearsalStore(env.DB),
          submissionStore: new D1MainnetSubmissionStore(env.DB),
          rpc: {
            getBalance: (parameters) => auditClient.getBalance(parameters),
            readContract: (parameters) => auditClient.readContract(parameters),
            simulateContract: (parameters) =>
              auditClient.simulateContract(parameters),
            getBlock: (parameters) => auditClient.getBlock(parameters),
            call: (parameters) => auditClient.call(parameters),
            getTransactionCount: ({ address, blockTag }) =>
              client.getTransactionCount({ address, blockTag }),
            estimateFeesPerGas: async () => {
              const fees = await client.estimateFeesPerGas({ type: "eip1559" });
              return {
                maxFeePerGas: fees.maxFeePerGas,
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
              };
            },
            estimateGas: (transaction) => client.estimateGas(transaction),
            sendRawTransaction: ({ serializedTransaction }) =>
              client.sendRawTransaction({ serializedTransaction }),
          },
          getWrappingKeys: () => wrappingKeys(env),
          limits,
          maxTransactionFee: limits.maxTransactionFee,
          emergencyStop: env.MAINNET_EMERGENCY_STOP !== "false",
        });
        return Response.json(result, { status: 202 });
      } catch (error) {
        if (
          error instanceof MainnetExecutionError ||
          error instanceof MainnetEvaluationError ||
          error instanceof MainnetSubmissionError
        ) {
          return Response.json({ error: error.code }, { status: error.status });
        }
        return Response.json({ error: "MAINNET_EXECUTION_FAILED" }, { status: 500 });
      }
    }

    if (url.pathname === "/internal/v1/attempts/reconcile-mainnet") {
      const input = await body(request);
      if (input instanceof Response) return input;
      if (!isIdentifier(input.attemptId)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }
      const client = createPublicClient({
        chain: arc,
        transport: http(env.ARC_MAINNET_RPC_URL),
      });
      try {
        const reconciliation = await reconcileMainnetAttempt({
          attemptId: input.attemptId,
          store: new D1MainnetReconciliationStore(env.DB),
          rpc: {
            getTransactionReceipt: async (hash) => {
              try {
                const receipt = await client.getTransactionReceipt({ hash });
                return { status: receipt.status, blockNumber: receipt.blockNumber };
              } catch (error) {
                if (error instanceof TransactionReceiptNotFoundError) return null;
                throw error;
              }
            },
            getTransaction: async (hash) => {
              try {
                const transaction = await client.getTransaction({ hash });
                return { nonce: transaction.nonce };
              } catch (error) {
                if (error instanceof TransactionNotFoundError) return null;
                throw error;
              }
            },
            getTransactionCount: (address, blockTag) =>
              client.getTransactionCount({ address, blockTag }),
          },
        });
        return Response.json(reconciliation);
      } catch (error) {
        if (error instanceof MainnetReconciliationError) {
          return Response.json({ error: error.code }, { status: error.status });
        }
        return Response.json({ error: "MAINNET_RECONCILIATION_FAILED" }, { status: 500 });
      }
    }

    if (url.pathname === "/internal/v1/wallets/rotate-key") {
      const input = await body(request);
      if (input instanceof Response) return input;
      if (!isIdentifier(input.userId) || !isIdentifier(input.walletId)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }
      if (!env.WALLET_KEK_V2) {
        return Response.json({ error: "NEXT_KEY_UNAVAILABLE" }, { status: 503 });
      }

      try {
        const result = await rotateManagedWalletKey(
          new D1WalletLifecycleStore(env.DB),
          await importWrappingKey(env.WALLET_KEK_V1),
          await importWrappingKey(env.WALLET_KEK_V2),
          {
            userId: input.userId,
            walletId: input.walletId,
            currentKeyVersion: 1,
            nextKeyVersion: 2,
            now: Date.now(),
          },
        );
        return Response.json(result);
      } catch (error) {
        if (error instanceof WalletLifecycleError) {
          return Response.json({ error: error.code }, { status: 409 });
        }
        return Response.json({ error: "WALLET_ROTATION_FAILED" }, { status: 500 });
      }
    }

    if (url.pathname === "/internal/v1/wallets/close-empty-testnet-proof") {
      const input = await body(request);
      if (input instanceof Response) return input;
      if (!isIdentifier(input.userId) || !isIdentifier(input.walletId)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }

      const client = createPublicClient({
        chain: arcTestnet,
        transport: http(env.ARC_TESTNET_RPC_URL),
      });
      try {
        const result = await closeEmptyTestnetProofWallet(
          new D1WalletLifecycleStore(env.DB),
          (address) => client.getBalance({ address }),
          { userId: input.userId, walletId: input.walletId, now: Date.now() },
        );
        return Response.json(result);
      } catch (error) {
        if (error instanceof WalletLifecycleError) {
          return Response.json({ error: error.code }, { status: 409 });
        }
        return Response.json({ error: "WALLET_CLOSE_FAILED" }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
