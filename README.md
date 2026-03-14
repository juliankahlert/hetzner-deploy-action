# hetzner-deploy-action

Create or update a Hetzner Cloud server and deploy a directory to it — all from a single GitHub Actions step.

The action provisions a server via the Hetzner Cloud API, syncs your build artifacts with `rsync`, and optionally configures **Podman** containers, **HAProxy** reverse-proxying, **systemd** services, and **UFW** firewall rules.

---

## Features

- **Idempotent provisioning** — finds an existing server by name and project tag, or creates one
- **SSH key management** — registers your deploy key with Hetzner automatically
- **rsync deploy** — fast incremental file transfer to the remote host
- **Podman Quadlet** — deploy OCI containers managed by systemd (set `container_image`)
- **HAProxy** — upload a full config or append a fragment to `/etc/haproxy/conf.d/`
- **Firewall** — configure UFW with sensible defaults and optional extra ports
- **systemd service** — install and restart a systemd unit for non-container workloads
- **IPv6-only support** — provision servers without a public IPv4 address

---

## Quick Start

```yaml
- uses: julian-kahlert/hetzner-deploy-action@v1
  with:
    hcloud_token:    ${{ secrets.HCLOUD_TOKEN }}
    ssh_private_key: ${{ secrets.SSH_PRIVATE_KEY }}
    public_key:      ${{ secrets.SSH_PUBLIC_KEY }}
    server_name:     my-app
    project_tag:     my-project
    source_dir:      ./dist
    target_dir:      /opt/app
```

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `hcloud_token` | **yes** | — | Hetzner Cloud API token. Store as a repository secret. |
| `server_name` | **yes** | — | Logical server name used to find or create the instance. |
| `project_tag` | **yes** | — | Tag that groups servers belonging to the same project. |
| `public_key` | **yes** | — | SSH public key registered on the server. Store as a secret. |
| `ssh_private_key` | **yes** | — | SSH private key used for rsync. Store as a secret. |
| `image` | no | `ubuntu-24.04` | Hetzner image slug for new servers. |
| `server_type` | no | `cx23` | Hetzner server type (size). |
| `ipv6_only` | no | `false` | Provision with IPv6 only (no public IPv4). **Warning:** GitHub-hosted runners do not provide outbound IPv6 connectivity, so this action's deploy stages and any later steps that connect to an IPv6-only server require a self-hosted runner with IPv6 support. |
| `ssh_user` | no | `root` | SSH user for connecting to the server. |
| `source_dir` | no | `.` | Workspace directory to deploy. |
| `target_dir` | no | `/opt/app` | Remote directory where files are placed. |
| `service_name` | no | — | Systemd service name to restart after deploy. |
| `container_image` | no | — | OCI image reference. Enables the Podman stage. |
| `container_port` | no | `8080` | Port mapping for Podman, e.g. `8080` or `8080:80`. |
| `haproxy_cfg` | no | — | Path to a full HAProxy config. Enables the HAProxy stage. |
| `haproxy_fragment` | no | — | Path to an HAProxy fragment to append. When set without `haproxy_cfg`, the action auto-deploys the bundled `templates/haproxy-base.cfg` as `/etc/haproxy/haproxy.cfg` so fragments are active immediately. |
| `haproxy_fragment_name` | no | `fragment` | Remote filename for the HAProxy fragment. |
| `firewall_enabled` | no | `true` | Enable the UFW firewall stage. |
| `firewall_extra_ports` | no | — | Comma-separated extra ports to allow, e.g. `8080, 8443`. |

> **Secrets:** `hcloud_token`, `ssh_private_key`, and `public_key` contain sensitive material. Always store them as [encrypted secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions) — never hard-code them in workflow files.

---

## Outputs

| Output | Description |
|--------|-------------|
| `server_ip` | Public IP address of the server. Reflects the server's **actual networking state**: IPv4 by default, or IPv6 when the server was provisioned with `ipv6_only`. When reusing an existing IPv6-only server, this output returns the IPv6 address even if the current workflow sets `ipv6_only=false`. |
| `server_id` | Hetzner Cloud server ID. |
| `server_status` | Server status after provisioning (e.g. `running`). |

---

## Pipeline Stages

