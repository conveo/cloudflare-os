import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse, type ParseError } from "jsonc-parser";
import { aiGatewayPlan, buildCommands, generateConfigs, validateConfig } from "./deploy.ts";
import type {
  BaseConfigs,
  DeploymentConfig,
  GeneratedConfigs,
  ProdWranglerConfig,
} from "./deployment-config.ts";

const validConfig: DeploymentConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  publicBaseUrl: null,
  workers: {
    router: { name: "acme-cloudflare-os", route: { customDomain: "os.example.com" } },
    workshop: { name: "acme-cloudflare-os-backend" },
    context: { name: "acme-cloudflare-os-context" },
    scheduler: { name: "acme-cloudflare-os-scheduler" },
    customGatekeeper: { name: "acme-cloudflare-os-custom" },
    mcpGatekeeper: { name: "acme-cloudflare-os-mcp" },
    mcpPortalGatekeeper: { name: "acme-cloudflare-os-mcp-portal" },
    errorReporter: { name: "acme-cloudflare-os-errors" },
  },
  access: {
    issuer: "https://acme.cloudflareaccess.com",
    audience: "access-audience",
    admins: ["admin@example.com"],
  },
  aiGateway: {
    enabled: true,
    name: "cloudflare-os",
    accountId: null,
    providers: ["anthropic", "cloudflare"],
  },
  context: {
    sharingDomain: null,
    kvNamespaceId: "context-kv-id",
    artifacts: { enabled: true, namespace: "acme-context-collections" },
  },
  customGatekeeper: { name: "Acme", message: "Use the company handbook." },
  mcp: { enabled: true },
  mcpPortal: { enabled: true, url: "https://mcp.example.com/", name: "Acme portal" },
  errorReporting: { enabled: true, environment: "production", release: "abc123" },
  resources: {
    blueprintsKvNamespaceId: "blueprints-kv-id",
    avatarsKvNamespaceId: "avatars-kv-id",
    blueprintContentBucket: "cloudflare-os-blueprints",
  },
  observability: {
    enabled: true,
    headSamplingRate: 0.5,
    logs: { invocationLogs: false },
    traces: { enabled: true, headSamplingRate: 0.25 },
  },
};

/**
 * A copy of {@link validConfig} with `mutate` applied, typed loosely on purpose.
 *
 * Most of these variants assign something `DeploymentConfig` forbids, which is exactly what
 * `validateConfig` exists to catch: `deployment.jsonc` is hand-edited JSONC with no schema behind
 * it, so the type describes the valid shape rather than guaranteeing what is on disk.
 */
function variant(mutate: (config: Record<string, any>) => void): DeploymentConfig {
  const config = structuredClone(validConfig) as Record<string, any>;
  mutate(config);
  return config as DeploymentConfig;
}

// Read from disk rather than inlined, including the Error Reporter's: deploy.ts derives every
// generated config from these files, so a copy here could drift from what actually ships.
async function baseConfigs(): Promise<BaseConfigs> {
  return {
    router: await baseConfig("../cloudflare-os/packages/router/wrangler.jsonc"),
    workshop: await baseConfig("../cloudflare-os/packages/workshop-backend/wrangler.jsonc"),
    context: await baseConfig("../cloudflare-os/packages/gatekeeper-context/wrangler.jsonc"),
    scheduler: await baseConfig("../cloudflare-os/packages/gatekeeper-scheduler/wrangler.jsonc"),
    customGatekeeper: await baseConfig("../packages/custom-gatekeeper/wrangler.jsonc"),
    mcpGatekeeper: await baseConfig("../cloudflare-os/packages/gatekeeper-mcp/wrangler.jsonc"),
    mcpPortalGatekeeper: await baseConfig(
      "../cloudflare-os/packages/gatekeeper-mcp-portal/wrangler.jsonc"),
    errorReporter: await baseConfig("../packages/error-reporter/wrangler.jsonc"),
  };
}

