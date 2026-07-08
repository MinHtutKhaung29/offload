#!/usr/bin/env bash
# test-fixes.sh — verify offload v1.3 fixes (verification + live diagnosis).
# Usage: bash ~/.config/offload/test-fixes.sh <abs-project-dir-with-git>
set -u
DIR="${1:?usage: test-fixes.sh <abs project dir>}"
OFF="node $HOME/.config/offload/offload.mjs"
PASS=0; FAIL=0
ck() { # ck <name> <expected-grep> <text>
  if echo "$3" | grep -qi "$2"; then echo "PASS: $1"; PASS=$((PASS+1));
  else echo "FAIL: $1 (expected /$2/)"; echo "$3" | head -5 | sed 's/^/    /'; FAIL=$((FAIL+1)); fi
}

echo "== T1: violation detection (file changed during propose-only job) =="
OUTPUT=$($OFF oc general "PROPOSE ONLY - do not edit files. Wait, then reply with exactly: DONE-T1" --dir "$DIR" --bg)
JOB=$(echo "$OUTPUT" | grep -o 'job_[a-z0-9]*' | head -1)
sleep 3
echo "injected violation" > "$DIR/violation-test.txt"   # simulate the agent writing
for i in $(seq 1 24); do
  S=$($OFF status "$JOB"); echo "$S" | grep -q "running" || break; sleep 5
done
ck "T1 propose-only violation flagged" "VERIFY: agent MODIFIED FILES" "$S"
rm -f "$DIR/violation-test.txt"

echo "== T2: clean propose-only job -> NO warning =="
S=$($OFF oc general "PROPOSE ONLY - do not edit files. Reply with exactly: DONE-T2" --dir "$DIR" --timeout 120)
if echo "$S" | grep -qi "VERIFY: agent MODIFIED"; then echo "FAIL: T2 false positive"; FAIL=$((FAIL+1)); else echo "PASS: T2 no false positive"; PASS=$((PASS+1)); fi

echo "== T3: legit edit detected =="
S=$($OFF oc general "Create a file named t3-test.txt containing hello in the project root. Nothing else." --dir "$DIR" --timeout 120)
ck "T3 edit note" "verify: .* file(s\\?) changed" "$S"
rm -f "$DIR/t3-test.txt"

echo "== T4: live diagnosis on running job =="
OUTPUT=$($OFF oc general "Read css/base.css and css/components.css fully, then summarize them in detail. Do not create files." --dir "$DIR" --bg)
JOB=$(echo "$OUTPUT" | grep -o 'job_[a-z0-9]*' | head -1)
sleep 10
S=$($OFF status "$JOB")
ck "T4 live state shown" "⏳\\|in tool\\|generating\\|BLOCKED" "$S"
$OFF abort "$JOB" >/dev/null 2>&1

echo
echo "RESULT: $PASS passed, $FAIL failed"
exit $FAIL