The action executes a pipeline of ordered stages. Core stages always run; optional stages activate when their corresponding inputs are provided.

```
 Hetzner Provisioning        Deployment Stages
 ──────────────────────      ─────────────────────────────────────
 1. Register SSH key         3. Install packages (rsync, etc.)
 2. Find/create server       4. Ensure target directory
                             5. rsync deploy
                             6. Podman Quadlet     (if container_image)
                             7. systemd unit       (if service_name, no container)
                             8. HAProxy            (if haproxy_cfg or haproxy_fragment)
                             9. Firewall           (if firewall_enabled)
```

### Stage activation rules

| Stage | Condition |
|-------|-----------|
| installPackages | Always |
| ensureTargetDir | Always |
| rsyncDeploy | Always |
| podman | `container_image` is set |
| systemd | `service_name` is set **and** `container_image` is not set |
| haproxy | `haproxy_cfg` or `haproxy_fragment` is set |
| firewall | `firewall_enabled` is `true` (default) |

> **Note:** When `container_image` is set, the Podman Quadlet manages the service via systemd. The standalone systemd stage is skipped to avoid conflicts.

### IPv6 and runner compatibility

GitHub-hosted runners only have outbound IPv4 connectivity. If your server is IPv6-only, Hetzner API provisioning may still work from a GitHub-hosted runner, but this action's deploy stages (SSH/rsync) and any later direct connections to the server require runner IPv6 connectivity.

| Scenario | Runner requirement |
|----------|--------------------|
| `ipv6_only=true`, provision only | GitHub-hosted runner works |
| `ipv6_only=true`, provision + deploy | Self-hosted runner with IPv6 required |
| `ipv6_only=true`, post-deploy connectivity to server | Self-hosted runner with IPv6 required |
| `ipv6_only=false` (default) | Any runner works |

**Automatic detection and mismatch warning:** When the action reuses an existing server, it detects the server's actual IP configuration. If the server is IPv6-only but `ipv6_only` is set to `false` (or left at its default), the action emits a warning to alert you to the mismatch. The deploy continues using the server's real IPv6 address, and `server_ip` reflects that address — not the value of the `ipv6_only` input.

### SSH readiness and troubleshooting

After provisioning completes the action automatically waits for the server's SSH daemon to accept connections before running any deploy stage. This **SSH wait gate** bridges the gap between Hetzner reporting a server as `running` and sshd actually being ready.

**Retry behaviour:**

| Parameter | Value |
|-----------|-------|
| Initial delay | 2 s |
| Back-off sequence | 2 → 4 → 8 → 16 → 32 s (exponential, doubling each attempt) |
| Per-attempt cap | 32 s |
| Maximum total wait | 120 s (cumulative across all retries) |

Connection-level errors (timeout, connection refused, network unreachable) are retried automatically with exponential back-off. **Permission denied** errors are treated as unrecoverable — the wait gate fails immediately so you can fix the SSH key rather than burn through the full timeout.

> **How it works:** The action runs `ssh … echo ok` against the server and checks for the literal response. Each failed attempt logs `SSH not ready yet, retrying in <N>s: <error>` so you can follow progress in the workflow log.

**If SSH still fails after 120 s:**