// Parsed the way `deploy.ts` parses it, errors included. Swallowing them would let a base config
// that the deploy cannot read still pass these tests on a best-effort parse -- which is how the
// Scheduler's trailing commas hid: nine parse errors, and a config object that still looked usable.
async function baseConfig(path: string): Promise<ProdWranglerConfig> {
  const errors: ParseError[] = [];
  const result = parse(
    await readFile(new URL(path, import.meta.url), "utf8"),
    errors,
    { allowTrailingComma: true },
  ) as ProdWranglerConfig;
  assert.deepEqual(errors, [], `${path} did not parse cleanly`);
  return result;
}

/** The Context data-isolation boundary carried by the Workshop's Gatekeeper binding. */
function sharingDomain(generated: GeneratedConfigs): unknown {
  return generated.workshop.services!
    .find((service) => service.binding === "GATEKEEPER_CONTEXT")!.props!.sharingDomain;
}

test("rejects deployment placeholders", () => {
  assert.throws(
    () => validateConfig(variant((c) => { c.accountId = "<CLOUDFLARE_ACCOUNT_ID>"; })),
    /placeholder/i);
});

test("rejects destructive or malformed deployment values", () => {
  const duplicateWorkers = structuredClone(validConfig);
  duplicateWorkers.workers.context.name = duplicateWorkers.workers.workshop.name;
  assert.throws(() => validateConfig(duplicateWorkers), /unique/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.observability.enabled = "true"; })), /boolean/i);

  assert.throws(
    () => validateConfig(variant((c) => {
      c.workers.router.route.customDomain = "os.example.com/path";
    })), /hostname/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.sharingDomain = ""; })),
    /sharingDomain must be null or a non-empty string/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.issuer += "/team"; })), /issuer.*origin/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.audience = "   "; })), /audience/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.audience = " access-audience "; })), /audience/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.admins = ["bad-address"]; })), /email/i);

  assert.throws(
    () => validateConfig(variant((c) => {
      c.observability.traces.headSamplingRate = 2;
    })), /sampling/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.enabled = "true"; })),
    /Artifacts enabled.*boolean/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts = null; })),
    /Artifacts configuration.*object/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts = []; })),
    /Artifacts configuration.*object/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.namespace = null; })),
    /namespace must be omitted/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.namespace = "context/collections"; })),
    /namespace must be omitted/i);
});

test("rejects AI Gateway keys that no longer do anything", () => {
  // A silently-ignored workersAi block is how a deploy succeeds with an empty model picker.
  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.workersAi = { mode: "gateway" }; })),
    /aiGateway\.workersAi does nothing/i);
  // Even with AI off: the key means the operator believes it still does something.
  assert.throws(
    () => validateConfig(variant((c) => {
      c.aiGateway = { enabled: false, workersAi: { mode: "direct" } };
    })),
    /aiGateway\.workersAi does nothing/i);
});

test("rejects malformed AI Gateway providers and account", () => {
  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.providers = []; })),
    /Missing required deployment value: aiGateway.providers/);

  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.providers = ["anthropic", "mistral"]; })),
    /providers must be a non-empty subset/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.accountId = "not-an-account"; })),
    /aiGateway.accountId must be null or 32 hexadecimal/i);
});

