# agentgateway integration

Conveo already runs [agentgateway](https://github.com/conveo/agentgateway), an identity-aware
control plane in front of every MCP server and LLM the company uses. This deployment does not
duplicate that. It plugs into it.

| Cloudflare OS needs | agentgateway already provides | How they connect |
| --- | --- | --- |
| Company tools as agent capabilities | Every MCP server at `mcp.ops.conveo.ai/<service>`, per-user OAuth | The **MCP Gatekeeper** ([below](#mcp-gatekeeper)) |
| A model to run agents on | `/anthropic`, injecting the Anthropic key server-side | A **second `/anthropic` route** gated by a deployment key ([below](#models)) |
| An identity for each user | Okta, via Keycloak | Cloudflare Access also federates Okta, so both sides see the same person |

## MCP Gatekeeper

`mcp.enabled` in [`deployment.jsonc`](../deployment.jsonc) deploys upstream's generic
[MCP connector](https://github.com/cloudflare/cloudflare-os/blob/main/packages/gatekeeper-mcp/README.md)
as the `conveo-studio-mcp` Worker and binds it to the Workshop as `GATEKEEPER_MCP`.

A user connects an endpoint once, from the connectors list:

1. They paste an agentgateway endpoint — `https://mcp.ops.conveo.ai/linear`, `/notion`,
   `/grafana`, and so on. The aggregate `/` route works too.
2. The connector runs OAuth discovery against it, registers itself with Keycloak via dynamic
   client registration, and sends the user through Okta.
3. Every tool the endpoint offers becomes a typed method on a session that Gadgets and agents
   can be granted, tool by tool.

The result is that a Gadget calls Linear **as the person using it**. agentgateway's broker mints
that user's own vendor token per request through AgentCore, so Linear's own RBAC applies and
nothing is shared. Cloudflare OS never sees a vendor credential.

### What this required on the agentgateway side

One change, in `chart/values.yaml`: `studio.conveo.ai` is now in
`keycloak.pruneDynamicClients.repairHosts`.

That list is the DCR trust boundary. Anonymous dynamic client registration is enabled, so
Keycloak decides whether to trust a self-registered client by the host its `redirect_uri` points
at — the one place an attacker cannot forge, because that is where the authorization code lands.
`studio.conveo.ai` qualifies: it is a Worker on Conveo's own zone behind Conveo's own Access
application.

Repair is not cosmetic here. The connector requests **no OAuth scopes** — not in its DCR
metadata, not at the authorize step — so it depends entirely on the client's default scopes.
Without repair it would receive tokens carrying no `email` or `groups` claim, and agentgateway's
`keycloak-users` and `engineering` identities both test those claims. The connector would
authenticate and then be denied at every route.

### The endpoint is not restricted to agentgateway

Upstream's MCP connector is deliberately generic: a user may paste **any** public MCP endpoint,
not only `mcp.ops.conveo.ai`. Its safety boundary is SSRF-shaped (`global_fetch_strictly_public`
plus a private-address blocklist), not an allowlist of approved hosts.

For Conveo that matters, because agentgateway exists precisely so tool access is brokered rather
than connected ad hoc. The control that exists today is the connector policy in `/admin`, which
can set this connector to disabled, optional, or enabled for the whole deployment. There is no
per-endpoint allowlist without patching upstream. Decide that policy deliberately rather than
inheriting the default.

### Rollout order

The connector registers `https://studio.conveo.ai/gatekeeper/mcp/oauth` with Keycloak on a user's
first connect, so the agentgateway change must land first:

1. Merge the `repairHosts` change to `agentgateway`'s `main`; ArgoCD rolls it onto `conveo-mgmt`.
2. Deploy Cloudflare OS.
3. Connect one endpoint as one user and confirm a tool call succeeds.

Deploying in the other order does not corrupt anything — the first client to register is simply
untrusted, gets no default scopes, and is eventually pruned. Reconnecting after the chart change
re-registers it correctly.

## Models

`aiGateway.enabled` is **false**. Cloudflare OS's platform model catalog can only be served
through Cloudflare AI Gateway (`gateway.ai.cloudflare.com`), which would put Anthropic spend and
the Anthropic key in Cloudflare rather than behind agentgateway.

Instead, models point at agentgateway. Upstream exposes a per-model `apiUrl` override
(`AiModelConfig.apiUrl`) on the direct-provider path, so a model added in Cloudflare OS can name
any Anthropic-compatible base URL.

On the agentgateway side, `llm.anthropic.cloudflareOs.enabled` publishes the same Anthropic
upstream on a **second** path, `/anthropic-cloudflare-os`, gated by a static API key
(the `cloudflare-os` Identity) rather than a JWT.

```
Cloudflare OS model config
  provider  anthropic
  apiUrl    https://gateway.ops.conveo.ai/anthropic-cloudflare-os
  apiToken  <the cloudflare-os gateway key>
```

### Why a separate route

An api-key identity and a JWT identity on one route render a Strict `apiKeyAuthentication`
policy alongside a Strict `jwtAuthentication` policy, and agentgateway does not define how those
combine — `render/access.go` flags the case explicitly as not-reachable-today. A separate `API`
CR keeps each gate unambiguous, and keeps the two traffic sources separable in Loki.

### What this costs, honestly

Cloudflare OS's model configuration accepts only a base URL and a key. The key is therefore
**per-deployment, not per-user**: this traffic attributes to `cloudflare-os` in Loki, not to the
person who wrote the prompt.

Note that the MCP path *does* attribute per user, so the limit is not that Cloudflare OS lacks a
usable identity. The two differ in how the credential is held. `gatekeeper-mcp` stores a full
OAuth grant — refresh token and expiry — in a per-user account Durable Object and mints a fresh
access token on demand, which is why it keeps working for scheduled and background turns long
after the browser consent. `AiModelConfig` holds an inert string with no refresh path.

Per-user model attribution is therefore a provisioning and lifecycle problem, not an identity
one, and three things stand in the way: agentgateway's `apiKey` Identity is a single static key
from one ESO secret with no per-user issuance; a static config field cannot hold a credential
that expires, so it would have to be N long-lived per-user secrets rather than one rotatable
deployment key; and every user would paste a credential before they could use AI at all.

The real fix is upstream and structural — Cloudflare OS modelling an AI provider the way it
already models a connected account, with a Durable Object owning the grant, exactly as
`gatekeeper-mcp` does. Chaining Keycloak behind Cloudflare Access does **not** help: Access
issues its own Cloudflare-signed assertion and never forwards the upstream provider's token, so
the Worker gains no credential it could pass on.

What the shared key still buys: the Anthropic key never leaves agentgateway, rotation is one
Secrets Manager write, and revoking the whole surface is deleting one Grant.

### Status: live and verified

Enabled on 2026-08-07 and exercised end to end — a request to
`https://gateway.ops.conveo.ai/anthropic-cloudflare-os/v1/messages` carrying the key in
`x-api-key` returned 200. That single call is what proves the whole chain: the gate accepted
the credential from a non-default header, and the upstream Anthropic call succeeded.

Two details are worth keeping, because both are silent failure modes rather than loud ones.

**The header.** Cloudflare OS's Anthropic transport constructs the SDK with `apiKey` set and
`authToken` null, so it always sends `x-api-key` and has no configuration seam to send anything
else. agentgateway's `apiKeyAuthentication` defaults to `Authorization` with the `Bearer `
prefix, so the gate had to move rather than the caller: `llm.anthropic.cloudflareOs.header`
compiles to `apiKeyAuthentication.location.header.name`. A mismatch here is a flat 401 with
nothing to indicate the header was the cause.

**The secret's shape.** The rendered `ExternalSecret` uses `remoteRef.property: "api-key"`, so
the Secrets Manager entry at `<eso.pathPrefix>/cloudflare-os-anthropic-key` must be a JSON
object carrying an `api-key` field — not a bare string. A bare string materializes an empty
Kubernetes Secret, and the route then denies every caller: fail-closed, but for a reason that
looks nothing like the cause.

Rotation is one Secrets Manager write, and revoking the whole surface is deleting the
`anthropic-cloudflare-os-access` Grant. Both are coordinated changes, not silent ones: the key
also lives in each user's model configuration, which does not refresh.

## What was not integrated, and why

**The aggregate `/` federation as an MCP portal.** Upstream ships a second connector,
`gatekeeper-mcp-portal`, that takes one administrator-configured URL and needs no user to paste
an endpoint — a better fit on its face. It requires the Cloudflare MCP portal contract: a
`portal_list_servers` tool and `{server_id}_{tool}` name prefixes. agentgateway's federation
implements neither, so the portal connector finds no server to scope a grant to and its form
stays unsubmittable. Teaching the federation route that contract would make the portal connector
work and is the natural follow-up if per-user endpoint pasting proves to be friction.

**Per-user model attribution.** See [above](#what-this-costs-honestly).

**Sign-in through Keycloak rather than Access.** Cloudflare OS supports auth Gatekeepers, so
Keycloak could in principle be the sign-in method, which would give the Workshop a Keycloak
token to forward. Access mode was kept because it authenticates before the request reaches
application code, which is the stronger boundary; both eventually resolve to the same Okta
identity.
