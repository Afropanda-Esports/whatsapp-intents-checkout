import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpIntentsCheckoutPayments } from './adaptors/intents-checkout/http-intents-checkout-payments.js';
import { buildServer } from './adaptors/fastify/server.js';
import { registerWhatsAppWebhook } from './adaptors/fastify/whatsapp-routes.js';
import { createOpenAiCompatibleLanguageModel } from './adaptors/openai-compatible/openai-compatible-language-model.js';
import { createScriptedLanguageModel } from './adaptors/openai-compatible/scripted-language-model.js';
import { createHttpPandaPayCatalog } from './adaptors/panda-pay/http-panda-pay-catalog.js';
import { createHttpPandaPayOrders } from './adaptors/panda-pay/http-panda-pay-orders.js';
import { createCloudApiMessagingChannel } from './adaptors/whatsapp-cloud-api/cloud-api-messaging-channel.js';
import { readInboundText } from './adaptors/whatsapp-cloud-api/read-inbound-text.js';
import { loadConfig, type AppConfig } from './config.js';
import { createConversationService } from './domain/conversation/conversation-service.js';
import { createToolPolicy, type ToolPolicy } from './domain/conversation/tool-policy.js';
import { createInMemoryCatalog } from './fakes/in-memory-catalog.js';
import { createInMemoryCheckout, type InMemoryCheckout } from './fakes/in-memory-checkout.js';
import { createInMemoryConversationStore } from './fakes/in-memory-conversation-store.js';
import { createInMemoryOrders, type InMemoryOrders } from './fakes/in-memory-orders.js';
import { inspectPurchases, type PurchaseInspection } from './fakes/inspect-purchases.js';
import type { FastifyInstance } from 'fastify';
import type { HandleMessage } from './ports/inbound/handle-message.js';
import type { CheckoutPayments } from './ports/outbound/checkout-payments.js';
import type { LanguageModel } from './ports/outbound/language-model.js';
import type { MerchantCatalog } from './ports/outbound/merchant-catalog.js';
import type { MerchantOrders } from './ports/outbound/merchant-orders.js';

export type AgentApp = {
  app: FastifyInstance;
  port: number;
  policy: ToolPolicy;
  handleMessage: HandleMessage;
  transport: 'memory' | 'http';
  inspection?: PurchaseInspection;
};

export async function buildAgent(env: Record<string, string | undefined>): Promise<AgentApp> {
  const config = loadConfig(env);
  const trace: string[] = [];
  const policy = createToolPolicy();
  const wired = wireMerchant(config, trace);
  const handleMessage = createConversationService({
    model: wireModel(config),
    policy,
    catalog: wired.catalog,
    orders: wired.orders,
    checkout: wired.checkout,
    store: createInMemoryConversationStore(),
  });
  const app = await buildServer({ handleMessage });
  if (config.whatsapp !== undefined) {
    registerWhatsAppWebhook(app, {
      handleMessage,
      channel: createCloudApiMessagingChannel(config.whatsapp),
      readInboundText,
    });
  }
  const agent: AgentApp = {
    app,
    port: config.port,
    policy,
    handleMessage,
    transport: wired.transport,
  };
  if (wired.inspection !== undefined) agent.inspection = wired.inspection;
  return agent;
}

function wireModel(config: AppConfig): LanguageModel {
  if (config.llmBaseUrl === undefined) return createScriptedLanguageModel();
  return createOpenAiCompatibleLanguageModel({
    baseUrl: config.llmBaseUrl,
    model: config.llmModel ?? 'checkout-agent',
    ...(config.llmApiKey === undefined ? {} : { apiKey: config.llmApiKey }),
  });
}

function wireMerchant(config: AppConfig, trace: string[]): {
  catalog: MerchantCatalog;
  orders: MerchantOrders;
  checkout: CheckoutPayments;
  transport: 'memory' | 'http';
  inspection?: PurchaseInspection;
} {
  if (config.pandaPayBaseUrl !== undefined && config.checkoutBaseUrl !== undefined) {
    const apiKey = config.pandaPayApiKey ?? '';
    return {
      transport: 'http',
      catalog: createHttpPandaPayCatalog({ baseUrl: config.pandaPayBaseUrl, apiKey }),
      orders: createHttpPandaPayOrders({ baseUrl: config.pandaPayBaseUrl, apiKey }),
      checkout: createHttpIntentsCheckoutPayments({
        baseUrl: config.checkoutBaseUrl,
        apiKey: config.checkoutApiKey ?? '',
      }),
    };
  }
  const orders: InMemoryOrders = createInMemoryOrders(trace);
  const checkout: InMemoryCheckout = createInMemoryCheckout(trace);
  return {
    transport: 'memory',
    catalog: createInMemoryCatalog(trace),
    orders,
    checkout,
    inspection: inspectPurchases(orders, checkout, trace),
  };
}

async function start(): Promise<void> {
  const agent = await buildAgent(process.env);
  try {
    await agent.app.listen({ port: agent.port, host: '0.0.0.0' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'server failed to listen';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
  process.stdout.write(`listening ${agent.port}\n`);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  void start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'startup failed';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