test("generates Access-mode Workshop, Context, and custom Gatekeeper configs", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(generated.workshop.name, "acme-cloudflare-os-backend");
  assert.deepEqual(vars.ADMINS, ["admin@example.com"]);
  assert.equal(vars.CF_ACCESS_ISS, validConfig.access.issuer);
  assert.equal(vars.CF_ACCESS_AUD, validConfig.access.audience);
  assert.equal(vars.PUBLIC_BASE_URL, "https://os.example.com");
  assert.equal(vars.CF_AI_GATEWAY, "cloudflare-os");
  assert.equal(vars.CF_AI_GATEWAY_PROVIDERS, "anthropic,cloudflare");
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(generated.workshop.services, [
    {
      binding: "ERROR_REPORTER",
      service: "acme-cloudflare-os-errors",
      entrypoint: "ErrorReporter",
      props: {
        service: "acme-cloudflare-os-backend",
        environment: "production",
        release: "abc123",
      },
    },
    {
      binding: "GATEKEEPER_CONTEXT",
      service: "acme-cloudflare-os-context",
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: "https://os.example.com" },
    },
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: "acme-cloudflare-os-scheduler",
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_CUSTOM",
      service: "acme-cloudflare-os-custom",
      entrypoint: "GatekeeperVendor",
    },
    // Conveo's agentgateway connectors; see docs/agentgateway.md.
    {
      binding: "GATEKEEPER_MCP",
      service: "acme-cloudflare-os-mcp",
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_MCP_PORTAL",
      service: "acme-cloudflare-os-mcp-portal",
      entrypoint: "GatekeeperVendor",
    },
  ]);
  assert.deepEqual(generated.workshop.kv_namespaces, [
    { binding: "BLUEPRINTS", id: "blueprints-kv-id" },
    { binding: "AVATARS", id: "avatars-kv-id" },
  ]);
  assert.equal(generated.workshop.r2_buckets![0].bucket_name, "cloudflare-os-blueprints");
  assert.equal(generated.context.name, "acme-cloudflare-os-context");
  assert.equal(generated.context.kv_namespaces![0].id, "context-kv-id");
  assert.deepEqual(generated.context.artifacts, [{
    binding: "ARTIFACTS",
    namespace: "acme-context-collections",
  }]);
  assert.equal(generated.customGatekeeper.name, "acme-cloudflare-os-custom");
  assert.deepEqual(generated.customGatekeeper.vars, {
    CUSTOM_NAME: "Acme",
    CUSTOM_MESSAGE: "Use the company handbook.",
  });
  assert.equal(generated.errorReporter!.name, "acme-cloudflare-os-errors");
  assert.deepEqual(generated.workshop.observability!.logs, {
    invocation_logs: false,
  });
  assert.deepEqual(generated.workshop.observability!.traces, {
    enabled: true,
    head_sampling_rate: 0.25,
  });
  assert.equal(generated.workshop.services!.some(
    (service) => service.binding === "FRONTEND_ERROR_REPORTER"), false);
});

test("gives the router the public route, the frontend, and every service binding", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(validConfig, bases);

  assert.equal(generated.router.name, "acme-cloudflare-os");
  assert.equal(generated.router.workers_dev, false);
  assert.deepEqual(generated.router.routes, [{ pattern: "os.example.com", custom_domain: true }]);
  // No entrypoint on any of them: the router forwards whole HTTP requests rather than making
  // vendor RPC calls, and the binding name is what selects the /gatekeeper/<name> path.
  assert.deepEqual(generated.router.services, [
    { binding: "WORKSHOP_BACKEND", service: "acme-cloudflare-os-backend" },
    { binding: "GATEKEEPER_CONTEXT", service: "acme-cloudflare-os-context" },
    { binding: "GATEKEEPER_SCHEDULER", service: "acme-cloudflare-os-scheduler" },
    { binding: "GATEKEEPER_CUSTOM", service: "acme-cloudflare-os-custom" },
    // Conveo's agentgateway connectors; see docs/agentgateway.md.
    { binding: "GATEKEEPER_MCP", service: "acme-cloudflare-os-mcp" },
    { binding: "GATEKEEPER_MCP_PORTAL", service: "acme-cloudflare-os-mcp-portal" },
  ]);
  // Inherited untouched: the base config already carries the ASSETS binding, the SPA fallback, and
  // the /gatekeeper/* prefix an OAuth Gatekeeper redirect needs.
  assert.deepEqual(generated.router.assets, bases.router.assets);
  assert.equal(generated.router.assets!.binding, "ASSETS");
  assert.equal(generated.router.assets!.directory, "../workshop-frontend/dist");
  assert.ok(generated.router.assets!.run_worker_first!.includes("/gatekeeper/*"),
    JSON.stringify(generated.router.assets));
});

/**
 * The hosted deploy preinstalls this one on every fresh instance (`PREINSTALL` in
 * cloudflare-os/scripts/release/manifest-lib.ts), so a starter that skipped it would not be the same
 * topology: a migrated instance would show none of its existing schedules, and the
 * Durable Objects holding them would be orphaned behind a Worker nothing is bound to.
 */
