import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// One deployment per checkout; use separate worktrees for concurrent deploys.
const generatedName = "wrangler.prod.jsonc";
const generatedPaths = {
  router: join(root, "cloudflare-os/packages/router", generatedName),
  workshop: join(root, "cloudflare-os/packages/workshop-backend", generatedName),
  context: join(root, "cloudflare-os/packages/gatekeeper-context", generatedName),
  customGatekeeper: join(root, "packages/custom-gatekeeper", generatedName),
  mcpGatekeeper: join(root, "cloudflare-os/packages/gatekeeper-mcp", generatedName),
  mcpPortalGatekeeper: join(root, "cloudflare-os/packages/gatekeeper-mcp-portal", generatedName),
  errorReporter: join(root, "packages/error-reporter", generatedName),
};
const defaultContextArtifactsNamespace = "gatekeeper-context-collections";

const requiredPaths = [
  "accountId",
  "workers.router.name",
  "workers.workshop.name",
  "workers.context.name",
  "workers.customGatekeeper.name",
  "mcp.enabled",
  "mcpPortal.enabled",
  "access.issuer",
  "access.audience",
  "access.admins",
  "aiGateway.enabled",
  "errorReporting.enabled",
  "context.sharingDomain",
  "customGatekeeper.name",
  "customGatekeeper.message",
  "observability.enabled",
  "observability.headSamplingRate",
  "observability.logs.invocationLogs",
  "observability.traces.enabled",
  "observability.traces.headSamplingRate",
];

const aiGatewayPaths = [
  "aiGateway.name",
  "aiGateway.accountId",
  "aiGateway.providers",
  "aiGateway.workersAi.mode",
];

const errorReportingPaths = [
  "workers.errorReporter.name",
  "errorReporting.environment",
];

const mcpPaths = ["workers.mcpGatekeeper.name"];

const mcpPortalPaths = ["workers.mcpPortalGatekeeper.name", "mcpPortal.url"];

const resourcePaths = [
  "context.kvNamespaceId",
  "resources.blueprintsKvNamespaceId",
  "resources.avatarsKvNamespaceId",
  "resources.blueprintContentBucket",
];

