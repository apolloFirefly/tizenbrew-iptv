# Brew TV — TizenBrew IPTV
TV-first Xtream live player, targeting Samsung Q60A (2021).
## Run locally
Run `npm start` and open http://localhost:8090. No separate Python server is needed.
If an older service is already running, stop it with Ctrl+C and run npm start again.
The existing http://localhost:8080 frontend is also supported.
## Features
D-pad spatial focus, Enter/OK selection, Return/Escape, media buttons, category search,
30-channel pages, local favorites, full-window player, native HLS and bundled hls.js 1.6.13 fallback.
The visual demo uses fictitious channels and does not connect to a provider.
## Credentials and service
Local credentials: service/config.local.json, ignored by Git; environment variables
XTREAM_BASE_URL / XTREAM_USERNAME / XTREAM_PASSWORD override the file.
In TizenBrew, the default file is .tizenbrew-iptv.json under the service user's home.
Override with XTREAM_CONFIG_PATH when the runtime requires another writable location.
Files use owner-only permissions where supported; credentials are not encrypted at rest.
Prefer HTTPS providers: HTTP transports provider credentials without TLS.
HLS resource URLs are encrypted with a process-local key; restarting invalidates old URLs.
Service binds loopback. Allowed browser origins include local development and TizenBrew port 8081.
Only same-origin stream resources and redirects are currently accepted; external CDN hosts
are deliberately unsupported until the actual provider routing is known.
No DRM, EPG, VOD, series or AVPlay adapter is implemented.
## TizenBrew compatibility
The official service launcher evaluates a single fetched JavaScript file inside a VM:
no module-local __dirname and no normal require.main entry point. Both cases are handled.
The code requires a modern Node runtime (async/await, URL, async stream iteration);
legacy Node 4 TizenBrew runtimes are NOT supported by this build.
The exact installed TizenBrew version/runtime and writable home must be verified on the TV.
The browser code avoids optional chaining and includes a CSS aspect-ratio fallback for Chromium 76.
TizenBrew's hosted page is not equivalent to a standalone signed Tizen WGT:
do not assume Samsung AVPlay is exposed. Native HTML video is preferred, with hls.js/MSE fallback.
## Packaging / TV next step
`npm pack --dry-run` verifies an explicit publish allowlist excluding config and tests.
TizenBrew resolves modules from npm/GitHub through jsDelivr. This local repository has not
been published or installed on a TV. A .tgz is not a signed .wgt or a direct installer.
After verifying the TizenBrew version, publish the reviewed package through an authorized
npm/GitHub destination, add that module to TizenBrew, and test with your own account on the TV.
## Verification
`npm run check`: syntax, VM startup, Xtream mock status/catalog, sealed HLS resources, segments,
CORS rejection and tampered-token rejection. This does not prove hardware decoding.
Manual browser validation includes D-pad navigation and actual H.264/AAC HLS playback
through the local mock provider and proxy (640x360).
## Research and design rationale
- https://github.com/adrianofranco/IPTVPlayer — separate playback strategy, D-pad focus,
bounded catalog rendering. Adopted these patterns with original implementation.
- https://github.com/reisxd/TizenBrew/blob/main/tizenbrew-app/TizenBrew/service-nextgen/service/utils/serviceLauncher.js — real service VM loader.
- https://github.com/reisxd/TizenBrew/blob/main/tizenbrew-app/TizenBrew/service-nextgen/service/utils/moduleLoader.js — hosted origin on port 8081.
- https://github.com/GlenLowland/jellyfin-tizen-npm-publish — hosted applications need
adaptation; native Samsung APIs cannot simply be assumed.
- https://github.com/video-dev/hls.js — MSE playback fallback; bundled with Apache-2.0 license.
- https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html — 2021 engine Chromium 76.
Third-party repository claims are useful evidence, not proof of operation on this user's TV.
