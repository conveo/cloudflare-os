<p align="center">
  <img src="docs/assets/cloudflareOS.svg" alt="Cloudflare OS" width="480">
</p>

<h1 align="center">Conveo Studio</h1>

<p align="center">
  A pinned Cloudflare OS release on <code>studio.conveo.ai</code>, signed in with Okta through Cloudflare Access,
  and wired into <a href="https://github.com/conveo/agentgateway">agentgateway</a> for company tools and models.
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F6821F?logo=cloudflare&logoColor=white"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 24" src="https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white"></a>
  <a href="https://pnpm.io/"><img alt="pnpm 11" src="https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white"></a>
  <a href="https://github.com/cloudflare/cloudflare-os"><img alt="Cloudflare OS upstream" src="https://img.shields.io/badge/upstream-Cloudflare_OS-24292F?logo=github"></a>
</p>

> [!IMPORTANT]
> Cloudflare OS is early-access software. Pin upstream releases, review changes, and verify the trust boundary before every production upgrade.

## Four steps

1. Create the Cloudflare Access application for `studio.conveo.ai` in the Zero Trust dashboard and copy its AUD tag.
2. Fill in the two remaining placeholders in `deployment.jsonc`: the Cloudflare account ID and that AUD.
3. Install the dependencies, run `pnpm exec wrangler login`, then `pnpm check` and `pnpm deploy`.
4. Open `/admin` and set branding and connector policy; neither needs a redeploy.