1. **Verify your key pair** — confirm that `ssh_private_key` and `public_key` are a matching pair and that the public key is in OpenSSH format.
2. **Check server state** — open the Hetzner Cloud Console, navigate to the server, and confirm it shows status *Running*. Use the web console to verify sshd is active: `systemctl status sshd`.
3. **Firewall / security group** — ensure no Hetzner Cloud Firewall is blocking port 22 for the runner's IP range.
4. **IPv6 connectivity** — if `server_ip` is an IPv6 address, the runner must have outbound IPv6. See [IPv6 and runner compatibility](#ipv6-and-runner-compatibility) above.
5. **Re-run the workflow** — transient cloud-init delays occasionally exceed 120 s on first boot. A simple re-run often succeeds because sshd is already up.

---

## Examples

### Minimal — static file deploy

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: julian-kahlert/hetzner-deploy-action@v1
        id: deploy
        with:
          hcloud_token:    ${{ secrets.HCLOUD_TOKEN }}
          ssh_private_key: ${{ secrets.SSH_PRIVATE_KEY }}
          public_key:      ${{ secrets.SSH_PUBLIC_KEY }}
          server_name:     web-prod
          project_tag:     website

      - run: echo "Deployed to ${{ steps.deploy.outputs.server_ip }}"
```

### Container deploy with Podman

```yaml
- uses: julian-kahlert/hetzner-deploy-action@v1
  with:
    hcloud_token:    ${{ secrets.HCLOUD_TOKEN }}
    ssh_private_key: ${{ secrets.SSH_PRIVATE_KEY }}
    public_key:      ${{ secrets.SSH_PUBLIC_KEY }}
    server_name:     api-prod
    project_tag:     backend
    container_image: ghcr.io/my-org/api:latest
    container_port:  '8080:3000'
    service_name:    api
```

### Fragment-only HAProxy

When you only set `haproxy_fragment` (without `haproxy_cfg`), the action automatically deploys the bundled base config to `/etc/haproxy/haproxy.cfg`. That base config only contains the `global` and `defaults` sections. Fragment loading is performed by the `haproxy-frag` systemd service, which invokes HAProxy with `-f /etc/haproxy/haproxy.cfg -f /etc/haproxy/conf.d/`, so your fragment is loaded without any extra setup.

Validation covers both paths: the action runs `haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/conf.d/` to verify the base config and all fragments together before reloading the service.

```yaml
- uses: julian-kahlert/hetzner-deploy-action@v1
  with:
    hcloud_token:          ${{ secrets.HCLOUD_TOKEN }}
    ssh_private_key:       ${{ secrets.SSH_PRIVATE_KEY }}
    public_key:            ${{ secrets.SSH_PUBLIC_KEY }}
    server_name:           web-prod
    project_tag:           website
    haproxy_fragment:      ./haproxy/my-backend.cfg
    haproxy_fragment_name: my-backend
```

### Full stack with HAProxy and firewall

```yaml
- uses: julian-kahlert/hetzner-deploy-action@v1
  with:
    hcloud_token:        ${{ secrets.HCLOUD_TOKEN }}
    ssh_private_key:     ${{ secrets.SSH_PRIVATE_KEY }}
    public_key:          ${{ secrets.SSH_PUBLIC_KEY }}
    server_name:         gateway
    project_tag:         infra
    source_dir:          ./config
    target_dir:          /opt/gateway
    container_image:     ghcr.io/my-org/app:latest
    container_port:      '8080'
    service_name:        app
    haproxy_cfg:         ./haproxy/haproxy.cfg
    firewall_enabled:    'true'
    firewall_extra_ports: '443, 8443'
```

---

## Development

### Prerequisites

- **Node.js 20+**
- **npm**

### Install dependencies

```sh
npm install
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript with `tsc`, then bundle with `@vercel/ncc` into `dist/index.js` |
| `npm test` | Run the test suite with Vitest |

### Project structure

```
src/
  index.ts              # Action entry point — parses inputs, runs pipeline
  pipeline.ts           # Orchestrates provisioning and deployment stages
  validate.ts           # Input validation with regex patterns
  hetzner/
    client.ts           # Hetzner Cloud API client setup
    findOrCreateServer.ts  # Idempotent server provisioning
    sshKeys.ts          # SSH key registration
  deploy/
    rsync.ts            # rsync file transfer
    podman.ts           # Podman Quadlet deployment
    haproxy.ts          # HAProxy config and fragment deployment
    firewall.ts         # UFW firewall configuration
    remoteSetup.ts      # Target directory and systemd unit setup
    packageInstall.ts   # Remote package installation
    ssh.ts              # SSH connection helpers
templates/
  systemd.service       # Systemd unit template
  quadlet.container     # Podman Quadlet unit template
  haproxy-base.cfg      # Base HAProxy global/defaults configuration
```

### Build and test

```sh
# Full build: TypeScript compile + ncc bundle
npm run build

# Run tests
npm test
```

The `dist/` directory is committed to the repository. GitHub Actions loads `dist/index.js` directly at runtime (as specified by `runs.main` in `action.yml`), so you must rebuild after every source change.

---

## License

[MIT](LICENSE) &copy; Julian Kahlert
