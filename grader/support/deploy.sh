#!/usr/bin/env bash
# Reference deployment path, as the grader invokes it.
#
# A student's manifest names its own command here. The only contract is the
# output: four ATBT_ lines on stdout naming the deployed addresses. Everything
# else this prints is ignored.
set -euo pipefail
cd "$(dirname "$0")/../.."
forge script contracts/script/Deploy.s.sol \
  --rpc-url "${L1_RPC:?}" \
  --broadcast \
  --private-key "${DEPLOYER_KEY:?}" \
  2>&1