[Deploy](#deploy) and [Customization](#customization) expand each step. [agentgateway](docs/agentgateway.md) covers the integration and is the part specific to Conveo.

## Overview

This repository adds deployment controls around a pinned [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) release without modifying the upstream source.

| Control | What Conveo owns |
| --- | --- |
| Branding | Site name, logo, and accent color, changed in [`/admin`](docs/customization.md#branding) without a deploy |
| Identity | [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) over Okta; the application and its policy are [created in the Zero Trust dashboard](docs/customization.md#cloudflare-access) |
| Routing | `studio.conveo.ai`, a [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) on the Cloudflare-managed `conveo.ai` zone |
| Data | Existing KV/R2 resources or [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) |
| Integrations | Company tools through [agentgateway](docs/agentgateway.md), per user, plus wrapper-owned Gatekeepers |
| AI | Models through [agentgateway's Anthropic route](docs/agentgateway.md#models) rather than a Cloudflare-funded catalog |
| Operations | [Structured logs, traces, explicit error reports](docs/observability.md), validation, deployment order, and upgrades |

### Architecture

Six Workers. Only the router is public:

```
                        Cloudflare Access (Okta)
                                  │
studio.conveo.ai ────────────────► router
                                  ├── /api/*              → workshop  (private)
                                  │                            ├── context
                                  │                            ├── custom gatekeeper
                                  │                            ├── mcp gatekeeper
                                  │                            └── error reporter
                                  ├── /gatekeeper/mcp/*   → mcp gatekeeper (OAuth callback)
                                  └── /*                  → frontend assets

mcp gatekeeper ──► mcp.ops.conveo.ai/<service> ──► agentgateway ──► Linear, Notion, Grafana, …
                        (the user's own Okta identity, their own vendor token)
```

This is upstream's `router` topology rather than the starter's default of a publicly routed Workshop. It is what makes OAuth-capable Gatekeepers possible: their browser callbacks need a public URL, and the router gives every Gatekeeper one under a single hostname and a single Access application. Adding the GitHub, Google, or Slack Gatekeeper later is one service binding, not another hostname.

The deploy command derives temporary Wrangler files from upstream base configs, builds the frontend in Cloudflare Access mode, deploys every private Worker before the router that binds them, and removes generated files even on failure. Secrets never enter tracked configuration.

## Deploy

### 1. Prepare the workspace

Install [Node.js 24](https://nodejs.org/), [pnpm 11](https://pnpm.io/installation), and authenticate [Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/#login):

```sh
git submodule update --init
pnpm install
pnpm --dir cloudflare-os install
pnpm exec wrangler login
```

Your account needs [Workers](https://developers.cloudflare.com/workers/), [KV](https://developers.cloudflare.com/kv/), [R2](https://developers.cloudflare.com/r2/), [Browser Rendering](https://developers.cloudflare.com/browser-rendering/), and [Dynamic Worker Loaders](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/). AI products are optional.

### 2. Configure sign-in

Cloudflare OS supports several sign-in methods. This deployment uses [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) mode, which verifies identity before a request reaches the Worker. See [Sign-in methods](docs/customization.md#sign-in-methods) for the alternatives and what switching involves.

The Access application is created **by hand**, in the Cloudflare Zero Trust dashboard under **Access → Applications**: a self-hosted application for `studio.conveo.ai`, session duration 24 hours, with an Allow policy listing the operators who will run this first deploy. See [Cloudflare Access](docs/customization.md#cloudflare-access) for the full field list.

Nothing in this repository creates it — Wrangler owns routing and has no `access` command. Without it the Workshop refuses every `/api` call and the router still serves the frontend to anyone, so treat it as a prerequisite rather than a follow-up.

Put that AUD in `access.audience` in [`deployment.jsonc`](deployment.jsonc), and the team origin from Zero Trust settings in `access.issuer`. Every control in that file is annotated in place.

Wrangler creates DNS and TLS for the custom domain at deploy time, so do not create that record by hand. For an evaluation without a zone, switch the annotated route to `{ "workersDev": true }`, which also means turning `mcp.enabled` off.

### 3. Land the agentgateway change first

The MCP connector registers `https://studio.conveo.ai/gatekeeper/mcp/oauth` with Keycloak the first time anyone connects an endpoint, and that host has to be trusted before then. Merge the `repairHosts` addition in [agentgateway](https://github.com/conveo/agentgateway)'s `chart/values.yaml` to `main` and let ArgoCD sync it. See [agentgateway](docs/agentgateway.md#rollout-order).

### 4. Validate and deploy

```sh
pnpm check
pnpm deploy
```

With resource values left as `null`, Wrangler creates the three KV namespaces and R2 bucket automatically and reconnects them on later deploys. Set explicit IDs or a bucket name when the deployment must reuse existing resources.

The platform AI catalog is off; models come from [agentgateway](docs/agentgateway.md#models). The application deploys without an AI Gateway or token.

Backend error reporting is enabled without a vendor account. Explicit upstream issue events become structured logs in the private Error Reporter Worker; see [Observability and error reporting](docs/observability.md).

### 5. Verify the deployment

- Open `studio.conveo.ai` in a private window and confirm Access refuses an unauthenticated request, then signs in with the expected Okta identity.
- Confirm the Access application actually covers this exact hostname. Because it is created by hand, a typo there does not error — it leaves the router unauthenticated. An unauthenticated request reaching the app instead of the Access login page is the symptom.
- Confirm no other Worker answers on a public hostname — the router is the only route.
- Open `/admin`, confirm the email is an administrator, and set Context, Custom, and MCP connectors to disabled, optional, or enabled deliberately.
- Connect `https://mcp.ops.conveo.ai/<service>` through the MCP connector, complete the Okta sign-in, and confirm a tool call succeeds and appears in Loki under your own `jwt.email`.
- Enable the Custom Gatekeeper, ask for deployment information, and confirm its read appears as an observation.
- Open the Error Reporter Worker's [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and verify its structured `error_report` query surface.
- Review logs for the router, Workshop, Context, Gatekeeper, and Error Reporter Workers.

## Customization

| Customize | Best place | Deploy required |
| --- | --- | --- |
| Site name, logo, color, announcements, instructions, connectors | `/admin` | No |
| Sign-in, routes, AI, storage, observability, Worker identities | [`deployment.jsonc`](deployment.jsonc) | Yes |
| Who may sign in at all | [Zero Trust dashboard](docs/customization.md#cloudflare-access) | No |
| Company tools and models | [agentgateway](docs/agentgateway.md) | Sometimes |
| Logs, traces, error destinations, browser reporting | [Observability guide](docs/observability.md) | Sometimes |
| Organization APIs and capabilities | [`packages/custom-gatekeeper`](packages/custom-gatekeeper/README.md) | Yes |
| Product behavior unavailable through Worker boundaries | Pinned upstream fork/commit | Yes |

The complete control reference and recipes live in [Customization](docs/customization.md). The upstream [`write-gatekeeper` skill](https://github.com/cloudflare/cloudflare-os/blob/main/.agents/skills/write-gatekeeper/SKILL.md) covers richer integrations.

## Operations and upgrades

- Stream production events with [`wrangler tail`](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/).
- Triage explicit failures and choose export destinations with the [observability guide](docs/observability.md).
- Roll a Worker back from its dashboard deployment history or with [`wrangler rollback`](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
- Follow the [upgrade checklist](docs/customization.md#upgrade) before changing the pinned submodule.
- Review the upstream Cloudflare OS documentation and release history before adopting behavior changes.