function valueAt(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

export function validateConfig(config) {
  const activePaths = [
    ...requiredPaths,
    ...(config.aiGateway?.enabled ? aiGatewayPaths : []),
    ...(config.errorReporting?.enabled ? errorReportingPaths : []),
    ...(config.mcp?.enabled ? mcpPaths : []),
    ...(config.mcpPortal?.enabled ? mcpPortalPaths : []),
  ];
  for (const path of activePaths) {
    const value = valueAt(config, path);
    if (value === undefined || value === null || value === "" || Array.isArray(value) && !value.length) {
      throw new Error(`Missing required deployment value: ${path}`);
    }
  }

  for (const path of resourcePaths) {
    const value = valueAt(config, path);
    if (value === undefined || value !== null && (typeof value !== "string" || !value)) {
      throw new Error(`Deployment resource must be null or a non-empty string: ${path}`);
    }
  }

  let activeConfig = !config.aiGateway.enabled
    ? { ...config, aiGateway: { enabled: false } }
    : config.aiGateway.workersAi.mode === "direct"
      ? { ...config, aiGateway: {
        ...config.aiGateway,
        workersAi: { mode: "direct" },
      } }
      : config;
  if (!config.errorReporting.enabled) {
    activeConfig = {
      ...activeConfig,
      workers: { ...activeConfig.workers, errorReporter: undefined },
      errorReporting: { enabled: false },
    };
  }
  if (!config.mcp.enabled) {
    activeConfig = {
      ...activeConfig,
      workers: { ...activeConfig.workers, mcpGatekeeper: undefined },
    };
  }
  if (!config.mcpPortal.enabled) {
    activeConfig = {
      ...activeConfig,
      workers: { ...activeConfig.workers, mcpPortalGatekeeper: undefined },
      mcpPortal: { enabled: false },
    };
  }
  const placeholder = JSON.stringify(activeConfig).match(/<[^>]+>/)?.[0];
  if (placeholder) throw new Error(`Replace deployment placeholder ${placeholder}.`);

  const stringPaths = activePaths.filter((path) => ![
    "access.admins",
    "aiGateway.enabled",
    "aiGateway.providers",
    "errorReporting.enabled",
    "mcp.enabled",
    "mcpPortal.enabled",
    "observability.enabled",
    "observability.headSamplingRate",
    "observability.logs.invocationLogs",
    "observability.traces.enabled",
    "observability.traces.headSamplingRate",
  ].includes(path));
  for (const path of stringPaths) {
    if (typeof valueAt(config, path) !== "string") {
      throw new Error(`Deployment value must be a string: ${path}`);
    }
  }

  if (!/^[a-f\d]{32}$/i.test(config.accountId) ||
      config.aiGateway.enabled && !/^[a-f\d]{32}$/i.test(config.aiGateway.accountId)) {
    throw new Error("Cloudflare account IDs must be 32 hexadecimal characters.");
  }
  const inactiveWorkers = {
    errorReporter: !config.errorReporting.enabled,
    mcpGatekeeper: !config.mcp.enabled,
    mcpPortalGatekeeper: !config.mcpPortal.enabled,
  };
  const workerNames = Object.entries(config.workers)
    .filter(([key]) => !inactiveWorkers[key])
    .map(([, worker]) => worker.name);
  if (new Set(workerNames).size !== workerNames.length) {
    throw new Error("Every deployed Worker name must be unique.");
  }
  if (!workerNames.every((name) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))) {
    throw new Error("Worker names must use lowercase letters, numbers, and hyphens.");
  }

  // The router owns the only public route; every other Worker is reached over a service
  // binding, so a route on one of them would be a way around Access.
  const routed = Object.entries(config.workers)
    .filter(([key, worker]) => key !== "router" && worker?.route);
  if (routed.length) {
    throw new Error(`Only the router may have a route: remove workers.${routed[0][0]}.route.`);
  }

  const route = config.workers.router.route;
  if (!route || Boolean(route.workersDev) === Boolean(route.customDomain)) {
    throw new Error("Set exactly one router route: workersDev or customDomain.");
  }
  if (route.workersDev !== undefined && route.workersDev !== true) {
    throw new Error("Router workersDev must be boolean true when selected.");
  }
  if (route.customDomain !== undefined && typeof route.customDomain !== "string") {
    throw new Error("Router customDomain must be a string.");
  }
  const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (route.customDomain && !hostnamePattern.test(route.customDomain)) {
    throw new Error("Router customDomain must be a lowercase hostname.");
  }

  if (typeof config.mcp.enabled !== "boolean") {
    throw new Error("MCP Gatekeeper enabled must be a boolean.");
  }
  // The connector registers https://<host>/gatekeeper/mcp/oauth as its OAuth redirect_uri
  // before the Worker is ever reached, so the hostname has to be known at config time. A
  // workers.dev address is only knowable after the first deploy.
  if (config.mcp.enabled && !route.customDomain) {
    throw new Error("The MCP Gatekeeper requires workers.router.route.customDomain.");
  }

  if (typeof config.mcpPortal.enabled !== "boolean") {
    throw new Error("MCP portal enabled must be a boolean.");
  }
  if (config.mcpPortal.enabled) {
    // Same reason as the MCP Gatekeeper: the OAuth redirect_uri is derived from the router
    // hostname and registered before the Worker is first reached.
    if (!route.customDomain) {
      throw new Error("The MCP portal requires workers.router.route.customDomain.");
    }
    // The portal URL becomes every user's OAuth destination, so a typo here sends the whole
    // deployment's sign-in flow at whatever host it names. Refuse anything but a plain HTTPS
    // URL, and refuse embedded credentials outright (the connector would copy them into
    // account state). Upstream hides a bad URL rather than failing loudly, so catch it here.
    let portal;
    try {
      portal = new URL(config.mcpPortal.url);
    } catch {
      throw new Error("MCP portal url must be an absolute URL.");
    }
    if (portal.protocol !== "https:") {
      throw new Error("MCP portal url must be https.");
    }
    if (portal.username || portal.password) {
      throw new Error("MCP portal url must not embed credentials.");
    }
    if (typeof config.mcpPortal.name !== "string" || !config.mcpPortal.name.trim()) {
      throw new Error("MCP portal name must be a non-empty string.");
    }
  }

  const issuer = new URL(config.access.issuer);
  if (issuer.protocol !== "https:" ||
      issuer.origin !== config.access.issuer.replace(/\/$/, "")) {
    throw new Error("Cloudflare Access issuer must be an HTTPS origin only.");
  }
  if (!config.access.audience.trim() || config.access.audience !== config.access.audience.trim()) {
    throw new Error("Cloudflare Access audience must not be blank or padded with whitespace.");
  }
  if (!Array.isArray(config.access.admins) ||
      !config.access.admins.every((email) =>
        typeof email === "string" && /^[^@\s]+@[^@\s]+$/.test(email))) {
    throw new Error("Every Access administrator must be an email address.");
  }

  if (typeof config.aiGateway.enabled !== "boolean") {
    throw new Error("AI Gateway enabled must be a boolean.");
  }
  if (config.aiGateway.enabled) {
    const providers = new Set(["anthropic", "openai", "google", "cloudflare"]);
    if (!Array.isArray(config.aiGateway.providers) ||
        !config.aiGateway.providers.every((provider) => providers.has(provider))) {
      throw new Error("AI Gateway providers must be anthropic, openai, google, or cloudflare.");
    }
    const workersAi = config.aiGateway.workersAi;
    if (!(["direct", "gateway"].includes(workersAi.mode))) {
      throw new Error("Workers AI mode must be direct or gateway.");
    }
    if (workersAi.mode === "gateway" &&
        (typeof workersAi.gateway !== "string" || !workersAi.gateway.trim())) {
      throw new Error("Workers AI gateway mode requires a gateway name string.");
    }
  }

  if (typeof config.errorReporting.enabled !== "boolean") {
    throw new Error("Error reporting enabled must be a boolean.");
  }
  const release = config.errorReporting.release;
  if (release !== null &&
      (typeof release !== "string" || !release.trim() || release !== release.trim())) {
    throw new Error("Error reporting release must be null or a non-padded string.");
  }

  const artifactsConfig = config.context.artifacts;
  if (artifactsConfig !== undefined &&
      (artifactsConfig === null || typeof artifactsConfig !== "object" ||
       Array.isArray(artifactsConfig))) {
    throw new Error("Context Artifacts configuration must be an object when present.");
  }
  const artifactsEnabled = artifactsConfig?.enabled;
  if (artifactsEnabled !== undefined && typeof artifactsEnabled !== "boolean") {
    throw new Error("Context Artifacts enabled must be a boolean.");
  }
  const artifactsNamespace = artifactsConfig?.namespace;
  if (artifactsNamespace !== undefined &&
      (typeof artifactsNamespace !== "string" ||
       !/^[a-z\d][a-z\d._-]*$/i.test(artifactsNamespace))) {
    throw new Error("Context Artifacts namespace must be omitted or start with a letter or number and use only letters, numbers, dots, underscores, and hyphens.");
  }

  const sampling = config.observability.headSamplingRate;
  if (typeof config.observability.enabled !== "boolean") {
    throw new Error("Observability enabled must be a boolean.");
  }
  if (typeof sampling !== "number" || sampling < 0 || sampling > 1) {
    throw new Error("Observability headSamplingRate must be between 0 and 1.");
  }
  if (typeof config.observability.logs.invocationLogs !== "boolean" ||
      typeof config.observability.traces.enabled !== "boolean") {
    throw new Error("Observability log and trace controls must be booleans.");
  }
  const traceSampling = config.observability.traces.headSamplingRate;
  if (typeof traceSampling !== "number" || traceSampling < 0 || traceSampling > 1) {
    throw new Error("Observability trace sampling must be between 0 and 1.");
  }
  return config;
}

