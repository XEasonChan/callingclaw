# SenseVoice Local STT Service

Real-time Chinese/English speech-to-text for CallingClaw meetings.

## Setup

```bash
cd callingclaw-backend/services/sensevoice
pip install -r requirements.txt
python server.py --port 4001
```

First run downloads the SenseVoiceSmall model (~500MB).

## Architecture

```
Meet audio → CallingClaw backend → WebSocket → SenseVoice server (port 4001)
                                                   ↓
                                              text transcript
                                                   ↓
                                          CallingClaw backend → SharedContext + Haiku
```

## Performance

- Model: SenseVoiceSmall (234M params)
- Latency: ~70ms per 10s audio chunk
- Languages: 50+ (Chinese/English best)
- 15x faster than Whisper-Large
