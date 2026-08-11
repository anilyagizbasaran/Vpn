# syntax=docker/dockerfile:1
#
# The public web surface: download page at /, account dashboard at /dashboard/,
# and the API proxied through the same origin. Built and served by the same
# Caddy that terminates TLS, so there is one hop and no CORS to configure.
#
# Build context is the repository root — the dashboard is a workspace member
# and cannot resolve its dependencies without the rest of the workspace.

# --- dashboard ---------------------------------------------------------------
FROM ghcr.io/cirruslabs/flutter:stable AS dashboard
WORKDIR /src

# Every workspace member's pubspec has to exist before `dart pub get` will
# resolve any of them, so the whole workspace comes along even though only
# apps/dashboard gets built.
COPY pubspec.yaml pubspec.lock ./
COPY packages ./packages
COPY apps ./apps
RUN dart pub get

WORKDIR /src/apps/dashboard
# No --dart-define: an empty API_BASE_URL means same-origin, which is exactly
# what it gets when Caddy serves this page and proxies /auth and /devices.
#
# --base-href matters more than it looks. Flutter writes <base href="/"> by
# default, so a build served under /dashboard/ asks for /flutter_bootstrap.js,
# gets a 404, and renders a white page with nothing in the UI to explain it.
RUN flutter build web --release --base-href /dashboard/

# --- runtime -----------------------------------------------------------------
FROM caddy:2-alpine
COPY website/index.html website/style.css website/downloads.js website/releases.json /srv/
COPY --from=dashboard /src/apps/dashboard/build/web /srv/dashboard