function routeConfig(route) {
  return route.workersDev
    ? { workers_dev: true, routes: undefined }
    : { workers_dev: false, routes: [{ pattern: route.customDomain, custom_domain: true }] };
}

function setCommon(config, deployment, name, route = { workersDev: false }) {
  config.account_id = deployment.accountId;
  config.name = name;
  config.workers_dev = route.workersDev;
  delete config.routes;
  if (route.customDomain) Object.assign(config, routeConfig(route));
  config.observability = {
    ...config.observability,
    enabled: deployment.observability.enabled,
    head_sampling_rate: deployment.observability.headSamplingRate,
    logs: {
      ...config.observability?.logs,
      invocation_logs: deployment.observability.logs.invocationLogs,
    },
    traces: {
      ...config.observability?.traces,
      enabled: deployment.observability.traces.enabled,
      head_sampling_rate: deployment.observability.traces.headSamplingRate,
    },
  };
}

// Public paths the router must handle itself rather than serve from static assets. Upstream's
// base config already lists these; repeating them here keeps the generated config explicit and
// lets a base-config change show up as a diff during review.
const ROUTER_WORKER_FIRST = [
  "/api",
  "/api/*",
  "/blueprint-screenshot",
  "/blueprint-screenshot/*",
  "/gatekeeper/*",
];

