# Velixir free-tier node (VLESS + WS via Xray)

Single Node app for the Velixir free plan. On first start it downloads
Xray-core and unpacks it using only Node's built-in zlib (the container
has no unzip/python3). The app serves a decoy page on `/`, a base64
subscription on `/sub`, and proxies WebSocket upgrades on the secret
path to a local Xray VLESS inbound.

## Environment variables (set in the Velixir panel)

- `UUID` — node UUID (default baked into server.js; panel value wins)
- `WS_PATH` — WebSocket path without leading slash (same rule)

## Client

Import `https://<your-app>.velixir.run/sub` as a subscription in
Shadowrocket, or use the vless:// link it decodes to:
`vless://<UUID>@<your-app>.velixir.run:443?encryption=none&security=tls&type=ws&host=<your-app>.velixir.run&path=%2F<WS_PATH>`

## Limits of the free plan (vendor-stated)

- 0.25 vCPU / 256 MB RAM / 1 GB scratch disk
- Sleeps after 15 min without a request (first connect cold-starts)
- Outbound capped at 10 Mbit/s, servers in the EU
