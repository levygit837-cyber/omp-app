#!/bin/sh
# usage: launch.sh <FAKE_REQUEST> [extra env...]
pkill -f "remote-debugging-port=9342" 2>/dev/null; sleep 1
cd /Users/levy/Documents/Workspace/Projects/Developer-Tools/omp-app-worktrees/12-permissions/apps/desktop
export OMP_APP_SIDECAR_BIN=/tmp/smoke12/fake.sh FAKE_SIDECAR=ok FAKE_REQUEST="$1" FAKE_HOLD=1
nohup bunx electron . --remote-debugging-port=9342 > /tmp/smoke12/electron.log 2>&1 &
