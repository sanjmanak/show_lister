#!/usr/bin/env bash
# macOS double-click wrapper for update-prices.sh: Finder opens .command files
# in Terminal. Keeps the window open at the end so you can read the result.
cd "$(dirname "$0")"
./update-prices.sh
status=$?
echo ""
read -r -p "Press Enter to close this window..."
exit $status