test("deploys the ambient Scheduler Gatekeeper the hosted flow preinstalls", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(validConfig, bases);

  assert.equal(generated.scheduler.name, "acme-cloudflare-os-scheduler");
  // Reached by both, for the two different things a Gatekeeper does: vendor RPC from the backend,
  // and whole HTTP requests under /gatekeeper/scheduler from the router.
  assert.deepEqual(
    generated.workshop.services!.find((service) => service.binding === "GATEKEEPER_SCHEDULER"),
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: "acme-cloudflare-os-scheduler",
      entrypoint: "GatekeeperVendor",
    });
  assert.deepEqual(
    generated.router.services!.find((service) => service.binding === "GATEKEEPER_SCHEDULER"),
    { binding: "GATEKEEPER_SCHEDULER", service: "acme-cloudflare-os-scheduler" });

  // Its Durable Object history has to arrive verbatim: those classes are where the schedules live.
  assert.deepEqual(generated.scheduler.migrations, bases.scheduler.migrations);
  assert.ok(generated.scheduler.migrations!.length > 0, "scheduler lost its DO migrations");
  // No configuration surface of its own -- which is what makes it installable with no user input
  // upstream, and deployable here from nothing but a Worker name.
  assert.equal(generated.scheduler.vars, undefined);
  assert.equal(generated.scheduler.kv_namespaces, undefined);
  assert.equal(generated.scheduler.secrets, undefined);

  const builds = buildCommands(validConfig)
    .map(({ args }) => args)
    .filter((args) => args.includes("@gadgets/gatekeeper-scheduler"));
  assert.deepEqual(builds.map((args) => args.at(-1)), ["build:app", "build"]);
});

test("keeps every Worker behind the router off the public internet", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  const workers = Object.entries(generated) as [string, ProdWranglerConfig][];

  for (const [name, worker] of workers) {
    if (name !== "router") {
      assert.equal(worker.workers_dev, false, `${name} answers on workers.dev`);
      assert.equal(worker.routes, undefined, `${name} carries a public route`);
    }
    // A preview URL is an unauthenticated path around the Access-protected origin.
    assert.equal(worker.preview_urls, false, `${name} leaves preview URLs enabled`);
  }
  // The router serves the frontend, so the backend uploads no assets of its own.
  assert.equal(generated.workshop.assets, undefined);
});

test("scopes PUBLIC_BASE_URL and Context sharing to the public origin", async () => {
  const onWorkersDev = variant((c) => {
    c.workers.router.route = { workersDev: true };
    c.publicBaseUrl = "https://acme-cloudflare-os.acme.workers.dev";
  });

  const derived = generateConfigs(validConfig, await baseConfigs());
  const explicit = generateConfigs(onWorkersDev, await baseConfigs());

  assert.equal(derived.workshop.vars!.PUBLIC_BASE_URL, "https://os.example.com");
  assert.equal(
    explicit.workshop.vars!.PUBLIC_BASE_URL, "https://acme-cloudflare-os.acme.workers.dev");
  assert.equal(explicit.router.workers_dev, true);
  assert.equal(explicit.router.routes, undefined);

  // sharingDomain: null follows the public origin, which is what the hosted deploy sets it to.
  assert.equal(sharingDomain(derived), "https://os.example.com");
  assert.equal(sharingDomain(explicit), "https://acme-cloudflare-os.acme.workers.dev");

  // A pinned literal keeps the boundary stable across a hostname change, so it wins.
  const pinned = generateConfigs(
    variant((c) => { c.context.sharingDomain = "production"; }), await baseConfigs());
  assert.equal(sharingDomain(pinned), "production");
  assert.equal(pinned.workshop.vars!.PUBLIC_BASE_URL, "https://os.example.com");
});

