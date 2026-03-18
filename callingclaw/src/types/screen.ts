// CallingClaw 2.0 — Screen Capture Types
// Shared types for BrowserCaptureProvider and DesktopCaptureProvider

export type CaptureSource = "browser" | "desktop";

export interface CaptureResult {
  image: string;       // base64 JPEG
  width: number;
  height: number;
  metadata: CaptureMetadata;
}

export interface CaptureMetadata {
  url?: string;          // browser: current page URL
  title?: string;        // browser: page title, desktop: window title
  displayIndex?: number; // desktop: which monitor
}

export interface CaptureProvider {
  readonly source: CaptureSource;
  capture(options?: Record<string, unknown>): Promise<CaptureResult | null>;
  isAvailable(): Promise<boolean>;
}
