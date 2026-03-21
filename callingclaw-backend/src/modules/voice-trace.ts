// CallingClaw 2.0 — Voice Path Tracing
// Tracks 9 key metrics per voice turn for observability.

export interface VoiceTurnTrace {
  turnId: string;
  // Timestamps (ms since epoch)
  userSpeechStart: number;
  userSpeechEnd: number;
  asrSentTime: number;           // When audio was sent to provider
  modelFirstToken: number;       // First response event from provider
  modelFirstAudio: number;       // First audio delta
  ttsPlaybackStart: number;      // When client started playing
  ttsPlaybackEnd: number;        // When playback finished (or interrupted)
  interruptionTime: number | null; // When user interrupted (null if not)
  // Computed
  heardDurationMs: number;       // How long AI audio actually played
  totalLatencyMs: number;        // userSpeechEnd → modelFirstAudio
  // Context
  contextUpdateSize: number;     // Bytes of context injected this turn
  toolsInvoked: string[];        // Tool names called this turn
  tokenCost: { input: number; output: number } | null;
}

export class VoiceTracer {
  private _currentTurn: Partial<VoiceTurnTrace> | null = null;
  private _history: VoiceTurnTrace[] = [];
  private _maxHistory = 50;

  /** Start tracking a new turn (call on speech_started or response.created) */
  startTurn() {
    // Finalize previous turn if still open
    if (this._currentTurn) this.endTurn();
    this._currentTurn = {
      turnId: `t_${Date.now().toString(36)}`,
      toolsInvoked: [],
      contextUpdateSize: 0,
    };
  }

  /** Record a timestamp for a specific event */
  mark(event: keyof Pick<VoiceTurnTrace,
    'userSpeechStart' | 'userSpeechEnd' | 'asrSentTime' |
    'modelFirstToken' | 'modelFirstAudio' | 'ttsPlaybackStart' |
    'ttsPlaybackEnd' | 'interruptionTime'>) {
    if (this._currentTurn) {
      (this._currentTurn as any)[event] = Date.now();
    }
  }

  /** Record a tool invocation */
  recordTool(name: string) {
    if (this._currentTurn?.toolsInvoked) {
      this._currentTurn.toolsInvoked.push(name);
    }
  }

  /** Record context injection size */
  recordContextUpdate(bytes: number) {
    if (this._currentTurn) {
      this._currentTurn.contextUpdateSize = (this._currentTurn.contextUpdateSize || 0) + bytes;
    }
  }

  /** Record token cost from response.done */
  recordTokens(input: number, output: number) {
    if (this._currentTurn) {
      this._currentTurn.tokenCost = { input, output };
    }
  }

  /** Finalize current turn and compute derived metrics */
  endTurn(): VoiceTurnTrace | null {
    if (!this._currentTurn) return null;
    const t = this._currentTurn;

    // Compute derived metrics
    const trace: VoiceTurnTrace = {
      turnId: t.turnId || `t_${Date.now().toString(36)}`,
      userSpeechStart: t.userSpeechStart || 0,
      userSpeechEnd: t.userSpeechEnd || 0,
      asrSentTime: t.asrSentTime || 0,
      modelFirstToken: t.modelFirstToken || 0,
      modelFirstAudio: t.modelFirstAudio || 0,
      ttsPlaybackStart: t.ttsPlaybackStart || 0,
      ttsPlaybackEnd: t.ttsPlaybackEnd || 0,
      interruptionTime: t.interruptionTime || null,
      heardDurationMs: (t.interruptionTime || t.ttsPlaybackEnd || 0) - (t.ttsPlaybackStart || 0),
      totalLatencyMs: (t.modelFirstAudio || 0) - (t.userSpeechEnd || 0),
      contextUpdateSize: t.contextUpdateSize || 0,
      toolsInvoked: t.toolsInvoked || [],
      tokenCost: t.tokenCost || null,
    };

    // Only keep meaningful traces
    if (trace.modelFirstAudio > 0 || trace.userSpeechStart > 0) {
      this._history.push(trace);
      if (this._history.length > this._maxHistory) {
        this._history.shift();
      }

      // Log summary
      const latency = trace.totalLatencyMs > 0 ? `${trace.totalLatencyMs}ms` : 'N/A';
      const heard = trace.heardDurationMs > 0 ? `${trace.heardDurationMs}ms` : 'N/A';
      console.log(`[VoiceTrace] Turn ${trace.turnId}: latency=${latency} heard=${heard} tools=[${trace.toolsInvoked.join(',')}]`);
    }

    this._currentTurn = null;
    return trace;
  }

  /** Get recent trace history */
  getHistory(): readonly VoiceTurnTrace[] {
    return this._history;
  }

  /** Get average metrics over last N turns */
  getAverages(n = 10): { avgLatencyMs: number; avgHeardMs: number; turnsWithInterrupt: number } {
    const recent = this._history.slice(-n);
    if (recent.length === 0) return { avgLatencyMs: 0, avgHeardMs: 0, turnsWithInterrupt: 0 };

    const latencies = recent.filter(t => t.totalLatencyMs > 0).map(t => t.totalLatencyMs);
    const heards = recent.filter(t => t.heardDurationMs > 0).map(t => t.heardDurationMs);
    const interrupts = recent.filter(t => t.interruptionTime !== null).length;

    return {
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      avgHeardMs: heards.length ? Math.round(heards.reduce((a, b) => a + b, 0) / heards.length) : 0,
      turnsWithInterrupt: interrupts,
    };
  }

  /** Reset all history */
  reset() {
    this._currentTurn = null;
    this._history = [];
  }
}
