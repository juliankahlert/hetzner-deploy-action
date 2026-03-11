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
| `ipv6_only` | no | `false` | Provision with IPv6 only (no public IPv4). |
| `ssh_user` | no | `root` | SSH user for connecting to the server. |
| `source_dir` | no | `.` | Workspace directory to deploy. |
| `target_dir` | no | `/opt/app` | Remote directory where files are placed. |
| `service_name` | no | — | Systemd service name to restart after deploy. |
| `container_image` | no | — | OCI image reference. Enables the Podman stage. |
| `container_port` | no | `8080` | Port mapping for Podman, e.g. `8080` or `8080:80`. |
| `haproxy_cfg` | no | — | Path to a full HAProxy config. Enables the HAProxy stage. |
| `haproxy_fragment` | no | — | Path to an HAProxy fragment to append. |
| `haproxy_fragment_name` | no | `fragment` | Remote filename for the HAProxy fragment. |
| `firewall_enabled` | no | `true` | Enable the UFW firewall stage. |
| `firewall_extra_ports` | no | — | Comma-separated extra ports to allow, e.g. `8080, 8443`. |

> **Secrets:** `hcloud_token`, `ssh_private_key`, and `public_key` contain sensitive material. Always store them as [encrypted secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions) — never hard-code them in workflow files.

---

## Outputs

| Output | Description |
|--------|-------------|
| `server_ip` | Public IP address of the server (IPv4 by default; IPv6 when `ipv6_only` is `true`). |
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
  haproxy-base.cfg      # Base HAProxy config with fragment include
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
