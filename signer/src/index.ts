import { arc } from "@stillwater/chain";
import {
  createPublicClient,
  http,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";
import { createCircleWallet, signWithCircle, type CircleEnv } from "./circle";
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
  D1WalletProvisioningStore,
  ProvisioningError,
  provisionWallet,
} from "./provision";

export {
  CircleError,
  createCircleWallet,
  entitySecretCiphertext,
  signWithCircle,
  type CircleEnv,
} from "./circle";
export type { WalletState } from "./policy";
export {
  D1WalletProvisioningStore,
  ProvisioningError,
  provisionWallet,
  type CreateCustodyWallet,
  type ProvisionedWallet,
  type StoredManagedWallet,
  type WalletProvisioningStore,
} from "./provision";
export { D1MainnetEvaluationStore } from "./mainnet-evaluation-store";
export {
  evaluateLoadedMainnetIntent,
  evaluateMainnetIntent,
  MainnetEvaluationError,
  type CustodyWallet,
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

type Env = CircleEnv & {
  DB: D1Database;
  // Optional override; without it, Arc's default public RPC is used.
  ARC_RPC_URL?: string;
  // Optional: "true" halts all signing except USDC withdrawals.
  EMERGENCY_STOP?: string;
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
          (idempotencyKey) => createCircleWallet(env, idempotencyKey),
          {
            userId: input.userId,
            walletId: input.walletId,
            now: Date.now(),
          },
        );
        return Response.json(result, { status: result.created ? 201 : 200 });
      } catch (error) {
        if (error instanceof ProvisioningError) {
          const status = error.code === "VERIFIED_OWNER_NOT_FOUND" ? 404
            : error.code === "CUSTODY_WALLET_CREATE_FAILED" ? 502 : 409;
          return Response.json({ error: error.code }, { status });
        }
        return Response.json({ error: "PROVISIONING_FAILED" }, { status: 500 });
      }
    }

    if (url.pathname === "/internal/v1/intents/evaluate-mainnet") {
      const input = await body(request);
      if (input instanceof Response) return input;
      if (!isIdentifier(input.intentId)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }
      const client = createPublicClient({
        chain: arc,
        transport: http(env.ARC_RPC_URL),
      }) as unknown as MainnetAuditClient;
      try {
        const evaluation = await evaluateMainnetIntent({
          intentId: input.intentId,
          store: new D1MainnetEvaluationStore(env.DB),
          client,
          emergencyStop: env.EMERGENCY_STOP === "true",
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
      const client = createPublicClient({
        chain: arc,
        transport: http(env.ARC_RPC_URL),
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
            emergencyStop: env.EMERGENCY_STOP === "true",
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
      const client = createPublicClient({
        chain: arc,
        transport: http(env.ARC_RPC_URL),
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
            // v3 swaps, approvals and mints verify the pool contract before signing.
            getCode: (parameters) => client.getCode(parameters),
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
          signTransaction: (circleWalletId, transaction) =>
            signWithCircle(env, circleWalletId, transaction),
          emergencyStop: env.EMERGENCY_STOP === "true",
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
        transport: http(env.ARC_RPC_URL),
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

    return new Response("Not found", { status: 404 });
  },
};