test("rejects a public origin it cannot derive or cannot trust", async () => {
  // Nothing in deployment.jsonc names the account's workers.dev subdomain, and PUBLIC_BASE_URL and
  // the Context sharing boundary both need an origin, so this cannot be left to a fallback.
  assert.throws(
    () => validateConfig(variant((c) => { c.workers.router.route = { workersDev: true }; })),
    /publicBaseUrl is required on a workersDev route/i);

  // Scoping Context data to a hostname the deployment does not answer on hides its collections.
  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "https://other.example.com"; })),
    /does not match workers.router.route.customDomain/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "https://os.example.com/"; })),
    /HTTPS origin only/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "http://os.example.com"; })),
    /HTTPS origin only/i);

  assert.throws(
    () => validateConfig(variant((c) => { delete c.publicBaseUrl; })),
    /publicBaseUrl must be present/i);
});

test("rejects a workersDev origin that is not the router's own", async () => {
  const onWorkersDev = (publicBaseUrl: string) => variant((c) => {
    c.workers.router.route = { workersDev: true };
    c.publicBaseUrl = publicBaseUrl;
  });

  // The account's workers.dev subdomain is unknowable here, but the rest of the hostname is not: a
  // typo in the Worker label, or an unrelated host, would silently become both PUBLIC_BASE_URL and
  // the Context isolation boundary.
  assert.throws(
    () => validateConfig(onWorkersDev("https://acme-cloudflare-o.acme.workers.dev")),
    /names Worker "acme-cloudflare-o", but the router is "acme-cloudflare-os"/);

  assert.throws(
    () => validateConfig(onWorkersDev("https://os.example.com")),
    /not a workers.dev origin/i);

  // A deeper name is a preview URL or an unrelated host, not the route wrangler serves.
  assert.throws(
    () => validateConfig(onWorkersDev("https://staging.acme-cloudflare-os.acme.workers.dev")),
    /not a workers.dev origin/i);

  // The shape wrangler actually serves stays valid, whatever the account subdomain is.
  const generated = generateConfigs(
    onWorkersDev("https://acme-cloudflare-os.some-account.workers.dev"), await baseConfigs());
  assert.equal(
    generated.workshop.vars!.PUBLIC_BASE_URL, "https://acme-cloudflare-os.some-account.workers.dev");

  // The rule is scoped to the workersDev route. A custom domain has its own hostname, unrelated to
  // any Worker name, and is checked against `customDomain` instead -- both spellings stay valid.
  assert.equal(
    validateConfig(variant((c) => { c.publicBaseUrl = "https://os.example.com"; })).publicBaseUrl,
    "https://os.example.com");
  assert.equal(validateConfig(validConfig).publicBaseUrl, null);
});

test("routes AI Gateway over the Workers AI binding without an API token", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, validConfig.accountId);
  // Absent, not "true": the backend takes the binding whenever it is bound, and the binding is
  // pre-authenticated inside the deployment's own account.
  assert.equal(vars.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  assert.deepEqual(aiGatewayPlan(validConfig), {
    gatewayAccountId: validConfig.accountId,
    crossAccount: false,
    needsToken: false,
    tokenReasons: [],
  });
});

test("requires a token for a gateway in another account", async () => {
  const config = variant((c) => { c.aiGateway.accountId = "fedcba9876543210fedcba9876543210"; });
  const generated = generateConfigs(config, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, "fedcba9876543210fedcba9876543210");
  assert.equal(vars.CF_AI_GATEWAY_USE_BINDING, "false");
  assert.deepEqual(generated.workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN"] });
  // The Workers AI binding stays bound: webFetch's toMarkdown() runs on it too.
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.equal(aiGatewayPlan(config)!.tokenReasons.length, 1);
});

test("treats a differently-cased account ID as the same account", async () => {
  const config = variant((c) => { c.aiGateway.accountId = c.accountId.toUpperCase(); });
  const generated = generateConfigs(config, await baseConfigs());

  // Same account written two ways, which the hex pattern accepts: the binding reaches this gateway,
  // so no CF_AI_GATEWAY_USE_BINDING opt-out and no token.
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_ACCOUNT_ID, validConfig.accountId);
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  assert.equal(aiGatewayPlan(config)!.crossAccount, false);
  assert.deepEqual(aiGatewayPlan(config)!.tokenReasons, []);
});

