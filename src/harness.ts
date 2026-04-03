import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { HarnessService } from "@buf/bitgn_api.connectrpc_es/bitgn/harness_connect.js";

export type HarnessClient = Client<typeof HarnessService>;

export function createHarnessClient(
  baseUrl: string,
  apiKey: string,
): HarnessClient {
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: "2",
    interceptors: [
      (next) => async (req) => {
        req.header.set("Authorization", `Bearer ${apiKey}`);
        return next(req);
      },
    ],
  });
  return createClient(HarnessService, transport);
}