export function generateConfigs(config, bases) {
  validateConfig(config);
  const router = structuredClone(bases.router);
  const workshop = structuredClone(bases.workshop);
  const context = structuredClone(bases.context);
  const customGatekeeper = structuredClone(bases.customGatekeeper);
  const mcpGatekeeper = config.mcp.enabled
    ? structuredClone(bases.mcpGatekeeper)
    : undefined;
  const mcpPortalGatekeeper = config.mcpPortal.enabled
    ? structuredClone(bases.mcpPortalGatekeeper)
    : undefined;
  const errorReporter = config.errorReporting.enabled
    ? structuredClone(bases.errorReporter)
    : undefined;

  // The Workshop is private: no route, no assets. Both belong to the router now.
  setCommon(workshop, config, config.workers.workshop.name);
  delete workshop.assets;
  workshop.vars = {
    ADMINS: config.access.admins,
    CF_ACCESS_ISS: config.access.issuer.replace(/\/$/, ""),
    CF_ACCESS_AUD: config.access.audience,
  };
  if (config.aiGateway.enabled) {
    Object.assign(workshop.vars, {
      CF_AI_GATEWAY: config.aiGateway.name,
      CF_AI_GATEWAY_ACCOUNT_ID: config.aiGateway.accountId,
      CF_AI_GATEWAY_PROVIDERS: config.aiGateway.providers.join(","),
    });
    workshop.secrets = {
      ...workshop.secrets,
      required: [...new Set([
        ...(workshop.secrets?.required ?? []),
        "CF_AI_GATEWAY_API_TOKEN",
      ])],
    };
    if (config.aiGateway.workersAi.mode === "gateway") {
      workshop.vars.CF_AI_GATEWAY_WAI = config.aiGateway.workersAi.gateway;
    } else {
      workshop.vars.CF_AI_GATEWAY_WAI_DIRECT = "true";
    }
  }
  workshop.ai = { binding: "WORKERS_AI" };
  workshop.services = [
    ...(config.errorReporting.enabled ? [{
      binding: "ERROR_REPORTER",
      service: config.workers.errorReporter.name,
      entrypoint: "ErrorReporter",
      props: {
        service: config.workers.workshop.name,
        environment: config.errorReporting.environment,
        ...(config.errorReporting.release ? { release: config.errorReporting.release } : {}),
      },
    }] : []),
    {
      binding: "GATEKEEPER_CONTEXT",
      service: config.workers.context.name,
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: config.context.sharingDomain },
    },
    {
      binding: "GATEKEEPER_CUSTOM",
      service: config.workers.customGatekeeper.name,
      entrypoint: "GatekeeperVendor",
    },
    // The backend discovers Gatekeepers by scanning GATEKEEPER_* bindings, so binding the MCP
    // connector here is the whole of installing it.
    ...(config.mcp.enabled ? [{
      binding: "GATEKEEPER_MCP",
      service: config.workers.mcpGatekeeper.name,
      entrypoint: "GatekeeperVendor",
    }] : []),
    ...(config.mcpPortal.enabled ? [{
      binding: "GATEKEEPER_MCP_PORTAL",
      service: config.workers.mcpPortalGatekeeper.name,
      entrypoint: "GatekeeperVendor",
    }] : []),
  ];
  workshop.kv_namespaces = [
    { binding: "BLUEPRINTS", ...(config.resources.blueprintsKvNamespaceId
      ? { id: config.resources.blueprintsKvNamespaceId } : {}) },
    { binding: "AVATARS", ...(config.resources.avatarsKvNamespaceId
      ? { id: config.resources.avatarsKvNamespaceId } : {}) },
  ];
  workshop.r2_buckets = [
    { binding: "BLUEPRINT_CONTENT", ...(config.resources.blueprintContentBucket
      ? { bucket_name: config.resources.blueprintContentBucket } : {}) },
  ];
  setCommon(context, config, config.workers.context.name);
  context.kv_namespaces = [
    { binding: "CONTEXT_COLLECTIONS", ...(config.context.kvNamespaceId
      ? { id: config.context.kvNamespaceId } : {}) },
  ];
  if (config.context.artifacts?.enabled ?? false) {
    context.artifacts = [{
      binding: "ARTIFACTS",
      namespace: config.context.artifacts?.namespace ?? defaultContextArtifactsNamespace,
    }];
  } else {
    delete context.artifacts;
  }

  setCommon(customGatekeeper, config, config.workers.customGatekeeper.name);
  customGatekeeper.vars = {
    CUSTOM_NAME: config.customGatekeeper.name,
    CUSTOM_MESSAGE: config.customGatekeeper.message,
  };

  if (mcpGatekeeper) {
    setCommon(mcpGatekeeper, config, config.workers.mcpGatekeeper.name);
    mcpGatekeeper.vars = {
      ...mcpGatekeeper.vars,
      // Where this Worker is publicly reachable. The connector derives both its own path
      // prefix and the OAuth redirect_uri (<BASE_URL>/oauth) from it, so it must match the
      // router's /gatekeeper/<binding-suffix> prefix exactly.
      BASE_URL: `https://${config.workers.router.route.customDomain}/gatekeeper/mcp`,
      // Keep upstream's explicit "false": http:// and private-network endpoints stay refused.
      MCP_ALLOW_INSECURE: "false",
    };
  }

  if (mcpPortalGatekeeper) {
    setCommon(mcpPortalGatekeeper, config, config.workers.mcpPortalGatekeeper.name);
    mcpPortalGatekeeper.vars = {
      ...mcpPortalGatekeeper.vars,
      BASE_URL: `https://${config.workers.router.route.customDomain}/gatekeeper/mcp-portal`,
      MCP_ALLOW_INSECURE: "false",
      // The one endpoint every user reaches company MCP servers through. Unlike the
      // user-supplied connector, nobody types this.
      MCP_PORTAL_URL: config.mcpPortal.url,
      MCP_PORTAL_NAME: config.mcpPortal.name,
      // OAuth is upstream's default; stated so the deployment's auth model is explicit
      // rather than inherited. Changing it is a trust-boundary change.
      MCP_PORTAL_AUTH: "oauth",
      // Left off deliberately: the portal fronts servers whose own destructiveHint /
      // idempotentHint we do not review, and trusting them would let any one upstream
      // self-declare its writes as auto-approvable.
      MCP_PORTAL_TRUST_ANNOTATIONS: "false",
    };
  }

  if (errorReporter) {
    setCommon(errorReporter, config, config.workers.errorReporter.name);
  }

  // The router is the public origin: it serves the frontend and fans every other path out to
  // the private Workers over service bindings.
  setCommon(router, config, config.workers.router.name, config.workers.router.route);
  router.services = [
    { binding: "WORKSHOP_BACKEND", service: config.workers.workshop.name },
    // No entrypoint: the router forwards raw HTTP to the Gatekeeper's default fetch handler,
    // which is where its OAuth callback lives.
    ...(config.mcp.enabled ? [{
      binding: "GATEKEEPER_MCP",
      service: config.workers.mcpGatekeeper.name,
    }] : []),
    // The binding suffix is what the router turns into a path: GATEKEEPER_MCP_PORTAL ->
    // /gatekeeper/mcp-portal, which must equal the connector's BASE_URL below.
    ...(config.mcpPortal.enabled ? [{
      binding: "GATEKEEPER_MCP_PORTAL",
      service: config.workers.mcpPortalGatekeeper.name,
    }] : []),
  ];
  router.assets = {
    directory: "../workshop-frontend/dist",
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: ROUTER_WORKER_FIRST,
  };

  return {
    workshop,
    context,
    customGatekeeper,
    ...(mcpGatekeeper && { mcpGatekeeper }),
    ...(mcpPortalGatekeeper && { mcpPortalGatekeeper }),
    ...(errorReporter && { errorReporter }),
    // Last: every binding it names must already exist.
    router,
  };
}

