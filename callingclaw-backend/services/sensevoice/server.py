"""
SenseVoice Real-Time STT Server
WebSocket service for CallingClaw meeting audio → text transcription.

Architecture:
  Meet audio (PCM16 24kHz) → CallingClaw backend → WebSocket → this server → text

Install:
  pip install funasr websockets numpy

Run:
  python server.py [--port 4001] [--model SenseVoiceSmall]

Protocol:
  Client sends: base64-encoded PCM16 24kHz mono audio chunks
  Server returns: {"text": "transcribed text", "lang": "zh|en", "emotion": "...", "ts": 123}
"""

import asyncio
import json
import base64
import struct
import argparse
import logging
import numpy as np
from typing import Optional

logging.basicConfig(level=logging.INFO, format="[SenseVoice] %(message)s")
log = logging.getLogger(__name__)

# ── Model Loading ──
model = None
SAMPLE_RATE = 16000  # SenseVoice expects 16kHz

def load_model(model_name: str = "SenseVoiceSmall"):
    """Load SenseVoice model via FunASR."""
    global model
    from funasr import AutoModel
    log.info(f"Loading {model_name}...")
    model = AutoModel(
        model=f"iic/{model_name}",
        trust_remote_code=True,
        device="cpu",  # Use "cuda:0" for GPU
    )
    log.info(f"Model loaded: {model_name}")

# ── Audio Processing ──
def pcm16_base64_to_float32(b64_audio: str, input_rate: int = 24000) -> np.ndarray:
    """Decode base64 PCM16 → float32 numpy array, resample if needed."""
    raw = base64.b64decode(b64_audio)
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    # Resample from input_rate to 16kHz if needed
    if input_rate != SAMPLE_RATE:
        ratio = SAMPLE_RATE / input_rate
        new_len = int(len(samples) * ratio)
        indices = np.round(np.linspace(0, len(samples) - 1, new_len)).astype(int)
        samples = samples[indices]

    return samples

# ── WebSocket Handler ──
async def handle_client(websocket):
    """Handle one WebSocket client (one meeting audio stream)."""
    log.info("Client connected")
    audio_buffer = np.array([], dtype=np.float32)
    chunk_count = 0

    # Buffer ~2 seconds of audio before transcribing (SenseVoice works best on chunks)
    BUFFER_SECONDS = 2.0
    BUFFER_SIZE = int(SAMPLE_RATE * BUFFER_SECONDS)

    try:
        async for message in websocket:
            try:
                data = json.loads(message)

                if data.get("type") == "audio" and data.get("audio"):
                    # Decode and accumulate audio
                    samples = pcm16_base64_to_float32(data["audio"], input_rate=24000)
                    audio_buffer = np.concatenate([audio_buffer, samples])
                    chunk_count += 1

                    # Transcribe when buffer is full
                    if len(audio_buffer) >= BUFFER_SIZE:
                        result = model.generate(
                            input=audio_buffer,
                            cache={},
                            language="auto",  # Auto-detect zh/en
                            use_itn=True,     # Inverse text normalization
                        )

                        if result and len(result) > 0:
                            text = result[0].get("text", "").strip()
                            if text and len(text) > 1:
                                response = {
                                    "type": "transcript",
                                    "text": text,
                                    "chunks": chunk_count,
                                    "lang": result[0].get("lang", "unknown"),
                                }
                                await websocket.send(json.dumps(response))
                                log.info(f"Transcript: \"{text[:60]}\" (lang={response['lang']}, chunks={chunk_count})")

                        # Keep last 0.5s for continuity
                        overlap = int(SAMPLE_RATE * 0.5)
                        audio_buffer = audio_buffer[-overlap:]
                        chunk_count = 0

                elif data.get("type") == "stop":
                    # Flush remaining buffer
                    if len(audio_buffer) > SAMPLE_RATE * 0.3:  # >0.3s
                        result = model.generate(input=audio_buffer, cache={}, language="auto", use_itn=True)
                        if result and result[0].get("text", "").strip():
                            await websocket.send(json.dumps({
                                "type": "transcript",
                                "text": result[0]["text"].strip(),
                                "final": True,
                            }))
                    audio_buffer = np.array([], dtype=np.float32)

            except json.JSONDecodeError:
                pass
            except Exception as e:
                log.warning(f"Error processing chunk: {e}")

    except Exception as e:
        log.info(f"Client disconnected: {e}")
    finally:
        log.info("Client disconnected")

# ── Main ──
async def main(port: int, model_name: str):
    import websockets
    load_model(model_name)
    log.info(f"WebSocket server starting on ws://localhost:{port}")
    async with websockets.serve(handle_client, "localhost", port):
        log.info(f"Ready — connect from CallingClaw backend")
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SenseVoice Real-Time STT Server")
    parser.add_argument("--port", type=int, default=4001, help="WebSocket port")
    parser.add_argument("--model", type=str, default="SenseVoiceSmall", help="Model name")
    args = parser.parse_args()

    asyncio.run(main(args.port, args.model))
