# One image for every TypeScript service. Which one it runs is chosen by the
# command, because validator, client and prover differ only in entry point and
# environment, and three near-identical Dockerfiles would drift.
FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache bash curl

# Dependencies are installed into a package.json written here rather than the
# repo's own, because npm rejects pnpm's "workspace:*" protocol outright with
# EUNSUPPORTEDPROTOCOL. The workspace links are then made by hand below, which
# is all "workspace:*" ever meant.
RUN npm init -y >/dev/null \
 && npm install --no-package-lock --loglevel=error \
      viem@^2 tsx@^4 typescript@^5 @types/node@^22

COPY tsconfig.json ./
COPY packages ./packages
COPY spec ./spec
COPY contracts ./contracts

# Resolve @atbt/* by name, the way the workspace does.
RUN mkdir -p node_modules/@atbt \
 && for p in common validator client prover malicious; do \
      ln -sfn ../../packages/$p node_modules/@atbt/$p; \
    done

# Every service answers JSON-RPC, so one health probe shape covers all of them.
HEALTHCHECK --interval=5s --timeout=3s --retries=24 --start-period=10s \
  CMD curl -sf -X POST -H 'content-type: application/json' \
      --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${HEALTH_METHOD:-vapi_info}\",\"params\":[]}" \
      "http://127.0.0.1:${HEALTH_PORT:-${VAPI_PORT:-$PORT}}" | grep -q result

# Both, and in that order: the entrypoint is a three-line wrapper around the
# renderer, so shipping one without the other gives a container that starts and
# then cannot configure itself.
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/render-config.ts docker/setup.ts ./docker/
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npx", "tsx", "packages/validator/src/index.ts"]