test("requires a token for the google provider", async () => {
  const config = variant((c) => { c.aiGateway.providers = ["cloudflare", "google"]; });
  const generated = generateConfigs(config, await baseConfigs());

  assert.deepEqual(generated.workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN"] });
  // Same account, so the binding still carries every other provider.
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.match(aiGatewayPlan(config)!.tokenReasons[0], /google/i);
});

test("omits disabled backend error reporting", async () => {
  const config = variant((c) => {
    c.errorReporting = { enabled: false, environment: "<ENVIRONMENT>", release: "<RELEASE>" };
  });

  const generated = generateConfigs(config, await baseConfigs());

  assert.equal(generated.errorReporter, undefined);
  assert.equal(generated.workshop.services!.some(
    (service) => service.binding === "ERROR_REPORTER"), false);
});

test("omits dormant AI Gateway configuration", async () => {
  const config = variant((c) => {
    c.aiGateway = {
      enabled: false,
      name: "<AI_GATEWAY_NAME>",
      accountId: "<AI_GATEWAY_ACCOUNT_ID>",
      providers: [],
    };
  });

  const generated = generateConfigs(config, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY, undefined);
  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, undefined);
  assert.equal(vars.CF_AI_GATEWAY_PROVIDERS, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  // Still bound: it is what webFetch's toMarkdown() runs on, independent of the model catalog.
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.equal(aiGatewayPlan(config), null);
});

test("uses the default Context Artifacts namespace when omitted", async () => {
  const config = variant((c) => { delete c.context.artifacts.namespace; });

  const generated = generateConfigs(config, await baseConfigs());

  assert.deepEqual(generated.context.artifacts, [{
    binding: "ARTIFACTS",
    namespace: "gatekeeper-context-collections",
  }]);
});

test("omits disabled Context Artifacts configuration", async () => {
  const config = variant((c) => { c.context.artifacts = {}; });
  const bases = await baseConfigs();
  bases.context.artifacts = [{ binding: "ARTIFACTS", namespace: "upstream-default" }];

  const generated = generateConfigs(config, bases);

  assert.equal(generated.context.artifacts, undefined);
});

test("defaults Context Artifacts to disabled when configuration is omitted", async () => {
  const config = variant((c) => { delete c.context.artifacts; });

  const generated = generateConfigs(config, await baseConfigs());

  assert.equal(generated.context.artifacts, undefined);
});

test("generates binding-only storage for automatic provisioning", async () => {
  const config = variant((c) => {
    c.context.kvNamespaceId = null;
    c.resources = {
      blueprintsKvNamespaceId: null,
      avatarsKvNamespaceId: null,
      blueprintContentBucket: null,
    };
  });

  const generated = generateConfigs(config, await baseConfigs());

  assert.deepEqual(generated.workshop.kv_namespaces, [
    { binding: "BLUEPRINTS" },
    { binding: "AVATARS" },
  ]);
  assert.deepEqual(generated.workshop.r2_buckets, [{ binding: "BLUEPRINT_CONTENT" }]);
  assert.deepEqual(generated.context.kv_namespaces, [{ binding: "CONTEXT_COLLECTIONS" }]);
});

/**
 * The equivalent, for this repository, of upstream's `deploy-scripts.test.ts`. That one
 * auto-discovers per-package `deploy` scripts; here deploying is centralised in `deploy.ts`, so the
 * same invariant has to be asserted against the commands it spawns.
 *
 * Both halves are silent failures: a replayed cache hit and a dropped build-time flag each exit
 * zero and each still deploy.
 */
test("never lets a deploy replay a cached build artifact", () => {
  const commands = buildCommands(validConfig);
  assert.ok(commands.length > 0, "expected at least one build command");
  for (const { args } of commands) {
    const command = args.join(" ");
    // `pnpm --filter <pkg> build` cannot see a Vite+ task, and two of the three submodule targets
    // are now tasks rather than scripts. `vp run` runs both.
    assert.ok(command.includes("vp run"),
      `build step does not go through vp run: ${command}`);
    assert.ok(command.includes("--no-cache"),
      `build step runs a vp task while deploying without --no-cache: ${command}\n` +
      "Deploys must not replay a cached artifact -- add --no-cache.");
    // Everything after the task specifier is forwarded to the task's own command, so a trailing
    // flag reaches `tsc` as an unknown option instead of reaching vp.
    assert.ok(args.indexOf("--no-cache") < args.indexOf("run") + 4,
      `--no-cache must precede the task name, not follow it: ${command}`);
  }
});

test("rebuilds the Context configurator app rather than replaying it", () => {
  // `gatekeeper-context`'s `build` script spawns `vp run --cache build:app` of its own, which the
  // outer --no-cache does not reach. Without this step a deploy ships whatever app.txt the cache
  // last archived.
  const context = buildCommands(validConfig)
    .map(({ args }) => args)
    .filter((args) => args.includes("@gadgets/gatekeeper-context"));
  assert.deepEqual(context.map((args) => args.at(-1)), ["build:app", "build"]);
  assert.ok(context.every((args) => args.at(-2) === "--no-cache"), context.join("\n"));
});

test("passes VITE_CF_ACCESS_MODE explicitly rather than inheriting it", () => {
  const withAccessMode = buildCommands(validConfig).filter(({ env }) => env);
  assert.deepEqual(withAccessMode.map(({ env }) => env), [{ VITE_CF_ACCESS_MODE: "true" }]);
  // It has to reach the frontend, which inlines it into the bundle, and nothing else.
  assert.match(withAccessMode[0].args.join(" "), /@gadgets\/workshop-frontend/);
});

test("builds the frontend before the router", () => {
  const order = buildCommands(validConfig).map(({ args }) => args.join(" "));
  const frontend = order.findIndex((command) => command.includes("workshop-frontend"));
  const router = order.findIndex((command) => command.includes("@gadgets/router"));
  // The router deploy picks up ../workshop-frontend/dist as its assets.
  assert.ok(frontend >= 0 && router >= 0 && frontend < router, order.join("\n"));
});

test("skips the Error Reporter build when error reporting is disabled", () => {
  const config = variant((c) => {
    c.errorReporting = { enabled: false, environment: "<ENVIRONMENT>", release: null };
  });
  const commands = buildCommands(config).map(({ args }) => args.join(" "));
  assert.equal(commands.some((command) => command.includes("error-reporter")), false);
});

// ---------------------------------------------------------------------------
// Conveo's additions: the two agentgateway MCP connectors, and the catalog this
// workspace mirrors from the submodule. See docs/agentgateway.md.

test("binds both MCP connectors on the router and the Workshop", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());

  // On the router because each serves an OAuth callback at /gatekeeper/<name>/oauth, and on the
  // Workshop because the backend discovers Gatekeepers by scanning GATEKEEPER_* bindings.
  for (const binding of ["GATEKEEPER_MCP", "GATEKEEPER_MCP_PORTAL"]) {
    assert.ok(generated.router.services?.some((s) => s.binding === binding),
      `${binding} missing from the router`);
    assert.ok(generated.workshop.services?.some((s) => s.binding === binding),
      `${binding} missing from the Workshop`);
  }
  assert.equal(generated.mcpGatekeeper?.routes, undefined);
  assert.equal(generated.mcpPortalGatekeeper?.routes, undefined);
});

