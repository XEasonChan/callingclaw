#!/bin/bash
# Setup 3 test meetings with existing prep files
# Creates Google Calendar events and registers sessions

API="http://localhost:4000"
SHARED_DIR="/Users/admin/Desktop/Code/Tanka/claw/callingclaw/callingclaw_repo/shared"

echo "=== CallingClaw Test Meeting Setup ==="
echo ""

# Check service is running
STATUS=$(curl -s "$API/api/status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('callingclaw',''))" 2>/dev/null)
if [ "$STATUS" != "running" ]; then
  echo "ERROR: CallingClaw is not running. Start it first."
  exit 1
fi
echo "[OK] CallingClaw is running"

# Check calendar is connected
CAL=$(curl -s "$API/api/status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('calendar',''))" 2>/dev/null)
echo "[OK] Calendar: $CAL"

# Define 3 meetings with their prep file mappings
# Format: meetingId|topic|prep_file|offset_minutes
MEETINGS=(
  "cc_mn09a2q8_4oz0|讨论 Tanka 2.0 最新方向|cc_mn09a2q8_4oz0_prep.md|30"
  "cc_mn34qxu9_t1fb|讨论 Link 接 Action 的进度|cc_mn34qxu9_t1fb_prep.md|60"
  "cc_mn8isj89_1kv4|CallingClaw 助手化整体设计方案对齐|cc_mn8isj89_1kv4_prep.md|90"
)

echo ""
echo "=== Creating 3 Google Calendar meetings ==="

for entry in "${MEETINGS[@]}"; do
  IFS='|' read -r MEETING_ID TOPIC PREP_FILE OFFSET <<< "$entry"

  # Calculate start time (now + offset minutes)
  START=$(date -v+${OFFSET}M -u +"%Y-%m-%dT%H:%M:%S+08:00" 2>/dev/null || date -d "+${OFFSET} minutes" +"%Y-%m-%dT%H:%M:%S+08:00")
  END=$(date -v+$((OFFSET+25))M -u +"%Y-%m-%dT%H:%M:%S+08:00" 2>/dev/null || date -d "+$((OFFSET+25)) minutes" +"%Y-%m-%dT%H:%M:%S+08:00")

  echo ""
  echo "--- Meeting: $TOPIC ---"
  echo "  ID: $MEETING_ID"
  echo "  Time: $START"
  echo "  Prep: $PREP_FILE"

  # 1. Create Google Calendar event
  CAL_RESULT=$(curl -s "$API/api/calendar/create" -X POST \
    -H "Content-Type: application/json" \
    -d "{\"summary\":\"$TOPIC\",\"start\":\"$START\",\"end\":\"$END\"}")

  echo "  Calendar: $CAL_RESULT"

  # Extract calendar event ID and meet link
  CAL_EVENT_ID=$(echo "$CAL_RESULT" | python3 -c "import sys,json; d=json.loads(json.load(sys.stdin) if isinstance(json.load(sys.stdin),str) else '{}'); print(d.get('id',''))" 2>/dev/null || echo "")
  MEET_LINK=$(echo "$CAL_RESULT" | python3 -c "import sys,json; d=json.loads(json.load(sys.stdin) if isinstance(json.load(sys.stdin),str) else '{}'); print(d.get('meetLink',''))" 2>/dev/null || echo "")

  # 2. Register session with prep file via prep-result API
  curl -s "$API/api/meeting/prep-result" -X POST \
    -H "Content-Type: application/json" \
    -d "{\"topic\":\"$TOPIC\",\"meetingId\":\"$MEETING_ID\",\"meetUrl\":\"$MEET_LINK\",\"calendarEventId\":\"$CAL_EVENT_ID\"}" > /dev/null

  # 3. Ensure prep file exists in expected locations
  # Copy to shared/ root (system looks here by default)
  if [ -f "$SHARED_DIR/prep/$PREP_FILE" ]; then
    cp "$SHARED_DIR/prep/$PREP_FILE" "$SHARED_DIR/$PREP_FILE" 2>/dev/null
    echo "  [OK] Prep file copied to shared/"
  fi

  echo "  [OK] Session registered"
done

echo ""
echo "=== Setup complete ==="
echo ""
echo "Verify: curl $API/api/calendar/events | python3 -m json.tool"
echo ""
echo "Test flow:"
echo "  1. Open voice-test page: http://localhost:4000/voice-test.html"
echo "  2. Select a meeting from dropdown"
echo "  3. Click Start → ask CallingClaw to join the meeting"
echo "  4. Test: ask questions covered in the prep brief"
echo "  5. Test: make decisions, the AI should record them"
echo "  6. Test: ask to leave → check generated notes"
