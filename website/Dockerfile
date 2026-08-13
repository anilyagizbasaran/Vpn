# syntax=docker/dockerfile:1
#
# The public web surface: a download page, with the API proxied through the
# same origin. Served by the same Caddy that terminates TLS, so there is one
# hop and no CORS to configure.
#
# Static files only. It used to compile a Flutter dashboard here, which meant
# the image could not be built without the whole Dart workspace and a 2 GB
# toolchain — on a small VPS that was a build away from running out of memory.
# The dashboard was account management; there are no accounts.
FROM caddy:2-alpine
COPY website/index.html website/style.css website/downloads.js website/releases.json /srv/