test("derives each connector's OAuth callback from the public origin", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());

  // The router turns a binding suffix into a path, so BASE_URL must match it exactly or the
  // callback 404s after the user has already authorized.
  assert.equal(generated.mcpGatekeeper?.vars?.BASE_URL,
    "https://os.example.com/gatekeeper/mcp");
  assert.equal(generated.mcpPortalGatekeeper?.vars?.BASE_URL,
    "https://os.example.com/gatekeeper/mcp-portal");

  // publicBaseUrl is what lets a workers.dev deployment work at all: the origin is otherwise
  // unknowable before the first deploy, which is why this used to require a custom domain.
  const onWorkersDev = structuredClone(validConfig);
  onWorkersDev.workers.router.route = { workersDev: true };
  onWorkersDev.publicBaseUrl = "https://acme-cloudflare-os.example-sub.workers.dev";
  const dev = generateConfigs(onWorkersDev, await baseConfigs());
  assert.equal(dev.mcpGatekeeper?.vars?.BASE_URL,
    "https://acme-cloudflare-os.example-sub.workers.dev/gatekeeper/mcp");
});

test("configures the portal, and refuses an unusable portal URL", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  const vars = generated.mcpPortalGatekeeper?.vars ?? {};
  assert.equal(vars.MCP_PORTAL_URL, "https://mcp.example.com/");
  assert.equal(vars.MCP_PORTAL_NAME, "Acme portal");
  assert.equal(vars.MCP_PORTAL_AUTH, "oauth");
  // An aggregator's upstreams write their own tool hints; trusting them would let any one of
  // them self-declare its writes as auto-approvable.
  assert.equal(vars.MCP_PORTAL_TRUST_ANNOTATIONS, "false");

  for (const [url, pattern] of [
    ["http://mcp.example.com/", /https/i],
    ["https://user:pass@mcp.example.com/", /credentials/i],
    ["mcp.example.com", /absolute URL/i],
  ] as const) {
    const bad = structuredClone(validConfig);
    bad.mcpPortal.url = url;
    assert.throws(() => validateConfig(bad), pattern, `should reject ${url}`);
  }
});

