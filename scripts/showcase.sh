#!/usr/bin/env bash
# Provision the showcase repos (D29) on a docker-compose deployment: the repos any visitor may run.
#
#   scripts/showcase.sh            # from the compose directory, with the api service up
#   SHOWCASE_FLASK=0 scripts/showcase.sh   # ledger only
#
# ledger: testlab's banking fixture, committed, then indexed, then given an UNCOMMITTED demo edit (the testlab
# `withdraw-signature` scenario) so the Tests page has a real diff to select, run and rank culprits for.
# flask: an already-indexed clone (`aftershock index https://github.com/pallets/flask`), given a test interpreter.
# Afterwards set AFTERSHOCK_SHOWCASE_REPOS=ledger,flask in the api's environment and recreate it.
set -euo pipefail

cd "$(dirname "$0")/.."
api() { docker compose exec -T api "$@"; }

echo "== ledger: copy, commit, index"
root() { docker compose exec -T -u root api "$@"; }
root rm -rf /data/showcase/ledger /tmp/ledger-src
# `docker cp` keeps the host's file owners (root on a sudo checkout): hand the tree to the api user before using it
docker compose cp testlab/repos/ledger api:/tmp/ledger-src
root sh -c 'mv /tmp/ledger-src /data/showcase/ledger && chown -R aftershock /data/showcase/ledger'
api sh -c 'cd /data/showcase/ledger && find . -name __pycache__ -prune -exec rm -rf {} + \
  && git init -q && git add -A \
  && git -c user.name=aftershock -c user.email=showcase@aftershock.invalid commit -qm "ledger showcase baseline"'
api aftershock index /data/showcase/ledger --name ledger --full

echo "== ledger: demo edit (uncommitted, so the diff is what the Tests page runs)"
api sed -i 's/def withdraw(self, amount: Money, memo: str = "withdrawal") -> None:/def withdraw(self, amount: Money, memo: str, *, approved_by: str) -> None:/' \
  /data/showcase/ledger/ledger/accounts.py
api git -C /data/showcase/ledger diff --stat

echo "== test environments"
api aftershock setup ledger
if [ "${SHOWCASE_FLASK:-1}" = 1 ]; then api aftershock setup flask; fi

echo "== seed real runs (recorded in the graph, shown on the Tests and Culprit pages)"
api aftershock run ledger --diff || true   # the demo edit fails 7 tests: a non-zero exit is the point
api aftershock scripts ledger run py.syntax py.import-smoke pytest.collect pytest.flaky pytest.isolation \
  graph.untested-hubs repo.merge-markers sec.secrets || true

repos=ledger; if [ "${SHOWCASE_FLASK:-1}" = 1 ]; then repos=ledger,flask; fi
echo "done. Set AFTERSHOCK_SHOWCASE_REPOS=$repos for the api and run: docker compose up -d api"
