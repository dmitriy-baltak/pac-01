import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { PcmRuntime } from "@buf/bitgn_api.connectrpc_es/bitgn/vm/pcm_connect.js";

export type RuntimeClient = Client<typeof PcmRuntime>;

export function createRuntimeClient(harnessUrl: string): RuntimeClient {
  const transport = createConnectTransport({
    baseUrl: harnessUrl,
    httpVersion: "2",
  });
  return createClient(PcmRuntime, transport);
}