test("omits each connector when it is disabled", async () => {
  const config = structuredClone(validConfig);
  config.mcp = { enabled: false };
  config.mcpPortal = { enabled: false };
  delete config.workers.mcpGatekeeper;
  delete config.workers.mcpPortalGatekeeper;

  const generated = generateConfigs(config, await baseConfigs());

  assert.equal(generated.mcpGatekeeper, undefined);
  assert.equal(generated.mcpPortalGatekeeper, undefined);
  for (const binding of ["GATEKEEPER_MCP", "GATEKEEPER_MCP_PORTAL"]) {
    assert.equal(generated.router.services?.some((s) => s.binding === binding), false);
    assert.equal(generated.workshop.services?.some((s) => s.binding === binding), false);
  }
});

// The submodule packages this workspace includes declare their toolchain as `catalog:`, resolved
// by the workspace that owns the member — so pnpm-workspace.yaml here carries a copy. A copy
// drifts, and the drift is silent: two capnweb copies in one tree make a stub minted by one
// unserialisable by the other.
//
// Reads only the flat `catalog:` block of each file rather than pulling in a YAML parser for one
// assertion. Anything it cannot parse fails the test rather than being skipped.
function readCatalog(text: string): Record<string, string> | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === "catalog:");
  if (start === -1) return null;
  const entries: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith("  ")) break;
    const match = line.match(/^ {2}'?([^':]+)'?:\s*(\S+)\s*$/);
    if (!match) throw new Error(`Unparsed catalog line: ${line}`);
    entries[match[1]] = match[2];
  }
  return entries;
}

test("keeps the workspace catalog in step with the submodule's", async () => {
  const read = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const ours = readCatalog(await read("../pnpm-workspace.yaml"));
  const upstream = readCatalog(await read("../cloudflare-os/pnpm-workspace.yaml"));
  assert.ok(ours, "this workspace must declare a catalog");
  assert.ok(upstream, "the submodule must declare a catalog");

  for (const [name, version] of Object.entries(ours)) {
    assert.equal(version, upstream[name],
      `catalog "${name}" is ${version} here but ${upstream[name]} upstream; the submodule bump ` +
      `moved it, so update pnpm-workspace.yaml to match`);
  }

  // And every `catalog:` spec the included submodule packages declare must be covered, which is
  // the install-time failure this guard exists to pre-empt.
  for (const pkg of ["workshop-shared", "error-reporting"]) {
    const manifest = JSON.parse(await read(`../cloudflare-os/packages/${pkg}/package.json`));
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
        if (typeof spec === "string" && spec.startsWith("catalog:")) {
          assert.ok(name in ours, `${pkg} needs catalog entry "${name}", which this workspace omits`);
        }
      }
    }
  }
});