async function readJsonc(path) {
  const errors = [];
  const result = parse(await readFile(path, "utf8"), errors);
  if (errors.length) {
    const where = relative(root, path) || path;
    throw new Error(`${where}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  return result;
}

// Every validateConfig message names a config path, so say which file those paths live in.
async function readDeployment(path) {
  const config = await readJsonc(path);
  try {
    return validateConfig(config);
  } catch (error) {
    throw new Error(`${relative(root, path)}: ${error.message}`);
  }
}

function run(args, cwd = root, env = process.env) {
  const result = spawnSync("pnpm", args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const where = relative(root, cwd) || ".";
    throw new Error(`${where}: pnpm ${args.join(" ")} failed. Its output is above.`);
  }
}

function requireSubmodule() {
  if (!existsSync(join(root, "cloudflare-os/package.json"))) {
    throw new Error("CloudflareOS submodule is not initialized. Run git submodule update --init.");
  }
}

// Upstream builds through Vite+ (`vp`) rather than package scripts, so several packages no
// longer expose a `build` script at all. What each one still needs before `wrangler deploy`
// is exactly what its own `deploy` script does upstream — mirrored here rather than guessed:
//
//   gatekeeper-context     vp build:app          (its Wrangler hook only runs capnweb-validate)
//   gatekeeper-mcp         vp build:configurator (same)
//   gatekeeper-mcp-portal  vp build:configurator (same)
//   workshop-frontend      vp build              (produces the dist the router serves)
//   workshop-backend       nothing — its Wrangler hook runs `pnpm run build:worker`
//   router                 nothing — no hook, and it only needs the frontend's dist
//
// --no-cache matches upstream's own deploy scripts: a replayed artifact is a poor trade for
// the minutes it saves on a rare, production-bound run. --fail-if-no-match makes a filter
// that stops matching a loud failure rather than a silent no-op, which is the failure mode
// that matters when upstream renames a package during an upgrade.
function vp(filter, task, env = process.env) {
  run(["exec", "vp", "run", "--no-cache", "--fail-if-no-match", "-F", filter, task],
    join(root, "cloudflare-os"), env);
}

function build(config) {
  vp("@gadgets/gatekeeper-context", "build:app");
  run(["--dir", "packages/custom-gatekeeper", "run", "build"]);
  if (config.mcp.enabled) {
    vp("@gadgets/mcp-gatekeeper", "build:configurator");
  }
  if (config.mcpPortal.enabled) {
    vp("@gadgets/mcp-portal-gatekeeper", "build:configurator");
  }
  if (config.errorReporting.enabled) {
    run(["--dir", "packages/error-reporter", "run", "build"]);
  }
  // The frontend task declares `env: ['VITE_*']`, so this flag is part of vp's cache
  // fingerprint rather than invisible to it — a bundle built without Access mode can no
  // longer be replayed into an Access-mode deployment.
  vp("@gadgets/workshop-frontend", "build", { ...process.env, VITE_CF_ACCESS_MODE: "true" });
}

async function main() {
  requireSubmodule();
  const config = await readDeployment(join(root, "deployment.jsonc"));
  const generated = generateConfigs(config, {
    router: await readJsonc(join(root, "cloudflare-os/packages/router/wrangler.jsonc")),
    workshop: await readJsonc(join(root, "cloudflare-os/packages/workshop-backend/wrangler.jsonc")),
    context: await readJsonc(join(root, "cloudflare-os/packages/gatekeeper-context/wrangler.jsonc")),
    customGatekeeper: await readJsonc(join(root, "packages/custom-gatekeeper/wrangler.jsonc")),
    mcpGatekeeper: await readJsonc(join(root, "cloudflare-os/packages/gatekeeper-mcp/wrangler.jsonc")),
    mcpPortalGatekeeper: await readJsonc(
      join(root, "cloudflare-os/packages/gatekeeper-mcp-portal/wrangler.jsonc")),
    errorReporter: await readJsonc(join(root, "packages/error-reporter/wrangler.jsonc")),
  });

  try {
    for (const [name, generatedConfig] of Object.entries(generated)) {
      await writeFile(generatedPaths[name], JSON.stringify(generatedConfig, null, 2) + "\n");
    }
    const check = process.argv.includes("--check");
    if (check) run(["test"]);
    build(config);
    const deployArgs = check ? ["--dry-run"] : [];
    if (config.errorReporting.enabled) {
      run(["exec", "wrangler", "deploy", "--config", generatedName, ...deployArgs],
        join(root, "packages/error-reporter"));
    }
    run(["exec", "wrangler", "deploy", "--config", generatedName, ...deployArgs],
      join(root, "cloudflare-os/packages/gatekeeper-context"));
    run(["exec", "wrangler", "deploy", "--config", generatedName, ...deployArgs],
      join(root, "packages/custom-gatekeeper"));
    if (config.mcp.enabled) {
      run(["exec", "wrangler", "deploy", "--config", generatedName, ...deployArgs],
        join(root, "cloudflare-os/packages/gatekeeper-mcp"));
    }
    if (config.mcpPortal.enabled) {
      run(["exec", "wrangler", "deploy", "--config", generatedName, ...deployArgs],
        join(root, "cloudflare-os/packages/gatekeeper-mcp-portal"));
    }
    run(["exec", "wrangler", "deploy", "--config", generatedName, ...deployArgs],
      join(root, "cloudflare-os/packages/workshop-backend"));
    // Last: it is the only Worker with a public route, and it binds every one above.
    run(["exec", "wrangler", "deploy", "--config", generatedName, ...deployArgs],
      join(root, "cloudflare-os/packages/router"));
  } finally {
    await Promise.all(Object.values(generatedPaths).map((path) => rm(path, { force: true })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    // One line, no stack: every failure here is a config or subprocess problem, not a script bug.
    console.error(`\nDeploy failed. ${error.message}`);
    process.exitCode = 1;
  }
}
