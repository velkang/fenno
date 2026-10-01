import { arc, arcRpcTransport } from "@stillwater/chain";
import { createPublicClient } from "viem";
import { v3Directory } from "./pool-directory";
import type { DirectoryClient } from "./pool-discovery";
import { v4Directory } from "./v4-pool-directory";

export type IndexerEnv = {
  DB: D1Database;
  DISCOVERY: DurableObjectNamespace;
  // Optional override. Without it, Arc's default RPC (Blockdaemon, ~400k blocks of logs) is used.
  ARC_RPC_URL?: string;
};

export const DIRECTORIES = [v4Directory, v3Directory];

export function createDirectoryClient(url?: string): DirectoryClient {
  return createPublicClient({ chain: arc, transport: arcRpcTransport(url), batch: { multicall: true } }) as
    unknown as DirectoryClient;
}
